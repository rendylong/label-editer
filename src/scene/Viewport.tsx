/**
 * 3D 视口：挂载 SceneController 并订阅各 store 驱动场景（多贴标区域）。
 */

import { useEffect, useRef, useState } from 'react'
import { SceneController } from './SceneController'
import { useModelStore, useLabelStore, useUiStore } from '../state/stores'
import { findPart } from '../glb/analyze'
import type { PartNode } from '../label/types'
import { registerAgentPreviewCapture } from '../agent/previewCapture'

/** modelStore 保存部件树 id；three 场景显隐以节点 name 定位，必须先做映射。 */
export function resolveHiddenNodeNames(parts: PartNode[], hiddenIds: Set<string>): Set<string> {
  const names = new Set<string>()
  const walk = (nodes: PartNode[]): void => {
    for (const node of nodes) {
      if (hiddenIds.has(node.id)) names.add(node.name)
      if (node.children.length > 0) walk(node.children)
    }
  }
  walk(parts)
  return names
}

export function Viewport({ showFrontMarker = false }: { showFrontMarker?: boolean } = {}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const ctrlRef = useRef<SceneController | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const loadedFor = useRef('')
  const glbInputRef = useRef<HTMLInputElement>(null)

  const statusStore = useModelStore((s) => s.status)
  const errorStore = useModelStore((s) => s.error)
  const glbBytes = useModelStore((s) => s.glbBytes)
  const modelName = useModelStore((s) => s.modelName)
  const selectedPartId = useModelStore((s) => s.selectedPartId)
  const hiddenIds = useModelStore((s) => s.hiddenIds)
  const parts = useModelStore((s) => s.parts)
  const areas = useLabelStore((s) => s.areas)
  const activeArea = useLabelStore((s) => s.activeArea)
  const remapOutput = useLabelStore((s) => s.remapOutput)
  const bakeMap = useLabelStore((s) => s.bakeMap)
  const channelView = useUiStore((s) => s.channelView)

  // 挂载 SceneController
  useEffect(() => {
    if (!hostRef.current || ctrlRef.current) return
    const ctrl = new SceneController({
      container: hostRef.current,
      onStatus: (st, m) => {
        setStatus(st)
        setMsg(m ?? '')
      },
    })
    ctrlRef.current = ctrl
    const unregisterPreview = registerAgentPreviewCapture(({ width, height }) => ctrl.capturePng(width, height))
    return () => {
      unregisterPreview()
      ctrl.dispose()
      ctrlRef.current = null
    }
  }, [])

  // 模型加载（每个模型名一次）；加载完成后应用所有区域
  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ctrl || !glbBytes) return
    if (loadedFor.current === modelName) return
    loadedFor.current = modelName
    setStatus('loading')
    void ctrl.loadModel(glbBytes).then((installed) => {
      if (!installed || ctrlRef.current !== ctrl) return
      const ls = useLabelStore.getState()
      ctrl.reconcileLabelAreas(ls.areas.map((area) => area.id))
      for (const area of ls.areas) {
        if (area.id === ls.activeAreaId && ls.remapOutput) {
          ctrl.applyLabelGeometry(ls.remapOutput, area.nodeName, area.surfaceMode ?? 'replace', area.meshIndex, area.id)
          if (showFrontMarker) ctrl.setFrontMarker(area.id, area.remap, ls.remapOutput)
          else ctrl.hideFrontMarker()
        }
        const bake = ls.bakeMap[area.id]
        if (bake) ctrl.applyLabelBake(area.id, bake)
      }
      ctrl.setChannelView(useUiStore.getState().channelView)
      ctrl.setActiveAreaHighlight(ls.activeArea?.id ?? null)
    })
  }, [glbBytes, modelName])

  // 状态同步
  useEffect(() => {
    if (statusStore === 'error') {
      setStatus('error')
      setMsg(errorStore ?? '加载失败')
    } else if (statusStore === 'loading') {
      setStatus('loading')
    }
  }, [statusStore, errorStore])

  // 激活区域：几何/正面标记/高亮（remapOutput 变化时）
  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    if (activeArea && remapOutput) {
      ctrl.applyLabelGeometry(remapOutput, activeArea.nodeName, activeArea.surfaceMode ?? 'replace', activeArea.meshIndex, activeArea.id)
      if (showFrontMarker) ctrl.setFrontMarker(activeArea.id, activeArea.remap, remapOutput)
      else ctrl.hideFrontMarker()
    }
    ctrl.setActiveAreaHighlight(activeArea?.id ?? null)
    ctrl.requestRender()
  }, [activeArea?.id, activeArea?.nodeName, remapOutput, areas.length, showFrontMarker])

  // 所有区域的烘焙应用
  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.reconcileLabelAreas(areas.map((area) => area.id))
    for (const area of areas) {
      const bake = bakeMap[area.id]
      if (bake) {
        ctrl.applyLabelBake(area.id, { color: bake.color, metalness: bake.metalness, roughness: bake.roughness, bump: bake.bump })
      }
    }
    ctrl.setChannelView(useUiStore.getState().channelView)
  }, [bakeMap, areas])

  // 部件选中高亮（浏览模式）
  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    if (!selectedPartId) {
      ctrl.setActiveAreaHighlight(useLabelStore.getState().activeArea?.id ?? null)
      return
    }
    const node = findPart(parts, selectedPartId)
    if (!node) return
    // 若选中部件是某区域的网格，保持区域高亮；否则高亮选中部件
    const isAreaMesh = useLabelStore.getState().areas.some((a) => a.nodeName === node.name)
    if (isAreaMesh) {
      const state = useLabelStore.getState()
      ctrl.setActiveAreaHighlight(state.activeArea?.nodeName === node.name ? state.activeArea.id : state.areas.find((area) => area.nodeName === node.name)?.id ?? null)
    } else {
      if (node.meshIndex !== undefined) ctrl.setSelectedMesh(node.meshIndex)
    }
  }, [selectedPartId, parts])

  // 显隐
  useEffect(() => {
    ctrlRef.current?.setHidden(resolveHiddenNodeNames(parts, hiddenIds))
  }, [hiddenIds, parts])

  // 通道视图
  useEffect(() => {
    ctrlRef.current?.setChannelView(channelView)
  }, [channelView])

  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0 }}>
      {status === 'idle' && (
        <div className="viewport-overlay">
          <div className="welcome">
            <div className="welcome-title">GLB 贴标编辑器</div>
            <div className="welcome-sub">为美妆瓶身设计标签：文字 · 图片 · 工艺（烫金/击凸/磨砂/UV/镭射）· 实时 3D 预览</div>
            <div className="welcome-actions">
              <button
                className="btn primary"
                type="button"
                onClick={() => glbInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  glbInputRef.current?.click()
                }}
              >
                打开 GLB
              </button>
              <input ref={glbInputRef} type="file" accept=".glb" hidden tabIndex={-1} aria-hidden="true" onChange={onPickFile} />
              <button className="btn secondary" onClick={onLoadSample}>
                加载示例（面霜瓶.glb）
              </button>
            </div>
          </div>
        </div>
      )}
      {status === 'loading' && <div className="viewport-overlay">正在加载 3D 模型…</div>}
      {status === 'error' && (
        <div className="viewport-overlay error">
          <div>模型加载失败：{msg}</div>
          <button className="btn secondary" onClick={() => ctrlRef.current?.requestRender()}>
            重试
          </button>
        </div>
      )}
      {status === 'ready' && <div className="viewport-hint">拖拽旋转 · 滚轮缩放 · 右键平移</div>}
    </div>
  )
}

import { loadSample, loadModelFromBytes } from '../app/modelLoader'

async function onLoadSample(): Promise<void> {
  await loadSample()
}

async function onPickFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
  const file = e.target.files?.[0]
  if (!file) return
  if (!/\.glb$/i.test(file.name)) {
    useUiStore.getState().toastMsg('v1 仅支持 .glb 文件', 'error')
    return
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  await loadModelFromBytes(file.name, bytes)
  e.target.value = ''
}
