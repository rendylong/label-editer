import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FONT_CATALOG, fontEntry, searchFonts, type FontCatalogEntry, type FontCategory } from '../label/fontCatalog'
import type { UploadedFont } from '../label/fonts'
import {
  ensureFontLoaded,
  ensureUploadedFontLoaded,
  fontCssFor,
  SYSTEM_FONT_ENTRIES,
  systemFontEntry,
  uploadedFontId,
  uploadedFontReceipt,
  type FontLoadResult,
  type SystemFontEntry,
} from '../label/fontRuntime'
import type { UploadedFontRecord } from '../label/types'
import { useUiStore } from '../state/stores'

export type FontCategoryFilter = FontCategory | 'system' | 'all'

export interface FontBrowserView {
  total: number
  rows: FontCatalogEntry[]
  systems: SystemFontEntry[]
  favorites: FontCatalogEntry[]
  recent: FontCatalogEntry[]
}

function uniqueCatalogEntries(ids: string[]): FontCatalogEntry[] {
  const seen = new Set<string>()
  return ids.flatMap((id) => {
    if (seen.has(id)) return []
    seen.add(id)
    const entry = fontEntry(id)
    return entry ? [entry] : []
  })
}

export function buildFontBrowserView(
  query: string,
  category: FontCategoryFilter,
  favoriteIds: string[],
  recentIds: string[],
  visibleLimit = 24,
): FontBrowserView {
  const filtered = category === 'system' ? [] : searchFonts(query, category === 'all' ? undefined : category)
  const normalized = query.trim().toLocaleLowerCase()
  const systems = category !== 'all' && category !== 'system'
    ? []
    : SYSTEM_FONT_ENTRIES.filter((font) => !normalized || `${font.id} ${font.name}`.toLocaleLowerCase().includes(normalized))
  return {
    total: filtered.length,
    rows: filtered.slice(0, visibleLimit),
    systems,
    favorites: uniqueCatalogEntries(favoriteIds),
    recent: uniqueCatalogEntries(recentIds),
  }
}

type PreviewObserverFactory = (
  callback: IntersectionObserverCallback,
) => Pick<IntersectionObserver, 'observe' | 'disconnect'>

