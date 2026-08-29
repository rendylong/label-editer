import type { ErrorObject, ValidateFunction } from 'ajv'
import approvalRecordV1Schema from './approval-record-v1.schema.json'
import designReviewManifestV1Schema from './design-review-manifest-v1.schema.json'
import editorHandoffV2Schema from './editor-handoff-v2.schema.json'
import layoutBlueprintV1Schema from './layout-blueprint-v1.schema.json'
import reviewManifestV1Schema from './review-manifest-v1.schema.json'
import generatedValidateWorkflowLabelSpecSchema from './generated/labelSpecV2Validator'
import {
  validateApprovalSchema as generatedValidateApprovalSchema,
  validateBlueprintSchema as generatedValidateBlueprintSchema,
  validateDesignManifestSchema as generatedValidateDesignManifestSchema,
  validateHandoffSchema as generatedValidateHandoffSchema,
  validateProductionManifestSchema as generatedValidateProductionManifestSchema,
  validateWorkflowProjectSchema as generatedValidateWorkflowProjectSchema,
} from './generated/designContractValidators'
import { canonicalApprovedBlueprintDesignProjection, canonicalDocumentDesignProjection } from './designProjection'
import { WorkflowGateError, type WorkflowGateErrorCode } from './workflowGateError'
import { validateManifestSemantics } from '../../scripts/lib/design-manifest-core.mjs'
import { validateFontStack } from '../label/fontStack'
import { canonicalLayerOrder, compareOrdinalText } from '../label/layerOrder'
import { parsePortablePng } from '../../scripts/lib/png-core.mjs'

export { WorkflowGateError } from './workflowGateError'
export type { WorkflowGateErrorCode } from './workflowGateError'

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
  resolvedProject: { path: 'resolved-project.lbl.json'; revision: string; sha256: string; areaTargetsSha256: string }
  blueprint: { revision: string; sha256: string }
  designReviewManifest: { sha256: string }
  model: { fingerprint: string }
  areaTargetsSha256: string
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

export interface WorkflowJsonSource {
  read: () => string | Uint8Array | Promise<string | Uint8Array>
}

export interface WorkflowArtifactReader {
  list: () => readonly string[] | Promise<readonly string[]>
  read: (relativePath: string) => string | Uint8Array | Promise<string | Uint8Array>
}

export interface DesignGateInput {
  handoff: unknown
  blueprint: WorkflowJsonSource
  designReviewManifest: WorkflowJsonSource
  designReviewArtifacts: WorkflowArtifactReader
  currentDocument: WorkflowJsonSource
  approvalRecord?: unknown
}

export interface DesignGateResult {
  valid: true
  status: 'approved' | 'continuous_authorized'
  blueprintRevision: string
  blueprintSha256: string
  designReviewManifestSha256: string
  documentRevision: string
  documentSha256: string
  documentKind: 'label-spec-v2' | 'label-project-v3'
}

export interface ProductionGateInput extends Omit<DesignGateInput, 'approvalRecord'> {
  approvalRecord: unknown
  designApprovalRecord?: unknown
  productionReviewManifest: WorkflowJsonSource
  productionReviewArtifacts: WorkflowArtifactReader
  modelFingerprint: string
}

export interface ProductionGateResult extends DesignGateResult {
  inputRevision: string
  inputSha256: string
  modelFingerprint: string
  areaTargetsSha256: string
  productionReviewManifestSha256: string
}

export interface WorkflowRevisionSnapshot {
  blueprint: LayoutBlueprintV1
  designReviewManifest?: DesignReviewManifestV1
  document: unknown
  modelFingerprint?: string
  productionReviewManifest?: ReviewManifestV1
  productionAssets?: Array<{ id: string; sha256: string; [key: string]: unknown }>
}

export type RevisionClassification =
  | { valid: true; invalidates: 'none' }
  | { valid: false; invalidates: 'production'; reasons: string[] }
  | { valid: false; invalidates: 'design'; reasons: string[] }

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

const validateBlueprintSchema = generatedValidateBlueprintSchema as unknown as ValidateFunction<LayoutBlueprintV1>
const validateHandoffSchema = generatedValidateHandoffSchema as unknown as ValidateFunction<EditorHandoffV2>
const validateApprovalSchema = generatedValidateApprovalSchema as unknown as ValidateFunction<ApprovalRecordV1>
const validateDesignManifestSchema = generatedValidateDesignManifestSchema as unknown as ValidateFunction<DesignReviewManifestV1>
const validateProductionManifestSchema = generatedValidateProductionManifestSchema as unknown as ValidateFunction<ReviewManifestV1>
const validateWorkflowLabelSpecSchema = generatedValidateWorkflowLabelSpecSchema as unknown as ValidateFunction
const validateWorkflowProjectSchema = generatedValidateWorkflowProjectSchema as unknown as ValidateFunction

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
    if (layer.fontStack && !validateFontStack(layer.fontStack)) {
      throw new DesignContractError('INVALID_LAYOUT_BLUEPRINT', `Text layer ${areaId}/${layer.id} fontStack contains an unsafe or blank font family`)
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
  if (value.status === 'approved' && value.approval.mode !== 'explicit_approval') {
    throw new DesignContractError('INVALID_EDITOR_HANDOFF', 'approved status requires explicit_approval mode')
  }
  if (value.status === 'continuous_authorized' && value.approval.mode !== 'continuous_authorized') {
    throw new DesignContractError('INVALID_EDITOR_HANDOFF', 'continuous_authorized status requires matching approval mode')
  }
  if (value.source.blueprint_revision !== value.approval.blueprint_revision) {
    throw new DesignContractError('DIGEST_MISMATCH', 'Blueprint revision digest binding mismatch', {
      field: 'handoff.blueprintRevision',
    })
  }
  if (value.source.blueprint_sha256 !== value.approval.blueprint_sha256) {
    throw new DesignContractError('DIGEST_MISMATCH', 'Blueprint digest mismatch', {
      field: 'handoff.blueprintSha256',
    })
  }
  if (value.source.review_manifest_sha256 !== value.approval.review_manifest_sha256) {
    throw new DesignContractError('DIGEST_MISMATCH', 'Review manifest digest mismatch', {
      field: 'handoff.reviewManifestSha256',
    })
  }
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

type UnknownRecord = Record<string, unknown>

interface JsonEvidence<T> {
  value: T
  sha256: string
  bytes: Uint8Array
}

interface DocumentEvidence extends JsonEvidence<UnknownRecord> {
  kind: 'label-spec-v2' | 'label-project-v3'
  revision: string
}

const MAX_WORKFLOW_ARTIFACT_BYTES = 32 * 1024 * 1024

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]))
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value))
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return hex(new Uint8Array(digest))
}

