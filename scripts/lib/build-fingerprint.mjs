import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const EDITOR_BUILD_FINGERPRINT_FILE = 'build-fingerprint.json'
export const DEFAULT_EDITOR_ASSET_LIMITS = Object.freeze({
  maxEditorAssetBytes: 32 * 1024 * 1024,
  maxEditorSnapshotBytes: 128 * 1024 * 1024,
  maxEditorAssetCount: 512,
  maxEditorAssetPathBytes: 1024,
  maxEditorTreeDepth: 32,
  maxEditorTreeEntries: 4096,
})

const READ_CHUNK_BYTES = 64 * 1024
const EDITOR_ASSET_SNAPSHOTS = new WeakMap()
const SOURCE_ENTRIES = [
  'src',
  'public',
  'scripts/lib',
  'scripts/generate-label-validator.mjs',
  'index.html',
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function editorAssetLimits(options = {}) {
  const limits = {
    maxEditorAssetBytes: options.maxEditorAssetBytes ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorAssetBytes,
    maxEditorSnapshotBytes: options.maxEditorSnapshotBytes ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorSnapshotBytes,
    maxEditorAssetCount: options.maxEditorAssetCount ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorAssetCount,
    maxEditorAssetPathBytes: options.maxEditorAssetPathBytes ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorAssetPathBytes,
    maxEditorTreeDepth: options.maxEditorTreeDepth ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorTreeDepth,
    maxEditorTreeEntries: options.maxEditorTreeEntries ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorTreeEntries,
  }
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
    || limits.maxEditorAssetBytes > limits.maxEditorSnapshotBytes
    || limits.maxEditorAssetCount > limits.maxEditorTreeEntries) {
    throw new Error('Invalid editor asset limits')
  }
  return limits
}

function portablePath(relativePath) {
  return relativePath.split(path.sep).join('/')
}

function statField(info, nanosecond, millisecond) {
  return nanosecond in info ? info[nanosecond] : info[millisecond]
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && statField(left, 'mtimeNs', 'mtimeMs') === statField(right, 'mtimeNs', 'mtimeMs')
    && statField(left, 'ctimeNs', 'ctimeMs') === statField(right, 'ctimeNs', 'ctimeMs')
}

