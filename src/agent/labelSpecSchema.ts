import type { ErrorObject, ValidateFunction } from 'ajv'
import labelSpecV2Schema from './label-spec-v2.schema.json'
import validateV2 from './generated/labelSpecV2Validator'

type UnknownRecord = Record<string, unknown>

export interface LabelSpecTargetV2 {
  stableSelector?: string
  meshIndex?: number
  nodeName?: string
  materialName?: string
}

export interface LabelSpecLayerV2 extends UnknownRecord {
  id: string
  type: 'text' | 'image' | 'shape'
  x: number
  y: number
}

export interface LabelSpecAreaV2 extends UnknownRecord {
  id: string
  name: string
  target: LabelSpecTargetV2
  surfaceMode: 'overlay' | 'replace'
  side?: 'front' | 'back'
  range: { uStart: number; uWidth: number; vStart: number; vHeight: number }
  layers: LabelSpecLayerV2[]
}

export interface LabelSpecV2 extends UnknownRecord {
  version: 2
  areas: LabelSpecAreaV2[]
}

export interface LabelSpecIssue {
  path: string
  message: string
  keyword: string
}

export type LabelSpecValidationResult =
  | { ok: true; spec: LabelSpecV2; issues: []; warnings: string[] }
  | { ok: false; issues: LabelSpecIssue[]; warnings: string[] }

const validateLabelSpecV2 = validateV2 as ValidateFunction<LabelSpecV2>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorPath(error: ErrorObject): string {
  if (error.keyword === 'additionalProperties') {
    const property = (error.params as { additionalProperty?: string }).additionalProperty
    if (property) return `${error.instancePath}/${property}` || `/${property}`
  }
  return error.instancePath || '/'
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function ratio(value: unknown, fallback: number): number {
  return Math.max(0, Math.min(1, finite(value, fallback)))
}

function migrateLayer(raw: unknown, areaIndex: number, layerIndex: number, warnings: string[]): UnknownRecord {
  const input = isRecord(raw) ? raw : {}
  const type = input.type === 'shape' || input.type === 'image' ? input.type : 'text'
  const path = `areas[${areaIndex}].layers[${layerIndex}]`
  const common = {
    id: typeof input.id === 'string' && input.id ? input.id : `v1-area-${areaIndex + 1}-layer-${layerIndex + 1}`,
    type,
    x: ratio(input.x, 0.5),
    y: ratio(input.y, 0.5),
    rotation: finite(input.rotation, 0),
    opacity: ratio(input.opacity, 1),
    visible: input.visible !== false,
    locked: input.locked === true,
    craft: Array.isArray(input.craft) ? input.craft : [],
  }
  if (typeof input.id !== 'string' || !input.id) warnings.push(`${path}.id inferred during v1 migration`)
  if (type === 'shape') {
    return {
      ...common,
      shape: typeof input.shape === 'string' ? input.shape : 'rectangle',
      width: Math.max(0.001, ratio(input.width, 0.25)),
      height: Math.max(0.001, ratio(input.height, 0.1)),
      fill: typeof input.fill === 'string' ? input.fill : '#000000',
      stroke: typeof input.stroke === 'string' ? input.stroke : '#000000',
      strokeWidth: Math.max(0, finite(input.strokeWidth, 0)),
      cornerRadius: Math.max(0, finite(input.cornerRadius, 0)),
    }
  }
  if (type === 'image') {
    return {
      ...common,
      asset: typeof input.asset === 'string' ? input.asset : 'missing-v1-image-asset',
      width: Math.max(0.001, ratio(input.width, 0.25)),
      height: Math.max(0.001, ratio(input.height, 0.25)),
    }
  }
  const language = typeof input.language === 'string' ? input.language : undefined
  const rtl = input.writingDirection === 'rtl' || language?.toLowerCase().startsWith('ar')
  return {
    ...common,
    text: typeof input.text === 'string' ? input.text : '',
    fontFamily: typeof input.fontFamily === 'string' ? input.fontFamily : rtl ? 'noto-sans-arabic' : 'system-sans',
    fontSize: Math.max(1, finite(input.fontSize, 64)),
    fontWeight: finite(input.fontWeight, 400),
    letterSpacing: finite(input.letterSpacing, 0),
    lineHeight: Math.max(0.5, finite(input.lineHeight, 1.2)),
    width: Math.max(0.001, ratio(input.width, 0.7)),
    color: typeof input.color === 'string' ? input.color : '#111111',
    align: input.align === 'left' || input.align === 'right' ? input.align : 'center',
    italic: input.italic === true,
    direction: input.direction === 'vertical' ? 'vertical' : 'horizontal',
    writingDirection: rtl ? 'rtl' : input.writingDirection === 'ltr' ? 'ltr' : 'auto',
    ...(language ? { language } : {}),
  }
}

export function migrateLabelSpecV1(raw: unknown): { spec: LabelSpecV2; warnings: string[] } {
  const root = isRecord(raw) ? raw : {}
  const sourceAreas = Array.isArray(root.areas) ? root.areas : []
  const warnings: string[] = []
  const areas = sourceAreas.map((rawArea, areaIndex): LabelSpecAreaV2 => {
    const area = isRecord(rawArea) ? rawArea : {}
    const side = area.side === 'back' ? 'back' : 'front'
    const name = typeof area.name === 'string' && area.name
      ? area.name
      : side === 'back' ? `背标 ${areaIndex + 1}` : `正标 ${areaIndex + 1}`
    const prefix = `areas[${areaIndex}]`
    warnings.push(`${prefix}.target inferred from the currently selected mesh during v1 migration`)
    warnings.push(`${prefix}.surfaceMode inferred as overlay during v1 migration`)
    warnings.push(`${prefix}.range inferred as full surface during v1 migration`)
    warnings.push(`${prefix}.remap inferred from model geometry during v1 migration`)
    warnings.push(`${prefix}.print is missing; production print readiness cannot be claimed`)
    if (typeof area.id !== 'string' || !area.id) warnings.push(`${prefix}.id inferred during v1 migration`)
    return {
      id: typeof area.id === 'string' && area.id ? area.id : `v1-area-${areaIndex + 1}`,
      name,
      target: { meshIndex: 0 },
      surfaceMode: 'overlay',
      side,
      range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
      remap: { mode: 'auto' },
      layers: Array.isArray(area.layers)
        ? area.layers.map((layer, layerIndex) => migrateLayer(layer, areaIndex, layerIndex, warnings) as LabelSpecLayerV2)
        : [],
    }
  })
  return { spec: { version: 2, areas }, warnings }
}

export function validateLabelSpec(raw: unknown): LabelSpecValidationResult {
  const version = isRecord(raw) ? raw.version : undefined
  const migrated = version === 1 ? migrateLabelSpecV1(raw) : { spec: raw, warnings: [] }
  if (!validateLabelSpecV2(migrated.spec)) {
    return {
      ok: false,
      issues: (validateLabelSpecV2.errors ?? []).map((error) => ({
        path: errorPath(error),
        message: error.message ?? 'invalid value',
        keyword: error.keyword,
      })),
      warnings: migrated.warnings,
    }
  }
  return {
    ok: true,
    spec: structuredClone(migrated.spec),
    issues: [],
    warnings: migrated.warnings,
  }
}

export { labelSpecV2Schema }
