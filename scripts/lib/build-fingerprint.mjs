import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
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
    digest.update(await readFile(path.join(root, relativePath)))
    digest.update('\0')
  }
  return { sourceSha256: digest.digest('hex'), sourceFileCount: files.length }
}

export async function writeEditorBuildFingerprint(pluginRoot, editorRoot) {
  const fingerprint = await editorSourceFingerprint(pluginRoot)
  const manifest = { version: 1, algorithm: 'sha256', ...fingerprint }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    path.join(path.resolve(editorRoot), EDITOR_BUILD_FINGERPRINT_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return manifest
}

export async function assertFreshEditorBuild(pluginRoot, editorRoot) {
  const root = path.resolve(editorRoot)
  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(root, EDITOR_BUILD_FINGERPRINT_FILE), 'utf8'))
    await stat(path.join(root, 'index.html'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Editor build fingerprint is invalid')
    throw new Error('Editor build fingerprint is missing; run the editor build before browser execution')
  }
  const actual = await editorSourceFingerprint(pluginRoot)
  if (manifest?.version !== 1 || manifest.algorithm !== 'sha256'
    || manifest.sourceSha256 !== actual.sourceSha256
    || manifest.sourceFileCount !== actual.sourceFileCount) {
    throw new Error('Stale editor build: source fingerprint does not match dist')
  }
  return manifest
}
