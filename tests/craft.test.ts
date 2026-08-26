import { afterEach, describe, expect, it } from 'vitest'
import type { ImageLayer, TextLayer } from '../src/label/types'
import * as craft from '../src/label/craft'

const textLayer: TextLayer = {
  id: 'text',
  kind: 'text',
  text: 'AB',
  fontFamily: 'Arial',
  fontSize: 100,
  fontWeight: 700,
  letterSpacing: 0,
  lineHeight: 1.2,
  color: '#111111',
  align: 'center',
  italic: false,
  direction: 'vertical',
  x: 400,
  y: 200,
  rotation: 15,
  opacity: 1,
  visible: true,
  locked: false,
  zIndex: 0,
  craft: [],
}

describe('工艺领域规则', () => {
  it('矩形图层的渲染属性保留尺寸、填色、描边和圆角', () => {
    const shapeProps = (craft as unknown as {
      rectangleRenderProps?: (layer: {
        width: number
        height: number
        fill: string
        stroke: string
        strokeWidth: number
        cornerRadius: number
      }) => unknown
    }).rectangleRenderProps

    expect(shapeProps?.({
      width: 640,
      height: 180,
      fill: '#111111',
      stroke: '#f5f5f5',
      strokeWidth: 4,
      cornerRadius: 12,
    })).toEqual({
      x: -320,
      y: -90,
      width: 640,
      height: 180,
      fill: '#111111',
      stroke: '#f5f5f5',
      strokeWidth: 4,
      cornerRadius: 12,
    })
  })

  it('全局工艺只开放整面有物理意义的磨砂与 UV', () => {
    expect(craft.craftTypesForScope?.('global')).toEqual(['matte', 'uv'])
    expect(craft.craftTypesForScope?.('layer')).toEqual(['foil', 'emboss', 'deboss', 'matte', 'uv', 'stroke'])
  })

  it('工艺参数会生成对应通道贡献，普通描边不会让整个字形金属化', () => {
    const layer = {
      ...textLayer,
      craft: [
        { type: 'foil', params: { foilColor: 'gold' } },
        { type: 'stroke', params: { strokeColor: '#f00', strokeWidth: 4 } },
        { type: 'emboss', params: { depth: 0.2 } },
        { type: 'uv', params: { gloss: 0.75 } },
      ],
    } satisfies TextLayer

    expect(craft.layerMaskContributions?.(layer)).toEqual([
      { channel: 'metalness', tone: 255, mode: 'fill' },
      { channel: 'roughness', tone: 32, mode: 'fill' },
      { channel: 'bump', tone: 192, mode: 'fill' },
    ])
  })

  it('烫金在没有叠加亮油时同时生成高金属与低粗糙度通道', () => {
    const layer = {
      ...textLayer,
      craft: [{ type: 'foil', params: { foilColor: 'gold' } }],
    } satisfies TextLayer

    expect(craft.layerMaskContributions?.(layer)).toEqual([
      { channel: 'metalness', tone: 255, mode: 'fill' },
      { channel: 'roughness', tone: 42, mode: 'fill' },
    ])
  })

  it('工艺描边统一覆盖形状自身描边，并保留无工艺时的原始外观', () => {
    const paint = (craft as unknown as {
      craftStrokePaint?: (layer: {
        stroke?: string
        strokeWidth?: number
        craft: TextLayer['craft']
      }) => { stroke?: string; strokeWidth: number }
    }).craftStrokePaint

    expect(paint).toBeTypeOf('function')
    expect(paint?.({ stroke: '#aaaaaa', strokeWidth: 2, craft: [{ type: 'stroke', params: { strokeColor: '#123456', strokeWidth: 7 } }] })).toEqual({
      stroke: '#123456',
      strokeWidth: 7,
    })
    expect(paint?.({ stroke: '#aaaaaa', strokeWidth: 2, craft: [] })).toEqual({ stroke: '#aaaaaa', strokeWidth: 2 })
  })

  it('磨砂为粗糙度与微表面提供细颗粒变化，而不是只污染颜色通道', () => {
    const tones = (craft as unknown as {
      matteSurfaceTones?: (pixel: number, intensity: number, density: number) => { roughness: number; bump: number }
    }).matteSurfaceTones

    expect(tones).toBeTypeOf('function')
    const first = tones?.(0, 0.8, 1)
    const second = tones?.(1, 0.8, 1)
    expect(first).not.toEqual(second)
    expect(first?.roughness).toBeGreaterThanOrEqual(210)
    expect(first?.roughness).toBeLessThanOrEqual(255)
    expect(first?.bump).toBeGreaterThanOrEqual(116)
    expect(first?.bump).toBeLessThanOrEqual(140)
  })

  it('磨砂、UV 与凹凸等表面工艺不直接改写标签基础颜色', () => {
    const apply = (craft as unknown as {
      applyPhysicalColorSurface?: (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        effects: TextLayer['craft'],
      ) => void
    }).applyPhysicalColorSurface
    const operations: string[] = []
    const context = new Proxy({}, {
      get: (_target, property) => typeof property === 'string' ? (..._args: unknown[]) => operations.push(property) : undefined,
      set: (_target, property) => { operations.push(`set:${String(property)}`); return true },
    }) as CanvasRenderingContext2D

    expect(apply).toBeTypeOf('function')
    apply?.(context, 120, 80, [
      { type: 'matte', params: { intensity: 0.6, noise: 0.7 } },
      { type: 'uv', params: { gloss: 0.8 } },
      { type: 'emboss', params: { depth: 0.1 } },
    ])
    expect(operations).toEqual([])
  })

  it('文字可见图形和遮罩共享同一个中心锚点与竖排旋转', () => {
    const layout = craft.measureTextLayerLayout?.(textLayer, () => 120)
    expect(layout).toMatchObject({ width: 120, height: 120, rotation: 105, lines: ['AB'], overflow: false })
    expect(craft.textLineAnchorX?.('left', 120)).toBe(-60)
    expect(craft.textLineAnchorX?.('center', 120)).toBe(0)
    expect(craft.textLineAnchorX?.('right', 120)).toBe(60)
  })

  it('按文本框宽度对中英文自动换行，并保留用户输入的显式换行', () => {
    const measure = (line: string) => line.length * 10
    const english = craft.measureTextLayerLayout?.({ ...textLayer, direction: 'horizontal', rotation: 0, text: 'A B C', width: 30 }, measure)
    const chinese = craft.measureTextLayerLayout?.({ ...textLayer, direction: 'horizontal', rotation: 0, text: '香水标签设计', width: 30 }, measure)
    const explicit = craft.measureTextLayerLayout?.({ ...textLayer, direction: 'horizontal', rotation: 0, text: 'AB\nCD', width: 30 }, measure)

    expect(english).toMatchObject({ width: 30, height: 240, rotation: 0, lines: ['A B', 'C'], overflow: false })
    expect(chinese).toMatchObject({ width: 30, height: 240, rotation: 0, lines: ['香水标', '签设计'], overflow: false })
    expect(explicit).toMatchObject({ width: 30, height: 240, rotation: 0, lines: ['AB', 'CD'], overflow: false })
  })

  it('按获批的 none、word、character 策略换行，并保留旧图层的自动换行默认值', () => {
    const measure = (line: string) => line.length * 10
    const metrics = (wrapPolicy: 'none' | 'word' | 'character') => ({
      anchor: 'top_left' as const,
      wrapPolicy,
    })

    const none = craft.measureTextLayerLayout({
      ...textLayer,
      direction: 'horizontal',
      text: 'AB CD',
      width: 30,
      designMetrics: metrics('none'),
    }, measure)
    const word = craft.measureTextLayerLayout({
      ...textLayer,
      direction: 'horizontal',
      text: 'AB CD EFGH',
      width: 50,
      designMetrics: metrics('word'),
    }, measure)
    const character = craft.measureTextLayerLayout({
      ...textLayer,
      direction: 'horizontal',
      text: 'ABCDE',
      width: 20,
      designMetrics: metrics('character'),
    }, measure)
    const legacy = craft.measureTextLayerLayout({
      ...textLayer,
      direction: 'horizontal',
      text: 'ABCDE',
      width: 20,
    }, measure)
    const oversizedWord = craft.measureTextLayerLayout({
      ...textLayer,
      direction: 'horizontal',
      text: 'UNBREAKABLE',
      width: 50,
      designMetrics: metrics('word'),
    }, measure)

    expect(none.lines).toEqual(['AB CD'])
    expect(none.overflow).toBe(true)
    expect(word.lines).toEqual(['AB CD', 'EFGH'])
    expect(word.overflow).toBe(false)
    expect(character.lines).toEqual(['AB', 'CD', 'E'])
    expect(character.overflow).toBe(false)
    expect(legacy.lines).toEqual(['AB', 'CD', 'E'])
    expect(oversizedWord.lines).toEqual(['UNBREAKABLE'])
    expect(oversizedWord.overflow).toBe(true)
  })

  it('clips rendering at maxLines, reports hidden copy, and resolves a measured alphabetic baseline', () => {
    const sourceLayer = {
      ...textLayer,
      direction: 'horizontal',
      text: 'A B C D',
      width: 20,
      designMetrics: { anchor: 'baseline_left', wrapPolicy: 'character', maxLines: 2 },
    } satisfies TextLayer
    const layout = craft.measureTextLayerLayout(sourceLayer, (line) => ({
      width: line.length * 10,
      actualBoundingBoxAscent: 72,
      actualBoundingBoxDescent: 18,
    }))

    expect(layout.lines).toEqual(['A ', 'B '])
    expect(layout.totalLineCount).toBe(4)
    expect(layout.hiddenLineCount).toBe(2)
    expect(layout.overflow).toBe(true)
    expect(layout.baselineFromTop).toBe(87)
    expect(sourceLayer.text).toBe('A B C D')
  })

  it('文字烫金明确选择线性渐变作为 Konva 填充源', () => {
    const props = craft.foilFillProps?.({ type: 'foil', params: { foilColor: 'gold', gradientAngle: 60 } }, 240, 100)
    expect(props?.fillPriority).toBe('linear-gradient')
    expect(props?.fillLinearGradientColorStops.length).toBeGreaterThan(4)
  })

  it('烫金高光强度会改变颜色渐变，而不是成为无效参数', () => {
    const low = craft.foilKonvaGradient?.({ type: 'foil', params: { foilColor: 'gold', highlight: 0 } }, 240, 100)
    const high = craft.foilKonvaGradient?.({ type: 'foil', params: { foilColor: 'gold', highlight: 1 } }, 240, 100)
    expect(high?.colorStops).not.toEqual(low?.colorStops)
  })
})