async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(value)))
}

function workflowError(
  code: WorkflowGateErrorCode,
  message: string,
  field: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new WorkflowGateError(code, message, { field, ...details })
}

async function readJsonEvidence<T>(source: WorkflowJsonSource, field: string): Promise<JsonEvidence<T>> {
  let supplied: string | Uint8Array
  try {
    supplied = await source.read()
  } catch {
    return workflowError('DIGEST_MISMATCH', `Current ${field} evidence could not be read`, field)
  }
  const bytes = typeof supplied === 'string' ? new TextEncoder().encode(supplied) : supplied
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_WORKFLOW_ARTIFACT_BYTES) {
    return workflowError('DIGEST_MISMATCH', `Current ${field} evidence has an invalid bounded size`, field, {
      maximumBytes: MAX_WORKFLOW_ARTIFACT_BYTES,
    })
  }
  let value: T
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T
  } catch {
    return workflowError('DIGEST_MISMATCH', `Current ${field} evidence is not valid UTF-8 JSON`, field)
  }
  return { value, sha256: await sha256Bytes(bytes), bytes }
}

const MAX_WORKFLOW_EVIDENCE_FILES = 513
const MAX_WORKFLOW_EVIDENCE_TOTAL_BYTES = 128 * 1024 * 1024

function portableEvidencePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value.includes('\0')
    || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\\')) {
    return workflowError('DIGEST_MISMATCH', 'Evidence path is not portable', field)
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return workflowError('DIGEST_MISMATCH', 'Evidence path contains an unsafe segment', field)
  }
  return value
}

function artifactBytes(value: string | Uint8Array, field: string): Uint8Array {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_WORKFLOW_ARTIFACT_BYTES) {
    return workflowError('DIGEST_MISMATCH', 'Evidence artifact has an invalid bounded size', field)
  }
  return bytes
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false
  return true
}

async function verifyArtifactEvidence(
  reader: WorkflowArtifactReader,
  manifestEvidence: JsonEvidence<DesignReviewManifestV1 | ReviewManifestV1>,
  kind: 'design' | 'production',
): Promise<DocumentEvidence | undefined> {
  const field = kind === 'design' ? 'designReviewArtifacts' : 'productionReviewArtifacts'
  const manifestName = kind === 'design' ? 'design-review-manifest.json' : 'review-manifest.json'
  let listed: readonly string[]
  try { listed = await reader.list() } catch {
    return workflowError('DIGEST_MISMATCH', 'Current evidence directory could not be listed', field)
  }
  if (!Array.isArray(listed) || listed.length < 1 || listed.length > MAX_WORKFLOW_EVIDENCE_FILES
    || listed.some((entry) => typeof entry !== 'string')) {
    return workflowError('DIGEST_MISMATCH', 'Current evidence directory has an invalid bounded file set', field)
  }
  const resolvedProjectPath = kind === 'production'
    ? portableEvidencePath((manifestEvidence.value as ReviewManifestV1).resolvedProject.path, `${field}.resolvedProject.path`)
    : undefined
  const expected = [
    manifestName,
    ...(resolvedProjectPath === undefined ? [] : [resolvedProjectPath]),
    ...manifestEvidence.value.artifacts.map((artifact) => portableEvidencePath(artifact.path, `${field}.path`)),
  ]
  const expectedKeys = new Map<string, string>()
  for (const entry of expected) {
    const key = entry.normalize('NFKC').toLowerCase()
    if (expectedKeys.has(key)) return workflowError('DIGEST_MISMATCH', 'Manifest artifact paths are not portable and unique', `${field}.path`)
    expectedKeys.set(key, entry)
  }
  const actualKeys = new Map<string, string>()
  for (const raw of listed) {
    const entry = portableEvidencePath(raw, field)
    const key = entry.normalize('NFKC').toLowerCase()
    if (actualKeys.has(key)) return workflowError('DIGEST_MISMATCH', 'Evidence file paths are not portable and unique', field)
    actualKeys.set(key, entry)
  }
  if (expectedKeys.size !== actualKeys.size || [...expectedKeys].some(([key, value]) => actualKeys.get(key) !== value)) {
    return workflowError('DIGEST_MISMATCH', 'Evidence directory does not contain the exact manifest file set', field)
  }
  let totalBytes = 0
  const read = async (relativePath: string): Promise<Uint8Array> => {
    let supplied: string | Uint8Array
    try { supplied = await reader.read(relativePath) } catch {
      return workflowError('DIGEST_MISMATCH', `Evidence artifact could not be read: ${relativePath}`, field)
    }
    const bytes = artifactBytes(supplied, field)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_WORKFLOW_EVIDENCE_TOTAL_BYTES) {
      return workflowError('DIGEST_MISMATCH', 'Evidence artifacts exceed the bounded aggregate size', field)
    }
    return bytes
  }
  const manifestBytes = await read(manifestName)
  if (!sameBytes(manifestBytes, manifestEvidence.bytes)) {
    return workflowError('DIGEST_MISMATCH', 'Evidence manifest bytes differ from the supplied manifest', field)
  }
  let htmlCount = 0
  let resolvedProject: DocumentEvidence | undefined
  if (kind === 'design') {
    const manifest = manifestEvidence.value as DesignReviewManifestV1
    for (const viewKind of ['mockup-html', 'mockup-front', 'mockup-back'] as const) {
      if (manifest.artifacts.filter((artifact) => artifact.viewKind === viewKind).length !== 1) {
        return workflowError('DIGEST_MISMATCH', `Design evidence requires exactly one ${viewKind} artifact`, field)
      }
    }
    for (const area of manifest.areas.filter((entry) => entry.carrier !== 'bare')) {
      if (manifest.artifacts.filter((artifact) => artifact.viewKind === 'mockup-area' && artifact.areaId === area.id).length !== 1) {
        return workflowError('DIGEST_MISMATCH', `Design evidence requires exactly one area artifact for ${area.id}`, field)
      }
    }
  } else {
    const manifest = manifestEvidence.value as ReviewManifestV1
    const bytes = await read(resolvedProjectPath!)
    if (await sha256Bytes(bytes) !== manifest.resolvedProject.sha256) {
      return workflowError('DIGEST_MISMATCH', 'Resolved Project digest is stale', field)
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch {
      return workflowError('DIGEST_MISMATCH', 'Resolved Project is not valid UTF-8 JSON', field)
    }
    if (!isRecord(value) || value.version !== 3 || !validateWorkflowProjectSchema(value)) {
      return workflowError('DIGEST_MISMATCH', 'Resolved Project is not a valid Project v3', field)
    }
    assertDocumentAreaIdentity(value)
    const revision = `sha256:${await sha256Canonical(value)}`
    const targetDigest = await areaTargetsSha256(value)
    if (manifest.resolvedProject.revision !== revision
      || manifest.resolvedProject.areaTargetsSha256 !== targetDigest) {
      return workflowError('DIGEST_MISMATCH', 'Resolved Project binding is stale', field)
    }
    resolvedProject = { value: structuredClone(value), bytes, sha256: manifest.resolvedProject.sha256, revision, kind: 'label-project-v3' }
  }
  for (const artifact of manifestEvidence.value.artifacts) {
    const bytes = await read(artifact.path)
    if (await sha256Bytes(bytes) !== artifact.sha256) {
      return workflowError('DIGEST_MISMATCH', `Evidence artifact digest is stale: ${artifact.path}`, field)
    }
    if (artifact.mimeType === 'image/png') {
      try {
        parsePortablePng(bytes, {
          expectedWidth: artifact.width, expectedHeight: artifact.height,
          maxWidth: 32768, maxHeight: 32768, maxPixels: 64 * 1024 * 1024,
        })
      } catch {
        return workflowError('DIGEST_MISMATCH', `Evidence PNG MIME or dimensions are invalid: ${artifact.path}`, field)
      }
    } else if (kind === 'design' && artifact.mimeType === 'text/html' && artifact.viewKind === 'mockup-html') {
      htmlCount += 1
      let html: string
      try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
        return workflowError('DIGEST_MISMATCH', 'Design HTML is not valid UTF-8', field)
      }
      if (html.includes('\0') || !/<html\b/i.test(html)
        || !html.includes(`width:${artifact.width}px;height:${artifact.height}px`)
        || artifact.sha256 !== (manifestEvidence.value as DesignReviewManifestV1).html.sha256) {
        return workflowError('DIGEST_MISMATCH', 'Design HTML MIME, dimensions, or manifest binding is invalid', field)
      }
    } else {
      return workflowError('DIGEST_MISMATCH', `Evidence artifact MIME is invalid: ${artifact.path}`, field)
    }
  }
  if (kind === 'design' && htmlCount !== 1) {
    return workflowError('DIGEST_MISMATCH', 'Design evidence requires exactly one HTML artifact', field)
  }
  return resolvedProject
}

