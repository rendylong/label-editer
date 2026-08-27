import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
import type { ReviewEvidenceRequest } from '../src/agent/contracts'
import type { DesignReviewManifestV1, EditorHandoffV2, LayoutBlueprintV1 } from '../src/agent/designContracts'
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

function reviewEvidenceFixture(): { spec: Record<string, unknown>; request: ReviewEvidenceRequest } {
  const widthMm = 58.76605666054
  const heightMm = 30
  const blueprint: LayoutBlueprintV1 = {
    version: 1,
    revision: 'task9-browser-review-v1',
    carrierDefaults: { carrier: 'direct_surface_print' },
    assets: [],
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      artboard: { widthMm, heightMm, background: 'transparent' },
      placementIntent: 'Centered direct print on the front face.', placementPolicy: 'block',
      layers: [{
        id: 'browser-mark', kind: 'shape', boundsMm: { x: 16, y: 4, width: 26, height: 22 },
        anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 0,
        processes: [{ process: 'screen_print' }], shape: 'ellipse',
        fill: '#b88a44', stroke: '#3b2411', strokeWidthMm: 0.5, cornerRadiusMm: 0,
      }],
    }],
  }
  const blueprintJson = JSON.stringify(blueprint)
  const blueprintSha = hash(new TextEncoder().encode(blueprintJson))
  const manifest: DesignReviewManifestV1 = {
    version: 1, createdAt: '2026-08-27T10:00:00.000Z',
    blueprint: { revision: blueprint.revision, sha256: blueprintSha },
    html: { sha256: '1'.repeat(64) }, references: [],
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'mockup-front', path: 'mockup-front.png', sha256: '2'.repeat(64),
      mimeType: 'image/png', width: 1600, height: 1200, viewKind: 'mockup-front',
    }, {
      id: 'mockup-back', path: 'mockup-back.png', sha256: '3'.repeat(64),
      mimeType: 'image/png', width: 1600, height: 1200, viewKind: 'mockup-back',
    }, {
      id: 'mockup-area-front', path: 'areas/front.png', sha256: '4'.repeat(64),
      mimeType: 'image/png', width: 1200, height: 1200, viewKind: 'mockup-area',
      areaId: 'front', carrier: 'direct_surface_print',
    }],
  }
  const designReviewManifestJson = JSON.stringify(manifest)
  const manifestSha = hash(new TextEncoder().encode(designReviewManifestJson))
  const handoff: EditorHandoffV2 = {
    handoff_version: 2, status: 'approved',
    source: {
      design_spec: 'design.md', mockup_html: 'mockup.html', blueprint: 'layout-blueprint.json',
      design_review_manifest: 'design-review-manifest.json', blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha, review_manifest_sha256: manifestSha,
    },
    approval: {
      mode: 'explicit_approval', scope: 'current_task', blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha, review_manifest_sha256: manifestSha,
    },
    model: { package_type: 'bottle' },
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      placement: 'Centered direct print on the front face.',
      physical_size_mm: { width: widthMm, height: heightMm }, blueprint_area_id: 'front',
    }],
    assets: [], production_constraints: {}, assumptions: [], blockers: [],
  }
  const areas = compileBlueprintToSpecAreas(blueprint, [{
    blueprintAreaId: 'front', name: 'Front',
    target: { nodeName: 'Cube.001_Material.001_0' }, surfaceMode: 'overlay',
    range: { uStart: 0.35, uWidth: 0.3, vStart: 0.2, vHeight: 0.6 },
  }])
  areas[0].designBinding = {
    blueprintRevision: blueprint.revision,
    blueprintSha256: blueprintSha,
    reviewManifestSha256: manifestSha,
  }
  return {
    spec: { version: 2, areas },
    request: {
      width: 640, height: 640,
      designGate: { handoff, blueprintJson, designReviewManifestJson },
    },
  }
}

