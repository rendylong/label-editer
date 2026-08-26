import type { ErrorObject, ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import approvalRecordV1Schema from './approval-record-v1.schema.json'
import designReviewManifestV1Schema from './design-review-manifest-v1.schema.json'
import editorHandoffV2Schema from './editor-handoff-v2.schema.json'
import layoutBlueprintV1Schema from './layout-blueprint-v1.schema.json'
import reviewManifestV1Schema from './review-manifest-v1.schema.json'
import { isStrictRfc3339DateTime, validateManifestSemantics } from '../../scripts/lib/design-manifest-core.mjs'

export type CarrierMode =
  | 'direct_surface_print'
  | 'applied_label'
  | 'clear_label'
  | 'in_mold'
  | 'foil_or_ink_only'
  | 'bare'

export type LabelSide = 'front' | 'back' | 'left' | 'right' | 'wrap' | 'top' | 'bottom' | 'neck' | 'custom'

export interface ProcessIntent {
  process: 'screen_print' | 'pad_print' | 'digital_print' | 'offset_print' | 'white_underbase' | 'varnish' | 'hot_stamp_foil' | 'emboss' | 'deboss' | 'in_mold' | 'batch_code'
  spotName?: string
  requiredMask?: 'color' | 'metalness' | 'roughness' | 'bump' | 'white_underbase'
}

export interface PhysicalBounds {
  x: number
  y: number
  width: number
  height: number
}

/** PhysicalBounds shape constrained by contract validators to the normalized 0..1 domain. */
export interface NormalizedBounds extends PhysicalBounds {}

export interface FlattenedFallback {
  accepted: boolean
  nonEditableLayerIds: string[]
  nonEditableTextIds: string[]
  lostSeparations: string[]
  vectorAlternative: string
}

export interface LayoutBlueprintLayer {
  id: string
  kind: 'text' | 'image' | 'shape'
  boundsMm?: PhysicalBounds
  normalizedBounds?: NormalizedBounds
  anchor: 'top_left' | 'top_center' | 'center' | 'baseline_left' | 'baseline_center'
  rotation: number
  opacity: number
  visible: boolean
  zIndex: number
  processes: ProcessIntent[]
  flattenedFallback?: FlattenedFallback
  text?: string
  language?: string
  writingDirection?: 'auto' | 'ltr' | 'rtl'
  fontAsset?: string
  fontStack?: string[]
  fontSizeMm?: number
  fontWeight?: number | 'normal' | 'bold'
  letterSpacingEm?: number
  lineHeight?: number
  alignment?: 'left' | 'center' | 'right' | 'justify'
  wrapPolicy?: 'none' | 'word' | 'character'
  maxLines?: number
  color?: string
  assetId?: string
  fit?: 'contain' | 'cover' | 'stretch'
  shape?: 'rectangle' | 'rounded_rectangle' | 'ellipse' | 'line' | 'polygon' | 'path'
  pathData?: string
  pathViewBox?: [number, number, number, number]
  fillRule?: 'nonzero' | 'evenodd'
  fill?: string
  stroke?: string
  strokeWidthMm?: number
  cornerRadiusMm?: number
  points?: Array<[number, number]>
}

export interface LabelSubstrate {
  kind: 'opaque' | 'transparent'
  color?: string
  opacity: number
  boundary?: {
    shape: 'rectangle' | 'rounded_rectangle' | 'ellipse' | 'custom'
    radiusMm?: number
    pathData?: string
  }
  material?: string
  adhesive?: string
}

export interface LayoutBlueprintArea {
  id: string
  side: LabelSide
  carrier: CarrierMode
  artboard: { widthMm: number; heightMm: number; background: string }
  placementIntent: string
  substrate?: LabelSubstrate
  placementPolicy?: 'fit' | 'crop-approved' | 'block'
  layers: LayoutBlueprintLayer[]
}

export interface LayoutBlueprintV1 {
  version: 1
  revision: string
  carrierDefaults: {
    carrier: CarrierMode
    evidence?: string[]
    alternative?: CarrierMode
    tradeoff?: string
    assumptions?: string[]
  }
  assets: Array<{
    id: string
    path: string
    sha256: string
    mimeType: string
    width?: number
    height?: number
  }>
  areas: LayoutBlueprintArea[]
}

export interface ApprovalRecordV1 {
  version: 1
  gate: 'design' | 'production'
  mode: 'explicit_approval' | 'continuous_authorized'
  scope: 'current_task'
  design_revision: string
  blueprint_sha256: string
  review_manifest_sha256: string
  spec_revision?: string
  model_fingerprint?: string
  area_targets_sha256?: string
  recorded_at: string
}

export interface EditorHandoffV2 {
  handoff_version: 2
  status: 'awaiting_user_approval' | 'approved' | 'continuous_authorized'
  source: {
    design_spec: string
    mockup_html: string
    blueprint: string
    design_review_manifest: string
    blueprint_revision: string
    blueprint_sha256: string
    review_manifest_sha256: string
  }
  approval: {
    mode: 'explicit_approval' | 'continuous_authorized'
    scope: 'current_task'
    blueprint_revision: string
    blueprint_sha256: string
    review_manifest_sha256: string
  }
  model: {
    glb_path?: string
    package_type: 'bottle' | 'jar' | 'tube' | 'compact' | 'other'
  }
  areas: Array<{
    id: string
    side: LabelSide
    carrier: CarrierMode
    placement: string
    physical_size_mm: { width: number | 'unknown'; height: number | 'unknown' }
    blueprint_area_id: string
  }>
  assets: Array<{ id: string; path: string; sha256: string; mime_type?: string }>
  production_constraints: {
    budget?: string
    durability?: string
    process_capabilities?: string[]
    notes?: string[]
  }
  assumptions: string[]
  blockers: string[]
}

export interface ManifestArea {
  id: string
  side: LabelSide
  carrier: CarrierMode
}

export interface DesignReviewManifestV1 {
  version: 1
  createdAt: string
  blueprint: { revision: string; sha256: string }
  html: { sha256: string }
  references: Array<{ path: string; sha256?: string; role: 'visual_evidence' }>
  areas: ManifestArea[]
  artifacts: Array<{
    id: string
    path: string
    sha256: string
    mimeType: 'text/html' | 'image/png'
    width: number
    height: number
    viewKind: 'mockup-html' | 'mockup-front' | 'mockup-back' | 'mockup-area'
    areaId?: string
    carrier?: CarrierMode
  }>
}

export interface ReviewCameraMetadata {
  position: [number, number, number]
  direction: [number, number, number]
  target: [number, number, number]
  up: [number, number, number]
  fov: number
}

export interface ReviewManifestV1 {
  version: 1
  createdAt: string
  input: { kind: 'label-spec-v2' | 'label-project-v3'; revision: string; sha256: string }
  blueprint: { revision: string; sha256: string }
  designReviewManifest: { sha256: string }
  model: { fingerprint: string }
  areas: ManifestArea[]
  artifacts: Array<{
    id: string
    path: string
    sha256: string
    mimeType: 'image/png'
    width: number
    height: number
    viewKind: 'flat-artwork' | 'surface-face' | 'model-front' | 'model-back' | 'review-sheet'
    camera?: ReviewCameraMetadata
    areaId?: string
    carrier?: CarrierMode
  }>
}

export type DesignContractErrorCode =
  | 'INVALID_CARRIER'
  | 'INVALID_LAYOUT_BLUEPRINT'
  | 'INVALID_EDITOR_HANDOFF'
  | 'INVALID_APPROVAL_RECORD'
  | 'INVALID_DESIGN_REVIEW_MANIFEST'
  | 'INVALID_REVIEW_MANIFEST'
  | 'DIGEST_MISMATCH'

export class DesignContractError extends Error {
  readonly code: DesignContractErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: DesignContractErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'DesignContractError'
    this.code = code
    this.details = details
  }
}

