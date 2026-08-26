import { prepareAllAreas } from '../app/areaExporter'
import type { BakeInput } from '../app/exportTypes'
import { serializeLabelProject } from '../app/projectSchema'
import { exportGlb, type CrossCheckResult } from '../glb/rebuild'
import { canvasToPngBytes } from '../glb/textures'
import { buildPrintManifest, type PrintManifest } from '../label/printReadiness'
import type { LabelAreaConfig } from '../label/types'
import { hasRenderableWhiteUnderbaseDeclaration } from '../label/whiteUnderbase'
import {
  snapshotRendererProvenWhiteUnderbase,
} from '../label/craft'

export type ArtifactChannel = 'color' | 'metalness' | 'roughness' | 'bump' | 'white_underbase'

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

export function createPrintArtifact(area: LabelAreaConfig, bake?: BakeInput): BrowserArtifact {
  return {
    id: `print-manifest-${area.id}`,
    fileName: `${sanitizeArtifactBaseName(area.name)}-print-manifest.json`,
    mimeType: 'application/json',
    bytes: jsonBytes(buildPrintManifest(area, bake)),
    areaId: area.id,
  }
}

export function createAggregatePrintArtifact(areas: LabelAreaConfig[], bakeMap?: Record<string, BakeInput>): BrowserArtifact {
  return createAggregatePrintArtifactFromManifests(
    areas.map((area) => buildPrintManifest(area, bakeMap?.[area.id])),
  )
}

function createAggregatePrintArtifactFromManifests(manifests: PrintManifest[]): BrowserArtifact {
  return {
    id: 'print-manifest',
    fileName: 'print-manifest.json',
    mimeType: 'application/json',
    bytes: jsonBytes({ version: 1, areas: manifests }),
  }
}

export async function createChannelArtifact(
  area: LabelAreaConfig,
  bake: BakeInput,
  channel: ArtifactChannel,
): Promise<BrowserArtifact> {
  const verifiedWhiteUnderbase = channel === 'white_underbase'
    ? snapshotRendererProvenWhiteUnderbase(area, bake)
    : undefined
  if (channel === 'white_underbase' && (!hasRenderableWhiteUnderbaseDeclaration(area) || !verifiedWhiteUnderbase)) {
    throw new Error(`贴标区域「${area.name}」没有 white_underbase 烘焙通道（缺少当前 renderer proof）`)
  }
  const canvas = channel === 'white_underbase' ? verifiedWhiteUnderbase : bake[channel]
  if (!canvas) throw new Error(`贴标区域「${area.name}」没有 ${channel} 烘焙通道`)
  return {
    id: `${area.id}-${channel}`,
    fileName: channel === 'white_underbase' ? 'white-underbase.png' : `${channel}.png`,
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
  return (await createAreaPublication(areas, bakeMap, false)).artifacts
}

async function createAreaPublication(
  areas: LabelAreaConfig[],
  bakeMap: Record<string, BakeInput>,
  includeManifests: boolean,
): Promise<{ artifacts: BrowserArtifact[]; manifests: PrintManifest[] }> {
  const artifacts: BrowserArtifact[] = []
  const manifests: PrintManifest[] = []
  for (const area of areas) {
    const bake = bakeMap[area.id]
    if (!bake) throw new Error(`贴标区域「${area.name}」缺少烘焙结果`)
    for (const channel of ['color', 'metalness', 'roughness', 'bump'] as const) {
      if (bake[channel]) artifacts.push(await createChannelArtifact(area, bake, channel))
    }
    let whiteUnderbaseArtifact: BrowserArtifact | undefined
    if (bake.whiteUnderbase && hasRenderableWhiteUnderbaseDeclaration(area)) {
      try {
        whiteUnderbaseArtifact = await createChannelArtifact(area, bake, 'white_underbase')
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('缺少当前 renderer proof')) throw error
      }
    }
    if (includeManifests) {
      // A transient artifact-side read failure must not leave a manifest-only
      // white claim. When a snapshot exists, the manifest still performs its
      // own current-source verification; a later mutation drops the snapshot.
      const manifest = buildPrintManifest(area, whiteUnderbaseArtifact
        ? bake
        : { ...bake, whiteUnderbase: undefined })
      manifests.push(manifest)
      if (whiteUnderbaseArtifact && manifest.whiteUnderbaseAuthorized) artifacts.push(whiteUnderbaseArtifact)
    } else if (whiteUnderbaseArtifact) artifacts.push(whiteUnderbaseArtifact)
  }
  return { artifacts, manifests }
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
  const [publication, glb] = await Promise.all([
    createAreaPublication(input.areas, input.bakeMap, true),
    createGlbArtifact(input),
  ])
  const printArtifact = createAggregatePrintArtifactFromManifests(publication.manifests)
  const artifacts = [
    glb.artifact,
    createProjectArtifact(input.modelName, input.areas),
    printArtifact,
    ...publication.artifacts,
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
