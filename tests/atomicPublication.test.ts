import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { publishAtomically } from '../scripts/lib/files.mjs'

const temporaryDirectories: string[] = []
const filesModuleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/lib/files.mjs')).href
const childPublisher = String.raw`
  import { rename, rm } from 'node:fs/promises'
  const { publishAtomically } = await import(process.env.FILES_MODULE_URL)
  const output = process.env.OUTPUT_DIR
  const round = process.env.ROUND
  const boundary = process.env.FAIL_BOUNDARY || ''
  const crash = () => process.exit(86)
  const fileSystem = {
    async rename(source, target) {
      await rename(source, target)
      if (boundary === 'rename-journal' && target.endsWith('transaction.json')) crash()
      if (boundary === 'rename-existing' && source === output && target.endsWith('.backup')) crash()
      if (boundary === 'rename-staging' && source.endsWith('.tmp') && target === output) crash()
    },
    async rm(target, options) {
      await rm(target, options)
      if (boundary === 'cleanup-backup' && target.endsWith('.backup')) crash()
      if (boundary === 'cleanup-marker' && target.endsWith('staged.complete')) crash()
      if (boundary === 'cleanup-journal' && target.endsWith('transaction.json')) crash()
      if (boundary === 'cleanup-lock' && target.endsWith('.publish.lock')) crash()
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

function runPublisher(input: { output: string; round: string; force: boolean; boundary?: string }) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childPublisher], {
      env: {
        ...process.env,
        FILES_MODULE_URL: filesModuleUrl,
        OUTPUT_DIR: input.output,
        ROUND: input.round,
        FORCE: input.force ? '1' : '0',
        FAIL_BOUNDARY: input.boundary ?? '',
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('atomic directory publication recovery', () => {
  it.each([
    ['rename-journal', 'old'],
    ['rename-existing', 'new-rename-existing'],
    ['rename-staging', 'new-rename-staging'],
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
})
