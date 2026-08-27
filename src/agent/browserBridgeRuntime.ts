import { applyStructuredLabelSpec } from '../app/labelSpec'
import { assertPhysicalAreaPlacement } from '../app/physicalLayout'
import { computeLabelSetup, loadModelFromBytes } from '../app/modelLoader'
import { parseLabelProject, serializeLabelProject } from '../app/projectSchema'
import { restoreImportedAreaRuntime } from '../app/projectImportRuntime'
import { extractMeshAccessors, isMeshWorldMirrored, meshLocalFrontDirection, readGlb } from '../glb/analyze'
import { makeDefaultRemap } from '../glb/uvRemap'
import type { LabelAreaConfig, LabelLayer } from '../label/types'
import { designAssetReadinessKey, isBakeAssetReadyForArea } from '../label/exportReadiness'
import { validatePrintReadiness } from '../label/printReadiness'
import { useLabelStore, useModelStore, useUiStore } from '../state/stores'
import { createExportBundle, type BrowserArtifact } from './artifactExport'
import { createAgentBridge, type AgentBridgeBootstrap } from './bridge'
import {
  captureAgentPreview,
  captureAgentQcView,
  captureAgentReviewView,
  validatedReviewPngBytes,
  type AgentReviewCaptureSource,
} from './previewCapture'
import { inspectModel } from './modelInspection'
import { validateLabelSpec, type LabelSpecAreaV2, type LabelSpecV2 } from './labelSpecSchema'
import { buildQcCapturePlan, craftChannelsForArea } from './qcCapturePlan'
import { assertReviewEncodedByteBudget, buildReviewCapturePlan } from './reviewCapturePlan'
import {
  computeAreaTargetsSha256,
  validateLayoutBlueprint,
  verifyDesignGate,
  type LayoutBlueprintV1,
} from './designContracts'
import { compareBlueprintFidelity, type FidelityReport } from './fidelityCheck'
import { sha256HexSync } from './syncSha256'
import { resolveTarget } from './targetResolver'
import { applyPreparedAreaTransaction } from './transactionalApply'
import type {
  ArtifactDescriptor,
  DesignValidationIssue,
  DesignValidationReport,
  ExportManifest,
  LabelEditorAgentBridgeV1,
  QcAreaEvidence,
  QcChannel,
  QcViewRequest,
  QcViewResult,
  ReviewEvidenceRequest,
  ReviewViewRequest,
  ReviewViewResult,
} from './contracts'
import type { BakeResult } from '../state/stores'

function sleepFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

type QcValidationIssue = DesignValidationIssue & {
  channel?: QcChannel
  component?: 'areas' | 'bakes' | 'model'
  stage?: string
}

function structuredInvalidLabelSpec(issues: QcValidationIssue[]): Error {
  const error = new Error(issues.map((issue) => [issue.code, issue.areaId, issue.channel].filter(Boolean).join(':')).join('; ')) as Error & {
    code: string
    details: { issues: QcValidationIssue[] }
  }
  error.code = 'INVALID_LABEL_SPEC'
  error.details = { issues }
  return error
}

function staleQcState(stage: string, component: QcValidationIssue['component'], areaId?: string): Error {
  const issue: QcValidationIssue = {
    severity: 'error',
    code: 'qc-stale-state',
    message: `Label design state changed during QC capture (${stage})`,
    ...(areaId ? { areaId } : {}),
    component,
    stage,
  }
  const error = new Error(issue.message) as Error & {
    code: string
    details: { issues: QcValidationIssue[] }
  }
  error.code = 'REVISION_CONFLICT'
  error.details = { issues: [issue] }
  return error
}

function boundedDimension(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 4096) {
    const error = new Error('QC capture dimensions must be integers from 1 through 4096') as Error & { code: string }
    error.code = 'INVALID_USAGE'
    throw error
  }
  return value
}

function assertValidationReady(validation: DesignValidationReport): void {
  const errors = validation.issues.filter((issue) => issue.severity === 'error')
  if (errors.length > 0) throw structuredInvalidLabelSpec(errors)
}

function assertPlannedAreasPresent(plan: QcViewRequest[], areas: LabelAreaConfig[]): void {
  const present = new Set(areas.map((area) => area.id))
  const missing = [...new Set(plan.flatMap((request) => request.areaId && !present.has(request.areaId) ? [request.areaId] : []))]
  if (missing.length === 0) return
  throw structuredInvalidLabelSpec(missing.map((areaId) => ({
    severity: 'error',
    code: 'qc-missing-area',
    message: `QC capture area is missing: ${areaId}`,
    areaId,
  })))
}

interface QcStateSnapshot {
  areas: readonly LabelAreaConfig[]
  bakes: ReadonlyMap<string, BakeResult>
  glbBytes: Uint8Array
  modelName: string
}

function snapshotQcState(): QcStateSnapshot {
  const labels = useLabelStore.getState()
  const model = useModelStore.getState()
  if (!model.glbBytes) throw staleQcState('snapshot', 'model')
  const bakes = new Map<string, BakeResult>()
  for (const area of labels.areas) {
    const bake = labels.bakeMap[area.id]
    if (!bake || bake.areaOwner !== area) throw staleQcState('snapshot', 'bakes', area.id)
    bakes.set(area.id, bake)
  }
  return {
    areas: [...labels.areas],
    bakes,
    glbBytes: model.glbBytes,
    modelName: model.modelName,
  }
}

