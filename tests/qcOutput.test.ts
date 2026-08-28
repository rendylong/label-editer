import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { buildQcManifest, parseQcCameraConfig, qcAreaToken, qcArtifactRelativePath, validateQcManifest } from '../scripts/lib/qc-output.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { inspectProject, revisionOf } from '../scripts/lib/project-control.mjs'

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const DIGEST = (character: string) => `sha256:${character.repeat(64)}`
const fixturePath = path.resolve(import.meta.dirname, 'fixtures/specs/perfume-front-back-v2.json')
const opaqueFixturePath = path.resolve(import.meta.dirname, 'fixtures/specs/qc-opaque-area-ids-v2.json')
const FRONT_TOKEN = 'front-fwgwsmlxvrcisx6afqaj5q7wv4zokhvqa6b4c4aa24cr2ftcxe5a'
const BACK_TOKEN = 'back-hrecgrxtoubhm572rigwqmfde4knj4j7t2kmfwpccxqkyic22tsq'
const UPPER_FRONT_TOKEN = 'Front-uylvsaqcrgecccp2skwxmxqsac3ksbu3tamqreosor6gkr2gnhra'
const FRONT_FACE_ID = `area-${FRONT_TOKEN}-face`
const FRONT_CRAFT_ID = `area-${FRONT_TOKEN}-craft`

async function fixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'))
}

function camera() {
  return {
    position: [0, 0, 3], direction: [0, 0, 1], target: [0, 0, 0],
    up: [0, 1, 0], fov: 45,
  }
}

const MODEL_VIEW_IDS = [
  'model-front', 'model-back', 'model-left', 'model-right',
  'model-front-right', 'model-back-left',
] as const