export const CARRIER_MODES: readonly CarrierMode[] = [
  'direct_surface_print',
  'applied_label',
  'clear_label',
  'in_mold',
  'foil_or_ink_only',
  'bare',
] as const

const LEGACY_CARRIERS: Record<string, CarrierMode> = {
  paper_label: 'applied_label',
  direct_print: 'direct_surface_print',
  clear_label: 'clear_label',
  foil_stamp: 'foil_or_ink_only',
  bare_no_label: 'bare',
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addFormat('date-time', {
  type: 'string',
  validate: isStrictRfc3339DateTime,
})

const validateBlueprintSchema = ajv.compile(layoutBlueprintV1Schema) as ValidateFunction<LayoutBlueprintV1>
const validateHandoffSchema = ajv.compile(editorHandoffV2Schema) as ValidateFunction<EditorHandoffV2>
const validateApprovalSchema = ajv.compile(approvalRecordV1Schema) as ValidateFunction<ApprovalRecordV1>
const validateDesignManifestSchema = ajv.compile(designReviewManifestV1Schema) as ValidateFunction<DesignReviewManifestV1>
const validateProductionManifestSchema = ajv.compile(reviewManifestV1Schema) as ValidateFunction<ReviewManifestV1>

function schemaIssues(validate: ValidateFunction): Array<{ path: string; message: string; keyword: string }> {
  return (validate.errors ?? []).map((error: ErrorObject) => ({
    path: error.keyword === 'additionalProperties'
      ? `${error.instancePath}/${String(error.params.additionalProperty)}`
      : error.instancePath || '/',
    message: error.message ?? 'invalid value',
    keyword: error.keyword,
  }))
}

function assertSchema<T>(
  value: unknown,
  validate: ValidateFunction<T>,
  code: DesignContractErrorCode,
  label: string,
): asserts value is T {
  if (!validate(value)) {
    const issues = schemaIssues(validate)
    const summary = issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
    throw new DesignContractError(code, `${label} schema validation failed: ${summary}`, { issues })
  }
}

function assertUnique(values: string[], label: string, code: DesignContractErrorCode): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new DesignContractError(code, `Duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function assertLayerShape(layer: LayoutBlueprintLayer, areaId: string, assetsById: Map<string, LayoutBlueprintV1['assets'][number]>): void {
  for (const process of layer.processes) {
    if (process.spotName === 'white_underbase') {
      throw new DesignContractError(
        'INVALID_LAYOUT_BLUEPRINT',
        `white_underbase is reserved for the canonical renderer channel (${areaId}/${layer.id}/spotName)`,
      )
    }
  }
  if (layer.kind === 'text') {
    const hasFont = Boolean(layer.fontAsset) !== Boolean(layer.fontStack)
    if (layer.text === undefined || !layer.language || !layer.writingDirection || !hasFont
      || layer.fontSizeMm === undefined || layer.fontWeight === undefined
      || layer.letterSpacingEm === undefined || layer.lineHeight === undefined
      || !layer.alignment || !layer.wrapPolicy || layer.maxLines === undefined || !layer.color) {
      throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Text layer ${areaId}/${layer.id} is missing required typography fields`)
    }
    if (layer.fontAsset && !['font/woff', 'font/woff2'].includes(assetsById.get(layer.fontAsset)?.mimeType ?? '')) {
      throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Text layer ${areaId}/${layer.id} fontAsset must reference WOFF or WOFF2`)
    }
    for (const family of layer.fontStack ?? []) {
      if (!/^[\p{L}\p{N} ._-]+$/u.test(family)) {
        throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Text layer ${areaId}/${layer.id} fontStack contains an unsafe font family`)
      }
    }
  }
  if (layer.kind === 'image' && !layer.assetId) {
    throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Image layer ${areaId}/${layer.id} requires assetId`)
  }
  if (layer.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(assetsById.get(layer.assetId ?? '')?.mimeType ?? '')) {
    throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Image layer ${areaId}/${layer.id} assetId must reference a supported image`)
  }
  if (layer.kind === 'shape') {
    if (!layer.shape) throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Shape layer ${areaId}/${layer.id} requires shape`)
    if (layer.shape === 'path' && (!layer.pathData || !layer.pathViewBox)) {
      throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Path layer ${areaId}/${layer.id} requires pathData and pathViewBox`)
    }
  }
  if (layer.flattenedFallback && !layer.flattenedFallback.accepted) {
    throw new DesignContractError(
      'INVALID_LAYOUT_BLUEPRINT',
      `Flattened fallback for ${areaId}/${layer.id} must be explicitly accepted`,
    )
  }
}

