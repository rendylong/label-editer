import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { publishAtomically } from '../scripts/lib/files.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the internal renderer.
import { renderDesignReview } from '../scripts/lib/design-review.mjs'

const temporaryDirectories: string[] = []
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dimensionedPng(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes.writeUInt32BE(pngCrc32(bytes.subarray(12, 29)), 29)
  return bytes
}

const filesModuleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/lib/files.mjs')).href
const childPublisher = String.raw`
  import { open, rename, rm, rmdir } from 'node:fs/promises'
  const { publishAtomically } = await import(process.env.FILES_MODULE_URL)
  const output = process.env.OUTPUT_DIR
  const round = process.env.ROUND
  const boundary = process.env.FAIL_BOUNDARY || ''
  let initializationDelayMs = Number(process.env.INITIALIZATION_DELAY_MS || 0)
  const crash = () => process.exit(86)
  let verifiedMarkerWritten = false
  let recoveryClaimOpened = false
  const fileSystem = {
    async open(target, flags) {
      if (boundary === 'initialize-owner' && target.endsWith('owner.json')) crash()
      if (target.endsWith('recovery.json')) recoveryClaimOpened = true
      if (initializationDelayMs > 0 && /transaction\.[^.]+\.tmp$/.test(String(target))) {
        const delay = initializationDelayMs
        initializationDelayMs = 0
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      const handle = await open(target, flags)
      if (boundary === 'after-verified-marker' && verifiedMarkerWritten
        && target.endsWith('.publish.lock') && flags === 'r') {
        return new Proxy(handle, {
          get(subject, property) {
            if (property === 'sync') return async () => { await subject.sync(); crash() }
            const value = Reflect.get(subject, property, subject)
            return typeof value === 'function' ? value.bind(subject) : value
          },
        })
      }
      return handle
    },
    async rename(source, target) {
      await rename(source, target)
      if (boundary === 'claim-release-owner' && /[/\\]owner\.json\.cleanup-[0-9a-f]{24}$/.test(String(target))) crash()
      if (boundary === 'rename-journal' && target.endsWith('transaction.json')) crash()
      if (boundary === 'rename-existing' && source === output && target.endsWith('.backup')) crash()
      if (boundary === 'rename-staging' && source.endsWith('.tmp') && target === output) crash()
      if (target.endsWith('published.verified')) verifiedMarkerWritten = true
      if (boundary === 'rename-lock-release' && source.endsWith('.publish.lock') && target.endsWith('.released')) crash()
    },
    async rm(target, options) {
      await rm(target, options)
      if (recoveryClaimOpened && boundary === 'recover-remove-journal' && target.endsWith('transaction.json')) crash()
      if (recoveryClaimOpened && boundary === 'recover-remove-staged' && target.endsWith('staged.complete')) crash()
      if (recoveryClaimOpened && boundary === 'recover-remove-verified' && target.endsWith('published.verified')) crash()
      if (boundary === 'cleanup-release-owner' && /[/\\]owner\.json\.cleanup-[0-9a-f]{24}$/.test(String(target))) crash()
      if (boundary === 'cleanup-release-staged' && /[/\\]staged\.complete\.cleanup-[0-9a-f]{24}$/.test(String(target))) crash()
      if (boundary === 'cleanup-backup' && target.endsWith('.backup')) crash()
      if (boundary === 'cleanup-journal' && target.endsWith('transaction.json')) crash()
      if (boundary === 'cleanup-lock' && target.endsWith('.released')) crash()
    },
    async rmdir(target) {
      await rmdir(target)
      if (boundary === 'cleanup-lock' && target.includes('.cleanup.r.')) crash()
    },
  }
  const artifacts = [
    { relativePath: 'one.txt', fileName: 'one.txt', bytes: Buffer.from(round + '-one') },
    { relativePath: 'two.txt', fileName: 'two.txt', bytes: Buffer.from(round + '-two') },
  ]
  try {
    await publishAtomically(output, artifacts, {
      force: process.env.FORCE === '1', sessionId: round, fileSystem,
      validatePublished: async () => { if (boundary === 'validate-published') crash() },
    })
  } catch (error) {
    if (error && error.code === 'OUTPUT_CONFLICT') process.exitCode = 9
    else {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exitCode = 1
    }
  }
`

