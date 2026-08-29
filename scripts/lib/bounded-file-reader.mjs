import { constants as fsConstants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import path from 'node:path'

function defaultError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function identity(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':')
}

export function portableRelativePath(value, label = 'Path') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value.includes('\0')
    || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw defaultError('PATH_NOT_ALLOWED', `${label} must be a bounded portable relative path`)
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw defaultError('PATH_NOT_ALLOWED', `${label} must not contain empty, dot, or parent segments`)
  }
  return parts.join('/')
}

export function assertPortablePathSet(values, label = 'Artifact paths') {
  const keys = new Map()
  for (const value of values) {
    const portable = portableRelativePath(value, label)
    const key = portable.normalize('NFKC').toLowerCase()
    const prior = keys.get(key)
    if (prior !== undefined) throw defaultError('PATH_NOT_ALLOWED', `${label} are not portable and unique: ${prior} / ${portable}`)
    keys.set(key, portable)
  }
}

export async function readBoundedRegularFile(filePath, options = {}) {
  const {
    label = 'Input', maxBytes, minBytes = 1, code = 'INVALID_USAGE',
    pathCode = 'PATH_NOT_ALLOWED', makeError = defaultError,
  } = options
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer')
  let before
  try { before = await lstat(filePath, { bigint: true }) } catch (error) {
    throw makeError(pathCode, `${label} does not exist or is unavailable`, { cause: error })
  }
  if (before.isSymbolicLink() || !before.isFile()) throw makeError(pathCode, `${label} must be a regular file and not a symlink`)
  if (before.size < BigInt(minBytes) || before.size > BigInt(maxBytes)) {
    throw makeError(code, `${label} exceeds the bounded size limit (${maxBytes} bytes)`)
  }
  let handle
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch (error) {
    throw makeError(pathCode, `${label} could not be opened as a non-symlink regular file`, { cause: error })
  }
  try {
    const beforeHandle = await handle.stat({ bigint: true })
    if (!beforeHandle.isFile() || identity(beforeHandle) !== identity(before)) {
      throw makeError(code, `${label} changed before bounded readback`)
    }
    // Allocate only the already-lstat-bounded size. Explicit positional reads
    // plus a one-byte growth probe prevent a concurrent writer from making
    // readFile() allocate beyond the declared per-file budget.
    const expectedLength = Number(before.size)
    const bytes = new Uint8Array(expectedLength)
    let offset = 0
    while (offset < expectedLength) {
      const { bytesRead } = await handle.read(bytes, offset, expectedLength - offset, offset)
      if (bytesRead === 0) throw makeError(code, `${label} changed during bounded readback`)
      offset += bytesRead
    }
    const growthProbe = new Uint8Array(1)
    const { bytesRead: growth } = await handle.read(growthProbe, 0, 1, expectedLength)
    if (growth !== 0) throw makeError(code, `${label} grew during bounded readback`)
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ])
    if (afterPath.isSymbolicLink() || !afterPath.isFile() || bytes.byteLength !== Number(before.size)
      || identity(afterHandle) !== identity(before) || identity(afterPath) !== identity(before)) {
      throw makeError(code, `${label} changed during bounded readback`)
    }
    return { bytes, identity: identity(before) }
  } finally {
    await handle.close()
  }
}

export async function assertNoSymlinkPath(root, relativePath, options = {}) {
  const { label = 'Path', makeError = defaultError } = options
  const portable = portableRelativePath(relativePath, label)
  const resolvedRoot = path.resolve(root)
  let current = resolvedRoot
  for (const part of portable.split('/')) {
    current = path.join(current, part)
    let info
    try { info = await lstat(current) } catch (error) {
      throw makeError('PATH_NOT_ALLOWED', `${label} does not exist`, { cause: error })
    }
    if (info.isSymbolicLink()) throw makeError('PATH_NOT_ALLOWED', `${label} must not traverse a symlink`)
  }
  return current
}

export async function snapshotRegularDirectory(root, options = {}) {
  const {
    label = 'Evidence directory', maxFiles = 512, maxDepth = 8,
    maxFileBytes = 32 * 1024 * 1024, maxTotalBytes = 128 * 1024 * 1024,
    makeError = defaultError,
  } = options
  const resolvedRoot = path.resolve(root)
  const rootInfo = await lstat(resolvedRoot).catch((error) => { throw makeError('PATH_NOT_ALLOWED', `${label} is unavailable`, { cause: error }) })
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw makeError('PATH_NOT_ALLOWED', `${label} must be a real directory`)
  const maxEntries = maxFiles * Math.max(1, maxDepth + 1)
  async function inventory() {
    const currentRoot = await lstat(resolvedRoot, { bigint: true })
    if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory()) {
      throw makeError('PATH_NOT_ALLOWED', `${label} must remain a real directory`)
    }
    const files = []
    const identities = [['.', identity(currentRoot)]]
    let total = 0
    let entryCount = 0
    async function visit(directory, prefix, depth) {
      if (depth > maxDepth) throw makeError('INVALID_USAGE', `${label} exceeds the bounded depth limit`)
      const stream = await opendir(directory)
      for await (const entry of stream) {
        entryCount += 1
        if (entryCount > maxEntries) throw makeError('INVALID_USAGE', `${label} exceeds the bounded entry-count limit`)
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        portableRelativePath(relative, label)
        const absolute = path.join(directory, entry.name)
        const info = await lstat(absolute, { bigint: true })
        if (info.isSymbolicLink()) throw makeError('PATH_NOT_ALLOWED', `${label} contains a symlink: ${relative}`)
        if (info.isDirectory()) {
          identities.push([`${relative}/`, identity(info)])
          await visit(absolute, relative, depth + 1)
        } else {
          if (!info.isFile()) throw makeError('PATH_NOT_ALLOWED', `${label} contains a non-regular entry: ${relative}`)
          if (info.size > BigInt(maxFileBytes)) throw makeError('INVALID_USAGE', `${label} file exceeds the bounded size limit: ${relative}`)
          files.push(relative)
          identities.push([relative, identity(info)])
          total += Number(info.size)
          if (files.length > maxFiles || total > maxTotalBytes) throw makeError('INVALID_USAGE', `${label} exceeds bounded file-count or aggregate-byte limits`)
        }
      }
    }
    await visit(resolvedRoot, '', 0)
    assertPortablePathSet(files, label)
    files.sort()
    identities.sort(([left], [right]) => left.localeCompare(right))
    return { files, identities }
  }
  const before = await inventory()
  const entries = []
  for (const relative of before.files) {
    const { bytes } = await readBoundedRegularFile(path.join(resolvedRoot, ...relative.split('/')), {
      label: `${label}/${relative}`, maxBytes: maxFileBytes, code: 'INVALID_USAGE', makeError,
    })
    entries.push({ path: relative, bytes })
  }
  const after = await inventory()
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw makeError('INVALID_USAGE', `${label} changed during bounded directory snapshot`)
  }
  return entries
}