/** Load a preview only after it is visible. Without IO, hover/focus remain explicit gates. */
export function observeFontPreview(
  element: HTMLElement,
  load: () => unknown,
  observerFactory?: PreviewObserverFactory | null,
): () => void {
  let loaded = false
  const loadOnce = (): void => {
    if (loaded) return
    loaded = true
    load()
  }
  const factory = observerFactory === null
    ? null
    : observerFactory ?? (typeof IntersectionObserver === 'undefined'
      ? null
      : (callback: IntersectionObserverCallback) => new IntersectionObserver(callback))

  if (factory) {
    const observer = factory((entries) => {
      if (!entries.some((entry) => entry.target === element && entry.isIntersecting)) return
      observer.disconnect()
      loadOnce()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }

  element.addEventListener('pointerenter', loadOnce)
  element.addEventListener('focusin', loadOnce)
  return () => {
    element.removeEventListener('pointerenter', loadOnce)
    element.removeEventListener('focusin', loadOnce)
  }
}

export interface LatestFontSelectionController {
  run: <T>(request: () => Promise<T>, apply: (value: T) => void) => Promise<{ value: T; applied: boolean }>
  activate: () => void
  invalidate: () => void
  dispose: () => void
}

/** Monotonic request gate: only the latest mounted selection may mutate the active object. */
export function createLatestFontSelectionController(): LatestFontSelectionController {
  let requestToken = 0
  let mounted = true
  return {
    async run(request, apply) {
      const token = ++requestToken
      const value = await request()
      const applied = mounted && token === requestToken
      if (applied) apply(value)
      return { value, applied }
    },
    activate() { mounted = true },
    invalidate() { requestToken += 1 },
    dispose() {
      mounted = false
      requestToken += 1
    },
  }
}

export interface FontVariantSupport {
  weights: number[]
  styles: Array<'normal' | 'italic'>
  resolvedWeight: number
  resolvedStyle: 'normal' | 'italic'
  usesNearestWeight: boolean
  usesNearestStyle: boolean
}

export function fontVariantSupport(entry: FontCatalogEntry, requestedWeight: number, italic: boolean): FontVariantSupport {
  const assets = Object.keys(entry.files).flatMap((key) => {
    const match = /^(\d+)-(normal|italic)$/.exec(key)
    return match && entry.files[key as keyof typeof entry.files]
      ? [{ weight: Number(match[1]), style: match[2] as 'normal' | 'italic' }]
      : []
  })
  const weights = [...new Set(assets.map((asset) => asset.weight))].sort((a, b) => a - b)
  const styles = [...new Set(assets.map((asset) => asset.style))]
  const requestedStyle = italic ? 'italic' : 'normal'
  const resolvedStyle = styles.includes(requestedStyle)
    ? requestedStyle
    : styles.includes('normal') ? 'normal' : styles[0] ?? 'normal'
  const styleAssets = assets.filter((asset) => asset.style === resolvedStyle)
  const resolvedWeight = styleAssets
    .map((asset) => asset.weight)
    .sort((a, b) => Math.abs(a - requestedWeight) - Math.abs(b - requestedWeight) || a - b)[0] ?? requestedWeight
  return {
    weights,
    styles,
    resolvedWeight,
    resolvedStyle,
    usesNearestWeight: resolvedWeight !== requestedWeight,
    usesNearestStyle: resolvedStyle !== requestedStyle,
  }
}

export async function loadAndSelectCatalogFont(
  entry: FontCatalogEntry,
  requestedWeight: number,
  italic: boolean,
  onSelect: (fontId: string) => void,
  loader: (id: string, weight: number, style: 'normal' | 'italic') => Promise<FontLoadResult> = ensureFontLoaded,
): Promise<FontLoadResult> {
  const result = await loader(entry.id, requestedWeight, italic ? 'italic' : 'normal')
  commitLoadedFontSelection(result, entry.id, onSelect)
  return result
}

export function commitLoadedFontSelection(
  result: FontLoadResult,
  fontId: string,
  onSelect: (fontId: string) => void,
): boolean {
  if (!result.ok) return false
  onSelect(fontId)
  return true
}

const CATEGORIES: Array<{ id: FontCategoryFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'chinese', label: '中文' },
  { id: 'arabic', label: '阿拉伯文' },
  { id: 'sans', label: '无衬线' },
  { id: 'serif', label: '衬线' },
  { id: 'display', label: '展示' },
  { id: 'handwriting', label: '手写' },
  { id: 'mono', label: '等宽' },
  { id: 'system', label: '系统' },
]

type FontLoadState = 'idle' | 'loading' | 'ready' | 'error'

function coverageLabel(entry: FontCatalogEntry): string {
  if (entry.languages.includes('ar')) return 'Arabic / Latin'
  if (entry.languages.includes('zh-Hans') && entry.languages.includes('zh-Hant')) return '简繁 / Latin'
  if (entry.languages.includes('zh-Hans')) return '简中 / Latin'
  if (entry.languages.includes('zh-Hant')) return '繁中 / Latin'
  return 'Latin'
}

function CatalogFontRow({
  entry,
  currentFontId,
  currentWeight,
  italic,
  sample,
  uploadedFonts,
  favorite,
  state,
  onFavorite,
  onPreview,
  onChoose,
}: {
  entry: FontCatalogEntry
  currentFontId: string
  currentWeight: number
  italic: boolean
  sample: string
  uploadedFonts: UploadedFontRecord[]
  favorite: boolean
  state: FontLoadState
  onFavorite: () => void
  onPreview: () => void
  onChoose: () => void
}): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const support = fontVariantSupport(entry, currentWeight, italic)
  useEffect(() => rowRef.current ? observeFontPreview(rowRef.current, onPreview) : undefined, [entry.id, onPreview])

  return <div ref={rowRef} className={`font-browser-row ${currentFontId === entry.id ? 'selected' : ''}`}>
    <button className="font-favorite" type="button" aria-label={favorite ? `取消收藏 ${entry.name}` : `收藏 ${entry.name}`} aria-pressed={favorite} onClick={onFavorite}>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6">
        <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />
      </svg>
    </button>
    <button className="font-choice" type="button" onClick={onChoose} disabled={state === 'loading'}>
      <span className="font-row-top">
        <span className="font-row-name">{entry.name}</span>
        <span className={`font-load-state ${state}`}>{state === 'loading' ? '加载中' : state === 'ready' ? '已加载' : state === 'error' ? '不可用' : '按需加载'}</span>
      </span>
      <span className="font-row-sample" style={{ fontFamily: fontCssFor(entry.id, uploadedFonts) }}>{sample}</span>
      <span className="font-row-meta">
        <span>{coverageLabel(entry)}</span>
        <span>{support.weights.join(' / ')} · {support.styles.includes('italic') ? '正体 / 斜体' : '仅正体'}</span>
      </span>
    </button>
  </div>
}

