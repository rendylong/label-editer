import { applyStructuredLabelSpec } from '../app/labelSpec'
import { computeLabelSetup, loadModelFromBytes } from '../app/modelLoader'
import { parseLabelProject, serializeLabelProject } from '../app/projectSchema'
import { restoreImportedAreaRuntime } from '../app/projectImportRuntime'
import { extractMeshAccessors, isMeshWorldMirrored, meshLocalFrontDirection, readGlb } from '../glb/analyze'
import { makeDefaultRemap } from '../glb/uvRemap'
import type { LabelAreaConfig, LabelLayer } from '../label/types'
import { designFontReadinessKey } from '../label/exportReadiness'
import { validatePrintReadiness } from '../label/printReadiness'
import { useLabelStore, useModelStore, useUiStore } from '../state/stores'
import { createExportBundle, type BrowserArtifact } from './artifactExport'
import { createAgentBridge, type AgentBridgeBootstrap } from './bridge'
import { captureAgentPreview, captureAgentQcView } from './previewCapture'
import { inspectModel } from './modelInspection'
import { validateLabelSpec, type LabelSpecAreaV2, type LabelSpecV2 } from './labelSpecSchema'
import { buildQcCapturePlan, craftChannelsForArea } from './qcCapturePlan'
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

async function waitForBakes(timeoutMs = 30_000): Promise<void> {
  const started = performance.now()
  const areas = useLabelStore.getState().areas
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
        && (bake.fontReadinessKey ?? '') === designFontReadinessKey(current)
        && (!requiresPostActivationBake || bake !== previousBake)) break
      if (performance.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for ${requiresPostActivationBake ? 'post-activation ' : ''}label bake: ${original.name}`)
      }
      await sleepFrame()
    }
  }

  const settleMs = 350
  const settledBakes = new Map<string, BakeResult>()
  let stableSince = performance.now()
  while (true) {
    const state = useLabelStore.getState()
    let ready = true
    let changed = settledBakes.size !== areas.length
    for (const original of areas) {
      const current = state.areas.find((area) => area.id === original.id)
      const bake = state.bakeMap[original.id]
      if (!current || bake?.areaOwner !== current || bake.color.width < 1 || bake.color.height < 1
        || (bake.fontReadinessKey ?? '') !== designFontReadinessKey(current)) {
        ready = false
        break
      }
      if (settledBakes.get(original.id) !== bake) changed = true
    }
    const now = performance.now()
    if (!ready) {
      settledBakes.clear()
      stableSince = now
    } else if (changed) {
      settledBakes.clear()
      for (const original of areas) settledBakes.set(original.id, state.bakeMap[original.id])
      stableSince = now
    } else if (now - stableSince >= settleMs) {
      return
    }
    if (now - started > timeoutMs) throw new Error('Timed out waiting for label bakes to settle')
    await sleepFrame()
  }
}

async function uploadArtifact(bootstrap: AgentBridgeBootstrap, artifact: BrowserArtifact): Promise<ArtifactDescriptor> {
  const url = new URL(`${bootstrap.artifactUploadBase.replace(/\/$/, '')}/${encodeURIComponent(artifact.id)}`, window.location.origin)
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
  if (typeof descriptor.id !== 'string' || descriptor.id.length === 0
    || typeof descriptor.fileName !== 'string' || descriptor.fileName.length === 0
    || typeof descriptor.mimeType !== 'string' || descriptor.mimeType.length === 0
    || typeof descriptor.url !== 'string'
    || !Number.isInteger(descriptor.byteLength) || (descriptor.byteLength ?? -1) < 0) {
    throw new Error(`Invalid artifact upload response: ${artifact.fileName}`)
  }
  let locator: URL
  try {
    const value = descriptor.url.trim()
    if (value.length === 0) throw new Error('Empty artifact locator')
    locator = new URL(value, window.location.origin)
    if ((locator.protocol !== 'http:' && locator.protocol !== 'https:')
      || locator.origin !== window.location.origin) {
      throw new Error('Artifact locator must be same-origin HTTP(S)')
    }
  } catch {
    throw new Error(`Invalid artifact upload response: ${artifact.fileName}`)
  }
  return {
    ...descriptor,
    url: locator.href,
    id: artifact.id,
    fileName: artifact.fileName,
    mimeType: artifact.mimeType,
    byteLength: artifact.bytes.byteLength,
    width: artifact.width,
    height: artifact.height,
    areaId: artifact.areaId,
    channel: artifact.channel,
  }
}

export function createBrowserAgentBridge(bootstrap: AgentBridgeBootstrap): LabelEditorAgentBridgeV1 {
  let normalizedSpec: LabelSpecV2 | undefined
  let qcOperationTail: Promise<void> = Promise.resolve()
  const runQcExclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const running = qcOperationTail.then(action)
    qcOperationTail = running.then(() => undefined, () => undefined)
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
    renderQcEvidence: (input) => runQcExclusive(async () => {
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