async function readBlueprintEvidence(source: WorkflowJsonSource): Promise<JsonEvidence<LayoutBlueprintV1>> {
  const evidence = await readJsonEvidence<unknown>(source, 'blueprint')
  try {
    return { ...evidence, value: validateLayoutBlueprint(evidence.value) }
  } catch (error) {
    return workflowError('DIGEST_MISMATCH', 'Current blueprint evidence is not contract-valid', 'blueprint', {
      contractCode: error instanceof DesignContractError ? error.code : 'INVALID_LAYOUT_BLUEPRINT',
      contractDetails: error instanceof DesignContractError ? error.details ?? error.message : String(error),
    })
  }
}

async function readDesignManifestEvidence(source: WorkflowJsonSource): Promise<JsonEvidence<DesignReviewManifestV1>> {
  const evidence = await readJsonEvidence<unknown>(source, 'designReviewManifest')
  try {
    return { ...evidence, value: validateDesignReviewManifest(evidence.value) }
  } catch (error) {
    return workflowError('DIGEST_MISMATCH', 'Current design review manifest is not contract-valid', 'designReviewManifest', {
      contractCode: error instanceof DesignContractError ? error.code : 'INVALID_DESIGN_REVIEW_MANIFEST',
    })
  }
}

async function readProductionManifestEvidence(source: WorkflowJsonSource): Promise<JsonEvidence<ReviewManifestV1>> {
  const evidence = await readJsonEvidence<unknown>(source, 'productionReviewManifest')
  try {
    return { ...evidence, value: validateReviewManifest(evidence.value) }
  } catch (error) {
    return workflowError('DIGEST_MISMATCH', 'Current production review manifest is not contract-valid', 'productionReviewManifest', {
      contractCode: error instanceof DesignContractError ? error.code : 'INVALID_REVIEW_MANIFEST',
    })
  }
}

async function readDocumentEvidence(source: WorkflowJsonSource): Promise<DocumentEvidence> {
  const evidence = await readJsonEvidence<unknown>(source, 'currentDocument')
  if (!isRecord(evidence.value)) {
    return workflowError('APPROVAL_REQUIRED', 'Current Spec/Project must be a JSON object', 'currentDocument')
  }
  const validate = evidence.value.version === 2
    ? validateWorkflowLabelSpecSchema
    : evidence.value.version === 3 ? validateWorkflowProjectSchema : undefined
  if (!validate || !validate(evidence.value)) {
    return workflowError('APPROVAL_REQUIRED', 'Current Spec/Project is not a valid Label Spec v2 or Project v3', 'currentDocument', {
      issueCount: validate?.errors?.length ?? 1,
    })
  }
  assertDocumentAreaIdentity(evidence.value)
  const digest = await sha256Canonical(evidence.value)
  return {
    value: structuredClone(evidence.value),
    sha256: evidence.sha256,
    bytes: evidence.bytes,
    kind: evidence.value.version === 2 ? 'label-spec-v2' : 'label-project-v3',
    revision: `sha256:${digest}`,
  }
}

function stableSortById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => compareOrdinalText(left.id, right.id))
}

function manifestAreaProjection(values: readonly ManifestArea[]): ManifestArea[] {
  return stableSortById(values.map((area) => ({ id: area.id, side: area.side, carrier: area.carrier })))
}

function blueprintManifestAreas(blueprint: LayoutBlueprintV1): ManifestArea[] {
  return manifestAreaProjection(blueprint.areas.map((area) => ({ id: area.id, side: area.side, carrier: area.carrier })))
}

function documentAreas(document: UnknownRecord): UnknownRecord[] {
  return Array.isArray(document.areas) ? document.areas.filter(isRecord) : []
}

