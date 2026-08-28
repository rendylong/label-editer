import { createHash, randomUUID } from 'node:crypto'
import { lstat, opendir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const EDITOR_BUILD_FINGERPRINT_FILE = 'build-fingerprint.json'
export const DEFAULT_EDITOR_ASSET_LIMITS = Object.freeze({
  maxEditorAssetBytes: 32 * 1024 * 1024,
  maxEditorSnapshotBytes: 128 * 1024 * 1024,
  maxEditorAssetCount: 512,
  maxEditorAssetPathBytes: 1024,
})
const EDITOR_ASSET_SNAPSHOTS = new WeakMap()
const SOURCE_ENTRIES = [
  'src',
  'public',
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

async function existingFiles(root, relativePath) {
  const absolute = path.join(root, relativePath)
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Editor build fingerprint refuses symbolic link input: ${relativePath}`)
  }
  if (info.isFile()) return [relativePath.split(path.sep).join('/')]
  if (!info.isDirectory()) return []
  const entries = await readdir(absolute)
  const nested = await Promise.all(entries.sort().map((entry) => existingFiles(root, path.join(relativePath, entry))))
  return nested.flat()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameFileState(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

async function readStableRegularFile(absolutePath, description, maxBytes) {
  const before = await lstat(absolutePath)
  if (before.isSymbolicLink()) throw new Error(`Editor build fingerprint refuses symbolic link ${description}`)
  if (!before.isFile()) throw new Error(`Editor build fingerprint requires a regular file: ${description}`)
  if (maxBytes !== undefined && before.size > maxBytes) throw new Error(`${description} byte limit exceeded`)
  const bytes = await readFile(absolutePath)
  const after = await lstat(absolutePath)
  if (!sameFileState(before, after)) throw new Error(`Editor build changed while fingerprinting: ${description}`)
  return bytes
}

function editorAssetLimits(options = {}) {
  const limits = {
    maxEditorAssetBytes: options.maxEditorAssetBytes ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorAssetBytes,
    maxEditorSnapshotBytes: options.maxEditorSnapshotBytes ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorSnapshotBytes,
    maxEditorAssetCount: options.maxEditorAssetCount ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorAssetCount,
    maxEditorAssetPathBytes: options.maxEditorAssetPathBytes ?? DEFAULT_EDITOR_ASSET_LIMITS.maxEditorAssetPathBytes,
  }
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
    || limits.maxEditorAssetBytes > limits.maxEditorSnapshotBytes) {
    throw new Error('Invalid editor asset limits')
  }
  return limits
}

async function distFiles(root, relativePath = '', limits = DEFAULT_EDITOR_ASSET_LIMITS, state = { count: 0, entries: 0 }) {
  const absolute = relativePath ? path.join(root, relativePath) : root
  const displayPath = relativePath.split(path.sep).join('/') || '.'
  if (Buffer.byteLength(displayPath) > limits.maxEditorAssetPathBytes) {
    throw new Error(`Editor asset path byte limit exceeded: ${displayPath}`)
  }
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Stale editor build: dist entry is missing: ${displayPath}`)
    throw error
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Editor build fingerprint refuses symbolic link output: ${displayPath}`)
  }
  if (relativePath === EDITOR_BUILD_FINGERPRINT_FILE) {
    if (!info.isFile()) throw new Error('Editor build fingerprint marker must be a regular file')
    return []
  }
  if (info.isFile()) {
    state.count += 1
    if (state.count > limits.maxEditorAssetCount) throw new Error('Editor asset count limit exceeded')
    return [displayPath]
  }
  if (!info.isDirectory()) throw new Error(`Editor build fingerprint refuses non-regular output: ${displayPath}`)
  const entries = []
  const directory = await opendir(absolute)
  for await (const entry of directory) {
    state.entries += 1
    if (state.entries > limits.maxEditorAssetCount * 4 + 64) {
      throw new Error('Editor asset tree entry limit exceeded')
    }
    entries.push(entry.name)
  }
  const nested = []
  for (const entry of entries.sort()) {
    nested.push(...await distFiles(root, path.join(relativePath, entry), limits, state))
  }
  return nested
}

async function collectEditorDist(editorRoot, options = {}, retainBytes = false) {
  const root = path.resolve(editorRoot)
  const limits = editorAssetLimits(options)
  const files = (await distFiles(root, '', limits)).sort()
  if (!files.includes('index.html')) throw new Error('Stale editor build: dist/index.html is missing')
  const inventory = []
  const assets = retainBytes ? new Map() : undefined
  let totalBytes = 0
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath)
    const info = await lstat(absolutePath)
    if (info.isSymbolicLink()) throw new Error(`Editor build fingerprint refuses symbolic link output: ${relativePath}`)
    if (!info.isFile()) throw new Error(`Editor build fingerprint requires a regular file: output: ${relativePath}`)
    if (info.size > limits.maxEditorAssetBytes) {
      throw new Error(`Editor asset byte limit exceeded: ${relativePath}`)
    }
    if (info.size > limits.maxEditorSnapshotBytes - totalBytes) {
      throw new Error('Editor snapshot byte limit exceeded')
    }
    const bytes = await readStableRegularFile(absolutePath, `output: ${relativePath}`, limits.maxEditorAssetBytes)
    totalBytes += bytes.byteLength
    inventory.push({ path: relativePath, byteLength: bytes.byteLength, sha256: sha256(bytes) })
    if (assets) assets.set(relativePath, bytes)
  }
  const finalFiles = (await distFiles(root, '', limits)).sort()
  if (JSON.stringify(files) !== JSON.stringify(finalFiles)) {
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
  return assets
}

export async function editorSourceFingerprint(pluginRoot) {
  const root = path.resolve(pluginRoot)
  const files = (await Promise.all(SOURCE_ENTRIES.map((entry) => existingFiles(root, entry))))
    .flat()
    .sort()
  if (files.length === 0) throw new Error(`Editor source files are missing: ${root}`)
  const digest = createHash('sha256')
  for (const relativePath of files) {
    digest.update(relativePath)
    digest.update('\0')
    digest.update(await readStableRegularFile(path.join(root, relativePath), `input: ${relativePath}`))
    digest.update('\0')
  }
  return { sourceSha256: digest.digest('hex'), sourceFileCount: files.length }
}

export async function writeEditorBuildFingerprint(pluginRoot, editorRoot) {
  const root = path.resolve(editorRoot)
  const manifest = {
    version: 2,
    algorithm: 'sha256',
    ...await editorSourceFingerprint(pluginRoot),
    ...await editorDistFingerprint(root),
  }
  const markerPath = path.join(root, EDITOR_BUILD_FINGERPRINT_FILE)
  const temporaryPath = path.join(path.dirname(root), `.${EDITOR_BUILD_FINGERPRINT_FILE}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, markerPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return assertFreshEditorBuild(pluginRoot, root)
}

async function readBuildFingerprint(root) {
  try {
    const markerPath = path.join(root, EDITOR_BUILD_FINGERPRINT_FILE)
    const bytes = await readStableRegularFile(markerPath, 'marker', 1024 * 1024)
    return { manifest: JSON.parse(bytes.toString('utf8')), markerSha256: sha256(bytes) }
  } catch (error) {
    if (error instanceof SyntaxError
      || /requires a regular file|refuses symbolic link/.test(error instanceof Error ? error.message : '')) {
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
    ...await editorSourceFingerprint(pluginRoot),
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
    ...await editorSourceFingerprint(pluginRoot),
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
        ...await editorSourceFingerprint(pluginRoot),
        ...await editorDistFingerprint(root, options),
      }
      assertMatchingBuild(marker.manifest, current)
    },
  }
}
