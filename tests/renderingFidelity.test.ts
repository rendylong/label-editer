import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Document as GltfDocument } from '@gltf-transform/core'
import * as THREE from 'three'
import { readGlb } from '../src/glb/analyze'
import { renderMasks } from '../src/label/craft'
import * as craft from '../src/label/craft'
import type { ShapeGeometry, ShapeKind, ShapeLayer } from '../src/label/types'
import * as labelCanvas from '../src/label/LabelCanvas'
import * as labelTextures from '../src/glb/textures'
import * as sceneController from '../src/scene/SceneController'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import { serializeLabelProject } from '../src/app/projectSchema'
import { useLabelStore } from '../src/state/stores'
import type { LabelAreaConfig } from '../src/label/types'

const SAMPLE = new URL('../public/sample/面霜瓶.glb', import.meta.url)

function physicalBaseArea(width: number, height: number): LabelAreaConfig {
  return {
    id: 'physical-area', name: 'Physical', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width, height, aspect: 2 / 3 }, layers: [], globalCraft: { craft: [] }, fonts: [],
    referenceVisible: false, undoStack: [], redoStack: [],
  }
}

function physicalSpec() {
  return {
    version: 2,
    areas: [{
      id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
      range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
      carrier: 'direct_surface_print',
      artboard: { widthMm: 40, heightMm: 60, background: 'transparent' },
      placementPolicy: 'fit', blueprintAreaId: 'front-approved',
      designBinding: {
        blueprintRevision: 'approved-v1', blueprintSha256: '1'.repeat(64), reviewManifestSha256: '2'.repeat(64),
      },
      layers: [
        {
          id: 'title', type: 'text', text: 'REALIBOX', x: 0.5, y: 0.5, width: 0.75,
          fontSize: 64, letterSpacing: 0, lineHeight: 1.1,
          designMetrics: {
            boundsMm: { x: 5, y: 8, width: 30, height: 8 }, anchor: 'top_left', fontSizeMm: 4,
            letterSpacingEm: 0.08, lineHeight: 1.1,
          },
          processes: [{ process: 'screen_print', spotName: 'BRAND_BLACK', requiredMask: 'color' }],
        },
        {
          id: 'frame', type: 'shape', shape: 'rectangle', x: 0.5, y: 0.5, width: 0.9, height: 0.9,
          fill: 'transparent', stroke: '#A5663B', strokeWidth: 1, cornerRadius: 1,
          designMetrics: {
            normalizedBounds: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, anchor: 'center',
            strokeWidthMm: 0.25, cornerRadiusMm: 1.5,
          },
          processes: [{ process: 'hot_stamp_foil', requiredMask: 'metalness' }],
        },
      ],
    }],
  }
}