function assertCarrierInvariants(area: LayoutBlueprintArea): void {
  if (area.carrier === 'applied_label' && (!area.substrate || area.substrate.kind !== 'opaque' || area.substrate.opacity <= 0 || !area.substrate.boundary)) {
    throw new DesignContractError(
      'INVALID_LAYOUT_BLUEPRINT',
      `applied_label area ${area.id} requires an opaque substrate with nonzero opacity and boundary`,
    )
  }
  if (area.carrier === 'clear_label') {
    if (!area.substrate || !area.substrate.boundary || area.substrate.kind !== 'transparent' || area.substrate.opacity >= 1) {
      throw new DesignContractError(
        'INVALID_LAYOUT_BLUEPRINT',
        `clear_label area ${area.id} requires a transparent substrate and boundary`,
      )
    }
    for (const layer of area.layers) {
      for (const process of layer.processes) {
        if (process.process === 'white_underbase' && process.requiredMask !== 'white_underbase') {
          throw new DesignContractError(
            'INVALID_LAYOUT_BLUEPRINT',
            `clear_label white_underbase on ${area.id}/${layer.id} requires requiredMask white_underbase`,
          )
        }
      }
    }
  }
  if (['direct_surface_print', 'in_mold', 'foil_or_ink_only', 'bare'].includes(area.carrier) && area.substrate) {
    throw new DesignContractError(
      'INVALID_LAYOUT_BLUEPRINT',
      `${area.carrier} area ${area.id} forbids substrate paper fields`,
    )
  }
  if (area.carrier === 'bare' && area.layers.length > 0) {
    throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `bare area ${area.id} must have no decorative layers`)
  }
}

