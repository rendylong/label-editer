/**
 * zustand 状态：modelStore（模型/部件/选中）+ labelStore（多贴标区域 + mutation 网关 + 增量撤销）+ uiStore。
 * 所有标签变更必须经 applyAreaOp（mutation 网关），保证撤销/重做与副作用一致。
 */

import { create } from 'zustand'
import type { GlbAnalysis, LabelAreaConfig, LabelLayer, PartNode, RemapParams, CanvasSpec, CraftEffect, AreaSnapshot, LabelAreaRange } from '../label/types'
import { computeRemap, deriveCanvasSpec, deriveSurfaceCanvasSpec, type MeshAccessors, type RemapOutput } from '../glb/uvRemap'
import { normalizeAreaRange } from '../glb/areaMath'
import { assertRasterAspect, assertRasterDimensions, withBakeCanvasSize } from '../app/canvasLayout'
import { assertPhysicalAreaPlacement, resolveLayersForCanvas } from '../app/physicalLayout'

export interface BakeResult {
  color: HTMLCanvasElement
  metalness?: HTMLCanvasElement
  roughness?: HTMLCanvasElement
  bump?: HTMLCanvasElement
  whiteUnderbase?: HTMLCanvasElement
  spec: CanvasSpec
  version: number
  /** Visible text layers whose approved copy did not fit the rendered layout. */
  textOverflowLayerIds?: string[]
  /** Exact immutable design owner rendered into this bake. Runtime-only. */
  areaOwner?: LabelAreaConfig
  /** Visible-font request identity that was ready when this bake completed. Runtime-only. */
  fontReadinessKey?: string
  /** Successful visible font + image identity bound to this exact bake. Runtime-only. */
  assetReadinessKey?: string
  /** Successful full-byte image receipts bound to this exact bake. Runtime-only. */
  imageAssetReceipts?: Record<string, string>
}

// ── modelStore ────────────────────────────────────────────────────────
export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ModelState {
  status: ModelStatus
  error: string | null
  modelName: string
  glbBytes: Uint8Array | null
  analysis: GlbAnalysis | null
  parts: PartNode[]
  selectedPartId: string | null
  hiddenIds: Set<string>
  loadModel: (name: string, bytes: Uint8Array, analysis: GlbAnalysis) => void
  setStatus: (s: ModelStatus, err?: string | null) => void
  selectPart: (id: string | null) => void
  toggleVisible: (id: string) => void
}

export const useModelStore = create<ModelState>((set, get) => ({
  status: 'idle',
  error: null,
  modelName: '',
  glbBytes: null,
  analysis: null,
  parts: [],
  selectedPartId: null,
  hiddenIds: new Set(),
  loadModel: (name, bytes, analysis) =>
    set(() => {
      if (useLabelStore.getState().activeAreaId === null) useUiStore.getState().setWorkspaceTab('model')
      return { modelName: name, glbBytes: bytes, analysis, parts: analysis.parts, status: 'ready', error: null }
    }),
  setStatus: (s, err) => set({ status: s, error: err ?? null }),
  selectPart: (id) => set({ selectedPartId: id }),
  toggleVisible: (id) => {
    const hidden = new Set(get().hiddenIds)
    if (hidden.has(id)) hidden.delete(id)
    else hidden.add(id)
    set({ hiddenIds: hidden })
  },
}))

// ── labelStore（多贴标区域）──────────────────────────────────────────
interface LabelState {
  /** 所有贴标区域（可多个） */
  areas: LabelAreaConfig[]
  /** 当前激活区域 id */
  activeAreaId: string | null
  /** 当前激活区域对象（派生引用，组件直接使用） */
  activeArea: LabelAreaConfig | null
  /** 激活区域的 meshIndex（兼容旧引用） */
  meshIndex: number | null
  nodeName: string
  remapOutput: RemapOutput | null
  meshAccessors: MeshAccessors | null
  /** 当前激活区域中选中的图层 ids；这是图层选择的唯一数据源。 */
  selectedLayerIds: string[]
  /** 每区域烘焙结果（canvas 非序列化，独立存储） */
  bakeMap: Record<string, BakeResult>
  activations: number

