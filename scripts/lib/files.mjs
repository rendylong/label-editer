import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'

const ACTIVE_PUBLICATIONS = new Set()
const PUBLICATION_LOCK_WAIT_MS = 30_000
const PUBLICATION_LOCK_RETRY_MS = 20
const EMPTY_LOCK_GRACE_MS = 200
const MAX_PROCESS_PID = 0x7fffffff
const SANITIZED_TOKEN_MAX_CODE_UNITS = 160
const RESIDUE_CLAIM_HEX_LENGTH = 24
const PUBLICATION_BINDING_HEX_LENGTH = 12
const PORTABLE_NAME_MAX_BYTES = 255
const RESIDUE_NAMESPACE = 'label-publish'
const MAX_RESIDUE_JSON_BYTES = 4_096
const RESIDUE_ENTRY_NAMES = [
  'owner.json', 'transaction.json', 'recovery.json', 'staged.complete', 'published.verified',
]
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

function truncateUnicodeSafe(value, maximumCodeUnits) {
  let result = ''
  for (const character of value) {
    if (result.length + character.length > maximumCodeUnits) break
    result += character
  }
  return result
}

export function sanitizeArtifactName(value) {
  const normalized = String(value)
    .normalize('NFKC')
    .replace(/\.\.(?=[/\\]|$)/g, '')
    .replace(/[/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const truncated = truncateUnicodeSafe(normalized, SANITIZED_TOKEN_MAX_CODE_UNITS)
    .replace(/^[-.]+|[-.]+$/g, '')
  return truncated || 'artifact'
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

function validProcessPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PROCESS_PID
}

function ownerIsActive(owner) {
  if (!owner || !validProcessPid(owner.pid) || typeof owner.token !== 'string') return true
  if (owner.pid === process.pid) return ACTIVE_PUBLICATIONS.has(publicationTokenHash(owner.token))
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function assertTransaction(journal, outputDir) {
  const parent = path.dirname(outputDir)
  const base = path.basename(outputDir)
  if (journal?.version !== 1 || !validProcessPid(journal.pid) || !validPublicationToken(journal.token)
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
  await cleanupLockResidueCandidate(
    fileSystem,
    lockPath,
    path.basename(releasedLockPath),
    { allowedActiveOwner: { pid: process.pid, token } },
  )
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
  if (!validProcessPid(pid) || String(pid) !== pidText) return undefined
  const token = identity.slice(delimiter + 1)
  if (!validPublicationToken(token)) return undefined
  return { name, pid, token, tokenHash: publicationTokenHash(token), suffix }
}

function publicationTokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, RESIDUE_CLAIM_HEX_LENGTH)
}

function createPublicationToken(sessionId) {
  const binding = createHash('sha256')
    .update(String(sessionId), 'utf8')
    .digest('hex')
    .slice(0, PUBLICATION_BINDING_HEX_LENGTH)
  return `${binding}-${randomBytes(6).toString('hex')}`
}

function publicationResidueNamespace(lockPath) {
  const binding = createHash('sha256')
    .update(path.basename(lockPath), 'utf8')
    .digest('hex')
    .slice(0, RESIDUE_CLAIM_HEX_LENGTH)
  return `.${RESIDUE_NAMESPACE}.${binding}`
}

function assertPortableNameComponent(component, purpose) {
  const bytes = new TextEncoder().encode(component).byteLength
  if (component.length === 0 || component === '.' || component === '..'
    || bytes > PORTABLE_NAME_MAX_BYTES) {
    throw new PathPolicyError(
      `${purpose} exceeds the portable ${PORTABLE_NAME_MAX_BYTES}-byte NAME_MAX: ${component}`,
    )
  }
}

function artifactRelativePath(artifact) {
  return artifact.relativePath
    ? String(artifact.relativePath).split('/').filter(Boolean).map(sanitizeArtifactName).join(path.sep)
    : sanitizeArtifactName(artifact.fileName)
}

function assertPublicationNameBudget(outputDir, token, artifactPaths = []) {
  const base = path.basename(outputDir)
  const lockName = `.${base}.publish.lock`
  const recoveryToken = `recovery-${token}`
  const tokenHash = 'f'.repeat(RESIDUE_CLAIM_HEX_LENGTH)
  const claim = 'e'.repeat(RESIDUE_CLAIM_HEX_LENGTH)
  const namespace = publicationResidueNamespace(lockName)
  const components = [
    [base, 'Output name'],
    [`.${base}.${token}.tmp`, 'Staging name'],
    [`.${base}.${token}.backup`, 'Backup name'],
    [lockName, 'Publication lock name'],
    [`${lockName}.${MAX_PROCESS_PID}.${token}.tmp`, 'Temporary lock name'],
    [`${lockName}.${MAX_PROCESS_PID}.${token}.released`, 'Released lock name'],
    [`${lockName}.${MAX_PROCESS_PID}.${recoveryToken}.released`, 'Recovery lock name'],
    [`${namespace}.cleanup.r.${MAX_PROCESS_PID}.${tokenHash}.${claim}`, 'Cleanup claim name'],
    [`${namespace}.preserved.${MAX_PROCESS_PID}.${tokenHash}.${claim}`, 'Preserved claim name'],
    [`transaction.${token}.tmp`, 'Journal staging name'],
    [`published.verified.${token}.tmp`, 'Verified marker staging name'],
    [`staged.complete.${token}.tmp`, 'Staged marker staging name'],
    [`published.verified.cleanup-${claim}`, 'Metadata claim name'],
  ]
  for (const [component, purpose] of components) assertPortableNameComponent(component, purpose)
  for (const relativePath of artifactPaths) {
    for (const component of relativePath.split(path.sep)) {
      assertPortableNameComponent(component, 'Artifact path component')
    }
  }
}

function validSanitizedTokenPrefix(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= SANITIZED_TOKEN_MAX_CODE_UNITS
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
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_RESIDUE_JSON_BYTES) {
    return { state: 'invalid' }
  }
  let handle
  try {
    handle = await fileSystem.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile() || openedInfo.size > MAX_RESIDUE_JSON_BYTES
      || (info.dev !== undefined && openedInfo.dev !== info.dev)
      || (info.ino !== undefined && openedInfo.ino !== info.ino)) return { state: 'invalid' }
    const raw = await handle.readFile('utf8')
    return { state: 'valid', value: JSON.parse(raw), raw, info: openedInfo }
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
    && owner.version === 1 && validProcessPid(owner.pid)
    && validPublicationToken(owner.token)
}

function parseLockResidueCandidateName(lockPath, name) {
  const direct = parseLockResidueName(lockPath, name)
  if (direct) return { ...direct, isCleanupClaim: false }
  const legacyPrefix = `${path.basename(lockPath)}.cleanup.`
  const compactPrefix = `${publicationResidueNamespace(lockPath)}.cleanup.`
  const prefix = name.startsWith(compactPrefix)
    ? compactPrefix
    : name.startsWith(legacyPrefix) ? legacyPrefix : undefined
  if (!prefix) return undefined
  const claimMatch = /^([tr])\.([1-9][0-9]*)\.([0-9a-f]{24})\.([0-9a-f]{24})$/.exec(
    name.slice(prefix.length),
  )
  if (!claimMatch) return undefined
  const pid = Number(claimMatch[2])
  if (!validProcessPid(pid) || String(pid) !== claimMatch[2]) return undefined
  return {
    name,
    pid,
    tokenHash: claimMatch[3],
    suffix: claimMatch[1] === 't' ? '.tmp' : '.released',
    isCleanupClaim: true,
  }
}

function parseResidueEntryName(name) {
  if (RESIDUE_ENTRY_NAMES.includes(name)) return { logicalName: name, isCleanupClaim: false }
  for (const logicalName of RESIDUE_ENTRY_NAMES) {
    const prefix = `${logicalName}.cleanup-`
    if (name.startsWith(prefix)
      && new RegExp(`^[0-9a-f]{${RESIDUE_CLAIM_HEX_LENGTH}}$`).test(name.slice(prefix.length))) {
      return { logicalName, isCleanupClaim: true }
    }
  }
  return undefined
}

function sameInode(left, right, type) {
  return left && right && !right.isSymbolicLink() && right[type]()
    && left.dev !== undefined && right.dev !== undefined && left.dev === right.dev
    && left.ino !== undefined && right.ino !== undefined && left.ino === right.ino
}

function sameInspection(left, right, marker) {
  return left?.state === 'valid' && right?.state === 'valid'
    && sameInode(left.info, right.info, 'isFile')
    && left.info.size === right.info.size
    && (marker || left.raw === right.raw)
}

async function inspectResidueSnapshot(fileSystem, residuePath, identity) {
  let info
  try {
    info = await fileSystem.lstat(residuePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return undefined
  const entries = (await fileSystem.readdir(residuePath)).sort()
  const records = new Map()
  for (const actualName of entries) {
    const parsed = parseResidueEntryName(actualName)
    if (!parsed || records.has(parsed.logicalName)
      || (parsed.isCleanupClaim && !identity.isCleanupClaim)) return undefined
    const marker = parsed.logicalName === 'staged.complete' || parsed.logicalName === 'published.verified'
    const inspection = marker
      ? await inspectResidueMarker(fileSystem, path.join(residuePath, actualName))
      : await inspectResidueJson(fileSystem, path.join(residuePath, actualName))
    if (inspection.state !== 'valid') return undefined
    records.set(parsed.logicalName, { ...inspection, actualName, marker })
  }
  return { info, entries, records }
}

function sameResidueSnapshot(left, right) {
  if (!left || !right || !sameInode(left.info, right.info, 'isDirectory')
    || left.entries.length !== right.entries.length
    || left.entries.some((entry, index) => entry !== right.entries[index])) return false
  for (const [logicalName, record] of left.records) {
    const current = right.records.get(logicalName)
    if (!current || current.actualName !== record.actualName
      || !sameInspection(record, current, record.marker)) return false
  }
  return true
}

function hasResidueEntries(snapshot, names) {
  return snapshot.records.size === names.length && names.every((name) => snapshot.records.has(name))
}

function matchesResidueIdentity(owner, identity) {
  return owner.pid === identity.pid
    && (typeof identity.token === 'string'
      ? owner.token === identity.token
      : publicationTokenHash(owner.token) === identity.tokenHash)
}

function classifyResiduePhase(identity, snapshot) {
  const owner = snapshot.records.get('owner.json')?.value
  const recovery = snapshot.records.get('recovery.json')?.value
  if (identity.suffix === '.tmp') {
    if (hasResidueEntries(snapshot, [])) return { initializer: identity, cleanupOrder: [] }
    if (hasResidueEntries(snapshot, ['owner.json'])
      && validGeneratedOwner(owner) && matchesResidueIdentity(owner, identity)) {
      return { initializer: owner, cleanupOrder: ['owner.json'] }
    }
    return undefined
  }

  if (hasResidueEntries(snapshot, [])) return { initializer: identity, cleanupOrder: [] }
  if (hasResidueEntries(snapshot, ['owner.json'])
    && validGeneratedOwner(owner) && matchesResidueIdentity(owner, identity)) {
    return { initializer: owner, cleanupOrder: ['owner.json'] }
  }
  if (hasResidueEntries(snapshot, ['owner.json', 'staged.complete', 'published.verified'])
    && validGeneratedOwner(owner) && matchesResidueIdentity(owner, identity)) {
    return { initializer: owner, cleanupOrder: ['owner.json', 'staged.complete', 'published.verified'] }
  }
  if (hasResidueEntries(snapshot, ['staged.complete', 'published.verified'])) {
    return { initializer: identity, cleanupOrder: ['staged.complete', 'published.verified'] }
  }
  if (hasResidueEntries(snapshot, ['staged.complete'])) {
    return { initializer: identity, cleanupOrder: ['staged.complete'] }
  }
  if (hasResidueEntries(snapshot, ['published.verified'])) {
    return { initializer: identity, cleanupOrder: ['published.verified'] }
  }
  if (hasResidueEntries(snapshot, ['recovery.json'])
    && validGeneratedOwner(recovery) && matchesResidueIdentity(recovery, identity)) {
    return { initializer: recovery, cleanupOrder: ['recovery.json'] }
  }
  if (hasResidueEntries(snapshot, ['owner.json', 'recovery.json'])
    && validGeneratedOwner(owner) && validGeneratedOwner(recovery)
    && matchesResidueIdentity(recovery, identity)) {
    return { initializer: recovery, cleanupOrder: ['owner.json', 'recovery.json'] }
  }
  if (hasResidueEntries(snapshot, [
    'owner.json', 'recovery.json', 'staged.complete', 'published.verified',
  ]) && validGeneratedOwner(owner) && validGeneratedOwner(recovery)
    && matchesResidueIdentity(recovery, identity)) {
    return {
      initializer: recovery,
      cleanupOrder: ['owner.json', 'recovery.json', 'staged.complete', 'published.verified'],
    }
  }
  if (hasResidueEntries(snapshot, ['owner.json', 'recovery.json', 'published.verified'])
    && validGeneratedOwner(owner) && validGeneratedOwner(recovery)
    && matchesResidueIdentity(recovery, identity)) {
    return {
      initializer: recovery,
      cleanupOrder: ['owner.json', 'recovery.json', 'published.verified'],
    }
  }
  if (hasResidueEntries(snapshot, ['recovery.json', 'staged.complete', 'published.verified'])
    && validGeneratedOwner(recovery) && matchesResidueIdentity(recovery, identity)) {
    return {
      initializer: recovery,
      cleanupOrder: ['recovery.json', 'staged.complete', 'published.verified'],
    }
  }
  return undefined
}

function sameOwner(left, right) {
  if (!left || !right || left.pid !== right.pid) return false
  if (typeof left.token === 'string' && typeof right.token === 'string') return left.token === right.token
  if (typeof left.token === 'string' && typeof right.tokenHash === 'string') {
    return publicationTokenHash(left.token) === right.tokenHash
  }
  if (typeof right.token === 'string' && typeof left.tokenHash === 'string') {
    return publicationTokenHash(right.token) === left.tokenHash
  }
  return left.tokenHash === right.tokenHash
}

function residueOwnerIsActive(owner, allowedActiveOwner) {
  if (sameOwner(owner, allowedActiveOwner)) return false
  if (typeof owner?.token !== 'string') {
    if (!validProcessPid(owner?.pid)) return true
    if (owner.pid === process.pid) return ACTIVE_PUBLICATIONS.has(owner.tokenHash)
    try {
      process.kill(owner.pid, 0)
      return true
    } catch (error) {
      return error?.code !== 'ESRCH'
    }
  }
  return ownerIsActive(owner)
}

function randomResidueClaim() {
  return randomBytes(RESIDUE_CLAIM_HEX_LENGTH / 2).toString('hex')
}

function residueClaimName(lockPath, identity) {
  const phase = identity.suffix === '.tmp' ? 't' : 'r'
  return `${publicationResidueNamespace(lockPath)}.cleanup.${phase}.${identity.pid}.${identity.tokenHash}.${randomResidueClaim()}`
}

async function renameToResidueClaim(fileSystem, sourcePath, parent, lockPath, identity) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimPath = path.join(parent, residueClaimName(lockPath, identity))
    try {
      await renameAndSync(fileSystem, sourcePath, claimPath)
      return claimPath
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
    }
  }
  return undefined
}

async function preserveResidueClaim(fileSystem, claimPath, parent, lockPath, identity) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const preservedPath = path.join(parent, `${publicationResidueNamespace(lockPath)}.preserved.${identity.pid}.${identity.tokenHash}.${randomResidueClaim()}`)
    try {
      await renameAndSync(fileSystem, claimPath, preservedPath)
      return preservedPath
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
    }
  }
  return claimPath
}

