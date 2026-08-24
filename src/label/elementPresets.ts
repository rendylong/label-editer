import type { LabelAreaConfig, LabelLayer, ShapeKind, ShapeLayer, TextLayer } from './types'

export type ElementPresetCategory = 'text' | 'basic' | 'line' | 'label' | 'decoration' | 'container'
export type ElementPresetThumbnailKind = 'text' | ShapeKind

type CommonLayerKeys = 'id' | 'x' | 'y' | 'zIndex' | 'visible' | 'locked' | 'craft'
type TextFactoryPatch = Partial<Omit<TextLayer, CommonLayerKeys | 'kind'>>
type ShapeFactoryPatch = Partial<Omit<ShapeLayer, CommonLayerKeys | 'kind'>>

export type ElementPresetFactoryPatch =
  | { kind: 'text'; values: TextFactoryPatch }
  | { kind: 'shape'; values: ShapeFactoryPatch }

export interface ElementPreset {
  id: string
  name: string
  category: ElementPresetCategory
  thumbnailKind: ElementPresetThumbnailKind
  factoryPatch: ElementPresetFactoryPatch
}

function textPreset(id: string, name: string, values: TextFactoryPatch): ElementPreset {
  return { id, name, category: 'text', thumbnailKind: 'text', factoryPatch: { kind: 'text', values } }
}

function shapePreset(
  id: string,
  name: string,
  category: Exclude<ElementPresetCategory, 'text'>,
  shape: ShapeKind,
  values: ShapeFactoryPatch = {},
): ElementPreset {
  return { id, name, category, thumbnailKind: shape, factoryPatch: { kind: 'shape', values: { ...values, shape } } }
}

export const ELEMENT_PRESETS: ElementPreset[] = [
  textPreset('text-title', '标题文字', { text: '标题文字', width: 420, fontSize: 72, fontWeight: 700, lineHeight: 1.1, align: 'center' }),
  textPreset('text-body', '正文文字', { text: '正文文字', width: 520, fontSize: 32, fontWeight: 400, lineHeight: 1.5, align: 'left' }),
  textPreset('text-vertical', '竖排文字', { text: '竖排文字', width: 300, fontSize: 48, fontWeight: 500, lineHeight: 1.2, align: 'center', direction: 'vertical' }),

  shapePreset('basic-rectangle', '矩形', 'basic', 'rectangle', { width: 260, height: 140 }),
  shapePreset('basic-rounded-rectangle', '圆角矩形', 'basic', 'rectangle', { width: 260, height: 140, cornerRadius: 28 }),
  shapePreset('basic-circle', '圆形', 'basic', 'ellipse', { width: 160, height: 160 }),
  shapePreset('basic-ellipse', '椭圆', 'basic', 'ellipse', { width: 260, height: 140 }),
  shapePreset('basic-triangle', '三角形', 'basic', 'triangle', { width: 200, height: 180 }),
  shapePreset('basic-diamond', '菱形', 'basic', 'diamond', { width: 200, height: 160 }),
  shapePreset('basic-polygon', '多边形', 'basic', 'polygon', { width: 190, height: 190, geometry: { sides: 6 } }),
  shapePreset('basic-star', '星形', 'basic', 'star', { width: 200, height: 200, geometry: { points: 5, innerRatio: 0.45 } }),

  shapePreset('line-solid', '直线', 'line', 'line', { width: 320, height: 32, fill: 'transparent', strokeWidth: 4 }),
  shapePreset('line-dashed', '虚线', 'line', 'line', { width: 320, height: 32, fill: 'transparent', strokeWidth: 4, geometry: { dash: [18, 12] } }),
  shapePreset('line-double', '双线', 'line', 'line', { width: 320, height: 18, fill: 'transparent', strokeWidth: 3, geometry: { parallel: true, gap: 8 } }),
  shapePreset('line-arrow', '箭头', 'line', 'line', { width: 320, height: 48, fill: 'transparent', strokeWidth: 4, geometry: { arrowEnd: true } }),
  shapePreset('line-wave', '波浪线', 'line', 'wave', { width: 320, height: 64, fill: 'transparent', strokeWidth: 4, geometry: { amplitude: 24, frequency: 3 } }),
  shapePreset('line-arc', '弧线', 'line', 'wave', { width: 320, height: 96, fill: 'transparent', strokeWidth: 4, geometry: { amplitude: 48, frequency: 0.5 } }),

  shapePreset('label-capsule', '胶囊框', 'label', 'rectangle', { width: 300, height: 100, fill: 'transparent', strokeWidth: 4, cornerRadius: 50 }),
  shapePreset('label-circle-badge', '圆形徽章', 'label', 'ellipse', { width: 180, height: 180, strokeWidth: 3 }),
  shapePreset('label-square-badge', '方形徽章', 'label', 'rectangle', { width: 180, height: 180, strokeWidth: 3, cornerRadius: 12 }),
  shapePreset('label-burst', '爆炸贴', 'label', 'burst', { width: 220, height: 200, geometry: { points: 14, innerRatio: 0.72 } }),
  shapePreset('label-price-tag', '价格签', 'label', 'polygon', { width: 220, height: 160, geometry: { sides: 5 } }),
  shapePreset('label-corner-badge', '角标', 'label', 'triangle', { width: 180, height: 150 }),

  shapePreset('decoration-cross', '十字', 'decoration', 'cross', { width: 120, height: 120, geometry: { inset: 16 } }),
  shapePreset('decoration-bracket', '括号', 'decoration', 'bracket', { width: 240, height: 140, fill: 'transparent', strokeWidth: 4, geometry: { inset: 32 } }),
  shapePreset('decoration-divider', '分割符', 'decoration', 'line', { width: 180, height: 24, fill: 'transparent', strokeWidth: 3, geometry: { dash: [3, 12] } }),
  shapePreset('decoration-dot-grid', '圆点阵列', 'decoration', 'dot-grid', { width: 220, height: 100, geometry: { rows: 3, columns: 6, gap: 28 } }),
  shapePreset('decoration-rays', '放射线', 'decoration', 'burst', { width: 220, height: 220, fill: 'transparent', strokeWidth: 3, geometry: { points: 20, innerRatio: 0.3 } }),
  shapePreset('decoration-corners', '边角装饰', 'decoration', 'bracket', { width: 260, height: 180, fill: 'transparent', strokeWidth: 3, geometry: { inset: 40 } }),

  shapePreset('container-outer-frame', '外边框', 'container', 'frame', { width: 520, height: 320, fill: 'transparent', strokeWidth: 3, geometry: { inset: 12 } }),
  shapePreset('container-content-panel', '内容底板', 'container', 'rectangle', { width: 480, height: 280, fill: '#f2efe4', strokeWidth: 0, cornerRadius: 16 }),
  shapePreset('container-color-block', '色块区域', 'container', 'rectangle', { width: 520, height: 180, fill: '#111111', strokeWidth: 0 }),
]

