import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Document, NodeIO, VertexLayout } from '@gltf-transform/core'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { ExportOptions } from '../src/glb/rebuild'
import type { RebuildRequest, RebuildResponse } from '../src/glb/rebuild.worker'

const EXPECTED_UV = new Float32Array([0, 0, 1, 0, 0, 1])
const DIFFERENT_UV = new Float32Array([0.25, 0.25, 0.75, 0.25, 0.25, 0.75])

type MessageListener = (event: MessageEvent<RebuildResponse>) => void

class ReturningWorker {
  static output: Uint8Array<ArrayBufferLike> = new Uint8Array()
  static targetMeshIndices: number[] = []
  private readonly messageListeners = new Set<MessageListener>()

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.messageListeners.add(listener as unknown as MessageListener)
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.messageListeners.delete(listener as unknown as MessageListener)
  }

  postMessage(request: RebuildRequest): void {
    const glb = ReturningWorker.output.buffer.slice(
      ReturningWorker.output.byteOffset,
      ReturningWorker.output.byteOffset + ReturningWorker.output.byteLength,
    ) as ArrayBuffer
    const response: RebuildResponse = {
      kind: 'rebuild-result',
      requestId: request.requestId,
      ok: true,
      glb,
      targetMeshIndices: ReturningWorker.targetMeshIndices,
    }
    queueMicrotask(() => {
      for (const listener of this.messageListeners) {
        listener({ data: response } as MessageEvent<RebuildResponse>)
      }
    })
  }

  terminate(): void {}
}

function addTriangle(
  doc: Document,
  buffer: ReturnType<Document['createBuffer']>,
  name: string,
  uv: Float32Array<ArrayBuffer>,
  sourceSlot: string,
): void {
  const position = doc
    .createAccessor(`${sourceSlot}-position`)
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer)
  const texcoord = doc
    .createAccessor(`${sourceSlot}-uv`)
    .setType('VEC2')
    .setArray(uv)
    .setBuffer(buffer)
  const primitive = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('TEXCOORD_0', texcoord)
  const mesh = doc.createMesh(`${sourceSlot}-mesh`).addPrimitive(primitive)
  const node = doc.createNode(name).setMesh(mesh).setExtras({ sourceSlot })
  doc.getRoot().listScenes()[0].addChild(node)
}

async function duplicateNameGlb(): Promise<Uint8Array> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  doc.createScene('Scene')
  addTriangle(doc, buffer, 'Duplicate', EXPECTED_UV, 'first')
  addTriangle(doc, buffer, 'Duplicate', DIFFERENT_UV, 'second')
  doc.getRoot().getAsset().copyright = 'identity-fixture-copyright'
  return new NodeIO().setVertexLayout(VertexLayout.SEPARATE).writeBinary(doc)
}

function exportOptions(glb: Uint8Array): ExportOptions {
  return {
    glb,
    areas: [{
      meshIndex: 1,
      nodeName: 'Duplicate',
      surfaceMode: 'replace',
      fullRange: false,
      remap: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uv: EXPECTED_UV,
        indices: new Uint32Array([0, 1, 2]),
        vertexCount: 3,
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

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('Worker', ReturningWorker)
  vi.stubGlobal('ProgressEvent', class ProgressEvent extends Event {
    readonly lengthComputable: boolean
    readonly loaded: number
    readonly total: number

    constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
      super(type)
      this.lengthComputable = init.lengthComputable ?? false
      this.loaded = init.loaded ?? 0
      this.total = init.total ?? 0
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GLB export cross-check stable target identity', () => {
  it('checks the second duplicate-name source mesh through real GLTFLoader associations', async () => {
    const glb = await duplicateNameGlb()
    ReturningWorker.output = glb
    ReturningWorker.targetMeshIndices = [1]

    const loaded = await new GLTFLoader().parseAsync(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer,
      '',
    )
    const loadedMeshes: Array<{ name: string; meshIndex?: number }> = []
    loaded.scene.traverse((object) => {
      if ('isMesh' in object && object.isMesh) {
        loadedMeshes.push({ name: object.name, meshIndex: loaded.parser.associations.get(object)?.meshes })
      }
    })
    expect(loadedMeshes).toEqual([
      { name: 'Duplicate', meshIndex: 0 },
      { name: 'Duplicate_1', meshIndex: 1 },
    ])

    const { exportGlb } = await import('../src/glb/rebuild')
    const result = await exportGlb(exportOptions(glb))

    expect(result).toMatchObject({ ok: true })
    expect(result.crossCheck).toMatchObject({ loaded: true, uvSampleOk: false })
    expect(result.crossCheck?.error).toContain('mesh[1]')
    expect(result.crossCheck?.areas).toEqual([
      expect.objectContaining({ nodeName: 'Duplicate', targetNodeName: 'Duplicate', loaded: true, uvSampleOk: false }),
    ])
    expect(result.glbBytes).toEqual(glb)

    const roundtrip = await new NodeIO().readBinary(result.glbBytes!)
    expect(roundtrip.getRoot().getAsset()).toMatchObject({ copyright: 'identity-fixture-copyright' })
    expect(roundtrip.getRoot().listNodes().map((node) => node.getExtras())).toEqual([
      { sourceSlot: 'first' },
      { sourceSlot: 'second' },
    ])
  })
})