export function canonicalCarrier(value: string): CarrierMode {
  const canonical = LEGACY_CARRIERS[value] ?? value
  if (!CARRIER_MODES.includes(canonical as CarrierMode)) {
    throw new DesignContractError('INVALID_CARRIER', `Unsupported carrier: ${value}`)
  }
  return canonical as CarrierMode
}

export function migrateLegacyApplication(value: string): { carrier: CarrierMode; processes: ProcessIntent[] } {
  return value === 'foil_stamp'
    ? { carrier: 'foil_or_ink_only', processes: [{ process: 'hot_stamp_foil' }] }
    : { carrier: canonicalCarrier(value), processes: [] }
}

export function assertDigestBinding(sourceDigest: string, approvalDigest: string, label = 'artifact'): void {
  if (sourceDigest !== approvalDigest) {
    throw new DesignContractError('DIGEST_MISMATCH', `${label} digest mismatch`)
  }
}

export function validateLayoutBlueprint(value: unknown): LayoutBlueprintV1 {
  assertSchema(value, validateBlueprintSchema, 'INVALID_LAYOUT_BLUEPRINT', 'Layout blueprint')
  assertUnique(value.areas.map((area) => area.id), 'area id', 'INVALID_LAYOUT_BLUEPRINT')
  assertUnique(value.assets.map((asset) => asset.id), 'asset id', 'INVALID_LAYOUT_BLUEPRINT')
  const assetsById = new Map(value.assets.map((asset) => [asset.id, asset]))
  const assetIds = new Set(assetsById.keys())
  const layerIds: string[] = []
  const layersById = new Map<string, LayoutBlueprintLayer>()
  for (const area of value.areas) {
    assertCarrierInvariants(area)
    for (const layer of area.layers) {
      layerIds.push(layer.id)
      layersById.set(layer.id, layer)
      assertLayerShape(layer, area.id, assetsById)
      if (layer.assetId && !assetIds.has(layer.assetId)) {
        throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Unknown asset id ${layer.assetId} on ${area.id}/${layer.id}`)
      }
      if (layer.fontAsset && !assetIds.has(layer.fontAsset)) {
        throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Unknown font asset id ${layer.fontAsset} on ${area.id}/${layer.id}`)
      }
    }
  }
  assertUnique(layerIds, 'layer id', 'INVALID_LAYOUT_BLUEPRINT')
  for (const area of value.areas) {
    for (const layer of area.layers) {
      const fallback = layer.flattenedFallback
      if (!fallback) continue
      for (const disclosedId of fallback.nonEditableLayerIds) {
        if (!layersById.has(disclosedId)) {
          throw new DesignContractError(
            'INVALID_LAYOUT_BLUEPRINT',
            `Flattened fallback nonEditableLayerIds references missing layer: ${disclosedId}`,
          )
        }
      }
      for (const disclosedId of fallback.nonEditableTextIds) {
        const disclosedLayer = layersById.get(disclosedId)
        if (!disclosedLayer) {
          throw new DesignContractError(
            'INVALID_LAYOUT_BLUEPRINT',
            `Flattened fallback nonEditableTextIds references missing text layer: ${disclosedId}`,
          )
        }
        if (disclosedLayer.kind !== 'text') {
          throw new DesignContractError(
            'INVALID_LAYOUT_BLUEPRINT',
            `Flattened fallback nonEditableTextIds must reference a text layer: ${disclosedId}`,
          )
        }
      }
    }
  }
  return structuredClone(value)
}

