import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const ACTIVE_PUBLICATIONS = new Set()
const PUBLICATION_LOCK_WAIT_MS = 30_000
const PUBLICATION_LOCK_RETRY_MS = 20
const EMPTY_LOCK_GRACE_MS = 200
const DEFAULT_PUBLICATION_FILE_SYSTEM = { mkdir, open, readFile, rename, rm, stat }

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
  const markerPath = path.join(lockPath, 'staged.complete')
  const journal = await readJsonIfPresent(fileSystem, journalPath)
  if (!journal) return
  const { temporary, backup } = assertTransaction(journal, outputDir)
  const [staged, outputExists, temporaryExists, backupExists] = await Promise.all([
    pathExists(fileSystem, markerPath),
    pathExists(fileSystem, outputDir),
    pathExists(fileSystem, temporary),
    pathExists(fileSystem, backup),
  ])

  if (!staged) {
    if (!outputExists && backupExists) await renameAndSync(fileSystem, backup, outputDir)
    else if (backupExists) await removeAndSync(fileSystem, backup, { recursive: true, force: true })
    if (temporaryExists) await removeAndSync(fileSystem, temporary, { recursive: true, force: true })
  } else if (backupExists && temporaryExists && !outputExists) {
    await renameAndSync(fileSystem, temporary, outputDir)
    await removeAndSync(fileSystem, backup, { recursive: true, force: true })
  } else if (backupExists && outputExists && !temporaryExists) {
    await removeAndSync(fileSystem, backup, { recursive: true, force: true })
  } else if (!backupExists && temporaryExists && !outputExists) {
    await renameAndSync(fileSystem, temporary, outputDir)
  } else if (!backupExists && temporaryExists && outputExists) {
    await removeAndSync(fileSystem, temporary, { recursive: true, force: true })
  } else if (backupExists && !temporaryExists && !outputExists) {
    await renameAndSync(fileSystem, backup, outputDir)
  } else if (backupExists && temporaryExists && outputExists) {
    await removeAndSync(fileSystem, temporary, { recursive: true, force: true })
    await removeAndSync(fileSystem, backup, { recursive: true, force: true })
  }

  await removeAndSync(fileSystem, markerPath, { force: true })
  await removeAndSync(fileSystem, journalPath, { force: true })
}

async function claimAndRecoverPublication(fileSystem, lockPath, outputDir, token) {
  const claimPath = path.join(lockPath, 'recovery.json')
  const claimToken = `recovery:${token}`
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
    await removeAndSync(fileSystem, lockPath, { recursive: true, force: true })
    return true
  } finally {
    ACTIVE_PUBLICATIONS.delete(claimToken)
  }
}

async function acquirePublicationLock(fileSystem, lockPath, outputDir, token) {
  const started = Date.now()
  while (true) {
    try {
      await fileSystem.mkdir(lockPath, { recursive: false })
      try {
        await syncDirectory(fileSystem, path.dirname(lockPath))
      } catch (error) {
        await fileSystem.rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      ACTIVE_PUBLICATIONS.add(token)
      return
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    const journal = await readJsonIfPresent(fileSystem, path.join(lockPath, 'transaction.json'))
    let stale = journal ? !ownerIsActive(journal) : false
    if (!journal) {
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
    if (Date.now() - started >= PUBLICATION_LOCK_WAIT_MS) {
      const error = new Error(`Output publication is already in progress: ${outputDir}`)
      error.code = 'OUTPUT_CONFLICT'
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLICATION_LOCK_RETRY_MS))
  }
}

export async function publishAtomically(outputDir, artifacts, {
  force = false,
  sessionId = randomBytes(8).toString('hex'),
  fileSystem: fileSystemOverrides,
} = {}) {
  const parent = path.dirname(outputDir)
  const base = path.basename(outputDir)
  const token = `${sanitizeArtifactName(sessionId)}-${randomBytes(6).toString('hex')}`
  const temporary = path.join(parent, `.${base}.${token}.tmp`)
  const backup = path.join(parent, `.${base}.${token}.backup`)
  const lockPath = path.join(parent, `.${base}.publish.lock`)
  const journalPath = path.join(lockPath, 'transaction.json')
  const journalTemporary = path.join(lockPath, `transaction.${token}.tmp`)
  const markerPath = path.join(lockPath, 'staged.complete')
  const fileSystem = { ...DEFAULT_PUBLICATION_FILE_SYSTEM, ...fileSystemOverrides }
  await acquirePublicationLock(fileSystem, lockPath, outputDir, token)
  let primaryError
  let journalInstalled = false
  try {
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
    await writeDurableExclusive(fileSystem, markerPath, new Uint8Array())
    if (exists) await renameAndSync(fileSystem, outputDir, backup)
    await renameAndSync(fileSystem, temporary, outputDir)
    if (exists) await removeAndSync(fileSystem, backup, { recursive: true, force: true })
    await removeAndSync(fileSystem, markerPath, { force: true })
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
    ACTIVE_PUBLICATIONS.delete(token)
    try {
      if (!journalInstalled) await removeAndSync(fileSystem, lockPath, { recursive: true, force: true })
    } catch (error) {
      if (!primaryError) throw error
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
