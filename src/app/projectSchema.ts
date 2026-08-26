/** Versioned .lbl project serialization and legacy migration boundary. */

import { legacyFontId } from '../label/fontCatalog'
import { resolveLabelPaper } from '../label/paper'
import layoutBlueprintV1Schema from '../agent/layout-blueprint-v1.schema.json'
import type {
  CanvasSpec,
  CarrierMode,
  CraftEffect,
  DesignBinding,
  LabelAreaConfig,
  LabelAreaRange,
  LabelLayer,
  LayerDesignMetrics,
  PhysicalArtboard,
  ProcessIntent,
  RemapParams,
  ShapeKind,
  ShapeLayer,
  SubstrateSpec,
  TargetAspectPolicy,
  TextLayer,
  UploadedFontRecord,
  LabelPrintSpec,
} from '../label/types'

export const PROJECT_VERSION = 3 as const

export interface LabelProjectV3 {
  version: typeof PROJECT_VERSION
  modelFileName: string
  areas: Array<Omit<LabelAreaConfig, 'undoStack' | 'redoStack' | 'referenceUrl'>>
}

type SerializedArea = LabelProjectV3['areas'][number]
type UnknownRecord = Record<string, unknown>

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const CRAFT_TYPES = new Set(['foil', 'emboss', 'deboss', 'matte', 'uv', 'stroke'])
const CARRIER_MODES = new Set<string>(layoutBlueprintV1Schema.$defs.carrier.enum)
const PROCESS_TYPES = new Set<string>(layoutBlueprintV1Schema.$defs.process.properties.process.enum)
const REQUIRED_MASKS = new Set<string>(layoutBlueprintV1Schema.$defs.process.properties.requiredMask.enum)
const SHAPE_KINDS = new Set<string>([
  'rectangle', 'ellipse', 'triangle', 'diamond', 'polygon', 'star', 'line',
  'wave', 'burst', 'cross', 'bracket', 'dot-grid', 'frame', 'path',
])
const SHAPE_GEOMETRY_NUMBER_FIELDS = ['sides', 'points', 'innerRatio', 'amplitude', 'frequency', 'inset', 'rows', 'columns', 'gap'] as const
const SHAPE_GEOMETRY_BOOLEAN_FIELDS = ['arrowStart', 'arrowEnd', 'parallel'] as const

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject inherited-key attacks before any imported value reaches app state. */
function assertSafeValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item)
    return
  }
  if (!isRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (POLLUTION_KEYS.has(key)) throw new Error('非法字段')
    assertSafeValue(nested)
  }
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)])) as T
}

function recordOr<T>(value: unknown, fallback: T): T {
  return isRecord(value) ? cloneValue(value) as T : fallback
}

function areaError(path: string, message: string): never {
  throw new Error(`项目区域无效：${path} ${message}`)
}

function areaRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) areaError(path, '必须是对象')
  return value
}

function areaFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) areaError(path, '必须是有限数字')
  return value
}

function areaVector3(value: unknown, path: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) areaError(path, '必须是 3 个有限数字')
  return value.map((item, index) => areaFiniteNumber(item, `${path}[${index}]`)) as [number, number, number]
}

function assertKnownFields(raw: UnknownRecord, allowed: readonly string[], path: string): void {
  const known = new Set(allowed)
  for (const key of Object.keys(raw)) if (!known.has(key)) areaError(`${path}.${key}`, '是未知字段')
}

function nonEmptyString(value: unknown, path: string, maximum?: number): string {
  if (typeof value !== 'string' || value.length === 0) areaError(path, '必须是非空字符串')
  if (maximum !== undefined && value.length > maximum) areaError(path, `长度不能超过 ${maximum}`)
  return value
}