function assertDocumentAreaIdentity(document: UnknownRecord): void {
  const ids = new Set<string>()
  const blueprintAreaIds = new Set<string>()
  for (const area of documentAreas(document)) {
    const id = typeof area.id === 'string' ? area.id : ''
    const blueprintAreaId = typeof area.blueprintAreaId === 'string' ? area.blueprintAreaId : ''
    if (!id || ids.has(id) || (blueprintAreaId && blueprintAreaIds.has(blueprintAreaId))) {
      workflowError('APPROVAL_REQUIRED', 'Current Spec/Project area identity is missing or duplicated', 'currentDocument.areas')
    }
    ids.add(id)
    if (blueprintAreaId) blueprintAreaIds.add(blueprintAreaId)
  }
}

function currentDocumentManifestAreas(document: UnknownRecord): ManifestArea[] {
  const projected: ManifestArea[] = []
  for (const area of documentAreas(document)) {
    if (typeof area.id !== 'string' || typeof area.side !== 'string' || typeof area.carrier !== 'string') {
      return workflowError('APPROVAL_REQUIRED', 'Current Spec/Project area identity is not normalized for review', 'currentDocument.areas')
    }
    projected.push({ id: area.id, side: area.side as LabelSide, carrier: area.carrier as CarrierMode })
  }
  return manifestAreaProjection(projected)
}

function sameProjection(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function assertManifestBlueprintBinding(
  manifest: DesignReviewManifestV1,
  blueprint: JsonEvidence<LayoutBlueprintV1>,
): void {
  if (manifest.blueprint.revision !== blueprint.value.revision || manifest.blueprint.sha256 !== blueprint.sha256) {
    workflowError('DIGEST_MISMATCH', 'Design review manifest does not bind the current blueprint', 'designReviewManifest.blueprint')
  }
  if (!sameProjection(manifestAreaProjection(manifest.areas), blueprintManifestAreas(blueprint.value))) {
    workflowError('DIGEST_MISMATCH', 'Design review manifest area bindings do not match the current blueprint', 'designReviewManifest.areas')
  }
}

function assertDocumentDesignBindings(
  document: UnknownRecord,
  blueprint: JsonEvidence<LayoutBlueprintV1>,
  reviewManifestSha256: string,
): void {
  const areas = documentAreas(document)
  const blueprintAreaIds = new Set(blueprint.value.areas.map((area) => area.id))
  const boundAreaIds = new Set<string>()
  for (const area of areas) {
    const binding = area.designBinding
    if (!isRecord(binding)) {
      workflowError('APPROVAL_REQUIRED', 'Current Spec/Project requires a normalized design binding', 'designBinding')
    }
    if (binding.blueprintRevision !== blueprint.value.revision
      || binding.blueprintSha256 !== blueprint.sha256
      || binding.reviewManifestSha256 !== reviewManifestSha256) {
      workflowError('STALE_APPROVAL', 'Current Spec/Project design binding is stale', 'designBinding')
    }
    const blueprintAreaId = typeof area.blueprintAreaId === 'string' ? area.blueprintAreaId : undefined
    if (!blueprintAreaId || !blueprintAreaIds.has(blueprintAreaId) || boundAreaIds.has(blueprintAreaId)) {
      workflowError('STALE_APPROVAL', 'Current Spec/Project blueprint area binding is stale or ambiguous', 'designBinding')
    }
    const sourceArea = blueprint.value.areas.find((candidate) => candidate.id === blueprintAreaId)!
    if (area.carrier !== sourceArea.carrier) {
      workflowError('STALE_APPROVAL', 'Current Spec/Project carrier differs from the approved blueprint', 'designBinding')
    }
    boundAreaIds.add(blueprintAreaId)
  }
  if (boundAreaIds.size !== blueprintAreaIds.size) {
    workflowError('STALE_APPROVAL', 'Current Spec/Project does not bind every blueprint area', 'designBinding')
  }
}

function assertCurrentDocumentDesign(
  document: UnknownRecord,
  blueprint: LayoutBlueprintV1,
): void {
  let approved: UnknownRecord
  let current: UnknownRecord
  try {
    approved = canonicalApprovedBlueprintDesignProjection(blueprint, document)
    current = canonicalDocumentDesignProjection(document, blueprint)
  } catch (error) {
    if (error instanceof WorkflowGateError) throw error
    return workflowError('APPROVAL_REQUIRED', 'Current Spec/Project render inputs are not representable', 'currentDocument.design')
  }
  if (!sameProjection(current, approved)) {
    workflowError('STALE_APPROVAL', 'Current Spec/Project editable design differs from the approved blueprint', 'currentDocument.design')
  }
}

function boundedBlockers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 32).map((blocker) => String(blocker).slice(0, 256))
}

function validateWorkflowApprovalRecord(value: unknown, expectedGate: ApprovalRecordV1['gate']): ApprovalRecordV1 {
  if (!isRecord(value)) return workflowError('APPROVAL_REQUIRED', `${expectedGate} approval record is required`, 'approvalRecord')
  if (value.scope !== 'current_task') {
    return workflowError('APPROVAL_REQUIRED', 'Approval scope must be exactly current_task', 'approval.scope')
  }
  let record: ApprovalRecordV1
  try { record = validateApprovalRecord(value) } catch {
    return workflowError('APPROVAL_REQUIRED', `${expectedGate} approval record is not contract-valid`, 'approvalRecord')
  }
  if (record.gate !== expectedGate) {
    return workflowError('APPROVAL_REQUIRED', `A ${expectedGate} approval record is required`, 'approval.gate')
  }
  return record
}

function assertCurrentDesignApproval(
  record: ApprovalRecordV1,
  blueprint: JsonEvidence<LayoutBlueprintV1>,
  designManifestSha256: string,
): void {
  if (record.design_revision !== blueprint.value.revision) {
    workflowError('STALE_APPROVAL', 'Design approval revision is stale', 'approval.designRevision')
  }
  if (record.blueprint_sha256 !== blueprint.sha256) {
    workflowError('STALE_APPROVAL', 'Design approval blueprint digest is stale', 'approval.blueprintSha256')
  }
  if (record.review_manifest_sha256 !== designManifestSha256) {
    workflowError('STALE_APPROVAL', 'Design approval review manifest digest is stale', 'approval.reviewManifestSha256')
  }
}

type LegacyHandoffStatus = 'approved' | 'assumed_for_fast_run' | 'awaiting_user_approval' | 'rejected'

interface LegacyEditorHandoffV1 extends UnknownRecord {
  handoff_version: 1
  status: LegacyHandoffStatus
  blockers: string[]
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
}

function stringList(value: unknown, maximum = 256): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(boundedString)
}

