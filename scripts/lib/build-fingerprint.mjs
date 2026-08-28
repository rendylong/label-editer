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
const NANOSECONDS_PER_MILLISECOND = 1_000_000n
const EDITOR_ASSET_SNAPSHOTS = new WeakMap()
const SOURCE_ENTRIES = [
  'src',
  'public',
  'scripts',
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

function rootRelativeParts(relativePath, description) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error(`Editor build fingerprint path escapes its verified root: ${description}`)
  }
  if (!relativePath) return []
  const parts = relativePath.split(path.sep)
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Editor build fingerprint path escapes its verified root: ${description}`)
  }
  return parts
}

async function createRootAuthority(root, description) {
  const absoluteRoot = path.resolve(root)
  let rootInfo
  try {
    rootInfo = await pathInfo(absoluteRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Stale editor build: ${description} root is missing`)
    throw error
  }
  if (rootInfo.isSymbolicLink()) throw symbolicLinkError(`${description} root`)
  if (!rootInfo.isDirectory()) {
    throw new Error(`Editor build fingerprint requires a regular directory: ${description} root`)
  }
  const rootHandle = await openNoFollow(
    absoluteRoot,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    `${description} root`,
  )
  try {
    const opened = await rootHandle.stat({ bigint: true })
    if (!opened.isDirectory() || !sameIdentity(rootInfo, opened)) {
      throw new Error(`Editor build changed while fingerprinting: ${description} root`)
    }
    return {
      root: absoluteRoot,
      description,
      rootHandle,
      rootInfo: opened,
      directories: new Map([['', opened]]),
    }
  } catch (error) {
    await rootHandle.close().catch(() => undefined)
    throw error
  }
}

async function currentAuthorityInfo(authority, absolutePath, relativePath, expected, handle) {
  const displayPath = portablePath(relativePath) || '.'
  let current
  try {
    current = await pathInfo(absolutePath)
  } catch {
    throw new Error(`Editor build changed while fingerprinting: ${authority.description}: ${displayPath}`)
  }
  if (current.isSymbolicLink()) throw symbolicLinkError(`${authority.description}: ${displayPath}`)
  const opened = await handle.stat({ bigint: true })
  if (!sameIdentity(expected, current) || !sameIdentity(expected, opened)) {
    throw new Error(`Editor build changed while fingerprinting: ${authority.description}: ${displayPath}`)
  }
}

async function assertAuthorityStable(authority, opened = []) {
  await currentAuthorityInfo(authority, authority.root, '', authority.rootInfo, authority.rootHandle)
  for (const component of opened) {
    await currentAuthorityInfo(
      authority,
      component.absolutePath,
      component.relativePath,
      component.info,
      component.handle,
    )
  }
}

async function openRootRelativePath(authority, relativePath, description) {
  const parts = rootRelativeParts(relativePath, description)
  if (parts.length === 0) {
    await assertAuthorityStable(authority)
    return {
      absolutePath: authority.root,
      info: authority.rootInfo,
      handle: authority.rootHandle,
      async assertStable() { await assertAuthorityStable(authority) },
      async close() {},
    }
  }

  const opened = []
  let currentRelative = ''
  try {
    await assertAuthorityStable(authority)
    for (let index = 0; index < parts.length; index += 1) {
      currentRelative = currentRelative ? path.join(currentRelative, parts[index]) : parts[index]
      const absolutePath = path.join(authority.root, currentRelative)
      const isLeaf = index === parts.length - 1
      let info
      try {
        info = await pathInfo(absolutePath)
      } catch (error) {
        if (error?.code === 'ENOENT') throw error
        throw error
      }
      const componentDescription = `${authority.description}: ${portablePath(currentRelative)}`
      if (info.isSymbolicLink()) throw symbolicLinkError(componentDescription)
      if (!isLeaf && !info.isDirectory()) {
        throw new Error(`Editor build fingerprint requires a regular directory: ${componentDescription}`)
      }
      if (isLeaf && !info.isDirectory() && !info.isFile()) {
        throw new Error(`Editor build fingerprint requires a regular file or directory: ${componentDescription}`)
      }
      const flags = constants.O_RDONLY | (info.isDirectory() ? (constants.O_DIRECTORY ?? 0) : 0)
      const handle = await openNoFollow(absolutePath, flags, componentDescription)
      const openedInfo = await handle.stat({ bigint: true })
      if (!sameIdentity(info, openedInfo)
        || (info.isDirectory() && !openedInfo.isDirectory())
        || (info.isFile() && !openedInfo.isFile())) {
        await handle.close().catch(() => undefined)
        throw new Error(`Editor build changed while fingerprinting: ${componentDescription}`)
      }
      if (info.isDirectory()) {
        const baseline = authority.directories.get(portablePath(currentRelative))
        if (baseline && !sameIdentity(baseline, openedInfo)) {
          await handle.close().catch(() => undefined)
          throw new Error(`Editor build changed while fingerprinting: ${componentDescription}`)
        }
        if (!baseline) authority.directories.set(portablePath(currentRelative), openedInfo)
      }
      opened.push({ absolutePath, relativePath: currentRelative, info: openedInfo, handle })
      await assertAuthorityStable(authority, opened)
    }
    const leaf = opened[opened.length - 1]
    return {
      absolutePath: leaf.absolutePath,
      info: leaf.info,
      handle: leaf.handle,
      async assertStable() { await assertAuthorityStable(authority, opened) },
      async close() {
        for (const component of [...opened].reverse()) {
          await component.handle.close().catch(() => undefined)
        }
      },
    }
  } catch (error) {
    for (const component of [...opened].reverse()) {
      await component.handle.close().catch(() => undefined)
    }
    throw error
  }
}