function normalizePhysicalBounds(value: unknown, path: string): { x: number; y: number; width: number; height: number } {
  const raw = areaRecord(value, path)
  assertKnownFields(raw, ['x', 'y', 'width', 'height'], path)
  const width = areaFiniteNumber(raw.width, `${path}.width`)
  const height = areaFiniteNumber(raw.height, `${path}.height`)
  if (width <= 0 || height <= 0) areaError(path, '宽高必须大于 0')
  return {
    x: areaFiniteNumber(raw.x, `${path}.x`),
    y: areaFiniteNumber(raw.y, `${path}.y`),
    width,
    height,
  }
}

function normalizeDesignMetrics(value: unknown): LayerDesignMetrics | undefined {
  if (value === undefined) return undefined
  const raw = areaRecord(value, 'designMetrics')
  assertKnownFields(raw, ['boundsMm', 'normalizedBounds', 'anchor', 'fontSizeMm', 'letterSpacingEm', 'lineHeight', 'wrapPolicy', 'maxLines'], 'designMetrics')
  if (!['top_left', 'top_center', 'center', 'baseline_left', 'baseline_center'].includes(String(raw.anchor))) areaError('designMetrics.anchor', '无效')
  const result: LayerDesignMetrics = {
    ...(raw.boundsMm === undefined ? {} : { boundsMm: normalizePhysicalBounds(raw.boundsMm, 'designMetrics.boundsMm') }),
    ...(raw.normalizedBounds === undefined ? {} : { normalizedBounds: normalizePhysicalBounds(raw.normalizedBounds, 'designMetrics.normalizedBounds') }),
    anchor: raw.anchor as LayerDesignMetrics['anchor'],
  }
  for (const field of ['fontSizeMm', 'letterSpacingEm', 'lineHeight'] as const) {
    if (raw[field] !== undefined) {
      const number = areaFiniteNumber(raw[field], `designMetrics.${field}`)
      if ((field === 'fontSizeMm' || field === 'lineHeight') && number <= 0) areaError(`designMetrics.${field}`, '必须大于 0')
      result[field] = number
    }
  }
  if (raw.wrapPolicy !== undefined) {
    if (!['none', 'word', 'character'].includes(String(raw.wrapPolicy))) areaError('designMetrics.wrapPolicy', '无效')
    result.wrapPolicy = raw.wrapPolicy as LayerDesignMetrics['wrapPolicy']
  }
  if (raw.maxLines !== undefined) {
    const maxLines = areaFiniteNumber(raw.maxLines, 'designMetrics.maxLines')
    if (!Number.isInteger(maxLines) || maxLines < 1) areaError('designMetrics.maxLines', '必须是正整数')
    result.maxLines = maxLines
  }
  return result
}

function normalizeProcesses(value: unknown): ProcessIntent[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) areaError('processes', '必须是数组')
  if (value.length > 32) areaError('processes', '不能超过 32 项')
  return value.map((item, index) => {
    const raw = areaRecord(item, `processes[${index}]`)
    assertKnownFields(raw, ['process', 'spotName', 'requiredMask'], `processes[${index}]`)
    if (typeof raw.process !== 'string' || !PROCESS_TYPES.has(raw.process)) areaError(`processes[${index}].process`, '无效')
    if (raw.spotName !== undefined) nonEmptyString(raw.spotName, `processes[${index}].spotName`, 128)
    if (raw.requiredMask !== undefined && (typeof raw.requiredMask !== 'string' || !REQUIRED_MASKS.has(raw.requiredMask))) {
      areaError(`processes[${index}].requiredMask`, '无效')
    }
    return cloneValue(raw) as unknown as ProcessIntent
  })
}

function normalizeArtboard(value: unknown): PhysicalArtboard | undefined {
  if (value === undefined) return undefined
  const raw = areaRecord(value, 'artboard')
  assertKnownFields(raw, ['widthMm', 'heightMm', 'background'], 'artboard')
  const widthMm = areaFiniteNumber(raw.widthMm, 'artboard.widthMm')
  const heightMm = areaFiniteNumber(raw.heightMm, 'artboard.heightMm')
  if (widthMm <= 0 || widthMm > 10000 || heightMm <= 0 || heightMm > 10000) areaError('artboard', '物理尺寸无效')
  return { widthMm, heightMm, background: nonEmptyString(raw.background, 'artboard.background', 64) }
}

