import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'

const ACTIVE_PUBLICATIONS = new Set()
const PUBLICATION_LOCK_WAIT_MS = 30_000
const PUBLICATION_LOCK_RETRY_MS = 20
const EMPTY_LOCK_GRACE_MS = 200
const DEFAULT_PUBLICATION_FILE_SYSTEM = { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat }

export class PathPolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PathPolicyError'
    this.code = 'PATH_NOT_ALLOWED'
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export async function resolveAllowedPath(allowedRoots, inputPath) {
  const resolved = await realpath(path.resolve(inputPath))
  const roots = await Promise.all(allowedRoots.map((root) => realpath(path.resolve(root))))
  if (!roots.some((root) => isWithin(root, resolved))) {
    throw new PathPolicyError(`Path is outside allowed root: ${inputPath}`)
  }
  return resolved
}

export async function resolveAllowedOutputPath(allowedRoots, inputPath) {
  const absolute = path.resolve(inputPath)
  const parent = await realpath(path.dirname(absolute))
  const roots = await Promise.all(allowedRoots.map((root) => realpath(path.resolve(root))))
  if (!roots.some((root) => isWithin(root, parent))) {
    throw new PathPolicyError(`Output path is outside allowed root: ${inputPath}`)
  }
  return path.join(parent, path.basename(absolute))
}

export function sanitizeArtifactName(value) {
  const normalized = String(value)
    .normalize('NFKC')
    .replace(/\.\.(?=[/\\]|$)/g, '')
    .replace(/[/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return normalized.slice(0, 160) || 'artifact'
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath))
}

export async function writeExclusive(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const handle = await open(filePath, 'wx')
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
}

function pathExists(fileSystem, target) {
  return fileSystem.stat(target).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      throw error
    },
  )
}

