// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
import { createBrowserAgentBridge, isBakeSettleWindowReady } from '../src/agent/browserBridgeRuntime'
import { registerAgentPreviewCapture } from '../src/agent/previewCapture'
import type { QcCameraMetadata, ReviewEvidenceRequest, ReviewViewRequest } from '../src/agent/contracts'
import type { DesignReviewManifestV1, EditorHandoffV2, LayoutBlueprintV1 } from '../src/agent/designContracts'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import { designAssetReadinessKey, designFontReadinessKey } from '../src/label/exportReadiness'
import type { LabelAreaConfig } from '../src/label/types'
import { useLabelStore, useModelStore, useUiStore, type BakeResult } from '../src/state/stores'
import { pngBlob as structuralPngBlob } from './pngTestUtils'

const external = vi.hoisted(() => ({
  restoreImportedAreaRuntime: vi.fn(async () => ({ remapOutput: null, meshAccessors: null })),
}))

vi.mock('../src/app/projectImportRuntime', () => ({
  restoreImportedAreaRuntime: external.restoreImportedAreaRuntime,
}))

const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

it('requires elapsed settle time and multiple unchanged frames before capture readiness', () => {
  expect(isBakeSettleWindowReady(400, 1)).toBe(false)
  expect(isBakeSettleWindowReady(349, 3)).toBe(false)
  expect(isBakeSettleWindowReady(350, 3)).toBe(true)
})

function pngBlob(value: string): Blob {
  return new NodeBlob([value], { type: 'image/png' }) as unknown as Blob
}

function area(): LabelAreaConfig {
  return {
    id: 'front-label',
    name: 'Front label',
    meshIndex: 7,
    nodeName: 'Bottle_Label',
    surfaceMode: 'replace',
    side: 'front',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1,
      wrap: 1, offset: 0, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 2, height: 2, aspect: 1 },
    printSpec: {
      physicalWidthMm: 40, physicalHeightMm: 40, bleedMm: 2,
      cornerRadiusMm: 0, minTextHeightMm: 1,
      dieCutShape: 'rectangle', spotColors: ['Gold foil'],
    },
    layers: [{
      id: 'crafted-mark', kind: 'shape', shape: 'rectangle',
      width: 1, height: 1, fill: '#ffffff', stroke: '#ffffff', strokeWidth: 0,
      cornerRadius: 0, x: 1, y: 1, rotation: 0, opacity: 1,
      visible: true, locked: false, zIndex: 0,
      craft: [{ type: 'foil', params: { foilSpotName: 'Gold foil' } }, { type: 'emboss', params: {} }],
    }],
    globalCraft: { craft: [] },
    fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

function channelCanvas(neutral: number, changed?: number): HTMLCanvasElement {
  const data = new Uint8ClampedArray(2 * 2 * 4)
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = neutral
    data[offset + 1] = neutral
    data[offset + 2] = neutral
    data[offset + 3] = 255
  }
  if (changed !== undefined) {
    const lastPixel = data.length - 4
    data[lastPixel] = changed
    data[lastPixel + 1] = changed
    data[lastPixel + 2] = changed
  }
  return {
    width: 2,
    height: 2,
    getContext: () => ({ getImageData: () => ({ data }) }),
  } as unknown as HTMLCanvasElement
}

