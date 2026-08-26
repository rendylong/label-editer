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
import { createAreaChannelArtifacts, createChannelArtifact } from '../src/agent/artifactExport'
import { renderCarrierMasks, withRendererWhiteUnderbaseAuthorization } from '../src/label/craft'
import { buildPrintManifest } from '../src/label/printReadiness'

class NeutralContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  tone: number | undefined
  getImageDataCalls = 0
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
    this.getImageDataCalls += 1
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

function renderWhiteBake(target: LabelAreaConfig, version = 7) {
  const masks = renderCarrierMasks(8, 8, (context, _layer, gray) => {
    context.fillStyle = `rgb(${gray},${gray},${gray})`
    context.fillRect(0, 0, 4, 4)
    return true
  }, target, version)
  return { color: canvas(1), ...masks, version }
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
    const bake = renderWhiteBake(target)
    const artifacts = await createAreaChannelArtifacts([target], { front: bake })

    expect(artifacts.map((artifact) => [artifact.id, artifact.fileName, artifact.channel])).toEqual([
      ['front-color', 'color.png', 'color'],
      ['front-white_underbase', 'white-underbase.png', 'white_underbase'],
    ])
    expect(buildPrintManifest(target, bake).separations).toEqual(['white_underbase', 'WHITE'])
    expect(external.canvasToPngBytes).toHaveBeenCalledTimes(2)
  })

  it('shares one current-pixel verification across synchronous artifact and manifest consumption', async () => {
    const target = area('clear_label', [whiteLayer()])
    const bake = renderWhiteBake(target)
    const white = bake.whiteUnderbase as unknown as NeutralCanvas
    const callsBeforePublication = white.context.getImageDataCalls
    let manifest: ReturnType<typeof buildPrintManifest> | undefined
    let artifact: ReturnType<typeof createChannelArtifact> | undefined

    withRendererWhiteUnderbaseAuthorization(target, bake, (authorization) => {
      manifest = buildPrintManifest(target, bake, authorization)
      artifact = createChannelArtifact(target, bake, 'white_underbase', authorization)
    })

    expect(manifest?.separations).toEqual(['white_underbase', 'WHITE'])
    await expect(artifact).resolves.toMatchObject({ channel: 'white_underbase' })
    expect(white.context.getImageDataCalls - callsBeforePublication).toBe(1)
  })

  it('verifies current pixels once for a manifest with multiple white contributors', () => {
    const target = area('clear_label', [
      whiteLayer(),
      whiteLayer({ id: 'second-white', x: 4, zIndex: 1 }),
    ])
    const bake = renderWhiteBake(target)
    const white = bake.whiteUnderbase as unknown as NeutralCanvas
    const callsBeforePublication = white.context.getImageDataCalls

    expect(buildPrintManifest(target, bake).separations).toEqual(['white_underbase', 'WHITE'])
    expect(white.context.getImageDataCalls - callsBeforePublication).toBe(1)
  })

  it('does not transfer a renderer proof to a different area id', async () => {
    const rendered = area('clear_label', [whiteLayer()])
    const bake = renderWhiteBake(rendered)
    const current = { ...rendered, id: 'back', name: 'Back' }

    expect((await createAreaChannelArtifacts([current], { back: bake })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(current, bake).separations).toEqual([])
  })

  it('does not transfer a renderer proof to another bake version', async () => {
    const target = area('clear_label', [whiteLayer()])
    const bake = renderWhiteBake(target, 7)
    const stale = { ...bake, version: 8 }

    expect((await createAreaChannelArtifacts([target], { front: stale })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, stale).separations).toEqual([])
  })

  it('retires an older same-intent raster after a newer area revision renders', async () => {
    const target = area('clear_label', [whiteLayer()])
    const stale = renderWhiteBake(target, 7)
    const current = renderWhiteBake(target, 8)

    expect((await createAreaChannelArtifacts([target], { front: stale })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, stale).separations).toEqual([])
    expect((await createAreaChannelArtifacts([target], { front: current })).map((artifact) => artifact.channel)).toEqual([
      'color', 'white_underbase',
    ])
    expect(buildPrintManifest(target, current).separations).toEqual(['white_underbase', 'WHITE'])
  })

  it.each([
    ['layer id', (target: LabelAreaConfig) => ({
      ...target,
      layers: target.layers.map((layer) => ({ ...layer, id: 'replacement-white' })),
    })],
    ['geometry', (target: LabelAreaConfig) => ({
      ...target,
      layers: target.layers.map((layer) => ({ ...layer, width: 6 })),
    })],
    ['process', (target: LabelAreaConfig) => ({
      ...target,
      layers: target.layers.map((layer) => ({
        ...layer,
        processes: [{ process: 'white_underbase' as const, requiredMask: 'white_underbase' as const, spotName: 'OPAQUE_WHITE' }],
      })),
    })],
    ['visibility', (target: LabelAreaConfig) => ({
      ...target,
      layers: target.layers.map((layer) => ({ ...layer, visible: false })),
    })],
    ['opacity', (target: LabelAreaConfig) => ({
      ...target,
      layers: target.layers.map((layer) => ({ ...layer, opacity: 0.5 })),
    })],
  ] as const)('invalidates proof after current %s intent changes', async (_label, mutate) => {
    const rendered = area('clear_label', [whiteLayer()])
    const bake = renderWhiteBake(rendered)
    const current = mutate(rendered)

    expect((await createAreaChannelArtifacts([current], { front: bake })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(current, bake).separations).toEqual([])
  })

  it('invalidates proof after the proven pixels are cleared', async () => {
    const target = area('clear_label', [whiteLayer()])
    const bake = renderWhiteBake(target)
    const white = bake.whiteUnderbase as unknown as NeutralCanvas
    white.context.fillStyle = 'rgb(0,0,0)'
    white.context.fillRect(0, 0, white.width, white.height)

    expect((await createAreaChannelArtifacts([target], { front: bake })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, bake).separations).toEqual([])
  })

  it('invalidates proof after a nonempty proven raster is mutated', async () => {
    const target = area('clear_label', [whiteLayer()])
    const bake = renderWhiteBake(target)
    const white = bake.whiteUnderbase as unknown as NeutralCanvas
    white.context.fillStyle = 'rgb(255,255,255)'
    white.context.fillRect(7, 7, 1, 1)

    expect((await createAreaChannelArtifacts([target], { front: bake })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, bake).separations).toEqual([])
  })

  it('fails closed when a proven raster becomes unreadable before consumption', async () => {
    const target = area('clear_label', [whiteLayer()])
    const bake = renderWhiteBake(target)
    const white = bake.whiteUnderbase as unknown as NeutralCanvas
    vi.spyOn(white.context, 'getImageData').mockImplementation(() => { throw new Error('tainted after proof') })

    expect((await createAreaChannelArtifacts([target], { front: bake })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, bake).separations).toEqual([])
  })

  it('does not transfer proof to a pixel-identical cloned canvas', async () => {
    const target = area('clear_label', [whiteLayer()])
    const bake = renderWhiteBake(target)
    const clone = new NeutralCanvas()
    clone.width = 8
    clone.height = 8
    clone.context.fillStyle = 'rgb(0,0,0)'
    clone.context.fillRect(0, 0, 8, 8)
    clone.context.fillStyle = 'rgb(255,255,255)'
    clone.context.fillRect(0, 0, 4, 4)
    const injected = { ...bake, whiteUnderbase: clone as unknown as HTMLCanvasElement }

    expect((await createAreaChannelArtifacts([target], { front: injected })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(target, injected).separations).toEqual([])
  })

  it('binds image source identity into renderer proof', async () => {
    const image = {
      id: 'white-image', kind: 'image', src: 'opaque-a.png', naturalWidth: 8, naturalHeight: 8,
      x: 4, y: 4, width: 4, height: 4, rotation: 0, opacity: 1, visible: true,
      locked: false, zIndex: 0, craft: [],
      processes: [{ process: 'white_underbase', requiredMask: 'white_underbase', spotName: 'WHITE' }],
    } as LabelLayer
    const rendered = area('clear_label', [image])
    const bake = renderWhiteBake(rendered)
    const current = { ...rendered, layers: [{ ...image, src: 'opaque-b.png' } as LabelLayer] }

    expect((await createAreaChannelArtifacts([current], { front: bake })).map((artifact) => artifact.channel)).toEqual(['color'])
    expect(buildPrintManifest(current, bake).separations).toEqual([])
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
