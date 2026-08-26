// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAgentBridge } from '../src/agent/browserBridgeRuntime'
import { registerAgentPreviewCapture } from '../src/agent/previewCapture'
import type { QcCameraMetadata } from '../src/agent/contracts'
import { designFontReadinessKey } from '../src/label/exportReadiness'
import type { LabelAreaConfig } from '../src/label/types'
import { useLabelStore, useModelStore, useUiStore, type BakeResult } from '../src/state/stores'

const external = vi.hoisted(() => ({
  restoreImportedAreaRuntime: vi.fn(async () => ({ remapOutput: null, meshAccessors: null })),
}))

vi.mock('../src/app/projectImportRuntime', () => ({
  restoreImportedAreaRuntime: external.restoreImportedAreaRuntime,
}))

const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

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
    url: `/artifact/${id}`,
    byteLength: 1,
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
      return {
        ok: true,
        json: async () => ({ id: 'server-id-must-not-win', fileName: 'server-name.png', mimeType: 'image/png', url: `/artifact/${id}`, byteLength: 0 }),
      } as Response
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
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      const id = decodeURIComponent(new URL(String(input), window.location.origin).pathname.split('/').at(-1) ?? '')
      return { ok: true, json: async () => uploadedDescriptor(id) } as Response
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
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      const id = decodeURIComponent(new URL(String(input), window.location.origin).pathname.split('/').at(-1) ?? '')
      if (id === 'qc-model-front') {
        uploadEntered.resolve()
        await releaseUpload.promise
      }
      if (id === 'qc-area-front-label-bump') activeBatches -= 1
      return { ok: true, json: async () => uploadedDescriptor(id) } as Response
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
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      const id = decodeURIComponent(new URL(String(input), window.location.origin).pathname.split('/').at(-1) ?? '')
      return { ok: true, json: async () => uploadedDescriptor(id) } as Response
    }))

    const result = await createBrowserAgentBridge({ token, artifactUploadBase: '/session/s1/artifact' })
      .renderQcEvidence()

    expect(result).toMatchObject({ ok: true, operation: 'render_qc_evidence' })
    if (!result.ok) throw new Error('Expected valid same-origin locator')
    expect(result.data.views[0].artifact.url).toBe(new URL('/artifact/qc-model-front', window.location.origin).href)
  })
})
