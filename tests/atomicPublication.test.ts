import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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
  import { open, rename, rm } from 'node:fs/promises'
  const { publishAtomically } = await import(process.env.FILES_MODULE_URL)
  const output = process.env.OUTPUT_DIR
  const round = process.env.ROUND
  const boundary = process.env.FAIL_BOUNDARY || ''
  let initializationDelayMs = Number(process.env.INITIALIZATION_DELAY_MS || 0)
  const crash = () => process.exit(86)
  const fileSystem = {
    async open(target, flags) {
      if (boundary === 'initialize-owner' && target.endsWith('owner.json')) crash()
      if (initializationDelayMs > 0 && /transaction\.[^.]+\.tmp$/.test(String(target))) {
        const delay = initializationDelayMs
        initializationDelayMs = 0
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      return open(target, flags)
    },
    async rename(source, target) {
      await rename(source, target)
      if (boundary === 'rename-journal' && target.endsWith('transaction.json')) crash()
      if (boundary === 'rename-existing' && source === output && target.endsWith('.backup')) crash()
      if (boundary === 'rename-staging' && source.endsWith('.tmp') && target === output) crash()
      if (boundary === 'rename-lock-release' && source.endsWith('.publish.lock') && target.endsWith('.released')) crash()
    },
    async rm(target, options) {
      await rm(target, options)
      if (boundary === 'cleanup-backup' && target.endsWith('.backup')) crash()
      if (boundary === 'cleanup-marker' && target.endsWith('staged.complete')) crash()
      if (boundary === 'cleanup-journal' && target.endsWith('transaction.json')) crash()
      if (boundary === 'cleanup-lock' && target.endsWith('.released')) crash()
    },
  }
  const artifacts = [
    { relativePath: 'one.txt', fileName: 'one.txt', bytes: Buffer.from(round + '-one') },
    { relativePath: 'two.txt', fileName: 'two.txt', bytes: Buffer.from(round + '-two') },
  ]
  try {
    await publishAtomically(output, artifacts, {
      force: process.env.FORCE === '1', sessionId: round, fileSystem,
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('atomic directory publication recovery', () => {
  it.each([
    ['initialize-owner', 'old'],
    ['rename-journal', 'old'],
    ['rename-existing', 'new-rename-existing'],
    ['rename-staging', 'new-rename-staging'],
    ['rename-lock-release', 'new-rename-lock-release'],
    ['cleanup-backup', 'new-cleanup-backup'],
    ['cleanup-marker', 'new-cleanup-marker'],
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