describe('图片遮罩绘制', () => {
  const originalDocument = globalThis.document

  afterEach(() => {
    globalThis.document = originalDocument
  })

  it('图片透明轮廓在 renderMasks 返回前同步绘制', () => {
    const operations: string[] = []
    const tempContext = {
      drawImage: () => operations.push('temp-image'),
      fillRect: () => operations.push('temp-fill'),
      clearRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      set fillStyle(_value: string) {},
      set globalCompositeOperation(_value: string) {},
    }
    globalThis.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => tempContext }),
    } as unknown as Document
    const targetContext = {
      save: () => undefined,
      restore: () => undefined,
      translate: () => undefined,
      rotate: () => undefined,
      drawImage: () => operations.push('target-image'),
    }
    const layer: ImageLayer = {
      id: 'image',
      kind: 'image',
      src: 'blob:test',
      naturalWidth: 40,
      naturalHeight: 20,
      width: 80,
      height: 40,
      x: 100,
      y: 50,
      rotation: 20,
      opacity: 1,
      visible: true,
      locked: false,
      zIndex: 0,
      craft: [],
    }

    const result = craft.drawImageMaskShape?.(
      targetContext as unknown as CanvasRenderingContext2D,
      layer,
      {} as CanvasImageSource,
      255,
    )

    expect(result).toBeUndefined()
    expect(operations).toEqual(['temp-image', 'temp-fill', 'target-image'])
  })

  it('top-left image masks rotate around the declared anchor and draw into positive local extents', () => {
    const transforms: Array<[string, ...number[]]> = []
    const draws: number[][] = []
    const tempContext = {
      drawImage: () => undefined,
      fillRect: () => undefined,
      clearRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      set fillStyle(_value: string) {},
      set globalCompositeOperation(_value: string) {},
    }
    globalThis.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => tempContext }),
    } as unknown as Document
    const targetContext = {
      save: () => undefined,
      restore: () => undefined,
      translate: (x: number, y: number) => transforms.push(['translate', x, y]),
      rotate: (radians: number) => transforms.push(['rotate', radians]),
      drawImage: (_source: CanvasImageSource, ...values: number[]) => draws.push(values),
    }
    const layer: ImageLayer = {
      id: 'anchored-image', kind: 'image', src: 'blob:test', naturalWidth: 40, naturalHeight: 20,
      width: 80, height: 40, x: 100, y: 50, rotation: 20, opacity: 1,
      visible: true, locked: false, zIndex: 0, craft: [],
      designMetrics: { anchor: 'top_left' },
    }

    craft.drawImageMaskShape?.(
      targetContext as unknown as CanvasRenderingContext2D,
      layer,
      {} as CanvasImageSource,
      255,
    )

    expect(transforms).toEqual([
      ['translate', 100, 50],
      ['rotate', 20 * Math.PI / 180],
    ])
    expect(draws).toEqual([[0, 0, 80, 40]])
  })
})
