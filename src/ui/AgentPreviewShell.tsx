import { useRef, type ReactNode } from 'react'
import { restoreImportedAreaRuntime } from '../app/projectImportRuntime'
import type { LabelAreaConfig } from '../label/types'
import type { MeshAccessors, RemapOutput } from '../glb/uvRemap'
import { useLabelStore, useModelStore, useUiStore, type EditorViewMode } from '../state/stores'
import { ViewModeSwitch } from './ViewModeSwitch'

function shortRevision(revision: string): string {
  return revision.replace(/^sha256:/, '').slice(0, 12)
}

export function AgentPreviewShell({
  editorViewMode,
  workspace,
}: {
  editorViewMode: EditorViewMode
  workspace: ReactNode
}): React.JSX.Element {
  const modelName = useModelStore((state) => state.modelName)
  const areas = useLabelStore((state) => state.areas)
  const activeArea = useLabelStore((state) => state.activeArea)
  const activeAreaId = useLabelStore((state) => state.activeAreaId)
  const glbBytes = useModelStore((state) => state.glbBytes)
  const status = useUiStore((state) => state.agentPreviewStatus)
  const selectionVersion = useRef(0)
  const runtimeCache = useRef(new WeakMap<LabelAreaConfig, { meshAccessors: MeshAccessors; remapOutput: RemapOutput }>())

  const selectArea = async (area: LabelAreaConfig): Promise<void> => {
    if (area.id === useLabelStore.getState().activeAreaId) return
    const version = ++selectionVersion.current
    if (!glbBytes) {
      useLabelStore.getState().setAreaData(null, null)
      useLabelStore.getState().activateArea(area.id)
      return
    }
    try {
      let runtime = runtimeCache.current.get(area)
      if (!runtime) {
        runtime = await restoreImportedAreaRuntime(glbBytes, area)
        runtimeCache.current.set(area, runtime)
      }
      if (version !== selectionVersion.current) return
      useLabelStore.getState().activateAreaWithRuntime(area.id, runtime)
    } catch (error) {
      if (version !== selectionVersion.current || !status?.revision) return
      useUiStore.getState().setAgentPreviewStatus({
        revision: status.revision,
        state: 'error',
        message: `区域预览切换失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return (
    <div className="agent-preview-shell" data-agent-preview="readonly">
      <header className="agent-preview-toolbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◆</span>
          <span>GLB Label Editor</span>
          {modelName && <span className="model-name">{modelName}</span>}
        </div>
        <div className={`agent-preview-status ${status?.state === 'error' ? 'error' : 'ready'}`} role="status" aria-live="polite">
          <strong>Agent 实时预览 · 只读</strong>
          {status?.revision && <code title={status.revision}>{shortRevision(status.revision)}</code>}
          {status?.message && <span className="agent-preview-status__message">{status.message}</span>}
        </div>
        <ViewModeSwitch />
      </header>
      <div className="main agent-preview-main" data-view-mode={editorViewMode}>
        <aside className="left agent-preview-areas" aria-label="预览区域">
          <div className="agent-preview-panel-heading">
            <strong>贴标区域</strong>
            <span>{areas.length}</span>
          </div>
          <div className="agent-preview-area-list">
            {areas.map((area) => (
              <button
                key={area.id}
                type="button"
                className={area.id === activeAreaId ? 'active' : ''}
                aria-pressed={area.id === activeAreaId}
                onClick={() => { void selectArea(area) }}
              >
                <span>{area.name}</span>
                <small>{area.layers.length} 个图层</small>
              </button>
            ))}
          </div>
        </aside>
        <section className="center" aria-label="实时预览工作区">{workspace}</section>
        <aside className="right agent-preview-inspector" aria-label="只读检查器">
          <div className="agent-preview-inspector-scroll">
            <div className="agent-preview-panel-heading"><strong>设计检查</strong><span>只读</span></div>
            {activeArea ? (
              <>
                <dl className="agent-preview-summary">
                  <div><dt>区域</dt><dd>{activeArea.name}</dd></div>
                  <div><dt>目标</dt><dd>{activeArea.nodeName || `Mesh ${activeArea.meshIndex}`}</dd></div>
                  <div><dt>贴合</dt><dd>{activeArea.surfaceMode === 'replace' ? '替换材质' : '表面覆盖'}</dd></div>
                  <div><dt>环绕</dt><dd>{Math.round(activeArea.range.uWidth * 100)}%</dd></div>
                  <div><dt>高度</dt><dd>{Math.round(activeArea.range.vHeight * 100)}%</dd></div>
                </dl>
                <div className="agent-preview-layer-summary">
                  <strong>图层</strong>
                  <ol>
                    {activeArea.layers.map((layer) => (
                      <li key={layer.id}>
                        <span>{layer.kind === 'text' ? layer.text || '空文字' : layer.kind === 'image' ? '图片' : layer.shape}</span>
                        <code>{layer.id}</code>
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            ) : <p className="empty-hint">等待 Agent 应用有效设计…</p>}
          </div>
        </aside>
      </div>
    </div>
  )
}
