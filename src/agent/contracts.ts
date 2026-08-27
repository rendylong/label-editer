/** Stable, structured-clone-safe contracts shared by browser Agent clients. */

export type AgentErrorCode =
  | 'INVALID_USAGE'
  | 'AWAITING_USER_APPROVAL'
  | 'APPROVAL_REQUIRED'
  | 'HANDOFF_BLOCKED'
  | 'DIGEST_MISMATCH'
  | 'STALE_APPROVAL'
  | 'UNREPRESENTABLE_LAYER'
  | 'PATH_NOT_ALLOWED'
  | 'OUTPUT_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'INVALID_PATCH_OPERATION'
  | 'INVALID_LABEL_SPEC'
  | 'AMBIGUOUS_MODEL_TARGET'
  | 'MODEL_TARGET_NOT_FOUND'
  | 'BROWSER_NOT_READY'
  | 'REBUILD_FAILED'
  | 'UNSUPPORTED_CODEC'
  | 'INTERNAL_ERROR'

export interface AgentError {
  code: AgentErrorCode
  message: string
  path?: string
  details?: Record<string, unknown>
  suggestion?: string
}

export type AgentEnvelope<T> =
  | {
      ok: true
      operation: string
      sessionId?: string
      data: T
      warnings: string[]
    }
  | {
      ok: false
      operation: string
      sessionId?: string
      error: AgentError
      warnings: string[]
    }

export interface ArtifactDescriptor {
  id: string
  fileName: string
  mimeType: string
  url: string
  byteLength: number
  sha256?: string
  width?: number
  height?: number
  areaId?: string
  channel?: 'color' | 'metalness' | 'roughness' | 'bump' | 'white_underbase' | 'preview'
}

export type QcChannel = 'color' | 'metalness' | 'roughness' | 'bump'
export type QcDiagnosticChannel = Exclude<QcChannel, 'color'>
export type QcVector3 = [number, number, number]

export type QcTarget =
  | { kind: 'model' }
  | { kind: 'area'; areaId: string }

export type QcPose =
  | { kind: 'direction'; direction: QcVector3 }
  | { kind: 'area-face' }
  | { kind: 'area-craft' }

export interface QcCustomView {
  id: string
  direction: QcVector3
  target: 'model' | string
  framing: 'fit-model' | 'fit-area'
  channel: QcChannel
}

export interface QcEvidenceRequest {
  preset?: 'qc-standard'
  width?: number
  height?: number
  customViews?: QcCustomView[]
}

export interface QcViewRequest {
  id: string
  target: QcTarget
  framing: 'fit-model' | 'fit-area'
  pose: QcPose
  channel: QcChannel
  width: number
  height: number
  areaId?: string
  reason: string
}

export interface QcCameraMetadata {
  position: QcVector3
  direction: QcVector3
  target: QcVector3
  up: QcVector3
  fov: number
}

export interface QcViewResult {
  artifact: ArtifactDescriptor
  view: QcViewRequest
  camera: QcCameraMetadata
}

export interface QcAreaEvidence {
  areaId: string
  meshIndex: number
  nodeName: string
  side?: 'front' | 'back' | 'left' | 'right' | 'wrap' | 'top' | 'bottom' | 'neck' | 'custom'
  surfaceMode: 'overlay' | 'replace'
  requiredChannels: QcDiagnosticChannel[]
  viewIds: string[]
}

export interface QcEvidenceResult {
  preset: 'qc-standard'
  views: QcViewResult[]
  areas: QcAreaEvidence[]
  validation: DesignValidationReport
}

export type ReviewViewKind = 'flat-artwork' | 'surface-face' | 'model-front' | 'model-back' | 'review-sheet'

export interface ReviewDesignGateEvidence {
  handoff: unknown
  blueprintJson: string
  designReviewManifestJson: string
  approvalRecord?: unknown
}

export interface ReviewEvidenceRequest {
  width?: number
  height?: number
  designGate: ReviewDesignGateEvidence
}

export interface ReviewViewRequest {
  id: string
  kind: ReviewViewKind
  width: number
  height: number
  areaId?: string
  areaToken?: string
  side?: 'front' | 'back' | 'left' | 'right' | 'wrap' | 'top' | 'bottom' | 'neck' | 'custom'
  carrier?: import('./designContracts').CarrierMode
  sourceViewIds?: string[]
}

export interface ReviewViewResult {
  id: string
  kind: ReviewViewKind
  areaId?: string
  carrier?: import('./designContracts').CarrierMode
  artifact: ArtifactDescriptor
  camera?: QcCameraMetadata
}

export interface ReviewEvidenceResult {
  inputKind: 'label-spec-v2' | 'label-project-v3'
  inputRevision: string
  inputSha256: string
  blueprintRevision: string
  blueprintSha256: string
  designReviewManifestSha256: string
  modelFingerprint: string
  areaTargetsSha256: string
  views: ReviewViewResult[]
  validation: DesignValidationReport
  fidelity: import('./fidelityCheck').FidelityReport
}