describe('physical design rendering fidelity', () => {
  it('rejects a captured raster whose dimensions disagree with the canvas aspect', () => {
    const capture = (labelCanvas as typeof labelCanvas & {
      captureDesignCanvas: (
        stage: {
          find: () => []
          draw: () => void
          toCanvas: () => HTMLCanvasElement
        },
        pixelRatio: number,
        expected: { width: number; height: number; aspect: number },
      ) => HTMLCanvasElement
    }).captureDesignCanvas
    const stage = {
      find: () => [] as [],
      draw: () => undefined,
      toCanvas: () => ({ width: 1600, height: 1600 }) as HTMLCanvasElement,
    }

    expect(() => capture(stage, 1, { width: 1600, height: 2400, aspect: 2 / 3 })).toThrow(expect.objectContaining({
      name: 'RasterAspectError', code: 'RASTER_ASPECT_MISMATCH',
    }))
  })

  it('rejects a mismatched actual bake channel before it enters store state', () => {
    const raster = { width: 1600, height: 1600 } as HTMLCanvasElement

    expect(() => useLabelStore.getState().setBake('bad-raster', {
      color: raster,
      metalness: raster,
      roughness: raster,
      bump: raster,
      spec: { width: 1600, height: 2400, aspect: 2 / 3 },
      version: 1,
    })).toThrow(expect.objectContaining({
      name: 'RasterAspectError', code: 'RASTER_ASPECT_MISMATCH',
    }))
    expect(useLabelStore.getState().bakeMap['bad-raster']).toBeUndefined()
  })

  it.each([
    ['top_left', { x: 0, y: 0 }, { x: 200, y: 100, width: 100, height: 40 }],
    ['top_center', { x: -50, y: 0 }, { x: 150, y: 100, width: 100, height: 40 }],
    ['center', { x: -50, y: -20 }, { x: 150, y: 80, width: 100, height: 40 }],
    ['baseline_left', { x: 0, y: -30 }, { x: 200, y: 70, width: 100, height: 40 }],
    ['baseline_center', { x: -50, y: -30 }, { x: 150, y: 70, width: 100, height: 40 }],
  ] as const)('keeps the %s anchor as the render transform origin', (anchor, box, worldBounds) => {
    const resolve = (craft as typeof craft & {
      resolveLayerRenderTransform?: (input: {
        x: number
        y: number
        rotation: number
        width: number
        height: number
        anchor: string
        baselineFromTop?: number
      }) => { box: { x: number; y: number }; worldBounds: { x: number; y: number; width: number; height: number } }
    }).resolveLayerRenderTransform

    expect(resolve).toBeTypeOf('function')
    expect(resolve?.({ x: 200, y: 100, rotation: 0, width: 100, height: 40, anchor, baselineFromTop: 30 })).toMatchObject({
      box,
      worldBounds,
    })
  })

  it('rotates top-left content around the declared anchor instead of its center', () => {
    const resolve = (craft as typeof craft & {
      resolveLayerRenderTransform?: (input: {
        x: number
        y: number
        rotation: number
        width: number
        height: number
        anchor: string
      }) => { origin: { x: number; y: number }; worldBounds: { x: number; y: number; width: number; height: number } }
    }).resolveLayerRenderTransform

    const result = resolve?.({ x: 10, y: 20, rotation: 90, width: 100, height: 40, anchor: 'top_left' })
    expect(result?.origin).toEqual({ x: 10, y: 20 })
    expect(result?.worldBounds.x).toBeCloseTo(-30, 12)
    expect(result?.worldBounds.y).toBeCloseTo(20, 12)
    expect(result?.worldBounds.width).toBeCloseTo(40, 12)
    expect(result?.worldBounds.height).toBeCloseTo(100, 12)
  })

  it.each([[1024, 1536], [2048, 3072], [4096, 6144]])(
    'derives pixels from immutable millimetres at bake %ix%i',
    (width, height) => {
      const area = applyStructuredLabelSpec(physicalBaseArea(width, height), physicalSpec()).areas[0]
      const title = area.layers[0]
      const frame = area.layers[1]

      expect(title).toMatchObject({ x: width * 0.125, y: height * (8 / 60), width: width * 0.75 })
      expect(title.kind === 'text' && title.fontSize).toBe(height * (4 / 60))
      expect(title.kind === 'text' && title.letterSpacing).toBeCloseTo(height * (4 / 60) * 0.08, 10)
      expect(frame).toMatchObject({ x: width / 2, y: height / 2, width: width * 0.9, height: height * 0.9 })
      expect(frame.kind === 'shape' && frame.strokeWidth).toBe(height * (0.25 / 60))
      expect(frame.kind === 'shape' && frame.cornerRadius).toBe(height * (1.5 / 60))
      expect(title.designMetrics).toEqual(physicalSpec().areas[0].layers[0].designMetrics)
      expect(frame.designMetrics).toEqual(physicalSpec().areas[0].layers[1].designMetrics)
    },
  )

  it('preserves physical source metadata byte-for-byte through repeated rebakes and project serialization', () => {
    const area = applyStructuredLabelSpec(physicalBaseArea(1024, 1536), physicalSpec()).areas[0]
    useLabelStore.getState().clearAll()
    useLabelStore.getState().addArea(area)
    const sourceBefore = JSON.stringify({
      artboard: area.artboard, placementPolicy: area.placementPolicy, designBinding: area.designBinding,
      layers: area.layers.map((layer) => ({ designMetrics: layer.designMetrics, processes: layer.processes })),
    })

    useLabelStore.getState().setAreaBakeSize(area.id, 4096, 6144)
    useLabelStore.getState().setAreaBakeSize(area.id, 2048, 3072)
    const rebaked = useLabelStore.getState().areas[0]
    const serialized = serializeLabelProject('bottle.glb', [rebaked]).areas[0]
    const sourceAfter = JSON.stringify({
      artboard: serialized.artboard, placementPolicy: serialized.placementPolicy, designBinding: serialized.designBinding,
      layers: serialized.layers.map((layer) => ({ designMetrics: layer.designMetrics, processes: layer.processes })),
    })

    expect(rebaked.canvas).toEqual({ width: 2048, height: 3072, aspect: 2 / 3 })
    expect(rebaked.layers[0]).toMatchObject({ x: 256, y: 409.6, width: 1536 })
    expect(sourceAfter).toBe(sourceBefore)
    useLabelStore.getState().clearAll()
  })

  it('scales every legacy pixel field proportionally through a 1024 to 4096 to 2048 rebake cycle', () => {
    const area = physicalBaseArea(1024, 1536)
    area.layers = [{
      id: 'legacy-text', kind: 'text', text: 'Legacy', fontFamily: 'Arial', fontSize: 48, fontWeight: 400,
      letterSpacing: 2, lineHeight: 1.2, width: 400, color: '#111111', align: 'left', italic: false,
      x: 200, y: 300, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0,
      craft: [{ type: 'stroke', params: { strokeColor: '#ffffff', strokeWidth: 3 } }],
    }, {
      id: 'legacy-image', kind: 'image', src: 'data:image/png;base64,AA==', naturalWidth: 80, naturalHeight: 40,
      width: 160, height: 80, x: 500, y: 700, rotation: 0, opacity: 1,
      visible: true, locked: false, zIndex: 1, craft: [],
    }, {
      id: 'legacy-shape', kind: 'shape', shape: 'rectangle', geometry: {}, width: 300, height: 120,
      fill: '#000000', stroke: '#ffffff', strokeWidth: 4, cornerRadius: 12,
      x: 600, y: 900, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 2, craft: [],
    }]
    useLabelStore.getState().clearAll()
    useLabelStore.getState().addArea(area)

    useLabelStore.getState().setAreaBakeSize(area.id, 4096, 6144)
    useLabelStore.getState().setAreaBakeSize(area.id, 2048, 3072)
    const [text, image, shape] = useLabelStore.getState().areas[0].layers

    expect(text).toMatchObject({ x: 400, y: 600, width: 800, fontSize: 96, letterSpacing: 4 })
    expect(text.craft).toEqual([{ type: 'stroke', params: { strokeColor: '#ffffff', strokeWidth: 6 } }])
    expect(image).toMatchObject({ x: 1000, y: 1400, width: 320, height: 160 })
    expect(shape).toMatchObject({ x: 1200, y: 1800, width: 600, height: 240, strokeWidth: 8, cornerRadius: 24 })
    useLabelStore.getState().clearAll()
  })

  it('scales pixel-derived fields when design metadata declares wrapping but no physical coordinate source', () => {
    const area = physicalBaseArea(1024, 1536)
    area.artboard = { widthMm: 40, heightMm: 60, background: 'transparent' }
    area.layers = [{
      id: 'hybrid-text', kind: 'text', text: 'Legacy coordinates', fontFamily: 'Arial', fontSize: 48,
      fontWeight: 400, letterSpacing: 2, lineHeight: 1.2, width: 400, color: '#111111', align: 'left', italic: false,
      x: 200, y: 300, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
      designMetrics: { anchor: 'top_left', wrapPolicy: 'word', maxLines: 2 },
    }]
    useLabelStore.getState().clearAll()
    useLabelStore.getState().addArea(area)

    useLabelStore.getState().setAreaBakeSize(area.id, 2048, 3072)

    expect(useLabelStore.getState().areas[0].layers[0]).toMatchObject({
      x: 400, y: 600, width: 800, fontSize: 96, letterSpacing: 4,
      designMetrics: { anchor: 'top_left', wrapPolicy: 'word', maxLines: 2 },
    })
    useLabelStore.getState().clearAll()
  })

  it('rejects a blocked target-aspect mismatch instead of applying stretched proxies', () => {
    const spec = physicalSpec()
    spec.areas[0].placementPolicy = 'block'
    const squareBase = { ...physicalBaseArea(2048, 2048), canvas: { width: 2048, height: 2048, aspect: 1 } }

    expect(() => applyStructuredLabelSpec(squareBase, spec)).toThrow(/TARGET_ASPECT_MISMATCH/)
  })

  it('keeps legacy pixel-only label specs on the existing coordinate path', () => {
    const legacy = physicalSpec()
    delete (legacy.areas[0] as { artboard?: unknown }).artboard
    delete (legacy.areas[0] as { placementPolicy?: unknown }).placementPolicy
    legacy.areas[0].layers[0].x = 0.25
    legacy.areas[0].layers[0].y = 0.75
    delete (legacy.areas[0].layers[0] as { designMetrics?: unknown }).designMetrics

    const title = applyStructuredLabelSpec(physicalBaseArea(1000, 500), legacy).areas[0].layers[0]

    expect(title).toMatchObject({ x: 250, y: 375, width: 750 })
    expect(title.kind === 'text' && title.fontSize).toBe(64)
  })
})

class TestCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  private pixels = new Uint8ClampedArray()

  constructor(private readonly canvas: TestCanvas) {}

  fillRect(): void {
    const [r, g, b] = colorChannels(String(this.fillStyle))
    this.pixels = new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4)
    for (let i = 0; i < this.pixels.length; i += 4) {
      this.pixels[i] = r
      this.pixels[i + 1] = g
      this.pixels[i + 2] = b
      this.pixels[i + 3] = 255
    }
  }

  getImageData(): ImageData {
    return { data: this.pixels, width: this.canvas.width, height: this.canvas.height, colorSpace: 'srgb' } as ImageData
  }

  putImageData(image: ImageData): void {
    this.pixels = new Uint8ClampedArray(image.data)
  }
}

class TestCanvas {
  width = 0
  height = 0
  private readonly context = new TestCanvasContext(this)

  getContext(kind: string): TestCanvasContext | null {
    return kind === '2d' ? this.context : null
  }
}

function colorChannels(value: string): [number, number, number] {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value)
  if (short) return short.slice(1).map((v) => Number.parseInt(v + v, 16)) as [number, number, number]
  const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (full) return full.slice(1).map((v) => Number.parseInt(v, 16)) as [number, number, number]
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/i.exec(value)
  if (rgb) return rgb.slice(1).map((v) => Number.parseInt(v, 10)) as [number, number, number]
  throw new Error(`Unsupported test color: ${value}`)
}

