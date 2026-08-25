/**
 * 应用骨架：三栏编辑器、中央 2D/3D 视图、toast、快捷键。
 */

import { useEffect, useRef, useState } from 'react'
import { Toolbar } from '../ui/Toolbar'
import { Inspector } from '../ui/Inspector'
import { EditorSidebar } from '../ui/EditorSidebar'
import { ResizableSplitPane } from '../ui/ResizableSplitPane'
import { LabelCanvas } from '../label/LabelCanvas'
import { Viewport } from '../scene/Viewport'
import { useLabelStore, useUiStore, type EditorViewMode } from '../state/stores'
import { installShortcuts } from './actions'
import { AreaSetupView } from './AreaSetupView'
import { fitCanvasDisplayWidth } from './canvasLayout'
import './styles.css'
import { bootstrapAgentBridgeFromPage } from '../agent/bridge'
import { createBrowserAgentBridge } from '../agent/browserBridgeRuntime'
import { isAgentPreviewUrl } from '../agent/previewMode'
import { AgentPreviewShell } from '../ui/AgentPreviewShell'

export function EditorWorkspace({ editorViewMode }: { editorViewMode: EditorViewMode }): React.JSX.Element {
  return (
    <>
      <Toolbar />
      <div className="main">
        <aside className="left">
          <EditorSidebar />
        </aside>
        <section className="center" aria-label="中央编辑工作区">
          <CentralWorkspace editorViewMode={editorViewMode} />
        </section>
        <aside className="right" aria-label="属性检查器">
          <div className="right-stack">
            <Inspector />
          </div>
        </aside>
      </div>
    </>
  )
}

export function CentralWorkspace({ editorViewMode, readOnly = false }: { editorViewMode: EditorViewMode; readOnly?: boolean }): React.JSX.Element {
  if (editorViewMode === '2d') {
    return <div className="canvas-area editor-canvas"><CanvasHost readOnly={readOnly} /></div>
  }
  if (editorViewMode === 'split') {
    return (
      <ResizableSplitPane
        primary={<div className="canvas-area editor-canvas"><CanvasHost readOnly={readOnly} /></div>}
        secondary={<div className="viewport-wrap editor-viewport editor-viewport--support"><Viewport showFrontMarker readOnly={readOnly} /></div>}
      />
    )
  }
  return <div className="viewport-wrap editor-viewport editor-viewport--formal"><Viewport readOnly={readOnly} /></div>
}

export function App(): React.JSX.Element {
  const toast = useUiStore((s) => s.toast)
  const editorViewMode = useUiStore((s) => s.editorViewMode)
  const view = useUiStore((s) => s.view)
  const agentPreview = typeof window !== 'undefined' && isAgentPreviewUrl(window.location.href)

  useEffect(() => agentPreview ? undefined : installShortcuts(), [agentPreview])
  useEffect(() => {
    let dispose = (): void => undefined
    let cancelled = false
    void bootstrapAgentBridgeFromPage({
      createBridge: (bootstrap) => createBrowserAgentBridge(bootstrap),
    }).then((nextDispose) => {
      if (cancelled) nextDispose()
      else dispose = nextDispose
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [])

  return (
    <div className="app">
      {agentPreview ? (
        <AgentPreviewShell
          editorViewMode={editorViewMode}
          workspace={<CentralWorkspace editorViewMode={editorViewMode} readOnly />}
        />
      ) : view === 'areaSetup' ? (
        <AreaSetupView />
      ) : (
        <>
          <EditorWorkspace editorViewMode={editorViewMode} />
          {toast && (
            <div className={`toast ${toast.kind}`} onClick={() => useUiStore.getState().clearToast()}>
              {toast.msg}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 设计模式中央画布：宽度自适应容器。 */
function CanvasHost({ readOnly = false }: { readOnly?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const aspect = useLabelStore((s) => s.activeArea?.canvas.aspect ?? 1)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => setSize({ width: el.clientWidth, height: el.clientHeight })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [])
  const displayWidth = fitCanvasDisplayWidth({ containerWidth: size.width, containerHeight: size.height, aspect, maxWidth: 900, padding: 24 })
  return (
    <div ref={ref} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      {size.width > 0 && size.height > 0 ? <LabelCanvas displayWidth={displayWidth} readOnly={readOnly} /> : null}
    </div>
  )
}