function legacyMeasurement(value: unknown, allowZero: boolean): boolean {
  return value === 'unknown' || (typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0))
}

function legacyRecordList(value: unknown, validate: (entry: UnknownRecord) => boolean, maximum = 256): boolean {
  return Array.isArray(value) && value.length <= maximum && value.every((entry) => isRecord(entry) && validate(entry))
}

function validateLegacyArea(value: unknown): value is UnknownRecord {
  if (!isRecord(value)
    || !boundedString(value.id)
    || !['front', 'back', 'left', 'right', 'wrap', 'top', 'bottom', 'neck', 'custom'].includes(String(value.side))
    || !['direct_print', 'paper_label', 'clear_label', 'foil_stamp', 'other'].includes(String(value.application))
    || !boundedString(value.placement)
    || !['rectangle', 'rounded_rect', 'oval', 'full_wrap', 'die_cut', 'band', 'other'].includes(String(value.shape))
    || !stringList(value.layer_order)) return false
  if (!isRecord(value.physical_size_mm)
    || !legacyMeasurement(value.physical_size_mm.width, false)
    || !legacyMeasurement(value.physical_size_mm.height, false)) return false
  if (!legacyRecordList(value.copy, (copy) => (
    typeof copy.text === 'string'
    && ['brand', 'product', 'claim', 'ingredient', 'volume', 'regulatory', 'other'].includes(String(copy.role))
    && boundedString(copy.language)
    && ['ltr', 'rtl', 'auto'].includes(String(copy.writing_direction))
    && typeof copy.placeholder === 'boolean'
  ))) return false
  if (!isRecord(value.typography)
    || !boundedString(value.typography.class)
    || !boundedString(value.typography.font_preference)
    || !(boundedString(value.typography.weight) || (typeof value.typography.weight === 'number' && Number.isFinite(value.typography.weight)))
    || !boundedString(value.typography.case)
    || !(boundedString(value.typography.letter_spacing) || (typeof value.typography.letter_spacing === 'number' && Number.isFinite(value.typography.letter_spacing)))
    || !boundedString(value.typography.alignment)) return false
  if (!legacyRecordList(value.palette, (entry) => boundedString(entry.role) && boundedString(entry.color))) return false
  return legacyRecordList(value.processes, (entry) => boundedString(entry.element) && boundedString(entry.process))
}

function validateLegacyHandoff(value: unknown): LegacyEditorHandoffV1 | undefined {
  if (!isRecord(value) || value.handoff_version !== 1
    || !['approved', 'assumed_for_fast_run', 'awaiting_user_approval', 'rejected'].includes(String(value.status))) return undefined
  if (!isRecord(value.source) || !boundedString(value.source.design_spec) || !boundedString(value.source.mockup)) return undefined
  if (!isRecord(value.model)
    || !['bottle', 'jar', 'tube', 'compact', 'other'].includes(String(value.model.package_type))
    || (value.model.glb_path !== undefined && !boundedString(value.model.glb_path))) return undefined
  if (!isRecord(value.design_intent)
    || !boundedString(value.design_intent.selected_direction)
    || !boundedString(value.design_intent.positioning)
    || !stringList(value.design_intent.convention_basis)
    || !stringList(value.design_intent.differentiation_axes)) return undefined
  if (!legacyRecordList(value.areas, validateLegacyArea, 64) || (value.areas as unknown[]).length === 0) return undefined
  const areaIds = (value.areas as UnknownRecord[]).map((area) => area.id as string)
  if (new Set(areaIds).size !== areaIds.length) return undefined
  if (!legacyRecordList(value.assets, (asset) => boundedString(asset.id) && boundedString(asset.role) && boundedString(asset.path))) return undefined
  const assetIds = (value.assets as UnknownRecord[]).map((asset) => asset.id as string)
  if (new Set(assetIds).size !== assetIds.length) return undefined
  if (!isRecord(value.print_constraints)
    || !legacyMeasurement(value.print_constraints.bleed_mm, true)
    || !legacyMeasurement(value.print_constraints.minimum_text_height_mm, false)
    || !stringList(value.print_constraints.spot_colors)) return undefined
  if (!stringList(value.assumptions, 128) || !stringList(value.blockers, 128)) return undefined
  return structuredClone(value) as LegacyEditorHandoffV1
}