describe('GLB label plugin E2E', () => {
  it.runIf(runRealE2E)('captures a gate-bound clean review through the packaged browser bridge', async () => {
    const requestedEvidenceDir = process.env.GLB_LABEL_TASK9_EVIDENCE_DIR
    const evidenceDir = requestedEvidenceDir
      ? path.resolve(requestedEvidenceDir)
      : await mkdtemp(path.join(tmpdir(), 'glb-label-task9-review-'))
    await mkdir(evidenceDir, { recursive: true })
    let droppedSealResponse = false
    const runtime = await createPluginRuntime({
      allowedRoots: [process.cwd(), path.dirname(modelPath), evidenceDir],
      fetcher: async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(input, init)
        if (!droppedSealResponse && String(input).includes('/confirm?')) {
          droppedSealResponse = true
          await response.arrayBuffer()
          throw new Error('injected lost seal response')
        }
        return response
      },
    })
    try {
      const session = await runtime.createSession({ glbPath: modelPath })
      const loaded = await runtime.callBridge(session, 'loadModel', {
        name: session.modelName, url: session.inputUrl,
      })
      expect(loaded).toMatchObject({ ok: true, operation: 'load_model' })
      const fixture = reviewEvidenceFixture()
      const applied = await runtime.callBridge(session, 'applySpec', { spec: fixture.spec, assetUrls: {} })
      expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true, operation: 'apply_label_spec' })
      expect(await runtime.callBridge(session, 'waitForReady', { timeoutMs: 60_000 }))
        .toMatchObject({ ok: true, operation: 'wait_for_ready' })

      const rendered = await runtime.callBridge(session, 'renderReviewEvidence', fixture.request)
      expect(rendered, JSON.stringify(rendered)).toMatchObject({
        ok: true, operation: 'render_review_evidence',
        data: {
          inputKind: 'label-project-v3', blueprintRevision: 'task9-browser-review-v1',
          validation: { ready: true }, fidelity: { pass: true },
          views: [
            { id: 'label-front' }, { id: 'surface-front' },
            { id: 'model-front' }, { id: 'model-back' }, { id: 'review-sheet' },
          ],
        },
      })
      if (!rendered.ok) throw new Error(rendered.error.message)
      await expect(runtime.confirmReviewEvidence(session.id, rendered.data.confirmation)).resolves.toMatchObject({
        ok: true, sealed: true, resultIds: rendered.data.views.map((entry: { id: string }) => entry.id),
      })
      expect(droppedSealResponse).toBe(true)
      const stored = runtime.getArtifacts(session.id)
      expect(stored.map((artifact: { id: string }) => artifact.id)).toEqual(
        rendered.data.views.map((entry: { artifact: { id: string } }) => entry.artifact.id),
      )
      const receipts = new Map(rendered.data.confirmation.artifacts.map((artifact: { resultId: string }) => [artifact.resultId, artifact]))
      for (const view of rendered.data.views) {
        const artifact = await runtime.readReviewArtifact(session.id, view, receipts.get(view.id))
        const bytes = Buffer.from(artifact.bytes)
        expect(bytes.subarray(0, 8), artifact.id)
          .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        expect(hash(bytes), artifact.id).toBe(artifact.sha256)
        await writeFile(path.join(evidenceDir, `${artifact.id}.png`), bytes)
      }
      await writeFile(path.join(evidenceDir, 'review-evidence.json'), `${JSON.stringify({
        ...rendered.data,
        confirmation: { ...rendered.data.confirmation, leaseToken: '[redacted]' },
      }, null, 2)}\n`)
      expect(runtime.browserErrors(session.id)).toEqual([])
    } finally {
      await runtime.close()
    }
  }, 180_000)

  it.runIf(runRealE2E)('publishes a realistic 1600 square review through the additive CLI and returns conflict exit 9', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-task10-review-'))
    const fixture = reviewEvidenceFixture()
    const inputPath = path.join(root, 'working.json')
    const outputDir = path.join(root, 'review-rev-001')
    const resolvedOutputDir = path.join(await realpath(root), 'review-rev-001')
    const inputBytes = `${JSON.stringify(fixture.spec)}\n`
    await writeFile(inputPath, inputBytes)
    await writeFile(path.join(root, 'editor-handoff.json'), `${JSON.stringify(fixture.request.designGate.handoff)}\n`)
    await writeFile(path.join(root, 'layout-blueprint.json'), fixture.request.designGate.blueprintJson)
    await writeFile(path.join(root, 'design-review-manifest.json'), fixture.request.designGate.designReviewManifestJson)
    const runtimeOptions = { allowedRoots: [process.cwd(), path.dirname(modelPath), root] }
    const stdout: string[] = []
    const stderr: string[] = []

    const code = await runCli([
      'review', inputPath, '--glb', modelPath, '--output', outputDir,
      '--width', '1600', '--height', '1600', '--json',
    ], {
      runtimeOptions,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    })
    expect(code, [...stderr, ...stdout].join('\n')).toBe(0)
    expect(stdout).toHaveLength(1)
    const envelope = JSON.parse(stdout[0])
    expect(envelope).toMatchObject({
      ok: true, operation: 'render_label_review',
      data: { outputDir: resolvedOutputDir, manifestPath: path.join(resolvedOutputDir, 'review-manifest.json') },
    })
    expect(stdout[0]).not.toMatch(/leaseToken|token=/)

    const manifestBytes = await readFile(path.join(outputDir, 'review-manifest.json'))
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    expect(manifest).toMatchObject({
      version: 1,
      input: { kind: 'label-spec-v2', revision: revisionOf(fixture.spec), sha256: hash(new TextEncoder().encode(inputBytes)) },
      blueprint: { revision: 'task9-browser-review-v1' },
      artifacts: [
        { id: 'label-front', path: 'label-front.png', width: 1600, height: 1600 },
        { id: 'surface-front', path: 'surface-front.png', width: 1600, height: 1600 },
        { id: 'model-front', path: 'model-front.png', width: 1600, height: 1600 },
        { id: 'model-back', path: 'model-back.png', width: 1600, height: 1600 },
        { id: 'review-sheet', path: 'review-sheet.png', width: 1600, height: 1600 },
      ],
    })
    expect((await readdir(outputDir)).sort()).toEqual([
      'label-front.png', 'model-back.png', 'model-front.png', 'review-manifest.json',
      'review-sheet.png', 'surface-front.png',
    ])
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(path.join(outputDir, artifact.path))
      expect(bytes.subarray(0, 8), artifact.path).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(bytes.readUInt32BE(16), artifact.path).toBe(artifact.width)
      expect(bytes.readUInt32BE(20), artifact.path).toBe(artifact.height)
      expect(hash(bytes), artifact.path).toBe(artifact.sha256)
    }

    const conflictStdout: string[] = []
    const conflictCode = await runCli([
      'review', inputPath, '--glb', modelPath, '--output', outputDir, '--json',
    ], {
      runtimeOptions,
      stdout: (value: string) => conflictStdout.push(value),
      stderr: () => undefined,
    })
    expect(conflictCode).toBe(9)
    expect(JSON.parse(conflictStdout[0])).toMatchObject({ ok: false, error: { code: 'OUTPUT_CONFLICT' } })
  }, 180_000)

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
