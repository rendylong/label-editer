/**
 * 应用动作：导出 PNG / 导出 GLB（多区域）/ 项目 .lbl 导入导出 / 快捷键。
 */

import { useModelStore, useLabelStore, useUiStore, flashToast } from '../state/stores'
import { exportGlb, downloadBytes } from '../glb/rebuild'
import { canvasToPngBytes, packMetalRough, bumpToNormal } from '../glb/textures'
import { restoreImportedAreaRuntime } from './projectImportRuntime'
import { parseLabelProject, serializeLabelProject } from './projectSchema'
import { nudgeLayers } from '../label/selection'
import { deriveDesignFontRequests, waitForDesignFonts } from '../label/fontRuntime'
import { designFontReadinessKey } from '../label/exportReadiness'
import type { LabelAreaConfig, LabelLayer } from '../label/types'
import type { BakeResult } from '../state/stores'

type ExportBakeRequest = () => boolean

interface ExportAreaSnapshot {
  owner: LabelAreaConfig
  area: LabelAreaConfig
  bake?: BakeResult
  bakeVersion: number
  fontReadinessKey: string
}

interface ExportModelSnapshot {
  glbBytes: Uint8Array
  modelName: string
  analysis: ReturnType<typeof useModelStore.getState>['analysis']
}

const exportBakeSurfaces = new Map<string, { token: symbol; requestBake: ExportBakeRequest }>()

/** Register the live Konva owner that can synchronously complete a real draw and bake. */
export function registerExportBakeSurface(areaId: string, requestBake: ExportBakeRequest): () => void {
  const token = Symbol(areaId)
  exportBakeSurfaces.set(areaId, { token, requestBake })
  return () => {
    if (exportBakeSurfaces.get(areaId)?.token === token) exportBakeSurfaces.delete(areaId)
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach((nested) => deepFreeze(nested))
  }
  return value
}

function frozenAreaCopy(area: LabelAreaConfig): LabelAreaConfig {
  return deepFreeze(JSON.parse(JSON.stringify(area)) as LabelAreaConfig)
}

function frozenBakeCopy(
  bake: BakeResult,
  owner: LabelAreaConfig,
  fontReadinessKey: string,
): BakeResult {
  return Object.freeze({ ...bake, areaOwner: owner, fontReadinessKey })
}

function captureExportAreas(areas: LabelAreaConfig[], bakeMap: Record<string, BakeResult>): ExportAreaSnapshot[] {
  return areas.map((owner) => {
    const bake = bakeMap[owner.id]
    return {
      owner,
      area: frozenAreaCopy(owner),
      bake,
      bakeVersion: bake?.version ?? 0,
      fontReadinessKey: designFontReadinessKey(owner),
    }
  })
}

function assertExportAreaOwnership(
  snapshots: ExportAreaSnapshot[],
  activeAreaId?: string,
  requireExactAreaSet = false,
): void {
  const state = useLabelStore.getState()
  if (activeAreaId !== undefined && state.activeAreaId !== activeAreaId) {
    throw new Error('设计已在导出准备期间更改，请重试')
  }
  if (requireExactAreaSet && (
    state.areas.length !== snapshots.length
    || state.areas.some((area, index) => area !== snapshots[index]?.owner)
  )) {
    throw new Error('设计已在导出准备期间更改，请重试')
  }
  for (const snapshot of snapshots) {
    if (state.areas.find((area) => area.id === snapshot.owner.id) !== snapshot.owner) {
      throw new Error('设计已在导出准备期间更改，请重试')
    }
  }
}

function captureModelSnapshot(): ExportModelSnapshot {
  const state = useModelStore.getState()
  if (!state.glbBytes) throw new Error('需要先加载模型并设计标签')
  return { glbBytes: state.glbBytes, modelName: state.modelName, analysis: state.analysis }
}

function assertModelOwnership(snapshot: ExportModelSnapshot): void {
  const state = useModelStore.getState()
  if (
    state.glbBytes !== snapshot.glbBytes
    || state.modelName !== snapshot.modelName
    || state.analysis !== snapshot.analysis
  ) {
    throw new Error('模型已在导出准备期间更改，请重试')
  }
}

async function waitForExportFonts(snapshots: ExportAreaSnapshot[]): Promise<void> {
  const visibleLayers = snapshots.map(({ owner }) => owner.layers.filter((layer) => layer.visible))
  const reports = await Promise.all(snapshots.map(({ owner }, index) => (
    waitForDesignFonts(visibleLayers[index], owner.fonts)
  )))
  const unavailableNames = new Set(reports.flatMap((report) => report.unavailable))
  const unavailableInDesignOrder = new Set<string>()
  snapshots.forEach(({ owner }, index) => {
    deriveDesignFontRequests(visibleLayers[index], owner.fonts).forEach((request) => {
      if (unavailableNames.has(request.name)) unavailableInDesignOrder.add(request.name)
    })
  })
  if (unavailableInDesignOrder.size > 0) {
    throw new Error(`字体尚未就绪：${[...unavailableInDesignOrder].join('、')}`)
  }
}