async function closeRootAuthority(authority) {
  await authority.rootHandle.close().catch(() => undefined)
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

async function readStableRegularFile(authority, relativePath, description, {
  maxFileBytes,
  maxAggregateBytes = maxFileBytes,
  expected,
  onOpened,
  kind,
} = {}) {
  let opened
  try {
    opened = await openRootRelativePath(authority, relativePath, description)
    const { absolutePath, handle } = opened
    const before = opened.info
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
    await opened.assertStable()
    return bytes
  } finally {
    if (opened) await opened.close()
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

async function walkRegularPath(authority, relativePath, depth, limits, state, {
  optional = false,
  kind,
  exclude,
} = {}) {
  const displayPath = assertInventoryPath(relativePath, depth, limits)
  let opened
  try {
    opened = await openRootRelativePath(authority, relativePath, `${kind}: ${displayPath}`)
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return
    if (error?.code === 'ENOENT') throw new Error(`Stale editor build: ${kind} entry is missing: ${displayPath}`)
    throw error
  }
  const { info, absolutePath } = opened
  let directory
  try {
    if (exclude?.(portablePath(relativePath), info)) return

    if (info.isFile()) {
      state.fileCount += 1
      if (state.fileCount > limits.maxEditorAssetCount) throw new Error('Editor asset count limit exceeded')
      const size = fileSize(info, `${kind}: ${displayPath}`)
      if (size > limits.maxEditorAssetBytes) throw new Error(`Editor asset byte limit exceeded: ${displayPath}`)
      state.declaredBytes += size
      if (state.declaredBytes > limits.maxEditorSnapshotBytes) throw new Error('Editor snapshot byte limit exceeded')
      state.files.push({ path: portablePath(relativePath), info, byteLength: size })
      return
    }
    if (!info.isDirectory()) {
      throw new Error(`Editor build fingerprint requires a regular file or directory: ${kind}: ${displayPath}`)
    }

    directory = await opendir(absolutePath)
    const names = []
    for await (const entry of directory) {
      state.treeEntries += 1
      if (state.treeEntries > limits.maxEditorTreeEntries) throw new Error('Editor asset tree entry limit exceeded')
      names.push(entry.name)
    }
    directory = undefined
    await opened.assertStable()
    for (const name of names.sort()) {
      await walkRegularPath(authority, path.join(relativePath, name), depth + 1, limits, state, { kind, exclude })
    }
    await opened.assertStable()
  } finally {
    if (directory) await directory.close().catch(() => undefined)
    await opened.close()
  }
}

async function sourceInventory(authority, limits) {
  const state = inventoryState()
  for (const entry of SOURCE_ENTRIES) {
    await walkRegularPath(authority, entry, 0, limits, state, { optional: entry !== 'scripts', kind: 'input' })
  }
  state.files.sort((left, right) => left.path.localeCompare(right.path))
  return state
}

async function distInventory(authority, limits) {
  const state = inventoryState()
  await walkRegularPath(authority, '', 0, limits, state, {
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
    entry.path === right[index].path
      && entry.byteLength === right[index].byteLength
      && sameIdentity(entry.info, right[index].info)
  ))
}

function identityNeedsByteVerification(info) {
  const ctime = statField(info, 'ctimeNs', 'ctimeMs')
  return typeof ctime !== 'bigint' || ctime % NANOSECONDS_PER_MILLISECOND === 0n
}

async function assertInventoryBytesUnchanged(authority, inventory, limits, kind, collectFinalInventory) {
  const final = await collectFinalInventory()
  if (!sameInventory(inventory, final.files)) {
    throw new Error(`Editor build ${kind} inventory changed while fingerprinting`)
  }
  const coarseTimestampEntries = inventory.filter((entry) => identityNeedsByteVerification(entry.info))
  if (coarseTimestampEntries.length === 0) return
  let totalBytes = 0
  for (const entry of coarseTimestampEntries) {
    const bytes = await readStableRegularFile(authority, entry.path, `${kind}: ${entry.path}`, {
      maxFileBytes: limits.maxEditorAssetBytes,
      maxAggregateBytes: limits.maxEditorSnapshotBytes - totalBytes,
      expected: entry.info,
    })
    totalBytes += bytes.byteLength
    if (bytes.byteLength !== entry.byteLength || sha256(bytes) !== entry.sha256) {
      throw new Error(`Editor build ${kind} bytes changed while fingerprinting: ${entry.path}`)
    }
  }
  const sealed = await collectFinalInventory()
  if (!sameInventory(inventory, sealed.files)) {
    throw new Error(`Editor build ${kind} inventory changed while fingerprinting`)
  }
}

function createSnapshotReader(assets) {
  const state = { assets, disposeRequested: false, disposed: false, activeLeases: 0 }
  const assertActive = () => {
    if (state.disposeRequested || state.disposed) throw new Error('Editor asset snapshot reader is disposed')
  }
  const finishDisposal = () => {
    if (!state.disposeRequested || state.disposed || state.activeLeases !== 0) return
    state.disposed = true
    for (const bytes of state.assets.values()) bytes.fill(0)
    state.assets.clear()
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
    size(relativePath) {
      assertActive()
      return state.assets.get(relativePath)?.byteLength
    },
    retain(relativePath) {
      assertActive()
      const bytes = state.assets.get(relativePath)
      if (!bytes) return undefined
      state.activeLeases += 1
      let released = false
      let written = false
      return Object.freeze({
        byteLength: bytes.byteLength,
        writeTo(response) {
          if (released) throw new Error('Editor asset snapshot lease is released')
          if (written) throw new Error('Editor asset snapshot lease is already written')
          written = true
          response.end(bytes)
        },
        release() {
          if (released) return
          released = true
          state.activeLeases -= 1
          finishDisposal()
        },
      })
    },
    paths() {
      assertActive()
      return Object.freeze([...state.assets.keys()])
    },
    dispose() {
      if (state.disposeRequested || state.disposed) return
      state.disposeRequested = true
      finishDisposal()
    },
  })
}

async function collectEditorDist(editorRoot, options = {}, retainBytes = false) {
  const root = path.resolve(editorRoot)
  const limits = editorAssetLimits(options)
  const authority = await createRootAuthority(root, 'output')
  try {
    const first = await distInventory(authority, limits)
    const inventory = []
    const assets = retainBytes ? new Map() : undefined
    let totalBytes = 0
    for (const entry of first.files) {
      const bytes = await readStableRegularFile(authority, entry.path, `output: ${entry.path}`, {
        maxFileBytes: limits.maxEditorAssetBytes,
        maxAggregateBytes: limits.maxEditorSnapshotBytes - totalBytes,
        expected: entry.info,
        onOpened: options.onEditorAssetOpened,
        kind: 'output',
      })
      totalBytes += bytes.byteLength
      if (totalBytes > limits.maxEditorSnapshotBytes) throw new Error('Editor snapshot byte limit exceeded')
      inventory.push({ path: entry.path, byteLength: bytes.byteLength, sha256: sha256(bytes), info: entry.info })
      if (assets) assets.set(entry.path, bytes)
    }
    await assertInventoryBytesUnchanged(
      authority,
      inventory,
      limits,
      'output',
      () => distInventory(authority, limits),
    )
    const digest = createHash('sha256')
    for (const entry of inventory) {
      digest.update(entry.path)
      digest.update('\0')
      digest.update(String(entry.byteLength))
      digest.update('\0')
      digest.update(entry.sha256)
      digest.update('\0')
    }
    const distFiles = inventory.map(({ info: _info, ...entry }) => entry)
    const result = {
      distSha256: digest.digest('hex'),
      distFileCount: inventory.length,
      distFiles,
      ...(assets ? { totalBytes } : {}),
    }
    if (!assets) return result
    const snapshot = Object.freeze({})
    EDITOR_ASSET_SNAPSHOTS.set(snapshot, assets)
    return { ...result, snapshot }
  } finally {
    await closeRootAuthority(authority)
  }
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
  const authority = await createRootAuthority(root, 'input')
  try {
    const first = await sourceInventory(authority, limits)
    if (first.files.length === 0) throw new Error(`Editor source files are missing: ${root}`)
    const digest = createHash('sha256')
    let totalBytes = 0
    const readInventory = []
    for (const entry of first.files) {
      const bytes = await readStableRegularFile(authority, entry.path, `input: ${entry.path}`, {
        maxFileBytes: limits.maxEditorAssetBytes,
        maxAggregateBytes: limits.maxEditorSnapshotBytes - totalBytes,
        expected: entry.info,
        onOpened: options.onEditorAssetOpened,
        kind: 'input',
      })
      totalBytes += bytes.byteLength
      if (totalBytes > limits.maxEditorSnapshotBytes) throw new Error('Editor snapshot byte limit exceeded')
      digest.update(entry.path)
      digest.update('\0')
      digest.update(bytes)
      digest.update('\0')
      readInventory.push({ path: entry.path, byteLength: bytes.byteLength, sha256: sha256(bytes), info: entry.info })
    }
    await assertInventoryBytesUnchanged(
      authority,
      readInventory,
      limits,
      'input',
      () => sourceInventory(authority, limits),
    )
    return { sourceSha256: digest.digest('hex'), sourceFileCount: first.files.length }
  } finally {
    await closeRootAuthority(authority)
  }
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
  let authority
  try {
    authority = await createRootAuthority(root, 'marker')
    const bytes = await readStableRegularFile(authority, EDITOR_BUILD_FINGERPRINT_FILE, 'marker', {
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
  } finally {
    if (authority) await closeRootAuthority(authority)
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
