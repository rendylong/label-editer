import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelAreaConfig, LabelLayer } from '../src/label/types'

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
import { renderCarrierMasks } from '../src/label/craft'
import { buildPrintManifest } from '../src/label/printReadiness'

class NeutralContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  tone: number | undefined
  private pixels = new Uint8ClampedArray()

  constructor(private readonly canvas: NeutralCanvas) {}

  fillRect(x: number, y: number, width: number, height: number): void {
    const match = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(this.fillStyle))
    this.tone = match ? Number(match[1]) : this.fillStyle === '#ffffff' ? 255 : 0
    if (this.pixels.length !== this.canvas.width * this.canvas.height * 4) {
      this.pixels = new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4)
    }
    for (let py = Math.max(0, y); py < Math.min(this.canvas.height, y + height); py += 1) {
      for (let px = Math.max(0, x); px < Math.min(this.canvas.width, x + width); px += 1) {
        const offset = (py * this.canvas.width + px) * 4
        this.pixels[offset] = this.tone
        this.pixels[offset + 1] = this.tone
        this.pixels[offset + 2] = this.tone
        this.pixels[offset + 3] = 255
      }
    }
  }

  getImageData(x: number, y: number, width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const source = ((y + py) * this.canvas.width + x + px) * 4
        data.set(this.pixels.slice(source, source + 4), (py * width + px) * 4)
      }
    }
    return { data, width, height, colorSpace: 'srgb' } as ImageData
  }
}

class NeutralCanvas {
  width = 0
  height = 0
  readonly context = new NeutralContext(this)

  getContext(): NeutralContext {
    return this.context
  }
}

function canvas(width: number): HTMLCanvasElement {
  return { width, height: 8 } as HTMLCanvasElement
}

function area(carrier: LabelAreaConfig['carrier'], layers: LabelLayer[] = []): LabelAreaConfig {
  return {
    id: 'front', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', carrier,
    remap: { mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] } },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, canvas: { width: 8, height: 8, aspect: 1 },
    layers, globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

function whiteLayer(overrides: Partial<LabelLayer> = {}): LabelLayer {
  return {
    id: 'white', kind: 'shape', shape: 'rectangle', x: 0, y: 0, width: 4, height: 4,
    fill: '#ffffff', stroke: 'transparent', strokeWidth: 0, cornerRadius: 0,
    rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
    processes: [{ process: 'white_underbase', requiredMask: 'white_underbase', spotName: 'WHITE' }],
    ...overrides,
  } as LabelLayer
}

const originalDocument = globalThis.document

beforeEach(() => {
  globalThis.document = { createElement: () => new NeutralCanvas() } as unknown as Document
  external.canvasToPngBytes.mockClear()
  external.packMetalRough.mockClear()
  external.bumpToNormal.mockClear()
})

afterEach(() => {
  globalThis.document = originalDocument
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

  it.each([
    ['metalness', 255],
    ['roughness', 0],
  ] as const)('packs a %s-only bake with a transient neutral companion', async (channel, neutralTone) => {
    const present = canvas(2)
    const bake = { color: canvas(1), [channel]: present }
    const prepared = await prepareAllAreas(new Uint8Array([1]), [area('direct_surface_print')], { front: bake })
    const [metalness, roughness] = external.packMetalRough.mock.calls[0] as unknown as [HTMLCanvasElement, HTMLCanvasElement]
    const companion = channel === 'metalness' ? roughness : metalness

    expect(channel === 'metalness' ? metalness : roughness).toBe(present)
    expect((companion as unknown as NeutralCanvas).context.tone).toBe(neutralTone)
    expect(prepared[0]).toHaveProperty('metalRoughPng')
    const artifacts = await createAreaChannelArtifacts([area('direct_surface_print')], { front: bake })
    expect(artifacts.map((artifact) => artifact.channel)).toEqual(['color', channel])
  })

  it('does not publish an injected white-underbase canvas for an area with no declaration', async () => {
    const target = area('clear_label')
    const artifacts = await createAreaChannelArtifacts([target], {
      front: { color: canvas(1), whiteUnderbase: canvas(5) },
    })

    expect(artifacts.map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, { color: canvas(1), whiteUnderbase: canvas(5) }).separations).not.toContain('white_underbase')
  })

  it('rejects an injected unproven white-underbase canvas despite a current declaration', async () => {
    const target = area('clear_label', [whiteLayer()])
    const bake = { color: canvas(1), whiteUnderbase: canvas(5) }
    const artifacts = await createAreaChannelArtifacts([target], { front: bake })

    expect(artifacts.map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, bake).separations).toEqual([])
  })

  it('publishes only a renderer-proven selective white-underbase artifact and keeps manifest in lockstep', async () => {
    const target = area('clear_label', [whiteLayer()])
    const masks = renderCarrierMasks(8, 8, (context, _layer, gray) => {
      context.fillStyle = `rgb(${gray},${gray},${gray})`
      context.fillRect(0, 0, 4, 4)
      return true
    }, target)
    const bake = { color: canvas(1), ...masks }
    const artifacts = await createAreaChannelArtifacts([target], { front: bake })

    expect(artifacts.map((artifact) => [artifact.id, artifact.fileName, artifact.channel])).toEqual([
      ['front-color', 'color.png', 'color'],
      ['front-white_underbase', 'white-underbase.png', 'white_underbase'],
    ])
    expect(buildPrintManifest(target, bake).separations).toEqual(['white_underbase', 'WHITE'])
    expect(external.canvasToPngBytes).toHaveBeenCalledTimes(2)
  })

  it.each([
    { visible: false },
    { opacity: 0 },
  ] as const)('omits white-underbase artifact and manifest separation for non-rendering declaration %j', async (overrides) => {
    const target = area('clear_label', [whiteLayer(overrides)])
    const bake = { color: canvas(1), whiteUnderbase: canvas(5) }

    expect((await createAreaChannelArtifacts([target], { front: bake })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, bake).separations).toEqual([])
  })
})
