import { useMemo, useState } from 'react'
import type { ElementPreset, ElementPresetThumbnailKind } from '../label/elementPresets'
import { useLabelStore, useUiStore, flashToast } from '../state/stores'
import { addElementPreset, filterElementPresets, type ElementCategoryFilter } from './sidebarActions'

const CATEGORIES: { id: ElementCategoryFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'text', label: '文字' },
  { id: 'basic', label: '基础' },
  { id: 'line', label: '线条' },
  { id: 'label', label: '标签' },
  { id: 'decoration', label: '装饰' },
  { id: 'container', label: '容器' },
]

function PresetGlyph({ kind }: { kind: ElementPresetThumbnailKind }): React.JSX.Element {
  if (kind === 'text') return <span className="preset-text-glyph" aria-hidden="true">Aa</span>
  return (
    <svg className="preset-shape-glyph" aria-hidden="true" focusable="false" viewBox="0 0 44 28" fill="none" stroke="currentColor" strokeWidth="1.6">
      {kind === 'ellipse' ? (
        <ellipse cx="22" cy="14" rx="14" ry="9" />
      ) : kind === 'triangle' ? (
        <path d="m22 4 14 20H8L22 4Z" />
      ) : kind === 'diamond' ? (
        <path d="m22 3 15 11-15 11L7 14 22 3Z" />
      ) : kind === 'line' ? (
        <path d="M5 14h34" />
      ) : kind === 'wave' ? (
        <path d="M4 15c6-13 12 13 18 0s12 13 18 0" />
      ) : kind === 'star' || kind === 'burst' ? (
        <path d="m22 3 3.4 7 8-2.5-4 7 7 4-8 .5.5 7-6.5-4-6.5 4 .5-7-8-.5 7-4-4-7 8 2.5L22 3Z" />
      ) : kind === 'cross' ? (
        <path d="M18 4h8v7h7v7h-7v7h-8v-7h-7v-7h7V4Z" />
      ) : kind === 'dot-grid' ? (
        <g fill="currentColor" stroke="none">{[9, 17, 25, 33].flatMap((x) => [9, 18].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}</g>
      ) : kind === 'bracket' || kind === 'frame' ? (
        <path d="M15 5H7v18h8M29 5h8v18h-8" />
      ) : kind === 'polygon' ? (
        <path d="m13 5 18 0 8 9-8 9H13l-8-9 8-9Z" />
      ) : (
        <rect x="7" y="5" width="30" height="18" rx={kind === 'rectangle' ? 3 : 0} />
      )}
    </svg>
  )
}

function PresetButton({ preset, disabled, onAdd }: { preset: ElementPreset; disabled: boolean; onAdd: (id: string) => void }): React.JSX.Element {
  return (
    <button
      className="preset-tile"
      type="button"
      disabled={disabled}
      onClick={() => onAdd(preset.id)}
      title={disabled ? '请先从模型创建贴标区域' : `添加${preset.name}`}
    >
      <span className="preset-thumbnail"><PresetGlyph kind={preset.thumbnailKind} /></span>
      <span className="preset-name">{preset.name}</span>
    </button>
  )
}

export function ElementLibrary({ onClose }: { onClose?: () => void } = {}): React.JSX.Element {
  const hasArea = useLabelStore((state) => state.activeArea !== null)
  const setWorkspaceTab = useUiStore((state) => state.setWorkspaceTab)
  const [category, setCategory] = useState<ElementCategoryFilter>('all')
  const [query, setQuery] = useState('')
  const presets = useMemo(() => filterElementPresets(category, query), [category, query])

  const addPreset = (presetId: string): void => {
    const layerId = addElementPreset(presetId)
    if (!layerId) return
    const preset = presets.find((candidate) => candidate.id === presetId)
    flashToast(`已添加${preset?.name ?? '元素'}`, 'success')
    onClose?.()
  }

  return (
    <section className="element-library" aria-label="元素库">
      <div className="sidebar-section-head">
        <span>元素库</span>
        <span className="sidebar-count">{presets.length}</span>
        {onClose && <button className="icon-btn" type="button" aria-label="关闭元素库" title="关闭元素库" onClick={onClose}>×</button>}
      </div>
      {!hasArea && (
        <div className="element-guidance">
          <span>需要先在模型中创建贴标区域。</span>
          <button className="btn ghost sm" type="button" onClick={() => setWorkspaceTab('model')}>前往模型</button>
        </div>
      )}
      <label className="sidebar-search-label">
        <span className="sr-only">搜索元素</span>
        <input className="input sidebar-search" placeholder="搜索 32 个元素" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="element-categories" role="group" aria-label="元素分类">
        {CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={category === item.id}
            className={`element-category ${category === item.id ? 'active' : ''}`}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="preset-list">
        {presets.length === 0 ? (
          <div className="empty-hint">
            <span>没有匹配的元素。</span>
            <button className="btn ghost sm" type="button" onClick={() => { setQuery(''); setCategory('all') }}>清除筛选</button>
          </div>
        ) : (
          presets.map((preset) => <PresetButton key={preset.id} preset={preset} disabled={!hasArea} onAdd={addPreset} />)
        )}
      </div>
    </section>
  )
}