export function validateEditorHandoff(value: unknown): EditorHandoffV2 {
  assertSchema(value, validateHandoffSchema, 'INVALID_EDITOR_HANDOFF', 'Editor Handoff v2')
  assertUnique(value.areas.map((area) => area.id), 'area id', 'INVALID_EDITOR_HANDOFF')
  assertUnique(value.areas.map((area) => area.blueprint_area_id), 'blueprint area id', 'INVALID_EDITOR_HANDOFF')
  assertUnique(value.assets.map((asset) => asset.id), 'asset id', 'INVALID_EDITOR_HANDOFF')
  if (value.status === 'awaiting_user_approval') {
    throw new DesignContractError('INVALID_EDITOR_HANDOFF', 'Editor Handoff status is awaiting_user_approval')
  }
  if (value.blockers.length > 0) {
    throw new DesignContractError('INVALID_EDITOR_HANDOFF', 'Editor Handoff has non-empty blockers', { blockers: value.blockers })
  }
  if (value.status === 'approved' && value.approval.mode !== 'explicit_approval') {
    throw new DesignContractError('INVALID_EDITOR_HANDOFF', 'approved status requires explicit_approval mode')
  }
  if (value.status === 'continuous_authorized' && value.approval.mode !== 'continuous_authorized') {
    throw new DesignContractError('INVALID_EDITOR_HANDOFF', 'continuous_authorized status requires matching approval mode')
  }
  if (value.source.blueprint_revision !== value.approval.blueprint_revision) {
    throw new DesignContractError('DIGEST_MISMATCH', 'Blueprint revision digest binding mismatch')
  }
  assertDigestBinding(value.source.blueprint_sha256, value.approval.blueprint_sha256, 'Blueprint')
  assertDigestBinding(value.source.review_manifest_sha256, value.approval.review_manifest_sha256, 'Review manifest')
  return structuredClone(value)
}

export function validateApprovalRecord(value: unknown): ApprovalRecordV1 {
  assertSchema(value, validateApprovalSchema, 'INVALID_APPROVAL_RECORD', 'Approval record')
  return structuredClone(value)
}

export function validateDesignReviewManifest(value: unknown): DesignReviewManifestV1 {
  assertSchema(value, validateDesignManifestSchema, 'INVALID_DESIGN_REVIEW_MANIFEST', 'Design review manifest')
  try { validateManifestSemantics(value, 'design') } catch (error) {
    throw new DesignContractError('INVALID_DESIGN_REVIEW_MANIFEST', error instanceof Error ? error.message : String(error))
  }
  return structuredClone(value)
}

export function validateReviewManifest(value: unknown): ReviewManifestV1 {
  assertSchema(value, validateProductionManifestSchema, 'INVALID_REVIEW_MANIFEST', 'Review manifest')
  try { validateManifestSemantics(value, 'production') } catch (error) {
    throw new DesignContractError('INVALID_REVIEW_MANIFEST', error instanceof Error ? error.message : String(error))
  }
  return structuredClone(value)
}

export {
  approvalRecordV1Schema,
  designReviewManifestV1Schema,
  editorHandoffV2Schema,
  layoutBlueprintV1Schema,
  reviewManifestV1Schema,
}
