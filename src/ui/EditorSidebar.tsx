import { useRef } from 'react'
import { useUiStore } from '../state/stores'
import { Icon } from './icons'
import { LabelWorkspace } from './LabelWorkspace'
import { ModelPartTree } from './ModelPartTree'

type WorkspaceTab = 'labels' | 'model'

export function nextWorkspaceTab(current: WorkspaceTab, key: string): WorkspaceTab | null {
  if (key === 'Home') return 'labels'
  if (key === 'End') return 'model'
  if (key === 'ArrowLeft' || key === 'ArrowRight') return current === 'labels' ? 'model' : 'labels'
  return null
}

export function EditorSidebar(): React.JSX.Element {
  const workspaceTab = useUiStore((state) => state.workspaceTab)
  const setWorkspaceTab = useUiStore((state) => state.setWorkspaceTab)
  const labelsTabRef = useRef<HTMLButtonElement>(null)
  const modelTabRef = useRef<HTMLButtonElement>(null)

  const handleTabKey = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const next = nextWorkspaceTab(workspaceTab, event.key)
    if (!next) return
    event.preventDefault()
    setWorkspaceTab(next)
    const nextButton = next === 'labels' ? labelsTabRef.current : modelTabRef.current
    nextButton?.focus()
  }

  return (
    <div className="editor-sidebar">
      <div className="workspace-tabs" role="tablist" aria-label="左侧工作区">
        <button
          ref={labelsTabRef}
          id="workspace-tab-labels"
          className={`workspace-tab ${workspaceTab === 'labels' ? 'active' : ''}`}
          type="button"
          role="tab"
          aria-selected={workspaceTab === 'labels'}
          aria-controls="workspace-panel-labels"
          tabIndex={workspaceTab === 'labels' ? 0 : -1}
          onClick={() => setWorkspaceTab('labels')}
          onKeyDown={handleTabKey}
        >
          {Icon.label(14)}
          贴标
        </button>
        <button
          ref={modelTabRef}
          id="workspace-tab-model"
          className={`workspace-tab ${workspaceTab === 'model' ? 'active' : ''}`}
          type="button"
          role="tab"
          aria-selected={workspaceTab === 'model'}
          aria-controls="workspace-panel-model"
          tabIndex={workspaceTab === 'model' ? 0 : -1}
          onClick={() => setWorkspaceTab('model')}
          onKeyDown={handleTabKey}
        >
          {Icon.cube(14)}
          模型
        </button>
      </div>
      <div id="workspace-panel-labels" className="workspace-panel" role="tabpanel" aria-labelledby="workspace-tab-labels" hidden={workspaceTab !== 'labels'}>
        <LabelWorkspace />
      </div>
      <div id="workspace-panel-model" className="workspace-panel" role="tabpanel" aria-labelledby="workspace-tab-model" hidden={workspaceTab !== 'model'}>
        <ModelPartTree />
      </div>
    </div>
  )
}