function makeShape(overrides: Partial<ShapeLayer> & { shape?: ShapeKind; geometry?: ShapeGeometry } = {}): ShapeLayer {
  return {
    id: 'shape', kind: 'shape', shape: 'rectangle', geometry: {}, width: 120, height: 80,
    fill: '#111111', stroke: '#eeeeee', strokeWidth: 4, cornerRadius: 0,
    x: 300, y: 180, rotation: 15, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
    ...overrides,
  }
}

type PathCall = [operation: string, ...values: unknown[]]

class RecordingShapeContext {
  readonly pathCalls: PathCall[] = []
  readonly paintCalls: string[] = []
  fillStyle = ''
  strokeStyle = ''
  lineWidth = 0

  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  beginPath(): void {}
  setLineDash(values: number[]): void { this.paintCalls.push(`dash:${values.join(',')}`) }
  moveTo(...values: [number, number]): void { this.pathCalls.push(['moveTo', ...values]) }
  lineTo(...values: [number, number]): void { this.pathCalls.push(['lineTo', ...values]) }
  bezierCurveTo(...values: [number, number, number, number, number, number]): void { this.pathCalls.push(['bezierCurveTo', ...values]) }
  arc(...values: [number, number, number, number, number, boolean?]): void { this.pathCalls.push(['arc', ...values]) }
  closePath(): void { this.pathCalls.push(['closePath']) }
  fill(): void { this.paintCalls.push('fill') }
  stroke(): void { this.paintCalls.push('stroke') }
  fillStrokeShape(): void { this.paintCalls.push('fillStrokeShape') }
  strokeShape(): void { this.paintCalls.push('strokeShape') }
}

