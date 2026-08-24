import { useId, useRef, useState, type ReactNode } from 'react'
import {
  clampSplitPercent,
  INITIAL_SPLIT_PERCENT,
  MAX_SPLIT_PERCENT,
  MIN_SPLIT_PERCENT,
  resizeSplitPercent,
  splitPercentFromPointer,
} from '../app/canvasLayout'

export function ResizableSplitPane({ primary, secondary, initialPercent = INITIAL_SPLIT_PERCENT }: {
  primary: ReactNode
  secondary: ReactNode
  initialPercent?: number
}): React.JSX.Element {
  const [primaryPercent, setPrimaryPercent] = useState(() => clampSplitPercent(initialPercent))
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingPointerId = useRef<number | null>(null)
  const id = useId().replace(/:/g, '')
  const primaryId = `split-primary-${id}`
  const secondaryId = `split-secondary-${id}`

  const updateFromPointer = (clientX: number): void => {
    const bounds = containerRef.current?.getBoundingClientRect()
    if (!bounds) return
    setPrimaryPercent(splitPercentFromPointer({ clientX, containerLeft: bounds.left, containerWidth: bounds.width }))
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    draggingPointerId.current = event.pointerId
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    updateFromPointer(event.clientX)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (draggingPointerId.current !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    updateFromPointer(event.clientX)
  }

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (draggingPointerId.current !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    draggingPointerId.current = null
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = resizeSplitPercent(primaryPercent, event.key)
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    setPrimaryPercent(next)
  }

  return (
    <div
      ref={containerRef}
      className="split-workspace"
      style={{ gridTemplateColumns: `minmax(0, ${primaryPercent}fr) 8px minmax(0, ${100 - primaryPercent}fr)` }}
    >
      <section id={primaryId} className="split-workspace__pane split-workspace__pane--2d" aria-label="2D 设计工作区">
        {primary}
      </section>
      <div
        className="split-workspace__divider"
        role="separator"
        aria-label="调整 2D 与 3D 面板宽度"
        aria-orientation="vertical"
        aria-controls={`${primaryId} ${secondaryId}`}
        aria-valuemin={MIN_SPLIT_PERCENT}
        aria-valuemax={MAX_SPLIT_PERCENT}
        aria-valuenow={primaryPercent}
        aria-valuetext={`2D 设计占 ${primaryPercent}%`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onLostPointerCapture={(event) => {
          if (draggingPointerId.current === event.pointerId) draggingPointerId.current = null
          event.stopPropagation()
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="split-workspace__divider-grip" aria-hidden="true" />
      </div>
      <section id={secondaryId} className="split-workspace__pane split-workspace__pane--3d" aria-label="3D 辅助预览">
        {secondary}
      </section>
    </div>
  )
}