function normalizeSubstrate(value: unknown): SubstrateSpec | undefined {
  if (value === undefined) return undefined
  const raw = areaRecord(value, 'substrate')
  assertKnownFields(raw, ['kind', 'color', 'opacity', 'boundary', 'material', 'adhesive'], 'substrate')
  if (raw.kind !== 'opaque' && raw.kind !== 'transparent') areaError('substrate.kind', '无效')
  const opacity = areaFiniteNumber(raw.opacity, 'substrate.opacity')
  if (opacity < 0 || opacity > 1) areaError('substrate.opacity', '必须在 0..1 之间')
  for (const field of ['color', 'material', 'adhesive'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') areaError(`substrate.${field}`, '必须是字符串')
  }
  let boundary: SubstrateSpec['boundary']
  if (raw.boundary !== undefined) {
    const input = areaRecord(raw.boundary, 'substrate.boundary')
    assertKnownFields(input, ['shape', 'radiusMm', 'pathData'], 'substrate.boundary')
    if (!['rectangle', 'rounded_rectangle', 'ellipse', 'custom'].includes(String(input.shape))) areaError('substrate.boundary.shape', '无效')
    if (input.radiusMm !== undefined && areaFiniteNumber(input.radiusMm, 'substrate.boundary.radiusMm') < 0) areaError('substrate.boundary.radiusMm', '不能小于 0')
    if (input.pathData !== undefined) nonEmptyString(input.pathData, 'substrate.boundary.pathData', 131072)
    boundary = cloneValue(input) as unknown as SubstrateSpec['boundary']
  }
  return {
    kind: raw.kind,
    opacity,
    ...(raw.color === undefined ? {} : { color: raw.color as string }),
    ...(boundary === undefined ? {} : { boundary }),
    ...(raw.material === undefined ? {} : { material: raw.material as string }),
    ...(raw.adhesive === undefined ? {} : { adhesive: raw.adhesive as string }),
  }
}

function normalizeDesignBinding(value: unknown): DesignBinding | undefined {
  if (value === undefined) return undefined
  const raw = areaRecord(value, 'designBinding')
  assertKnownFields(raw, ['blueprintRevision', 'blueprintSha256', 'reviewManifestSha256', 'approvedCrop'], 'designBinding')
  const blueprintRevision = nonEmptyString(raw.blueprintRevision, 'designBinding.blueprintRevision', 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(blueprintRevision)) areaError('designBinding.blueprintRevision', '格式无效')
  const blueprintSha256 = nonEmptyString(raw.blueprintSha256, 'designBinding.blueprintSha256')
  const reviewManifestSha256 = nonEmptyString(raw.reviewManifestSha256, 'designBinding.reviewManifestSha256')
  if (!/^[a-f0-9]{64}$/.test(blueprintSha256)) areaError('designBinding.blueprintSha256', '格式无效')
  if (!/^[a-f0-9]{64}$/.test(reviewManifestSha256)) areaError('designBinding.reviewManifestSha256', '格式无效')
  return {
    blueprintRevision,
    blueprintSha256,
    reviewManifestSha256,
    ...(raw.approvedCrop === undefined ? {} : { approvedCrop: normalizePhysicalBounds(raw.approvedCrop, 'designBinding.approvedCrop') }),
  }
}

function requiredAreaValue(raw: UnknownRecord, field: string, legacy: boolean, fallback: unknown): unknown {
  if (Object.prototype.hasOwnProperty.call(raw, field) && raw[field] !== undefined) return raw[field]
  if (legacy) return fallback
  areaError(field, '为必填字段')
}

function layerError(message: string): never {
  throw new Error(`项目图层无效：${message}`)
}

function requiredString(raw: UnknownRecord, field: string, options?: { nonEmpty?: boolean }): string {
  const value = raw[field]
  if (typeof value !== 'string' || (options?.nonEmpty === true && value.length === 0)) layerError(`${field} 必须是字符串`)
  return value
}

function requiredFiniteNumber(raw: UnknownRecord, field: string): number {
  const value = raw[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) layerError(`${field} 必须是有限数字`)
  return value
}

function requiredBoolean(raw: UnknownRecord, field: string): boolean {
  const value = raw[field]
  if (typeof value !== 'boolean') layerError(`${field} 必须是布尔值`)
  return value
}

function validateCraftList(value: unknown, path: string, fail: (message: string) => never): CraftEffect[] {
  if (!Array.isArray(value)) fail(`${path} 必须是数组`)
  for (let index = 0; index < value.length; index++) {
    const effect = value[index]
    if (!isRecord(effect) || typeof effect.type !== 'string' || !CRAFT_TYPES.has(effect.type) || !isRecord(effect.params)) {
      fail(`${path}[${index}] 条目无效`)
    }
    for (const [key, value] of Object.entries(effect.params)) {
      if (key === 'foilColor') {
        if (!['gold', 'silver', 'rose', 'champagne', 'holographic', 'custom'].includes(String(value))) fail(`${path}[${index}].params.foilColor 无效`)
      } else if (key === 'strokeColor' || key === 'foilCustomColor' || key === 'foilSpotName') {
        if (typeof value !== 'string') fail(`${path}[${index}].params.strokeColor 必须是字符串`)
      } else if (['gradientAngle', 'highlight', 'depth', 'lightAngle', 'intensity', 'noise', 'gloss', 'strokeWidth'].includes(key)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path}[${index}].params.${key} 必须是有限数字`)
      } else {
        fail(`${path}[${index}].params.${key} 是未知工艺参数`)
      }
    }
  }
  return cloneValue(value) as CraftEffect[]
}

function validateCraft(raw: UnknownRecord): void {
  validateCraftList(raw.craft, 'craft', layerError)
}

function validateCommonLayerFields(raw: UnknownRecord): void {
  requiredString(raw, 'id', { nonEmpty: true })
  for (const field of ['x', 'y', 'rotation', 'opacity', 'zIndex']) requiredFiniteNumber(raw, field)
  for (const field of ['visible', 'locked']) requiredBoolean(raw, field)
  validateCraft(raw)
}

function validateShapeGeometry(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value)) layerError('geometry 必须是对象')
  for (const key of SHAPE_GEOMETRY_NUMBER_FIELDS) {
    if (key in value && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) layerError(`${key} 必须是有限数字`)
  }
  for (const key of SHAPE_GEOMETRY_BOOLEAN_FIELDS) {
    if (key in value && typeof value[key] !== 'boolean') layerError(`${key} 必须是布尔值`)
  }
  if ('dash' in value && (!Array.isArray(value.dash) || value.dash.some((item) => typeof item !== 'number' || !Number.isFinite(item)))) {
    layerError('dash 必须是有限数字数组')
  }
  const validFields = new Set([...SHAPE_GEOMETRY_NUMBER_FIELDS, ...SHAPE_GEOMETRY_BOOLEAN_FIELDS, 'dash'])
  for (const key of Object.keys(value)) if (!validFields.has(key)) layerError(`未知 geometry 字段：${key}`)
}

function normalizeLayer(raw: unknown): LabelLayer {
  if (!isRecord(raw)) throw new Error('项目图层无效')
  if (raw.kind === 'text') {
    validateCommonLayerFields(raw)
    requiredString(raw, 'text')
    const fontFamily = requiredString(raw, 'fontFamily', { nonEmpty: true })
    requiredFiniteNumber(raw, 'fontSize')
    if (!(typeof raw.fontWeight === 'number' && Number.isFinite(raw.fontWeight)) && raw.fontWeight !== 'normal' && raw.fontWeight !== 'bold') {
      layerError('fontWeight 无效')
    }
    requiredFiniteNumber(raw, 'letterSpacing')
    requiredFiniteNumber(raw, 'lineHeight')
    if (raw.width !== undefined && requiredFiniteNumber(raw, 'width') <= 0) layerError('width 必须大于 0')
    requiredString(raw, 'color', { nonEmpty: true })
    if (raw.align !== 'left' && raw.align !== 'center' && raw.align !== 'right') layerError('align 无效')
    requiredBoolean(raw, 'italic')
    if (raw.direction !== undefined && raw.direction !== 'horizontal' && raw.direction !== 'vertical') layerError('direction 无效')
    if (raw.writingDirection !== undefined && raw.writingDirection !== 'auto' && raw.writingDirection !== 'ltr' && raw.writingDirection !== 'rtl') layerError('writingDirection 无效')
    if (raw.language !== undefined && typeof raw.language !== 'string') layerError('language 必须是字符串')
    const layer = cloneValue(raw) as unknown as TextLayer
    return {
      ...layer,
      fontFamily: legacyFontId(fontFamily),
      ...(raw.designMetrics === undefined ? {} : { designMetrics: normalizeDesignMetrics(raw.designMetrics) }),
      ...(raw.processes === undefined ? {} : { processes: normalizeProcesses(raw.processes) }),
    }
  }
  if (raw.kind === 'image') {
    validateCommonLayerFields(raw)
    requiredString(raw, 'src', { nonEmpty: true })
    for (const field of ['naturalWidth', 'naturalHeight', 'width', 'height']) requiredFiniteNumber(raw, field)
    return {
      ...cloneValue(raw) as unknown as LabelLayer,
      ...(raw.designMetrics === undefined ? {} : { designMetrics: normalizeDesignMetrics(raw.designMetrics) }),
      ...(raw.processes === undefined ? {} : { processes: normalizeProcesses(raw.processes) }),
    }
  }
  if (raw.kind === 'shape') {
    validateCommonLayerFields(raw)
    const shape = Object.prototype.hasOwnProperty.call(raw, 'shape') ? raw.shape : 'rectangle'
    if (typeof shape !== 'string' || !SHAPE_KINDS.has(shape)) layerError('shape 无效')
    for (const field of ['width', 'height', 'strokeWidth', 'cornerRadius']) requiredFiniteNumber(raw, field)
    requiredString(raw, 'fill', { nonEmpty: true })
    requiredString(raw, 'stroke', { nonEmpty: true })
    if (shape === 'path') {
      requiredString(raw, 'pathData', { nonEmpty: true })
      if (!Array.isArray(raw.pathViewBox) || raw.pathViewBox.length !== 4) layerError('pathViewBox 必须是 4 个有限数字')
      raw.pathViewBox.forEach((value, index) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) layerError(`pathViewBox[${index}] 必须是有限数字`)
      })
    }
    if (raw.fillRule !== undefined && raw.fillRule !== 'nonzero' && raw.fillRule !== 'evenodd') layerError('fillRule 无效')
    validateShapeGeometry(raw.geometry)
    const layer = cloneValue(raw) as unknown as ShapeLayer
    return {
      ...layer,
      shape: shape as ShapeKind,
      geometry: recordOr(raw.geometry, {}),
      ...(raw.designMetrics === undefined ? {} : { designMetrics: normalizeDesignMetrics(raw.designMetrics) }),
      ...(raw.processes === undefined ? {} : { processes: normalizeProcesses(raw.processes) }),
    }
  }
  layerError('kind 无效')
}

function normalizeRemap(value: unknown): RemapParams {
  const raw = areaRecord(value, 'remap')
  if (raw.mode !== 'cylindrical' && raw.mode !== 'planar') areaError('remap.mode', '必须是 cylindrical 或 planar')
  const axis = areaVector3(raw.axis, 'remap.axis')
  const axisLength = Math.hypot(...axis)
  if (axisLength <= 1e-9) areaError('remap.axis', '不能是零向量')
  const normalizedAxis = axis.map((component) => component / axisLength) as [number, number, number]
  const origin = areaVector3(raw.origin, 'remap.origin')
  const radius = areaFiniteNumber(raw.radius, 'remap.radius')
  if (radius <= 0) areaError('remap.radius', '必须大于 0')
  const wrap = areaFiniteNumber(raw.wrap, 'remap.wrap')
  if (wrap <= 0) areaError('remap.wrap', '必须大于 0')
  const offset = areaFiniteNumber(raw.offset, 'remap.offset')
  if (raw.mirrorU !== undefined && typeof raw.mirrorU !== 'boolean') areaError('remap.mirrorU', '必须是布尔值')
  const planarBox = areaRecord(raw.planarBox, 'remap.planarBox')
  const min = areaVector3(planarBox.min, 'remap.planarBox.min')
  const max = areaVector3(planarBox.max, 'remap.planarBox.max')
  for (let dimension = 0; dimension < 3; dimension++) {
    if (min[dimension] > max[dimension]) areaError(`remap.planarBox[${dimension}]`, 'min 不能大于 max')
  }
  return {
    mode: raw.mode,
    axis: normalizedAxis,
    origin,
    radius,
    wrap,
    offset,
    ...(raw.mirrorU === undefined ? {} : { mirrorU: raw.mirrorU }),
    planarBox: { min, max },
  }
}

function normalizeRange(value: unknown): LabelAreaRange {
  const raw = areaRecord(value, 'range')
  const range: LabelAreaRange = {
    uStart: areaFiniteNumber(raw.uStart, 'range.uStart'),
    uWidth: areaFiniteNumber(raw.uWidth, 'range.uWidth'),
    vStart: areaFiniteNumber(raw.vStart, 'range.vStart'),
    vHeight: areaFiniteNumber(raw.vHeight, 'range.vHeight'),
  }
  if (range.uStart < 0 || range.uStart > 1) areaError('range.uStart', '必须在 0..1 之间')
  if (range.vStart < 0 || range.vStart > 1) areaError('range.vStart', '必须在 0..1 之间')
  if (range.uWidth <= 0 || range.uWidth > 1) areaError('range.uWidth', '必须在 0..1 之间且大于 0')
  if (range.vHeight <= 0 || range.vHeight > 1) areaError('range.vHeight', '必须在 0..1 之间且大于 0')
  if (range.uStart + range.uWidth > 1 + 1e-9) areaError('range.uWidth', '与 uStart 之和不能超过 1')
  if (range.vStart + range.vHeight > 1 + 1e-9) areaError('range.vHeight', '与 vStart 之和不能超过 1')
  return range
}

function normalizeCanvas(value: unknown): CanvasSpec {
  const raw = areaRecord(value, 'canvas')
  const width = areaFiniteNumber(raw.width, 'canvas.width')
  const height = areaFiniteNumber(raw.height, 'canvas.height')
  const aspect = areaFiniteNumber(raw.aspect, 'canvas.aspect')
  if (!Number.isInteger(width) || width <= 0) areaError('canvas.width', '必须是正整数')
  if (!Number.isInteger(height) || height <= 0) areaError('canvas.height', '必须是正整数')
  if (aspect <= 0) areaError('canvas.aspect', '必须大于 0')
  return { width, height, aspect }
}

function normalizeGlobalCraft(value: unknown): { craft: CraftEffect[] } {
  const raw = areaRecord(value, 'globalCraft')
  return { craft: validateCraftList(raw.craft, 'globalCraft.craft', (message) => areaError(message.split(' ')[0], message.slice(message.indexOf(' ') + 1))) }
}

function normalizeFonts(value: unknown): UploadedFontRecord[] {
  if (!Array.isArray(value)) areaError('fonts', '必须是数组')
  return value.map((font, index) => {
    if (!isRecord(font)) areaError(`fonts[${index}]`, '必须是对象')
    if (typeof font.name !== 'string' || font.name.length === 0) areaError(`fonts[${index}].name`, '必须是非空字符串')
    if (typeof font.dataUrl !== 'string' || font.dataUrl.length === 0) areaError(`fonts[${index}].dataUrl`, '必须是非空字符串')
    return { name: font.name, dataUrl: font.dataUrl }
  })
}

function normalizePrintSpec(value: unknown): LabelPrintSpec | undefined {
  if (value === undefined) return undefined
  const raw = areaRecord(value, 'printSpec')
  const physicalWidthMm = areaFiniteNumber(raw.physicalWidthMm, 'printSpec.physicalWidthMm')
  const physicalHeightMm = areaFiniteNumber(raw.physicalHeightMm, 'printSpec.physicalHeightMm')
  const bleedMm = areaFiniteNumber(raw.bleedMm, 'printSpec.bleedMm')
  const cornerRadiusMm = areaFiniteNumber(raw.cornerRadiusMm, 'printSpec.cornerRadiusMm')
  const minTextHeightMm = areaFiniteNumber(raw.minTextHeightMm, 'printSpec.minTextHeightMm')
  if (physicalWidthMm <= 0 || physicalHeightMm <= 0) areaError('printSpec', '物理尺寸必须大于 0')
  if (bleedMm < 0 || cornerRadiusMm < 0 || minTextHeightMm <= 0) areaError('printSpec', '出血、圆角或最小字高无效')
  if (raw.dieCutShape !== 'rectangle' && raw.dieCutShape !== 'rounded-rectangle' && raw.dieCutShape !== 'custom') areaError('printSpec.dieCutShape', '无效')
  if (!Array.isArray(raw.spotColors) || raw.spotColors.some((color) => typeof color !== 'string' || color.length === 0)) areaError('printSpec.spotColors', '必须是非空字符串数组')
  return { physicalWidthMm, physicalHeightMm, bleedMm, cornerRadiusMm, minTextHeightMm, dieCutShape: raw.dieCutShape, spotColors: [...raw.spotColors] }
}

function normalizeArea(raw: unknown, index: number, sourceVersion: 1 | 2 | typeof PROJECT_VERSION): SerializedArea {
  if (!isRecord(raw)) throw new Error('项目区域无效')
  const legacy = sourceVersion < PROJECT_VERSION
  const remap = normalizeRemap(raw.remap)

  const idValue = requiredAreaValue(raw, 'id', legacy, `area-${index + 1}`)
  if (typeof idValue !== 'string' || idValue.length === 0) areaError('id', '必须是非空字符串')
  const nodeNameValue = requiredAreaValue(raw, 'nodeName', legacy, 'label')
  if (typeof nodeNameValue !== 'string' || nodeNameValue.length === 0) areaError('nodeName', '必须是非空字符串')
  const meshIndexValue = requiredAreaValue(raw, 'meshIndex', legacy, 0)
  const meshIndex = areaFiniteNumber(meshIndexValue, 'meshIndex')
  if (!Number.isInteger(meshIndex) || meshIndex < 0) areaError('meshIndex', '必须是非负整数')
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : nodeNameValue
  if (raw.surfaceMode !== undefined && raw.surfaceMode !== 'overlay' && raw.surfaceMode !== 'replace') {
    areaError('surfaceMode', '必须是 overlay 或 replace')
  }
  if (raw.side !== undefined && raw.side !== 'front' && raw.side !== 'back') {
    areaError('side', '必须是 front 或 back')
  }

  const range = normalizeRange(requiredAreaValue(raw, 'range', legacy, { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }))
  const canvas = normalizeCanvas(requiredAreaValue(raw, 'canvas', legacy, { width: 2048, height: 2048, aspect: 1 }))
  const layersValue = requiredAreaValue(raw, 'layers', legacy, [])
  if (!Array.isArray(layersValue)) areaError('layers', '必须是数组')
  const globalCraft = normalizeGlobalCraft(requiredAreaValue(raw, 'globalCraft', legacy, { craft: [] }))
  const fonts = normalizeFonts(requiredAreaValue(raw, 'fonts', legacy, []))

  if (raw.paper !== undefined && !isRecord(raw.paper)) areaError('paper', '必须是对象')
  const paperInput = isRecord(raw.paper) ? raw.paper : undefined
  if (paperInput?.enabled !== undefined && typeof paperInput.enabled !== 'boolean') areaError('paper.enabled', '必须是布尔值')
  if (paperInput?.color !== undefined && typeof paperInput.color !== 'string') areaError('paper.color', '必须是字符串')
  if (paperInput?.opacity !== undefined) {
    const opacity = areaFiniteNumber(paperInput.opacity, 'paper.opacity')
    if (opacity < 0 || opacity > 1) areaError('paper.opacity', '必须在 0..1 之间')
  }
  let carrier: CarrierMode | undefined
  if (raw.carrier !== undefined) {
    if (typeof raw.carrier !== 'string' || !CARRIER_MODES.has(raw.carrier)) areaError('carrier', '无效')
    carrier = raw.carrier as CarrierMode
  } else if (paperInput?.enabled === true) {
    carrier = 'applied_label'
  }
  let placementPolicy: TargetAspectPolicy | undefined
  if (raw.placementPolicy !== undefined) {
    if (!['fit', 'crop-approved', 'block'].includes(String(raw.placementPolicy))) areaError('placementPolicy', '无效')
    placementPolicy = raw.placementPolicy as TargetAspectPolicy
  }
  if (raw.blueprintAreaId !== undefined) nonEmptyString(raw.blueprintAreaId, 'blueprintAreaId', 128)
  return {
    id: idValue,
    name,
    meshIndex,
    nodeName: nodeNameValue,
    surfaceMode: raw.surfaceMode === 'overlay' || raw.surfaceMode === 'replace'
      ? raw.surfaceMode
      : /label|贴标|标签/i.test(nodeNameValue) ? 'replace' : 'overlay',
    ...(raw.side === 'front' || raw.side === 'back' ? { side: raw.side } : {}),
    remap,
    range,
    canvas,
    paper: resolveLabelPaper(paperInput),
    ...(carrier === undefined ? {} : { carrier }),
    ...(raw.artboard === undefined ? {} : { artboard: normalizeArtboard(raw.artboard) }),
    ...(raw.substrate === undefined ? {} : { substrate: normalizeSubstrate(raw.substrate) }),
    ...(placementPolicy === undefined ? {} : { placementPolicy }),
    ...(raw.blueprintAreaId === undefined ? {} : { blueprintAreaId: raw.blueprintAreaId as string }),
    ...(raw.designBinding === undefined ? {} : { designBinding: normalizeDesignBinding(raw.designBinding) }),
    ...(raw.printSpec === undefined ? {} : { printSpec: normalizePrintSpec(raw.printSpec) }),
    layers: layersValue.map(normalizeLayer),
    globalCraft,
    fonts,
    // Reference pixels are runtime data and cannot be restored from a .lbl file.
    referenceVisible: false,
  }
}

export function parseLabelProject(raw: unknown): LabelProjectV3 {
  assertSafeValue(raw)
  if (!isRecord(raw)) throw new Error('无效项目文件')
  const version = raw.version
  if (version !== 1 && version !== 2 && version !== PROJECT_VERSION) throw new Error(`不支持的版本：${String(version)}`)
  const rawAreas = version === 1 ? [raw] : raw.areas
  if (!Array.isArray(rawAreas)) throw new Error('项目缺少区域')

  const areas = rawAreas.map((area, index) => normalizeArea(area, index, version))
  if (areas.length === 0) throw new Error('项目至少需要一个区域')

  return {
    version: PROJECT_VERSION,
    modelFileName: typeof raw.modelFileName === 'string' ? raw.modelFileName : '',
    areas,
  }
}

export function serializeLabelProject(modelFileName: string, areas: Array<LabelAreaConfig | SerializedArea>): LabelProjectV3 {
  return {
    version: PROJECT_VERSION,
    modelFileName,
    areas: areas.map((area, index) => {
      const withRuntimeFields = area as SerializedArea & Partial<Pick<LabelAreaConfig, 'undoStack' | 'redoStack' | 'referenceUrl'>>
      const { undoStack: _undoStack, redoStack: _redoStack, referenceUrl: _referenceUrl, ...serializable } = withRuntimeFields
      return normalizeArea(serializable, index, PROJECT_VERSION)
    }),
  }
}
