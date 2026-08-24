import { describe, expect, it } from 'vitest'
import { createLayerFromPreset, ELEMENT_PRESETS } from '../src/label/elementPresets'
import { shapeCommands } from '../src/label/shapeGeometry'
import type { LabelAreaConfig, ShapeKind, ShapeLayer } from '../src/label/types'

const KNOWN_SHAPES = new Set<ShapeKind>([
  'rectangle', 'ellipse', 'triangle', 'diamond', 'polygon', 'star', 'line',
  'wave', 'burst', 'cross', 'bracket', 'dot-grid', 'frame',
])

function makeArea(): LabelAreaConfig {
  return {
    id: 'area-1',
    name: 'Front',
    meshIndex: 0,
    nodeName: 'Bottle',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1,
      wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 1200, height: 800, aspect: 1.5 },
    layers: [{
      id: 'existing', kind: 'shape', shape: 'rectangle', geometry: {}, width: 100, height: 50,
      fill: '#000000', stroke: '#000000', strokeWidth: 0, cornerRadius: 0,
      x: 100, y: 100, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 7.8, craft: [],
    }],
    globalCraft: { craft: [] },
    fonts: [],
    referenceVisible: false,
    undoStack: [],
    redoStack: [],
  }
}

describe('element presets', () => {
  it('contains every first-release entry in its specified category', () => {
    const names = (category: (typeof ELEMENT_PRESETS)[number]['category']) => ELEMENT_PRESETS
      .filter((preset) => preset.category === category)
      .map((preset) => preset.name)

    expect(names('text')).toEqual(['标题文字', '正文文字', '竖排文字'])
    expect(names('basic')).toEqual(['矩形', '圆角矩形', '圆形', '椭圆', '三角形', '菱形', '多边形', '星形'])
    expect(names('line')).toEqual(['直线', '虚线', '双线', '箭头', '波浪线', '弧线'])
    expect(names('label')).toEqual(['胶囊框', '圆形徽章', '方形徽章', '爆炸贴', '价格签', '角标'])
    expect(names('decoration')).toEqual(['十字', '括号', '分割符', '圆点阵列', '放射线', '边角装饰'])
    expect(names('container')).toEqual(['外边框', '内容底板', '色块区域'])
    expect(ELEMENT_PRESETS).toHaveLength(32)
  })

  it('creates serializable, centered, editable native layers with unique ids and safe stacking', () => {
    const area = makeArea()
    const ids = new Set<string>()

    for (const preset of ELEMENT_PRESETS) {
      const first = createLayerFromPreset(preset.id, area)
      const second = createLayerFromPreset(preset.id, area)

      expect(['text', 'shape']).toContain(first.kind)
      expect(first).toMatchObject({ x: 600, y: 400, visible: true, locked: false, zIndex: 8, craft: [] })
      expect(first.id).not.toBe(second.id)
      expect(ids.has(first.id)).toBe(false)
      expect(() => JSON.parse(JSON.stringify(first))).not.toThrow()
      expect(JSON.stringify(first)).not.toContain('presetId')
      expect(JSON.stringify(first)).not.toContain('presetName')
      if (first.kind === 'shape') expect(KNOWN_SHAPES.has(first.shape)).toBe(true)
      ids.add(first.id)
    }
  })

  it('keeps vertical text as one editable text layer instead of simulated rotated characters', () => {
    const vertical = createLayerFromPreset('text-vertical', makeArea())

    expect(vertical).toMatchObject({ kind: 'text', direction: 'vertical', rotation: 0 })
    expect(vertical.kind === 'text' && vertical.text).toBe('竖排文字')
  })

  it('creates text presets with an editable text box width inside the label canvas', () => {
    const title = createLayerFromPreset('text-title', makeArea())
    const body = createLayerFromPreset('text-body', makeArea())

    expect(title).toMatchObject({ kind: 'text', width: 420 })
    expect(body).toMatchObject({ kind: 'text', width: 520 })
  })

  it('deep-clones dashed geometry across created layers and the preset definition', () => {
    const preset = ELEMENT_PRESETS.find((candidate) => candidate.id === 'line-dashed')
    const first = createLayerFromPreset('line-dashed', makeArea()) as ShapeLayer
    const second = createLayerFromPreset('line-dashed', makeArea()) as ShapeLayer

    expect(preset?.factoryPatch.kind).toBe('shape')
    expect(first.geometry?.dash).toEqual([18, 12])
    expect(second.geometry?.dash).toEqual([18, 12])
    expect(first.geometry?.dash).not.toBe(second.geometry?.dash)

    first.geometry?.dash?.push(99)

    expect(second.geometry?.dash).toEqual([18, 12])
    if (preset?.factoryPatch.kind === 'shape') expect(preset.factoryPatch.values.geometry?.dash).toEqual([18, 12])
    expect((createLayerFromPreset('line-dashed', makeArea()) as ShapeLayer).geometry?.dash).toEqual([18, 12])
  })

  it('creates 双线 as exactly two independent open line subpaths', () => {
    const layer = createLayerFromPreset('line-double', makeArea()) as ShapeLayer

    expect(layer).toMatchObject({ kind: 'shape', shape: 'line', geometry: { parallel: true, gap: 8 } })
    expect(shapeCommands(layer)).toEqual([
      { type: 'moveTo', x: -160, y: -4 },
      { type: 'lineTo', x: 160, y: -4 },
      { type: 'moveTo', x: -160, y: 4 },
      { type: 'lineTo', x: 160, y: 4 },
    ])
  })

  it('chooses a deterministic unused safe z-index when existing stacking is saturated or invalid', () => {
    const area = makeArea()
    area.layers = [
      { ...area.layers[0], id: 'max', zIndex: Number.MAX_SAFE_INTEGER },
      { ...area.layers[0], id: 'max-minus-one', zIndex: Number.MAX_SAFE_INTEGER - 1 },
      { ...area.layers[0], id: 'invalid-huge', zIndex: 1e308 },
    ]

    const first = createLayerFromPreset('text-title', area)
    const second = createLayerFromPreset('text-title', area)

    expect(first.zIndex).toBe(Number.MAX_SAFE_INTEGER - 2)
    expect(second.zIndex).toBe(first.zIndex)
    expect(Number.isSafeInteger(first.zIndex)).toBe(true)
    expect(area.layers.every((layer) => layer.zIndex !== first.zIndex)).toBe(true)
  })

  it('rejects unknown preset ids rather than creating a fallback layer', () => {
    expect(() => createLayerFromPreset('missing-preset', makeArea())).toThrow('未知元素预设')
  })
})