  addArea: (area: Omit<LabelAreaConfig, 'undoStack' | 'redoStack' | 'id'> & { id?: string }) => string
  removeArea: (id: string) => void
  activateArea: (id: string | null) => void
  /** Activate an area together with its matching mesh/remap runtime in one commit. */
  activateAreaWithRuntime: (
    id: string,
    runtime: { remapOutput: RemapOutput; meshAccessors: MeshAccessors },
  ) => void
  /** mutation 网关：对指定区域应用不可变更新并记录撤销快照 */
  applyAreaOp: (areaId: string, updater: (a: LabelAreaConfig) => LabelAreaConfig, opts?: { commit?: boolean }) => void
  /** 作用于激活区域的撤销/重做 */
  undo: () => void
  redo: () => void
  selectLayers: (ids: string[]) => void
  toggleLayerSelection: (id: string) => void
  clearLayerSelection: () => void
  setBake: (areaId: string, bake: BakeResult | null) => void
  /** Change raster bake resolution without mutating approved physical source metadata. */
  setAreaBakeSize: (areaId: string, width: number, height: number) => void
  /** 拖拽合并：显式推入撤销快照（prev 为拖拽开始前状态） */
  pushAreaHistory: (areaId: string, prev: AreaSnapshot, next: AreaSnapshot) => void
  setAreaData: (remapOutput: RemapOutput | null, meshAccessors: MeshAccessors | null) => void
  /** 调整区域范围（尺寸/位置）。light=true 只更新 range（拖拽中，不重算几何/画布）；默认全量重算 remap 输出与画布 */
  updateAreaRange: (areaId: string, range: Partial<LabelAreaRange>, opts?: { light?: boolean }) => void
  renameArea: (id: string, name: string) => void
  /** Replace the complete editable area set and active runtime in one Zustand commit. */
  replaceAreasAtomically: (
    areas: LabelAreaConfig[],
    activeAreaId: string,
    runtime: { remapOutput: RemapOutput; meshAccessors: MeshAccessors },
  ) => void
  clearAll: () => void
}

function snapshotOf(a: LabelAreaConfig): AreaSnapshot {
  return { paper: a.paper, layers: a.layers, globalCraft: a.globalCraft.craft, referenceVisible: a.referenceVisible, remap: a.remap, range: a.range }
}

function applySnapshot(a: LabelAreaConfig, s: AreaSnapshot): LabelAreaConfig {
  return { ...a, paper: s.paper, layers: s.layers, globalCraft: { craft: s.globalCraft }, referenceVisible: s.referenceVisible, remap: s.remap, range: s.range }
}

let areaSeq = 0

