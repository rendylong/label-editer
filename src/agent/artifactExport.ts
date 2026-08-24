import { prepareAllAreas } from '../app/areaExporter'
import type { BakeInput } from '../app/exportTypes'
import { serializeLabelProject } from '../app/projectSchema'
import { exportGlb, type CrossCheckResult } from '../glb/rebuild'
import { canvasToPngBytes } from '../glb/textures'
import { buildPrintManifest } from '../label/printReadiness'
import type { LabelAreaConfig } from '../label/types'

export type ArtifactChannel = 'color' | 'metalness' | 'roughness' | 'bump'

export interface BrowserArtifact {
  id: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
  width?: number
  height?: number
  areaId?: string
  channel?: ArtifactChannel | 'preview'
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2))
}

export function sanitizeArtifactBaseName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'artifact'
}

export function createProjectArtifact(modelFileName: string, areas: LabelAreaConfig[]): BrowserArtifact {
  return {
    id: 'project',
    fileName: 'project.lbl.json',
    mimeType: 'application/json',
    bytes: jsonBytes(serializeLabelProject(modelFileName, areas)),
  }
}

export function createPrintArtifact(area: LabelAreaConfig): BrowserArtifact {
  return {
    id: `print-manifest-${area.id}`,
    fileName: `${sanitizeArtifactBaseName(area.name)}-print-manifest.json`,
    mimeType: 'application/json',
    bytes: jsonBytes(buildPrintManifest(area)),
    areaId: area.id,
  }
}

export function createAggregatePrintArtifact(areas: LabelAreaConfig[]): BrowserArtifact {
  return {
    id: 'print-manifest',
    fileName: 'print-manifest.json',
    mimeType: 'application/json',
    bytes: jsonBytes({ version: 1, areas: areas.map((area) => buildPrintManifest(area)) }),
  }
}

export async function createChannelArtifact(
  area: LabelAreaConfig,
  bake: BakeInput,
  channel: ArtifactChannel,
): Promise<BrowserArtifact> {
  const canvas = bake[channel]
  return {
    id: `${area.id}-${channel}`,
    fileName: `${channel}.png`,
    mimeType: 'image/png',
    bytes: await canvasToPngBytes(canvas),
    width: canvas.width,
    height: canvas.height,
    areaId: area.id,
    channel,
  }
}

export async function createAreaChannelArtifacts(
  areas: LabelAreaConfig[],
  bakeMap: Record<string, BakeInput>,
): Promise<BrowserArtifact[]> {
  const artifacts: BrowserArtifact[] = []
  for (const area of areas) {
    const bake = bakeMap[area.id]
    if (!bake) throw new Error(`贴标区域「${area.name}」缺少烘焙结果`)
    for (const channel of ['color', 'metalness', 'roughness', 'bump'] as const) {
      artifacts.push(await createChannelArtifact(area, bake, channel))
    }
  }
  return artifacts
}

export interface CreateGlbArtifactInput {
  glbBytes: Uint8Array
  modelName: string
  areas: LabelAreaConfig[]
  bakeMap: Record<string, BakeInput>
  /** Revalidate immutable editor/model ownership after async preparation and before reconstruction. */
  beforeRebuild?: () => void
}

export interface CreatedGlbArtifact {
  artifact: BrowserArtifact
  crossCheck: CrossCheckResult
  preparedAreaCount: number
}

export async function createGlbArtifact(input: CreateGlbArtifactInput): Promise<CreatedGlbArtifact> {
  const prepared = await prepareAllAreas(input.glbBytes, input.areas, input.bakeMap)
  if (prepared.length !== input.areas.length) {
    throw new Error(`仅准备了 ${prepared.length}/${input.areas.length} 个贴标区域`)
  }
  input.beforeRebuild?.()
  const result = await exportGlb({
    glb: input.glbBytes,
    areas: prepared,
    editableProject: serializeLabelProject(input.modelName, input.areas),
  })
  if (!result.ok || !result.glbBytes) throw new Error(result.error ?? 'GLB 重建失败')
  const crossCheck = result.crossCheck
  if (!crossCheck?.loaded || !crossCheck.uvSampleOk) {
    throw new Error(crossCheck?.error ?? 'GLB 交叉校验失败')
  }
  const base = sanitizeArtifactBaseName(input.modelName.replace(/\.glb$/i, '') || 'model')
  return {
    artifact: {
      id: 'labeled-glb',
      fileName: `${base}-label-edited.glb`,
      mimeType: 'model/gltf-binary',
      bytes: result.glbBytes,
    },
    crossCheck,
    preparedAreaCount: prepared.length,
  }
}

export async function createExportBundle(input: CreateGlbArtifactInput & { normalizedSpec?: unknown }): Promise<{
  artifacts: BrowserArtifact[]
  crossCheck: CrossCheckResult
}> {
  const [channels, glb] = await Promise.all([
    createAreaChannelArtifacts(input.areas, input.bakeMap),
    createGlbArtifact(input),
  ])
  const artifacts = [
    glb.artifact,
    createProjectArtifact(input.modelName, input.areas),
    createAggregatePrintArtifact(input.areas),
    ...channels,
  ]
  if (input.normalizedSpec !== undefined) {
    artifacts.splice(2, 0, {
      id: 'normalized-spec',
      fileName: 'label-spec.normalized.json',
      mimeType: 'application/json',
      bytes: jsonBytes(input.normalizedSpec),
    })
  }
  return { artifacts, crossCheck: glb.crossCheck }
}
