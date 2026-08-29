import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Pure Node ESM module is consumed directly by CLI code.
import { assertPortablePathSet, portableRelativePath, readBoundedRegularFile, snapshotRegularDirectory } from '../scripts/lib/bounded-file-reader.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('bounded regular file reader', () => {
  it('rejects platform-specific separators and portable case/normalization collisions', () => {
    expect(() => portableRelativePath('nested\\artifact.png')).toThrow(/portable relative path/i)
    expect(() => assertPortablePathSet(['Area.png', 'area.png'])).toThrow(/portable and unique/i)
    expect(() => assertPortablePathSet(['é.png', 'e\u0301.png'])).toThrow(/portable and unique/i)
  })

  it('rejects an oversized file before returning bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bounded-reader-'))
    temporaryDirectories.push(root)
    const filePath = path.join(root, 'oversized.json')
    await writeFile(filePath, '123456789')
    await expect(readBoundedRegularFile(filePath, { maxBytes: 8 })).rejects.toThrow(/bounded size/i)
  })

  it('rejects symlinked and non-regular directory entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bounded-directory-'))
    temporaryDirectories.push(root)
    await writeFile(path.join(root, 'artifact.png'), 'bytes')
    await symlink('artifact.png', path.join(root, 'alias.png'))
    await expect(snapshotRegularDirectory(root)).rejects.toThrow(/symlink/i)

    await rm(path.join(root, 'alias.png'))
    await mkdir(path.join(root, 'nested'))
    await writeFile(path.join(root, 'nested', 'artifact.png'), 'bytes')
    await expect(snapshotRegularDirectory(root, { maxDepth: 0 })).rejects.toThrow(/depth/i)
  })
})