export async function verifyDesignGate(input: DesignGateInput): Promise<DesignGateResult> {
  const [blueprint, designManifest, document] = await Promise.all([
    readBlueprintEvidence(input.blueprint),
    readDesignManifestEvidence(input.designReviewManifest),
    readDocumentEvidence(input.currentDocument),
  ])
  await verifyArtifactEvidence(input.designReviewArtifacts, designManifest, 'design')
  assertManifestBlueprintBinding(designManifest.value, blueprint)
  assertDocumentDesignBindings(document.value, blueprint, designManifest.sha256)
  assertCurrentDocumentDesign(document.value, blueprint.value)

  if (!isRecord(input.handoff) || input.handoff.handoff_version !== 2) {
    if (!isRecord(input.handoff) || input.handoff.handoff_version !== 1) {
      return workflowError('APPROVAL_REQUIRED', 'Handoff version is not recognized', 'handoff.version')
    }
    const legacy = validateLegacyHandoff(input.handoff)
    if (!legacy) {
      return workflowError('APPROVAL_REQUIRED', 'Legacy Handoff v1 is not contract-valid', 'handoff')
    }
    const blockers = boundedBlockers(legacy.blockers)
    if (blockers.length > 0) {
      return workflowError('HANDOFF_BLOCKED', 'Legacy editor handoff has unresolved blockers', 'handoff.blockers', { blockers })
    }
    if (legacy.status === 'rejected' || legacy.status === 'awaiting_user_approval') {
      return workflowError('AWAITING_USER_APPROVAL', 'Legacy handoff is awaiting user approval', 'handoff.status', {
        workflowState: 'awaiting_user_approval',
      })
    }
    if (legacy.status === 'approved') {
      return workflowError('APPROVAL_REQUIRED', 'Legacy approved handoff must be normalized to approved Handoff v2', 'handoff.version', {
        normalizedStatus: 'awaiting_user_approval',
      })
    }
    if (input.approvalRecord === undefined) {
      return workflowError('AWAITING_USER_APPROVAL', 'Legacy assumed_for_fast_run is not approval', 'handoff.status', {
        workflowState: 'awaiting_user_approval',
      })
    }
    const record = validateWorkflowApprovalRecord(input.approvalRecord, 'design')
    if (record.mode !== 'continuous_authorized') {
      return workflowError('APPROVAL_REQUIRED', 'Legacy handoff requires current continuous authorization', 'approval.mode')
    }
    assertCurrentDesignApproval(record, blueprint, designManifest.sha256)
    return {
      valid: true, status: 'continuous_authorized', blueprintRevision: blueprint.value.revision,
      blueprintSha256: blueprint.sha256, designReviewManifestSha256: designManifest.sha256,
      documentRevision: document.revision, documentSha256: document.sha256,
      documentKind: document.kind,
    }
  }

  let handoff: EditorHandoffV2
  try {
    handoff = validateEditorHandoff(input.handoff)
  } catch (error) {
    if (error instanceof DesignContractError && error.code === 'DIGEST_MISMATCH') {
      const field = typeof error.details?.field === 'string' ? error.details.field : 'handoff'
      return workflowError('DIGEST_MISMATCH', error.message, field)
    }
    if (isRecord(input.handoff.approval) && input.handoff.approval.scope !== 'current_task') {
      return workflowError('APPROVAL_REQUIRED', 'Handoff approval scope must be exactly current_task', 'approval.scope')
    }
    return workflowError('APPROVAL_REQUIRED', 'Editor Handoff v2 is not contract-valid', 'handoff')
  }
  const blockers = boundedBlockers(handoff.blockers)
  if (blockers.length > 0) {
    return workflowError('HANDOFF_BLOCKED', 'Editor handoff has unresolved blockers', 'handoff.blockers', { blockers })
  }
  if (handoff.status === 'awaiting_user_approval') {
    return workflowError('AWAITING_USER_APPROVAL', 'Editor handoff is awaiting user approval', 'handoff.status', {
      workflowState: 'awaiting_user_approval',
    })
  }
  if (handoff.approval.scope !== 'current_task') {
    return workflowError('APPROVAL_REQUIRED', 'Handoff approval scope must be exactly current_task', 'approval.scope')
  }
  if (handoff.approval.blueprint_revision !== blueprint.value.revision) {
    return workflowError('STALE_APPROVAL', 'Handoff blueprint revision is stale', 'blueprint.revision')
  }
  if (handoff.approval.blueprint_sha256 !== blueprint.sha256) {
    return workflowError('STALE_APPROVAL', 'Handoff blueprint digest is stale', 'blueprint.sha256')
  }
  if (handoff.approval.review_manifest_sha256 !== designManifest.sha256) {
    return workflowError('STALE_APPROVAL', 'Handoff design review digest is stale', 'designReviewManifest.sha256')
  }
  const handoffAreas = manifestAreaProjection(handoff.areas.map((area) => ({
    id: area.blueprint_area_id, side: area.side, carrier: area.carrier,
  })))
  if (!sameProjection(handoffAreas, blueprintManifestAreas(blueprint.value))) {
    return workflowError('DIGEST_MISMATCH', 'Handoff area bindings do not match the current blueprint', 'handoff.areas')
  }
  if (input.approvalRecord !== undefined) {
    const record = validateWorkflowApprovalRecord(input.approvalRecord, 'design')
    assertCurrentDesignApproval(record, blueprint, designManifest.sha256)
    if (record.mode !== handoff.approval.mode) {
      return workflowError('APPROVAL_REQUIRED', 'Design approval record mode differs from Handoff v2', 'approval.mode')
    }
  }
  return {
    valid: true,
    status: handoff.status,
    blueprintRevision: blueprint.value.revision,
    blueprintSha256: blueprint.sha256,
    designReviewManifestSha256: designManifest.sha256,
    documentRevision: document.revision,
    documentSha256: document.sha256,
    documentKind: document.kind,
  }
}

function areaTargetProjection(document: UnknownRecord): UnknownRecord[] {
  const projected = documentAreas(document).map((area) => ({
    id: area.id,
    blueprintAreaId: area.blueprintAreaId ?? null,
    target: isRecord(area.target)
      ? structuredClone(area.target)
      : { meshIndex: area.meshIndex, nodeName: area.nodeName },
    surfaceMode: area.surfaceMode,
    side: area.side ?? null,
    range: structuredClone(area.range),
    remap: area.remap === undefined ? null : structuredClone(area.remap),
    placementPolicy: area.placementPolicy ?? (area.artboard === undefined ? null : 'block'),
    canvas: area.canvas === undefined ? null : structuredClone(area.canvas),
    axisMin: area.axisMin ?? null,
    axisMax: area.axisMax ?? null,
  }))
  return stableSortById(projected.map((area) => ({ ...area, id: String(area.id) })))
}

function assertResolvedDocumentMapping(source: UnknownRecord, resolved: UnknownRecord): void {
  if (source.version === 3) {
    if (!sameProjection(areaTargetProjection(source), areaTargetProjection(resolved))) {
      workflowError('STALE_APPROVAL', 'Resolved Project mapping differs from the reviewed Project', 'reviewManifest.resolvedProject')
    }
    return
  }
  const resolvedById = new Map(documentAreas(resolved).map((area) => [area.id, area]))
  if (resolvedById.size !== documentAreas(source).length) {
    workflowError('STALE_APPROVAL', 'Resolved Project area set differs from the reviewed Spec', 'reviewManifest.resolvedProject')
  }
  for (const area of documentAreas(source)) {
    const live = resolvedById.get(area.id)
    if (!live) workflowError('STALE_APPROVAL', 'Resolved Project is missing a reviewed Spec area', 'reviewManifest.resolvedProject')
    const sourcePolicy = area.placementPolicy ?? (area.artboard === undefined ? null : 'block')
    const livePolicy = live.placementPolicy ?? (live.artboard === undefined ? null : 'block')
    if (area.blueprintAreaId !== live.blueprintAreaId
      || area.surfaceMode !== live.surfaceMode
      || area.side !== live.side
      || sourcePolicy !== livePolicy
      || !sameProjection(area.range, live.range)) {
      workflowError('STALE_APPROVAL', 'Resolved Project mapping differs from the reviewed Spec', 'reviewManifest.resolvedProject')
    }
    const target = isRecord(area.target) ? area.target : {}
    if ((typeof target.meshIndex === 'number' && target.meshIndex !== live.meshIndex)
      || (typeof target.nodeName === 'string' && target.nodeName !== live.nodeName)) {
      workflowError('STALE_APPROVAL', 'Resolved Project target differs from the reviewed Spec selector', 'reviewManifest.resolvedProject')
    }
    if (typeof target.stableSelector === 'string') {
      const match = /^mesh:(\d+)\/node:(\d+)$/.exec(target.stableSelector)
      if (!match || Number(match[1]) !== live.meshIndex) {
        workflowError('STALE_APPROVAL', 'Resolved Project target differs from the reviewed stable selector', 'reviewManifest.resolvedProject')
      }
    }
    if (isRecord(area.remap)) {
      const remap = isRecord(live.remap) ? live.remap : {}
      for (const key of ['wrap', 'offset', 'mirrorU'] as const) {
        if (area.remap[key] !== undefined && area.remap[key] !== remap[key]) {
          workflowError('STALE_APPROVAL', 'Resolved Project remap differs from the reviewed Spec', 'reviewManifest.resolvedProject')
        }
      }
      if (area.remap.mode !== undefined && area.remap.mode !== 'auto' && area.remap.mode !== remap.mode) {
        workflowError('STALE_APPROVAL', 'Resolved Project mapping mode differs from the reviewed Spec', 'reviewManifest.resolvedProject')
      }
    }
  }
}