function staleAreaBakeError(snapshot: ExportAreaSnapshot): Error {
  return new Error(`贴标区域「${snapshot.owner.name}」尚未完成当前设计与字体的烘焙：请打开该区域并在 2D 设计或 2D + 3D 视图中刷新后重试`)
}

function refreshExportBake(snapshot: ExportAreaSnapshot): BakeResult {
  const surface = exportBakeSurfaces.get(snapshot.owner.id)
  if (!surface) {
    throw new Error(`贴标区域「${snapshot.owner.name}」无法刷新：请打开该区域并切换到 2D 设计或 2D + 3D 视图后重试`)
  }
  if (!surface.requestBake()) {
    throw new Error(`贴标区域「${snapshot.owner.name}」无法刷新：请打开该区域并切换到 2D 设计或 2D + 3D 视图后重试`)
  }
  const bake = useLabelStore.getState().bakeMap[snapshot.owner.id]
  if (!bake || bake.version <= snapshot.bakeVersion) {
    throw new Error(`贴标区域「${snapshot.owner.name}」未完成最新烘焙，请重试`)
  }
  return frozenBakeCopy(bake, snapshot.owner, snapshot.fontReadinessKey)
}

function freezeExportBakes(snapshots: ExportAreaSnapshot[]): Readonly<Record<string, BakeResult>> {
  const entries = snapshots.map((snapshot): [string, BakeResult] => {
    if (exportBakeSurfaces.has(snapshot.owner.id)) {
      return [snapshot.owner.id, refreshExportBake(snapshot)]
    }
    const bake = snapshot.bake
    if (
      !bake
      || bake.areaOwner !== snapshot.owner
      || bake.fontReadinessKey !== snapshot.fontReadinessKey
    ) {
      throw staleAreaBakeError(snapshot)
    }
    return [snapshot.owner.id, frozenBakeCopy(bake, snapshot.owner, snapshot.fontReadinessKey)]
  })
  return Object.freeze(Object.fromEntries(entries))
}

async function prepareActiveExportSnapshot(): Promise<{ snapshot: ExportAreaSnapshot; bake: BakeResult }> {
  const state = useLabelStore.getState()
  const activeAreaId = state.activeAreaId
  const area = activeAreaId ? state.areas.find((candidate) => candidate.id === activeAreaId) : undefined
  if (!activeAreaId || !area) throw new Error('尚无可导出的标签')
  const snapshot = captureExportAreas([area], state.bakeMap)[0]
  await waitForExportFonts([snapshot])
  assertExportAreaOwnership([snapshot], activeAreaId)
  const refreshed = freezeExportBakes([snapshot])[snapshot.owner.id]
  assertExportAreaOwnership([snapshot], activeAreaId)
  return { snapshot, bake: refreshed }
}

/** 导出激活区域的标签纹理 PNG。 */
export async function exportPng(): Promise<void> {
  try {
    const { snapshot, bake } = await prepareActiveExportSnapshot()
    const bytes = await canvasToPngBytes(bake.color)
    assertExportAreaOwnership([snapshot], snapshot.owner.id)
    downloadBytes(bytes, `label-${bake.spec.width}x${bake.spec.height}.png`, 'image/png')
    flashToast(`已导出标签纹理 ${bake.spec.width}×${bake.spec.height}px`, 'success')
  } catch (err) {
    flashToast(err instanceof Error ? err.message : '导出失败', 'error')
  }
}

