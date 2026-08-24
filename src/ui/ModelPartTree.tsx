import { useMemo, useState } from 'react'
import type { LabelAreaConfig, PartNode } from '../label/types'
import { useLabelStore, useModelStore, useUiStore } from '../state/stores'
import { Icon } from './icons'
import { displayPartName } from '../glb/analyze'

function filterPartTree(nodes: PartNode[], query: string): PartNode[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return nodes
  return nodes
    .map((node) => {
      const children = filterPartTree(node.children, normalized)
      return node.name.toLocaleLowerCase().includes(normalized) || children.length > 0 ? { ...node, children } : null
    })
    .filter((node): node is PartNode => node !== null)
}

interface ModelHierarchyProps {
  nodes: PartNode[]
  selectedPartId: string | null
  hiddenIds: Set<string>
  areas: LabelAreaConfig[]
  onActivate: (node: PartNode) => void
  onToggleVisible: (id: string) => void
}

export function ModelHierarchy({ nodes, selectedPartId, hiddenIds, areas, onActivate, onToggleVisible }: ModelHierarchyProps): React.JSX.Element {
  const renderNode = (node: PartNode): React.JSX.Element => {
    const area = node.meshIndex === undefined ? undefined : areas.find((candidate) => candidate.meshIndex === node.meshIndex)
    const selected = node.id === selectedPartId
    const shownName = displayPartName(node.name)
    return (
      <li key={node.id} className="model-tree-item">
        <div className={`tree-row model-tree-row ${selected ? 'selected' : ''}`}>
          <button
            className="icon-btn"
            type="button"
            onClick={() => onToggleVisible(node.id)}
            aria-label={hiddenIds.has(node.id) ? `显示 ${shownName}` : `隐藏 ${shownName}`}
            title={hiddenIds.has(node.id) ? '显示' : '隐藏'}
          >
            {Icon.eye(13, !hiddenIds.has(node.id))}
          </button>
          <button
            className="model-select-button"
            type="button"
            aria-pressed={selected}
            onClick={() => onActivate(node)}
            title={node.material ? `材质：${node.material}` : undefined}
          >
            <span className="tree-icon" aria-hidden="true">
              {node.children.length > 0 ? Icon.group(13) : Icon.cube(13)}
            </span>
            <span className="tree-name">{shownName}</span>
            {area && <span className="tree-badge">贴标</span>}
            {node.triangleCount !== undefined && <span className="tree-meta">{node.triangleCount.toLocaleString()}▲</span>}
          </button>
        </div>
        {node.children.length > 0 && <ul className="model-tree-children">{node.children.map(renderNode)}</ul>}
      </li>
    )
  }

  return <ul className="tree model-tree" aria-label="模型部件">{nodes.map(renderNode)}</ul>
}

export function ModelPartTree(): React.JSX.Element {
  const status = useModelStore((state) => state.status)
  const error = useModelStore((state) => state.error)
  const parts = useModelStore((state) => state.parts)
  const selectedPartId = useModelStore((state) => state.selectedPartId)
  const hiddenIds = useModelStore((state) => state.hiddenIds)
  const selectPart = useModelStore((state) => state.selectPart)
  const toggleVisible = useModelStore((state) => state.toggleVisible)
  const areas = useLabelStore((state) => state.areas)
  const activateArea = useLabelStore((state) => state.activateArea)
  const setMode = useUiStore((state) => state.setMode)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => filterPartTree(parts, query), [parts, query])

  const activateNode = (node: PartNode): void => {
    selectPart(node.id)
    if (node.meshIndex === undefined) return
    const area = areas.find((candidate) => candidate.meshIndex === node.meshIndex)
    if (area) {
      activateArea(area.id)
      setMode('design')
    } else {
      setMode('browse')
    }
  }

  return (
    <section className="model-workspace" aria-label="模型层级">
      <div className="sidebar-section-head">
        <span>模型层级</span>
        {parts.length > 0 && <span className="sidebar-count">{parts.length}</span>}
      </div>
      <label className="sidebar-search-label">
        <span className="sr-only">搜索模型部件</span>
        <input className="input sidebar-search" placeholder="搜索部件" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {status === 'loading' ? (
        <div className="empty-hint">正在读取模型层级…</div>
      ) : status === 'error' ? (
        <div className="sidebar-error" role="alert">
          <span>模型读取失败</span>
          <small>{error ?? '请重新打开 GLB 文件'}</small>
        </div>
      ) : parts.length === 0 ? (
        <div className="empty-hint">打开一个 GLB 或加载示例模型后，可在这里查看部件层级。</div>
      ) : filtered.length === 0 ? (
        <div className="empty-hint">
          <span>没有匹配的模型部件。</span>
          <button className="btn ghost sm" onClick={() => setQuery('')}>清除搜索</button>
        </div>
      ) : (
        <ModelHierarchy
          nodes={filtered}
          selectedPartId={selectedPartId}
          hiddenIds={hiddenIds}
          areas={areas}
          onActivate={activateNode}
          onToggleVisible={toggleVisible}
        />
      )}
    </section>
  )
}