type ShapeDrawingApi = {
  drawShapePreview?: (context: RecordingShapeContext, layer: ShapeLayer, node: object) => void
  drawShapeMask?: (context: CanvasRenderingContext2D, layer: ShapeLayer, gray: number, mode: craft.MaskDrawMode) => void
  genericShapePaintProps?: (layer: ShapeLayer, foil: ShapeLayer['craft'][number] | undefined) => {
    fill: string
    stroke: string
    fillPriority: 'color' | 'linear-gradient'
    fillLinearGradientStartPoint?: { x: number; y: number }
    fillLinearGradientEndPoint?: { x: number; y: number }
    fillLinearGradientColorStops: Array<number | string>
    strokeLinearGradientStartPoint?: { x: number; y: number }
    strokeLinearGradientEndPoint?: { x: number; y: number }
    strokeLinearGradientColorStops?: Array<number | string>
  }
}

function drawRecordedShape(layer: ShapeLayer, mode: craft.MaskDrawMode = 'fill'): { preview: RecordingShapeContext; mask: RecordingShapeContext } {
  const api = craft as unknown as ShapeDrawingApi
  expect(api.drawShapePreview).toBeTypeOf('function')
  expect(api.drawShapeMask).toBeTypeOf('function')
  const preview = new RecordingShapeContext()
  const mask = new RecordingShapeContext()
  api.drawShapePreview?.(preview, layer, {})
  api.drawShapeMask?.(mask as unknown as CanvasRenderingContext2D, layer, 192, mode)
  return { preview, mask }
}

function closedSubpathAreas(calls: PathCall[]): number[] {
  const paths: Array<Array<[number, number]>> = []
  let points: Array<[number, number]> = []
  for (const [operation, x, y] of calls) {
    if (operation === 'moveTo') points = [[x as number, y as number]]
    else if (operation === 'lineTo') points.push([x as number, y as number])
    else if (operation === 'closePath') { paths.push(points); points = [] }
  }
  return paths.map((path) => path.reduce((area, [x, y], index) => {
    const [nextX, nextY] = path[(index + 1) % path.length]
    return area + x * nextY - nextX * y
  }, 0) / 2)
}

