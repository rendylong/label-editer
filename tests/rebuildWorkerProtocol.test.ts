import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportOptions } from '../src/glb/rebuild'
import type { RebuildRequest, RebuildResponse } from '../src/glb/rebuild.worker'

const crossCheckHarness = vi.hoisted(() => ({
  meshes: [] as Array<{ name: string; uv: Float32Array; meshIndex: number }>,
}))

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(_url: string, onLoad: (value: {
      scene: { traverse: (visit: (object: unknown) => void) => void }
      parser: { associations: Map<object, { meshes: number }> }
    }) => void): void {
      const objects = crossCheckHarness.meshes.map((mesh) => ({
        isMesh: true,
        name: mesh.name,
        geometry: { attributes: { uv: { array: mesh.uv, count: mesh.uv.length / 2 } } },
      }))
      onLoad({
        scene: {
          traverse: (visit) => objects.forEach(visit),
        },
        parser: {
          associations: new Map(objects.map((object, index) => [object, { meshes: crossCheckHarness.meshes[index].meshIndex }])),
        },
      })
    }
  },
}))

type MessageListener = (event: MessageEvent<RebuildResponse>) => void
type ErrorListener = (event: ErrorEvent) => void

class ControlledWorker {
  static instances: ControlledWorker[] = []
  readonly posted: RebuildRequest[] = []
  readonly messageListeners = new Set<MessageListener>()
  readonly errorListeners = new Set<ErrorListener>()
  terminated = false

  constructor() {
    ControlledWorker.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.messageListeners.add(listener as unknown as MessageListener)
    if (type === 'error') this.errorListeners.add(listener as unknown as ErrorListener)
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.messageListeners.delete(listener as unknown as MessageListener)
    if (type === 'error') this.errorListeners.delete(listener as unknown as ErrorListener)
  }

  postMessage(message: RebuildRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  respond(response: RebuildResponse): void {
    for (const listener of [...this.messageListeners]) listener({ data: response } as MessageEvent<RebuildResponse>)
  }

  fail(message: string): void {
    for (const listener of [...this.errorListeners]) listener({ message } as ErrorEvent)
  }
}

function exportOptions(workerTimeoutMs = 1_000): ExportOptions {
  return {
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    workerTimeoutMs,
    areas: [{
      meshIndex: 0,
      nodeName: 'Bottle',
      surfaceMode: 'overlay',
      fullRange: false,
      remap: {
        positions: new Float32Array([0, 0, 0]),
        normals: new Float32Array([0, 0, 1]),
        uv: new Float32Array([0, 0]),
        indices: new Uint32Array([0]),
        vertexCount: 1,
        seamCrossingTriangles: 0,
        frontAngle: 0,
        maxSpan: 0,
      },
      colorPng: new Uint8Array([1]),
      metalRoughPng: new Uint8Array([2]),
      normalPng: new Uint8Array([3]),
    }],
  }
}

async function loadRebuild(): Promise<typeof import('../src/glb/rebuild')> {
  return import('../src/glb/rebuild')
}

async function completeSuccessfulExport(options: ExportOptions, marker: number): Promise<Awaited<ReturnType<typeof import('../src/glb/rebuild')['exportGlb']>>> {
  const { exportGlb } = await loadRebuild()
  const exporting = exportGlb(options)
  const controlled = ControlledWorker.instances.at(-1)!
  const request = controlled.posted[0]
  controlled.respond({
    kind: 'rebuild-result',
    requestId: request.requestId,
    ok: true,
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, marker]).buffer,
    targetMeshIndices: options.areas.map((_, index) => index),
  })
  return exporting
}

