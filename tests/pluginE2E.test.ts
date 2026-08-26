import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error CLI is directly executable ESM.
import { runCli } from '../scripts/label-cli.mjs'
// @ts-expect-error Plugin runtime is directly executable ESM.
import { createPluginRuntime } from '../scripts/plugin-runtime.mjs'
// @ts-expect-error Operations are directly executable ESM.
import { createOperations } from '../scripts/lib/operations.mjs'
// @ts-expect-error Project control is directly executable ESM.
import { revisionOf } from '../scripts/lib/project-control.mjs'

const defaultModel = '/Users/apple/realibox/cosmetic-bottles-glb/02_perfume_glass_with_cap.glb'
const modelPath = process.env.GLB_LABEL_E2E_MODEL ?? defaultModel
const runRealE2E = existsSync(modelPath)
const runLiveE2E = runRealE2E && process.env.GLB_LABEL_LIVE_E2E === '1'

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
    const workingSpec = path.join(root, 'working-spec.json')
    const patchDocument = path.join(root, 'copy-patch.json')
    const stdout: string[] = []
    const inputHash = hash(await readFile(modelPath))
    const originalSpec = JSON.parse(await readFile('tests/fixtures/specs/perfume-front-back-v2.json', 'utf8'))
    await writeFile(workingSpec, JSON.stringify(originalSpec, null, 2))
    const projectStdout: string[] = []
    expect(await runCli(['project', workingSpec, '--json'], {
      runtimeOptions: { allowedRoots: [root] },
      stdout: (value: string) => projectStdout.push(value),
      stderr: () => undefined,
    })).toBe(0)
    const inspected = JSON.parse(projectStdout[0])
    expect(inspected.data.revision).toBe(revisionOf(originalSpec))
    await writeFile(patchDocument, JSON.stringify({
      version: 1,
      baseRevision: inspected.data.revision,
      operations: [{ op: 'update-layer', areaId: 'front', layerId: 'brand', changes: { text: 'LOCAL AGENT API' } }],
    }))
    const patchStdout: string[] = []
    expect(await runCli([
      'patch', workingSpec, '--operations', patchDocument, '--output', workingSpec, '--force', '--json',
    ], {
      runtimeOptions: { allowedRoots: [root] },
      stdout: (value: string) => patchStdout.push(value),
      stderr: () => undefined,
    })).toBe(0)
    expect(JSON.parse(patchStdout[0])).toMatchObject({
      ok: true,
      operation: 'patch_label_spec',
      data: { appliedOperationCount: 1 },
    })
    expect(JSON.parse(await readFile(workingSpec, 'utf8')).areas[0].layers[0].text).toBe('LOCAL AGENT API')
    const argv = [
      'apply', workingSpec,
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
    const normalized = JSON.parse(await readFile(path.join(output, 'label-spec.normalized.json'), 'utf8'))
    expect(normalized.areas[0].layers[0].text).toBe('LOCAL AGENT API')

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
    const exportStdout: string[] = []
    const projectCode = await runCli([
      'export', path.join(output, 'project.lbl.json'), '--glb', modelPath,
      '--output', projectOutput, '--json',
    ], { ...dependencies, stdout: (value: string) => exportStdout.push(value) })
    expect(projectCode, exportStdout[0]).toBe(0)
    expect((await stat(path.join(projectOutput, 'labeled.glb'))).size).toBeGreaterThan(0)

    const previewOutput = path.join(root, 'agent-preview.png')
    const previewStdout: string[] = []
    const previewCode = await runCli([
      'preview', workingSpec, '--glb', modelPath,
      '--output', previewOutput, '--view', '3d', '--json',
    ], { ...dependencies, stdout: (value: string) => previewStdout.push(value) })
    expect(previewCode, previewStdout[0]).toBe(0)
    expect((await readFile(previewOutput)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect((await readdir(root)).some((name) => name.endsWith('.artifacts'))).toBe(false)

    const qcOutput = path.join(root, 'label-qc', 'round-0')
    await mkdir(path.dirname(qcOutput))
    const qcStdout: string[] = []
    const qcCode = await runCli([
      'qc', workingSpec, '--glb', modelPath,
      '--output', qcOutput, '--preset', 'qc-standard', '--json',
    ], { ...dependencies, stdout: (value: string) => qcStdout.push(value) })
    expect(qcCode, qcStdout[0]).toBe(0)
    expect(qcStdout).toHaveLength(1)
    const publishedQcOutput = path.join(await realpath(root), 'label-qc', 'round-0')
    expect(JSON.parse(qcStdout[0])).toMatchObject({
      ok: true,
      operation: 'render_label_qc',
      data: { outputDir: publishedQcOutput, manifestPath: path.join(publishedQcOutput, 'qc-manifest.json') },
    })
    const currentSpec = JSON.parse(await readFile(workingSpec, 'utf8'))
    const qcManifest = JSON.parse(await readFile(path.join(qcOutput, 'qc-manifest.json'), 'utf8'))
    expect(qcManifest.input.revision).toBe(revisionOf(currentSpec))
    expect(qcManifest.artifacts.filter((item: { channel: string }) => item.channel === 'color').length).toBeGreaterThanOrEqual(10)
    expect(qcManifest.artifacts.filter((item: { areaId?: string }) => item.areaId === undefined).map((item: { viewId: string }) => item.viewId)).toEqual([
      'model-front', 'model-back', 'model-left', 'model-right',
      'model-front-right', 'model-back-left',
    ])
    expect(qcManifest.artifacts.filter((item: { channel: string }) => item.channel !== 'color')
      .every((item: { view: { kind: string }; reason: string }) => item.view.kind === 'area-face' && item.reason.length > 0)).toBe(true)
    expect(qcManifest.artifacts.filter((item: { channel: string; view: { kind: string } }) => item.channel === 'color' && item.view.kind === 'area-craft')).toHaveLength(2)
    for (const area of qcManifest.areas) {
      expect(area.artifactIds).toEqual(qcManifest.artifacts
        .filter((artifact: { areaId?: string }) => artifact.areaId === area.id)
        .map((artifact: { id: string }) => artifact.id))
    }
    for (const artifact of qcManifest.artifacts) {
      const png = await readFile(path.join(qcOutput, artifact.path))
      expect(png.subarray(0, 8), artifact.path).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(hash(png), artifact.path).toBe(artifact.sha256)
    }
    expect((await readdir(path.dirname(qcOutput))).some((name) => name.startsWith('.round-0.'))).toBe(false)
    for (const forbidden of ['labeled.glb', 'project.lbl.json', 'label-spec.normalized.json', 'print-manifest.json', 'preview-3d.png', 'manifest.json']) {
      expect(existsSync(path.join(qcOutput, forbidden)), forbidden).toBe(false)
    }

    const runtime = await createPluginRuntime(dependencies.runtimeOptions)
    try {
      const opened = await createOperations(runtime).open({
        inputPath: workingSpec,
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
  }, 180_000)

  it.runIf(runLiveE2E)('automatically opens one headful read-only preview and applies an in-place patch revision', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-live-e2e-'))
    const workingSpec = path.join(root, 'working-spec.json')
    const operationsPath = path.join(root, 'operations.json')
    const spec = JSON.parse(await readFile('tests/fixtures/specs/perfume-front-back-v2.json', 'utf8'))
    await writeFile(workingSpec, JSON.stringify(spec, null, 2))
    const progress: string[] = []
    const runtime = await createPluginRuntime({
      allowedRoots: [process.cwd(), path.dirname(modelPath), root],
      headless: false,
      browserQuery: { 'agent-preview': '1' },
    })
    try {
      const operations = createOperations(runtime, { progress: (message: string) => progress.push(message) })
      const live = await operations.live({ specPath: workingSpec, glbPath: modelPath })
      expect(live.ok).toBe(true)
      if (!live.ok) throw new Error(live.error.message)
      const previewUrl = new URL(live.data.previewUrl)
      expect(previewUrl.searchParams.get('agent-preview')).toBe('1')
      expect(previewUrl.searchParams.get('token')).toBeTruthy()
      expect(live.data.keepAlive).toBe(true)

      await writeFile(operationsPath, JSON.stringify({
        version: 1,
        baseRevision: live.data.revision,
        operations: [{ op: 'update-layer', areaId: 'front', layerId: 'brand', changes: { text: 'LIVE LOCAL API' } }],
      }))
      const patched = await createOperations(undefined, { allowedRoots: [root] }).patch({
        inputPath: workingSpec,
        operationsPath,
        outputPath: workingSpec,
        force: true,
      })
      expect(patched.ok).toBe(true)
      if (!patched.ok) throw new Error(patched.error.message)

      const deadline = Date.now() + 20_000
      while (!progress.some((message) => message.includes(patched.data.revision)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(progress).toContain(`live revision ${patched.data.revision}`)
      expect(runtime.browserErrors(live.sessionId)).toEqual([])
    } finally {
      await runtime.close()
    }
  }, 60_000)
})
