import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { buildQcManifest, parseQcCameraConfig, qcArtifactRelativePath, validateQcManifest } from '../scripts/lib/qc-output.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { inspectProject, revisionOf } from '../scripts/lib/project-control.mjs'

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const DIGEST = (character: string) => `sha256:${character.repeat(64)}`
const fixturePath = path.resolve(import.meta.dirname, 'fixtures/specs/perfume-front-back-v2.json')

async function fixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'))
}

function camera() {
  return {
    position: [0, 0, 3], direction: [0, 0, 1], target: [0, 0, 0],
    up: [0, 1, 0], fov: 45,
  }
}

function view(id: string, areaId?: string, channel: 'color' | 'metalness' = 'color') {
  return {
    id,
    target: areaId ? { kind: 'area', areaId } : { kind: 'model' },
    framing: areaId ? 'fit-area' : 'fit-model',
    pose: areaId ? { kind: id.endsWith('-face') ? 'area-face' : 'area-craft' } : { kind: 'direction', direction: [0, 0, 1] },
    channel,
    width: 1440,
    height: 1440,
    ...(areaId ? { areaId } : {}),
    reason: 'QC evidence',
  }
}

function descriptor(id: string, viewId: string, areaId?: string, channel: 'color' | 'metalness' = 'color') {
  return {
    id,
    fileName: `${viewId}.png`,
    mimeType: 'image/png',
    byteLength: PNG_BYTES.byteLength,
    sha256: DIGEST('a'),
    width: 1440,
    height: 1440,
    ...(areaId ? { areaId } : {}),
    channel,
  }
}

function inputFor(spec: Record<string, unknown>) {
  const frontFace = view('area-front-face', 'front')
  const frontCraft = view('area-front-craft', 'front')
  const backFace = view('area-back-face', 'back')
  const backCraft = view('area-back-craft', 'back')
  const entries = [
    [frontFace, descriptor('qc-area-front-face', frontFace.id, 'front')],
    [frontCraft, descriptor('qc-area-front-craft', frontCraft.id, 'front')],
    [backFace, descriptor('qc-area-back-face', backFace.id, 'back')],
    [backCraft, descriptor('qc-area-back-craft', backCraft.id, 'back')],
  ] as const
  return {
    createdAt: '2026-08-25T00:00:00.000Z',
    project: inspectProject(spec),
    inspection: {
      name: 'bottle.glb', fingerprint: DIGEST('b'),
      dimensions: { width: 1, height: 2, depth: 1 },
      meshes: [{ meshIndex: 7, stableSelector: 'mesh:7', nodeName: 'Bottle' }], warnings: [],
    },
    evidence: {
      preset: 'qc-standard',
      views: entries.map(([request, artifact]) => ({ artifact, view: request, camera: camera() })),
      areas: [
        { areaId: 'front', meshIndex: 7, nodeName: 'Bottle', side: 'front', surfaceMode: 'overlay', viewIds: ['area-front-face', 'area-front-craft'] },
        { areaId: 'back', meshIndex: 7, nodeName: 'Bottle', side: 'back', surfaceMode: 'overlay', viewIds: ['area-back-face', 'area-back-craft'] },
      ],
      validation: { ready: true, issues: [] },
    },
    artifacts: entries.map(([, item]) => ({ ...item, bytes: PNG_BYTES })),
  }
}