beforeEach(() => {
  vi.resetModules()
  ControlledWorker.instances = []
  crossCheckHarness.meshes = []
  vi.stubGlobal('Worker', ControlledWorker)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('shared rebuild worker request ownership', () => {
  it('routes two out-of-order responses only to their matching concurrent requests', async () => {
    const { exportGlb } = await loadRebuild()
    const firstExport = exportGlb(exportOptions())
    const secondExport = exportGlb(exportOptions())
    const shared = ControlledWorker.instances[0]
    const [firstRequest, secondRequest] = shared.posted

    shared.respond({ kind: 'rebuild-result', requestId: secondRequest.requestId, ok: false, error: 'second-result' })
    shared.respond({ kind: 'rebuild-result', requestId: firstRequest.requestId, ok: false, error: 'first-result' })

    await expect(firstExport).resolves.toMatchObject({ ok: false, error: 'first-result' })
    await expect(secondExport).resolves.toMatchObject({ ok: false, error: 'second-result' })
  })

  it('ignores unrelated responses and removes both listeners after a successful matching response', async () => {
    const { exportGlb } = await loadRebuild()
    const exporting = exportGlb(exportOptions())
    const shared = ControlledWorker.instances[0]
    const request = shared.posted[0]
    let settled = false
    void exporting.then(() => { settled = true })

    shared.respond({ kind: 'rebuild-result', requestId: request.requestId + 99, ok: false, error: 'unrelated' })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(shared.messageListeners.size).toBe(1)
    expect(shared.errorListeners.size).toBe(1)

    shared.respond({
      kind: 'rebuild-result',
      requestId: request.requestId,
      ok: true,
      glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2]).buffer,
    })
    await expect(exporting).resolves.toMatchObject({ ok: true })
    expect(shared.messageListeners.size).toBe(0)
    expect(shared.errorListeners.size).toBe(0)
  })

  it('removes both listeners after a Worker error and settles only once', async () => {
    const { exportGlb } = await loadRebuild()
    const exporting = exportGlb(exportOptions())
    const shared = ControlledWorker.instances[0]
    const request = shared.posted[0]

    shared.fail('worker-crashed')
    await expect(exporting).resolves.toEqual({ ok: false, error: 'worker-crashed' })
    expect(shared.messageListeners.size).toBe(0)
    expect(shared.errorListeners.size).toBe(0)
    shared.respond({ kind: 'rebuild-result', requestId: request.requestId, ok: false, error: 'late-response' })
  })

  it('times out a silent Worker, resets it, and lets the next request succeed on a new Worker', async () => {
    vi.useFakeTimers()
    const { exportGlb } = await loadRebuild()
    const firstExport = exportGlb(exportOptions(25))
    const stuck = ControlledWorker.instances[0]
    const firstRequest = stuck.posted[0]

    await vi.advanceTimersByTimeAsync(25)
    await expect(firstExport).resolves.toEqual({ ok: false, error: 'GLB 重打包超时，请重试' })
    expect(stuck.terminated).toBe(true)
    expect(stuck.messageListeners.size).toBe(0)
    expect(stuck.errorListeners.size).toBe(0)

    const nextExport = exportGlb(exportOptions(25))
    const replacement = ControlledWorker.instances[1]
    const nextRequest = replacement.posted[0]
    stuck.respond({ kind: 'rebuild-result', requestId: firstRequest.requestId, ok: false, error: 'late-old-worker' })
    replacement.respond({
      kind: 'rebuild-result',
      requestId: nextRequest.requestId,
      ok: true,
      glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 3]).buffer,
    })

    await expect(nextExport).resolves.toMatchObject({ ok: true })
    expect(replacement.messageListeners.size).toBe(0)
    expect(replacement.errorListeners.size).toBe(0)
  })

  it('cross-checks every mesh associated with each stable target index and ignores decoys', async () => {
    const options = exportOptions()
    options.areas = [
      { ...options.areas[0], nodeName: 'Part A', remap: { ...options.areas[0].remap, uv: new Float32Array([0, 0]) } },
      { ...options.areas[0], meshIndex: 1, nodeName: 'Part B', remap: { ...options.areas[0].remap, uv: new Float32Array([1, 1, 0.5, 0.5]) } },
    ]
    crossCheckHarness.meshes = [
      { name: 'Part A__label_overlay', uv: new Float32Array([0, 0]), meshIndex: 10 },
      { name: 'Part B__label_overlay', uv: new Float32Array([0, 0, 0.25, 0.25]), meshIndex: 11 },
      // A glTF mesh may be instantiated more than once; every associated Three mesh must pass.
      { name: 'Part B__label_overlay_1', uv: new Float32Array([1, 1, 0.5, 0.5]), meshIndex: 11 },
      { name: 'Decoy', uv: new Float32Array([1, 1, 0.5, 0.5]), meshIndex: 12 },
    ]
    const { exportGlb } = await loadRebuild()
    const exporting = exportGlb(options)
    const shared = ControlledWorker.instances[0]
    const request = shared.posted[0]
    shared.respond({
      kind: 'rebuild-result',
      requestId: request.requestId,
      ok: true,
      glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 4]).buffer,
      targetMeshIndices: [10, 11],
    })

    const result = await exporting

    expect(result.crossCheck?.loaded).toBe(true)
    expect(result.crossCheck?.uvSampleOk).toBe(false)
    expect(result.crossCheck?.error).toContain('区域「Part B」')
    expect(result.crossCheck?.areas).toEqual([
      expect.objectContaining({ nodeName: 'Part A', targetNodeName: 'Part A__label_overlay', loaded: true, uvSampleOk: true }),
      expect.objectContaining({ nodeName: 'Part B', targetNodeName: 'Part B__label_overlay', loaded: true, uvSampleOk: false }),
    ])
  })

  it('uses distinct stable mesh associations when exported node names are duplicates', async () => {
    const options = exportOptions()
    options.areas = [
      { ...options.areas[0], meshIndex: 0, nodeName: 'Duplicate' },
      { ...options.areas[0], meshIndex: 1, nodeName: 'Duplicate' },
    ]
    crossCheckHarness.meshes = [
      { name: 'Duplicate__label_overlay', uv: new Float32Array([0, 0]), meshIndex: 0 },
      { name: 'Duplicate__label_overlay_1', uv: new Float32Array([0, 0]), meshIndex: 1 },
    ]

    const result = await completeSuccessfulExport(options, 5)

    expect(result.crossCheck).toMatchObject({ loaded: true, uvSampleOk: true })
    expect(result.crossCheck?.error).toBeUndefined()
    expect(result.crossCheck?.areas).toEqual([
      expect.objectContaining({ nodeName: 'Duplicate', loaded: true, uvSampleOk: true }),
      expect.objectContaining({ nodeName: 'Duplicate', loaded: true, uvSampleOk: true }),
    ])
  })

  it('uses stable mesh associations across Three.js-sanitized name collisions', async () => {
    const options = exportOptions()
    options.areas = [
      { ...options.areas[0], meshIndex: 0, nodeName: 'Part A' },
      { ...options.areas[0], meshIndex: 1, nodeName: 'Part_A' },
    ]
    crossCheckHarness.meshes = [
      { name: 'Part_A__label_overlay', uv: new Float32Array([0, 0]), meshIndex: 0 },
      { name: 'Part_A__label_overlay_1', uv: new Float32Array([0, 0]), meshIndex: 1 },
    ]

    const result = await completeSuccessfulExport(options, 6)

    expect(result.crossCheck).toMatchObject({ loaded: true, uvSampleOk: true })
    expect(result.crossCheck?.error).toBeUndefined()
    expect(result.crossCheck?.areas).toEqual([
      expect.objectContaining({ nodeName: 'Part A', loaded: true, uvSampleOk: true }),
      expect.objectContaining({ nodeName: 'Part_A', loaded: true, uvSampleOk: true }),
    ])
  })

  it('fails closed when two area descriptors claim the same stable exported mesh index', async () => {
    const options = exportOptions()
    options.areas = [
      { ...options.areas[0], meshIndex: 0, nodeName: 'First' },
      { ...options.areas[0], meshIndex: 1, nodeName: 'Second' },
    ]
    crossCheckHarness.meshes = [
      { name: 'First__label_overlay', uv: new Float32Array([0, 0]), meshIndex: 7 },
      { name: 'Second__label_overlay', uv: new Float32Array([0, 0]), meshIndex: 7 },
    ]
    const { exportGlb } = await loadRebuild()
    const exporting = exportGlb(options)
    const shared = ControlledWorker.instances[0]
    const request = shared.posted[0]
    shared.respond({
      kind: 'rebuild-result',
      requestId: request.requestId,
      ok: true,
      glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 7]).buffer,
      targetMeshIndices: [7, 7],
    })

    const result = await exporting

    expect(result.crossCheck).toMatchObject({ loaded: true, uvSampleOk: false })
    expect(result.crossCheck?.areas).toEqual([
      expect.objectContaining({ nodeName: 'First', error: expect.stringContaining('mesh[7]') }),
      expect.objectContaining({ nodeName: 'Second', error: expect.stringContaining('mesh[7]') }),
    ])
  })

  it('preserves the single-area response contract with a unique stable association', async () => {
    const options = exportOptions()
    crossCheckHarness.meshes = [
      { name: 'Bottle__label_overlay', uv: new Float32Array([0, 0]), meshIndex: 4 },
    ]
    const { exportGlb } = await loadRebuild()
    const exporting = exportGlb(options)
    const shared = ControlledWorker.instances[0]
    const request = shared.posted[0]
    shared.respond({
      kind: 'rebuild-result',
      requestId: request.requestId,
      ok: true,
      glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 8]).buffer,
      targetMeshIndices: [4],
    })

    await expect(exporting).resolves.toMatchObject({
      ok: true,
      crossCheck: {
        loaded: true,
        uvSampleOk: true,
        areas: [expect.objectContaining({ nodeName: 'Bottle', loaded: true, uvSampleOk: true })],
      },
    })
  })

  it('fails closed when no loaded mesh has the worker-reported stable association', async () => {
    const options = exportOptions()
    crossCheckHarness.meshes = [
      { name: 'Unrelated', uv: new Float32Array([0, 0]), meshIndex: 3 },
    ]
    const { exportGlb } = await loadRebuild()
    const exporting = exportGlb(options)
    const shared = ControlledWorker.instances[0]
    const request = shared.posted[0]
    shared.respond({
      kind: 'rebuild-result',
      requestId: request.requestId,
      ok: true,
      glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 9]).buffer,
      targetMeshIndices: [99],
    })

    const result = await exporting

    expect(result.crossCheck).toMatchObject({ loaded: false, uvSampleOk: false })
    expect(result.crossCheck?.error).toContain('mesh[99]')
  })
})