function bake(owner: LabelAreaConfig, roughness = channelCanvas(255, 42)): BakeResult {
  return {
    color: channelCanvas(0),
    metalness: channelCanvas(0, 255),
    roughness,
    bump: channelCanvas(128, 160),
    spec: owner.canvas,
    version: 1,
    areaOwner: owner,
    assetReadinessKey: designAssetReadinessKey(owner),
  }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function installOwner(owner = area()): LabelAreaConfig {
  useLabelStore.setState({
    ...useLabelStore.getInitialState(),
    areas: [owner], activeAreaId: owner.id, activeArea: owner,
    meshIndex: owner.meshIndex, nodeName: owner.nodeName,
    bakeMap: { [owner.id]: bake(owner) },
  }, true)
  return owner
}

function uploadedDescriptor(id: string): Record<string, unknown> {
  return {
    id,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    url: `/session/s1/artifact/${id}?token=${token}`,
    byteLength: 1,
  }
}

function exactUploadDescriptor(input: URL | RequestInfo, init?: RequestInit, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const url = new URL(String(input), window.location.origin)
  const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
  const headers = new Headers(init?.headers)
  const body = init?.body as Uint8Array | undefined
  return {
    id,
    fileName: decodeURIComponent(headers.get('x-artifact-file-name') ?? id),
    mimeType: headers.get('content-type') ?? 'application/octet-stream',
    url: `/session/s1/artifact/${encodeURIComponent(id)}?token=${token}`,
    byteLength: body?.byteLength ?? 0,
    ...overrides,
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function reviewFixture(): { request: ReviewEvidenceRequest; owner: LabelAreaConfig } {
  const blueprint: LayoutBlueprintV1 = {
    version: 1,
    revision: 'review-design-v1',
    carrierDefaults: { carrier: 'direct_surface_print' },
    assets: [],
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      artboard: { widthMm: 40, heightMm: 40, background: 'transparent' },
      placementIntent: 'Centered front.', placementPolicy: 'block',
      layers: [{
        id: 'mark', kind: 'shape', boundsMm: { x: 4, y: 4, width: 32, height: 32 },
        anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 0,
        processes: [{ process: 'screen_print' }], shape: 'ellipse',
        fill: '#111111', stroke: '#111111', strokeWidthMm: 0, cornerRadiusMm: 0,
      }],
    }],
  }
  const blueprintJson = JSON.stringify(blueprint)
  const blueprintSha = sha256(blueprintJson)
  const designManifest: DesignReviewManifestV1 = {
    version: 1, createdAt: '2026-08-27T10:00:00.000Z',
    blueprint: { revision: blueprint.revision, sha256: blueprintSha },
    html: { sha256: '1'.repeat(64) }, references: [],
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'mockup-front', path: 'mockup-front.png', sha256: '2'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1200, viewKind: 'mockup-front',
    }, {
      id: 'mockup-back', path: 'mockup-back.png', sha256: '3'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1200, viewKind: 'mockup-back',
    }, {
      id: 'mockup-area-front', path: 'areas/front.png', sha256: '4'.repeat(64), mimeType: 'image/png',
      width: 1200, height: 1200, viewKind: 'mockup-area', areaId: 'front', carrier: 'direct_surface_print',
    }],
  }
  const designReviewManifestJson = JSON.stringify(designManifest)
  const manifestSha = sha256(designReviewManifestJson)
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
      id: 'front', side: 'front', carrier: 'direct_surface_print', placement: 'Centered front.',
      physical_size_mm: { width: 40, height: 40 }, blueprint_area_id: 'front',
    }],
    assets: [], production_constraints: {}, assumptions: [], blockers: [],
  }
  const shell = { ...area(), id: 'front', name: 'Front', side: 'front' as const, surfaceMode: 'overlay' as const }
  shell.canvas = { width: 1024, height: 1024, aspect: 1 }
  shell.layers = []
  shell.globalCraft = { craft: [] }
  delete shell.printSpec
  const compiled = compileBlueprintToSpecAreas(blueprint, [{
    blueprintAreaId: 'front', name: 'Front', target: { stableSelector: 'mesh:7/node:7' },
    surfaceMode: 'overlay', range: structuredClone(shell.range),
    remap: { mode: shell.remap.mode, wrap: shell.remap.wrap, offset: shell.remap.offset, mirrorU: shell.remap.mirrorU },
  }])[0]
  compiled.designBinding = {
    blueprintRevision: blueprint.revision, blueprintSha256: blueprintSha, reviewManifestSha256: manifestSha,
  }
  const owner = applyStructuredLabelSpec(shell, { version: 2, areas: [compiled] }).areas[0]
  useLabelStore.setState({
    ...useLabelStore.getInitialState(), areas: [owner], activeAreaId: owner.id, activeArea: owner,
    meshIndex: owner.meshIndex, nodeName: owner.nodeName, selectedLayerIds: ['sentinel-selection'],
    bakeMap: { [owner.id]: bake(owner) },
  }, true)
  return {
    request: {
      width: 640, height: 640,
      designGate: { handoff, blueprintJson, designReviewManifestJson },
    },
    owner,
  }
}