function fileSize(info, description) {
  const value = typeof info.size === 'bigint' ? info.size : BigInt(info.size)
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${description} byte limit exceeded`)
  }
  return Number(value)
}

async function pathInfo(absolutePath) {
  return lstat(absolutePath, { bigint: true })
}

function symbolicLinkError(description) {
  return new Error(`Editor build fingerprint refuses symbolic link ${description}`)
}

async function openNoFollow(absolutePath, flags, description) {
  try {
    return await open(absolutePath, flags | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') throw symbolicLinkError(description)
    throw error
  }
}

async function readBoundedDescriptor(handle, description, maxFileBytes, maxAggregateBytes) {
  const chunks = []
  let total = 0
  while (true) {
    const remainingFile = maxFileBytes - total
    const remainingAggregate = maxAggregateBytes - total
    const allowed = Math.min(remainingFile, remainingAggregate)
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, allowed + 1)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > maxFileBytes) throw new Error(`${description} byte limit exceeded`)
    if (total > maxAggregateBytes) throw new Error('Editor snapshot byte limit exceeded')
    chunks.push(buffer.subarray(0, bytesRead))
  }
  return Buffer.concat(chunks, total)
}

async function readStableRegularFile(absolutePath, description, {
  maxFileBytes,
  maxAggregateBytes = maxFileBytes,
  expected,
  onOpened,
  relativePath,
  kind,
} = {}) {
  let handle
  try {
    handle = await openNoFollow(absolutePath, constants.O_RDONLY, description)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`Editor build fingerprint requires a regular file: ${description}`)
    if (expected && !sameIdentity(expected, before)) {
      throw new Error(`Editor build changed while fingerprinting: ${description}`)
    }
    const declaredSize = fileSize(before, description)
    if (declaredSize > maxFileBytes) throw new Error(`${description} byte limit exceeded`)
    if (declaredSize > maxAggregateBytes) throw new Error('Editor snapshot byte limit exceeded')
    if (onOpened) await onOpened({ absolutePath, relativePath, kind })
    const bytes = await readBoundedDescriptor(handle, description, maxFileBytes, maxAggregateBytes)
    const after = await handle.stat({ bigint: true })
    if (!sameIdentity(before, after) || bytes.byteLength !== fileSize(after, description)) {
      throw new Error(`Editor build changed while fingerprinting: ${description}`)
    }
    let current
    try {
      current = await pathInfo(absolutePath)
    } catch {
      throw new Error(`Editor build changed while fingerprinting: ${description}`)
    }
    if (current.isSymbolicLink()) throw symbolicLinkError(description)
    if (!current.isFile() || !sameIdentity(after, current)) {
      throw new Error(`Editor build changed while fingerprinting: ${description}`)
    }
    return bytes
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function inventoryState() {
  return { fileCount: 0, treeEntries: 0, declaredBytes: 0, files: [] }
}

function assertInventoryPath(relativePath, depth, limits) {
  const displayPath = portablePath(relativePath) || '.'
  if (Buffer.byteLength(displayPath) > limits.maxEditorAssetPathBytes) {
    throw new Error(`Editor asset path byte limit exceeded: ${displayPath}`)
  }
  if (depth > limits.maxEditorTreeDepth) {
    throw new Error(`Editor asset tree depth limit exceeded: ${displayPath}`)
  }
  return displayPath
}

async function walkRegularPath(root, relativePath, depth, limits, state, {
  optional = false,
  kind,
  exclude,
} = {}) {
  const displayPath = assertInventoryPath(relativePath, depth, limits)
  const absolutePath = relativePath ? path.join(root, relativePath) : root
  let info
  try {
    info = await pathInfo(absolutePath)
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return
    if (error?.code === 'ENOENT') throw new Error(`Stale editor build: ${kind} entry is missing: ${displayPath}`)
    throw error
  }
  if (info.isSymbolicLink()) throw symbolicLinkError(`${kind}: ${displayPath}`)
  if (exclude?.(portablePath(relativePath), info)) return

  if (info.isFile()) {
    state.fileCount += 1
    if (state.fileCount > limits.maxEditorAssetCount) throw new Error('Editor asset count limit exceeded')
    const size = fileSize(info, `${kind}: ${displayPath}`)
    if (size > limits.maxEditorAssetBytes) throw new Error(`Editor asset byte limit exceeded: ${displayPath}`)
    state.declaredBytes += size
    if (state.declaredBytes > limits.maxEditorSnapshotBytes) throw new Error('Editor snapshot byte limit exceeded')
    state.files.push({ path: portablePath(relativePath), absolutePath, info, byteLength: size })
    return
  }
  if (!info.isDirectory()) {
    throw new Error(`Editor build fingerprint requires a regular file or directory: ${kind}: ${displayPath}`)
  }

  let directoryHandle
  let directory
  try {
    directoryHandle = await openNoFollow(
      absolutePath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
      `${kind}: ${displayPath}`,
    )
    const opened = await directoryHandle.stat({ bigint: true })
    if (!opened.isDirectory() || !sameIdentity(info, opened)) {
      throw new Error(`Editor build changed while fingerprinting: ${kind}: ${displayPath}`)
    }
    directory = await opendir(absolutePath)
    const names = []
    for await (const entry of directory) {
      state.treeEntries += 1
      if (state.treeEntries > limits.maxEditorTreeEntries) throw new Error('Editor asset tree entry limit exceeded')
      names.push(entry.name)
    }
    directory = undefined
    const listedPath = await pathInfo(absolutePath)
    const listedHandle = await directoryHandle.stat({ bigint: true })
    if (!listedPath.isDirectory() || !sameIdentity(opened, listedPath) || !sameIdentity(opened, listedHandle)) {
      throw new Error(`Editor build changed while fingerprinting: ${kind}: ${displayPath}`)
    }
    for (const name of names.sort()) {
      await walkRegularPath(root, path.join(relativePath, name), depth + 1, limits, state, { kind, exclude })
    }
    const finalPath = await pathInfo(absolutePath)
    const finalHandle = await directoryHandle.stat({ bigint: true })
    if (!finalPath.isDirectory() || !sameIdentity(opened, finalPath) || !sameIdentity(opened, finalHandle)) {
      throw new Error(`Editor build changed while fingerprinting: ${kind}: ${displayPath}`)
    }
  } finally {
    if (directory) await directory.close().catch(() => undefined)
    if (directoryHandle) await directoryHandle.close().catch(() => undefined)
  }
}

async function sourceInventory(root, limits) {
  const state = inventoryState()
  for (const entry of SOURCE_ENTRIES) {
    await walkRegularPath(root, entry, 0, limits, state, { optional: true, kind: 'input' })
  }
  state.files.sort((left, right) => left.path.localeCompare(right.path))
  return state
}

async function distInventory(root, limits) {
  const state = inventoryState()
  await walkRegularPath(root, '', 0, limits, state, {
    kind: 'output',
    exclude(relativePath, info) {
      if (relativePath !== EDITOR_BUILD_FINGERPRINT_FILE) return false
      if (!info.isFile()) throw new Error('Editor build fingerprint marker must be a regular file')
      return true
    },
  })
  state.files.sort((left, right) => left.path.localeCompare(right.path))
  if (!state.files.some((entry) => entry.path === 'index.html')) {
    throw new Error('Stale editor build: dist/index.html is missing')
  }
  return state
}

function sameInventory(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index].path && entry.byteLength === right[index].byteLength
  ))
}

function createSnapshotReader(assets) {
  const state = { assets, disposed: false }
  const assertActive = () => {
    if (state.disposed) throw new Error('Editor asset snapshot reader is disposed')
  }
  return Object.freeze({
    has(relativePath) {
      assertActive()
      return state.assets.has(relativePath)
    },
    read(relativePath) {
      assertActive()
      const bytes = state.assets.get(relativePath)
      return bytes ? Buffer.from(bytes) : undefined
    },
    paths() {
      assertActive()
      return Object.freeze([...state.assets.keys()])
    },
    dispose() {
      if (state.disposed) return
      state.disposed = true
      for (const bytes of state.assets.values()) bytes.fill(0)
      state.assets.clear()
    },
  })
}

async function collectEditorDist(editorRoot, options = {}, retainBytes = false) {
  const root = path.resolve(editorRoot)
  const limits = editorAssetLimits(options)
  const first = await distInventory(root, limits)
  const inventory = []
  const assets = retainBytes ? new Map() : undefined
  let totalBytes = 0
  for (const entry of first.files) {
    const bytes = await readStableRegularFile(entry.absolutePath, `output: ${entry.path}`, {
      maxFileBytes: limits.maxEditorAssetBytes,
      maxAggregateBytes: limits.maxEditorSnapshotBytes - totalBytes,
      expected: entry.info,
      onOpened: options.onEditorAssetOpened,
      relativePath: entry.path,
      kind: 'output',
    })
    totalBytes += bytes.byteLength
    if (totalBytes > limits.maxEditorSnapshotBytes) throw new Error('Editor snapshot byte limit exceeded')
    inventory.push({ path: entry.path, byteLength: bytes.byteLength, sha256: sha256(bytes) })
    if (assets) assets.set(entry.path, bytes)
  }
  const final = await distInventory(root, limits)
  if (!sameInventory(inventory, final.files)) {
    throw new Error('Editor build output inventory changed while fingerprinting')
  }
  const digest = createHash('sha256')
  for (const entry of inventory) {
    digest.update(entry.path)
    digest.update('\0')
    digest.update(String(entry.byteLength))
    digest.update('\0')
    digest.update(entry.sha256)
    digest.update('\0')
  }
  const result = {
    distSha256: digest.digest('hex'),
    distFileCount: inventory.length,
    distFiles: inventory,
    ...(assets ? { totalBytes } : {}),
  }
  if (!assets) return result
  const snapshot = Object.freeze({})
  EDITOR_ASSET_SNAPSHOTS.set(snapshot, assets)
  return { ...result, snapshot }
}

export async function editorDistFingerprint(editorRoot, options = {}) {
  return collectEditorDist(editorRoot, options, false)
}

export async function snapshotEditorDist(editorRoot, options = {}) {
  return collectEditorDist(editorRoot, options, true)
}

export function takeEditorDistSnapshot(snapshot) {
  const assets = snapshot && typeof snapshot === 'object' ? EDITOR_ASSET_SNAPSHOTS.get(snapshot) : undefined
  if (!assets) throw new Error('Editor asset snapshot is invalid or already consumed')
  EDITOR_ASSET_SNAPSHOTS.delete(snapshot)
  return createSnapshotReader(assets)
}

export async function editorSourceFingerprint(pluginRoot, options = {}) {
  const root = path.resolve(pluginRoot)
  const limits = editorAssetLimits(options)
  const first = await sourceInventory(root, limits)
  if (first.files.length === 0) throw new Error(`Editor source files are missing: ${root}`)
  const digest = createHash('sha256')
  let totalBytes = 0
  const readInventory = []
  for (const entry of first.files) {
    const bytes = await readStableRegularFile(entry.absolutePath, `input: ${entry.path}`, {
      maxFileBytes: limits.maxEditorAssetBytes,
      maxAggregateBytes: limits.maxEditorSnapshotBytes - totalBytes,
      expected: entry.info,
      onOpened: options.onEditorAssetOpened,
      relativePath: entry.path,
      kind: 'input',
    })
    totalBytes += bytes.byteLength
    if (totalBytes > limits.maxEditorSnapshotBytes) throw new Error('Editor snapshot byte limit exceeded')
    digest.update(entry.path)
    digest.update('\0')
    digest.update(bytes)
    digest.update('\0')
    readInventory.push({ path: entry.path, byteLength: bytes.byteLength })
  }
  const final = await sourceInventory(root, limits)
  if (!sameInventory(readInventory, final.files)) {
    throw new Error('Editor build input inventory changed while fingerprinting')
  }
  return { sourceSha256: digest.digest('hex'), sourceFileCount: first.files.length }
}

export async function writeEditorBuildFingerprint(pluginRoot, editorRoot, options = {}) {
  const root = path.resolve(editorRoot)
  const manifest = {
    version: 2,
    algorithm: 'sha256',
    ...await editorSourceFingerprint(pluginRoot, options),
    ...await editorDistFingerprint(root, options),
  }
  const markerPath = path.join(root, EDITOR_BUILD_FINGERPRINT_FILE)
  const temporaryPath = path.join(path.dirname(root), `.${EDITOR_BUILD_FINGERPRINT_FILE}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, markerPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return assertFreshEditorBuild(pluginRoot, root, options)
}