export interface ModelLoadRequest {
  name: string
  url: string
}

export interface MeshInspection {
  stableSelector: string
  meshIndex: number
  nodeIndex: number
  nodeName: string
  materialNames: string[]
  mappingMode: 'cylindrical' | 'planar'
  labelCandidate: boolean
  warnings: string[]
}

export interface ModelInspection {
  name: string
  fingerprint?: string
  dimensions?: { width: number; height: number; depth: number }
  meshes: MeshInspection[]
  partTree: unknown[]
  codec: {
    sourceCompressed: boolean
    normalized: boolean
    outputCompressed: boolean
    extensions: string[]
  }
  warnings: string[]
}

export interface ApplySpecRequest {
  spec: unknown
  assetUrls?: Record<string, string>
}

export interface ApplyProjectRequest {
  project: unknown
}

export interface AgentPreviewStatus {
  revision: string
  state: 'ready' | 'error'
  message?: string
}

export interface AppliedDesign {
  areaIds: string[]
  project: SerializedProject
  warnings: string[]
}

export type SerializedProject = Record<string, unknown>

export interface DesignValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  path?: string
  areaId?: string
  layerId?: string
  field?: string
}

export interface DesignValidationReport {
  ready: boolean
  issues: DesignValidationIssue[]
}

export interface ReadinessRequest {
  timeoutMs?: number
}

export interface ReadinessReport extends DesignValidationReport {
  fontsReady: boolean
  imagesReady: boolean
  bakesReady: boolean
}

export interface PreviewRequest {
  view?: '2d' | 'split' | '3d'
  channel?: 'color' | 'metalness' | 'roughness' | 'bump'
  width?: number
  height?: number
}

export interface ExportRequest {
  artifacts?: Array<'glb' | 'project' | 'normalized-spec' | 'print-manifest' | 'preview' | 'channels'>
  preview?: PreviewRequest
}

export interface ExportManifest {
  artifacts: ArtifactDescriptor[]
  validation: DesignValidationReport
  glbCrossCheck?: {
    loaded: boolean
    uvSampleOk: boolean
    error?: string
  }
  warnings: string[]
}

export type BridgeResult<T = void> = AgentEnvelope<T>

export interface LabelEditorAgentBridgeV1 {
  reset(): Promise<BridgeResult>
  loadModel(input: ModelLoadRequest): Promise<BridgeResult<ModelInspection>>
  applySpec(input: ApplySpecRequest): Promise<BridgeResult<AppliedDesign>>
  applyProject(input: ApplyProjectRequest): Promise<BridgeResult<AppliedDesign>>
  setAgentPreviewStatus(input: AgentPreviewStatus): Promise<BridgeResult>
  getProject(): Promise<BridgeResult<SerializedProject>>
  validateDesign(): Promise<BridgeResult<DesignValidationReport>>
  waitForReady(input?: ReadinessRequest): Promise<BridgeResult<ReadinessReport>>
  renderPreview(input?: PreviewRequest): Promise<BridgeResult<ArtifactDescriptor>>
  renderQcEvidence(input?: QcEvidenceRequest): Promise<BridgeResult<QcEvidenceResult>>
  renderReviewEvidence(input: ReviewEvidenceRequest): Promise<BridgeResult<ReviewEvidenceResult>>
  exportArtifacts(input: ExportRequest): Promise<BridgeResult<ExportManifest>>
}

export function agentSuccess<T>(
  operation: string,
  data: T,
  warnings: string[] = [],
  sessionId?: string,
): AgentEnvelope<T> {
  return { ok: true, operation, ...(sessionId ? { sessionId } : {}), data, warnings }
}

export function agentFailure(
  operation: string,
  code: AgentErrorCode,
  message: string,
  options: Omit<AgentError, 'code' | 'message'> & { warnings?: string[]; sessionId?: string } = {},
): Extract<AgentEnvelope<never>, { ok: false }> {
  const { warnings = [], sessionId, ...errorOptions } = options
  return {
    ok: false,
    operation,
    ...(sessionId ? { sessionId } : {}),
    error: { code, message, ...errorOptions },
    warnings,
  }
}

export function exitCodeForError(error: AgentError): number {
  if (error.code === 'INVALID_USAGE') return 2
  if (error.code === 'PATH_NOT_ALLOWED') return 3
  if (error.code === 'INVALID_LABEL_SPEC') return 4
  if (error.code === 'AMBIGUOUS_MODEL_TARGET' || error.code === 'MODEL_TARGET_NOT_FOUND') return 5
  if (error.code === 'BROWSER_NOT_READY') return 6
  if (error.code === 'REBUILD_FAILED') return 7
  if (error.code === 'UNSUPPORTED_CODEC') return 8
  if (error.code === 'OUTPUT_CONFLICT') return 9
  if (error.code === 'REVISION_CONFLICT') return 10
  if (error.code === 'INVALID_PATCH_OPERATION') return 11
  return 1
}
