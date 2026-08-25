import { applyStructuredLabelSpec } from '../app/labelSpec'
import { computeLabelSetup, loadModelFromBytes } from '../app/modelLoader'
import { parseLabelProject, serializeLabelProject } from '../app/projectSchema'
import { restoreImportedAreaRuntime } from '../app/projectImportRuntime'
import { extractMeshAccessors, isMeshWorldMirrored, meshLocalFrontDirection, readGlb } from '../glb/analyze'
import { makeDefaultRemap } from '../glb/uvRemap'
import type { LabelAreaConfig, LabelLayer } from '../label/types'
import { validatePrintReadiness } from '../label/printReadiness'
import { useLabelStore, useModelStore, useUiStore } from '../state/stores'
import { createExportBundle, type BrowserArtifact } from './artifactExport'
import { createAgentBridge, type AgentBridgeBootstrap } from './bridge'
import { captureAgentPreview } from './previewCapture'
import { inspectModel } from './modelInspection'
import { validateLabelSpec, type LabelSpecAreaV2, type LabelSpecV2 } from './labelSpecSchema'
import { resolveTarget } from './targetResolver'
import { applyPreparedAreaTransaction } from './transactionalApply'
import type { ArtifactDescriptor, DesignValidationIssue, ExportManifest, LabelEditorAgentBridgeV1 } from './contracts'

function sleepFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
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
        severity: 'warning',
        code: issue.code,
        message: issue.message,
        areaId: area.id,
        ...(issue.layerId ? { layerId: issue.layerId } : {}),
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
  for (const original of areas) {
    const runtime = await restoreImportedAreaRuntime(glbBytes, original)
    useLabelStore.getState().activateArea(original.id)
    useLabelStore.getState().setAreaData(runtime.remapOutput, runtime.meshAccessors)
    while (true) {
      const state = useLabelStore.getState()
      const current = state.areas.find((area) => area.id === original.id)
      const bake = state.bakeMap[original.id]
      if (current && bake?.areaOwner === current && bake.color.width > 0 && bake.color.height > 0) break
      if (performance.now() - started > timeoutMs) throw new Error(`Timed out waiting for label bake: ${original.name}`)
      await sleepFrame()
    }
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
  const descriptor = await response.json() as ArtifactDescriptor
  return {
    ...descriptor,
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
