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

const SAMPLE = new URL('../public/sample/面霜瓶.glb', import.meta.url)

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