async function areaTargetsSha256(document: UnknownRecord): Promise<string> {
  return sha256Canonical({ areas: areaTargetProjection(document) })
}

export async function computeAreaTargetsSha256(document: unknown): Promise<string> {
  if (!isRecord(document)) {
    return workflowError('APPROVAL_REQUIRED', 'Current Spec/Project must be a JSON object', 'currentDocument')
  }
  const validate = document.version === 2
    ? validateWorkflowLabelSpecSchema
    : document.version === 3 ? validateWorkflowProjectSchema : undefined
  if (!validate || !validate(document)) {
    return workflowError('APPROVAL_REQUIRED', 'Current Spec/Project is not contract-valid', 'currentDocument')
  }
  assertDocumentAreaIdentity(document)
  return areaTargetsSha256(document)
}

function assertReviewManifestAreas(manifest: ReviewManifestV1, document: UnknownRecord): void {
  if (!sameProjection(manifestAreaProjection(manifest.areas), currentDocumentManifestAreas(document))) {
    workflowError('STALE_APPROVAL', 'Production review manifest area bindings are stale', 'reviewManifest.areas')
  }
}

export async function verifyProductionGate(input: ProductionGateInput): Promise<ProductionGateResult> {
  const design = await verifyDesignGate({
    handoff: input.handoff,
    blueprint: input.blueprint,
    designReviewManifest: input.designReviewManifest,
    designReviewArtifacts: input.designReviewArtifacts,
    currentDocument: input.currentDocument,
    ...(input.designApprovalRecord === undefined ? {} : { approvalRecord: input.designApprovalRecord }),
  })
  const [blueprint, designManifest, document, productionManifest] = await Promise.all([
    readBlueprintEvidence(input.blueprint),
    readDesignManifestEvidence(input.designReviewManifest),
    readDocumentEvidence(input.currentDocument),
    readProductionManifestEvidence(input.productionReviewManifest),
  ])
  const resolvedProject = await verifyArtifactEvidence(input.productionReviewArtifacts, productionManifest, 'production')
  if (!resolvedProject) {
    return workflowError('DIGEST_MISMATCH', 'Production review does not bind the exact resolved Project', 'productionReviewArtifacts')
  }
  if (design.blueprintRevision !== blueprint.value.revision
    || design.blueprintSha256 !== blueprint.sha256
    || design.designReviewManifestSha256 !== designManifest.sha256
    || design.documentRevision !== document.revision
    || design.documentSha256 !== document.sha256) {
    return workflowError('STALE_APPROVAL', 'Design evidence changed during production gate verification', 'designGate.evidence')
  }
  const manifest = productionManifest.value
  if (manifest.input.kind !== document.kind || manifest.input.revision !== document.revision || manifest.input.sha256 !== document.sha256) {
    return workflowError('STALE_APPROVAL', 'Production review input binding is stale', 'reviewManifest.input')
  }
  if (manifest.blueprint.revision !== blueprint.value.revision || manifest.blueprint.sha256 !== blueprint.sha256) {
    return workflowError('STALE_APPROVAL', 'Production review blueprint binding is stale', 'reviewManifest.blueprint')
  }
  if (manifest.designReviewManifest.sha256 !== designManifest.sha256) {
    return workflowError('STALE_APPROVAL', 'Production review design-review binding is stale', 'reviewManifest.designReviewManifest')
  }
  if (manifest.model.fingerprint !== input.modelFingerprint) {
    return workflowError('STALE_APPROVAL', 'Production review model binding is stale', 'reviewManifest.model')
  }
  assertReviewManifestAreas(manifest, document.value)
  assertDocumentDesignBindings(resolvedProject.value, blueprint, designManifest.sha256)
  assertCurrentDocumentDesign(resolvedProject.value, blueprint.value)
  assertResolvedDocumentMapping(document.value, resolvedProject.value)
  const targetDigest = await areaTargetsSha256(document.value)
  if (manifest.areaTargetsSha256 !== targetDigest) {
    return workflowError('STALE_APPROVAL', 'Production review area-target digest is stale', 'reviewManifest.areaTargetsSha256')
  }

  const approval = validateWorkflowApprovalRecord(input.approvalRecord, 'production')
  if (approval.mode === 'continuous_authorized' && design.status !== 'continuous_authorized') {
    return workflowError('APPROVAL_REQUIRED', 'Production continuous authorization requires current design authorization', 'approval.mode')
  }
  if (!approval.spec_revision || !approval.model_fingerprint || !approval.area_targets_sha256) {
    return workflowError('APPROVAL_REQUIRED', 'Production approval record is missing current production bindings', 'approval.productionBindings')
  }
  if (approval.design_revision !== blueprint.value.revision) {
    return workflowError('STALE_APPROVAL', 'Production approval design revision is stale', 'approval.designRevision')
  }
  if (approval.blueprint_sha256 !== blueprint.sha256) {
    return workflowError('STALE_APPROVAL', 'Production approval blueprint digest is stale', 'approval.blueprintSha256')
  }
  if (approval.spec_revision !== document.revision) {
    return workflowError('STALE_APPROVAL', 'Production approval Spec/Project revision is stale', 'approval.specRevision')
  }
  if (approval.model_fingerprint !== input.modelFingerprint) {
    return workflowError('STALE_APPROVAL', 'Production approval model fingerprint is stale', 'approval.modelFingerprint')
  }
  if (approval.area_targets_sha256 !== targetDigest) {
    return workflowError('STALE_APPROVAL', 'Production approval area-target digest is stale', 'approval.areaTargetsSha256')
  }
  if (approval.review_manifest_sha256 !== productionManifest.sha256) {
    return workflowError('STALE_APPROVAL', 'Production approval review-manifest digest is stale', 'approval.reviewManifestSha256')
  }
  return {
    ...design,
    status: approval.mode === 'continuous_authorized' ? 'continuous_authorized' : 'approved',
    inputRevision: document.revision,
    inputSha256: document.sha256,
    modelFingerprint: input.modelFingerprint,
    areaTargetsSha256: targetDigest,
    productionReviewManifestSha256: productionManifest.sha256,
  }
}

