/**
 * 贴标区域设置独立流程页面（可视化框选版）：
 * 选择目标网格 → 在展开图上拖拽矩形定义贴标区域（小区域，可拖动位置/调整大小）→ 确认创建回到编辑器。
 * 全程轻量：选中只读取预览（宽高比/纹理），创建仅在确认时执行一次。
 */

import { useEffect, useRef, useState } from 'react'
import { useModelStore, useLabelStore, useUiStore, flashToast } from '../state/stores'
import { addAreaForNode, getAreaPreview } from '../app/modelLoader'
import { AreaPicker } from './AreaPicker'
import type { PartNode, LabelAreaRange } from '../label/types'
import { Icon } from '../ui/icons'
import { displayPartName } from '../glb/analyze'

interface Preview {
  aspect: number
  nodeName: string
  nodeId: string
  meshIndex: number
}

const DEFAULT_RANGE: LabelAreaRange = { uStart: 0.3, uWidth: 0.4, vStart: 0.3, vHeight: 0.4 }

export function AreaSetupView(): React.JSX.Element {
  const parts = useModelStore((s) => s.parts)
  const selectedPartId = useModelStore((s) => s.selectedPartId)
  const selectPart = useModelStore((s) => s.selectPart)
  const areas = useLabelStore((s) => s.areas)
  const setView = useUiStore((s) => s.setView)
  const setMode = useUiStore((s) => s.setMode)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [range, setRange] = useState<LabelAreaRange>({ ...DEFAULT_RANGE })
  const [creating, setCreating] = useState(false)
  const initialAreaIds = useRef<Set<string> | null>(null)
  const autoPicked = useRef(false)

  useEffect(() => {
    initialAreaIds.current = new Set(useLabelStore.getState().areas.map((a) => a.id))
    return () => {
      initialAreaIds.current = null
    }
  }, [])

  const meshes: PartNode[] = []
  const walk = (nodes: PartNode[]): void => {
    for (const n of nodes) {
      if (n.meshIndex !== undefined) meshes.push(n)
      walk(n.children)
    }
  }
  walk(parts)

  const onPickMesh = async (node: PartNode): Promise<void> => {
    selectPart(node.id)
    setLoading(true)
    const r = await getAreaPreview(node.id)
    setLoading(false)
    if (!r.ok) {
      flashToast(r.error ?? '读取网格失败', 'error')
      return
    }
    setPreview({ aspect: r.aspect, nodeName: node.name, nodeId: node.id, meshIndex: node.meshIndex! })
    const existing = useLabelStore.getState().areas.find((a) => a.meshIndex === node.meshIndex)
    setRange(existing ? { ...existing.range } : { ...DEFAULT_RANGE })
  }

  useEffect(() => {
    if (autoPicked.current || !selectedPartId) return
    const selected = meshes.find((node) => node.id === selectedPartId)
    if (!selected) return
    autoPicked.current = true
    void onPickMesh(selected)
  }, [selectedPartId, parts])

  const onCancel = (): void => {
    const ls = useLabelStore.getState()
    if (initialAreaIds.current) {
      for (const a of [...ls.areas]) {
        if (!initialAreaIds.current.has(a.id)) ls.removeArea(a.id)
      }
    }
    setView('editor')
    setMode('browse')
  }

  const onConfirm = async (): Promise<void> => {
    if (!preview) {
      flashToast('请先选择一个网格作为贴标区域', 'error')
      return
    }
    setCreating(true)
    const r = await addAreaForNode(preview.nodeId, range)
    setCreating(false)
    if (!r.ok) {
      flashToast(r.error ?? '创建失败', 'error')
      return
    }
    setView('editor')
    setMode('design')
    const updatedExisting = areas.some((a) => a.meshIndex === preview.meshIndex)
    flashToast(`${updatedExisting ? '已更新' : '已创建'}贴标区域「${preview.nodeName}」（环绕 ${Math.round(range.uWidth * 100)}% · 高 ${Math.round(range.vHeight * 100)}%）`, 'success')
  }

  const editingExisting = preview ? areas.some((a) => a.meshIndex === preview.meshIndex) : false

  return (
    <div className="setup-root">
      <div className="setup-header">
        <div className="brand">
          <span className="brand-mark">{Icon.label(16)}</span>
          <span>设置贴标区域</span>
        </div>
        <div className="toolbar-group">
          <span className="hint">① 选择目标表面 → ② 在 2D 展开图上定义区域 → ③ 完成</span>
          <button className="btn secondary sm" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary sm" onClick={() => void onConfirm()} disabled={!preview || creating}>
            {creating ? '保存中…' : editingExisting ? '更新区域' : '创建区域'}
          </button>
        </div>
      </div>
      <div className="setup-body">
        <aside className="setup-left">
          <div className="panel-title">选择目标表面</div>
          <div className="tree">
            {meshes.length === 0 && <div className="empty-hint">没有可用的网格部件</div>}
            {meshes.map((m) => {
              const hasArea = areas.some((a) => a.meshIndex === m.meshIndex)
              const isPicked = preview?.nodeId === m.id
              return (
                <div key={m.id} className={`tree-row ${isPicked ? 'selected' : ''}`} onClick={() => void onPickMesh(m)}>
                  <span className={`tree-icon ${hasArea ? 'tree-icon--accent' : 'tree-icon--decorative'}`}>
                    {hasArea ? Icon.label(13) : Icon.cube(13)}
                  </span>
                  <span className="tree-name">{displayPartName(m.name)}</span>
                  {hasArea && <span className="tree-badge">可编辑</span>}
                  {m.triangleCount !== undefined && <span className="tree-meta">{m.triangleCount.toLocaleString()}▲</span>}
                </div>
              )
            })}
          </div>
          {preview && (
            <div className="panel" style={{ borderTop: '1px solid var(--border)', marginTop: 8 }}>
              <div className="panel-title">贴标区域</div>
              <div className="props">
                <label>目标：{displayPartName(preview.nodeName)}</label>
                <label>环绕宽度：{Math.round(range.uWidth * 100)}%</label>
                <label>高度比例：{Math.round(range.vHeight * 100)}%</label>
                <label>环绕起点：{Math.round(range.uStart * 100)}%</label>
                <label>距底部：{Math.round(range.vStart * 100)}%</label>
                <div className="hint">蓝色选区是最终贴标范围；中央为模型正面，两侧为背部接缝</div>
              </div>
            </div>
          )}
        </aside>
        <div className="setup-center" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
          {loading ? (
            <div className="empty-hint">读取网格数据…</div>
          ) : preview ? (
            <div style={{ padding: 16 }}>
              <AreaPicker aspect={preview.aspect} value={range} onChange={setRange} />
            </div>
          ) : (
            <div className="empty-hint" style={{ maxWidth: 340, textAlign: 'center' }}>
              在左侧选择一个<b>目标表面</b>，然后在 2D 展开图上拖拽矩形定义贴标区域。已有区域会载入当前范围供继续编辑。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