describe('browser Agent QC runtime', () => {
  let disposeCapture: (() => void) | undefined

  beforeEach(() => {
    external.restoreImportedAreaRuntime.mockClear()
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState({
      ...useModelStore.getInitialState(), status: 'ready', modelName: 'bottle.glb',
      glbBytes: new Uint8Array([1, 2, 3]),
    }, true)
  })

  afterEach(() => {
    disposeCapture?.()
    disposeCapture = undefined
    vi.unstubAllGlobals()
  })

  it('captures the validated QC plan sequentially with exact artifact and area metadata', async () => {
    const owner = area()
    useLabelStore.setState({
      ...useLabelStore.getInitialState(),
      areas: [owner], activeAreaId: owner.id, activeArea: owner,
      meshIndex: owner.meshIndex, nodeName: owner.nodeName,
      bakeMap: { [owner.id]: bake(owner) },
    }, true)
    const camera: QcCameraMetadata = {
      position: [1, 2, 3], direction: [0, 0, 1], target: [0, 0, 0],
      up: [0, 1, 0], fov: 45,
    }
    const events: string[] = []
    const requests: Array<{ id: string; channel: string; pose: { kind: string } }> = []
    const uploads: Array<Record<string, string | undefined>> = []
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => pngBlob('preview'),
      qc: async (request) => {
        events.push(`capture:${request.id}`)
        requests.push(request)
        return { blob: pngBlob(request.id), camera }
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin)
      const headers = new Headers(init?.headers)
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
      events.push(`upload:${id.replace(/^qc-/, '')}`)
      uploads.push({
        id,
        fileName: decodeURIComponent(headers.get('x-artifact-file-name') ?? ''),
        width: headers.get('x-artifact-width') ?? undefined,
        height: headers.get('x-artifact-height') ?? undefined,
        areaId: headers.get('x-artifact-area-id') ? decodeURIComponent(headers.get('x-artifact-area-id')!) : undefined,
        channel: headers.get('x-artifact-channel') ?? undefined,
      })
      return { ok: true, json: async () => exactUploadDescriptor(input, init) } as Response
    }))

    const result = await createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence({ width: 640, height: 480 })

    const requestIds = [
      'model-front', 'model-back', 'model-left', 'model-right',
      'model-front-right', 'model-back-left',
      'area-front-label-face', 'area-front-label-craft',
      'area-front-label-metalness', 'area-front-label-roughness', 'area-front-label-bump',
    ]
    expect(events).toEqual(requestIds.flatMap((id) => [`capture:${id}`, `upload:${id}`]))
    expect(uploads.map(({ id, fileName }) => [id, fileName])).toEqual(
      requestIds.map((id) => [`qc-${id}`, `${id}.png`]),
    )
    expect(uploads.at(-1)).toEqual({
      id: 'qc-area-front-label-bump', fileName: 'area-front-label-bump.png',
      width: '640', height: '480', areaId: 'front-label', channel: 'bump',
    })
    expect(result).toMatchObject({
      ok: true,
      operation: 'render_qc_evidence',
      data: {
        preset: 'qc-standard',
        validation: { ready: true },
        areas: [{
          areaId: 'front-label', meshIndex: 7, nodeName: 'Bottle_Label',
          side: 'front', surfaceMode: 'replace',
          requiredChannels: ['metalness', 'roughness', 'bump'],
          viewIds: [
            'area-front-label-face', 'area-front-label-craft',
            'area-front-label-metalness', 'area-front-label-roughness',
            'area-front-label-bump',
          ],
        }],
      },
    })
    if (!result.ok) throw new Error('Expected successful QC result')
    expect(result.data.views.map((view) => view.artifact.id)).toEqual(requestIds.map((id) => `qc-${id}`))
    expect(result.data.views.at(-1)?.camera).toEqual(camera)
    expect(requests.filter((request) => request.channel !== 'color').map((request) => [request.channel, request.pose.kind])).toEqual([
      ['metalness', 'area-face'],
      ['roughness', 'area-face'],
      ['bump', 'area-face'],
    ])
  })

  it('waits for the post-activation bake replacement before snapshotting guarded QC state', async () => {
    const owner = area()
    owner.layers.push({
      id: 'copy', kind: 'text', text: 'QC READY', fontFamily: 'system-sans',
      fontSize: 24, fontWeight: 400, letterSpacing: 0, lineHeight: 1.2,
      width: 1, color: '#000000', align: 'center', italic: false,
      direction: 'horizontal', writingDirection: 'auto', language: 'en',
      x: 1, y: 1, rotation: 0, opacity: 1, visible: true, locked: false,
      zIndex: 1, craft: [],
    })
    installOwner(owner)
    const readinessKey = designFontReadinessKey(owner)
    useLabelStore.setState({
      activeAreaId: null,
      activeArea: null,
      bakeMap: { [owner.id]: { ...bake(owner), fontReadinessKey: readinessKey } },
    })
    const originalActivateArea = useLabelStore.getState().activateArea
    const replacement = { ...bake(owner), version: 2, fontReadinessKey: readinessKey }
    useLabelStore.setState({
      activateArea: (id) => {
        originalActivateArea(id)
        setTimeout(() => useLabelStore.getState().setBake(owner.id, replacement), 400)
      },
    })
    const capturedBakes: Array<BakeResult | undefined> = []
    const camera: QcCameraMetadata = {
      position: [1, 2, 3], direction: [0, 0, 1], target: [0, 0, 0],
      up: [0, 1, 0], fov: 45,
    }
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => pngBlob('preview'),
      qc: async (request) => {
        capturedBakes.push(useLabelStore.getState().bakeMap[owner.id])
        if (capturedBakes.length === 1) await new Promise((resolve) => setTimeout(resolve, 450))
        return { blob: pngBlob(request.id), camera }
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      return { ok: true, json: async () => exactUploadDescriptor(input, init) } as Response
    }))

    const result = await createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence()

    expect(result).toMatchObject({ ok: true, operation: 'render_qc_evidence' })
    expect(capturedBakes.length).toBeGreaterThan(0)
    expect(capturedBakes.every((captured) => captured === replacement)).toBe(true)
  })

  it('returns a structured issue when a required craft channel has no contribution', async () => {
    const owner = area()
    useLabelStore.setState({
      ...useLabelStore.getInitialState(),
      areas: [owner], activeAreaId: owner.id, activeArea: owner,
      meshIndex: owner.meshIndex, nodeName: owner.nodeName,
      bakeMap: { [owner.id]: bake(owner, channelCanvas(255)) },
    }, true)
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => new Blob(['preview']),
      qc: async () => { throw new Error('capture must not start') },
    })
    vi.stubGlobal('fetch', vi.fn())

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence()).resolves.toMatchObject({
      ok: false,
      operation: 'render_qc_evidence',
      error: {
        code: 'INVALID_LABEL_SPEC',
        details: {
          issues: [{
            severity: 'error', code: 'qc-empty-craft-channel',
            areaId: 'front-label', channel: 'roughness',
          }],
        },
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([0, 4097, 640.5])('rejects non-bounded integer dimension %s before capture', async (width) => {
    const owner = area()
    useLabelStore.setState({
      ...useLabelStore.getInitialState(),
      areas: [owner], activeAreaId: owner.id, activeArea: owner,
      meshIndex: owner.meshIndex, nodeName: owner.nodeName,
      bakeMap: { [owner.id]: bake(owner) },
    }, true)
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => new Blob(['preview']),
      qc: async () => { throw new Error('capture must not start') },
    })

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence({ width })).resolves.toMatchObject({
      ok: false,
      operation: 'render_qc_evidence',
      error: { code: 'INVALID_USAGE' },
    })
  })

  it('classifies invalid capture planning as INVALID_USAGE before capture', async () => {
    installOwner()
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => new Blob(['preview']),
      qc: async () => { throw new Error('capture must not start') },
    })

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence({
        customViews: [{
          id: '../escape', direction: [1, 0, 0], target: 'model',
          framing: 'fit-model', channel: 'color',
        }],
      })).resolves.toMatchObject({
      ok: false,
      operation: 'render_qc_evidence',
      error: { code: 'INVALID_USAGE' },
    })
  })

  it('rejects validation errors without authoring a visual verdict or starting capture', async () => {
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => new Blob(['preview']),
      qc: async () => { throw new Error('capture must not start') },
    })

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence()).resolves.toMatchObject({
      ok: false,
      operation: 'render_qc_evidence',
      error: {
        code: 'INVALID_LABEL_SPEC',
        details: { issues: [{ severity: 'error', code: 'no-label-areas' }] },
      },
    })
  })

  it('preserves blocking severity for a runtime-mutated invalid vector path', async () => {
    const owner = area()
    const shape = owner.layers[0]
    if (shape.kind !== 'shape') throw new Error('fixture must remain a shape layer')
    owner.layers = [{
      ...shape,
      shape: 'path',
      pathData: 'M0 0 L',
      pathViewBox: [0, 0, 1, 1],
    }]
    installOwner(owner)

    const result = await createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .validateDesign()

    expect(result).toMatchObject({
      ok: true,
      operation: 'validate_design',
      data: {
        ready: false,
        issues: [{
          severity: 'error', code: 'invalid-vector-path', areaId: owner.id,
          layerId: owner.layers[0].id, field: 'pathData',
        }],
      },
    })
  })

  it.each(['legacy-no-print', 'bare'] as const)(
    'keeps browser readiness false for malformed runtime vectors in %s early-return areas',
    async (mode) => {
      const owner = area()
      const shape = owner.layers[0]
      if (shape.kind !== 'shape') throw new Error('fixture must remain a shape layer')
      owner.layers = [{
        ...shape,
        shape: 'path',
        pathData: 'M0 0A1 1 0 0 1 0 0',
        pathViewBox: [0, 0, 1, 1],
      }]
      if (mode === 'bare') owner.carrier = 'bare'
      else {
        delete owner.carrier
        delete owner.printSpec
      }
      installOwner(owner)

      const result = await createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
        .validateDesign()

      expect(result).toMatchObject({
        ok: true,
        operation: 'validate_design',
        data: { ready: false },
      })
      expect((result as { data: { issues: unknown[] } }).data.issues).toContainEqual(expect.objectContaining({
        severity: 'error', code: 'invalid-vector-path', areaId: owner.id,
        layerId: owner.layers[0].id, field: 'pathData',
      }))
    },
  )

  it('serializes complete QC operations across deferred capture and upload boundaries', async () => {
    installOwner()
    const camera: QcCameraMetadata = {
      position: [1, 2, 3], direction: [0, 0, 1], target: [0, 0, 0],
      up: [0, 1, 0], fov: 45,
    }
    const captureEntered = deferred()
    const releaseCapture = deferred()
    const uploadEntered = deferred()
    const releaseUpload = deferred()
    let activeBatches = 0
    let maxInFlight = 0
    let modelFrontCaptures = 0
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => pngBlob('preview'),
      qc: async (request) => {
        if (request.id === 'model-front') {
          modelFrontCaptures += 1
          activeBatches += 1
          maxInFlight = Math.max(maxInFlight, activeBatches)
          captureEntered.resolve()
          await releaseCapture.promise
        }
        return { blob: pngBlob(request.id), camera }
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const id = decodeURIComponent(new URL(String(input), window.location.origin).pathname.split('/').at(-1) ?? '')
      if (id === 'qc-model-front') {
        uploadEntered.resolve()
        await releaseUpload.promise
      }
      if (id === 'qc-area-front-label-bump') activeBatches -= 1
      return { ok: true, json: async () => exactUploadDescriptor(input, init) } as Response
    }))
    const bridge = createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })

    const first = bridge.renderQcEvidence()
    const second = bridge.renderQcEvidence()
    await captureEntered.promise
    await flushMicrotasks()
    releaseCapture.resolve()
    await uploadEntered.promise
    await flushMicrotasks()
    releaseUpload.resolve()
    const results = await Promise.all([first, second])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(modelFrontCaptures).toBe(2)
    expect(maxInFlight).toBe(1)
    expect(activeBatches).toBe(0)
  })

  it('fails the current batch when area identity changes during a pending capture', async () => {
    const owner = installOwner()
    const camera: QcCameraMetadata = {
      position: [1, 2, 3], direction: [0, 0, 1], target: [0, 0, 0],
      up: [0, 1, 0], fov: 45,
    }
    const captureEntered = deferred()
    const releaseCapture = deferred()
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => pngBlob('preview'),
      qc: async (request) => {
        captureEntered.resolve()
        await releaseCapture.promise
        return { blob: pngBlob(request.id), camera }
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => uploadedDescriptor('unexpected'),
    }) as Response))
    const pending = createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence()
    await captureEntered.promise

    useLabelStore.getState().applyAreaOp(owner.id, (current) => ({ ...current, name: 'Edited during QC' }))
    releaseCapture.resolve()

    await expect(pending).resolves.toMatchObject({
      ok: false,
      operation: 'render_qc_evidence',
      error: {
        code: 'REVISION_CONFLICT',
        details: {
          issues: [{ severity: 'error', code: 'qc-stale-state', areaId: owner.id }],
        },
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['empty object', {}],
    ['empty locator', { ...uploadedDescriptor('qc-model-front'), url: '' }],
    ['whitespace locator', { ...uploadedDescriptor('qc-model-front'), url: '   \t' }],
    ['malformed locator', { ...uploadedDescriptor('qc-model-front'), url: 'http://[' }],
    ['unsupported protocol', { ...uploadedDescriptor('qc-model-front'), url: 'javascript:alert(1)' }],
    ['foreign origin', { ...uploadedDescriptor('qc-model-front'), url: 'https://example.com/artifact/qc-model-front' }],
  ])('rejects a successful artifact upload response with %s', async (_label, responseDescriptor) => {
    installOwner()
    const camera: QcCameraMetadata = {
      position: [1, 2, 3], direction: [0, 0, 1], target: [0, 0, 0],
      up: [0, 1, 0], fov: 45,
    }
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => pngBlob('preview'),
      qc: async (request) => ({ blob: pngBlob(request.id), camera }),
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responseDescriptor }) as Response))

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence()).resolves.toMatchObject({
      ok: false,
      operation: 'render_qc_evidence',
      error: { code: 'INTERNAL_ERROR', message: expect.stringMatching(/artifact upload response/i) },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('normalizes a valid relative same-origin artifact locator', async () => {
    installOwner()
    const camera: QcCameraMetadata = {
      position: [1, 2, 3], direction: [0, 0, 1], target: [0, 0, 0],
      up: [0, 1, 0], fov: 45,
    }
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => pngBlob('preview'),
      qc: async (request) => ({ blob: pngBlob(request.id), camera }),
    })
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      return { ok: true, json: async () => exactUploadDescriptor(input, init) } as Response
    }))

    const result = await createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence()

    expect(result).toMatchObject({ ok: true, operation: 'render_qc_evidence' })
    if (!result.ok) throw new Error('Expected valid same-origin locator')
    expect(result.data.views[0].artifact.url).toBe(new URL(`/session/s1/artifact/qc-model-front?token=${token}`, window.location.origin).href)
  })
})