function sortedLayerProjection(
  blueprint: LayoutBlueprintV1,
  project: (area: LayoutBlueprintArea, layer: LayoutBlueprintLayer) => unknown,
): unknown[] {
  return stableSortById(blueprint.areas).flatMap((area) => stableSortById(area.layers).map((layer) => ({
    areaId: area.id, layerId: layer.id, value: project(area, layer),
  })))
}

function designProjections(blueprint: LayoutBlueprintV1): Record<string, unknown> {
  return {
    'design:blueprint-revision': blueprint.revision,
    'design:copy': sortedLayerProjection(blueprint, (_area, layer) => layer.kind === 'text' ? layer.text : null),
    'design:hierarchy': stableSortById(blueprint.areas).map((area) => ({
      areaId: area.id,
      layers: canonicalLayerOrder(area.layers)
        .map((layer) => ({ id: layer.id, kind: layer.kind, zIndex: layer.zIndex, visible: layer.visible })),
    })),
    'design:layout': {
      areas: stableSortById(blueprint.areas).map((area) => ({
        id: area.id, side: area.side, artboard: area.artboard,
        placementIntent: area.placementIntent, placementPolicy: area.placementPolicy ?? 'block',
      })),
      layers: sortedLayerProjection(blueprint, (_area, layer) => ({
        boundsMm: layer.boundsMm ?? null, normalizedBounds: layer.normalizedBounds ?? null,
        anchor: layer.anchor, rotation: layer.rotation, shape: layer.shape ?? null, points: layer.points ?? null,
        pathData: layer.pathData ?? null, pathViewBox: layer.pathViewBox ?? null,
        fillRule: layer.fillRule ?? null, strokeWidthMm: layer.strokeWidthMm ?? null,
        cornerRadiusMm: layer.cornerRadiusMm ?? null,
      })),
    },
    'design:color': sortedLayerProjection(blueprint, (_area, layer) => ({
      opacity: layer.opacity, color: layer.color ?? null, fill: layer.fill ?? null, stroke: layer.stroke ?? null,
    })),
    'design:typography': sortedLayerProjection(blueprint, (_area, layer) => layer.kind === 'text' ? {
      language: layer.language, writingDirection: layer.writingDirection, fontAsset: layer.fontAsset ?? null,
      fontStack: layer.fontStack ?? null, fontSizeMm: layer.fontSizeMm, fontWeight: layer.fontWeight,
      letterSpacingEm: layer.letterSpacingEm, lineHeight: layer.lineHeight, alignment: layer.alignment,
      wrapPolicy: layer.wrapPolicy, maxLines: layer.maxLines,
    } : null),
    'design:carrier': {
      defaults: blueprint.carrierDefaults,
      areas: stableSortById(blueprint.areas).map((area) => ({ id: area.id, carrier: area.carrier, substrate: area.substrate ?? null })),
    },
    'design:process': sortedLayerProjection(blueprint, (_area, layer) => layer.processes),
    'design:assets': {
      assets: stableSortById(blueprint.assets),
      layers: sortedLayerProjection(blueprint, (_area, layer) => ({
        assetId: layer.assetId ?? null, fit: layer.fit ?? null, flattenedFallback: layer.flattenedFallback ?? null,
      })),
    },
  }
}

function canonicalProductionAssets(values: WorkflowRevisionSnapshot['productionAssets']): unknown[] {
  return stableSortById((values ?? []).map((value) => structuredClone(value)))
}

export function classifyRevisionChange(input: {
  approved: WorkflowRevisionSnapshot
  current: WorkflowRevisionSnapshot
}): RevisionClassification {
  const reasons = new Set<string>()
  const approvedDesign = designProjections(input.approved.blueprint)
  const currentDesign = designProjections(input.current.blueprint)
  for (const reason of Object.keys(approvedDesign).sort()) {
    if (!sameProjection(approvedDesign[reason], currentDesign[reason])) reasons.add(reason)
  }
  if (!sameProjection(input.approved.designReviewManifest ?? null, input.current.designReviewManifest ?? null)) {
    reasons.add('design:evidence')
  }
  const approvedDocument = isRecord(input.approved.document) ? input.approved.document : {}
  const currentDocument = isRecord(input.current.document) ? input.current.document : {}
  try {
    if (!sameProjection(
      canonicalDocumentDesignProjection(approvedDocument, input.approved.blueprint),
      canonicalDocumentDesignProjection(currentDocument, input.current.blueprint),
    )) reasons.add('design:document')
  } catch {
    // A classifier must keep its exact union return contract while failing
    // unrepresentable snapshots closed as a design invalidation.
    reasons.add('design:document')
  }
  if (!sameProjection(areaTargetProjection(approvedDocument), areaTargetProjection(currentDocument))) {
    reasons.add('production:area-targets')
  }
  if (input.approved.modelFingerprint !== input.current.modelFingerprint) reasons.add('production:model-fingerprint')
  if (!sameProjection(canonicalProductionAssets(input.approved.productionAssets), canonicalProductionAssets(input.current.productionAssets))) {
    reasons.add('production:capture-assets')
  }
  if (!sameProjection(input.approved.productionReviewManifest ?? null, input.current.productionReviewManifest ?? null)) {
    reasons.add('production:review-manifest')
  }
  const sortedReasons = [...reasons].sort()
  if (sortedReasons.length === 0) return { valid: true, invalidates: 'none' }
  return sortedReasons.some((reason) => reason.startsWith('design:'))
    ? { valid: false, invalidates: 'design', reasons: sortedReasons }
    : { valid: false, invalidates: 'production', reasons: sortedReasons }
}

export {
  approvalRecordV1Schema,
  designReviewManifestV1Schema,
  editorHandoffV2Schema,
  layoutBlueprintV1Schema,
  reviewManifestV1Schema,
}
