import type { LabelAreaConfig } from '../../label/types'
import { alignLayers, distributeLayers, type AreaMutationGateway, type DistributionAxis, type LayerAlignment } from '../../label/selection'

export type MultiSelectionAction =
  | { type: 'align'; value: LayerAlignment }
  | { type: 'distribute'; value: DistributionAxis }
  | { type: 'opacity'; value: number }
  | { type: 'locked'; value: boolean }
  | { type: 'delete' }

export function canDistributeSelection(selectedCount: number): boolean {
  return selectedCount >= 3
}

export function runMultiSelectionAction(
  areaId: string,
  selectedIds: string[],
  action: MultiSelectionAction,
  applyAreaOp: AreaMutationGateway,
): void {
  const selected = new Set(selectedIds)
  applyAreaOp(areaId, (area) => {
    if (action.type === 'align') {
      const layers = alignLayers(area.layers, selectedIds, action.value)
      return layers === area.layers ? area : { ...area, layers }
    }
    if (action.type === 'distribute') {
      const layers = distributeLayers(area.layers, selectedIds, action.value)
      return layers === area.layers ? area : { ...area, layers }
    }
    if (action.type === 'delete') {
      const layers = area.layers.filter((layer) => !selected.has(layer.id) || layer.locked)
      return layers.length === area.layers.length ? area : { ...area, layers }
    }
    if (action.type === 'locked') {
      let changed = false
      const layers = area.layers.map((layer) => {
        if (!selected.has(layer.id) || layer.locked === action.value) return layer
        changed = true
        return { ...layer, locked: action.value }
      })
      return changed ? { ...area, layers } : area
    }
    const opacity = Math.max(0, Math.min(1, action.value))
    let changed = false
    const layers = area.layers.map((layer) => {
      if (!selected.has(layer.id) || layer.locked || layer.opacity === opacity) return layer
      changed = true
      return { ...layer, opacity }
    })
    return changed ? { ...area, layers } : area
  })
}

export function MultiSelectionInspector({ area, selectedIds, applyAreaOp }: {
  area: LabelAreaConfig
  selectedIds: string[]
  applyAreaOp: AreaMutationGateway
}): React.JSX.Element {
  const selected = area.layers.filter((layer) => selectedIds.includes(layer.id))
  const mutable = selected.filter((layer) => !layer.locked)
  const commonOpacity = mutable.length > 0 && mutable.every((layer) => layer.opacity === mutable[0].opacity)
    ? mutable[0].opacity
    : null
  const allLocked = selected.length > 0 && selected.every((layer) => layer.locked)
  const run = (action: MultiSelectionAction): void => runMultiSelectionAction(area.id, selectedIds, action, applyAreaOp)
  return (
    <div className="inspector-body multi-selection-inspector">
      <div className="inspector-selection-summary">已选择 {selected.length} 个对象{mutable.length !== selected.length ? ` · ${selected.length - mutable.length} 个已锁定` : ''}</div>
      <div className="inspector-section-region props">
        <div className="inspector-control-label">水平对齐</div>
        <div className="segmented inspector-action-grid">
          {(['left', 'center', 'right'] as const).map((value) => <button key={value} type="button" disabled={mutable.length < 2} onClick={() => run({ type: 'align', value })}>{value === 'left' ? '左' : value === 'center' ? '中' : '右'}</button>)}
        </div>
        <div className="inspector-control-label">垂直对齐</div>
        <div className="segmented inspector-action-grid">
          {(['top', 'middle', 'bottom'] as const).map((value) => <button key={value} type="button" disabled={mutable.length < 2} onClick={() => run({ type: 'align', value })}>{value === 'top' ? '上' : value === 'middle' ? '中' : '下'}</button>)}
        </div>
        <div className="row2">
          <button className="btn secondary" type="button" disabled={!canDistributeSelection(mutable.length)} onClick={() => run({ type: 'distribute', value: 'horizontal' })}>水平分布</button>
          <button className="btn secondary" type="button" disabled={!canDistributeSelection(mutable.length)} onClick={() => run({ type: 'distribute', value: 'vertical' })}>垂直分布</button>
        </div>
        <label>共同不透明度 {commonOpacity === null ? '混合' : `${Math.round(commonOpacity * 100)}%`}
          <input type="range" min={0} max={1} step={0.05} value={commonOpacity ?? 1} disabled={mutable.length === 0} onChange={(event) => run({ type: 'opacity', value: +event.target.value })} />
        </label>
        <div className="row2">
          <button className="btn secondary" type="button" onClick={() => run({ type: 'locked', value: !allLocked })}>{allLocked ? '全部解锁' : '全部锁定'}</button>
          <button className="btn danger" type="button" disabled={mutable.length === 0} onClick={() => run({ type: 'delete' })}>删除可编辑对象</button>
        </div>
      </div>
    </div>
  )
}