describe('QC output manifest', () => {
  it('binds relative PNG evidence to the canonical input revision', async () => {
    const spec = await fixture()
    const input = inputFor(spec)
    const modelRequest = view('model-front')
    const modelDescriptor = descriptor('qc-model-front', modelRequest.id)
    input.evidence.views.push({ artifact: modelDescriptor, view: modelRequest, camera: camera() })
    input.artifacts.push({ ...modelDescriptor, bytes: PNG_BYTES })

    const manifest = buildQcManifest(input)

    expect(manifest).toMatchObject({
      version: 1,
      preset: 'qc-standard',
      input: { kind: 'label-spec-v2', revision: revisionOf(spec), sha256: revisionOf(spec).slice('sha256:'.length) },
    })
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'qc-model-front', path: 'model/model-front.png' }),
    ]))
    expect(manifest.artifacts.every((artifact: { path: string }) => !path.isAbsolute(artifact.path))).toBe(true)
  })

  it('retains exact dimensions, hashes, channels, and camera metadata', async () => {
    const manifest = buildQcManifest(inputFor(await fixture()))

    expect(manifest.artifacts[0]).toMatchObject({
      sha256: DIGEST('a'), mimeType: 'image/png', byteLength: PNG_BYTES.byteLength,
      width: 1440, height: 1440, areaId: 'front', channel: 'color',
      view: { kind: 'area-face', framing: 'fit-area', target: 'front' },
      camera: camera(),
    })
    expect(manifest.areas).toEqual([
      expect.objectContaining({ id: 'front', meshIndex: 7, stableSelector: 'mesh:7', artifactIds: ['qc-area-front-face', 'qc-area-front-craft'] }),
      expect.objectContaining({ id: 'back', meshIndex: 7, stableSelector: 'mesh:7', artifactIds: ['qc-area-back-face', 'qc-area-back-craft'] }),
    ])
    expect(validateQcManifest(manifest)).toEqual(manifest)
  })

  it('preserves the stored artifact hash format without recomputing it', async () => {
    const input = inputFor(await fixture())
    input.evidence.views[0].artifact.sha256 = 'd'.repeat(64)
    input.artifacts[0].sha256 = 'd'.repeat(64)

    expect(buildQcManifest(input).artifacts[0].sha256).toBe('d'.repeat(64))
  })

  it.each([
    ['kind', (input: ReturnType<typeof inputFor>) => { input.project.kind = 'label-project-v3' }],
    ['area summary', (input: ReturnType<typeof inputFor>) => { input.project.areas[0].id = 'tampered' }],
    ['revision', (input: ReturnType<typeof inputFor>) => { input.project.revision = DIGEST('c') }],
  ])('rejects a tampered project %s summary instead of trusting it', async (_label, alter) => {
    const input = inputFor(await fixture())
    alter(input)

    expect(() => buildQcManifest(input)).toThrow()
  })

  it.each([
    ['duplicate artifact ids', (input: ReturnType<typeof inputFor>) => { input.artifacts[1].id = input.artifacts[0].id }],
    ['unexpected uploaded artifact', (input: ReturnType<typeof inputFor>) => { input.artifacts.push({ ...descriptor('qc-unexpected', 'unexpected'), bytes: PNG_BYTES }) }],
    ['missing area-face image', (input: ReturnType<typeof inputFor>) => {
      input.evidence.views = input.evidence.views.filter((entry) => entry.view.id !== 'area-front-face')
      input.artifacts = input.artifacts.filter((artifact) => artifact.id !== 'qc-area-front-face')
      input.evidence.areas[0].viewIds = ['area-front-craft']
    }],
    ['mismatched project revision', (input: ReturnType<typeof inputFor>) => { input.project.revision = DIGEST('c') }],
    ['unsafe uploaded filename', (input: ReturnType<typeof inputFor>) => { input.artifacts[0].fileName = '../escape.png' }],
  ])('rejects %s before publication', async (_label, alter) => {
    const input = inputFor(await fixture())
    alter(input)

    expect(() => buildQcManifest(input)).toThrow()
  })

  it('rejects evidence whose distinct ids sanitize to the same published path', async () => {
    const input = inputFor(await fixture())
    const request = view('model/a')
    const artifact = descriptor('qc-model-slash', request.id)
    input.evidence.views.push({ artifact, view: request, camera: camera() })
    input.artifacts.push({ ...artifact, bytes: PNG_BYTES })
    const otherRequest = view('model-a')
    const otherArtifact = descriptor('qc-model-dash', otherRequest.id)
    input.evidence.views.push({ artifact: otherArtifact, view: otherRequest, camera: camera() })
    input.artifacts.push({ ...otherArtifact, bytes: PNG_BYTES })

    expect(() => buildQcManifest(input)).toThrow()
  })

  it('rejects unsafe manifest paths and stale revisions during independent validation', async () => {
    const manifest = buildQcManifest(inputFor(await fixture()))
    manifest.artifacts[0].path = '../escape.png'
    expect(() => validateQcManifest(manifest)).toThrow()

    const stale = buildQcManifest(inputFor(await fixture()))
    stale.input.revision = DIGEST('c')
    expect(() => validateQcManifest(stale)).toThrow()
  })

  it.each([
    ['disconnected area artifact ids', (manifest: ReturnType<typeof buildQcManifest>) => { manifest.areas[0].artifactIds.pop() }],
    ['artifact area id with no manifest area', (manifest: ReturnType<typeof buildQcManifest>) => {
      manifest.artifacts[0].areaId = 'missing'
      manifest.artifacts[0].view.target = 'missing'
    }],
    ['area artifact targeted at the model', (manifest: ReturnType<typeof buildQcManifest>) => { manifest.artifacts[0].view.target = 'model' }],
    ['area artifact using model framing', (manifest: ReturnType<typeof buildQcManifest>) => { manifest.artifacts[0].view.framing = 'fit-model' }],
  ])('rejects %s in independent validation', async (_label, alter) => {
    const manifest = buildQcManifest(inputFor(await fixture()))
    alter(manifest)

    expect(() => validateQcManifest(manifest)).toThrow()
  })

  it.each([
    ['an area target and area framing', (manifest: ReturnType<typeof buildQcManifest>) => {
      const artifact = manifest.artifacts.find((candidate: any) => candidate.areaId === undefined)!
      artifact.view.target = 'front'
      artifact.view.framing = 'fit-area'
    }],
    ['model target with area framing', (manifest: ReturnType<typeof buildQcManifest>) => {
      const artifact = manifest.artifacts.find((candidate: any) => candidate.areaId === undefined)!
      artifact.view.framing = 'fit-area'
    }],
  ])('rejects a model artifact with %s', async (_label, alter) => {
    const input = inputFor(await fixture())
    const request = view('model-front')
    const artifact = descriptor('qc-model-front', request.id)
    input.evidence.views.push({ artifact, view: request, camera: camera() })
    input.artifacts.push({ ...artifact, bytes: PNG_BYTES })
    const manifest = buildQcManifest(input)
    alter(manifest)

    expect(() => validateQcManifest(manifest)).toThrow()
  })

  it.each([
    ['encoded traversal', '%2e%2e/escape.png'],
    ['encoded separator', 'areas%2ffront/face.png'],
    ['Windows absolute path', 'C:/evidence.png'],
    ['full-width segment that collides with ASCII', 'ａｒｅａｓ/front/area-front-face.png'],
  ])('rejects unsafe publication path: %s', async (_label, unsafePath) => {
    const manifest = buildQcManifest(inputFor(await fixture()))
    manifest.artifacts[0].path = unsafePath

    expect(() => validateQcManifest(manifest)).toThrow()
  })

  it('rejects case-folded publication path collisions', async () => {
    const manifest = buildQcManifest(inputFor(await fixture()))
    const duplicate = structuredClone(manifest.artifacts[0])
    duplicate.id = 'qc-case-folded'
    duplicate.path = 'AREAS/front/area-front-face.png'
    manifest.artifacts.push(duplicate)
    manifest.areas[0].artifactIds.push(duplicate.id)

    expect(() => validateQcManifest(manifest)).toThrow()
  })

  it('does not allow Greek sigma and final-sigma paths to coexist', async () => {
    const input = inputFor(await fixture())
    for (const id of ['model-sigma', 'model-final-sigma']) {
      const request = view(id)
      const artifact = descriptor(`qc-${id}`, request.id)
      input.evidence.views.push({ artifact, view: request, camera: camera() })
      input.artifacts.push({ ...artifact, bytes: PNG_BYTES })
    }
    const manifest = buildQcManifest(input)
    const modelArtifacts = manifest.artifacts.filter((artifact: any) => artifact.areaId === undefined)
    modelArtifacts[0].path = 'model/Σ.png'
    modelArtifacts[1].path = 'model/ς.png'

    expect(() => validateQcManifest(manifest)).toThrow()
  })

  it.each([
    ['nested bytes', { severity: 'error', code: 'X', message: 'bad', bytes: new Uint8Array([1]) }],
    ['URL extra key', { severity: 'error', code: 'X', message: 'bad', url: 'https://example.test/evidence' }],
    ['token extra key', { severity: 'error', code: 'X', message: 'bad', token: 'secret' }],
  ])('rejects non-contract validation issue content: %s', async (_label, issue) => {
    const input = inputFor(await fixture())
    input.evidence.validation.issues = [issue] as never

    expect(() => buildQcManifest(input)).toThrow()
  })

  it('rejects unsupported manifest input kinds', async () => {
    const manifest = buildQcManifest(inputFor(await fixture()))
    manifest.input.kind = 'unknown-project'

    expect(() => validateQcManifest(manifest)).toThrow()
  })

  it('creates safe area and model paths from capture view ids', () => {
    expect(qcArtifactRelativePath({ view: view('model-front') })).toBe('model/model-front.png')
    expect(qcArtifactRelativePath({ view: view('area-front-face', 'front') })).toBe('areas/front/area-front-face.png')
  })

  it('parses only exact, compatible custom camera views', () => {
    const views = [
      { id: 'pump-top', direction: [0.4, 1, 0.4], target: 'model', framing: 'fit-model', channel: 'color' },
      { id: 'front-detail', direction: [0, 0, 1], target: 'front', framing: 'fit-area', channel: 'roughness' },
    ]
    expect(parseQcCameraConfig({ version: 1, views }, { areaIds: ['front'] })).toEqual(views)
    for (const value of [
      {}, { version: 1 }, { version: 1, views, ignored: true }, { version: 1, views: 'no' },
      { version: 1, views: Array.from({ length: 33 }, () => views[0]) },
    ]) {
      expect(() => parseQcCameraConfig(value)).toThrowError(expect.objectContaining({ code: 'INVALID_USAGE' }))
    }
  })

  it.each([
    ['non-object view', [null]],
    ['extra kind', [{ id: 'extra', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color', kind: 'direction' }]],
    ['unsupported up', [{ id: 'up', direction: [1, 0, 0], up: [0, 1, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['missing channel', [{ id: 'missing', direction: [1, 0, 0], target: 'model', framing: 'fit-model' }]],
    ['unsafe id', [{ id: '../escape', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['overlong id', [{ id: 'x'.repeat(81), direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['duplicate id', [
      { id: 'same', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' },
      { id: 'same', direction: [0, 1, 0], target: 'model', framing: 'fit-model', channel: 'color' },
    ]],
    ['reserved model id', [{ id: 'model-front', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['reserved area id', [{ id: 'area-front-face', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['non-finite direction', [{ id: 'nan', direction: [Number.NaN, 0, 1], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['zero direction', [{ id: 'zero', direction: [0, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['short direction', [{ id: 'short', direction: [1, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
    ['non-string target', [{ id: 'target', direction: [1, 0, 0], target: 7, framing: 'fit-area', channel: 'color' }]],
    ['unsafe area target', [{ id: 'target', direction: [1, 0, 0], target: '../front', framing: 'fit-area', channel: 'color' }]],
    ['missing area target', [{ id: 'target', direction: [1, 0, 0], target: 'absent', framing: 'fit-area', channel: 'color' }]],
    ['area framing on model', [{ id: 'framing', direction: [1, 0, 0], target: 'model', framing: 'fit-area', channel: 'color' }]],
    ['model framing on area', [{ id: 'framing', direction: [1, 0, 0], target: 'front', framing: 'fit-model', channel: 'color' }]],
    ['unsupported channel', [{ id: 'channel', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'normal' }]],
  ])('rejects an invalid custom camera before capture: %s', (_label, views) => {
    expect(() => parseQcCameraConfig({ version: 1, views }, { areaIds: ['front'] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_USAGE' }))
  })
})
