import type { ReactNode } from 'react'
import { useUiStore } from '../state/stores'

const OPEN_BY_DEFAULT = new Set(['content', 'typography', 'geometry', 'transform'])

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function InspectorSection({
  objectType,
  sectionId,
  title,
  children,
}: {
  objectType: string
  sectionId: string
  title: string
  children?: ReactNode
}): React.JSX.Element {
  const storedOpen = useUiStore((state) => state.inspectorSections[objectType]?.[sectionId])
  const setOpen = useUiStore((state) => state.setInspectorSectionOpen)
  const open = storedOpen ?? OPEN_BY_DEFAULT.has(sectionId)
  const baseId = `inspector-${safeId(objectType)}-${safeId(sectionId)}`
  const buttonId = `${baseId}-button`
  const regionId = `${baseId}-region`

  return (
    <section className="inspector-section">
      <button
        id={buttonId}
        className="inspector-section-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(objectType, sectionId, !open)}
      >
        <span>{title}</span>
        <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d={open ? 'm3 7.5 3-3 3 3' : 'm3 4.5 3 3 3-3'} />
        </svg>
      </button>
      <div id={regionId} role="region" aria-labelledby={buttonId} hidden={!open} className="inspector-section-region">
        {children}
      </div>
    </section>
  )
}