function LoadGatedRow({ children, onPreview, className }: {
  children: React.ReactNode
  onPreview: () => void
  className: string
}): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => rowRef.current ? observeFontPreview(rowRef.current, onPreview) : undefined, [onPreview])
  return <div ref={rowRef} className={className}>{children}</div>
}

export function FontBrowser({
  currentFontId,
  currentWeight,
  italic,
  sampleText,
  uploadedFonts,
  selectionKey,
  disabled = false,
  onSelect,
  uploadFont,
  onUploadCommit,
}: {
  currentFontId: string
  currentWeight: number
  italic: boolean
  sampleText: string
  uploadedFonts: UploadedFontRecord[]
  selectionKey: string
  disabled?: boolean
  onSelect: (fontId: string) => void
  uploadFont: (file: File) => Promise<UploadedFont>
  onUploadCommit: (font: UploadedFont) => void
}): React.JSX.Element {
  const favoriteIds = useUiStore((state) => state.favoriteFontIds)
  const recentIds = useUiStore((state) => state.recentFontIds)
  const toggleFavorite = useUiStore((state) => state.toggleFavoriteFont)
  const rememberRecent = useUiStore((state) => state.rememberRecentFont)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<FontCategoryFilter>('all')
  const [loadStates, setLoadStates] = useState<Record<string, FontLoadState>>({})
  const [error, setError] = useState<string | null>(null)
  const [activeUploadToken, setActiveUploadToken] = useState<number | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const restoreTriggerFocus = useRef(false)
  const previewRequests = useRef(new Set<string>())
  const selectionController = useRef(createLatestFontSelectionController())
  const uploadRequestToken = useRef(0)
  const mountedRef = useRef(true)
  const selectionKeyRef = useRef(selectionKey)
  selectionKeyRef.current = selectionKey
  const titleId = useId()
  const view = useMemo(() => buildFontBrowserView(query, category, favoriteIds, recentIds), [query, category, favoriteIds, recentIds])
  const uploadedMatches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return uploadedFonts.filter((font) => !normalized || font.name.toLocaleLowerCase().includes(normalized))
  }, [query, uploadedFonts])
  const currentEntry = fontEntry(currentFontId)
  const currentSystem = systemFontEntry(currentFontId)
  const currentUpload = uploadedFonts.find((font) => uploadedFontId(font.name) === currentFontId || font.name === currentFontId)
  const currentName = currentEntry?.name ?? currentSystem?.name ?? currentUpload?.name ?? currentFontId
  const sample = sampleText.trim() || '品牌字体 Sample 0123'
  const uploading = activeUploadToken !== null

  const cancelUploadBusy = (): void => {
    uploadRequestToken.current += 1
    if (mountedRef.current) setActiveUploadToken(null)
  }

  useEffect(() => {
    const controller = selectionController.current
    mountedRef.current = true
    controller.activate()
    return () => {
      uploadRequestToken.current += 1
      mountedRef.current = false
      controller.dispose()
    }
  }, [])

  useEffect(() => {
    selectionController.current.invalidate()
    cancelUploadBusy()
    setError(null)
  }, [selectionKey])

  const closePopover = (): void => {
    restoreTriggerFocus.current = true
    selectionController.current.invalidate()
    cancelUploadBusy()
    setOpen(false)
  }

  useEffect(() => {
    if (open) {
      const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0)
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault()
          closePopover()
        }
      }
      const onPointerDown = (event: PointerEvent): void => {
        const target = event.target as Node | null
        if (target && !popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) closePopover()
      }
      document.addEventListener('keydown', onKeyDown)
      document.addEventListener('pointerdown', onPointerDown)
      return () => {
        window.clearTimeout(focusTimer)
        document.removeEventListener('keydown', onKeyDown)
        document.removeEventListener('pointerdown', onPointerDown)
      }
    }
    if (restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false
      const focusTimer = window.setTimeout(() => triggerRef.current?.focus(), 0)
      return () => window.clearTimeout(focusTimer)
    }
  }, [open])

  const previewCatalog = (entry: FontCatalogEntry): void => {
    const key = `catalog/${entry.id}`
    if (previewRequests.current.has(key)) return
    previewRequests.current.add(key)
    setLoadStates((state) => ({ ...state, [entry.id]: 'loading' }))
    void ensureFontLoaded(entry.id, 400, 'normal').then((result) => {
      if (!mountedRef.current) return
      setLoadStates((state) => ({ ...state, [entry.id]: result.ok ? 'ready' : 'error' }))
    })
  }

  const previewUpload = (font: UploadedFontRecord): void => {
    const id = uploadedFontId(font.name)
    let revision: string
    try { revision = uploadedFontReceipt(font).receiptKey } catch { revision = 'invalid' }
    const key = `uploaded/${id}/${revision}`
    if (previewRequests.current.has(key)) return
    previewRequests.current.add(key)
    setLoadStates((state) => ({ ...state, [id]: 'loading' }))
    void ensureUploadedFontLoaded(font).then((result) => {
      if (!mountedRef.current) return
      setLoadStates((state) => ({ ...state, [id]: result.ok ? 'ready' : 'error' }))
    })
  }

  const choose = async (entry: FontCatalogEntry): Promise<void> => {
    const sourceSelectionKey = selectionKeyRef.current
    cancelUploadBusy()
    setLoadStates((state) => ({ ...state, [entry.id]: 'loading' }))
    setError(null)
    await selectionController.current.run(
      () => ensureFontLoaded(entry.id, currentWeight, italic ? 'italic' : 'normal'),
      (result) => {
        if (selectionKeyRef.current !== sourceSelectionKey) return
        if (!result.ok) {
          setLoadStates((state) => ({ ...state, [entry.id]: 'error' }))
          setError(result.error ?? `无法加载 ${entry.name}`)
          return
        }
        setLoadStates((state) => ({ ...state, [entry.id]: 'ready' }))
        commitLoadedFontSelection(result, entry.id, onSelect)
        rememberRecent(entry.id)
        closePopover()
      },
    )
  }

  const chooseUpload = async (font: UploadedFontRecord): Promise<void> => {
    const id = uploadedFontId(font.name)
    const sourceSelectionKey = selectionKeyRef.current
    cancelUploadBusy()
    setLoadStates((state) => ({ ...state, [id]: 'loading' }))
    setError(null)
    await selectionController.current.run(
      () => ensureUploadedFontLoaded(font),
      (result) => {
        if (selectionKeyRef.current !== sourceSelectionKey) return
        if (!result.ok) {
          setLoadStates((state) => ({ ...state, [id]: 'error' }))
          setError(result.error ?? `无法加载 ${font.name}`)
          return
        }
        setLoadStates((state) => ({ ...state, [id]: 'ready' }))
        commitLoadedFontSelection(result, id, onSelect)
        closePopover()
      },
    )
  }

  const chooseSystem = (font: SystemFontEntry): void => {
    const sourceSelectionKey = selectionKeyRef.current
    cancelUploadBusy()
    void selectionController.current.run(
      () => Promise.resolve<FontLoadResult>({ id: font.id, ok: true, cssFamily: font.css }),
      () => {
        if (selectionKeyRef.current !== sourceSelectionKey) return
        onSelect(font.id)
        closePopover()
      },
    )
  }

  const uploadFresh = async (file: File): Promise<void> => {
    const sourceSelectionKey = selectionKeyRef.current
    const uploadToken = ++uploadRequestToken.current
    setActiveUploadToken(uploadToken)
    setError(null)
    try {
      await selectionController.current.run(
        async () => {
          try {
            return { ok: true as const, font: await uploadFont(file) }
          } catch (uploadError) {
            return {
              ok: false as const,
              error: uploadError instanceof Error ? uploadError.message : '字体加载失败',
            }
          }
        },
        (result) => {
          if (selectionKeyRef.current !== sourceSelectionKey) return
          if (!result.ok) {
            setError(result.error)
            return
          }
          onUploadCommit(result.font)
          closePopover()
        },
      )
    } finally {
      if (mountedRef.current) {
        setActiveUploadToken((currentToken) => currentToken === uploadToken ? null : currentToken)
      }
    }
  }

  const renderRow = (entry: FontCatalogEntry): React.JSX.Element => <CatalogFontRow
    key={entry.id}
    entry={entry}
    currentFontId={currentFontId}
    currentWeight={currentWeight}
    italic={italic}
    sample={sample}
    uploadedFonts={uploadedFonts}
    favorite={favoriteIds.includes(entry.id)}
    state={loadStates[entry.id] ?? 'idle'}
    onFavorite={() => toggleFavorite(entry.id)}
    onPreview={() => previewCatalog(entry)}
    onChoose={() => void choose(entry)}
  />

  return (
    <div className="font-browser">
      <button ref={triggerRef} className="font-browser-trigger" type="button" disabled={disabled} aria-expanded={open} onClick={() => open ? closePopover() : setOpen(true)}>
        <span>
          <span className="font-trigger-label">字体</span>
          <span className="font-trigger-name">{currentName}</span>
        </span>
        <span className="font-trigger-sample" style={{ fontFamily: fontCssFor(currentFontId, uploadedFonts) }}>{sample}</span>
      </button>
      {open && (
        <div ref={popoverRef} className="font-browser-popover" role="dialog" aria-modal="false" aria-labelledby={titleId}>
          <div className="font-browser-toolbar">
            <h3 className="sr-only" id={titleId}>字体浏览器</h3>
            <label>
              <span className="sr-only">搜索 60 款字体</span>
              <input ref={searchRef} className="input" type="search" placeholder="搜索字体库与系统字体" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <button className="icon-btn" type="button" aria-label="关闭字体浏览器" onClick={closePopover}>
              <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="13" height="13" stroke="currentColor" strokeWidth="1.5"><path d="m3 3 10 10M13 3 3 13" /></svg>
            </button>
          </div>
          {view.systems.length > 0 && <div className="font-quick-section">
            <div className="font-list-label">系统字体 <span>{view.systems.length}</span></div>
            {view.systems.map((font) => <div className={`font-browser-row system ${currentFontId === font.id ? 'selected' : ''}`} key={font.id}>
              <span className="font-upload-mark" aria-hidden="true">Aa</span>
              <button className="font-choice" type="button" onClick={() => chooseSystem(font)}>
                <span className="font-row-top"><span className="font-row-name">{font.name}</span><span className="font-load-state ready">系统可用</span></span>
                <span className="font-row-sample" style={{ fontFamily: font.css }}>{sample}</span>
                <span className="font-row-meta"><span>系统字体栈</span><span>无需下载</span></span>
              </button>
            </div>)}
          </div>}
          <div className="font-category-chips" role="group" aria-label="字体分类">
            {CATEGORIES.map((item) => (
              <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>
            ))}
          </div>
          {!query && view.favorites.length > 0 && <div className="font-quick-section"><div className="font-list-label">收藏</div>{view.favorites.map(renderRow)}</div>}
          {!query && view.recent.length > 0 && <div className="font-quick-section"><div className="font-list-label">最近使用</div>{view.recent.map(renderRow)}</div>}
          {uploadedMatches.length > 0 && <div className="font-quick-section">
            <div className="font-list-label">已上传 <span>{uploadedMatches.length}</span></div>
            {uploadedMatches.map((font) => {
              const id = uploadedFontId(font.name)
              const state = loadStates[id] ?? 'idle'
              return <LoadGatedRow className={`font-browser-row uploaded ${currentFontId === id ? 'selected' : ''}`} key={id} onPreview={() => previewUpload(font)}>
                <span className="font-upload-mark" aria-hidden="true">Aa</span>
                <button className="font-choice" type="button" onClick={() => void chooseUpload(font)} disabled={state === 'loading'}>
                  <span className="font-row-top"><span className="font-row-name">{font.name}</span><span className={`font-load-state ${state}`}>{state === 'loading' ? '加载中' : state === 'ready' ? '项目字体' : state === 'error' ? '不可用' : '按需加载'}</span></span>
                  <span className="font-row-sample" style={{ fontFamily: fontCssFor(id, uploadedFonts) }}>{sample}</span>
                  <span className="font-row-meta"><span>自定义覆盖</span><span>单文件字形</span></span>
                </button>
              </LoadGatedRow>
            })}
          </div>}
          <div className="font-list-label">字体库 <span>{view.total}</span></div>
          <div className="font-browser-list">{view.rows.map(renderRow)}</div>
          {view.total > view.rows.length && <div className="font-list-more">继续输入名称以筛选其余 {view.total - view.rows.length} 款</div>}
          {view.total === 0 && view.systems.length === 0 && uploadedMatches.length === 0 && <div className="empty-hint">没有匹配字体。可清除筛选或上传本地字体。</div>}
          <div className="font-upload-entry">
            <button className="btn secondary" type="button" disabled={uploading} onClick={() => uploadRef.current?.click()}>{uploading ? '正在验证字体…' : '上传字体'}</button>
            <span>TTF / OTF / WOFF2，最大 20MB</span>
            <input ref={uploadRef} type="file" accept=".ttf,.otf,.woff2" hidden onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void uploadFresh(file)
              event.target.value = ''
            }} />
          </div>
          {error && <div className="font-browser-error" role="alert">{error}。原字体保持不变。</div>}
        </div>
      )}
    </div>
  )
}
