import { useState } from 'react'
import { findPart } from '../glb/analyze'
import { patchUnlockedLayer } from '../label/layerMutations'
import type { LabelAreaConfig, LabelLayer, ShapeKind } from '../label/types'
import { addAreaForNode } from '../app/modelLoader'
import { flashToast, useLabelStore, useModelStore, type ModelStatus } from '../state/stores'
import { deleteSelectedLayers, duplicateSelectedLayers } from './sidebarActions'
import { Icon } from './icons'
import { AreaInspector } from './inspectors/AreaInspector'
import { ImageInspector } from './inspectors/ImageInspector'
import { MultiSelectionInspector } from './inspectors/MultiSelectionInspector'
import { ShapeInspector } from './inspectors/ShapeInspector'
import { commitFreshUploadedFont, TextInspector } from './inspectors/TextInspector'

export interface InspectorMeshSummary {
  id: string
  name: string
  meshIndex: number
  material?: string
  triangleCount?: number
}

export type InspectorRoute =
  | { kind: 'model'; meshId: string }
  | { kind: 'multi' }
  | { kind: LabelLayer['kind']; layerId: string }
  | { kind: 'area' }
  | { kind: 'empty' }

export function resolveInspectorRoute({ selectedMesh, selectedMeshHasArea, selectedLayers, activeArea }: {
  selectedMesh: InspectorMeshSummary | null
  selectedMeshHasArea: boolean
  selectedLayers: LabelLayer[]
  activeArea: LabelAreaConfig | null
  modelStatus: ModelStatus
}): InspectorRoute {
  if (selectedMesh && !selectedMeshHasArea) return { kind: 'model', meshId: selectedMesh.id }
  if (selectedLayers.length > 1) return { kind: 'multi' }
  if (selectedLayers.length === 1) return { kind: selectedLayers[0].kind, layerId: selectedLayers[0].id }
  if (activeArea) return { kind: 'area' }
  return { kind: 'empty' }
}

