import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelAreaConfig } from '../src/label/types'

const external = vi.hoisted(() => ({
  canvasToPngBytes: vi.fn(async (canvas: HTMLCanvasElement) => new Uint8Array([canvas.width])),
  packMetalRough: vi.fn(() => ({ width: 8, height: 8 } as HTMLCanvasElement)),
  bumpToNormal: vi.fn(() => ({ width: 8, height: 8 } as HTMLCanvasElement)),
}))

vi.mock('../src/glb/analyze', () => ({
  readGlb: vi.fn(async () => ({})),
  extractMeshAccessors: vi.fn(() => ({ positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array() })),
}))
vi.mock('../src/glb/uvRemap', () => ({
  computeRemap: vi.fn(() => ({ positions: new Float32Array(), normals: new Float32Array(), uv: new Float32Array(), indices: new Uint32Array() })),
}))
vi.mock('../src/glb/textures', () => external)

import { prepareAllAreas } from '../src/app/areaExporter'
import { createAreaChannelArtifacts } from '../src/agent/artifactExport'

function canvas(width: number): HTMLCanvasElement {
  return { width, height: 8 } as HTMLCanvasElement
}

function area(carrier: LabelAreaConfig['carrier']): LabelAreaConfig {
  return {
    id: 'front', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', carrier,
    remap: { mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] } },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, canvas: { width: 8, height: 8, aspect: 1 },
    layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

beforeEach(() => {
  external.canvasToPngBytes.mockClear()
  external.packMetalRough.mockClear()
  external.bumpToNormal.mockClear()
})

describe('carrier-aware channel export', () => {
  it('encodes no material texture when a bake has no declared PBR channel', async () => {
    const color = canvas(1)
    const prepared = await prepareAllAreas(new Uint8Array([1]), [area('bare')], { front: { color } })

    expect(external.canvasToPngBytes).toHaveBeenCalledTimes(1)
    expect(external.canvasToPngBytes).toHaveBeenCalledWith(color)
    expect(external.packMetalRough).not.toHaveBeenCalled()
    expect(external.bumpToNormal).not.toHaveBeenCalled()
    expect(prepared[0]).not.toHaveProperty('metalRoughPng')
    expect(prepared[0]).not.toHaveProperty('normalPng')
  })

  it('retains legacy/applied PBR encoding when those channels exist', async () => {
    const bake = { color: canvas(1), metalness: canvas(2), roughness: canvas(3), bump: canvas(4) }
    const prepared = await prepareAllAreas(new Uint8Array([1]), [area('applied_label')], { front: bake })

    expect(external.packMetalRough).toHaveBeenCalledWith(bake.metalness, bake.roughness)
    expect(external.bumpToNormal).toHaveBeenCalledWith(bake.bump)
    expect(prepared[0]).toHaveProperty('metalRoughPng')
    expect(prepared[0]).toHaveProperty('normalPng')
  })

  it('publishes a real selective white-underbase artifact and omits absent material artifacts', async () => {
    const artifacts = await createAreaChannelArtifacts([area('clear_label')], {
      front: { color: canvas(1), whiteUnderbase: canvas(5) },
    })

    expect(artifacts.map((artifact) => [artifact.id, artifact.fileName, artifact.channel])).toEqual([
      ['front-color', 'color.png', 'color'],
      ['front-white_underbase', 'white-underbase.png', 'white_underbase'],
    ])
    expect(external.canvasToPngBytes).toHaveBeenCalledTimes(2)
  })
})