async function readBuildFingerprint(root) {
  try {
    const markerPath = path.join(root, EDITOR_BUILD_FINGERPRINT_FILE)
    const bytes = await readStableRegularFile(markerPath, 'marker', {
      maxFileBytes: 1024 * 1024,
      maxAggregateBytes: 1024 * 1024,
    })
    return { manifest: JSON.parse(bytes.toString('utf8')), markerSha256: sha256(bytes) }
  } catch (error) {
    if (error instanceof SyntaxError
      || /requires a regular file|refuses symbolic link|changed while fingerprinting/.test(error instanceof Error ? error.message : '')) {
      throw new Error('Editor build fingerprint is invalid')
    }
    throw new Error('Editor build fingerprint is missing; run the editor build before browser execution')
  }
}

function assertMatchingBuild(manifest, actual) {
  if (manifest?.version !== 2 || manifest.algorithm !== 'sha256'
    || manifest.sourceSha256 !== actual.sourceSha256
    || manifest.sourceFileCount !== actual.sourceFileCount
    || manifest.distSha256 !== actual.distSha256
    || manifest.distFileCount !== actual.distFileCount
    || JSON.stringify(manifest.distFiles) !== JSON.stringify(actual.distFiles)) {
    throw new Error('Stale editor build: source fingerprint does not match dist')
  }
}