function view(id: string, areaId?: string, channel: 'color' | 'metalness' | 'roughness' | 'bump' = 'color') {
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

function descriptor(id: string, viewId: string, areaId?: string, channel: 'color' | 'metalness' | 'roughness' | 'bump' = 'color') {
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

function inputFor(spec: Record<string, unknown>, areaTokensById: Record<string, string> = {}) {
  const specAreas = (spec as { areas: Array<{ id: string; side?: 'front' | 'back' }> }).areas
  const areaEntries = specAreas.flatMap((area) => {
    const token = areaTokensById[area.id] ?? qcAreaToken(area.id)
    const face = view(`area-${token}-face`, area.id)
    const craft = view(`area-${token}-craft`, area.id)
    return [
      [face, descriptor(`qc-${face.id}`, face.id, area.id)],
      [craft, descriptor(`qc-${craft.id}`, craft.id, area.id)],
    ] as const
  })
  const entries = [
    ...MODEL_VIEW_IDS.map((id) => {
      const request = view(id)
      return [request, descriptor(`qc-${id}`, id)] as const
    }),
    ...areaEntries,
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
      areas: specAreas.map((area) => {
        const token = areaTokensById[area.id] ?? qcAreaToken(area.id)
        return {
          areaId: area.id, meshIndex: 7, nodeName: 'Bottle',
          ...(area.side === undefined ? {} : { side: area.side }),
          surfaceMode: 'overlay', requiredChannels: [],
          viewIds: [`area-${token}-face`, `area-${token}-craft`],
        }
      }),
      validation: { ready: true, issues: [] },
    },
    artifacts: entries.map(([, item]) => ({ ...item, bytes: PNG_BYTES })),
  }
}

describe('QC output manifest', () => {
  it('binds relative PNG evidence to the canonical input revision', async () => {
    const spec = await fixture()
    const input = inputFor(spec)

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

    const frontFace = manifest.artifacts.find((artifact: { id: string }) => artifact.id === `qc-${FRONT_FACE_ID}`)
    expect(frontFace).toMatchObject({
      sha256: DIGEST('a'), mimeType: 'image/png', byteLength: PNG_BYTES.byteLength,
      width: 1440, height: 1440, areaId: 'front', channel: 'color',
      viewId: FRONT_FACE_ID, reason: 'QC evidence',
      view: { kind: 'area-face', framing: 'fit-area', target: 'front' },
      camera: camera(),
    })
    expect(manifest.areas).toEqual([
      expect.objectContaining({ id: 'front', meshIndex: 7, stableSelector: 'mesh:7', artifactIds: [`qc-${FRONT_FACE_ID}`, `qc-${FRONT_CRAFT_ID}`] }),
      expect.objectContaining({ id: 'back', meshIndex: 7, stableSelector: 'mesh:7', artifactIds: [`qc-area-${BACK_TOKEN}-face`, `qc-area-${BACK_TOKEN}-craft`] }),
    ])
    expect(validateQcManifest(manifest)).toEqual(manifest)
  })

  it.each(MODEL_VIEW_IDS)('rejects a missing required %s artifact during independent validation', async (viewId) => {
    const manifest = buildQcManifest(inputFor(await fixture()))
    manifest.artifacts = manifest.artifacts.filter((artifact: { viewId: string }) => artifact.viewId !== viewId)

    expect(() => validateQcManifest(manifest)).toThrow()
  })

  it.each(['metalness', 'roughness', 'bump'] as const)('rejects a missing declared %s artifact even when area membership is edited consistently', async (channel) => {
    const input = inputFor(await fixture())
    const area = input.evidence.areas[0]
    const request = view(`area-front-${channel}`, 'front', channel)
    const artifact = descriptor(`qc-${request.id}`, request.id, 'front', channel)
    input.evidence.views.push({ artifact, view: request, camera: camera() })
    input.artifacts.push({ ...artifact, bytes: PNG_BYTES })
    ;(area as { requiredChannels: Array<'metalness' | 'roughness' | 'bump'> }).requiredChannels = [channel]
    area.viewIds.push(request.id)
    const manifest = buildQcManifest(input)
    const artifactId = `qc-${request.id}`
    manifest.artifacts = manifest.artifacts.filter((candidate: { id: string }) => candidate.id !== artifactId)
    manifest.areas[0].artifactIds = manifest.areas[0].artifactIds.filter((id: string) => id !== artifactId)

    expect(() => validateQcManifest(manifest)).toThrow()
  })

  it('rejects undeclared extra face-on PBR evidence', async () => {
    const input = inputFor(await fixture())
    const request = view('area-front-metalness', 'front', 'metalness')
    const artifact = descriptor('qc-area-front-metalness', request.id, 'front', 'metalness')
    input.evidence.views.push({ artifact, view: request, camera: camera() })
    input.artifacts.push({ ...artifact, bytes: PNG_BYTES })
    input.evidence.areas[0].viewIds.push(request.id)

    expect(() => buildQcManifest(input)).toThrow()
  })

  it('keeps side optional in built and independently validated manifests', async () => {
    const input = inputFor(await fixture())
    for (const area of input.evidence.areas) delete (area as { side?: string }).side

    const manifest = buildQcManifest(input)

    expect(manifest.areas.every((area: { side?: string }) => !Object.hasOwn(area, 'side'))).toBe(true)
    expect(validateQcManifest(manifest)).toEqual(manifest)
  })

  it('round-trips the long, Unicode, and token-collision compatibility fixture without narrowing area ids', async () => {
    const spec = JSON.parse(await readFile(opaqueFixturePath, 'utf8'))
    const manifest = buildQcManifest(inputFor(spec))

    expect(manifest.areas.map((area: { id: string }) => area.id)).toEqual(spec.areas.map((area: { id: string }) => area.id))
    expect(manifest.areas.every((area: { side?: string }) => !Object.hasOwn(area, 'side'))).toBe(true)
    const areaPaths = manifest.artifacts.filter((artifact: { areaId?: string }) => artifact.areaId !== undefined)
      .map((artifact: { path: string }) => artifact.path)
    expect(new Set(areaPaths).size).toBe(areaPaths.length)
    expect(areaPaths.every((value: string) => /^areas\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.png$/.test(value))).toBe(true)
    expect(validateQcManifest(manifest)).toEqual(manifest)
  })

  it('publishes case-fold-colliding opaque area ids under distinct deterministic tokens', async () => {
    const spec = await fixture()
    spec.areas[0].id = 'Front'
    spec.areas[1].id = 'front'
    const manifest = buildQcManifest(inputFor(spec))

    expect(manifest.areas.map((area: { id: string }) => area.id)).toEqual(['Front', 'front'])
    const pathsByArea = new Map(manifest.areas.map((area: { id: string; artifactIds: string[] }) => [
      area.id,
      area.artifactIds.map((artifactId) => manifest.artifacts.find((artifact: { id: string }) => artifact.id === artifactId)?.path),
    ]))
    expect(pathsByArea.get('Front')).toEqual([
      `areas/${UPPER_FRONT_TOKEN}/area-${UPPER_FRONT_TOKEN}-face.png`,
      `areas/${UPPER_FRONT_TOKEN}/area-${UPPER_FRONT_TOKEN}-craft.png`,
    ])
    expect(pathsByArea.get('front')).toEqual([
      `areas/${FRONT_TOKEN}/area-${FRONT_TOKEN}-face.png`,
      `areas/${FRONT_TOKEN}/area-${FRONT_TOKEN}-craft.png`,
    ])
    expect(validateQcManifest(manifest)).toEqual(manifest)

    const rawCaseOnlyDirectories = structuredClone(manifest)
    for (const artifact of rawCaseOnlyDirectories.artifacts) {
      if (artifact.areaId === 'Front') artifact.path = artifact.path.replace(`areas/${UPPER_FRONT_TOKEN}/`, 'areas/Front/')
      if (artifact.areaId === 'front') artifact.path = artifact.path.replace(`areas/${FRONT_TOKEN}/`, 'areas/front/')
    }
    expect(() => validateQcManifest(rawCaseOnlyDirectories)).toThrow()
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
      input.evidence.views = input.evidence.views.filter((entry) => entry.view.id !== FRONT_FACE_ID)
      input.artifacts = input.artifacts.filter((artifact) => artifact.id !== `qc-${FRONT_FACE_ID}`)
      input.evidence.areas[0].viewIds = [FRONT_CRAFT_ID]
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
      const artifact = manifest.artifacts.find((candidate: { areaId?: string }) => candidate.areaId !== undefined)!
      artifact.areaId = 'missing'
      artifact.view.target = 'missing'
    }],
    ['area artifact targeted at the model', (manifest: ReturnType<typeof buildQcManifest>) => {
      manifest.artifacts.find((candidate: { areaId?: string }) => candidate.areaId !== undefined)!.view.target = 'model'
    }],
    ['area artifact using model framing', (manifest: ReturnType<typeof buildQcManifest>) => {
      manifest.artifacts.find((candidate: { areaId?: string }) => candidate.areaId !== undefined)!.view.framing = 'fit-model'
    }],
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
    expect(qcArtifactRelativePath({ view: view('area-front-face', 'front') }))
      .toBe(`areas/${FRONT_TOKEN}/area-front-face.png`)
  })

  it('derives distinct ASCII publication paths while preserving opaque area targets', () => {
    const areaIds = [`opaque-${'a'.repeat(180)}`, '正面 标签／α', 'front/label', 'front\\label']
    const paths = areaIds.map((areaId, index) => qcArtifactRelativePath({
      view: view(`opaque-view-${index}`, areaId),
    }))

    expect(new Set(paths).size).toBe(paths.length)
    expect(paths.every((value) => /^areas\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.png$/.test(value))).toBe(true)
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

  it('accepts an opaque known area id as a custom camera target', () => {
    const areaId = '正面 标签／α'
    const views = [{ id: 'unicode-detail', direction: [0, 0, 1], target: areaId, framing: 'fit-area', channel: 'color' }]

    expect(parseQcCameraConfig({ version: 1, views }, { areaIds: [areaId] })).toEqual(views)
  })

  it('accepts target model with area framing only when model is an exact known opaque area id', () => {
    const areaView = [{ id: 'model-area', direction: [0, 0, 1], target: 'model', framing: 'fit-area', channel: 'color' }]

    expect(parseQcCameraConfig({ version: 1, views: areaView }, { areaIds: ['model'] })).toEqual(areaView)
    expect(() => parseQcCameraConfig({ version: 1, views: areaView }, { areaIds: ['front'] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_USAGE' }))
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
    ['reserved area id', [{ id: FRONT_FACE_ID, direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }]],
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
