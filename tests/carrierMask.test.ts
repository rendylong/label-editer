import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderCarrierMasks } from '../src/label/craft'
import type { LabelAreaConfig, LabelLayer } from '../src/label/types'

function channels(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (hex) return hex.slice(1).map((part) => Number.parseInt(part, 16)) as [number, number, number]
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/i.exec(value)
  if (rgb) return rgb.slice(1).map(Number) as [number, number, number]
  throw new Error(`Unsupported color ${value}`)
}

class PixelContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  private pixels = new Uint8ClampedArray()

  constructor(private readonly canvas: PixelCanvas) {}

  fillRect(x: number, y: number, width: number, height: number): void {
    if (this.pixels.length !== this.canvas.width * this.canvas.height * 4) {
      this.pixels = new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4)
    }
    const [r, g, b] = channels(String(this.fillStyle))
    for (let py = Math.max(0, y); py < Math.min(this.canvas.height, y + height); py += 1) {
      for (let px = Math.max(0, x); px < Math.min(this.canvas.width, x + width); px += 1) {
        const offset = (py * this.canvas.width + px) * 4
        this.pixels[offset] = r
        this.pixels[offset + 1] = g
        this.pixels[offset + 2] = b
        this.pixels[offset + 3] = 255
      }
    }
  }

  getImageData(): ImageData {
    return { data: this.pixels, width: this.canvas.width, height: this.canvas.height, colorSpace: 'srgb' } as ImageData
  }

  putImageData(image: ImageData): void {
    this.pixels = new Uint8ClampedArray(image.data)
  }
}

class PixelCanvas {
  width = 0
  height = 0
  private readonly context = new PixelContext(this)

  getContext(kind: string): PixelContext | null {
    return kind === '2d' ? this.context : null
  }
}

function layer(overrides: Partial<LabelLayer> = {}): LabelLayer {
  return {
    id: 'mark', kind: 'shape', shape: 'rectangle', x: 0, y: 0, width: 1, height: 1,
    fill: '#000000', stroke: 'transparent', strokeWidth: 0, cornerRadius: 0,
    rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
    ...overrides,
  } as LabelLayer
}

function area(carrier: LabelAreaConfig['carrier'], mark: LabelLayer): LabelAreaConfig {
  return {
    id: 'area', name: 'Area', meshIndex: 0, nodeName: 'Bottle', carrier,
    remap: { mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] } },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, canvas: { width: 2, height: 2, aspect: 1 },
    ...(carrier === 'applied_label' ? { substrate: { kind: 'opaque' as const, color: '#fff', opacity: 1, boundary: { shape: 'rectangle' as const } } } : {}),
    ...(carrier === 'clear_label' ? { substrate: { kind: 'transparent' as const, opacity: 0.1, boundary: { shape: 'rectangle' as const } } } : {}),
    layers: [mark], globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

function pixel(canvas: HTMLCanvasElement | undefined, x: number, y: number): number[] | undefined {
  if (!canvas) return undefined
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const offset = (y * canvas.width + x) * 4
  return Array.from(data.slice(offset, offset + 3))
}

describe('carrier mask raster production', () => {
  const originalDocument = globalThis.document

  beforeEach(() => {
    globalThis.document = { createElement: () => new PixelCanvas() } as unknown as Document
  })

  afterEach(() => {
    globalThis.document = originalDocument
  })

  const drawLayer = (context: CanvasRenderingContext2D, _layer: LabelLayer, gray: number): void => {
    context.fillStyle = `rgb(${gray},${gray},${gray})`
    context.fillRect(0, 0, 1, 1)
  }

  it.each(['direct_surface_print', 'in_mold', 'foil_or_ink_only', 'clear_label'] as const)(
    'omits every material mask for ordinary %s artwork',
    (carrier) => {
      expect(renderCarrierMasks(2, 2, drawLayer, area(carrier, layer()))).toEqual({})
    },
  )

  it('emits only declared craft channels over neutral carrier-free pixels', () => {
    const masks = renderCarrierMasks(2, 2, drawLayer, area('direct_surface_print', layer({
      craft: [{ type: 'foil', params: {} }],
    })))

    expect(Object.keys(masks).sort()).toEqual(['metalness', 'roughness'])
    expect(pixel(masks.metalness, 0, 0)).toEqual([255, 255, 255])
    expect(pixel(masks.metalness, 1, 1)).toEqual([0, 0, 0])
    expect(pixel(masks.roughness, 1, 1)).toEqual([255, 255, 255])
  })

  it('bakes selective white underbase only from a declared layer process', () => {
    const masks = renderCarrierMasks(2, 2, drawLayer, area('clear_label', layer({
      processes: [{ process: 'white_underbase', requiredMask: 'white_underbase', spotName: 'WHITE' }],
    })))

    expect(Object.keys(masks)).toEqual(['whiteUnderbase'])
    expect(pixel(masks.whiteUnderbase, 0, 0)).toEqual([255, 255, 255])
    expect(pixel(masks.whiteUnderbase, 1, 1)).toEqual([0, 0, 0])
  })

  it('adds a declared selective white underbase to substrate-backed applied masks', () => {
    const masks = renderCarrierMasks(2, 2, drawLayer, area('applied_label', layer({
      processes: [{ process: 'white_underbase', requiredMask: 'white_underbase', spotName: 'WHITE' }],
    })))

    expect(Object.keys(masks).sort()).toEqual(['bump', 'metalness', 'roughness', 'whiteUnderbase'])
    expect(pixel(masks.whiteUnderbase, 0, 0)).toEqual([255, 255, 255])
    expect(pixel(masks.whiteUnderbase, 1, 1)).toEqual([0, 0, 0])
  })

  it('never bakes decorative or process masks for bare', () => {
    expect(renderCarrierMasks(2, 2, drawLayer, area('bare', layer({
      craft: [{ type: 'foil', params: {} }],
      processes: [{ process: 'white_underbase', requiredMask: 'white_underbase' }],
    })))).toEqual({})
  })

  it('retains the complete legacy/applied substrate mask set', () => {
    expect(Object.keys(renderCarrierMasks(2, 2, drawLayer, area('applied_label', layer()))).sort()).toEqual([
      'bump', 'metalness', 'roughness',
    ])
  })
})