describe('browser Agent clean production review runtime', () => {
  let disposeCapture: (() => void) | undefined

  beforeEach(() => {
    external.restoreImportedAreaRuntime.mockClear()
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState({
      ...useModelStore.getInitialState(), status: 'ready', modelName: 'bottle.glb',
      glbBytes: new Uint8Array([1, 2, 3]), selectedPartId: 'sentinel-part',
    }, true)
  })

  afterEach(() => {
    disposeCapture?.()
    disposeCapture = undefined
    vi.unstubAllGlobals()
  })

  function registerReviewCapture(
    callback: (request: ReviewViewRequest, captureIndex: number) => Promise<Record<string, unknown>> = async () => ({}),
  ) {
    let captureIndex = 0
    const camera: QcCameraMetadata = {
      position: [1, 2, 3], direction: [0, 0, -1], target: [0, 0, 0], up: [0, 1, 0], fov: 45,
    }
    disposeCapture = registerAgentPreviewCapture({
      preview: async () => pngBlob('preview'),
      qc: async () => { throw new Error('QC capture must remain separate') },
      review: async (request) => ({
        id: request.id, kind: request.kind, blob: structuralPngBlob(request.width, request.height),
        width: request.width, height: request.height,
        ...(request.kind === 'surface-face' || request.kind === 'model-front' || request.kind === 'model-back' ? { camera } : {}),
        ...await callback(request, captureIndex++),
      }),
    })
  }

  function acceptUploads(events: string[] = []) {
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const id = decodeURIComponent(new URL(String(input), window.location.origin).pathname.split('/').at(-1) ?? '')
      if (init?.method === 'PUT') {
        events.push(`upload:${id}`)
        return { ok: true, json: async () => ({ ...exactUploadDescriptor(input, init), bytes: { serverOnly: true } }) } as Response
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { artifactIds: string[] }
        return { ok: true, json: async () => ({ ok: true, artifactIds: body.artifactIds }) } as Response
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response
    }))
  }

  it('verifies the design gate and returns exactly the deterministic all-captured-before-upload plan', async () => {
    const { request } = reviewFixture()
    const events: string[] = []
    registerReviewCapture(async (view) => { events.push(`capture:${view.id}`); return {} })
    acceptUploads(events)
    const before = {
      activeAreaId: useLabelStore.getState().activeAreaId,
      selectedLayerIds: useLabelStore.getState().selectedLayerIds,
      selectedPartId: useModelStore.getState().selectedPartId,
      workspaceTab: useUiStore.getState().workspaceTab,
    }

    const result = await createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)

    const ids = ['label-front', 'surface-front', 'model-front', 'model-back', 'review-sheet']
    expect(events).toEqual([...ids.map((id) => `capture:${id}`), ...ids.map((id) => `upload:${id}`)])
    expect(result).toMatchObject({
      ok: true, operation: 'render_review_evidence',
      data: {
        inputKind: 'label-project-v3', blueprintRevision: 'review-design-v1',
        modelFingerprint: sha256(new Uint8Array([1, 2, 3])),
        views: ids.map((id) => ({ id, artifact: { id } })),
        validation: { ready: true }, fidelity: { pass: true },
      },
    })
    if (!result.ok) throw new Error('Expected review evidence')
    expect(result.data.views.every((entry) => !('bytes' in entry.artifact))).toBe(true)
    expect({
      activeAreaId: useLabelStore.getState().activeAreaId,
      selectedLayerIds: useLabelStore.getState().selectedLayerIds,
      selectedPartId: useModelStore.getState().selectedPartId,
      workspaceTab: useUiStore.getState().workspaceTab,
    }).toEqual(before)
  })

  it.each(['awaiting_user_approval', 'continuous_authorized'] as const)(
    'rejects non-current %s gate evidence before capture',
    async (status) => {
      const { request } = reviewFixture()
      const handoff = request.designGate.handoff as EditorHandoffV2
      handoff.status = status
      if (status === 'continuous_authorized') handoff.approval.mode = 'explicit_approval'
      registerReviewCapture(async () => { throw new Error('capture must not start') })
      vi.stubGlobal('fetch', vi.fn())

      await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
        .renderReviewEvidence(request)).resolves.toMatchObject({
        ok: false, operation: 'render_review_evidence',
        error: { code: status === 'awaiting_user_approval' ? 'AWAITING_USER_APPROVAL' : 'APPROVAL_REQUIRED' },
      })
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([0, 1, 2, 3, 4])('fails closed with no upload when state changes after capture boundary %i', async (boundary) => {
    const { request, owner } = reviewFixture()
    registerReviewCapture(async (_view, captureIndex) => {
      if (captureIndex === boundary) {
        useLabelStore.getState().applyAreaOp(owner.id, (current) => ({ ...current, name: `mutated-${boundary}` }))
      }
      return {}
    })
    vi.stubGlobal('fetch', vi.fn())

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong id', { id: 'wrong-id' }],
    ['wrong kind', { kind: 'model-front' }],
    ['wrong width', { width: 1 }],
    ['wrong height', { height: 1 }],
    ['wrong mime', { blob: new NodeBlob(['x'], { type: 'text/plain' }) as unknown as Blob }],
  ])('rejects a %s capture result without exposing a partial result', async (_label, mutation) => {
    const { request } = reviewFixture()
    registerReviewCapture(async (_view, index) => index === 0 ? mutation : {})
    vi.stubGlobal('fetch', vi.fn())

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns no review result when a deferred upload fails', async () => {
    const { request } = reviewFixture()
    useUiStore.setState({ channelView: 'bump' })
    const before = {
      activeAreaId: useLabelStore.getState().activeAreaId,
      activeArea: useLabelStore.getState().activeArea,
      meshIndex: useLabelStore.getState().meshIndex,
      nodeName: useLabelStore.getState().nodeName,
      remapOutput: useLabelStore.getState().remapOutput,
      meshAccessors: useLabelStore.getState().meshAccessors,
      selectedLayerIds: useLabelStore.getState().selectedLayerIds,
      selectedPartId: useModelStore.getState().selectedPartId,
      channelView: useUiStore.getState().channelView,
      workspaceTab: useUiStore.getState().workspaceTab,
    }
    registerReviewCapture()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response))

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
    expect({
      activeAreaId: useLabelStore.getState().activeAreaId,
      activeArea: useLabelStore.getState().activeArea,
      meshIndex: useLabelStore.getState().meshIndex,
      nodeName: useLabelStore.getState().nodeName,
      remapOutput: useLabelStore.getState().remapOutput,
      meshAccessors: useLabelStore.getState().meshAccessors,
      selectedLayerIds: useLabelStore.getState().selectedLayerIds,
      selectedPartId: useModelStore.getState().selectedPartId,
      channelView: useUiStore.getState().channelView,
      workspaceTab: useUiStore.getState().workspaceTab,
    }).toEqual(before)
  })

  it.each([
    ['a 1x1 capture claiming the planned dimensions', structuralPngBlob(1, 1)],
    ['an oversized IHDR', structuralPngBlob(9000, 9000)],
  ])('rejects %s before any artifact staging or image allocation', async (_label, maliciousBlob) => {
    const { request } = reviewFixture()
    registerReviewCapture(async (_view, index) => index === 0 ? { blob: maliciousBlob } : {})
    vi.stubGlobal('fetch', vi.fn())

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('purges every staged artifact from the attempt when a later stage upload fails', async () => {
    const { request } = reviewFixture()
    registerReviewCapture()
    const readable = new Set<string>()
    let putCount = 0
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin)
      if (init?.method === 'DELETE') {
        readable.clear()
        return { ok: true, json: async () => ({ ok: true }) } as Response
      }
      if (init?.method === 'PUT') {
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
        putCount += 1
        if (putCount === 2) return { ok: false, status: 503 } as Response
        readable.add(id)
        return { ok: true, json: async () => exactUploadDescriptor(input, init) } as Response
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response
    }))

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
    expect(readable).toEqual(new Set())
    expect([...((fetch as ReturnType<typeof vi.fn>).mock.calls)].some(([, init]) => init?.method === 'DELETE')).toBe(true)
  })

  it('rejects a same-origin locator bound to a different session artifact', async () => {
    const { request } = reviewFixture()
    registerReviewCapture()
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => ({
      ok: true,
      json: async () => exactUploadDescriptor(input, init, {
        url: `/session/s1/artifact/model-back?token=${token}`,
      }),
    }) as Response))

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
  })

  it.each([
    ['id', { id: 'model-back' }],
    ['name', { fileName: 'model-back.png' }],
    ['MIME', { mimeType: 'image/jpeg' }],
    ['byte length', { byteLength: 7 }],
  ])('rejects an upload response with mismatched %s binding', async (_label, mismatch) => {
    const { request } = reviewFixture()
    registerReviewCapture()
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) } as Response
      return { ok: true, json: async () => exactUploadDescriptor(input, init, mismatch) } as Response
    }))

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
  })

  it('purges an already committed attempt when state mutates during commit', async () => {
    const { request, owner } = reviewFixture()
    registerReviewCapture()
    const staged = new Set<string>()
    const readable = new Set<string>()
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin)
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
      if (init?.method === 'PUT') {
        staged.add(id)
        return { ok: true, json: async () => exactUploadDescriptor(input, init) } as Response
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { artifactIds: string[] }
        body.artifactIds.forEach((artifactId) => readable.add(artifactId))
        staged.clear()
        useLabelStore.getState().applyAreaOp(owner.id, (current) => ({ ...current, name: 'mutated-during-commit' }))
        return { ok: true, json: async () => ({ ok: true, artifactIds: body.artifactIds }) } as Response
      }
      if (init?.method === 'DELETE') {
        staged.clear()
        readable.clear()
        return { ok: true, json: async () => ({ ok: true }) } as Response
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`)
    }))

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
    expect(staged).toEqual(new Set())
    expect(readable).toEqual(new Set())
  })

  it('fails the final synchronous freshness barrier when state mutates during the last digest', async () => {
    const { request, owner } = reviewFixture()
    let capturesComplete = false
    registerReviewCapture(async (view) => {
      if (view.kind === 'review-sheet') capturesComplete = true
      return {}
    })
    vi.stubGlobal('fetch', vi.fn())
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
    const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    let mutated = false
    vi.stubGlobal('crypto', {
      getRandomValues: realGetRandomValues,
      subtle: {
        digest: async (...args: Parameters<SubtleCrypto['digest']>) => {
          const digest = await realDigest(...args)
          if (capturesComplete && !mutated) {
            mutated = true
            useLabelStore.getState().applyAreaOp(owner.id, (current) => ({ ...current, name: 'mutated-during-digest' }))
          }
          return digest
        },
      },
    })

    await expect(createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderReviewEvidence(request)).resolves.toMatchObject({
      ok: false, operation: 'render_review_evidence', error: { code: 'BROWSER_NOT_READY' },
    })
    expect(mutated).toBe(true)
  })
})