let fallbackIdSequence = 0

function createLayerId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `layer-${uuid}`
  fallbackIdSequence += 1
  return `layer-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`
}

function nextZIndex(area: LabelAreaConfig): number {
  const used = new Set<number>()
  let saturated = false
  for (const layer of area.layers) {
    if (!Number.isFinite(layer.zIndex) || Math.abs(layer.zIndex) > Number.MAX_SAFE_INTEGER) {
      saturated = true
      continue
    }
    const normalized = Math.floor(layer.zIndex)
    used.add(normalized)
    if (normalized === Number.MAX_SAFE_INTEGER) saturated = true
  }

  if (!saturated) {
    if (used.size === 0) return 0
    return Math.max(...used) + 1
  }

  // Invalid state may already sort above MAX_SAFE_INTEGER, so no safe result
  // can remain topmost. Choose the highest deterministic unused safe integer.
  let candidate = Number.MAX_SAFE_INTEGER
  while (used.has(candidate)) candidate -= 1
  return candidate
}

function maximumSize(requested: number, canvasSize: number): number {
  return Math.max(1, Math.min(requested, Math.max(1, canvasSize * 0.8)))
}

function cloneGeometry(geometry: ShapeLayer['geometry']): ShapeLayer['geometry'] {
  if (!geometry) return {}
  return {
    ...geometry,
    ...(geometry.dash ? { dash: [...geometry.dash] } : {}),
  }
}

/** Create an independent, editable native layer centered on the active area. */
export function createLayerFromPreset(presetId: string, area: LabelAreaConfig): LabelLayer {
  const preset = ELEMENT_PRESETS.find((candidate) => candidate.id === presetId)
  if (!preset) throw new Error(`未知元素预设：${presetId}`)
  const common = {
    id: createLayerId(),
    x: area.canvas.width / 2,
    y: area.canvas.height / 2,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: nextZIndex(area),
    craft: [],
  }

  if (preset.factoryPatch.kind === 'text') {
    return {
      kind: 'text',
      text: '文字',
      fontFamily: 'noto-sans-sc',
      fontSize: 48,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 1.2,
      color: '#111111',
      align: 'center',
      italic: false,
      direction: 'horizontal',
      ...common,
      ...preset.factoryPatch.values,
      width: maximumSize(preset.factoryPatch.values.width ?? 420, area.canvas.width),
    }
  }

  const values = preset.factoryPatch.values
  return {
    kind: 'shape',
    shape: 'rectangle',
    fill: '#111111',
    stroke: '#111111',
    strokeWidth: 0,
    cornerRadius: 0,
    ...common,
    ...values,
    width: maximumSize(values.width ?? 220, area.canvas.width),
    height: maximumSize(values.height ?? 140, area.canvas.height),
    geometry: cloneGeometry(values.geometry),
  }
}
