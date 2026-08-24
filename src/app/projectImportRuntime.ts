/** 为序列化项目恢复无法写入 .lbl 的运行时网格数据。 */

import type { LabelAreaConfig } from '../label/types'
import { readGlb, extractMeshAccessors, isMeshWorldMirrored } from '../glb/analyze'
import { computeRemap, type MeshAccessors, type RemapOutput } from '../glb/uvRemap'

export async function restoreImportedAreaRuntime(
  glbBytes: Uint8Array,
  area: Pick<LabelAreaConfig, 'meshIndex' | 'remap' | 'range' | 'surfaceMode'>,
): Promise<{ meshAccessors: MeshAccessors; remapOutput: RemapOutput; remap: LabelAreaConfig['remap'] }> {
  const doc = await readGlb(glbBytes)
  const meshAccessors = extractMeshAccessors(doc, area.meshIndex)
  const remap = { ...area.remap, mirrorU: area.remap.mirrorU ?? isMeshWorldMirrored(doc, area.meshIndex) }
  const remapOutput = computeRemap(meshAccessors, remap, area.range, { exteriorOnly: area.surfaceMode === 'overlay' })
  return { meshAccessors, remapOutput, remap }
}