describe('形状预览与工艺遮罩保真', () => {
  const foil = { type: 'foil', params: { foilColor: 'gold', gradientAngle: 0, highlight: 0 } } as const

  it.each<ShapeKind>(['star', 'ellipse'])('%s foil fill uses centered local gradient coordinates', (shape) => {
    const paintProps = (craft as unknown as ShapeDrawingApi).genericShapePaintProps
    expect(paintProps).toBeTypeOf('function')

    const props = paintProps?.(makeShape({ shape }), foil)
    expect(props).toMatchObject({
      fill: '#111111',
      stroke: '#eeeeee',
      fillPriority: 'linear-gradient',
      fillLinearGradientStartPoint: { x: -60, y: 0 },
      fillLinearGradientEndPoint: { x: 60, y: 0 },
    })
    expect(props?.fillLinearGradientColorStops.length).toBeGreaterThan(4)
    expect(props?.strokeLinearGradientColorStops).toBeUndefined()
  })

  it.each([
    ['single line', {}],
    ['parallel line', { parallel: true, gap: 12 }],
  ] satisfies Array<[string, ShapeGeometry]>)('%s foil routes the centered gradient to stroke paint', (_label, geometry) => {
    const paintProps = (craft as unknown as ShapeDrawingApi).genericShapePaintProps
    expect(paintProps).toBeTypeOf('function')

    const props = paintProps?.(makeShape({ shape: 'line', geometry }), foil)
    expect(props).toMatchObject({
      fill: '#111111',
      stroke: '#eeeeee',
      fillPriority: 'color',
      fillLinearGradientColorStops: [],
      strokeLinearGradientStartPoint: { x: -60, y: 0 },
      strokeLinearGradientEndPoint: { x: 60, y: 0 },
    })
    expect(props?.strokeLinearGradientColorStops?.length).toBeGreaterThan(4)
    expect(props?.fillLinearGradientStartPoint).toBeUndefined()
  })

  it.each<ShapeKind>(['star', 'ellipse', 'line'])('%s without foil retains normal fill and stroke colors', (shape) => {
    const paintProps = (craft as unknown as ShapeDrawingApi).genericShapePaintProps
    expect(paintProps).toBeTypeOf('function')

    expect(paintProps?.(makeShape({ shape }), undefined)).toEqual({
      fill: '#111111',
      stroke: '#eeeeee',
      fillPriority: 'color',
      fillLinearGradientColorStops: [],
    })
  })

  it.each([
    ['star', { points: 7, innerRatio: 0.42 }],
    ['wave', { amplitude: 22, frequency: 2.5 }],
    ['frame', { inset: 12 }],
    ['dot-grid', { rows: 2, columns: 3, gap: 24 }],
    ['line', { parallel: true, gap: 10 }],
  ] satisfies Array<[ShapeKind, ShapeGeometry]>)('%s preview and fill mask replay the identical parameterized path', (shape, geometry) => {
    const { preview, mask } = drawRecordedShape(makeShape({ shape, geometry }))

    expect(preview.pathCalls.length).toBeGreaterThan(1)
    expect(mask.pathCalls).toEqual(preview.pathCalls)
  })

  it.each<ShapeKind>(['line', 'wave', 'bracket'])('%s remains an open stroke in preview and fill-mask mode', (shape) => {
    const geometry = shape === 'line' ? { parallel: true, gap: 10 } : shape === 'wave' ? { amplitude: 18, frequency: 2 } : { inset: 20 }
    const { preview, mask } = drawRecordedShape(makeShape({ shape, geometry }))

    expect(preview.pathCalls.some(([operation]) => operation === 'closePath')).toBe(false)
    expect(preview.paintCalls).toContain('strokeShape')
    expect(preview.paintCalls).not.toContain('fillStrokeShape')
    expect(mask.paintCalls).toContain('stroke')
    expect(mask.paintCalls).not.toContain('fill')
  })

  it('parallel line keeps two independent subpaths instead of fill-closing a quadrilateral', () => {
    const { mask } = drawRecordedShape(makeShape({ shape: 'line', geometry: { parallel: true, gap: 12 } }))

    expect(mask.pathCalls.filter(([operation]) => operation === 'moveTo')).toHaveLength(2)
    expect(mask.pathCalls.filter(([operation]) => operation === 'lineTo')).toHaveLength(2)
    expect(mask.pathCalls.filter(([operation]) => operation === 'closePath')).toHaveLength(0)
    expect(mask.paintCalls).toContain('stroke')
  })

  it('frame fill preserves an oppositely wound inner contour so its center stays hollow', () => {
    const { preview, mask } = drawRecordedShape(makeShape({ shape: 'frame', geometry: { inset: 12 } }))
    const [outerArea, innerArea] = closedSubpathAreas(mask.pathCalls)

    expect(mask.pathCalls.filter(([operation]) => operation === 'closePath')).toHaveLength(2)
    expect(Math.sign(outerArea)).toBe(-Math.sign(innerArea))
    expect(preview.paintCalls).toContain('fillStrokeShape')
    expect(mask.paintCalls).toContain('fill')
  })

  it('dot-grid fill keeps every dot as its own closed full circle', () => {
    const { mask } = drawRecordedShape(makeShape({ shape: 'dot-grid', geometry: { rows: 2, columns: 3, gap: 24 } }))
    const arcs = mask.pathCalls.filter(([operation]) => operation === 'arc')

    expect(arcs).toHaveLength(6)
    expect(arcs.every(([, , , , start, end]) => start === 0 && end === Math.PI * 2)).toBe(true)
    expect(mask.pathCalls.filter(([operation]) => operation === 'closePath')).toHaveLength(6)
    expect(mask.paintCalls).toContain('fill')
  })
})