export const useLabelStore = create<LabelState>((set, get) => ({
  areas: [],
  activeAreaId: null,
  activeArea: null,
  meshIndex: null,
  nodeName: '',
  remapOutput: null,
  meshAccessors: null,
  selectedLayerIds: [],
  bakeMap: {},
  activations: 0,

  addArea: (input) => {
    const id = input.id ?? `area-${++areaSeq}`
    const area: LabelAreaConfig = { ...input, id, name: input.name || input.nodeName || '贴标区域', undoStack: [], redoStack: [] }
    set((s) => {
      // 同 id 替换（避免重复区域）
      const areas = [...s.areas.filter((a) => a.id !== id), area]
      return {
        areas,
        activeAreaId: id,
        activeArea: area,
        meshIndex: area.meshIndex,
        nodeName: area.nodeName,
        remapOutput: s.remapOutput,
        meshAccessors: s.meshAccessors,
        selectedLayerIds: [],
        activations: s.activations + 1,
      }
    })
    useUiStore.getState().setWorkspaceTab('labels')
    return id
  },

  removeArea: (id) => {
    const s = get()
    const areas = s.areas.filter((a) => a.id !== id)
    const wasActive = s.activeAreaId === id
    const nextActive = wasActive ? (areas[areas.length - 1] ?? null) : s.areas.find((a) => a.id === s.activeAreaId) ?? null
    set({
      areas,
      activeAreaId: nextActive ? nextActive.id : null,
      activeArea: nextActive,
      meshIndex: nextActive ? nextActive.meshIndex : null,
      nodeName: nextActive ? nextActive.nodeName : '',
      remapOutput: wasActive ? null : s.remapOutput,
      meshAccessors: wasActive ? null : s.meshAccessors,
      selectedLayerIds: wasActive ? [] : s.selectedLayerIds,
      bakeMap: omitKey(s.bakeMap, id),
    })
    if (!nextActive) useUiStore.getState().setWorkspaceTab('model')
  },

  activateArea: (id) => {
    const s = get()
    const area = s.areas.find((a) => a.id === id) ?? null
    set({
      activeAreaId: area ? area.id : null,
      activeArea: area,
      meshIndex: area ? area.meshIndex : null,
      nodeName: area ? area.nodeName : '',
      selectedLayerIds: [],
      activations: s.activations + (area?.layers.some((layer) => layer.kind === 'image' && layer.visible) ? 1 : 0),
    })
    useUiStore.getState().setWorkspaceTab(area ? 'labels' : 'model')
  },

  activateAreaWithRuntime: (id, runtime) => {
    const area = get().areas.find((candidate) => candidate.id === id)
    if (!area) throw new Error(`无法激活不存在的贴标区域：${id}`)
    set((state) => ({
      activeAreaId: area.id,
      activeArea: area,
      meshIndex: area.meshIndex,
      nodeName: area.nodeName,
      remapOutput: runtime.remapOutput,
      meshAccessors: runtime.meshAccessors,
      selectedLayerIds: [],
      activations: state.activations + (area.layers.some((layer) => layer.kind === 'image' && layer.visible) ? 1 : 0),
    }))
    useUiStore.getState().setWorkspaceTab('labels')
  },

  applyAreaOp: (areaId, updater, opts) => {
    const s = get()
    const area = s.areas.find((a) => a.id === areaId)
    if (!area) return
    const commit = opts?.commit ?? true
    const prev = snapshotOf(area)
    const next = updater(area)
    if (next === area) return
    if (commit) {
      const areas = s.areas.map((a) => (a.id === areaId ? { ...next, undoStack: [...a.undoStack.slice(-199), prev], redoStack: [] } : a))
      const updated = areas.find((a) => a.id === areaId)!
      const selectedLayerIds = s.activeAreaId === areaId ? existingLayerIds(s.selectedLayerIds, updated.layers) : s.selectedLayerIds
      set({ areas, activeArea: s.activeAreaId === areaId ? updated : s.activeArea, selectedLayerIds, ...(s.activeAreaId === areaId ? { meshIndex: updated.meshIndex, nodeName: updated.nodeName } : {}) })
    } else {
      const areas = s.areas.map((a) => (a.id === areaId ? next : a))
      const updated = areas.find((a) => a.id === areaId)!
      const selectedLayerIds = s.activeAreaId === areaId ? existingLayerIds(s.selectedLayerIds, updated.layers) : s.selectedLayerIds
      set({ areas, activeArea: s.activeAreaId === areaId ? updated : s.activeArea, selectedLayerIds })
    }
  },

  undo: () => {
    const s = get()
    const area = s.activeArea
    if (!area || area.undoStack.length === 0) return
    const prev = area.undoStack[area.undoStack.length - 1]
    const current = snapshotOf(area)
    const next = applySnapshot(area, prev)
    const areas = s.areas.map((a) => (a.id === area.id ? { ...next, undoStack: a.undoStack.slice(0, -1), redoStack: [...a.redoStack, current] } : a))
    const updated = areas.find((a) => a.id === area.id)!
    set({ areas, activeArea: updated, selectedLayerIds: existingLayerIds(s.selectedLayerIds, updated.layers) })
  },

  redo: () => {
    const s = get()
    const area = s.activeArea
    if (!area || area.redoStack.length === 0) return
    const nextSnap = area.redoStack[area.redoStack.length - 1]
    const current = snapshotOf(area)
    const next = applySnapshot(area, nextSnap)
    const areas = s.areas.map((a) => (a.id === area.id ? { ...next, redoStack: a.redoStack.slice(0, -1), undoStack: [...a.undoStack, current] } : a))
    const updated = areas.find((a) => a.id === area.id)!
    set({ areas, activeArea: updated, selectedLayerIds: existingLayerIds(s.selectedLayerIds, updated.layers) })
  },

  selectLayers: (ids) =>
    set((s) => ({ selectedLayerIds: existingLayerIds(ids, s.activeArea?.layers ?? []) })),
  toggleLayerSelection: (id) =>
    set((s) => {
      if (!s.activeArea?.layers.some((layer) => layer.id === id)) return s
      return {
        selectedLayerIds: s.selectedLayerIds.includes(id)
          ? s.selectedLayerIds.filter((selectedId) => selectedId !== id)
          : [...s.selectedLayerIds, id],
      }
    }),
  clearLayerSelection: () => set({ selectedLayerIds: [] }),
  setBake: (areaId, bake) =>
    set((s) => {
      const bakeMap = { ...s.bakeMap }
      if (bake === null) delete bakeMap[areaId]
      else {
        assertRasterAspect(bake.spec)
        for (const canvas of [bake.color, bake.metalness, bake.roughness, bake.bump, bake.whiteUnderbase]) {
          if (!canvas) continue
          assertRasterDimensions(canvas, bake.spec)
        }
        bakeMap[areaId] = bake
      }
      return { bakeMap }
    }),
  setAreaBakeSize: (areaId, width, height) =>
    set((s) => {
      const areas = s.areas.map((area) => {
        if (area.id !== areaId) return area
        const canvas = withBakeCanvasSize(area.canvas, { width, height })
        const next = { ...area, canvas }
        assertPhysicalAreaPlacement(next)
        return { ...next, layers: resolveLayersForCanvas(area, canvas) }
      })
      const updated = areas.find((area) => area.id === areaId)
      return {
        areas,
        activeArea: s.activeAreaId === areaId && updated ? updated : s.activeArea,
        bakeMap: updated ? omitKey(s.bakeMap, areaId) : s.bakeMap,
      }
    }),
  pushAreaHistory: (areaId, prev, next) =>
    set((s) => {
      const areas = s.areas.map((a) => (a.id === areaId ? { ...a, undoStack: [...a.undoStack.slice(-199), prev], redoStack: [] } : a))
      const updated = areas.find((a) => a.id === areaId)!
      return { areas, activeArea: s.activeAreaId === areaId ? updated : s.activeArea }
    }),
  /** 记录激活区域的 remap 输出与原始 accessors（供重算） */
  setAreaData: (remapOutput: RemapOutput | null, meshAccessors: MeshAccessors | null) => set({ remapOutput, meshAccessors }),

  updateAreaRange: (areaId, rangePatch, opts) => {
    const s = get()
    const area = s.areas.find((a) => a.id === areaId)
    const mesh = area ? (s.meshAccessors ?? null) : null
    if (!area) return
    const range: LabelAreaRange = normalizeAreaRange({
      uStart: rangePatch.uStart ?? area.range.uStart,
      uWidth: rangePatch.uWidth ?? area.range.uWidth,
      vStart: rangePatch.vStart ?? area.range.vStart,
      vHeight: rangePatch.vHeight ?? area.range.vHeight,
    })
    const light = opts?.light === true
    let remapOutput: RemapOutput | null = s.remapOutput
    let canvas = area.canvas
    if (mesh && !light) {
      remapOutput = computeRemap(mesh, area.remap, range, { exteriorOnly: area.surfaceMode === 'overlay' })
      const fallbackCanvas = deriveCanvasSpec(area.remap.radius, cylinderHeight(mesh, area.remap), area.remap.wrap, range.uWidth, range.vHeight)
      canvas = deriveSurfaceCanvasSpec(remapOutput, fallbackCanvas.aspect)
    }
    const areas = s.areas.map((a) => {
      if (a.id !== areaId) return a
      const next = { ...a, range, canvas }
      assertPhysicalAreaPlacement(next)
      return { ...next, layers: resolveLayersForCanvas(a, canvas) }
    })
    const updated = areas.find((a) => a.id === areaId)!
    set({
      areas,
      activeArea: s.activeAreaId === areaId ? updated : s.activeArea,
      ...(s.activeAreaId === areaId && mesh && !light ? { remapOutput } : {}),
    })
  },

  renameArea: (id, name) => {
    const s = get()
    const areas = s.areas.map((a) => (a.id === id ? { ...a, name } : a))
    const updated = areas.find((a) => a.id === id)!
    set({ areas, activeArea: s.activeAreaId === id ? updated : s.activeArea })
  },

  replaceAreasAtomically: (areas, activeAreaId, runtime) => {
    const activeArea = areas.find((area) => area.id === activeAreaId)
    if (!activeArea) throw new Error(`无法激活不存在的贴标区域：${activeAreaId}`)
    set((state) => ({
      areas,
      activeAreaId,
      activeArea,
      meshIndex: activeArea.meshIndex,
      nodeName: activeArea.nodeName,
      remapOutput: runtime.remapOutput,
      meshAccessors: runtime.meshAccessors,
      selectedLayerIds: [],
      bakeMap: {},
      activations: state.activations + 1,
    }))
    useUiStore.getState().setWorkspaceTab('labels')
  },

  clearAll: () =>
    set({ areas: [], activeAreaId: null, activeArea: null, meshIndex: null, nodeName: '', remapOutput: null, meshAccessors: null, selectedLayerIds: [], bakeMap: {} }),
}))

