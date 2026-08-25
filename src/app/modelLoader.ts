/**
 * 模型加载编排：GLB 分析 → 部件树 → 标签面识别 → UV 重映射 → 创建贴标区域。
 */

import { readGlb, buildPartTree, extractMeshAccessors, findPart, isMeshWorldMirrored, meshLocalFrontDirection } from '../glb/analyze'
import { computeRemap, makeDefaultRemap, deriveCanvasSpec, deriveSurfaceCanvasSpec, fitCylinder, axisSpan, type MeshAccessors } from '../glb/uvRemap'
import { useModelStore, useLabelStore, useUiStore, flashToast } from '../state/stores'
import type { RemapParams, LabelAreaRange } from '../label/types'
import { parseLabelProject } from './projectSchema'
import { readEditableProjectMetadata } from '../glb/rebuildCore'

/** 版本戳（用于验证浏览器加载的是最新 bundle）。 */
export const GLB_EDITOR_VERSION = '0.2.0-multi'

/** 计算标签配置（重映射参数 + 画布规格 + 输出）。 */
export function computeLabelSetup(
  mesh: MeshAccessors,
  params: RemapParams,
  range: LabelAreaRange = { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
  surfaceMode: 'overlay' | 'replace' = 'replace',
) {
  const fit = fitCylinder(mesh.positions)
  const output = computeRemap(mesh, params, range, { exteriorOnly: surfaceMode === 'overlay' })
  const fallbackSpec = deriveCanvasSpec(fit.radius, fit.height, params.wrap, range.uWidth, range.vHeight)
  const spec = deriveSurfaceCanvasSpec(output, fallbackSpec.aspect)
  const [axisMin, axisMax] = axisSpan(mesh.positions, fit.axis, fit.origin)
  return { output, spec, fit, axisMin, axisMax }
}

/** 从字节加载模型并自动创建首个贴标区域（如识别到标签面）。 */
export async function loadModelFromBytes(modelName: string, bytes: Uint8Array): Promise<{ labelActivated: boolean; error?: string }> {
  const ms = useModelStore.getState()
  ms.setStatus('loading')
  // 新模型必然重置标签状态（防止旧模型的贴标区域/图层残留）
  useLabelStore.getState().clearAll()
  useModelStore.getState().selectPart(null)
  useUiStore.getState().setWorkspaceTab('model')
  useUiStore.getState().setMode('browse')
  try {
    const doc = await readGlb(bytes)
    const analysis = buildPartTree(doc)
    ms.loadModel(modelName, bytes, analysis)

    const embedded = readEditableProjectMetadata(doc)
    if (embedded !== undefined) {
      const project = parseLabelProject(embedded)
      const restored = project.areas.filter((area) => area.meshIndex < doc.getRoot().listMeshes().length)
      if (restored.length > 0) {
        const ls = useLabelStore.getState()
        restored.forEach((area) => ls.addArea(area))
        const active = restored[restored.length - 1]
        const mesh = extractMeshAccessors(doc, active.meshIndex)
        const remap = { ...active.remap, mirrorU: active.remap.mirrorU ?? isMeshWorldMirrored(doc, active.meshIndex) }
        const output = computeRemap(mesh, remap, active.range, { exteriorOnly: active.surfaceMode === 'overlay' })
        ls.applyAreaOp(active.id, (area) => ({ ...area, remap }), { commit: false })
        ls.setAreaData(output, mesh)
        const partId = analysis.meshToNode[active.meshIndex]
        if (partId) ms.selectPart(partId)
        useUiStore.getState().setWorkspaceTab('labels')
        useUiStore.getState().setMode('design')
        return { labelActivated: true }
      }
    }

    const candidateId = analysis.labelCandidates[0]
    if (candidateId) {
      const node = findPart(analysis.parts, candidateId)
      if (node?.meshIndex !== undefined) {
        const mesh = extractMeshAccessors(doc, node.meshIndex)
        const params = makeDefaultRemap(mesh, isMeshWorldMirrored(doc, node.meshIndex), meshLocalFrontDirection(doc, node.meshIndex))
        const { output, spec, axisMin, axisMax } = computeLabelSetup(mesh, params)
        const ls = useLabelStore.getState()
        ls.addArea({
          name: node.name,
          meshIndex: node.meshIndex,
          nodeName: node.name,
          surfaceMode: 'replace',
          axisMin,
          axisMax,
          remap: params,
          range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
          canvas: spec,
          layers: [],
          globalCraft: { craft: [] },
          fonts: [],
          // 原 GLB 贴图依赖旧 UV/纹理变换，不能直接拉伸到新展开画布。
          referenceVisible: false,
        })
        ls.setAreaData(output, mesh)
        ms.selectPart(candidateId)
        useUiStore.getState().setMode('design')
        return { labelActivated: true }
      }
    }
    // 无标签面：留在浏览模式
    useUiStore.getState().setMode('browse')
    return { labelActivated: false }
  } catch (err) {
    ms.setStatus('error', err instanceof Error ? err.message : String(err))
    return { labelActivated: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 加载示例模型（public/sample/面霜瓶.glb）。 */
export async function loadSample(): Promise<{ labelActivated: boolean; error?: string }> {
  const res = await fetch('/sample/面霜瓶.glb')
  if (!res.ok) return { labelActivated: false, error: `示例模型加载失败 HTTP ${res.status}` }
  const buf = await res.arrayBuffer()
  return loadModelFromBytes('面霜瓶.glb', new Uint8Array(buf))
}

/** 将指定部件创建为新的贴标区域（可多个；同一部件重复创建会替换其区域）。
 *  @param range 可选：创建时直接使用指定区域范围（可视化框选结果），避免创建后再重算。 */
export async function addAreaForNode(
  nodeId: string,
  range?: LabelAreaRange,
  options: { replaceAreaId?: string; side?: 'front' | 'back' } = {},
): Promise<{ ok: boolean; error?: string; areaId?: string }> {
  const ms = useModelStore.getState()
  if (!ms.glbBytes || !ms.analysis) return { ok: false, error: '请先加载模型' }
  const node = findPart(ms.analysis.parts, nodeId)
  if (!node || node.meshIndex === undefined) {
    return { ok: false, error: '该部件不是网格，无法设为贴标区域' }
  }
  try {
    const doc = await readGlb(ms.glbBytes)
    const mesh = extractMeshAccessors(doc, node.meshIndex)
    const params = makeDefaultRemap(mesh, isMeshWorldMirrored(doc, node.meshIndex), meshLocalFrontDirection(doc, node.meshIndex))
    if (options.side === 'back') params.offset = (params.offset + 0.5) % 1
    const areaRange: LabelAreaRange = range ?? { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }
    const surfaceMode = node.kind === 'label' ? 'replace' : 'overlay'
    const { output, spec, axisMin, axisMax } = computeLabelSetup(mesh, params, areaRange, surfaceMode)
    const ls = useLabelStore.getState()
    // 同一网格允许多个区域；只有显式编辑指定区域时才复用设计数据与 id。
    const existing = options.replaceAreaId ? ls.areas.find((area) => area.id === options.replaceAreaId) : undefined
    const id = ls.addArea({
      id: existing?.id,
      name: existing?.name ?? `${node.name}${options.side === 'back' ? ' · 背标' : options.side === 'front' ? ' · 正标' : ''}`,
      meshIndex: node.meshIndex,
      nodeName: node.name,
      surfaceMode,
      side: options.side ?? existing?.side,
      remap: params,
      // 用户在 2D 展开图中确认的范围始终是本次提交的真值；
      // 已有区域只复用设计内容与 id，不得吞掉新的框选结果。
      range: areaRange,
      canvas: spec,
      axisMin,
      axisMax,
      paper: existing?.paper,
      layers: existing?.layers ?? [],
      globalCraft: existing?.globalCraft ?? { craft: [] },
      fonts: existing?.fonts ?? [],
      referenceVisible: false,
    })
    ls.setAreaData(output, mesh)
    ms.selectPart(nodeId)
    useUiStore.getState().setMode('design')
    return { ok: true, areaId: id }
  } catch (err) {
    flashToast(err instanceof Error ? err.message : '设置失败', 'error')
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 获取网格的展开图宽高比，供可视化区域选择器使用。原贴图不适用于重建后的 UV。 */
export async function getAreaPreview(nodeId: string): Promise<{ ok: boolean; aspect: number; referenceUrl?: string; error?: string }> {
  const ms = useModelStore.getState()
  if (!ms.glbBytes || !ms.analysis) return { ok: false, aspect: 1, error: '请先加载模型' }
  const node = findPart(ms.analysis.parts, nodeId)
  if (!node || node.meshIndex === undefined) return { ok: false, aspect: 1, error: '该部件不是网格' }
  try {
    const doc = await readGlb(ms.glbBytes)
    const mesh = extractMeshAccessors(doc, node.meshIndex)
    const params = makeDefaultRemap(mesh, isMeshWorldMirrored(doc, node.meshIndex), meshLocalFrontDirection(doc, node.meshIndex))
    const { spec } = computeLabelSetup(mesh, params, undefined, node.kind === 'label' ? 'replace' : 'overlay')
    return { ok: true, aspect: spec.aspect }
  } catch (err) {
    return { ok: false, aspect: 1, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 兼容旧名：手动设置贴标区域 = 创建新区域。 */
export const setLabelForNode = addAreaForNode