function artifacts(round: string) {
  return [
    { relativePath: 'one.txt', fileName: 'one.txt', bytes: Buffer.from(`${round}-one`) },
    { relativePath: 'two.txt', fileName: 'two.txt', bytes: Buffer.from(`${round}-two`) },
  ]
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'label-publication-'))
  temporaryDirectories.push(directory)
  return directory
}

async function readRound(output: string) {
  const [one, two] = await Promise.all([
    readFile(path.join(output, 'one.txt'), 'utf8'),
    readFile(path.join(output, 'two.txt'), 'utf8'),
  ])
  expect(two).toBe(`${one.slice(0, -4)}-two`)
  return one.slice(0, -4)
}

function runPublisher(input: {
  output: string
  round: string
  force: boolean
  boundary?: string
  initializationDelayMs?: number
}) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childPublisher], {
      env: {
        ...process.env,
        FILES_MODULE_URL: filesModuleUrl,
        OUTPUT_DIR: input.output,
        ROUND: input.round,
        FORCE: input.force ? '1' : '0',
        FAIL_BOUNDARY: input.boundary ?? '',
        INITIALIZATION_DELAY_MS: String(input.initializationDelayMs ?? 0),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

async function waitForPath(target: string) {
  const started = Date.now()
  while (true) {
    if (await stat(target).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error))) return
    if (Date.now() - started >= 2_000) throw new Error(`Timed out waiting for path: ${target}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function findFileWithContents(directory: string, expected: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFileWithContents(target, expected)
      if (nested) return nested
    } else if (entry.isFile() && await readFile(target, 'utf8').then(
      (contents) => contents === expected,
      () => false,
    )) return target
  }
  return undefined
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('atomic directory publication recovery', () => {
  it('preserves the exact .publish.lock.notes.tmp sibling and its sentinel during normal publication', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const notes = path.join(root, '.review.publish.lock.notes.tmp')
    const sentinel = path.join(notes, 'sentinel')
    await mkdir(notes)
    await writeFile(sentinel, 'user-owned')

    await publishAtomically(output, artifacts('new'), { sessionId: 'normal' })

    expect(await readRound(output)).toBe('new')
    expect(await readFile(sentinel, 'utf8')).toBe('user-owned')
  })

  it('ignores malformed, confusable, wrong-type, symlink, and unowned lock-residue siblings', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const prefix = path.join(root, '.review.publish.lock')
    const preservedDirectories = [
      `${prefix}.0.review-0123456789ab.tmp`,
      `${prefix}.01.review-0123456789ab.tmp`,
      `${prefix}.999991.review-0123456789ab.notes.tmp`,
      `${prefix}.999992.review-0123456789AB.tmp`,
      `${prefix}.１２３.review-0123456789ab.tmp`,
      `${prefix}.999993.review-0123456789ab`,
    ]
    for (const directory of preservedDirectories) {
      await mkdir(directory)
      await writeFile(path.join(directory, 'sentinel'), path.basename(directory))
    }

    const malformedMetadata = `${prefix}.999994.review-0123456789ab.tmp`
    await mkdir(malformedMetadata)
    await writeFile(path.join(malformedMetadata, 'owner.json'), JSON.stringify({
      version: 1,
      pid: 999994,
      token: 'different-0123456789ab',
    }))
    await writeFile(path.join(malformedMetadata, 'sentinel'), 'malformed-metadata')

    const unownedResidue = `${prefix}.999998.unowned-0123456789ab.tmp`
    await mkdir(unownedResidue)
    await writeFile(path.join(unownedResidue, 'sentinel'), 'unowned-nonempty')

    const ownedWithUnexpectedEntry = `${prefix}.999990.owned-0123456789ab.tmp`
    await mkdir(ownedWithUnexpectedEntry)
    await writeFile(path.join(ownedWithUnexpectedEntry, 'owner.json'), JSON.stringify({
      version: 1,
      pid: 999990,
      token: 'owned-0123456789ab',
    }))
    await writeFile(path.join(ownedWithUnexpectedEntry, 'sentinel'), 'unexpected-user-entry')

    const externalOwner = path.join(root, 'external-owner.json')
    await writeFile(externalOwner, JSON.stringify({ version: 1, pid: 999995, token: 'review-0123456789ab' }))
    const symlinkedMetadata = `${prefix}.999995.review-0123456789ab.tmp`
    await mkdir(symlinkedMetadata)
    await symlink(externalOwner, path.join(symlinkedMetadata, 'owner.json'))
    await writeFile(path.join(symlinkedMetadata, 'sentinel'), 'symlinked-metadata')

    const fileResidue = `${prefix}.999996.review-0123456789ab.tmp`
    await writeFile(fileResidue, 'ordinary-file')
    const externalDirectory = path.join(root, 'external-directory')
    await mkdir(externalDirectory)
    await writeFile(path.join(externalDirectory, 'sentinel'), 'external')
    const symlinkResidue = `${prefix}.999997.review-0123456789ab.tmp`
    await symlink(externalDirectory, symlinkResidue)

    const activeToken = 'active-0123456789ab'
    const activeResidue = `${prefix}.${process.ppid}.${activeToken}.tmp`
    await mkdir(activeResidue)
    await writeFile(path.join(activeResidue, 'owner.json'), JSON.stringify({
      version: 1,
      pid: process.ppid,
      token: activeToken,
    }))
    await writeFile(path.join(activeResidue, 'sentinel'), 'active-owner')
    const activePreOwnerResidue = `${prefix}.${process.ppid}.active-pre-owner-0123456789ab.tmp`
    await mkdir(activePreOwnerResidue)

    await publishAtomically(output, artifacts('new'), { sessionId: 'normal' })

    expect(await readRound(output)).toBe('new')
    for (const directory of preservedDirectories) {
      expect(await readFile(path.join(directory, 'sentinel'), 'utf8')).toBe(path.basename(directory))
    }
    expect(await readFile(path.join(malformedMetadata, 'sentinel'), 'utf8')).toBe('malformed-metadata')
    expect(await readFile(path.join(unownedResidue, 'sentinel'), 'utf8')).toBe('unowned-nonempty')
    expect(await readFile(path.join(ownedWithUnexpectedEntry, 'sentinel'), 'utf8')).toBe('unexpected-user-entry')
    expect(await readFile(path.join(symlinkedMetadata, 'sentinel'), 'utf8')).toBe('symlinked-metadata')
    expect(await readlink(path.join(symlinkedMetadata, 'owner.json'))).toBe(externalOwner)
    expect(await readFile(fileResidue, 'utf8')).toBe('ordinary-file')
    expect(await readlink(symlinkResidue)).toBe(externalDirectory)
    expect(await readFile(path.join(externalDirectory, 'sentinel'), 'utf8')).toBe('external')
    expect(await readFile(path.join(activeResidue, 'sentinel'), 'utf8')).toBe('active-owner')
    expect((await stat(activePreOwnerResidue)).isDirectory()).toBe(true)
  })

  it('cleans a genuine dead recovery release using its exact long generated token and recovery owner', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const originalPid = 2_147_483_646
    const recoveryPid = 2_147_483_647
    const sanitizedSession = 'x'.repeat(160)
    const originalToken = `${sanitizedSession}-0123456789ab`
    const recoveryToken = `recovery-${originalToken}`
    const residue = path.join(root, `.review.publish.lock.${recoveryPid}.${recoveryToken}.released`)
    await mkdir(residue)
    await writeFile(path.join(residue, 'owner.json'), JSON.stringify({
      version: 1,
      pid: originalPid,
      token: originalToken,
    }))
    await writeFile(path.join(residue, 'recovery.json'), JSON.stringify({
      version: 1,
      pid: recoveryPid,
      token: recoveryToken,
    }))

    await publishAtomically(output, artifacts('new'), { sessionId: 'normal' })

    expect(await readRound(output)).toBe('new')
    await expect(stat(residue)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finishes non-recursive cleanup of an empty exact release left after its identity file was removed', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const residue = path.join(root, '.review.publish.lock.999989.cleanup-0123456789ab.released')
    await mkdir(residue)

    await publishAtomically(output, artifacts('new'), { sessionId: 'normal' })

    expect(await readRound(output)).toBe('new')
    await expect(stat(residue)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a residue whose PID is outside the positive signed range supported by process.kill', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const pid = 2_147_483_648
    const token = 'outside-pid-range-0123456789ab'
    const residue = path.join(root, `.review.publish.lock.${pid}.${token}.tmp`)
    await mkdir(residue)
    await writeFile(path.join(residue, 'owner.json'), JSON.stringify({ version: 1, pid, token }))

    await publishAtomically(output, artifacts('new'), { sessionId: 'normal' })

    expect(await readRound(output)).toBe('new')
    expect((await stat(residue)).isDirectory()).toBe(true)
  })

  it('preserves ownership when process.kill cannot determine whether a valid PID is alive', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const pid = 2_147_483_647
    const token = 'indeterminate-owner-0123456789ab'
    const residue = path.join(root, `.review.publish.lock.${pid}.${token}.tmp`)
    await mkdir(residue)
    await writeFile(path.join(residue, 'owner.json'), JSON.stringify({ version: 1, pid, token }))
    const realKill = process.kill.bind(process)
    const kill = vi.spyOn(process, 'kill').mockImplementation(((candidate: number, signal?: NodeJS.Signals | number) => {
      if (candidate === pid) throw Object.assign(new Error('indeterminate owner state'), { code: 'EINVAL' })
      return realKill(candidate, signal as NodeJS.Signals | number)
    }) as typeof process.kill)

    try {
      await publishAtomically(output, artifacts('new'), { sessionId: 'normal' })
    } finally {
      kill.mockRestore()
    }

    expect(await readRound(output)).toBe('new')
    expect((await stat(residue)).isDirectory()).toBe(true)
  })

  it('preserves exact-name residues whose metadata combination is impossible for their suffix phase', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const prefix = path.join(root, '.review.publish.lock')
    const cases = [
      { pid: 2_147_483_640, token: 'tmp-recovery-0123456789ab', suffix: '.tmp', files: ['recovery.json'] },
      { pid: 2_147_483_641, token: 'tmp-journal-0123456789ab', suffix: '.tmp', files: ['transaction.json'] },
      { pid: 2_147_483_642, token: 'tmp-marker-0123456789ab', suffix: '.tmp', files: ['owner.json', 'staged.complete'] },
      { pid: 2_147_483_643, token: 'released-journal-0123456789ab', suffix: '.released', files: ['transaction.json'] },
      { pid: 2_147_483_644, token: 'released-phase-0123456789ab', suffix: '.released', files: ['owner.json', 'staged.complete'] },
    ]
    const residues: string[] = []
    for (const entry of cases) {
      const residue = `${prefix}.${entry.pid}.${entry.token}${entry.suffix}`
      residues.push(residue)
      await mkdir(residue)
      for (const fileName of entry.files) {
        if (fileName === 'owner.json' || fileName === 'recovery.json') {
          await writeFile(path.join(residue, fileName), JSON.stringify({
            version: 1, pid: entry.pid, token: entry.token,
          }))
        } else if (fileName === 'transaction.json') {
          await writeFile(path.join(residue, fileName), JSON.stringify({
            version: 1,
            pid: entry.pid,
            token: entry.token,
            outputName: 'review',
            temporaryName: `.review.${entry.token}.tmp`,
            backupName: `.review.${entry.token}.backup`,
            hadExisting: false,
          }))
        } else {
          await writeFile(path.join(residue, fileName), '')
        }
      }
    }

    await publishAtomically(output, artifacts('new'), { sessionId: 'normal' })

    expect(await readRound(output)).toBe('new')
    for (const residue of residues) expect((await stat(residue)).isDirectory()).toBe(true)
  })

  it.each([
    ['cleanup-release-owner', ['staged.complete', 'published.verified']],
    ['cleanup-release-staged', ['published.verified']],
  ] as const)('converges a genuine marker-only release after %s is interrupted', async (boundary, expectedMarkers) => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')

    const interrupted = await runPublisher({ output, round: boundary, force: false, boundary })
    expect(interrupted, interrupted.stderr).toMatchObject({ code: 86 })
    const residueName = (await readdir(root)).find((entry) => entry.includes('.cleanup.r.'))
    expect(residueName).toBeDefined()
    expect((await readdir(path.join(root, residueName!))).sort()).toEqual([...expectedMarkers].sort())

    await expect(publishAtomically(output, artifacts('probe'), { sessionId: 'probe' }))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
    expect(await readRound(output)).toBe(boundary)
    expect(await readdir(root)).toEqual(['round-0'])
  })

  it('converges when cleanup crashes after atomically claiming a verified metadata inode', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')

    const interrupted = await runPublisher({
      output, round: 'claimed-owner', force: false, boundary: 'claim-release-owner',
    })
    expect(interrupted, interrupted.stderr).toMatchObject({ code: 86 })
    const residueName = (await readdir(root)).find((entry) => entry.includes('.cleanup.r.'))
    expect(residueName).toBeDefined()
    expect(await readdir(path.join(root, residueName!))).toEqual(expect.arrayContaining([
      expect.stringMatching(/^owner\.json\.cleanup-[0-9a-f]{24}$/),
      'staged.complete',
      'published.verified',
    ]))

    await expect(publishAtomically(output, artifacts('probe'), { sessionId: 'probe' }))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
    expect(await readRound(output)).toBe('claimed-owner')
    expect(await readdir(root)).toEqual(['round-0'])
  })

  it('preserves a replacement directory swapped in immediately before the cleanup claim', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const pid = 2_147_483_639
    const token = 'directory-swap-0123456789ab'
    const residue = path.join(root, `.review.publish.lock.${pid}.${token}.tmp`)
    const original = `${residue}.original`
    await mkdir(residue)
    await writeFile(path.join(residue, 'owner.json'), JSON.stringify({ version: 1, pid, token }))
    let swapped = false

    await publishAtomically(output, artifacts('new'), {
      sessionId: 'normal',
      fileSystem: {
        async rename(source: string, target: string) {
          if (!swapped && source === residue && path.basename(target).includes('.cleanup.t.')) {
            await rename(source, original)
            await mkdir(source)
            await writeFile(path.join(source, 'sentinel'), 'user-owned replacement directory')
            swapped = true
          }
          await rename(source, target)
        },
      },
    })

    expect(swapped).toBe(true)
    expect(await findFileWithContents(root, 'user-owned replacement directory')).toBeDefined()
    expect((await stat(original)).isDirectory()).toBe(true)
    expect(await readRound(output)).toBe('new')
  })

  it('preserves a replacement metadata inode swapped in immediately before the file claim', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const pid = 2_147_483_638
    const token = 'metadata-swap-0123456789ab'
    const residue = path.join(root, `.review.publish.lock.${pid}.${token}.tmp`)
    await mkdir(residue)
    await writeFile(path.join(residue, 'owner.json'), JSON.stringify({ version: 1, pid, token }))
    let replacementClaim = ''

    await publishAtomically(output, artifacts('new'), {
      sessionId: 'normal',
      fileSystem: {
        async rename(source: string, target: string) {
          if (!replacementClaim && path.basename(source) === 'owner.json'
            && /^owner\.json\.cleanup-[0-9a-f]{24}$/.test(path.basename(target))) {
            await rename(source, `${source}.original`)
            await writeFile(source, 'user-owned replacement metadata')
            replacementClaim = target
          }
          await rename(source, target)
        },
      },
    })

    expect(replacementClaim).not.toBe('')
    expect(await findFileWithContents(root, 'user-owned replacement metadata')).toBeDefined()
    expect(await readRound(output)).toBe('new')
  })

  it('never unlinks a replacement metadata inode installed while the verified claim handle closes', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const pid = 2_147_483_637
    const token = 'close-swap-0123456789ab'
    const residue = path.join(root, `.review.publish.lock.${pid}.${token}.tmp`)
    await mkdir(residue)
    await writeFile(path.join(residue, 'owner.json'), JSON.stringify({ version: 1, pid, token }))
    let replacementInode: bigint | number | undefined
    let swapped = false

    await publishAtomically(output, artifacts('new'), {
      sessionId: 'normal',
      fileSystem: {
        async open(target: string, flags: string | number) {
          const handle = await open(target, flags)
          if (!swapped && /^owner\.json\.cleanup-[0-9a-f]{24}$/.test(path.basename(target))) {
            return new Proxy(handle, {
              get(subject, property) {
                if (property === 'close') return async () => {
                  await subject.close()
                  await rename(target, `${target}.publisher-inode`)
                  await writeFile(target, 'user-owned replacement after verified handle close')
                  replacementInode = (await stat(target, { bigint: true })).ino
                  swapped = true
                }
                const value = Reflect.get(subject, property, subject)
                return typeof value === 'function' ? value.bind(subject) : value
              },
            })
          }
          return handle
        },
      },
    })

    expect(swapped).toBe(true)
    const replacement = await findFileWithContents(root, 'user-owned replacement after verified handle close')
    expect(replacement).toBeDefined()
    expect((await stat(replacement!, { bigint: true })).ino).toBe(replacementInode)
    expect(await readRound(output)).toBe('new')
  })

  it('publishes and cleans a 180-byte output name despite fixed cleanup-claim collisions', async () => {
    const root = await temporaryDirectory()
    const base = 'r'.repeat(180)
    const output = path.join(root, base)
    const pid = 2_147_483_636
    const token = 'long-output-0123456789ab'
    const residue = path.join(root, `.${base}.publish.lock.${pid}.${token}.tmp`)
    await mkdir(residue)
    await writeFile(path.join(residue, 'owner.json'), JSON.stringify({ version: 1, pid, token }))
    let collisions = 0

    await publishAtomically(output, artifacts('new'), {
      sessionId: 's'.repeat(500),
      fileSystem: {
        async rename(source: string, target: string) {
          if (source === residue && target.includes('.cleanup.') && collisions < 3) {
            collisions += 1
            throw Object.assign(new Error('fixed cleanup claim collision'), { code: 'EEXIST' })
          }
          await rename(source, target)
        },
      },
    })

    expect(collisions).toBe(3)
    expect(await readRound(output)).toBe('new')
    expect(await readdir(root)).toEqual([base])
  })

  it('preflights component NAME_MAX before any publication mutation', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'x'.repeat(256))
    let mutationAttempted = false

    await expect(publishAtomically(output, artifacts('new'), {
      sessionId: 'normal',
      fileSystem: {
        async mkdir(target: string, options?: Parameters<typeof mkdir>[1]) {
          mutationAttempted = true
          return mkdir(target, options)
        },
        async open(target: string, flags: string | number) {
          mutationAttempted = true
          return open(target, flags)
        },
        async rename(source: string, target: string) {
          mutationAttempted = true
          return rename(source, target)
        },
        async rm(target: string, options?: Parameters<typeof rm>[1]) {
          mutationAttempted = true
          return rm(target, options)
        },
      },
    })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })

    expect(mutationAttempted).toBe(false)
    expect(await readdir(root)).toEqual([])
  })

  it('converges a handled marker-only cleanup claim later in the same process', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    let injected = false

    await expect(publishAtomically(output, artifacts('first'), {
      sessionId: 'first',
      fileSystem: {
        async rm(target: string, options?: Parameters<typeof rm>[1]) {
          if (!injected && /^published\.verified\.cleanup-[0-9a-f]{24}$/.test(path.basename(target))) {
            injected = true
            throw Object.assign(new Error('handled final marker cleanup failure'), { code: 'EIO' })
          }
          return rm(target, options)
        },
      },
    })).rejects.toThrow('handled final marker cleanup failure')
    expect(injected).toBe(true)
    expect(await readRound(output)).toBe('first')
    expect((await readdir(root)).some((entry) => entry.includes('.cleanup.'))).toBe(true)

    await expect(publishAtomically(output, artifacts('probe'), { sessionId: 'probe' }))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })

    expect(await readRound(output)).toBe('first')
    expect(await readdir(root)).toEqual(['review'])
  })

  it('uses one Unicode-safe canonical token grammar for NFKC input ending at an astral boundary', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    const sessionId = `${'Ａ'.repeat(159)}𐐷`

    const interrupted = await runPublisher({
      output, round: sessionId, force: false, boundary: 'initialize-owner',
    })
    expect(interrupted, interrupted.stderr).toMatchObject({ code: 86 })

    await publishAtomically(output, artifacts('new'), { sessionId: 'normal' })

    expect(await readRound(output)).toBe('new')
    expect(await readdir(root)).toEqual(['review'])
  })

  it.each([
    ['initialize-owner', 'old'],
    ['rename-journal', 'old'],
    ['rename-existing', 'old'],
    ['rename-staging', 'old'],
    ['rename-lock-release', 'new-rename-lock-release'],
    ['cleanup-backup', 'new-cleanup-backup'],
    ['cleanup-journal', 'new-cleanup-journal'],
    ['cleanup-lock', 'new-cleanup-lock'],
  ])('recovers a complete interrupted round after %s', async (boundary, expectedRound) => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')
    await publishAtomically(output, artifacts('old'), { sessionId: 'old' })

    const interrupted = await runPublisher({ output, round: `new-${boundary}`, force: true, boundary })

    expect(interrupted, interrupted.stderr).toMatchObject({ code: 86 })
    await expect(publishAtomically(output, artifacts('probe'), { sessionId: 'probe' }))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
    expect(await readRound(output)).toBe(expectedRound)
    expect(await readdir(root)).toEqual(['round-0'])
  })

  it.each([
    'recover-remove-journal',
    'recover-remove-staged',
    'recover-remove-verified',
  ])('converges a verified publication when recovery crashes after %s', async (boundary) => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')
    const publishedRound = 'new-after-verified-marker'
    const published = await runPublisher({
      output, round: publishedRound, force: false, boundary: 'after-verified-marker',
    })
    expect(published, published.stderr).toMatchObject({ code: 86 })

    const interruptedRecovery = await runPublisher({
      output, round: `recovery-${boundary}`, force: true, boundary,
    })
    expect(interruptedRecovery, interruptedRecovery.stderr).toMatchObject({ code: 86 })

    await expect(publishAtomically(output, artifacts('probe'), { sessionId: 'probe' }))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
    expect(await readRound(output)).toBe(publishedRound)
    expect(await readdir(root)).toEqual(['round-0'])
  })

  it.each([
    ['validate-published', false, 'absent'],
    ['validate-published', true, 'old'],
    ['after-verified-marker', false, 'new-after-verified-marker'],
    ['after-verified-marker', true, 'new-after-verified-marker'],
  ] as const)('recovers %s crash with prior output %s to %s and removes transaction residue', async (boundary, prior, expected) => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')
    if (prior) await publishAtomically(output, artifacts('old'), { sessionId: 'old' })

    const interrupted = await runPublisher({
      output, round: `new-${boundary}`, force: prior, boundary,
    })
    expect(interrupted, interrupted.stderr).toMatchObject({ code: 86 })

    if (expected === 'absent') {
      await expect(publishAtomically(output, artifacts('probe'), {
        sessionId: 'probe', beforeCommit: async () => { throw new Error('recovery probe') },
      })).rejects.toThrow('recovery probe')
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(root)).toEqual([])
    } else {
      await expect(publishAtomically(output, artifacts('probe'), { sessionId: 'probe' }))
        .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
      expect(await readRound(output)).toBe(expected)
      expect(await readdir(root)).toEqual(['round-0'])
    }
  })

  it('serializes concurrent forced publishers to one complete old-or-new round', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')
    await publishAtomically(output, artifacts('old'), { sessionId: 'old' })

    const results = await Promise.all([
      runPublisher({ output, round: 'writer-a', force: true }),
      runPublisher({ output, round: 'writer-b', force: true }),
    ])

    expect(results, results.map((result) => result.stderr).join('\n')).toMatchObject([{ code: 0 }, { code: 0 }])
    expect(['writer-a', 'writer-b']).toContain(await readRound(output))
    expect(await readdir(root)).toEqual(['round-0'])
  })

  it('does not steal a live publisher delayed before journal initialization', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')
    await publishAtomically(output, artifacts('old'), { sessionId: 'old' })

    const first = runPublisher({
      output,
      round: 'delayed-writer',
      force: true,
      initializationDelayMs: 600,
    })
    await waitForPath(path.join(root, '.round-0.publish.lock'))
    const second = runPublisher({ output, round: 'following-writer', force: true })
    const results = await Promise.all([first, second])

    expect(results, results.map((result) => result.stderr).join('\n')).toMatchObject([{ code: 0 }, { code: 0 }])
    expect(['delayed-writer', 'following-writer']).toContain(await readRound(output))
    expect(await readdir(root)).toEqual(['round-0'])
  })

  it('recovers an orphaned pre-owner lock directory', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')
    await mkdir(path.join(root, '.round-0.publish.lock'))

    const result = await runPublisher({ output, round: 'recovered', force: true })

    expect(result, result.stderr).toMatchObject({ code: 0 })
    expect(await readRound(output)).toBe('recovered')
    expect(await readdir(root)).toEqual(['round-0'])
  })

  it('allows exactly one concurrent non-forced publisher and returns OUTPUT_CONFLICT for the other', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'round-0')

    const results = await Promise.all([
      runPublisher({ output, round: 'writer-a', force: false }),
      runPublisher({ output, round: 'writer-b', force: false }),
    ])

    expect(results.map((result) => result.code).sort(), results.map((result) => result.stderr).join('\n')).toEqual([0, 9])
    expect(['writer-a', 'writer-b']).toContain(await readRound(output))
    expect(await readdir(root)).toEqual(['round-0'])
  })

  it('rejects a concurrent review publisher immediately instead of queueing behind the active transaction', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const first = publishAtomically(output, artifacts('first'), {
      sessionId: 'first',
      rejectConcurrent: true,
      beforeCommit: async () => { entered(); await blocked },
    })
    await started
    await expect(publishAtomically(output, artifacts('second'), {
      sessionId: 'second', rejectConcurrent: true,
    })).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
    release()
    await first
    expect(await readRound(output)).toBe('first')
    expect(await readdir(root)).toEqual(['review'])
  })

  it('restores the prior complete output when post-publication readback fails under force', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    await publishAtomically(output, artifacts('old'), { sessionId: 'old' })

    await expect(publishAtomically(output, artifacts('new'), {
      force: true,
      sessionId: 'new',
      validateStaged: async (directory: string) => {
        expect(await readRound(directory)).toBe('new')
      },
      validatePublished: async () => { throw new Error('injected published readback failure') },
    })).rejects.toThrow(/injected published readback failure/)

    expect(await readRound(output)).toBe('old')
    expect(await readdir(root)).toEqual(['review'])
  })

  it.each([
    ['validateStaged', false], ['validateStaged', true],
    ['beforeCommit', false], ['beforeCommit', true],
  ] as const)('never installs staging when %s fails (prior output: %s)', async (hook, prior) => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    if (prior) await publishAtomically(output, artifacts('old'), { sessionId: 'old' })
    const injected = async () => { throw new Error(`injected ${hook} failure`) }

    await expect(publishAtomically(output, artifacts('new'), {
      force: prior,
      sessionId: 'new',
      ...(hook === 'validateStaged' ? { validateStaged: injected } : { beforeCommit: injected }),
    })).rejects.toThrow(`injected ${hook} failure`)

    if (prior) expect(await readRound(output)).toBe('old')
    else await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual(prior ? ['review'] : [])
  })

  it('removes a newly installed output when post-publication validation fails without a prior output', async () => {
    const root = await temporaryDirectory()
    const output = path.join(root, 'review')
    await expect(publishAtomically(output, artifacts('new'), {
      sessionId: 'new', validatePublished: async () => { throw new Error('post-publish failure') },
    })).rejects.toThrow('post-publish failure')
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a final-component output symlink without replacing it or touching its target', async () => {
    const root = await temporaryDirectory()
    const target = path.join(root, 'target')
    const output = path.join(root, 'review')
    await mkdir(target)
    await writeFile(path.join(target, 'sentinel.txt'), 'preserved')
    await symlink(target, output)

    await expect(publishAtomically(output, artifacts('new'), { force: true, sessionId: 'new' }))
      .rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    expect(await readlink(output)).toBe(target)
    expect(await readFile(path.join(target, 'sentinel.txt'), 'utf8')).toBe('preserved')
    expect((await readdir(root)).sort()).toEqual(['review', 'target'])
  })

  it('exposes exactly one complete design review under concurrent non-forced publication', async () => {
    const root = await temporaryDirectory()
    const outputDir = path.join(root, 'review')
    const blueprintPath = path.join(root, 'layout-blueprint.json')
    await writeFile(blueprintPath, JSON.stringify({
      version: 1, revision: 'rev-atomic', carrierDefaults: { carrier: 'bare' }, assets: [],
      areas: [
        { id: 'front', side: 'front', carrier: 'bare', artboard: { widthMm: 40, heightMm: 60, background: 'transparent' }, placementIntent: 'Front', layers: [] },
        { id: 'back', side: 'back', carrier: 'bare', artboard: { widthMm: 40, heightMm: 60, background: 'transparent' }, placementIntent: 'Back', layers: [] },
      ],
    }))
    const capture = async ({ width, height }: { width: number; height: number }) => ({
      front: { bytes: dimensionedPng(width, height), width, height },
      back: { bytes: dimensionedPng(width, height), width, height },
      areas: {},
    })

    const settled = await Promise.allSettled([
      renderDesignReview({ blueprintPath, outputDir, width: 320, height: 240, pxPerMm: 2, capture }),
      renderDesignReview({ blueprintPath, outputDir, width: 320, height: 240, pxPerMm: 2, capture }),
    ])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await readdir(outputDir)).toEqual(expect.arrayContaining([
      'design-review-manifest.json', 'mockup-back.png', 'mockup-front.png', 'mockup.html',
    ]))
    expect(await readdir(root)).toEqual(['layout-blueprint.json', 'review'])
  })
})
