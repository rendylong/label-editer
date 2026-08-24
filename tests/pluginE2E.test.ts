import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error CLI is directly executable ESM.
import { runCli } from '../scripts/label-cli.mjs'
// @ts-expect-error Plugin runtime is directly executable ESM.
import { createPluginRuntime } from '../scripts/plugin-runtime.mjs'
// @ts-expect-error Operations are directly executable ESM.
import { createOperations } from '../scripts/lib/operations.mjs'

const defaultModel = '/Users/apple/realibox/cosmetic-bottles-glb/02_perfume_glass_with_cap.glb'
const modelPath = process.env.GLB_LABEL_E2E_MODEL ?? defaultModel
const runRealE2E = existsSync(modelPath)

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function glbJson(bytes: Uint8Array): Record<string, any> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim())
}

describe('GLB label plugin E2E', () => {
  it.runIf(runRealE2E)('applies a front/back design and atomically publishes verified artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-e2e-'))
    const output = path.join(root, 'result')
    const stdout: string[] = []
    const inputHash = hash(await readFile(modelPath))
    const argv = [
      'apply', 'tests/fixtures/specs/perfume-front-back-v2.json',
      '--glb', modelPath, '--output', output, '--json',
    ]
    const dependencies = {
      runtimeOptions: { allowedRoots: [process.cwd(), path.dirname(modelPath), root] },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    }

    expect(existsSync(output)).toBe(false)
    const code = await runCli(argv, dependencies)
    expect(code, stdout[0]).toBe(0)
    expect(stdout).toHaveLength(1)
    for (const file of [
      'labeled.glb', 'project.lbl.json', 'label-spec.normalized.json',
      'print-manifest.json', 'preview-3d.png', 'manifest.json',
      'areas/front/color.png', 'areas/front/metalness.png', 'areas/front/roughness.png', 'areas/front/bump.png',
      'areas/back/color.png', 'areas/back/metalness.png', 'areas/back/roughness.png', 'areas/back/bump.png',
    ]) {
      expect((await stat(path.join(output, file))).size, file).toBeGreaterThan(0)
    }
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'))
    expect(manifest.glbCrossCheck).toMatchObject({ loaded: true, uvSampleOk: true })
    for (const artifact of manifest.artifacts) {
      expect(hash(await readFile(path.join(output, artifact.path))), artifact.path).toBe(artifact.sha256)
    }
    expect(hash(await readFile(modelPath))).toBe(inputHash)
    const embedded = glbJson(await readFile(path.join(output, 'labeled.glb')))
      .extras?.glbLabelEditorProject
    expect(embedded).toMatchObject({ version: 3, areas: [{ id: 'front' }, { id: 'back' }] })

    const conflictOutput: string[] = []
    const conflictCode = await runCli(argv, { ...dependencies, stdout: (value: string) => conflictOutput.push(value) })
    expect(conflictCode).toBe(9)
    expect(JSON.parse(conflictOutput[0]).error.code).toBe('OUTPUT_CONFLICT')

    const forcedOutput: string[] = []
    const forceCode = await runCli([...argv.slice(0, -1), '--force', '--json'], {
      ...dependencies,
      stdout: (value: string) => forcedOutput.push(value),
    })
    expect(forceCode, forcedOutput[0]).toBe(0)

    const invalidSpec = path.join(root, 'invalid.json')
    const invalidOutput = path.join(root, 'invalid-result')
    await writeFile(invalidSpec, JSON.stringify({ version: 2, areas: [] }))
    const invalidCode = await runCli([
      'apply', invalidSpec, '--glb', modelPath, '--output', invalidOutput, '--json',
    ], dependencies)
    expect(invalidCode).toBe(4)
    expect(existsSync(invalidOutput)).toBe(false)

    const projectOutput = path.join(root, 'project-export')
    const projectStdout: string[] = []
    const projectCode = await runCli([
      'export', path.join(output, 'project.lbl.json'), '--glb', modelPath,
      '--output', projectOutput, '--json',
    ], { ...dependencies, stdout: (value: string) => projectStdout.push(value) })
    expect(projectCode, projectStdout[0]).toBe(0)
    expect((await stat(path.join(projectOutput, 'labeled.glb'))).size).toBeGreaterThan(0)

    const previewOutput = path.join(root, 'agent-preview.png')
    const previewStdout: string[] = []
    const previewCode = await runCli([
      'preview', 'tests/fixtures/specs/perfume-front-back-v2.json', '--glb', modelPath,
      '--output', previewOutput, '--view', '3d', '--json',
    ], { ...dependencies, stdout: (value: string) => previewStdout.push(value) })
    expect(previewCode, previewStdout[0]).toBe(0)
    expect((await readFile(previewOutput)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect((await readdir(root)).some((name) => name.endsWith('.artifacts'))).toBe(false)

    const runtime = await createPluginRuntime(dependencies.runtimeOptions)
    try {
      const opened = await createOperations(runtime).open({
        inputPath: 'tests/fixtures/specs/perfume-front-back-v2.json',
        glbPath: modelPath,
      })
      expect(opened.ok).toBe(true)
      if (!opened.ok) throw new Error(opened.error.message)
      const editorUrl = new URL(opened.data.url)
      expect(editorUrl.hostname).toBe('127.0.0.1')
      expect(editorUrl.searchParams.get('session')).toBe(opened.sessionId)
      expect(runtime.browserErrors(opened.sessionId)).toEqual([])
      expect((await fetch(editorUrl)).status).toBe(200)
    } finally {
      await runtime.close()
    }
  }, 120_000)
})
