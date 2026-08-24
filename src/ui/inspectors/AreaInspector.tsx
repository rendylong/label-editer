import type { CraftEffect, LabelAreaConfig } from '../../label/types'
import { resolveLabelPaper } from '../../label/paper'
import { useUiStore } from '../../state/stores'
import { CraftEditor } from '../CraftEditor'
import { InspectorSection } from '../InspectorSection'

export function AreaInspector({ area, patchArea }: { area: LabelAreaConfig; patchArea: (updater: (area: LabelAreaConfig) => LabelAreaConfig) => void }): React.JSX.Element {
  const paper = resolveLabelPaper(area.paper)
  const patchPaper = (patch: Partial<typeof paper>): void => patchArea((config) => ({ ...config, paper: { ...resolveLabelPaper(config.paper), ...patch } }))
  const patchCraft = (craft: CraftEffect[]): void => patchArea((config) => ({ ...config, globalCraft: { craft } }))
  return <div className="inspector-body">
    <InspectorSection objectType="area" sectionId="content" title="区域">
      <div className="props">
        <label>名称<input type="text" value={area.name} onChange={(event) => patchArea((config) => ({ ...config, name: event.target.value }))} /></label>
        <div className="hint">重建 UV 后原始纹理不能直接作为参考；3D 预览始终显示当前贴标设计。</div>
        <div className="area-target-meta"><span>目标网格</span><b>{area.nodeName}</b><span>{area.surfaceMode === 'replace' ? '替换原标签外观' : '透明叠加贴标层'}</span></div>
      </div>
    </InspectorSection>
    <InspectorSection objectType="area" sectionId="paper" title="标签纸张">
      <div className="props">
        <label className="inline-toggle"><span>启用实体底色</span><input type="checkbox" checked={paper.enabled} onChange={(event) => patchPaper({ enabled: event.target.checked })} /></label>
        {paper.enabled && <div className="row2"><label>纸张颜色<input type="color" value={paper.color} onChange={(event) => patchPaper({ color: event.target.value })} /></label><label>不透明度 {Math.round(paper.opacity * 100)}%<input type="range" min={0} max={1} step={0.05} value={paper.opacity} onChange={(event) => patchPaper({ opacity: +event.target.value })} /></label></div>}
        <div className="hint">默认透明；仅在设计实体纸质贴纸时主动启用。</div>
      </div>
    </InspectorSection>
    <InspectorSection objectType="area" sectionId="geometry" title="贴标区域大小"><AreaRangeEditor area={area} /></InspectorSection>
    <InspectorSection objectType="area" sectionId="craft" title="全局工艺"><CraftEditor craft={area.globalCraft.craft} onChange={patchCraft} scope="global" /><div className="hint inspector-craft-note">作用于整个标签面。</div></InspectorSection>
  </div>
}

export function AreaRangeEditor({ area }: { area: LabelAreaConfig }): React.JSX.Element {
  const range = area.range
  return <div className="props">
    <div className="area-range-summary"><span>环绕 {Math.round(range.uWidth * 100)}%</span><span>高度 {Math.round(range.vHeight * 100)}%</span><span>距底部 {Math.round(range.vStart * 100)}%</span></div>
    <button className="btn secondary" type="button" onClick={() => { useUiStore.getState().setWorkspaceTab('model'); useUiStore.getState().setView('areaSetup'); useUiStore.getState().setMode('browse') }}>在 2D 展开图中编辑</button>
    <div className="hint">画布 {area.canvas.width}×{area.canvas.height}px（宽高比 {area.canvas.aspect.toFixed(2)}:1），由瓶身几何与区域尺寸推导。</div>
  </div>
}
