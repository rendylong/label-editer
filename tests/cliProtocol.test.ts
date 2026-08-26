import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error CLI is directly executable ESM.
import { runCli } from '../scripts/label-cli.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { createOperations } from '../scripts/lib/operations.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { publishAtomically } from '../scripts/lib/files.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { qcAreaToken } from '../scripts/lib/qc-output.mjs'
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

function projectV3(): Record<string, any> {
  return {
    version: 3,
    modelFileName: 'bottle.glb',
    areas: [{
      id: 'a1', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', side: 'front',
      remap: {
        mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
        planarBox: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
      range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
      canvas: { width: 2048, height: 1024, aspect: 2 },
      paper: { enabled: false, color: '#ffffff', opacity: 0 },
      layers: [{
        id: 'l1', kind: 'text', text: 'Label', fontFamily: 'system-sans', fontSize: 64,
        fontWeight: 400, letterSpacing: 0, lineHeight: 1.2, color: '#000000', align: 'center',
        italic: false, x: 512, y: 256, rotation: 0, opacity: 1, visible: true, locked: false,
        zIndex: 0, craft: [],
      }],
      globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
    }],
  }
}

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_SHA256 = createHash('sha256').update(PNG_BYTES).digest('hex')

const QC_MODEL_VIEW_IDS = [
  'model-front', 'model-back', 'model-left', 'model-right',
  'model-front-right', 'model-back-left',
] as const

function qcView(id: string, areaId?: string, channel: 'color' | 'metalness' | 'roughness' | 'bump' = 'color') {
  return {
    id,
    target: areaId ? { kind: 'area', areaId } : { kind: 'model' },
    framing: areaId ? 'fit-area' : 'fit-model',
    pose: areaId
      ? { kind: channel === 'color' && id.endsWith('-craft') ? 'area-craft' : 'area-face' }
      : { kind: 'direction', direction: [0, 0, 1] },
    channel,
    width: 1440,
    height: 1440,
    ...(areaId ? { areaId } : {}),
    reason: channel === 'color' ? 'QC evidence' : `Area ${channel} craft channel`,
  }
}

type QcCustomFixtureView = {
  id: string
  direction: [number, number, number]
  target: string
  framing: 'fit-model' | 'fit-area'
  channel: 'color' | 'metalness' | 'roughness' | 'bump'
}

function qcCustomView(view: QcCustomFixtureView) {
  const areaId = view.framing === 'fit-area' ? view.target : undefined
  return {
    id: view.id,
    target: areaId ? { kind: 'area' as const, areaId } : { kind: 'model' as const },
    framing: view.framing,
    pose: { kind: 'direction' as const, direction: view.direction },
    channel: view.channel,
    width: 1440,
    height: 1440,
    ...(areaId ? { areaId } : {}),
    reason: 'Custom QC view',
  }
}

function qcDescriptor(view: ReturnType<typeof qcView>) {
  return {
    id: `qc-${view.id}`,
    fileName: `${view.id}.png`,
    mimeType: 'image/png',
    byteLength: PNG_BYTES.byteLength,
    sha256: PNG_SHA256,
    width: view.width,
    height: view.height,
    ...(view.areaId ? { areaId: view.areaId } : {}),
    channel: view.channel,
  }
}

function qcRuntime(options: {
  captureError?: boolean
  publishToDisk?: boolean
  storedArtifactSet?: 'exact' | 'missing' | 'extra'
  browserErrors?: string[]
  areaIds?: string[]
  includeSide?: boolean
  requiredChannelsByArea?: Record<string, Array<'metalness' | 'roughness' | 'bump'>>
  areaTokensByArea?: Record<string, string>
  customViews?: QcCustomFixtureView[]
} = {}) {
  const areaIds = options.areaIds ?? ['front', 'back']
  const requiredChannelsByArea = options.requiredChannelsByArea
    ?? Object.fromEntries(areaIds.map((areaId) => [areaId, areaId === 'front' ? ['metalness', 'roughness'] : []]))
  const views = [
    ...QC_MODEL_VIEW_IDS.map((id) => qcView(id)),
    ...areaIds.flatMap((areaId) => [
      qcView(`area-${options.areaTokensByArea?.[areaId] ?? qcAreaToken(areaId)}-face`, areaId),
      qcView(`area-${options.areaTokensByArea?.[areaId] ?? qcAreaToken(areaId)}-craft`, areaId),
      ...(requiredChannelsByArea[areaId] ?? []).map((channel) => qcView(`area-${options.areaTokensByArea?.[areaId] ?? qcAreaToken(areaId)}-${channel}`, areaId, channel)),
    ]),
    ...(options.customViews ?? []).map(qcCustomView),
  ]
  const descriptors = views.map(qcDescriptor)
  const bridgeCalls: Array<{ method: string, input: unknown }> = []
  const publications: Array<{ sessionId: string, outputDir: string, artifacts: any[], force: boolean }> = []
  let sessionCount = 0
  const runtime = {
    allowedRoots: [] as string[],
    async createSession({ glbPath }: { glbPath: string }) {
      sessionCount += 1
      return { id: 'qc-session', modelName: path.basename(glbPath), inputUrl: 'http://127.0.0.1/model.glb' }
    },
    async callBridge(_session: unknown, method: string, input: unknown) {
      bridgeCalls.push({ method, input })
      if (method === 'loadModel') {
        return {
          ok: true,
          data: {
            name: 'model.glb', fingerprint: `sha256:${'b'.repeat(64)}`,
            dimensions: { width: 1, height: 2, depth: 1 },
            meshes: [{ meshIndex: 7, stableSelector: 'mesh:7/node:1', nodeName: 'Bottle' }],
            warnings: [],
          },
          warnings: [],
        }
      }
      if (method === 'applySpec' || method === 'applyProject') return { ok: true, data: { areaIds }, warnings: [] }
      if (method === 'waitForReady') return { ok: true, data: { ready: true }, warnings: [] }
      if (method === 'renderQcEvidence') {
        if (options.captureError) {
          return { ok: false, error: { code: 'REBUILD_FAILED', message: 'QC capture failed' }, warnings: [] }
        }
        return {
          ok: true,
          data: {
            preset: 'qc-standard',
            views: views.map((view, index) => ({
              artifact: descriptors[index],
              view,
              camera: {
                position: [0, 0, 3], direction: [0, 0, -1], target: [0, 0, 0],
                up: [0, 1, 0], fov: 45,
              },
            })),
            areas: areaIds.map((areaId) => ({
              areaId, meshIndex: 7, nodeName: 'Bottle',
              ...(options.includeSide === false ? {} : { side: areaId === 'back' ? 'back' : 'front' }),
              surfaceMode: 'overlay', requiredChannels: requiredChannelsByArea[areaId] ?? [],
              viewIds: views.filter((view) => view.areaId === areaId).map((view) => view.id),
            })),
            validation: { ready: true, issues: [] },
          },
          warnings: [],
        }
      }
      throw new Error(`Unexpected bridge method: ${method}`)
    },
    browserErrors: () => options.browserErrors ?? [],
    getArtifacts: () => {
      const artifacts = descriptors.map((descriptor) => ({ ...descriptor, bytes: PNG_BYTES }))
      if (options.storedArtifactSet === 'missing') artifacts.pop()
      if (options.storedArtifactSet === 'extra') artifacts.push({
        ...artifacts[0], id: 'qc-unexpected', fileName: 'unexpected.png',
      })
      return artifacts
    },
    async publishArtifacts(sessionId: string, outputDir: string, artifacts: any[], force: boolean) {
      publications.push({ sessionId, outputDir, artifacts, force })
      if (options.publishToDisk) await publishAtomically(outputDir, artifacts, { force, sessionId })
      return outputDir
    },
    addAsset: () => { throw new Error('The QC fixture has no local assets') },
  }
  return { runtime, bridgeCalls, publications, get sessionCount() { return sessionCount } }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('label-cli protocol', () => {
  it('routes qc dimensions, preset, camera config, force, and output', async () => {
    const calls: unknown[] = []
    const code = await runCli([
      'qc', 'spec.json', '--glb', 'model.glb', '--output', 'qc-dir',
      '--preset', 'qc-standard', '--camera-config', 'cameras.json',
      '--width', '1600', '--height', '1200', '--force', '--json',
    ], {
      operations: {
        qc: async (input: unknown) => {
          calls.push(input)
          return { ok: true, operation: 'render_label_qc', data: {}, warnings: [] }
        },
      },
      stdout: () => undefined,
      stderr: () => undefined,
    })

    expect(code).toBe(0)
    expect(calls).toEqual([{
      inputPath: 'spec.json', glbPath: 'model.glb', outputDir: 'qc-dir',
      preset: 'qc-standard', cameraConfigPath: 'cameras.json',
      width: 1600, height: 1200, force: true,
    }])
  })

  it('writes exactly one QC success envelope to stdout', async () => {
    const stdout: string[] = []
    const code = await runCli([
      'qc', 'spec.json', '--glb', 'model.glb', '--output', 'qc-dir', '--json',
    ], {
      operations: {
        qc: async () => ({ ok: true, operation: 'render_label_qc', data: { preset: 'qc-standard' }, warnings: [] }),
      },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ ok: true, operation: 'render_label_qc' })
  })

  it('runs QC in one browser session and publishes only the exact evidence set plus its manifest once', async () => {
    const directory = await temporaryDirectory()
    const spec = await fixture()
    const inputPath = path.join(directory, 'spec.json')
    const glbPath = path.join(directory, 'model.glb')
    const cameraConfigPath = path.join(directory, 'cameras.json')
    const outputDir = path.join(directory, 'qc-output')
    const customViews = [{
      id: 'pump-top', direction: [0.4, 1, 0.4], target: 'model',
      framing: 'fit-model', channel: 'color',
    }]
    await writeFile(inputPath, JSON.stringify(spec))
    await writeFile(glbPath, 'glb')
    await writeFile(cameraConfigPath, JSON.stringify({ version: 1, views: customViews }))
    await mkdir(outputDir)
    await writeFile(path.join(outputDir, 'old-evidence.txt'), 'stale')
    const harness = qcRuntime({ publishToDisk: true })
    harness.runtime.allowedRoots = [directory]
    const resolvedOutputDir = path.join(await realpath(directory), 'qc-output')

    const result = await createOperations(harness.runtime).qc({
      inputPath, glbPath, outputDir, cameraConfigPath, force: true,
    })

    expect(result.ok).toBe(true)
    expect(harness.sessionCount).toBe(1)
    expect(harness.bridgeCalls.map((call) => call.method)).toEqual([
      'loadModel', 'applySpec', 'waitForReady', 'renderQcEvidence',
    ])
    expect(harness.bridgeCalls.at(-1)?.input).toEqual({
      preset: 'qc-standard', width: 1440, height: 1440, customViews,
    })
    expect(harness.publications).toHaveLength(1)
    expect(harness.publications[0]).toMatchObject({
      sessionId: 'qc-session', outputDir: resolvedOutputDir, force: true,
    })
    expect(harness.publications[0].artifacts.map((artifact) => artifact.id)).toEqual([
      ...QC_MODEL_VIEW_IDS.map((id) => `qc-${id}`),
      'qc-area-front-face', 'qc-area-front-craft', 'qc-area-front-metalness', 'qc-area-front-roughness',
      'qc-area-back-face', 'qc-area-back-craft', 'qc-manifest',
    ])
    expect(harness.publications[0].artifacts.map((artifact) => artifact.relativePath)).toEqual([
      ...QC_MODEL_VIEW_IDS.map((id) => `model/${id}.png`),
      'areas/front/area-front-face.png', 'areas/front/area-front-craft.png',
      'areas/front/area-front-metalness.png', 'areas/front/area-front-roughness.png',
      'areas/back/area-back-face.png', 'areas/back/area-back-craft.png', 'qc-manifest.json',
    ])
    expect(harness.publications[0].artifacts.some((artifact) => [
      'labeled-glb', 'project', 'normalized-spec', 'print-manifest', 'preview-3d',
    ].includes(artifact.id))).toBe(false)
    await expect(readFile(path.join(outputDir, 'old-evidence.txt'))).rejects.toThrow()
    expect(await readFile(path.join(outputDir, 'qc-manifest.json'), 'utf8')).toContain(`"revision": "${revisionOf(spec)}"`)
    const qcManifest = JSON.parse(await readFile(path.join(outputDir, 'qc-manifest.json'), 'utf8'))
    expect(qcManifest.areas.find((area: { id: string }) => area.id === 'front')).toMatchObject({
      requiredChannels: ['metalness', 'roughness'],
    })
    expect(qcManifest.artifacts.filter((artifact: { channel: string }) => artifact.channel !== 'color')).toEqual([
      expect.objectContaining({ viewId: 'area-front-metalness', reason: 'Area metalness craft channel', view: expect.objectContaining({ kind: 'area-face' }) }),
      expect.objectContaining({ viewId: 'area-front-roughness', reason: 'Area roughness craft channel', view: expect.objectContaining({ kind: 'area-face' }) }),
    ])
    expect((await readdir(directory)).some((name) => name.startsWith('.qc-output.'))).toBe(false)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.data).toMatchObject({
      outputDir: resolvedOutputDir,
      manifestPath: path.join(resolvedOutputDir, 'qc-manifest.json'),
      revision: revisionOf(spec),
      modelFingerprint: `sha256:${'b'.repeat(64)}`,
      preset: 'qc-standard',
      validation: { ready: true, issues: [] },
    })
  })

  it('rejects an existing QC output before creating a browser session', async () => {
    const directory = await temporaryDirectory()
    const inputPath = path.join(directory, 'spec.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(await fixture()))
    await writeFile(glbPath, 'glb')
    await mkdir(outputDir)
    const harness = qcRuntime()
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir })

    expect(result).toMatchObject({ ok: false, operation: 'render_label_qc', error: { code: 'OUTPUT_CONFLICT' } })
    expect(harness.sessionCount).toBe(0)
    expect(harness.publications).toEqual([])
  })

  it('maps malformed camera JSON to INVALID_USAGE before creating a browser session', async () => {
    const directory = await temporaryDirectory()
    const inputPath = path.join(directory, 'spec.json')
    const cameraConfigPath = path.join(directory, 'cameras.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(await fixture()))
    await writeFile(cameraConfigPath, '{')
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime()
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir, cameraConfigPath })

    expect(result).toMatchObject({ ok: false, operation: 'render_label_qc', error: { code: 'INVALID_USAGE' } })
    expect(harness.sessionCount).toBe(0)
    expect(harness.publications).toEqual([])
  })

  it.each([
    ['zero direction', [{ id: 'zero', direction: [0, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['duplicate ids', [
      { id: 'same', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' },
      { id: 'same', direction: [0, 1, 0], target: 'model', framing: 'fit-model', channel: 'color' },
    ]],
    ['missing area', [{ id: 'missing', direction: [1, 0, 0], target: 'absent', framing: 'fit-area', channel: 'color' }]],
    ['extra up', [{ id: 'up', direction: [1, 0, 0], up: [0, 1, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
  ])('maps well-formed but invalid camera JSON to INVALID_USAGE before a browser session: %s', async (_label, views) => {
    const directory = await temporaryDirectory()
    const inputPath = path.join(directory, 'spec.json')
    const cameraConfigPath = path.join(directory, 'cameras.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(await fixture()))
    await writeFile(cameraConfigPath, JSON.stringify({ version: 1, views }))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime()
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir, cameraConfigPath })

    expect(result).toMatchObject({ ok: false, operation: 'render_label_qc', error: { code: 'INVALID_USAGE' } })
    expect(harness.sessionCount).toBe(0)
    expect(harness.publications).toEqual([])
    expect(await readdir(directory)).toEqual(['cameras.json', 'model.glb', 'spec.json'])
  })

  it('routes a Label Project v3 through applyProject and binds its exact revision', async () => {
    const directory = await temporaryDirectory()
    const project = projectV3()
    const inputPath = path.join(directory, 'project.lbl.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(project))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime({ areaIds: ['a1'] })
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir })

    expect(result.ok).toBe(true)
    expect(harness.bridgeCalls.map((call) => call.method)).toEqual([
      'loadModel', 'applyProject', 'waitForReady', 'renderQcEvidence',
    ])
    expect(harness.bridgeCalls[1].input).toEqual({ project })
    expect(harness.publications).toHaveLength(1)
    const manifestArtifact = harness.publications[0].artifacts.at(-1)
    const manifest = JSON.parse(Buffer.from(manifestArtifact.bytes).toString('utf8'))
    expect(manifest.input).toMatchObject({ kind: 'label-project-v3', revision: revisionOf(project) })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.data.revision).toBe(revisionOf(project))
  })

  it.each(['label-spec-v2', 'label-project-v3'] as const)('runs QC for a side-less %s document', async (kind) => {
    const directory = await temporaryDirectory()
    const input = kind === 'label-spec-v2' ? await fixture() : projectV3()
    for (const area of input.areas) delete area.side
    const areaIds = input.areas.map((area: { id: string }) => area.id)
    const inputPath = path.join(directory, kind === 'label-spec-v2' ? 'spec.json' : 'project.lbl.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(input))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime({ areaIds, includeSide: false })
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir })

    expect(result.ok).toBe(true)
    expect(harness.publications).toHaveLength(1)
    const manifestArtifact = harness.publications[0].artifacts.at(-1)
    const manifest = JSON.parse(Buffer.from(manifestArtifact.bytes).toString('utf8'))
    expect(manifest.input.kind).toBe(kind)
    expect(manifest.areas.every((area: { side?: string }) => !Object.hasOwn(area, 'side'))).toBe(true)
  })

  it('runs QC with long and Unicode area ids and an opaque custom-camera target', async () => {
    const directory = await temporaryDirectory()
    const input = JSON.parse(await readFile(path.resolve(import.meta.dirname, 'fixtures/specs/qc-opaque-area-ids-v2.json'), 'utf8'))
    const areaIds = input.areas.map((area: { id: string }) => area.id)
    const target = areaIds[1]
    const customViews = [{
      id: 'unicode-detail', direction: [0, 0, 1], target,
      framing: 'fit-area', channel: 'color',
    }]
    const inputPath = path.join(directory, 'opaque-spec.json')
    const cameraConfigPath = path.join(directory, 'cameras.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(input))
    await writeFile(cameraConfigPath, JSON.stringify({ version: 1, views: customViews }))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime({ areaIds, includeSide: false, requiredChannelsByArea: {} })
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir, cameraConfigPath })

    expect(result.ok).toBe(true)
    expect(harness.bridgeCalls.at(-1)?.input).toMatchObject({ customViews })
    const manifest = JSON.parse(Buffer.from(harness.publications[0].artifacts.at(-1).bytes).toString('utf8'))
    expect(manifest.areas.map((area: { id: string }) => area.id)).toEqual(areaIds)
    expect(manifest.artifacts.filter((artifact: { areaId?: string }) => artifact.areaId !== undefined)
      .every((artifact: { path: string }) => /^areas\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.png$/.test(artifact.path))).toBe(true)
  })

  it.each(['label-spec-v2', 'label-project-v3'] as const)('publishes distinct case-fold-safe tokens for a %s document', async (kind) => {
    const directory = await temporaryDirectory()
    const input = kind === 'label-spec-v2' ? await fixture() : projectV3()
    const sourceAreas = input.areas
    input.areas = [
      { ...sourceAreas[0], id: 'Front', name: 'Uppercase area' },
      { ...(sourceAreas[1] ?? sourceAreas[0]), id: 'front', name: 'Lowercase area' },
    ]
    const areaIds = ['Front', 'front']
    const inputPath = path.join(directory, kind === 'label-spec-v2' ? 'spec.json' : 'project.lbl.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(input))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime({
      areaIds,
      requiredChannelsByArea: {},
      areaTokensByArea: {
        Front: 'Front-6de898785ca4f504',
        front: 'front-e179dbd83ca4c2a4',
      },
    })
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir })

    expect(result.ok).toBe(true)
    const manifest = JSON.parse(Buffer.from(harness.publications[0].artifacts.at(-1).bytes).toString('utf8'))
    expect(manifest.areas.map((area: { id: string }) => area.id)).toEqual(areaIds)
    expect(manifest.artifacts.filter((artifact: { areaId?: string }) => artifact.areaId === 'Front').map((artifact: { path: string }) => artifact.path)).toEqual([
      'areas/Front-6de898785ca4f504/area-Front-6de898785ca4f504-face.png',
      'areas/Front-6de898785ca4f504/area-Front-6de898785ca4f504-craft.png',
    ])
    expect(manifest.artifacts.filter((artifact: { areaId?: string }) => artifact.areaId === 'front').map((artifact: { path: string }) => artifact.path)).toEqual([
      'areas/front-e179dbd83ca4c2a4/area-front-e179dbd83ca4c2a4-face.png',
      'areas/front-e179dbd83ca4c2a4/area-front-e179dbd83ca4c2a4-craft.png',
    ])
  })

  it.each(['label-spec-v2', 'label-project-v3'] as const)('targets an opaque area named model from %s camera config by fit-area framing', async (kind) => {
    const directory = await temporaryDirectory()
    const input = kind === 'label-spec-v2' ? await fixture() : projectV3()
    input.areas = [{ ...input.areas[0], id: 'model', name: 'Opaque model area' }]
    const customViews: QcCustomFixtureView[] = [
      { id: 'whole-model', direction: [0, 0, 1], target: 'model', framing: 'fit-model', channel: 'color' },
      { id: 'model-area', direction: [0, 0, 1], target: 'model', framing: 'fit-area', channel: 'color' },
    ]
    const inputPath = path.join(directory, kind === 'label-spec-v2' ? 'spec.json' : 'project.lbl.json')
    const cameraConfigPath = path.join(directory, 'cameras.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(input))
    await writeFile(cameraConfigPath, JSON.stringify({ version: 1, views: customViews }))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime({ areaIds: ['model'], requiredChannelsByArea: {}, customViews })
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir, cameraConfigPath })

    expect(result.ok).toBe(true)
    expect(harness.bridgeCalls.at(-1)?.input).toMatchObject({ customViews })
    const manifest = JSON.parse(Buffer.from(harness.publications[0].artifacts.at(-1).bytes).toString('utf8'))
    expect(manifest.artifacts.find((artifact: { viewId: string }) => artifact.viewId === 'whole-model')).toMatchObject({
      view: { target: 'model', framing: 'fit-model' },
    })
    expect(manifest.artifacts.find((artifact: { viewId: string }) => artifact.viewId === 'model-area')).toMatchObject({
      areaId: 'model', view: { target: 'model', framing: 'fit-area' },
    })
  })

  it('leaves no output or staging directory when the browser QC batch fails', async () => {
    const directory = await temporaryDirectory()
    const inputPath = path.join(directory, 'spec.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(await fixture()))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime({ captureError: true })
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir })

    expect(result).toMatchObject({ ok: false, operation: 'render_label_qc', error: { code: 'REBUILD_FAILED' } })
    expect(harness.publications).toEqual([])
    expect(await readdir(directory)).toEqual(['model.glb', 'spec.json'])
  })

  it.each([
    ['a missing artifact', 'missing'],
    ['an unexpected artifact', 'extra'],
  ] as const)('rejects %s instead of publishing a partial or expanded QC set', async (_label, storedArtifactSet) => {
    const directory = await temporaryDirectory()
    const inputPath = path.join(directory, 'spec.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(await fixture()))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime({ storedArtifactSet })
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir })

    expect(result).toMatchObject({ ok: false, operation: 'render_label_qc', error: { code: 'INVALID_USAGE' } })
    expect(harness.publications).toEqual([])
    expect(await readdir(directory)).toEqual(['model.glb', 'spec.json'])
  })

  it('rejects browser console or page errors before publication', async () => {
    const directory = await temporaryDirectory()
    const inputPath = path.join(directory, 'spec.json')
    const glbPath = path.join(directory, 'model.glb')
    const outputDir = path.join(directory, 'qc-output')
    await writeFile(inputPath, JSON.stringify(await fixture()))
    await writeFile(glbPath, 'glb')
    const harness = qcRuntime({ browserErrors: ['pageerror: renderer lost'] })
    harness.runtime.allowedRoots = [directory]

    const result = await createOperations(harness.runtime).qc({ inputPath, glbPath, outputDir })

    expect(result).toMatchObject({ ok: false, operation: 'render_label_qc', error: { code: 'BROWSER_NOT_READY' } })
    expect(harness.publications).toEqual([])
  })

  it.each([
    ['missing GLB', ['qc', 'spec.json', '--output', 'qc-dir', '--json']],
    ['missing output', ['qc', 'spec.json', '--glb', 'model.glb', '--json']],
    ['unsupported preset', ['qc', 'spec.json', '--glb', 'model.glb', '--output', 'qc-dir', '--preset', 'custom', '--json']],
    ['fractional width', ['qc', 'spec.json', '--glb', 'model.glb', '--output', 'qc-dir', '--width', '1.5', '--json']],
    ['zero height', ['qc', 'spec.json', '--glb', 'model.glb', '--output', 'qc-dir', '--height', '0', '--json']],
    ['oversized width', ['qc', 'spec.json', '--glb', 'model.glb', '--output', 'qc-dir', '--width', '4097', '--json']],
    ['camera config on preview', ['preview', 'spec.json', '--glb', 'model.glb', '--output', 'preview.png', '--camera-config', 'cameras.json', '--json']],
  ])('rejects invalid QC usage: %s', async (_label, argv) => {
    let invoked = false
    const stdout: string[] = []
    const code = await runCli(argv, {
      operations: {
        qc: async () => { invoked = true },
        preview: async () => { invoked = true },
      },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(2)
    expect(invoked).toBe(false)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0]).error.code).toBe('INVALID_USAGE')
  })

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

  it.each([
    ['INVALID_USAGE', 2],
    ['MODEL_TARGET_NOT_FOUND', 5],
    ['BROWSER_NOT_READY', 6],
    ['REBUILD_FAILED', 7],
  ] as const)('preserves QC %s envelopes as exit code %s', async (errorCode, expectedExitCode) => {
    const stdout: string[] = []
    const code = await runCli([
      'qc', 'spec.json', '--glb', 'model.glb', '--output', 'qc-output', '--json',
    ], {
      operations: {
        qc: async () => ({
          ok: false, operation: 'render_label_qc',
          error: { code: errorCode, message: 'classified failure' }, warnings: [],
        }),
      },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    })

    expect(code).toBe(expectedExitCode)
    expect(JSON.parse(stdout[0])).toMatchObject({ error: { code: errorCode } })
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
