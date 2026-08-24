/**
 * 顶栏：打开/示例/项目/撤销重做/导出/视图切换。
 */

import { useRef, useState } from 'react'
import { useModelStore, useLabelStore, useUiStore, flashToast } from '../state/stores'
import { loadSample, loadModelFromBytes } from '../app/modelLoader'
import { exportPng, exportGlbFile, exportProject, importProject } from '../app/actions'
import { Icon } from './icons'
import { ViewModeSwitch } from './ViewModeSwitch'

export function Toolbar(): React.JSX.Element {
  const glbInputRef = useRef<HTMLInputElement>(null)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const status = useModelStore((s) => s.status)
  const modelName = useModelStore((s) => s.modelName)
  const activeArea = useLabelStore((s) => s.activeArea)
  const canUndo = activeArea !== null && activeArea.undoStack.length > 0
  const canRedo = activeArea !== null && activeArea.redoStack.length > 0
  const hasBake = useLabelStore((s) => (s.activeAreaId ? s.bakeMap[s.activeAreaId] !== undefined : false))
  const channelView = useUiStore((s) => s.channelView)
  const setChannelView = useUiStore((s) => s.setChannelView)
  const undo = useLabelStore((s) => s.undo)
  const redo = useLabelStore((s) => s.redo)
  const labelActive = useLabelStore((s) => s.activeAreaId !== null)
  const [exporting, setExporting] = useState<'png' | 'glb' | null>(null)
  const runExport = async (kind: 'png' | 'glb'): Promise<void> => {
    if (exporting) return
    setExporting(kind)
    try {
      if (kind === 'png') await exportPng()
      else await exportGlbFile()
    } finally {
      setExporting(null)
    }
  }
  const activatePicker = (event: React.KeyboardEvent<HTMLButtonElement>, input: React.RefObject<HTMLInputElement | null>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    input.current?.click()
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!/\.glb$/i.test(file.name)) {
      flashToast('v1 仅支持 .glb 文件', 'error')
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const r = await loadModelFromBytes(file.name, bytes)
    if (!r.labelActivated) flashToast('未找到标签部件，可在左栏手动选择', 'info')
    e.target.value = ''
  }

  const onProjectImport = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await importProject(file)
    } catch (err) {
      flashToast(err instanceof Error ? err.message : '导入失败', 'error')
    }
    e.target.value = ''
  }

  return (
    <div className="toolbar">
      <div className="brand">
        <span className="brand-mark">{Icon.label(16)}</span>
        <span>GLB 贴标编辑器</span>
        {modelName && <span className="model-name">{modelName}</span>}
      </div>
      <div className="toolbar-group">
        <button
          className="btn primary sm"
          title="设置贴标区域（选择目标表面 → 2D 展开图框选 → 完成）"
          onClick={() => {
            useUiStore.getState().setWorkspaceTab('model')
            useUiStore.getState().setView('areaSetup')
            useUiStore.getState().setMode('browse')
          }}
        >
          + 贴标区域
        </button>
        <button
          className="btn secondary sm"
          type="button"
          onClick={() => glbInputRef.current?.click()}
          onKeyDown={(event) => activatePicker(event, glbInputRef)}
        >
          打开 GLB
        </button>
        <input ref={glbInputRef} type="file" accept=".glb" hidden tabIndex={-1} aria-hidden="true" onChange={(e) => void onFile(e)} />
        <button className="btn secondary sm" onClick={() => void loadSample()}>
          加载示例
        </button>
        <button className="btn ghost sm" onClick={exportProject} disabled={!labelActive} title="导出 .lbl 项目（设计数据）">
          项目↓
        </button>
        <button
          className="btn ghost sm"
          type="button"
          title="导入 .lbl 项目"
          onClick={() => projectInputRef.current?.click()}
          onKeyDown={(event) => activatePicker(event, projectInputRef)}
        >
          项目↑
        </button>
        <input ref={projectInputRef} type="file" accept=".json,.lbl" hidden tabIndex={-1} aria-hidden="true" onChange={(e) => void onProjectImport(e)} />
      </div>
      <div className="toolbar-group">
        <button className="btn ghost sm" onClick={undo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
          ⟲ 撤销
        </button>
        <button className="btn ghost sm" onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Shift+Z)">
          ⟳ 重做
        </button>
      </div>
      <div className="toolbar-view-modes">
        <ViewModeSwitch />
      </div>
      <div className="toolbar-group">
        {labelActive && (
          <select className="input sm" value={channelView ?? 'color'} onChange={(e) => setChannelView(e.target.value === 'color' ? null : (e.target.value as never))} title="通道视图">
            <option value="color">Color 通道</option>
            <option value="metalness">Metalness 通道</option>
            <option value="roughness">Roughness 通道</option>
            <option value="bump">Bump 通道</option>
          </select>
        )}
        <button className="btn secondary sm" onClick={() => void runExport('png')} disabled={!hasBake || exporting !== null} aria-busy={exporting === 'png'}>
          {exporting === 'png' ? '导出中…' : '导出纹理 PNG'}
        </button>
        <button className="btn primary sm" onClick={() => void runExport('glb')} disabled={!hasBake || status !== 'ready' || exporting !== null} aria-busy={exporting === 'glb'}>
          {exporting === 'glb' ? '导出中…' : '导出 GLB'}
        </button>
      </div>
    </div>
  )
}
