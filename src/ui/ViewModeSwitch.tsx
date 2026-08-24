import { useRef } from 'react'
import { useUiStore, type EditorViewMode } from '../state/stores'

const VIEW_MODES: ReadonlyArray<{ mode: EditorViewMode; label: string }> = [
  { mode: '2d', label: '2D 设计' },
  { mode: 'split', label: '2D + 3D' },
  { mode: '3d', label: '3D 预览' },
]

export function nextEditorViewMode(current: EditorViewMode, key: string): EditorViewMode | null {
  if (key === 'Home') return VIEW_MODES[0].mode
  if (key === 'End') return VIEW_MODES[VIEW_MODES.length - 1].mode
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const currentIndex = VIEW_MODES.findIndex((item) => item.mode === current)
  const offset = key === 'ArrowRight' ? 1 : -1
  return VIEW_MODES[(currentIndex + offset + VIEW_MODES.length) % VIEW_MODES.length].mode
}

export function ViewModeSwitch(): React.JSX.Element {
  const editorViewMode = useUiStore((state) => state.editorViewMode)
  const setEditorViewMode = useUiStore((state) => state.setEditorViewMode)
  const buttonRefs = useRef<Record<EditorViewMode, HTMLButtonElement | null>>({
    '2d': null,
    split: null,
    '3d': null,
  })

  const handleKeyDown = (current: EditorViewMode, event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const next = nextEditorViewMode(current, event.key)
    if (!next) return
    event.preventDefault()
    setEditorViewMode(next)
    buttonRefs.current[next]?.focus()
  }

  return (
    <div className="view-mode-switch" role="group" aria-label="中央视图" data-editor-control>
      {VIEW_MODES.map(({ mode, label }) => {
        const selected = editorViewMode === mode
        return (
          <button
            key={mode}
            ref={(button) => { buttonRefs.current[mode] = button }}
            className={`view-mode-switch__button ${selected ? 'active' : ''}`}
            type="button"
            aria-pressed={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setEditorViewMode(mode)}
            onKeyDown={(event) => handleKeyDown(mode, event)}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