function existingLayerIds(ids: string[], layers: LabelLayer[]): string[] {
  const existing = new Set(layers.map((layer) => layer.id))
  const seen = new Set<string>()
  const selected: string[] = []
  for (const id of ids) {
    if (!existing.has(id) || seen.has(id)) continue
    seen.add(id)
    selected.push(id)
  }
  return selected
}

function omitKey<K extends string, V>(obj: Record<K, V>, key: string): Record<K, V> {
  const out = { ...obj }
  delete (out as Record<string, V>)[key]
  return out
}

function cylinderHeight(mesh: MeshAccessors, remap: RemapParams): number {
  let aMin = Infinity
  let aMax = -Infinity
  const n = mesh.positions.length / 3
  for (let i = 0; i < n; i++) {
    const along = (mesh.positions[i * 3] - remap.origin[0]) * remap.axis[0] + (mesh.positions[i * 3 + 1] - remap.origin[1]) * remap.axis[1] + (mesh.positions[i * 3 + 2] - remap.origin[2]) * remap.axis[2]
    if (along < aMin) aMin = along
    if (along > aMax) aMax = along
  }
  return Math.max(aMax - aMin, 1e-6)
}

// ── uiStore ───────────────────────────────────────────────────────────
export type EditorViewMode = '2d' | 'split' | '3d'
export interface AgentPreviewStatus {
  revision: string
  state: 'ready' | 'error'
  message?: string
}

