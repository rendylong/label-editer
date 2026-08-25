import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error CLI is directly executable ESM.
import { runCli } from '../scripts/label-cli.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { revisionOf } from '../scripts/lib/project-control.mjs'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glb-label-cli-'))
  temporaryDirectories.push(directory)
  return directory
}

async function fixture(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.resolve(import.meta.dirname, 'fixtures/specs/perfume-front-back-v2.json'), 'utf8'))
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('label-cli protocol', () => {
  it('writes exactly one machine-readable JSON result to stdout', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runCli(['inspect', 'model.glb', '--json'], {
      operations: {
        inspect: async () => ({ ok: true, operation: 'inspect_model', data: { meshes: [] }, warnings: [] }),
      },
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    })

    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toEqual({ ok: true, operation: 'inspect_model', data: { meshes: [] }, warnings: [] })
    expect(stderr).toEqual([])
  })

  it('maps a validation failure to exit code 4', async () => {
    const output: string[] = []
    const code = await runCli(['validate', 'bad.json', '--json'], {
      operations: {
        validate: async () => ({
          ok: false,
          operation: 'validate_label_spec',
          error: { code: 'INVALID_LABEL_SPEC', message: 'bad schema' },
          warnings: [],
        }),
      },
      stdout: (value: string) => output.push(value),
      stderr: () => undefined,
    })
    expect(code).toBe(4)
    expect(output).toHaveLength(1)
  })

  it('rejects missing apply options before invoking an operation', async () => {
    let invoked = false
    const output: string[] = []
    const code = await runCli(['apply', 'spec.json', '--json'], {
      operations: { apply: async () => { invoked = true } },
      stdout: (value: string) => output.push(value),
      stderr: () => undefined,
    })
    expect(code).toBe(2)
    expect(invoked).toBe(false)
    expect(JSON.parse(output[0]).error.code).toBe('INVALID_USAGE')
  })

  it('routes live as a foreground keep-alive operation without requiring an output path', async () => {
    const stdout: string[] = []
    const live = async (input: unknown) => ({
      ok: true,
      operation: 'live_preview',
      data: { ...(input as object), previewUrl: 'http://127.0.0.1/', revision: `sha256:${'a'.repeat(64)}`, keepAlive: true },
      warnings: [],
    })
    const code = await runCli(['live', 'working.json', '--glb', 'model.glb', '--json'], {
      operations: { live },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(0)
    expect(JSON.parse(stdout[0])).toMatchObject({
      ok: true,
      operation: 'live_preview',
      data: { specPath: 'working.json', glbPath: 'model.glb', keepAlive: true },
    })
  })

  it('inspects a local Label Spec without creating the browser runtime', async () => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const specPath = path.join(directory, 'working-spec.json')
    await writeFile(specPath, JSON.stringify(spec))
    const stdout: string[] = []

    const code = await runCli(['project', specPath, '--json'], {
      runtimeOptions: { allowedRoots: [directory] },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({
      ok: true,
      operation: 'inspect_label_project',
      data: { kind: 'label-spec-v2', revision: revisionOf(spec), areaCount: 2 },
    })
  })

  it('atomically patches to a new output and returns both revisions', async () => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const specPath = path.join(directory, 'working-spec.json')
    const operationsPath = path.join(directory, 'operations.json')
    const outputPath = path.join(directory, 'patched-spec.json')
    await writeFile(specPath, JSON.stringify(spec))
    await writeFile(operationsPath, JSON.stringify({
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [{ op: 'update-layer', areaId: 'front', layerId: 'brand', changes: { text: 'LOCAL API' } }],
    }))
    const stdout: string[] = []

    const code = await runCli([
      'patch', specPath, '--operations', operationsPath, '--output', outputPath, '--json',
    ], {
      runtimeOptions: { allowedRoots: [directory] },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    const envelope = JSON.parse(stdout[0])
    const written = JSON.parse(await readFile(outputPath, 'utf8'))
    expect(envelope).toMatchObject({
      ok: true,
      operation: 'patch_label_spec',
      data: { previousRevision: revisionOf(spec), appliedOperationCount: 1, value: written },
    })
    expect(envelope.data.revision).toBe(revisionOf(written))
    expect(written.areas[0].layers[0].text).toBe('LOCAL API')
  })

  it('requires --force for in-place patching and publishes in place when explicit', async () => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const specPath = path.join(directory, 'working-spec.json')
    const operationsPath = path.join(directory, 'operations.json')
    await writeFile(specPath, JSON.stringify(spec))
    await writeFile(operationsPath, JSON.stringify({
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [{ op: 'update-area', areaId: 'front', changes: { name: 'Updated' } }],
    }))

    const conflictOutput: string[] = []
    const conflictCode = await runCli([
      'patch', specPath, '--operations', operationsPath, '--output', specPath, '--json',
    ], {
      runtimeOptions: { allowedRoots: [directory] },
      stdout: (value: string) => conflictOutput.push(value),
      stderr: () => undefined,
    })
    expect(conflictCode).toBe(9)
    expect(JSON.parse(conflictOutput[0]).error.code).toBe('OUTPUT_CONFLICT')
    expect(JSON.parse(await readFile(specPath, 'utf8'))).toEqual(spec)

    const successOutput: string[] = []
    const successCode = await runCli([
      'patch', specPath, '--operations', operationsPath, '--output', specPath, '--force', '--json',
    ], {
      runtimeOptions: { allowedRoots: [directory] },
      stdout: (value: string) => successOutput.push(value),
      stderr: () => undefined,
    })
    expect(successCode).toBe(0)
    expect(JSON.parse(await readFile(specPath, 'utf8')).areas[0].name).toBe('Updated')
  })

  it.each([
    ['revision conflict', 10, 'REVISION_CONFLICT', { version: 1, baseRevision: `sha256:${'0'.repeat(64)}`, operations: [] }],
    ['invalid operation', 11, 'INVALID_PATCH_OPERATION', { version: 1, baseRevision: '', operations: [{ op: 'delete-everything' }] }],
  ])('leaves no output on %s', async (_label, expectedCode, expectedError, operations) => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const specPath = path.join(directory, 'working-spec.json')
    const operationsPath = path.join(directory, 'operations.json')
    const outputPath = path.join(directory, 'patched-spec.json')
    await writeFile(specPath, JSON.stringify(spec))
    const document = expectedError === 'INVALID_PATCH_OPERATION'
      ? operations
      : { ...operations, baseRevision: `sha256:${'0'.repeat(64)}` }
    await writeFile(operationsPath, JSON.stringify(document))
    const stdout: string[] = []

    const code = await runCli([
      'patch', specPath, '--operations', operationsPath, '--output', outputPath, '--json',
    ], {
      runtimeOptions: { allowedRoots: [directory] },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(expectedCode)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0]).error.code).toBe(expectedError)
    await expect(readFile(outputPath)).rejects.toThrow()
  })

  it.each([
    ['malformed spec', 'spec', 4, 'INVALID_LABEL_SPEC'],
    ['malformed operations', 'operations', 11, 'INVALID_PATCH_OPERATION'],
  ])('maps %s JSON to the domain exit code', async (_label, malformedTarget, expectedCode, expectedError) => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const specPath = path.join(directory, 'working-spec.json')
    const operationsPath = path.join(directory, 'operations.json')
    const outputPath = path.join(directory, 'patched-spec.json')
    await writeFile(specPath, malformedTarget === 'spec' ? '{' : JSON.stringify(spec))
    await writeFile(operationsPath, malformedTarget === 'operations' ? '{' : JSON.stringify({
      version: 1, baseRevision: revisionOf(spec), operations: [],
    }))
    const stdout: string[] = []

    const code = await runCli([
      'patch', specPath, '--operations', operationsPath, '--output', outputPath, '--json',
    ], {
      runtimeOptions: { allowedRoots: [directory] },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(expectedCode)
    expect(JSON.parse(stdout[0]).error.code).toBe(expectedError)
    await expect(readFile(outputPath)).rejects.toThrow()
  })

  it('rejects a concurrent patch lock without touching the source or another process lock', async () => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const specPath = path.join(directory, 'working-spec.json')
    const operationsPath = path.join(directory, 'operations.json')
    const outputPath = path.join(directory, 'patched-spec.json')
    const lockPath = path.join(directory, '.working-spec.json.patch.lock')
    await writeFile(specPath, JSON.stringify(spec))
    await writeFile(operationsPath, JSON.stringify({
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [{ op: 'update-area', areaId: 'front', changes: { name: 'Concurrent' } }],
    }))
    await writeFile(lockPath, 'other-process')
    const stdout: string[] = []

    const code = await runCli([
      'patch', specPath, '--operations', operationsPath, '--output', outputPath, '--json',
    ], {
      runtimeOptions: { allowedRoots: [directory] },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(10)
    expect(JSON.parse(stdout[0]).error.code).toBe('REVISION_CONFLICT')
    expect(JSON.parse(await readFile(specPath, 'utf8'))).toEqual(spec)
    expect(await readFile(lockPath, 'utf8')).toBe('other-process')
    await expect(readFile(outputPath)).rejects.toThrow()
  })

  it('allows only one of two concurrent in-place transactions based on the same revision', async () => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const specPath = path.join(directory, 'working-spec.json')
    const operationsPaths = [path.join(directory, 'first.json'), path.join(directory, 'second.json')]
    await writeFile(specPath, JSON.stringify(spec))
    await Promise.all(operationsPaths.map((operationsPath, index) => writeFile(operationsPath, JSON.stringify({
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [{ op: 'update-area', areaId: 'front', changes: { name: `Writer ${index + 1}` } }],
    }))))

    const results = await Promise.all(operationsPaths.map(async (operationsPath) => {
      const stdout: string[] = []
      const code = await runCli([
        'patch', specPath, '--operations', operationsPath, '--output', specPath, '--force', '--json',
      ], {
        runtimeOptions: { allowedRoots: [directory] },
        stdout: (value: string) => stdout.push(value),
        stderr: () => undefined,
      })
      return { code, envelope: JSON.parse(stdout[0]) }
    }))

    expect(results.map((result) => result.code).sort((a, b) => a - b)).toEqual([0, 10])
    expect(results.find((result) => result.code === 10)?.envelope.error.code).toBe('REVISION_CONFLICT')
    expect(['Writer 1', 'Writer 2']).toContain(JSON.parse(await readFile(specPath, 'utf8')).areas[0].name)
  })

  it('allows only one of two different inputs to publish a shared new destination', async () => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const inputPaths = [path.join(directory, 'input-a.json'), path.join(directory, 'input-b.json')]
    const operationsPaths = [path.join(directory, 'ops-a.json'), path.join(directory, 'ops-b.json')]
    const outputPath = path.join(directory, 'shared-output.json')
    await Promise.all(inputPaths.map((inputPath) => writeFile(inputPath, JSON.stringify(spec))))
    await Promise.all(operationsPaths.map((operationsPath, index) => writeFile(operationsPath, JSON.stringify({
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [{ op: 'update-area', areaId: 'front', changes: { name: `Shared writer ${index + 1}` } }],
    }))))

    const results = await Promise.all(inputPaths.map(async (inputPath, index) => {
      const stdout: string[] = []
      const code = await runCli([
        'patch', inputPath, '--operations', operationsPaths[index], '--output', outputPath, '--json',
      ], {
        runtimeOptions: { allowedRoots: [directory] },
        stdout: (value: string) => stdout.push(value),
        stderr: () => undefined,
      })
      return { code, envelope: JSON.parse(stdout[0]) }
    }))

    expect(results.filter((result) => result.code === 0)).toHaveLength(1)
    const rejected = results.find((result) => result.code !== 0)
    expect([5, 10]).toContain(rejected?.code)
    expect(['OUTPUT_CONFLICT', 'REVISION_CONFLICT']).toContain(rejected?.envelope.error.code)
    expect(['Shared writer 1', 'Shared writer 2']).toContain(JSON.parse(await readFile(outputPath, 'utf8')).areas[0].name)
  })
})