function assertQcStateUnchanged(snapshot: QcStateSnapshot, stage: string): void {
  const model = useModelStore.getState()
  if (model.glbBytes !== snapshot.glbBytes || model.modelName !== snapshot.modelName) {
    throw staleQcState(stage, 'model')
  }
  const labels = useLabelStore.getState()
  if (labels.areas.length !== snapshot.areas.length) {
    const changedArea = snapshot.areas.find((area) => !labels.areas.includes(area))
    throw staleQcState(stage, 'areas', changedArea?.id)
  }
  for (let index = 0; index < snapshot.areas.length; index += 1) {
    const area = snapshot.areas[index]
    if (labels.areas[index] !== area) throw staleQcState(stage, 'areas', area.id)
    if (labels.bakeMap[area.id] !== snapshot.bakes.get(area.id)) throw staleQcState(stage, 'bakes', area.id)
  }
}

function canvasHasContribution(canvas: HTMLCanvasElement, neutral: number): boolean {
  if (canvas.width < 1 || canvas.height < 1) return false
  const context = canvas.getContext('2d')
  if (!context) return false
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] !== neutral || pixels[offset + 1] !== neutral || pixels[offset + 2] !== neutral) return true
  }
  return false
}

function assertCraftChannelContributions(
  areas: LabelAreaConfig[],
  bakeMap: Record<string, BakeResult>,
  plan: QcViewRequest[],
): void {
  const areaIds = new Set(areas.map((area) => area.id))
  const checked = new Set<string>()
  const neutrals: Record<Exclude<QcChannel, 'color'>, number> = {
    metalness: 0,
    roughness: 255,
    bump: 128,
  }
  for (const request of plan) {
    if (!request.areaId || request.channel === 'color') continue
    const key = `${request.areaId}:${request.channel}`
    if (checked.has(key)) continue
    checked.add(key)
    const bake = areaIds.has(request.areaId) ? bakeMap[request.areaId] : undefined
    const canvas = bake?.[request.channel]
    if (canvas && canvasHasContribution(canvas, neutrals[request.channel])) continue
    throw structuredInvalidLabelSpec([{
      severity: 'error',
      code: 'qc-empty-craft-channel',
      message: `QC craft channel has no baked contribution: ${request.areaId}/${request.channel}`,
      areaId: request.areaId,
      channel: request.channel,
    }])
  }
}

function qcAreaEvidence(areas: LabelAreaConfig[], views: QcViewResult[]): QcAreaEvidence[] {
  return areas.map((area) => ({
    areaId: area.id,
    meshIndex: area.meshIndex,
    nodeName: area.nodeName,
    ...(area.side ? { side: area.side } : {}),
    surfaceMode: area.surfaceMode ?? 'overlay',
    requiredChannels: craftChannelsForArea(area),
    viewIds: views.filter((result) => result.view.areaId === area.id).map((result) => result.view.id),
  }))
}

async function buildAreasFromSpec(spec: LabelSpecV2, assetUrls: Record<string, string>): Promise<LabelAreaConfig[]> {
  const model = useModelStore.getState()
  if (!model.glbBytes) throw new Error('No model is loaded')
  const [doc, inspection] = await Promise.all([
    readGlb(model.glbBytes),
    inspectModel(model.glbBytes, model.modelName),
  ])
  const areas: LabelAreaConfig[] = []
  for (const areaSpec of spec.areas) {
    const target = resolveTarget(areaSpec.target, inspection.meshes)
    const mesh = extractMeshAccessors(doc, target.meshIndex)
    const params = makeDefaultRemap(
      mesh,
      isMeshWorldMirrored(doc, target.meshIndex),
      meshLocalFrontDirection(doc, target.meshIndex),
    )
    const requestedRemap = areaSpec.remap as { mode?: 'auto' | 'cylindrical' | 'planar'; wrap?: number; offset?: number; mirrorU?: boolean } | undefined
    if (requestedRemap?.mode && requestedRemap.mode !== 'auto') params.mode = requestedRemap.mode
    if (requestedRemap?.wrap !== undefined) params.wrap = requestedRemap.wrap
    if (requestedRemap?.offset !== undefined) params.offset = requestedRemap.offset
    if (requestedRemap?.mirrorU !== undefined) params.mirrorU = requestedRemap.mirrorU
    if (areaSpec.side === 'back' && requestedRemap?.offset === undefined) params.offset = (params.offset + 0.5) % 1
    const setup = computeLabelSetup(mesh, params, areaSpec.range, areaSpec.surfaceMode)
    const base: LabelAreaConfig = {
      id: areaSpec.id,
      name: areaSpec.name,
      meshIndex: target.meshIndex,
      nodeName: target.nodeName,
      surfaceMode: areaSpec.surfaceMode,
      side: areaSpec.side,
      remap: params,
      range: areaSpec.range,
      canvas: setup.spec,
      axisMin: setup.axisMin,
      axisMax: setup.axisMax,
      layers: [],
      globalCraft: { craft: [] },
      fonts: [],
      referenceVisible: false,
      undoStack: [],
      redoStack: [],
    }
    const mapped = applyStructuredLabelSpec(base, { version: 2, areas: [areaSpec] }, areaSpec.id).areas[0]
    const sourceLayers = areaSpec.layers
    const layers = mapped.layers.map((layer, index): LabelLayer => {
      if (layer.kind !== 'image') return layer
      const source = sourceLayers[index] as { asset?: string }
      return { ...layer, src: source.asset ? assetUrls[source.asset] ?? source.asset : layer.src }
    })
    areas.push({
      ...mapped,
      id: areaSpec.id,
      meshIndex: target.meshIndex,
      nodeName: target.nodeName,
      surfaceMode: areaSpec.surfaceMode,
      side: areaSpec.side,
      remap: params,
      range: areaSpec.range,
      canvas: setup.spec,
      axisMin: setup.axisMin,
      axisMax: setup.axisMax,
      layers,
      globalCraft: { craft: Array.isArray(areaSpec.globalCraft) ? areaSpec.globalCraft as never : [] },
    })
  }
  return areas
}