/** 导出重打包 GLB（所有贴标区域，Worker + 交叉自检）。 */
export async function exportGlbFile(): Promise<void> {
  const ms = useModelStore.getState()
  const ls = useLabelStore.getState()
  if (!ms.glbBytes || ls.areas.length === 0) {
    flashToast('需要先加载模型并设计标签', 'error')
    return
  }
  // 每个区域需要 remapOutput —— remapOutput 只存 active 区域！需要每区域存。
  // 解决：遍历区域时若缺 output 则用 meshAccessors 重算（active 区域的 accessors 可能不匹配其它区域）。
  // —— 见下方 prepareAreaOutputs：从 glbBytes 重新提取每个区域对应网格并重算。
  try {
    const modelSnapshot = captureModelSnapshot()
    const snapshots = captureExportAreas(ls.areas, ls.bakeMap)
    const activeAreaId = ls.activeAreaId
    const activeSnapshot = activeAreaId
      ? snapshots.find((snapshot) => snapshot.owner.id === activeAreaId)
      : undefined
    if (!activeAreaId || !activeSnapshot) {
      throw new Error('导出前无法确定当前贴标区域，请打开区域并切换到 2D 设计或 2D + 3D 视图后重试')
    }
    await waitForExportFonts(snapshots)
    assertExportAreaOwnership(snapshots, activeAreaId, true)
    assertModelOwnership(modelSnapshot)
    const bakeInputs = freezeExportBakes(snapshots)
    assertExportAreaOwnership(snapshots, activeAreaId, true)
    assertModelOwnership(modelSnapshot)
    flashToast(`正在重打包 GLB（${ls.areas.length} 个贴标区域）…`, 'info')
    const { prepareAllAreas } = await import('./areaExporter')
    assertExportAreaOwnership(snapshots, activeAreaId, true)
    assertModelOwnership(modelSnapshot)
    const prepared = await prepareAllAreas(modelSnapshot.glbBytes, snapshots.map(({ area }) => area), bakeInputs)
    assertExportAreaOwnership(snapshots, activeAreaId, true)
    assertModelOwnership(modelSnapshot)
    if (prepared.length === 0) {
      flashToast('没有可导出的贴标区域（请先添加并设计）', 'error')
      return
    }
    const result = await exportGlb({
      glb: modelSnapshot.glbBytes,
      areas: prepared,
    })
    assertExportAreaOwnership(snapshots, activeAreaId, true)
    assertModelOwnership(modelSnapshot)
    if (!result.ok || !result.glbBytes) {
      flashToast(`导出失败：${result.error ?? '未知错误'}（可改用仅导出 PNG）`, 'error')
      return
    }
    console.log('[export] crossCheck =', JSON.stringify(result.crossCheck), 'bytes =', result.glbBytes.length)
    ;(window as unknown as { __lastExport?: unknown }).__lastExport = { bytes: result.glbBytes, crossCheck: result.crossCheck }
    const checks = [
      result.crossCheck?.error,
      result.crossCheck?.loaded === false ? '交叉解析失败' : null,
      result.crossCheck?.uvSampleOk === false ? 'UV 校验不一致' : null,
    ].filter(Boolean)
    if (checks.length > 0) {
      flashToast(`导出自检未通过：${checks.join('；')}——已保留原文件`, 'error')
      return
    }
    assertExportAreaOwnership(snapshots, activeAreaId, true)
    assertModelOwnership(modelSnapshot)
    const base = modelSnapshot.modelName.replace(/\.glb$/i, '') || 'model'
    downloadBytes(result.glbBytes, `${base}-label-edited.glb`, 'model/gltf-binary')
    flashToast(`已导出 GLB（${prepared.length} 个区域，自检通过）`, 'success')
  } catch (err) {
    flashToast(err instanceof Error ? err.message : '导出失败', 'error')
  }
}

/** 导出项目 .lbl（JSON，多区域，不含模型字节）。 */
export function exportProject(): void {
  const ls = useLabelStore.getState()
  const ms = useModelStore.getState()
  if (ls.areas.length === 0) {
    flashToast('没有可导出的标签项目', 'error')
    return
  }
  const project = serializeLabelProject(ms.modelName, ls.areas)
  const bytes = new TextEncoder().encode(JSON.stringify(project, null, 2))
  downloadBytes(bytes, `label-project-${Date.now()}.lbl.json`, 'application/json')
  flashToast(`项目已导出（${ls.areas.length} 个贴标区域）`, 'success')
}

