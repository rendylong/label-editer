import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const EDITOR_BUILD_FINGERPRINT_FILE = 'build-fingerprint.json'
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

async function readStableRegularFile(absolutePath, description) {
  const before = await lstat(absolutePath)
  if (before.isSymbolicLink()) throw new Error(`Editor build fingerprint refuses symbolic link ${description}`)
  if (!before.isFile()) throw new Error(`Editor build fingerprint requires a regular file: ${description}`)
  const bytes = await readFile(absolutePath)
  const after = await lstat(absolutePath)
  if (!sameFileState(before, after)) throw new Error(`Editor build changed while fingerprinting: ${description}`)
  return bytes
}

async function distFiles(root, relativePath = '') {
  const absolute = relativePath ? path.join(root, relativePath) : root
  const displayPath = relativePath.split(path.sep).join('/') || '.'
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
  if (info.isFile()) return [displayPath]
  if (!info.isDirectory()) throw new Error(`Editor build fingerprint refuses non-regular output: ${displayPath}`)
  const entries = await readdir(absolute)
  const nested = await Promise.all(entries.sort().map((entry) => distFiles(root, path.join(relativePath, entry))))
  return nested.flat()
}

export async function editorDistFingerprint(editorRoot) {
  const root = path.resolve(editorRoot)
  const files = (await distFiles(root)).sort()
  if (!files.includes('index.html')) throw new Error('Stale editor build: dist/index.html is missing')
  const inventory = []
  for (const relativePath of files) {
    const bytes = await readStableRegularFile(path.join(root, relativePath), `output: ${relativePath}`)
    inventory.push({ path: relativePath, byteLength: bytes.byteLength, sha256: sha256(bytes) })
  }
  const finalFiles = (await distFiles(root)).sort()
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
  return { distSha256: digest.digest('hex'), distFileCount: inventory.length, distFiles: inventory }
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

export async function assertFreshEditorBuild(pluginRoot, editorRoot) {
  const root = path.resolve(editorRoot)
  let manifest
  try {
    const markerPath = path.join(root, EDITOR_BUILD_FINGERPRINT_FILE)
    const markerInfo = await lstat(markerPath)
    if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) throw new Error('invalid marker type')
    manifest = JSON.parse(await readFile(markerPath, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || error?.message === 'invalid marker type') {
      throw new Error('Editor build fingerprint is invalid')
    }
    throw new Error('Editor build fingerprint is missing; run the editor build before browser execution')
  }
  const actual = {
    ...await editorSourceFingerprint(pluginRoot),
    ...await editorDistFingerprint(root),
  }
  if (manifest?.version !== 2 || manifest.algorithm !== 'sha256'
    || manifest.sourceSha256 !== actual.sourceSha256
    || manifest.sourceFileCount !== actual.sourceFileCount
    || manifest.distSha256 !== actual.distSha256
    || manifest.distFileCount !== actual.distFileCount
    || JSON.stringify(manifest.distFiles) !== JSON.stringify(actual.distFiles)) {
    throw new Error('Stale editor build: source fingerprint does not match dist')
  }
  return manifest
}