function designValidation(): { ready: boolean; issues: DesignValidationIssue[] } {
  const areas = useLabelStore.getState().areas
  const issues: DesignValidationIssue[] = []
  if (areas.length === 0) issues.push({ severity: 'error', code: 'no-label-areas', message: 'No label areas exist' })
  for (const area of areas) {
    for (const issue of validatePrintReadiness(area)) {
      issues.push({
        severity: issue.severity ?? 'warning',
        code: issue.code,
        message: issue.message,
        areaId: area.id,
        ...(issue.layerId ? { layerId: issue.layerId } : {}),
        ...(issue.field ? { field: issue.field } : {}),
      })
    }
  }
  return { ready: !issues.some((issue) => issue.severity === 'error'), issues }
}

async function waitForBakes(
  timeoutMs = 30_000,
  includeArea: (area: LabelAreaConfig) => boolean = () => true,
): Promise<void> {
  const started = performance.now()
  const areas = useLabelStore.getState().areas.filter(includeArea)
  const glbBytes = useModelStore.getState().glbBytes
  if (!glbBytes) throw new Error('No model is loaded')
  if (areas.length === 0) return
  for (const original of areas) {
    const runtime = await restoreImportedAreaRuntime(glbBytes, original)
    const beforeActivation = useLabelStore.getState()
    const previousBake = beforeActivation.bakeMap[original.id]
    const requiresPostActivationBake = beforeActivation.activeAreaId !== original.id
    useLabelStore.getState().activateArea(original.id)
    useLabelStore.getState().setAreaData(runtime.remapOutput, runtime.meshAccessors)
    await sleepFrame()
    while (true) {
      const state = useLabelStore.getState()
      const current = state.areas.find((area) => area.id === original.id)
      const bake = state.bakeMap[original.id]
      if (current && bake?.areaOwner === current
        && bake.color.width > 0 && bake.color.height > 0
        && isBakeAssetReadyForArea(current, bake)
        && (!requiresPostActivationBake || bake !== previousBake)) break
      if (performance.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for ${requiresPostActivationBake ? 'post-activation ' : ''}label bake: ${original.name}`)
      }
      await sleepFrame()
    }
  }

  const settledBakes = new Map<string, BakeResult>()
  let stableSince = performance.now()
  let stableFrames = 0
  while (true) {
    const state = useLabelStore.getState()
    let ready = true
    let changed = settledBakes.size !== areas.length
    for (const original of areas) {
      const current = state.areas.find((area) => area.id === original.id)
      const bake = state.bakeMap[original.id]
      if (!current || bake?.areaOwner !== current || bake.color.width < 1 || bake.color.height < 1
        || !isBakeAssetReadyForArea(current, bake)) {
        ready = false
        break
      }
      if (settledBakes.get(original.id) !== bake) changed = true
    }
    const now = performance.now()
    if (!ready) {
      settledBakes.clear()
      stableSince = now
      stableFrames = 0
    } else if (changed) {
      settledBakes.clear()
      for (const original of areas) settledBakes.set(original.id, state.bakeMap[original.id])
      stableSince = now
      stableFrames = 0
    } else if (isBakeSettleWindowReady(now - stableSince, ++stableFrames)) {
      return
    }
    if (now - started > timeoutMs) throw new Error('Timed out waiting for label bakes to settle')
    await sleepFrame()
  }
}

/** A long blocked frame is not evidence that debounced browser work has drained. */
export function isBakeSettleWindowReady(stableElapsedMs: number, stableFrames: number): boolean {
  return stableElapsedMs >= 350 && stableFrames >= 3
}

function reviewNotReady(stage: string, message: string, details: Record<string, unknown> = {}): Error {
  const error = new Error(message) as Error & { code: 'BROWSER_NOT_READY'; details: Record<string, unknown> }
  error.code = 'BROWSER_NOT_READY'
  error.details = { stage, ...details }
  return error
}

function currentReviewDocument(): { value: Record<string, unknown>; json: string } {
  const value = serializeLabelProject(
    useModelStore.getState().modelName,
    useLabelStore.getState().areas,
  ) as unknown as Record<string, unknown>
  return { value, json: JSON.stringify(value) }
}

function reviewEvidenceBytes(value: string): Uint8Array {
  return Uint8Array.from(new TextEncoder().encode(value))
}

interface ReviewStateSnapshot {
  documentJson: string
  modelName: string
  modelFingerprint: string
  bakes: Map<string, {
    value: BakeResult
    color: HTMLCanvasElement
    width: number
    height: number
    version: number
    areaOwner: LabelAreaConfig
    fontReadinessKey: string
    assetReadinessKey: string
  }>
}

function snapshotReviewState(): ReviewStateSnapshot {
  const labels = useLabelStore.getState()
  const model = useModelStore.getState()
  if (!model.glbBytes) throw reviewNotReady('snapshot', 'Review model is not loaded')
  const bakes: ReviewStateSnapshot['bakes'] = new Map()
  for (const area of labels.areas) {
    if (area.carrier === 'bare') continue
    const value = labels.bakeMap[area.id]
    if (!value || value.areaOwner !== area || value.color.width < 1 || value.color.height < 1
      || !isBakeAssetReadyForArea(area, value)) {
      throw reviewNotReady('snapshot', `Review bake is not current: ${area.id}`, { areaId: area.id })
    }
    bakes.set(area.id, {
      value, color: value.color, width: value.color.width, height: value.color.height,
      version: value.version, areaOwner: area, fontReadinessKey: value.fontReadinessKey ?? '',
      assetReadinessKey: value.assetReadinessKey ?? '',
    })
  }
  return {
    documentJson: currentReviewDocument().json,
    modelName: model.modelName,
    modelFingerprint: sha256HexSync(model.glbBytes),
    bakes,
  }
}

function assertReviewStateUnchanged(snapshot: ReviewStateSnapshot, stage: string): void {
  const model = useModelStore.getState()
  if (!model.glbBytes || model.modelName !== snapshot.modelName
    || sha256HexSync(model.glbBytes) !== snapshot.modelFingerprint
    || currentReviewDocument().json !== snapshot.documentJson) {
    throw reviewNotReady(stage, `Review input changed during capture (${stage})`)
  }
  const labels = useLabelStore.getState()
  for (const [areaId, expected] of snapshot.bakes) {
    const value = labels.bakeMap[areaId]
    if (value !== expected.value || value.color !== expected.color
      || value.color.width !== expected.width || value.color.height !== expected.height
      || value.version !== expected.version || value.areaOwner !== expected.areaOwner
      || (value.fontReadinessKey ?? '') !== expected.fontReadinessKey
      || (value.assetReadinessKey ?? '') !== expected.assetReadinessKey
      || value.assetReadinessKey !== designAssetReadinessKey(expected.areaOwner)) {
      throw reviewNotReady(stage, `Review bake changed during capture (${stage})`, { areaId })
    }
  }
}

function reviewValidation(): DesignValidationReport {
  const validation = designValidation()
  const issues = [...validation.issues]
  for (const area of useLabelStore.getState().areas) {
    if (area.carrier === 'bare' || !area.artboard) continue
    try {
      assertPhysicalAreaPlacement({
        ...area,
        placementPolicy: area.designBinding?.approvedCrop ? 'crop-approved' : 'block',
      })
    } catch (error) {
      issues.push({
        severity: 'error', code: 'target-aspect-mismatch', areaId: area.id,
        message: error instanceof Error ? error.message : String(error), field: 'placementPolicy',
      })
    }
  }
  return { ready: !issues.some((issue) => issue.severity === 'error'), issues }
}

function assertFidelityReady(fidelity: FidelityReport): void {
  if (!fidelity.pass) {
    throw reviewNotReady('fidelity', 'Current editable design does not match the approved blueprint', {
      issueCount: fidelity.issues.length,
      issues: fidelity.issues.slice(0, 32),
    })
  }
}

function isFiniteCamera(camera: unknown): boolean {
  if (!camera || typeof camera !== 'object') return false
  const value = camera as { position?: unknown; direction?: unknown; target?: unknown; up?: unknown; fov?: unknown }
  return [value.position, value.direction, value.target, value.up].every((vector) => (
    Array.isArray(vector) && vector.length === 3 && vector.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  )) && typeof value.fov === 'number' && Number.isFinite(value.fov) && value.fov > 0 && value.fov < 180
}

function assertReviewCaptureResult(
  request: ReviewViewRequest,
  result: Awaited<ReturnType<typeof captureAgentReviewView>>,
  resultIds: Set<string>,
): void {
  const key = typeof result?.id === 'string' ? result.id.normalize('NFKC').toLowerCase() : ''
  const requiresCamera = request.kind === 'surface-face' || request.kind === 'model-front' || request.kind === 'model-back'
  if (!result || result.id !== request.id || result.kind !== request.kind || resultIds.has(key)
    || result.width !== request.width || result.height !== request.height
    || !result.blob || result.blob.type !== 'image/png' || result.blob.size < 1
    || result.blob.size > 32 * 1024 * 1024
    || (requiresCamera ? !isFiniteCamera(result.camera) : result.camera !== undefined)) {
    throw reviewNotReady(`capture:${request.id}`, `Review capture result is missing, duplicate, stale, or malformed: ${request.id}`)
  }
  resultIds.add(key)
}

interface ReviewUiSnapshot {
  activeAreaId: string | null
  activeArea: LabelAreaConfig | null
  meshIndex: number | null
  nodeName: string
  remapOutput: ReturnType<typeof useLabelStore.getState>['remapOutput']
  meshAccessors: ReturnType<typeof useLabelStore.getState>['meshAccessors']
  selectedLayerIds: string[]
  selectedPartId: string | null
  channelView: ReturnType<typeof useUiStore.getState>['channelView']
  workspaceTab: ReturnType<typeof useUiStore.getState>['workspaceTab']
}

function snapshotReviewUi(): ReviewUiSnapshot {
  const labels = useLabelStore.getState()
  return {
    activeAreaId: labels.activeAreaId, activeArea: labels.activeArea,
    meshIndex: labels.meshIndex, nodeName: labels.nodeName,
    remapOutput: labels.remapOutput, meshAccessors: labels.meshAccessors,
    selectedLayerIds: [...labels.selectedLayerIds],
    selectedPartId: useModelStore.getState().selectedPartId,
    channelView: useUiStore.getState().channelView,
    workspaceTab: useUiStore.getState().workspaceTab,
  }
}

function restoreReviewUi(snapshot: ReviewUiSnapshot): void {
  useLabelStore.setState({
    activeAreaId: snapshot.activeAreaId, activeArea: snapshot.activeArea,
    meshIndex: snapshot.meshIndex, nodeName: snapshot.nodeName,
    remapOutput: snapshot.remapOutput, meshAccessors: snapshot.meshAccessors,
    selectedLayerIds: [...snapshot.selectedLayerIds],
  })
  useModelStore.setState({ selectedPartId: snapshot.selectedPartId })
  useUiStore.setState({ channelView: snapshot.channelView, workspaceTab: snapshot.workspaceTab })
}

function reviewPlanAreas(areas: readonly LabelAreaConfig[]): Array<{
  id: string
  side: NonNullable<LabelAreaConfig['side']>
  carrier: NonNullable<LabelAreaConfig['carrier']>
}> {
  return areas.map((area) => {
    if (!area.side || !area.carrier) {
      throw reviewNotReady('plan', `Review requires normalized side and carrier: ${area.id}`, { areaId: area.id })
    }
    return { id: area.id, side: area.side, carrier: area.carrier }
  })
}

function assertReviewPlanUnchanged(
  expected: readonly ReviewViewRequest[],
  width: number,
  height: number,
  stage: string,
): void {
  const current = buildReviewCapturePlan({
    areas: reviewPlanAreas(useLabelStore.getState().areas),
    width,
    height,
  })
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw reviewNotReady(stage, `Review capture plan changed during capture (${stage})`)
  }
}

function artifactLocator(bootstrap: AgentBridgeBootstrap, artifactId: string): URL {
  const locator = new URL(`${bootstrap.artifactUploadBase.replace(/\/$/, '')}/${encodeURIComponent(artifactId)}`, window.location.origin)
  locator.searchParams.set('token', bootstrap.token)
  return locator
}

function artifactStageUrl(bootstrap: AgentBridgeBootstrap, batchId: string, suffix = ''): URL {
  const url = new URL(`${bootstrap.artifactUploadBase.replace(/\/$/, '')}/stage/${encodeURIComponent(batchId)}${suffix}`, window.location.origin)
  url.searchParams.set('token', bootstrap.token)
  return url
}

async function uploadArtifact(
  bootstrap: AgentBridgeBootstrap,
  artifact: BrowserArtifact,
  options: { batchId?: string } = {},
): Promise<ArtifactDescriptor> {
  const url = options.batchId
    ? artifactStageUrl(bootstrap, options.batchId, `/${encodeURIComponent(artifact.id)}`)
    : artifactLocator(bootstrap, artifact.id)
  url.searchParams.set('token', bootstrap.token)
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'content-type': artifact.mimeType,
      'x-artifact-file-name': encodeURIComponent(artifact.fileName),
      ...(artifact.width ? { 'x-artifact-width': String(artifact.width) } : {}),
      ...(artifact.height ? { 'x-artifact-height': String(artifact.height) } : {}),
      ...(artifact.areaId ? { 'x-artifact-area-id': encodeURIComponent(artifact.areaId) } : {}),
      ...(artifact.channel ? { 'x-artifact-channel': artifact.channel } : {}),
    },
    body: artifact.bytes as BodyInit,
  })
  if (!response.ok) throw new Error(`Artifact upload failed (${response.status}): ${artifact.fileName}`)
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error(`Invalid artifact upload response: ${artifact.fileName}`)
  }
  if (!value || typeof value !== 'object') throw new Error(`Invalid artifact upload response: ${artifact.fileName}`)
  const descriptor = value as Partial<ArtifactDescriptor>
  if (descriptor.id !== artifact.id
    || descriptor.fileName !== artifact.fileName
    || descriptor.mimeType !== artifact.mimeType
    || typeof descriptor.url !== 'string'
    || descriptor.byteLength !== artifact.bytes.byteLength) {
    throw new Error(`Invalid artifact upload response: ${artifact.fileName}`)
  }
  let locator: URL
  try {
    const value = descriptor.url.trim()
    if (value.length === 0) throw new Error('Empty artifact locator')
    locator = new URL(value, window.location.origin)
    const expected = artifactLocator(bootstrap, artifact.id)
    if (locator.href !== expected.href) throw new Error('Artifact locator does not bind the expected session artifact')
  } catch {
    throw new Error(`Invalid artifact upload response: ${artifact.fileName}`)
  }
  return {
    url: locator.href,
    id: artifact.id,
    fileName: artifact.fileName,
    mimeType: artifact.mimeType,
    byteLength: artifact.bytes.byteLength,
    sha256: sha256HexSync(artifact.bytes),
    width: artifact.width,
    height: artifact.height,
    areaId: artifact.areaId,
    channel: artifact.channel,
  }
}

let reviewBatchCounter = 0

function nextReviewBatchId(): string {
  reviewBatchCounter = (reviewBatchCounter + 1) % Number.MAX_SAFE_INTEGER
  const nonce = new Uint8Array(12)
  globalThis.crypto.getRandomValues(nonce)
  const random = [...nonce].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `review-${reviewBatchCounter}-${random}`
}

async function commitArtifactBatch(
  bootstrap: AgentBridgeBootstrap,
  batchId: string,
  artifactIds: readonly string[],
): Promise<void> {
  const response = await fetch(artifactStageUrl(bootstrap, batchId, '/commit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artifactIds }),
  })
  if (!response.ok) throw new Error(`Artifact batch commit failed (${response.status})`)
  let value: unknown
  try { value = await response.json() } catch { throw new Error('Invalid artifact batch commit response') }
  const ids = value && typeof value === 'object' && Array.isArray((value as { artifactIds?: unknown }).artifactIds)
    ? (value as { artifactIds: unknown[] }).artifactIds : undefined
  if (!ids || ids.length !== artifactIds.length || ids.some((id, index) => id !== artifactIds[index])) {
    throw new Error('Invalid artifact batch commit response')
  }
}

async function purgeArtifactBatch(bootstrap: AgentBridgeBootstrap, batchId: string): Promise<void> {
  const response = await fetch(artifactStageUrl(bootstrap, batchId), { method: 'DELETE' })
  if (!response.ok) throw new Error(`Artifact batch purge failed (${response.status})`)
}

export function createBrowserAgentBridge(bootstrap: AgentBridgeBootstrap): LabelEditorAgentBridgeV1 {
  let normalizedSpec: LabelSpecV2 | undefined
  let captureOperationTail: Promise<void> = Promise.resolve()
  const runCaptureExclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const running = captureOperationTail.then(action)
    captureOperationTail = running.then(() => undefined, () => undefined)
    return running
  }
  return createAgentBridge({
    setAgentPreviewStatus: async (status) => {
      if (!/^sha256:[a-f0-9]{64}$/.test(status.revision)
        || (status.state !== 'ready' && status.state !== 'error')
        || (status.message !== undefined && typeof status.message !== 'string')) {
        const error = new Error('Invalid Agent preview status') as Error & { code: string }
        error.code = 'INVALID_USAGE'
        throw error
      }
      useUiStore.getState().setAgentPreviewStatus(status)
    },
    reset: async () => {
      useLabelStore.getState().clearAll()
      useModelStore.getState().selectPart(null)
      normalizedSpec = undefined
    },
    loadModel: async (input) => {
      const response = await fetch(input.url, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`Model download failed (${response.status})`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const loaded = await loadModelFromBytes(input.name, bytes)
      if (loaded.error) throw new Error(loaded.error)
      return inspectModel(bytes, input.name)
    },
    applySpec: async (input) => {
      const validation = validateLabelSpec(input.spec)
      if (!validation.ok) {
        const error = new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')) as Error & { code: string }
        error.code = 'INVALID_LABEL_SPEC'
        throw error
      }
      normalizedSpec = validation.spec
      const glbBytes = useModelStore.getState().glbBytes
      if (!glbBytes) throw new Error('No model is loaded')
      const areas = await buildAreasFromSpec(validation.spec, input.assetUrls ?? {})
      await applyPreparedAreaTransaction({ glbBytes, areas })
      const ui = useUiStore.getState()
      ui.setView('editor')
      ui.setMode('design')
      ui.setEditorViewMode('split')
      return {
        areaIds: areas.map((area) => area.id),
        project: serializeLabelProject(useModelStore.getState().modelName, useLabelStore.getState().areas) as unknown as Record<string, unknown>,
        warnings: validation.warnings,
      }
    },
    applyProject: async (input) => {
      const project = parseLabelProject(input.project)
      const model = useModelStore.getState()
      if (!model.glbBytes) throw new Error('No model is loaded')
      if (project.modelFileName && model.modelName && project.modelFileName !== model.modelName) {
        const error = new Error(`Project targets ${project.modelFileName}, but the loaded model is ${model.modelName}`) as Error & { code: string }
        error.code = 'INVALID_LABEL_SPEC'
        throw error
      }
      normalizedSpec = undefined
      const areas: LabelAreaConfig[] = project.areas.map((area) => ({
        ...area,
        undoStack: [],
        redoStack: [],
      }))
      await applyPreparedAreaTransaction({ glbBytes: model.glbBytes, areas })
      const ui = useUiStore.getState()
      ui.setView('editor')
      ui.setWorkspaceTab('labels')
      ui.setMode('design')
      ui.setEditorViewMode('split')
      return {
        areaIds: areas.map((area) => area.id),
        project: serializeLabelProject(model.modelName, useLabelStore.getState().areas) as unknown as Record<string, unknown>,
        warnings: [],
      }
    },
    getProject: async () => serializeLabelProject(
      useModelStore.getState().modelName,
      useLabelStore.getState().areas,
    ) as unknown as Record<string, unknown>,
    validateDesign: async () => designValidation(),
    waitForReady: async (input) => {
      await waitForBakes(input?.timeoutMs)
      const validation = designValidation()
      return { ...validation, fontsReady: true, imagesReady: true, bakesReady: true }
    },
    renderPreview: async (input) => {
      await waitForBakes()
      const width = input?.width ?? 1200
      const height = input?.height ?? 1200
      const artifact: BrowserArtifact = {
        id: 'preview-3d', fileName: 'preview-3d.png', mimeType: 'image/png',
        bytes: await blobBytes(await captureAgentPreview({ width, height })),
        width, height, channel: 'preview',
      }
      return uploadArtifact(bootstrap, artifact)
    },
    renderQcEvidence: (input) => runCaptureExclusive(async () => {
      await waitForBakes()
      const width = boundedDimension(input?.width ?? 1440)
      const height = boundedDimension(input?.height ?? 1440)
      const snapshot = snapshotQcState()
      const areas = [...snapshot.areas]
      assertQcStateUnchanged(snapshot, 'after-snapshot')
      const validation = designValidation()
      assertValidationReady(validation)
      const plan = buildQcCapturePlan({
        preset: input?.preset ?? 'qc-standard',
        width,
        height,
        areas,
        customViews: input?.customViews ?? [],
      })
      assertQcStateUnchanged(snapshot, 'after-plan')
      assertPlannedAreasPresent(plan, areas)
      assertCraftChannelContributions(areas, useLabelStore.getState().bakeMap, plan)
      const views: QcViewResult[] = []
      for (const request of plan) {
        assertQcStateUnchanged(snapshot, `before-capture:${request.id}`)
        const captured = await captureAgentQcView(request)
        assertQcStateUnchanged(snapshot, `after-capture:${request.id}`)
        const bytes = await blobBytes(captured.blob)
        assertQcStateUnchanged(snapshot, `after-encoding:${request.id}`)
        const artifact = await uploadArtifact(bootstrap, {
          id: `qc-${request.id}`,
          fileName: `${request.id}.png`,
          mimeType: 'image/png',
          bytes,
          width,
          height,
          areaId: request.areaId,
          channel: request.channel,
        })
        assertQcStateUnchanged(snapshot, `after-upload:${request.id}`)
        views.push({ artifact, view: request, camera: captured.camera })
      }
      if (views.length !== plan.length) throw new Error(`QC capture produced ${views.length} of ${plan.length} planned views`)
      assertQcStateUnchanged(snapshot, 'before-result')
      const finalValidation = designValidation()
      assertValidationReady(finalValidation)
      return { preset: 'qc-standard', views, areas: qcAreaEvidence(areas, views), validation: finalValidation }
    }),
    renderReviewEvidence: (input: ReviewEvidenceRequest) => runCaptureExclusive(async () => {
      const uiSnapshot = snapshotReviewUi()
      try {
        const width = boundedDimension(input?.width ?? 1600)
        const height = boundedDimension(input?.height ?? 1600)
        await waitForBakes(30_000, (area) => area.carrier !== 'bare')
        const snapshot = snapshotReviewState()
        const document = currentReviewDocument()
        const gateInput = input?.designGate
        if (!gateInput || typeof gateInput.blueprintJson !== 'string'
          || typeof gateInput.designReviewManifestJson !== 'string') {
          throw reviewNotReady('design-gate', 'Exact design-gate evidence is required for production review')
        }
        const gateEvidenceJson = JSON.stringify(gateInput)
        const gate = await verifyDesignGate({
          handoff: gateInput.handoff,
          blueprint: { read: () => reviewEvidenceBytes(gateInput.blueprintJson) },
          designReviewManifest: { read: () => reviewEvidenceBytes(gateInput.designReviewManifestJson) },
          currentDocument: { read: () => reviewEvidenceBytes(document.json) },
          ...(gateInput.approvalRecord === undefined ? {} : { approvalRecord: gateInput.approvalRecord }),
        })
        assertReviewStateUnchanged(snapshot, 'after-design-gate')
        let blueprint: LayoutBlueprintV1
        try {
          blueprint = validateLayoutBlueprint(JSON.parse(gateInput.blueprintJson))
        } catch {
          throw reviewNotReady('blueprint', 'Approved review blueprint is unavailable or invalid')
        }
        const validation = reviewValidation()
        assertValidationReady(validation)
        const fidelity = compareBlueprintFidelity({ blueprint, editableAreas: useLabelStore.getState().areas })
        assertFidelityReady(fidelity)
        const plan = buildReviewCapturePlan({
          areas: reviewPlanAreas(useLabelStore.getState().areas), width, height,
        })
        assertReviewStateUnchanged(snapshot, 'after-plan')
        const captures: Array<AgentReviewCaptureSource & { bytes: Uint8Array }> = []
        const resultIds = new Set<string>()
        let encodedByteTotal = 0
        for (const request of plan) {
          assertReviewStateUnchanged(snapshot, `before-capture:${request.id}`)
          let result: Awaited<ReturnType<typeof captureAgentReviewView>>
          try {
            result = await captureAgentReviewView(request, {
              blueprintRevision: gate.blueprintRevision,
              inputRevision: gate.documentRevision,
              sources: [...captures],
            })
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error) throw error
            throw reviewNotReady(`capture:${request.id}`, `Review capture failed: ${request.id}`)
          }
          assertReviewCaptureResult(request, result, resultIds)
          const bytes = await validatedReviewPngBytes(result.blob, request.width, request.height)
          encodedByteTotal = assertReviewEncodedByteBudget(encodedByteTotal, bytes.byteLength)
          captures.push({ request, result, bytes })
          assertReviewStateUnchanged(snapshot, `after-capture:${request.id}`)
        }
        if (captures.length !== plan.length) {
          throw reviewNotReady('capture-complete', `Review captured ${captures.length} of ${plan.length} planned views`)
        }
        const finalDocument = currentReviewDocument()
        const finalGate = await verifyDesignGate({
          handoff: gateInput.handoff,
          blueprint: { read: () => reviewEvidenceBytes(gateInput.blueprintJson) },
          designReviewManifest: { read: () => reviewEvidenceBytes(gateInput.designReviewManifestJson) },
          currentDocument: { read: () => reviewEvidenceBytes(finalDocument.json) },
          ...(gateInput.approvalRecord === undefined ? {} : { approvalRecord: gateInput.approvalRecord }),
        })
        if (JSON.stringify(finalGate) !== JSON.stringify(gate)) {
          throw reviewNotReady('final-design-gate', 'Review design gate changed during capture')
        }
        const areaTargetsSha256 = await computeAreaTargetsSha256(document.value)
        assertReviewStateUnchanged(snapshot, 'before-upload')
        assertReviewPlanUnchanged(plan, width, height, 'before-upload-plan')
        const finalValidation = reviewValidation()
        assertValidationReady(finalValidation)
        const finalFidelity = compareBlueprintFidelity({ blueprint, editableAreas: useLabelStore.getState().areas })
        assertFidelityReady(finalFidelity)
        const batchId = nextReviewBatchId()
        let completed = false
        try {
          const views: ReviewViewResult[] = []
          for (const source of captures) {
            assertReviewStateUnchanged(snapshot, `before-upload:${source.request.id}`)
            let artifact: ArtifactDescriptor
            try {
              artifact = await uploadArtifact(bootstrap, {
                id: source.request.id, fileName: `${source.request.id}.png`, mimeType: 'image/png',
                bytes: source.bytes, width: source.request.width, height: source.request.height,
                areaId: source.request.areaId,
              }, { batchId })
            } catch (error) {
              throw reviewNotReady(`upload:${source.request.id}`, `Review artifact upload failed: ${source.request.id}`, {
                cause: error instanceof Error ? error.message : String(error),
              })
            }
            assertReviewStateUnchanged(snapshot, `after-upload:${source.request.id}`)
            views.push({
              id: source.request.id, kind: source.request.kind,
              ...(source.request.areaId ? { areaId: source.request.areaId } : {}),
              ...(source.request.carrier ? { carrier: source.request.carrier } : {}),
              artifact,
              ...(source.result.camera ? { camera: source.result.camera } : {}),
            })
          }
          assertReviewStateUnchanged(snapshot, 'before-commit')
          assertReviewPlanUnchanged(plan, width, height, 'before-commit-plan')
          try {
            await commitArtifactBatch(bootstrap, batchId, captures.map((source) => source.request.id))
          } catch (error) {
            throw reviewNotReady('upload-commit', 'Review artifact batch commit failed', {
              cause: error instanceof Error ? error.message : String(error),
            })
          }

          // Final no-await barrier. Every digest and network operation is complete;
          // no mutable evidence input may change between these checks and return.
          assertReviewStateUnchanged(snapshot, 'before-result')
          assertReviewPlanUnchanged(plan, width, height, 'before-result-plan')
          if (currentReviewDocument().json !== document.json) {
            throw reviewNotReady('before-result-gate', 'Review design-gate input changed before result')
          }
          if (JSON.stringify(gateInput) !== gateEvidenceJson) {
            throw reviewNotReady('before-result-gate', 'Review design-gate evidence changed before result')
          }
          const returnValidation = reviewValidation()
          assertValidationReady(returnValidation)
          const returnFidelity = compareBlueprintFidelity({ blueprint, editableAreas: useLabelStore.getState().areas })
          assertFidelityReady(returnFidelity)
          completed = true
          return {
            inputKind: 'label-project-v3',
            inputRevision: gate.documentRevision,
            inputSha256: gate.documentSha256,
            blueprintRevision: gate.blueprintRevision,
            blueprintSha256: gate.blueprintSha256,
            designReviewManifestSha256: gate.designReviewManifestSha256,
            modelFingerprint: snapshot.modelFingerprint,
            areaTargetsSha256,
            views,
            validation: returnValidation,
            fidelity: returnFidelity,
          }
        } finally {
          if (!completed) {
            try {
              await purgeArtifactBatch(bootstrap, batchId)
            } catch (error) {
              throw reviewNotReady('upload-rollback', 'Review artifact batch could not be purged', {
                cause: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      } finally {
        restoreReviewUi(uiSnapshot)
      }
    }),
    exportArtifacts: async () => {
      await waitForBakes()
      const model = useModelStore.getState()
      const labels = useLabelStore.getState()
      if (!model.glbBytes) throw new Error('No model is loaded')
      const bundle = await createExportBundle({
        glbBytes: model.glbBytes,
        modelName: model.modelName,
        areas: labels.areas,
        bakeMap: labels.bakeMap,
        normalizedSpec,
      })
      const uploaded: ArtifactDescriptor[] = []
      for (const artifact of bundle.artifacts) uploaded.push(await uploadArtifact(bootstrap, artifact))
      const validation = designValidation()
      return { artifacts: uploaded, validation, glbCrossCheck: bundle.crossCheck, warnings: [] } satisfies ExportManifest
    },
  })
}
