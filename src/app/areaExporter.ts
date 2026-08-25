/**
 * 多区域导出数据准备：为每个贴标区域重新提取网格 accessor、重算 remap 输出与烘焙 PNG。
 */

import { readGlb, extractMeshAccessors } from '../glb/analyze'
import { computeRemap, type RemapOutput } from '../glb/uvRemap'
import { canvasToPngBytes, packMetalRough, bumpToNormal } from '../glb/textures'
import type { LabelAreaConfig } from '../label/types'
import type { BakeInput } from './exportTypes'

export interface PreparedArea {
  areaId: string
  meshIndex: number
  nodeName: string
  surfaceMode: 'overlay' | 'replace'
  fullRange: boolean
  remap: RemapOutput
  colorPng: Uint8Array
  metalRoughPng: Uint8Array
  normalPng: Uint8Array
}

/** 为所有区域准备导出数据（每个区域独立提取网格 + 重算 remap + 编码纹理）。 */
export async function prepareAllAreas(glbBytes: Uint8Array, areas: LabelAreaConfig[], bakeMap: Record<string, BakeInput>): Promise<PreparedArea[]> {
  const doc = await readGlb(glbBytes)
  const out: PreparedArea[] = []
  for (const area of areas) {
    const bake = bakeMap[area.id]
    if (!bake) continue
    const mesh = extractMeshAccessors(doc, area.meshIndex)
    const remap: RemapOutput = computeRemap(mesh, area.remap, area.range, { exteriorOnly: area.surfaceMode === 'overlay' })
    const [colorPng, metalRoughPng, normalPng] = await Promise.all([
      canvasToPngBytes(bake.color),
      canvasToPngBytes(packMetalRough(bake.metalness, bake.roughness)),
      canvasToPngBytes(bumpToNormal(bake.bump)),
    ])
    out.push({ areaId: area.id, meshIndex: area.meshIndex, nodeName: area.nodeName, surfaceMode: area.surfaceMode ?? 'replace', fullRange: area.range.uWidth >= 0.999 && area.range.vHeight >= 0.999, remap, colorPng, metalRoughPng, normalPng })
  }
  return out
}