interface UiState {
  /** 仅供独立贴标区域设置流程使用。 */
  mode: 'browse' | 'design'
  /** editor: 编辑器；areaSetup: 贴标区域设置独立流程 */
  view: 'editor' | 'areaSetup'
  workspaceTab: 'labels' | 'model'
  /** 中央编辑工作区视图；不参与项目数据、图层选择或撤销栈。 */
  editorViewMode: EditorViewMode
  agentPreviewStatus: AgentPreviewStatus | null
  canvasZoom: number
  showSeam: boolean
  channelView: 'color' | 'metalness' | 'roughness' | 'bump' | null
  areaSetupEditAreaId: string | null
  areaSetupSide: 'front' | 'back'
  toast: { msg: string; kind: 'info' | 'success' | 'error' } | null
  /** Inspector-only preferences. These never participate in label snapshots. */
  favoriteFontIds: string[]
  recentFontIds: string[]
  inspectorSections: Record<string, Record<string, boolean>>
  setView: (v: 'editor' | 'areaSetup') => void
  setWorkspaceTab: (tab: UiState['workspaceTab']) => void
  setMode: (m: 'browse' | 'design') => void
  setEditorViewMode: (mode: EditorViewMode) => void
  setAgentPreviewStatus: (status: AgentPreviewStatus) => void
  setCanvasZoom: (z: number) => void
  toggleSeam: () => void
  setChannelView: (c: UiState['channelView']) => void
  startAreaSetup: (editAreaId?: string | null, side?: 'front' | 'back') => void
  toastMsg: (msg: string, kind?: 'info' | 'success' | 'error') => void
  clearToast: () => void
  toggleFavoriteFont: (id: string) => void
  rememberRecentFont: (id: string) => void
  setInspectorSectionOpen: (objectType: string, sectionId: string, open: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  mode: 'browse',
  view: 'editor',
  workspaceTab: 'model',
  editorViewMode: '2d',
  agentPreviewStatus: null,
  canvasZoom: 1,
  showSeam: true,
  channelView: null,
  areaSetupEditAreaId: null,
  areaSetupSide: 'front',
  toast: null,
  favoriteFontIds: [],
  recentFontIds: [],
  inspectorSections: {},
  setMode: (mode) => set({ mode }),
  setView: (view) => set({ view }),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
  setEditorViewMode: (editorViewMode) => set({ editorViewMode }),
  setAgentPreviewStatus: (agentPreviewStatus) => set({ agentPreviewStatus }),
  setCanvasZoom: (canvasZoom) => set({ canvasZoom }),
  toggleSeam: () => set((s) => ({ showSeam: !s.showSeam })),
  setChannelView: (channelView) => set({ channelView }),
  startAreaSetup: (areaSetupEditAreaId = null, areaSetupSide = 'front') => set({
    areaSetupEditAreaId, areaSetupSide, workspaceTab: 'model', view: 'areaSetup', mode: 'browse',
  }),
  toastMsg: (msg, kind = 'info') => set({ toast: { msg, kind } }),
  clearToast: () => set({ toast: null }),
  toggleFavoriteFont: (id) => set((state) => ({
    favoriteFontIds: state.favoriteFontIds.includes(id)
      ? state.favoriteFontIds.filter((fontId) => fontId !== id)
      : [...state.favoriteFontIds, id],
  })),
  rememberRecentFont: (id) => set((state) => ({
    recentFontIds: [id, ...state.recentFontIds.filter((fontId) => fontId !== id)].slice(0, 8),
  })),
  setInspectorSectionOpen: (objectType, sectionId, open) => set((state) => ({
    inspectorSections: {
      ...state.inspectorSections,
      [objectType]: { ...state.inspectorSections[objectType], [sectionId]: open },
    },
  })),
}))

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function flashToast(msg: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  useUiStore.getState().toastMsg(msg, kind)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => useUiStore.getState().clearToast(), 3500)
}
