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

  it('creates safe area and model paths from capture view ids', () => {
    expect(qcArtifactRelativePath({ view: view('model-front') })).toBe('model/model-front.png')
    expect(qcArtifactRelativePath({ view: view('area-front-face', 'front') })).toBe('areas/front/area-front-face.png')
  })

  it('parses only versioned bounded camera configuration documents', () => {
    const views = [{ id: 'pump-top', direction: [0.4, 1, 0.4], target: 'model', framing: 'fit-model', channel: 'color' }]
    expect(parseQcCameraConfig({ version: 1, views })).toEqual(views)
    for (const value of [
      {}, { version: 1 }, { version: 1, views, ignored: true }, { version: 1, views: 'no' },
      { version: 1, views: Array.from({ length: 33 }, () => views[0]) },
    ]) {
      expect(() => parseQcCameraConfig(value)).toThrowError(expect.objectContaining({ code: 'INVALID_USAGE' }))
    }
  })
})