export function InspectorHeader({ title, subtitle, visible, locked, onToggleVisible, onToggleLocked, onDuplicate, onDelete }: {
  title: string
  subtitle?: string
  visible: boolean
  locked: boolean
  onToggleVisible: () => void
  onToggleLocked: () => void
  onDuplicate?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  return <header className="inspector-header">
    <div className="inspector-heading"><span className="inspector-eyebrow">检查器</span><strong title={title}>{title}</strong>{subtitle && <span>{subtitle}</span>}</div>
    <div className="inspector-header-actions">
      <button className="icon-btn" type="button" aria-label={visible ? '隐藏对象' : '显示对象'} title={visible ? '隐藏对象' : '显示对象'} onClick={onToggleVisible}>{Icon.eye(14, visible)}</button>
      <button className="icon-btn" type="button" aria-label={locked ? '解锁对象' : '锁定对象'} title={locked ? '解锁对象' : '锁定对象'} onClick={onToggleLocked}>{Icon.lock(14, locked)}</button>
      {!locked && onDuplicate && <button className="icon-btn" type="button" aria-label="复制对象" title="复制对象" onClick={onDuplicate}>{Icon.duplicate(14)}</button>}
      {!locked && onDelete && <button className="icon-btn danger-icon" type="button" aria-label="删除对象" title="删除对象" onClick={onDelete}>{Icon.trash(14)}</button>}
    </div>
  </header>
}

const SHAPE_NAMES: Record<ShapeKind, string> = {
  rectangle: '矩形', ellipse: '椭圆', triangle: '三角形', diamond: '菱形', polygon: '多边形', star: '星形', line: '线条',
  wave: '波浪线', burst: '放射形', cross: '十字', bracket: '括号', 'dot-grid': '点阵', frame: '边框',
}

function layerTitle(layer: LabelLayer): { title: string; subtitle: string } {
  if (layer.kind === 'text') return { title: layer.text.trim().split('\n')[0]?.slice(0, 24) || '空文字', subtitle: '文字图层' }
  if (layer.kind === 'image') return { title: '图片', subtitle: `${Math.round(layer.width)} × ${Math.round(layer.height)}px` }
  return { title: SHAPE_NAMES[layer.shape], subtitle: '形状图层' }
}

export function Inspector(): React.JSX.Element {
  const status = useModelStore((state) => state.status)
  const modelError = useModelStore((state) => state.error)
  const parts = useModelStore((state) => state.parts)
  const selectedPartId = useModelStore((state) => state.selectedPartId)
  const activeArea = useLabelStore((state) => state.activeArea)
  const areas = useLabelStore((state) => state.areas)
  const selectedLayerIds = useLabelStore((state) => state.selectedLayerIds)
  const applyAreaOp = useLabelStore((state) => state.applyAreaOp)
  const selectedNode = selectedPartId ? findPart(parts, selectedPartId) : null
  const selectedMesh: InspectorMeshSummary | null = selectedNode?.meshIndex === undefined ? null : {
    id: selectedNode.id, name: selectedNode.name, meshIndex: selectedNode.meshIndex,
    material: selectedNode.material, triangleCount: selectedNode.triangleCount,
  }
  const selectedMeshHasArea = selectedMesh ? areas.some((area) => area.meshIndex === selectedMesh.meshIndex) : false
  const selectedLayers = activeArea?.layers.filter((layer) => selectedLayerIds.includes(layer.id)) ?? []
  const route = resolveInspectorRoute({ selectedMesh, selectedMeshHasArea, selectedLayers, activeArea, modelStatus: status })

  if (route.kind === 'model' && selectedMesh) return <ModelInspector mesh={selectedMesh} />
  if (route.kind === 'multi' && activeArea) return <div className="inspector-shell"><StaticHeader title="多对象" subtitle={`${selectedLayers.length} 个图层`} /><MultiSelectionInspector area={activeArea} selectedIds={selectedLayerIds} applyAreaOp={applyAreaOp} /></div>

  if ((route.kind === 'text' || route.kind === 'image' || route.kind === 'shape') && activeArea) {
    const layer = selectedLayers[0]
    if (!layer) return <InspectorEmpty status={status} error={modelError} />
    const heading = layerTitle(layer)
    const patchState = (patch: Partial<Pick<LabelLayer, 'visible' | 'locked'>>): void => applyAreaOp(activeArea.id, (area) => ({ ...area, layers: area.layers.map((item) => item.id === layer.id ? ({ ...item, ...patch } as LabelLayer) : item) }))
    const patch = (value: Partial<LabelLayer>): void => {
      if (layer.locked) return
      applyAreaOp(activeArea.id, (area) => {
        const layers = patchUnlockedLayer(area.layers, layer.id, value)
        return layers === area.layers ? area : { ...area, layers }
      })
    }
    return <div className="inspector-shell">
      <InspectorHeader title={heading.title} subtitle={heading.subtitle} visible={layer.visible} locked={layer.locked} onToggleVisible={() => patchState({ visible: !layer.visible })} onToggleLocked={() => patchState({ locked: !layer.locked })} onDuplicate={() => { duplicateSelectedLayers() }} onDelete={() => { deleteSelectedLayers() }} />
      {layer.locked ? <LockedInspector layer={layer} onVisible={(visible) => patchState({ visible })} onUnlock={() => patchState({ locked: false })} />
        : layer.kind === 'text' ? <TextInspector
          area={activeArea}
          layer={layer}
          patch={patch}
          commitUploadedFont={(font) => commitFreshUploadedFont(activeArea.id, layer.id, font, applyAreaOp)}
        />
          : layer.kind === 'image' ? <ImageInspector layer={layer} patch={patch} />
            : <ShapeInspector layer={layer} patch={patch} />}
    </div>
  }

  if (route.kind === 'area' && activeArea) return <div className="inspector-shell"><StaticHeader title={activeArea.name} subtitle={`贴标区域 · ${activeArea.nodeName}`} /><AreaInspector area={activeArea} patchArea={(updater) => applyAreaOp(activeArea.id, updater)} /></div>
  return <InspectorEmpty status={status} error={modelError} />
}

function StaticHeader({ title, subtitle, eyebrow = '检查器' }: { title: string; subtitle?: string; eyebrow?: string }): React.JSX.Element {
  return <header className="inspector-header"><div className="inspector-heading"><span className="inspector-eyebrow">{eyebrow}</span><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div></header>
}

function LockedInspector({ layer, onVisible, onUnlock }: { layer: LabelLayer; onVisible: (visible: boolean) => void; onUnlock: () => void }): React.JSX.Element {
  return <div className="inspector-locked-state"><div className="inspector-lock-mark">{Icon.lock(22, true)}</div><strong>对象已锁定</strong><p>内容、外观、工艺和画布变换已停用。</p><label className="inline-toggle"><span>对象可见</span><input type="checkbox" checked={layer.visible} onChange={(event) => onVisible(event.target.checked)} /></label><button className="btn secondary" type="button" onClick={onUnlock}>解锁后编辑</button></div>
}

function ModelInspector({ mesh }: { mesh: InspectorMeshSummary }): React.JSX.Element {
  const [setting, setSetting] = useState(false)
  return <div className="inspector-shell"><StaticHeader title={mesh.name} subtitle="未创建贴标区域" eyebrow="模型部件" /><div className="model-inspector-summary">
    <dl><div><dt>网格索引</dt><dd>{mesh.meshIndex}</dd></div>{mesh.material && <div><dt>材质</dt><dd>{mesh.material}</dd></div>}{mesh.triangleCount !== undefined && <div><dt>三角形</dt><dd>{mesh.triangleCount.toLocaleString()}</dd></div>}</dl>
    <div className="model-inspector-cta"><strong>在这个部件上设计标签</strong><p>创建贴标区域后，可添加文字、图片和形状。</p><button className="btn primary" type="button" disabled={setting} onClick={async () => { setSetting(true); const result = await addAreaForNode(mesh.id); setSetting(false); if (!result.ok) flashToast(result.error ?? '设置失败', 'error'); else flashToast(`已创建贴标区域「${mesh.name}」`, 'success') }}>{setting ? '正在分析表面…' : '设为贴标区域'}</button></div>
  </div></div>
}

function InspectorEmpty({ status, error }: { status: ModelStatus; error: string | null }): React.JSX.Element {
  return <div className="inspector-shell inspector-empty"><StaticHeader title={status === 'loading' ? '正在读取模型' : status === 'error' ? '模型未能加载' : '选择设计对象'} /><div className="inspector-empty-content">
    <svg aria-hidden="true" focusable="false" width="40" height="40" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="m24 5 15 8v18l-15 8-15-8V13l15-8Z"/><path d="m9 13 15 8 15-8M24 21v18"/></svg>
    <strong>{status === 'idle' ? '先打开一个 GLB 模型' : status === 'error' ? error ?? '请重新选择模型文件' : '从左侧选择网格或标签对象'}</strong><p>{status === 'ready' ? '网格可创建贴标区域；标签对象会显示对应的内容、外观与变换控制。' : '模型载入后，检查器会根据当前选择自动切换。'}</p>
  </div></div>
}
