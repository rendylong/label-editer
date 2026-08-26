/** Structured Label Spec -> editable area/layer mapping. */

import type {
  CraftEffect,
  DesignBinding,
  LabelAreaConfig,
  LabelLayer,
  LabelPrintSpec,
  LayerDesignMetrics,
  PhysicalArtboard,
  ProcessIntent,
  ShapeGeometry,
  ShapeKind,
  SubstrateSpec,
  TargetAspectPolicy,
} from '../label/types'
import { validateLabelSpec } from '../agent/labelSpecSchema'

type UnknownRecord = Record<string, unknown>

export interface StructuredLabelSpecResult {
  areas: LabelAreaConfig[]
  warnings: string[]
}

/** A structured spec owns the complete front/back set for its target mesh. */
export function targetAreaIdsForSpecReplacement(areas: LabelAreaConfig[], baseArea: LabelAreaConfig): string[] {
  return areas.filter((area) => area.meshIndex === baseArea.meshIndex).map((area) => area.id)
}

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Label Spec ${path} 必须是对象`)
  return value as UnknownRecord
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function ratio(value: unknown, fallback: number): number {
  return Math.max(0, Math.min(1, finite(value, fallback)))
}

function normalizedDimension(value: unknown, fallback: number, maximum = 1): number {
  return Math.max(0, Math.min(maximum, finite(value, fallback)))
}

function craft(value: unknown): CraftEffect[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as CraftEffect[] : []
}

function shapeGeometry(value: unknown): ShapeGeometry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as UnknownRecord
  const geometry: ShapeGeometry = {}
  const numericKeys = ['sides', 'points', 'innerRatio', 'amplitude', 'frequency', 'inset', 'rows', 'columns', 'gap'] as const
  const booleanKeys = ['arrowStart', 'arrowEnd', 'parallel'] as const
  for (const key of numericKeys) if (typeof input[key] === 'number' && Number.isFinite(input[key])) geometry[key] = input[key]
  for (const key of booleanKeys) if (typeof input[key] === 'boolean') geometry[key] = input[key]
  if (Array.isArray(input.dash)) geometry.dash = input.dash.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
  return geometry
}

function printSpec(value: unknown, fallback?: LabelPrintSpec): LabelPrintSpec | undefined {
  if (value === undefined) return fallback
  const input = record(value, 'print')
  return {
    physicalWidthMm: Math.max(0.1, finite(input.widthMm, fallback?.physicalWidthMm ?? 40)),
    physicalHeightMm: Math.max(0.1, finite(input.heightMm, fallback?.physicalHeightMm ?? 60)),
    bleedMm: Math.max(0, finite(input.bleedMm, fallback?.bleedMm ?? 2)),
    cornerRadiusMm: Math.max(0, finite(input.cornerRadiusMm, fallback?.cornerRadiusMm ?? 0)),
    minTextHeightMm: Math.max(0.1, finite(input.minTextHeightMm, fallback?.minTextHeightMm ?? 1.2)),
    dieCutShape: input.dieCutShape === 'custom' || input.dieCutShape === 'rectangle' ? input.dieCutShape : 'rounded-rectangle',
    spotColors: Array.isArray(input.spotColors) ? input.spotColors.filter((item): item is string => typeof item === 'string' && item.length > 0) : fallback?.spotColors ?? [],
  }
}

function mapLayer(raw: unknown, area: LabelAreaConfig, index: number): LabelLayer {
  const input = record(raw, `areas[].layers[${index}]`)
  const x = ratio(input.x, 0.5) * area.canvas.width
  const y = ratio(input.y, 0.5) * area.canvas.height
  const common = {
    id: typeof input.id === 'string' ? input.id : `spec-layer-${index + 1}`,
    x, y, rotation: finite(input.rotation, 0), opacity: ratio(input.opacity, 1),
    visible: input.visible !== false, locked: input.locked === true, zIndex: index, craft: craft(input.craft),
    ...(input.designMetrics === undefined ? {} : { designMetrics: structuredClone(input.designMetrics) as LayerDesignMetrics }),
    ...(input.processes === undefined ? {} : { processes: structuredClone(input.processes) as ProcessIntent[] }),
  }
  if (input.type === 'shape') {
    const shape = (typeof input.shape === 'string' ? input.shape : 'rectangle') as ShapeKind
    return {
      ...common, kind: 'shape', shape, geometry: shapeGeometry(input.geometry), width: Math.max(4, normalizedDimension(input.width, 0.25, 4) * area.canvas.width),
      height: Math.max(4, normalizedDimension(input.height, 0.1, 4) * area.canvas.height), fill: typeof input.fill === 'string' ? input.fill : '#000000',
      stroke: typeof input.stroke === 'string' ? input.stroke : '#000000', strokeWidth: Math.max(0, finite(input.strokeWidth, 0)),
      cornerRadius: Math.max(0, finite(input.cornerRadius, 0)),
      ...(typeof input.pathData === 'string' ? { pathData: input.pathData } : {}),
      ...(Array.isArray(input.pathViewBox) ? { pathViewBox: structuredClone(input.pathViewBox) as [number, number, number, number] } : {}),
      ...(input.fillRule === 'nonzero' || input.fillRule === 'evenodd' ? { fillRule: input.fillRule } : {}),
    }
  }
  if (input.type === 'image') {
    const width = Math.max(4, normalizedDimension(input.width, 0.25, 4) * area.canvas.width)
    const height = Math.max(4, normalizedDimension(input.height, 0.25, 4) * area.canvas.height)
    return {
      ...common,
      kind: 'image',
      src: typeof input.asset === 'string' ? input.asset : '',
      naturalWidth: width,
      naturalHeight: height,
      width,
      height,
    }
  }
  const language = typeof input.language === 'string' ? input.language : undefined
  const rtl = input.writingDirection === 'rtl' || language?.toLowerCase().startsWith('ar')
  return {
    ...common, kind: 'text', text: typeof input.text === 'string' ? input.text : '',
    fontFamily: typeof input.fontFamily === 'string' ? input.fontFamily : rtl ? 'noto-sans-arabic' : 'system-sans',
    fontSize: Math.max(8, finite(input.fontSize, 64)), fontWeight: finite(input.fontWeight, 400),
    letterSpacing: finite(input.letterSpacing, 0), lineHeight: Math.max(0.5, finite(input.lineHeight, 1.2)),
    width: Math.max(8, ratio(input.width, 0.7) * area.canvas.width), color: typeof input.color === 'string' ? input.color : '#111111',
    align: input.align === 'left' || input.align === 'right' ? input.align : 'center', italic: input.italic === true,
    direction: input.direction === 'vertical' ? 'vertical' : 'horizontal', writingDirection: rtl ? 'rtl' : input.writingDirection === 'ltr' ? 'ltr' : 'auto', language,
  }
}

/** Apply a JSON Label Spec to one selected target mesh, creating front/back areas independently. */
export function applyStructuredLabelSpec(baseArea: LabelAreaConfig, raw: unknown, idSeed = 'import'): StructuredLabelSpecResult {
  const validation = validateLabelSpec(raw)
  if (!validation.ok) {
    const first = validation.issues[0]
    throw new Error(`Label Spec 校验失败${first?.path ? `（${first.path}）` : ''}：${first?.message ?? '格式无效'}`)
  }
  const root = validation.spec
  if (!Array.isArray(root.areas) || root.areas.length === 0) throw new Error('Label Spec 至少需要一个 areas 条目')
  const warnings: string[] = [...validation.warnings]
  const baseIsBack = baseArea.side === 'back' || (baseArea.side === undefined && /(?:背标|\bback\b)/i.test(baseArea.name))
  const frontOffset = baseIsBack
    ? (baseArea.remap.offset + 0.5) % 1
    : baseArea.remap.offset
  const areas = root.areas.map((value, index) => {
    const input = record(value, `areas[${index}]`)
    const side = input.side === 'back' ? 'back' : 'front'
    const offset = side === 'back' ? (frontOffset + 0.5) % 1 : frontOffset
    const inputCarrier = typeof input.carrier === 'string' ? input.carrier as LabelAreaConfig['carrier'] : undefined
    const effectiveCarrier = inputCarrier ?? baseArea.carrier
    const substrateForbidden = effectiveCarrier === 'direct_surface_print'
      || effectiveCarrier === 'in_mold'
      || effectiveCarrier === 'foil_or_ink_only'
      || effectiveCarrier === 'bare'
    const next: LabelAreaConfig = {
      ...baseArea,
      id: index === 0 ? baseArea.id : `${baseArea.id}-${idSeed}-${index + 1}`,
      name: typeof input.name === 'string' ? input.name : `${baseArea.name} · ${side === 'back' ? '背标' : '正标'}`,
      side,
      remap: { ...baseArea.remap, offset },
      paper: input.paper && typeof input.paper === 'object' ? { ...baseArea.paper, ...(input.paper as LabelAreaConfig['paper']) } as LabelAreaConfig['paper'] : baseArea.paper,
      ...(inputCarrier === undefined ? {} : { carrier: inputCarrier }),
      ...(input.artboard === undefined ? {} : { artboard: structuredClone(input.artboard) as PhysicalArtboard }),
      ...(input.substrate === undefined ? {} : { substrate: structuredClone(input.substrate) as SubstrateSpec }),
      ...(input.placementPolicy === undefined ? {} : { placementPolicy: input.placementPolicy as TargetAspectPolicy }),
      ...(typeof input.blueprintAreaId === 'string' ? { blueprintAreaId: input.blueprintAreaId } : {}),
      ...(input.designBinding === undefined ? {} : { designBinding: structuredClone(input.designBinding) as DesignBinding }),
      printSpec: printSpec(input.print, baseArea.printSpec),
      layers: [], undoStack: [], redoStack: [], referenceVisible: false,
    }
    // Validation above rejects a forbidden carrier with source substrate. Only
    // remove stale substrate inherited from the editable base during transition.
    if (substrateForbidden && input.substrate === undefined) delete next.substrate
    if (Array.isArray(input.layers)) next.layers = input.layers.map((layer, layerIndex) => mapLayer(layer, next, layerIndex))
    else warnings.push(`区域「${next.name}」没有 layers，已创建空白区域`)
    return next
  })
  return { areas, warnings }
}