async function renameResidueFileClaim(fileSystem, sourcePath, residuePath, logicalName) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimedPath = path.join(residuePath, `${logicalName}.cleanup-${randomResidueClaim()}`)
    try {
      await renameAndSync(fileSystem, sourcePath, claimedPath)
      return claimedPath
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
    }
  }
  return undefined
}

async function removeResidueFileWithOpenClaim(fileSystem, claimedPath, expected) {
  let info
  try {
    info = await fileSystem.lstat(claimedPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()
    || (expected.marker ? info.size !== 0 : info.size > MAX_RESIDUE_JSON_BYTES)) return false

  let handle
  try {
    handle = await fileSystem.open(claimedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const openedInfo = await handle.stat()
    if (!sameInode(info, openedInfo, 'isFile')
      || (expected.marker ? openedInfo.size !== 0 : openedInfo.size > MAX_RESIDUE_JSON_BYTES)) {
      return false
    }
    let raw
    let value
    if (!expected.marker) {
      raw = await handle.readFile('utf8')
      try {
        value = JSON.parse(raw)
      } catch (error) {
        if (error instanceof SyntaxError) return false
        throw error
      }
    }
    const current = { state: 'valid', info: openedInfo, raw, value }
    if (!sameInspection(expected, current, expected.marker)) return false
    const finalInfo = await fileSystem.lstat(claimedPath).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (!sameInode(openedInfo, finalInfo, 'isFile')) return false

    // Node exposes pathname unlink, not inode-conditional unlink. Keep the
    // verified descriptor open through deletion and use a second unpredictable
    // atomic claim after the first readback. If either claim observes a swap,
    // the current object is retained inside one preserved quarantine instead.
    // Publisher-owned retained metadata is bounded to five files, 4 KiB each.
    await removeAndSync(fileSystem, claimedPath, { force: true })
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return false
    throw error
  } finally {
    await handle?.close()
  }
}

async function claimAndRemoveResidueFile(fileSystem, residuePath, logicalName, expected) {
  const sourcePath = path.join(residuePath, expected.actualName)
  const claimedPath = await renameResidueFileClaim(fileSystem, sourcePath, residuePath, logicalName)
  if (!claimedPath) return false
  const current = expected.marker
    ? await inspectResidueMarker(fileSystem, claimedPath)
    : await inspectResidueJson(fileSystem, claimedPath)
  if (!sameInspection(expected, current, expected.marker)) return false
  const terminalClaim = await renameResidueFileClaim(fileSystem, claimedPath, residuePath, logicalName)
  if (!terminalClaim) return false
  return removeResidueFileWithOpenClaim(fileSystem, terminalClaim, expected)
}

async function cleanupLockResidueCandidate(fileSystem, lockPath, name, {
  allowedActiveOwner,
} = {}) {
  const identity = parseLockResidueCandidateName(lockPath, name)
  if (!identity) return false
  const parent = path.dirname(lockPath)
  const sourcePath = path.join(parent, name)
  const snapshot = await inspectResidueSnapshot(fileSystem, sourcePath, identity)
  const phase = snapshot && classifyResiduePhase(identity, snapshot)
  if (!phase || residueOwnerIsActive(phase.initializer, allowedActiveOwner)) return false

  const claimedPath = await renameToResidueClaim(fileSystem, sourcePath, parent, lockPath, identity)
  if (!claimedPath) return false
  const claimedIdentity = parseLockResidueCandidateName(lockPath, path.basename(claimedPath))
  if (!claimedIdentity) return false
  const claimedSnapshot = await inspectResidueSnapshot(fileSystem, claimedPath, claimedIdentity)
  const claimedPhase = claimedSnapshot && classifyResiduePhase(claimedIdentity, claimedSnapshot)
  if (!claimedPhase || !sameResidueSnapshot(snapshot, claimedSnapshot)
    || residueOwnerIsActive(claimedPhase.initializer, allowedActiveOwner)) {
    await preserveResidueClaim(fileSystem, claimedPath, parent, lockPath, claimedIdentity)
    return false
  }

  for (const logicalName of claimedPhase.cleanupOrder) {
    const expected = claimedSnapshot.records.get(logicalName)
    if (!expected || !(await claimAndRemoveResidueFile(fileSystem, claimedPath, logicalName, expected))) {
      await preserveResidueClaim(fileSystem, claimedPath, parent, lockPath, claimedIdentity)
      return false
    }
  }
  if ((await fileSystem.readdir(claimedPath)).length !== 0) {
    await preserveResidueClaim(fileSystem, claimedPath, parent, lockPath, claimedIdentity)
    return false
  }

  const finalClaimPath = await renameToResidueClaim(fileSystem, claimedPath, parent, lockPath, claimedIdentity)
  if (!finalClaimPath) return false
  let finalInfo
  try {
    finalInfo = await fileSystem.lstat(finalClaimPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  if (!sameInode(claimedSnapshot.info, finalInfo, 'isDirectory')
    || (await fileSystem.readdir(finalClaimPath)).length !== 0) {
    await preserveResidueClaim(fileSystem, finalClaimPath, parent, lockPath, claimedIdentity)
    return false
  }
  try {
    await fileSystem.rmdir(finalClaimPath)
    await syncDirectory(fileSystem, parent)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    if (error?.code === 'ENOTEMPTY') {
      await preserveResidueClaim(fileSystem, finalClaimPath, parent, lockPath, claimedIdentity)
      return false
    }
    throw error
  }
}

async function cleanupAbandonedLockResidue(fileSystem, lockPath) {
  const parent = path.dirname(lockPath)
  for (const name of await fileSystem.readdir(parent)) {
    if (!parseLockResidueCandidateName(lockPath, name)) continue
    await cleanupLockResidueCandidate(fileSystem, lockPath, name)
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

  const activeClaim = publicationTokenHash(claimToken)
  ACTIVE_PUBLICATIONS.add(activeClaim)
  try {
    await recoverLockedPublication(fileSystem, lockPath, outputDir)
    await releasePublicationLock(fileSystem, lockPath, claimToken)
    return true
  } finally {
    ACTIVE_PUBLICATIONS.delete(activeClaim)
  }
}

async function acquirePublicationLock(fileSystem, lockPath, outputDir, token, { rejectConcurrent = false } = {}) {
  const started = Date.now()
  const lockTemporary = `${lockPath}.${process.pid}.${token}.tmp`
  const ownerPath = path.join(lockTemporary, 'owner.json')
  let acquired = false
  const activeToken = publicationTokenHash(token)
  ACTIVE_PUBLICATIONS.add(activeToken)
  try {
    await cleanupAbandonedLockResidue(fileSystem, lockPath)
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
      ACTIVE_PUBLICATIONS.delete(activeToken)
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
  const token = createPublicationToken(sessionId)
  const artifactPaths = artifacts.map(artifactRelativePath)
  assertPublicationNameBudget(outputDir, token, artifactPaths)
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
    for (const [index, artifact] of artifacts.entries()) {
      const relativePath = artifactPaths[index]
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
      ACTIVE_PUBLICATIONS.delete(publicationTokenHash(token))
    }
  }
}

export async function publishFileAtomically(outputPath, bytes, { force = false, sessionId = randomBytes(8).toString('hex') } = {}) {
  const parent = path.dirname(outputPath)
  const base = path.basename(outputPath)
  const token = createPublicationToken(sessionId)
  assertPortableNameComponent(base, 'Output name')
  assertPortableNameComponent(`.${base}.${token}.tmp`, 'Staging name')
  assertPortableNameComponent(`.${base}.${token}.backup`, 'Backup name')
  const temporary = path.join(parent, `.${base}.${token}.tmp`)
  const backup = path.join(parent, `.${base}.${token}.backup`)
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