describe('3D 渲染细节保真', () => {
  const originalDocument = globalThis.document

  beforeEach(() => {
    globalThis.document = { createElement: () => new TestCanvas() } as unknown as Document
  })

  afterEach(() => {
    globalThis.document = originalDocument
  })

  it('无金属工艺的标签底纸应为非金属，而不是整面金属', () => {
    const masks = renderMasks(2, 2, () => undefined, [], [])
    const metalness = masks.metalness.getContext('2d')!.getImageData(0, 0, 1, 1).data

    expect(Array.from(metalness.slice(0, 3))).toEqual([0, 0, 0])
  })

  it('全局磨砂应为整面粗糙度生成确定性的微表面凹凸，而不是留下中性 bump', () => {
    const masks = renderMasks(16, 16, () => undefined, [], [{
      type: 'matte', params: { intensity: 0.32, noise: 0.08 },
    }])
    const roughness = masks.roughness.getContext('2d')!.getImageData(0, 0, 16, 16).data
    const bump = masks.bump.getContext('2d')!.getImageData(0, 0, 16, 16).data
    const roughnessTones = Array.from({ length: 16 * 16 }, (_, pixel) => roughness[pixel * 4])
    const bumpTones = Array.from({ length: 16 * 16 }, (_, pixel) => bump[pixel * 4])

    expect(roughnessTones.some((tone) => tone !== 255)).toBe(true)
    expect(bumpTones.some((tone) => tone !== 128)).toBe(true)
    expect(bumpTones.some((tone) => tone === 128)).toBe(true)
  })

  it('无全局磨砂时应保持平面中性 bump', () => {
    const masks = renderMasks(4, 4, () => undefined, [], [])
    const bump = masks.bump.getContext('2d')!.getImageData(0, 0, 4, 4).data
    const bumpTones = Array.from({ length: 4 * 4 }, (_, pixel) => bump[pixel * 4])

    expect(new Set(bumpTones)).toEqual(new Set([128]))
  })

  it('PBR 场景应安装图像环境光以显示金属、玻璃与清漆细节', () => {
    const install = (sceneController as typeof sceneController & {
      installStudioEnvironment?: (scene: THREE.Scene, texture: THREE.Texture, intensity?: number) => void
    }).installStudioEnvironment
    const scene = new THREE.Scene()
    const texture = new THREE.Texture()

    expect(install).toBeTypeOf('function')
    install?.(scene, texture, 1.15)
    expect(scene.environment).toBe(texture)
    expect(scene.environmentIntensity).toBe(1.15)
  })

  it('贴标材质接管 UV 后应移除失效的原始法线贴图', () => {
    const configure = (sceneController as typeof sceneController & {
      configureLabelMaterial?: (
        material: THREE.MeshStandardMaterial,
        textures: { color: THREE.Texture; metal: THREE.Texture; rough: THREE.Texture; bump: THREE.Texture },
      ) => void
    }).configureLabelMaterial
    const material = new THREE.MeshStandardMaterial()
    const originalNormal = new THREE.Texture()
    const textures = {
      color: new THREE.Texture(),
      metal: new THREE.Texture(),
      rough: new THREE.Texture(),
      bump: new THREE.Texture(),
    }
    material.normalMap = originalNormal

    expect(configure).toBeTypeOf('function')
    configure?.(material, textures)
    expect(material.normalMap).toBeNull()
    expect(material.map).toBe(textures.color)
    expect(material.metalnessMap).toBe(textures.metal)
    expect(material.roughnessMap).toBe(textures.rough)
    expect(material.bumpMap).toBe(textures.bump)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(true)
    expect(material.alphaTest).toBeGreaterThan(0)
    expect(material.polygonOffset).toBe(true)
    expect(material.polygonOffsetFactor).toBeLessThan(0)
    expect(material.polygonOffsetUnits).toBeLessThan(0)
    expect(material.bumpScale).toBeGreaterThanOrEqual(0.06)
  })

  it('烘焙颜色贴图时应排除参考图、选框与定位辅助层，并在完成后恢复编辑视图', () => {
    const capture = (labelCanvas as typeof labelCanvas & {
      captureDesignCanvas?: (stage: {
        find: (selector: string) => Array<{ visible: { (): boolean; (value: boolean): unknown } }>
        draw: () => void
        toCanvas: (options: { pixelRatio: number }) => HTMLCanvasElement
      }, pixelRatio: number) => HTMLCanvasElement
    }).captureDesignCanvas
    let guideVisible = true
    let transformerVisible = true
    let reliefShadowEnabled = true
    const nodes = [
      { visible: (value?: boolean) => value === undefined ? guideVisible : (guideVisible = value) },
      { visible: (value?: boolean) => value === undefined ? transformerVisible : (transformerVisible = value) },
    ]
    const reliefNodes = [
      { shadowEnabled: (value?: boolean) => value === undefined ? reliefShadowEnabled : (reliefShadowEnabled = value) },
    ]
    const output = {} as HTMLCanvasElement
    const stage = {
      find: (selector: string) => selector === '.non-export' ? nodes : selector === '.craft-relief' ? reliefNodes : [],
      draw: () => undefined,
      toCanvas: ({ pixelRatio }: { pixelRatio: number }) => {
        expect(pixelRatio).toBe(4)
        expect(guideVisible).toBe(false)
        expect(transformerVisible).toBe(false)
        expect(reliefShadowEnabled).toBe(false)
        return output
      },
    }

    expect(capture).toBeTypeOf('function')
    expect(capture?.(stage, 4)).toBe(output)
    expect(guideVisible).toBe(true)
    expect(transformerVisible).toBe(true)
    expect(reliefShadowEnabled).toBe(true)
  })

  it('GLB 导出的贴标材质应保留 PNG 透明背景', () => {
    const configure = (labelTextures as typeof labelTextures & {
      configureTransparentLabelExport?: (material: ReturnType<GltfDocument['createMaterial']>) => void
    }).configureTransparentLabelExport
    const material = new GltfDocument().createMaterial()

    expect(configure).toBeTypeOf('function')
    configure?.(material)
    expect(material.getAlphaMode()).toBe('BLEND')
  })

  it('GLB 分析管线应保留纹理变换与清漆扩展', async () => {
    const doc = await readGlb(new Uint8Array(readFileSync(SAMPLE)))
    const extensions = doc.getRoot().listExtensionsUsed().map((extension) => extension.extensionName)

    expect(extensions).toEqual(expect.arrayContaining(['KHR_texture_transform', 'KHR_materials_clearcoat']))
  })
})