async function assertSafePublicationRoot(fileSystem, outputDir) {
  let info
  try {
    info = await fileSystem.lstat(outputDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (info.isSymbolicLink()) {
    throw new PathPolicyError(`Output path final component must not be a symlink: ${outputDir}`)
  }
}

async function syncDirectory(fileSystem, directory) {
  const handle = await fileSystem.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeDurableExclusive(fileSystem, filePath, bytes) {
  const handle = await fileSystem.open(filePath, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(fileSystem, path.dirname(filePath))
}

async function writeDurableMarker(fileSystem, markerPath, token) {
  const temporary = `${markerPath}.${token}.tmp`
  await writeDurableExclusive(fileSystem, temporary, new Uint8Array())
  await renameAndSync(fileSystem, temporary, markerPath)
}

async function removeAndSync(fileSystem, target, options) {
  await fileSystem.rm(target, options)
  await syncDirectory(fileSystem, path.dirname(target))
}

async function renameAndSync(fileSystem, source, target) {
  await fileSystem.rename(source, target)
  await syncDirectory(fileSystem, path.dirname(target))
}

async function readJsonIfPresent(fileSystem, filePath) {
  try {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

function ownerIsActive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || typeof owner.token !== 'string') return false
  if (owner.pid === process.pid) return ACTIVE_PUBLICATIONS.has(owner.token)
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function assertTransaction(journal, outputDir) {
  const parent = path.dirname(outputDir)
  const base = path.basename(outputDir)
  if (journal?.version !== 1 || !Number.isInteger(journal.pid) || typeof journal.token !== 'string'
    || journal.outputName !== base || typeof journal.hadExisting !== 'boolean'
    || journal.temporaryName !== `.${base}.${journal.token}.tmp`
    || journal.backupName !== `.${base}.${journal.token}.backup`
    || path.basename(journal.temporaryName) !== journal.temporaryName
    || path.basename(journal.backupName) !== journal.backupName) {
    const error = new Error(`Invalid atomic publication journal for: ${outputDir}`)
    error.code = 'OUTPUT_CONFLICT'
    throw error
  }
  return {
    temporary: path.join(parent, journal.temporaryName),
    backup: path.join(parent, journal.backupName),
  }
}

async function recoverLockedPublication(fileSystem, lockPath, outputDir) {
  const journalPath = path.join(lockPath, 'transaction.json')
  const stagedMarkerPath = path.join(lockPath, 'staged.complete')
  const verifiedMarkerPath = path.join(lockPath, 'published.verified')
  const journal = await readJsonIfPresent(fileSystem, journalPath)
  if (!journal) return
  const { temporary, backup } = assertTransaction(journal, outputDir)
  const [staged, verified, outputExists, temporaryExists, backupExists] = await Promise.all([
    pathExists(fileSystem, stagedMarkerPath),
    pathExists(fileSystem, verifiedMarkerPath),
    pathExists(fileSystem, outputDir),
    pathExists(fileSystem, temporary),
    pathExists(fileSystem, backup),
  ])

  if (!staged || !verified) {
    if (journal.hadExisting && backupExists) {
      if (outputExists) await removeAndSync(fileSystem, outputDir, { recursive: true, force: true })
      await renameAndSync(fileSystem, backup, outputDir)
    } else if (!journal.hadExisting && outputExists) {
      await removeAndSync(fileSystem, outputDir, { recursive: true, force: true })
    } else if (backupExists) {
      await removeAndSync(fileSystem, backup, { recursive: true, force: true })
    }
    if (temporaryExists) await removeAndSync(fileSystem, temporary, { recursive: true, force: true })
  } else if (outputExists) {
    if (temporaryExists) await removeAndSync(fileSystem, temporary, { recursive: true, force: true })
    if (backupExists) await removeAndSync(fileSystem, backup, { recursive: true, force: true })
  } else {
    if (journal.hadExisting && backupExists) await renameAndSync(fileSystem, backup, outputDir)
    else if (backupExists) await removeAndSync(fileSystem, backup, { recursive: true, force: true })
    if (temporaryExists) await removeAndSync(fileSystem, temporary, { recursive: true, force: true })
  }

  // Removing the journal is the durable terminal decision. If cleanup crashes
  // after this point, a later owner keeps the already-converged output and
  // removes the entire external lock directory without reinterpreting markers.
  await removeAndSync(fileSystem, journalPath, { force: true })
  await removeAndSync(fileSystem, stagedMarkerPath, { force: true })
  await removeAndSync(fileSystem, verifiedMarkerPath, { force: true })
}

async function releasePublicationLock(fileSystem, lockPath, token) {
  const releasedLockPath = `${lockPath}.${process.pid}.${token}.released`
  try {
    await renameAndSync(fileSystem, lockPath, releasedLockPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await removeAndSync(fileSystem, releasedLockPath, { recursive: true, force: true })
}

function parseLockResidueName(lockPath, name) {
  const prefix = `${path.basename(lockPath)}.`
  if (typeof name !== 'string' || !name.startsWith(prefix)) return undefined
  const suffix = name.endsWith('.tmp') ? '.tmp' : name.endsWith('.released') ? '.released' : undefined
  if (!suffix) return undefined
  const identity = name.slice(prefix.length, -suffix.length)
  const delimiter = identity.indexOf('.')
  if (delimiter <= 0) return undefined
  const pidText = identity.slice(0, delimiter)
  if (!/^[1-9][0-9]*$/.test(pidText)) return undefined
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== pidText) return undefined
  const token = identity.slice(delimiter + 1)
  if (!validPublicationToken(token)) return undefined
  return { name, pid, token, suffix }
}

function validSanitizedTokenPrefix(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && sanitizeArtifactName(value) === value
}

function validPublicationToken(token) {
  if (typeof token !== 'string') return false
  const randomDelimiter = token.length - 13
  if (randomDelimiter <= 0 || token[randomDelimiter] !== '-') return false
  const sanitized = token.slice(0, randomDelimiter)
  const random = token.slice(randomDelimiter + 1)
  if (!/^[0-9a-f]{12}$/.test(random)) return false
  return validSanitizedTokenPrefix(sanitized)
    || (sanitized.startsWith('recovery-') && validSanitizedTokenPrefix(sanitized.slice('recovery-'.length)))
}

async function inspectResidueJson(fileSystem, filePath) {
  let info
  try {
    info = await fileSystem.lstat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' }
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) return { state: 'invalid' }
  let handle
  try {
    handle = await fileSystem.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile()
      || (info.dev !== undefined && openedInfo.dev !== info.dev)
      || (info.ino !== undefined && openedInfo.ino !== info.ino)) return { state: 'invalid' }
    return { state: 'valid', value: JSON.parse(await handle.readFile('utf8')), info: openedInfo }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP' || error instanceof SyntaxError) {
      return { state: 'invalid' }
    }
    throw error
  } finally {
    await handle?.close()
  }
}

async function inspectResidueMarker(fileSystem, filePath) {
  let info
  try {
    info = await fileSystem.lstat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' }
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size !== 0) return { state: 'invalid' }
  let handle
  try {
    handle = await fileSystem.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile() || openedInfo.size !== 0
      || (info.dev !== undefined && openedInfo.dev !== info.dev)
      || (info.ino !== undefined && openedInfo.ino !== info.ino)) return { state: 'invalid' }
    return { state: 'valid', info: openedInfo }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return { state: 'invalid' }
    throw error
  } finally {
    await handle?.close()
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function validGeneratedOwner(owner) {
  return exactKeys(owner, ['version', 'pid', 'token'])
    && owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && validPublicationToken(owner.token)
}

function validGeneratedJournal(journal, outputDir) {
  if (!exactKeys(journal, [
    'version', 'pid', 'token', 'outputName', 'temporaryName', 'backupName', 'hadExisting',
  ]) || !Number.isSafeInteger(journal.pid) || journal.pid <= 0
    || !validPublicationToken(journal.token)) return false
  try {
    assertTransaction(journal, outputDir)
    return true
  } catch {
    return false
  }
}

async function sameResidueDirectory(fileSystem, residuePath, original) {
  try {
    const current = await fileSystem.lstat(residuePath)
    return !current.isSymbolicLink() && current.isDirectory()
      && (original.dev === undefined || current.dev === original.dev)
      && (original.ino === undefined || current.ino === original.ino)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function sameResidueFile(fileSystem, filePath, original) {
  try {
    const current = await fileSystem.lstat(filePath)
    return !current.isSymbolicLink() && current.isFile()
      && (original.dev === undefined || current.dev === original.dev)
      && (original.ino === undefined || current.ino === original.ino)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function removeEmptyResidueDirectory(fileSystem, residuePath, parent) {
  try {
    await fileSystem.rmdir(residuePath)
    await syncDirectory(fileSystem, parent)
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error
  }
}

async function cleanupAbandonedLockResidue(fileSystem, lockPath, outputDir) {
  const parent = path.dirname(lockPath)
  for (const name of await fileSystem.readdir(parent)) {
    const identity = parseLockResidueName(lockPath, name)
    if (!identity) continue
    const residuePath = path.join(parent, name)
    let residueInfo
    try {
      residueInfo = await fileSystem.lstat(residuePath)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (residueInfo.isSymbolicLink() || !residueInfo.isDirectory()) continue

    const owner = await inspectResidueJson(fileSystem, path.join(residuePath, 'owner.json'))
    const journal = await inspectResidueJson(fileSystem, path.join(residuePath, 'transaction.json'))
    const recovery = await inspectResidueJson(fileSystem, path.join(residuePath, 'recovery.json'))
    const staged = await inspectResidueMarker(fileSystem, path.join(residuePath, 'staged.complete'))
    const verified = await inspectResidueMarker(fileSystem, path.join(residuePath, 'published.verified'))
    if ([owner, journal, recovery, staged, verified].some((entry) => entry.state === 'invalid')) continue
    if (owner.state === 'valid' && !validGeneratedOwner(owner.value)) continue
    if (journal.state === 'valid' && !validGeneratedJournal(journal.value, outputDir)) continue
    if (recovery.state === 'valid' && !validGeneratedOwner(recovery.value)) continue
    if (owner.state === 'valid' && journal.state === 'valid'
      && (owner.value.pid !== journal.value.pid || owner.value.token !== journal.value.token)) continue

    let initializer
    if (recovery.state === 'valid') {
      const prior = owner.state === 'valid' ? owner.value : journal.state === 'valid' ? journal.value : undefined
      if (recovery.value.pid !== identity.pid || recovery.value.token !== identity.token
        || (prior && recovery.value.token !== `recovery-${prior.token}`)) continue
      initializer = recovery.value
    } else {
      if (owner.state === 'valid'
        && (owner.value.pid !== identity.pid || owner.value.token !== identity.token)) continue
      if (journal.state === 'valid'
        && (journal.value.pid !== identity.pid || journal.value.token !== identity.token)) continue
      initializer = owner.state === 'valid' ? owner.value
        : journal.state === 'valid' ? journal.value : undefined
    }
    if (!initializer) {
      if (ownerIsActive(identity) || (await fileSystem.readdir(residuePath)).length !== 0
        || !(await sameResidueDirectory(fileSystem, residuePath, residueInfo))) continue
      await removeEmptyResidueDirectory(fileSystem, residuePath, parent)
      continue
    }
    if (ownerIsActive(initializer)) continue

    const identityFileName = recovery.state === 'valid' ? 'recovery.json'
      : owner.state === 'valid' ? 'owner.json' : 'transaction.json'
    const metadata = [
      ['owner.json', owner], ['transaction.json', journal], ['recovery.json', recovery],
      ['staged.complete', staged], ['published.verified', verified],
    ].filter(([, inspection]) => inspection.state === 'valid')
      .sort(([left], [right]) => Number(left === identityFileName) - Number(right === identityFileName))
    const expectedEntries = new Set(metadata.map(([fileName]) => fileName))
    if ((await fileSystem.readdir(residuePath)).some((entry) => !expectedEntries.has(entry))
      || !(await sameResidueDirectory(fileSystem, residuePath, residueInfo))) continue
    let metadataStable = true
    for (const [fileName, inspection] of metadata) {
      if (!(await sameResidueFile(fileSystem, path.join(residuePath, fileName), inspection.info))) {
        metadataStable = false
        break
      }
    }
    if (!metadataStable) continue
    for (const [fileName] of metadata) {
      await removeAndSync(fileSystem, path.join(residuePath, fileName), { force: true })
    }
    if (await sameResidueDirectory(fileSystem, residuePath, residueInfo)) {
      await removeEmptyResidueDirectory(fileSystem, residuePath, parent)
    }
  }
}

async function claimAndRecoverPublication(fileSystem, lockPath, outputDir, token) {
  const claimPath = path.join(lockPath, 'recovery.json')
  const claimToken = `recovery-${token}`
  try {
    await writeDurableExclusive(fileSystem, claimPath, new TextEncoder().encode(JSON.stringify({
      version: 1,
      pid: process.pid,
      token: claimToken,
    })))
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    if (error?.code !== 'EEXIST') throw error
    const existingClaim = await readJsonIfPresent(fileSystem, claimPath)
    if (ownerIsActive(existingClaim)) return false
    await removeAndSync(fileSystem, claimPath, { force: true })
    return false
  }

  ACTIVE_PUBLICATIONS.add(claimToken)
  try {
    await recoverLockedPublication(fileSystem, lockPath, outputDir)
    await releasePublicationLock(fileSystem, lockPath, claimToken)
    return true
  } finally {
    ACTIVE_PUBLICATIONS.delete(claimToken)
  }
}

async function acquirePublicationLock(fileSystem, lockPath, outputDir, token, { rejectConcurrent = false } = {}) {
  const started = Date.now()
  const lockTemporary = `${lockPath}.${process.pid}.${token}.tmp`
  const ownerPath = path.join(lockTemporary, 'owner.json')
  let acquired = false
  ACTIVE_PUBLICATIONS.add(token)
  try {
    await cleanupAbandonedLockResidue(fileSystem, lockPath, outputDir)
    await fileSystem.mkdir(lockTemporary, { recursive: false })
    await writeDurableExclusive(fileSystem, ownerPath, new TextEncoder().encode(JSON.stringify({
      version: 1,
      pid: process.pid,
      token,
    })))
    while (true) {
      try {
        await renameAndSync(fileSystem, lockTemporary, lockPath)
        acquired = true
        return
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
      }

      const owner = await readJsonIfPresent(fileSystem, path.join(lockPath, 'owner.json'))
        ?? await readJsonIfPresent(fileSystem, path.join(lockPath, 'transaction.json'))
      let stale = owner ? !ownerIsActive(owner) : false
      if (!owner) {
        try {
          stale = Date.now() - (await fileSystem.stat(lockPath)).mtimeMs >= EMPTY_LOCK_GRACE_MS
        } catch (error) {
          if (error?.code === 'ENOENT') continue
          throw error
        }
      }
      if (stale) {
        if (await claimAndRecoverPublication(fileSystem, lockPath, outputDir, token)) continue
      }
      if (rejectConcurrent) {
        const error = new Error(`Output publication is already in progress: ${outputDir}`)
        error.code = 'OUTPUT_CONFLICT'
        throw error
      }
      if (Date.now() - started >= PUBLICATION_LOCK_WAIT_MS) {
        const error = new Error(`Output publication is already in progress: ${outputDir}`)
        error.code = 'OUTPUT_CONFLICT'
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, PUBLICATION_LOCK_RETRY_MS))
    }
  } finally {
    if (!acquired) {
      ACTIVE_PUBLICATIONS.delete(token)
      await fileSystem.rm(lockTemporary, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function publishAtomically(outputDir, artifacts, {
  force = false,
  sessionId = randomBytes(8).toString('hex'),
  fileSystem: fileSystemOverrides,
  rejectConcurrent = false,
  validateStaged,
  beforeCommit,
  validatePublished,
} = {}) {
  const parent = path.dirname(outputDir)
  const base = path.basename(outputDir)
  const token = `${sanitizeArtifactName(sessionId)}-${randomBytes(6).toString('hex')}`
  const temporary = path.join(parent, `.${base}.${token}.tmp`)
  const backup = path.join(parent, `.${base}.${token}.backup`)
  const lockPath = path.join(parent, `.${base}.publish.lock`)
  const journalPath = path.join(lockPath, 'transaction.json')
  const journalTemporary = path.join(lockPath, `transaction.${token}.tmp`)
  const stagedMarkerPath = path.join(lockPath, 'staged.complete')
  const verifiedMarkerPath = path.join(lockPath, 'published.verified')
  const fileSystem = { ...DEFAULT_PUBLICATION_FILE_SYSTEM, ...fileSystemOverrides }
  await assertSafePublicationRoot(fileSystem, outputDir)
  await acquirePublicationLock(fileSystem, lockPath, outputDir, token, { rejectConcurrent })
  let primaryError
  let journalInstalled = false
  try {
    await assertSafePublicationRoot(fileSystem, outputDir)
    const exists = await pathExists(fileSystem, outputDir)
    if (exists && !force) {
      const error = new Error(`Output already exists: ${outputDir}`)
      error.code = 'OUTPUT_CONFLICT'
      throw error
    }
    const journal = {
      version: 1,
      pid: process.pid,
      token,
      outputName: base,
      temporaryName: path.basename(temporary),
      backupName: path.basename(backup),
      hadExisting: exists,
    }
    await writeDurableExclusive(fileSystem, journalTemporary, new TextEncoder().encode(JSON.stringify(journal)))
    await renameAndSync(fileSystem, journalTemporary, journalPath)
    journalInstalled = true
    await fileSystem.mkdir(temporary, { recursive: false })
    for (const artifact of artifacts) {
      const relativePath = artifact.relativePath
        ? String(artifact.relativePath).split('/').filter(Boolean).map(sanitizeArtifactName).join(path.sep)
        : sanitizeArtifactName(artifact.fileName)
      if (!relativePath) throw new PathPolicyError('Artifact path is empty')
      const artifactPath = path.join(temporary, relativePath)
      await fileSystem.mkdir(path.dirname(artifactPath), { recursive: true })
      await writeDurableExclusive(fileSystem, artifactPath, artifact.bytes)
    }
    if (validateStaged) await validateStaged(temporary)
    if (beforeCommit) await beforeCommit(temporary)
    await assertSafePublicationRoot(fileSystem, outputDir)
    await writeDurableMarker(fileSystem, stagedMarkerPath, token)
    if (exists) await renameAndSync(fileSystem, outputDir, backup)
    await renameAndSync(fileSystem, temporary, outputDir)
    if (validatePublished) await validatePublished(outputDir)
    await writeDurableMarker(fileSystem, verifiedMarkerPath, token)
    if (exists) await removeAndSync(fileSystem, backup, { recursive: true, force: true })
    await removeAndSync(fileSystem, journalPath, { force: true })
    journalInstalled = false
  } catch (error) {
    primaryError = error
    if (journalInstalled) {
      try {
        await recoverLockedPublication(fileSystem, lockPath, outputDir)
        journalInstalled = false
      } catch {
        // Leave the durable journal and lock for deterministic recovery by the next publisher.
      }
    } else {
      await fileSystem.rm(journalTemporary, { force: true }).catch(() => undefined)
      await fileSystem.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  } finally {
    try {
      if (!journalInstalled) await releasePublicationLock(fileSystem, lockPath, token)
    } catch (error) {
      if (!primaryError) throw error
    } finally {
      ACTIVE_PUBLICATIONS.delete(token)
    }
  }
}

export async function publishFileAtomically(outputPath, bytes, { force = false, sessionId = randomBytes(8).toString('hex') } = {}) {
  const parent = path.dirname(outputPath)
  const base = path.basename(outputPath)
  const temporary = path.join(parent, `.${base}.${sessionId}.tmp`)
  const backup = path.join(parent, `.${base}.${sessionId}.backup`)
  let movedExisting = false
  await rm(temporary, { force: true })
  try {
    await writeExclusive(temporary, bytes)
    const exists = await stat(outputPath).then(() => true, () => false)
    if (exists && !force) {
      const error = new Error(`Output already exists: ${outputPath}`)
      error.code = 'OUTPUT_CONFLICT'
      throw error
    }
    if (exists) {
      await rm(backup, { force: true })
      await rename(outputPath, backup)
      movedExisting = true
    }
    await rename(temporary, outputPath)
    if (movedExisting) await rm(backup, { force: true })
  } catch (error) {
    await rm(temporary, { force: true })
    if (movedExisting) {
      const outputExists = await stat(outputPath).then(() => true, () => false)
      if (!outputExists) await rename(backup, outputPath)
    }
    throw error
  }
}