export async function assertFreshEditorBuild(pluginRoot, editorRoot, options = {}) {
  const root = path.resolve(editorRoot)
  const { manifest } = await readBuildFingerprint(root)
  const actual = {
    ...await editorSourceFingerprint(pluginRoot, options),
    ...await editorDistFingerprint(root, options),
  }
  assertMatchingBuild(manifest, actual)
  return manifest
}

export async function captureFreshEditorBuild(pluginRoot, editorRoot, options = {}) {
  const root = path.resolve(editorRoot)
  const marker = await readBuildFingerprint(root)
  const dist = await snapshotEditorDist(root, options)
  const actual = {
    ...await editorSourceFingerprint(pluginRoot, options),
    distSha256: dist.distSha256,
    distFileCount: dist.distFileCount,
    distFiles: dist.distFiles,
  }
  assertMatchingBuild(marker.manifest, actual)
  const pinnedManifest = JSON.stringify(marker.manifest)
  return {
    manifest: marker.manifest,
    snapshot: dist.snapshot,
    totalBytes: dist.totalBytes,
    async assertCurrent() {
      const currentMarker = await readBuildFingerprint(root)
      if (currentMarker.markerSha256 !== marker.markerSha256
        || JSON.stringify(currentMarker.manifest) !== pinnedManifest) {
        throw new Error('Stale editor build: build fingerprint marker changed before browser execution')
      }
      const current = {
        ...await editorSourceFingerprint(pluginRoot, options),
        ...await editorDistFingerprint(root, options),
      }
      assertMatchingBuild(marker.manifest, current)
    },
  }
}