/** 导入项目 .lbl（JSON schema 校验，防 prototype pollution）。 */
export function importProject(file: File): Promise<void> {
  return new Promise((res, rej) => {
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const parsed = parseLabelProject(JSON.parse(String(reader.result)))
        const areas = parsed.areas
        const ls = useLabelStore.getState()
        if (useModelStore.getState().glbBytes === null) {
          rej(new Error('请先加载模型，再导入项目（.lbl 只含设计数据，不含模型）'))
          return
        }
        const glbBytes = useModelStore.getState().glbBytes
        const currentModelName = useModelStore.getState().modelName
        if (parsed.modelFileName && currentModelName && parsed.modelFileName !== currentModelName) {
          rej(new Error(`项目基于 ${parsed.modelFileName}，当前模型是 ${currentModelName}`))
          return
        }
        // .lbl 只保存稳定的设计/映射参数，three/gltf 运行时数据必须从当前 GLB
        // 重建。旧项目还可能缺少节点镜像手性；导入时一并从 GLB 补齐。
        const restoredAreas: typeof areas = []
        let activeRuntime: Awaited<ReturnType<typeof restoreImportedAreaRuntime>> | null = null
        for (const area of areas) {
          const runtime = await restoreImportedAreaRuntime(glbBytes!, area)
          restoredAreas.push({ ...area, remap: runtime.remap })
          activeRuntime = runtime
        }
        ls.clearAll()
        for (const area of restoredAreas) ls.addArea(area)
        const activeArea = restoredAreas[restoredAreas.length - 1]
        if (!activeArea || !glbBytes) throw new Error('项目没有可恢复的贴标区域')
        if (!activeRuntime) throw new Error('项目运行时恢复失败')
        ls.setAreaData(activeRuntime.remapOutput, activeRuntime.meshAccessors)
        const ui = useUiStore.getState()
        ui.setView('editor')
        ui.setWorkspaceTab('labels')
        ui.setMode('design')
        if (ui.editorViewMode === '3d') ui.setEditorViewMode('split')
        flashToast(`已导入项目（${areas.length} 个贴标区域）`, 'success')
        res()
      } catch (err) {
        rej(err instanceof Error ? err : new Error('解析失败'))
      }
    }
    reader.onerror = () => rej(new Error('读取文件失败'))
    reader.readAsText(file)
  })
}

/** 全局快捷键。 */
let shortcutDuplicateSeq = 0

function nextDuplicateLayerId(existing: Set<string>): string {
  let id = ''
  do id = `l${Date.now()}-${++shortcutDuplicateSeq}`
  while (existing.has(id))
  existing.add(id)
  return id
}

function blocksCanvasMutationShortcut(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as HTMLElement
  const tagName = element.tagName?.toUpperCase()
  if (tagName && ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(tagName)) return true
  if (element.isContentEditable) return true
  return Boolean(element.closest?.('[role="tablist"], [role="toolbar"], [role="group"], [role="menu"], [data-editor-control]'))
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    const editingTarget = t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    if (editingTarget && !e.ctrlKey && !e.metaKey) return
    const ls = useLabelStore.getState()
    const ui = useUiStore.getState()
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) ls.redo()
      else ls.undo()
    } else if (mod && e.key.toLowerCase() === 'd') {
      if (blocksCanvasMutationShortcut(t)) return
      e.preventDefault()
      const area = ls.activeArea
      if (area) {
        const selectedIds = new Set(ls.selectedLayerIds)
        const originals = area.layers.filter((layer) => selectedIds.has(layer.id) && !layer.locked)
        if (originals.length > 0) {
          const existingIds = new Set(area.layers.map((layer) => layer.id))
          const baseZIndex = Math.max(-1, ...area.layers.map((layer) => layer.zIndex))
          const copies = originals.map((layer, index) => ({
            ...layer,
            id: nextDuplicateLayerId(existingIds),
            x: layer.x + 30,
            y: layer.y + 30,
            zIndex: baseZIndex + index + 1,
          } as LabelLayer))
          ls.applyAreaOp(area.id, (current) => ({ ...current, layers: [...current.layers, ...copies] }))
          ls.selectLayers(copies.map((layer) => layer.id))
        }
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (blocksCanvasMutationShortcut(t)) return
      const area = ls.activeArea
      const selectedIds = new Set(ls.selectedLayerIds)
      const deletableIds = new Set(area?.layers.filter((layer) => selectedIds.has(layer.id) && !layer.locked).map((layer) => layer.id) ?? [])
      if (area && deletableIds.size > 0 && !editingTarget) {
        e.preventDefault()
        ls.applyAreaOp(area.id, (current) => ({ ...current, layers: current.layers.filter((layer) => !deletableIds.has(layer.id)) }))
      }
    } else if (!mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (blocksCanvasMutationShortcut(t)) return
      const area = ls.activeArea
      const selectedIds = new Set(ls.selectedLayerIds)
      const hasNudgeableLayer = area?.layers.some((layer) => selectedIds.has(layer.id) && !layer.locked) ?? false
      if (area && hasNudgeableLayer) {
        e.preventDefault()
        const distance = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -distance : e.key === 'ArrowRight' ? distance : 0
        const dy = e.key === 'ArrowUp' ? -distance : e.key === 'ArrowDown' ? distance : 0
        ls.applyAreaOp(area.id, (current) => ({ ...current, layers: nudgeLayers(current.layers, ls.selectedLayerIds, dx, dy) }))
      }
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault()
      ui.setCanvasZoom(Math.min(4, ui.canvasZoom + 0.25))
    } else if (mod && e.key === '-') {
      e.preventDefault()
      ui.setCanvasZoom(Math.max(0.25, ui.canvasZoom - 0.25))
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

void exportPng
void useUiStore
