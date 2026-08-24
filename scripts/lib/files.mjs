import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

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

export async function publishAtomically(outputDir, artifacts, { force = false, sessionId = randomBytes(8).toString('hex') } = {}) {
  const parent = path.dirname(outputDir)
  const base = path.basename(outputDir)
  const temporary = path.join(parent, `.${base}.${sessionId}.tmp`)
  const backup = path.join(parent, `.${base}.${sessionId}.backup`)
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: false })
  let movedExisting = false
  try {
    for (const artifact of artifacts) {
      const fileName = sanitizeArtifactName(artifact.fileName)
      await writeExclusive(path.join(temporary, fileName), artifact.bytes)
    }
    const exists = await stat(outputDir).then(() => true, () => false)
    if (exists && !force) {
      const error = new Error(`Output already exists: ${outputDir}`)
      error.code = 'OUTPUT_CONFLICT'
      throw error
    }
    if (exists) {
      await rm(backup, { recursive: true, force: true })
      await rename(outputDir, backup)
      movedExisting = true
    }
    await rename(temporary, outputDir)
    if (movedExisting) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (movedExisting) {
      const outputExists = await stat(outputDir).then(() => true, () => false)
      if (!outputExists) await rename(backup, outputDir)
    }
    throw error
  }
}
