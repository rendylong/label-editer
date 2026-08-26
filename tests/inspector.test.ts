import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FONT_CATALOG } from '../src/label/fontCatalog'
import type { UploadedFont } from '../src/label/fonts'
import type { LabelAreaConfig, LabelLayer, ShapeLayer, TextLayer } from '../src/label/types'
import { useUiStore } from '../src/state/stores'
import {
  buildFontBrowserView,
  commitLoadedFontSelection,
  createLatestFontSelectionController,
  FontBrowser,
  fontVariantSupport,
  loadAndSelectCatalogFont,
  observeFontPreview,
} from '../src/ui/FontBrowser'
import { InspectorHeader, resolveInspectorRoute } from '../src/ui/Inspector'
import { InspectorSection } from '../src/ui/InspectorSection'
import { canDistributeSelection, runMultiSelectionAction } from '../src/ui/inspectors/MultiSelectionInspector'
import { TextInspector } from '../src/ui/inspectors/TextInspector'
import { ShapeInspector } from '../src/ui/inspectors/ShapeInspector'

function documentFor(element: React.ReactNode): Document {
  return new JSDOM(`<!doctype html><body>${renderToStaticMarkup(element)}</body>`).window.document
}

function textLayer(id: string, x: number, locked = false): TextLayer {
  return {
    id, kind: 'text', text: id, fontFamily: 'outfit', fontSize: 40, fontWeight: 400,
    letterSpacing: 0, lineHeight: 1.2, color: '#222222', align: 'left', italic: false,
    x, y: x, rotation: 0, opacity: 1, visible: true, locked, zIndex: x, craft: [],
  }
}

function area(layers: LabelLayer[]): LabelAreaConfig {
  return {
    id: 'area-a', name: '正面标签', meshIndex: 0, nodeName: 'Bottle',
    remap: {
      mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 400, height: 300, aspect: 4 / 3 }, layers,
    globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

function ShapeFillHarness({ initial, patches }: { initial: ShapeLayer; patches: Array<Partial<LabelLayer>> }): React.JSX.Element {
  const [layer, setLayer] = useState(initial)
  return createElement(ShapeInspector, {
    layer,
    patch: (patch: Partial<LabelLayer>) => {
      patches.push(patch)
      setLayer((current) => ({ ...current, ...patch } as ShapeLayer))
    },
  })
}

async function withMountedDom(run: (context: {
  dom: JSDOM
  root: ReturnType<typeof createRoot>
  tick: () => Promise<void>
  unmount: () => Promise<void>
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div><button id="outside">Outside</button></body>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('Node', dom.window.Node)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(dom.window.HTMLElement.prototype as unknown as { attachEvent: () => void; detachEvent: () => void }).attachEvent = () => {}
  ;(dom.window.HTMLElement.prototype as unknown as { attachEvent: () => void; detachEvent: () => void }).detachEvent = () => {}
  const root = createRoot(dom.window.document.querySelector('#root')!)
  const tick = () => new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0))
  let mounted = true
  const unmount = async (): Promise<void> => {
    if (!mounted) return
    mounted = false
    await act(async () => root.unmount())
    await act(async () => { await tick() })
  }

  try {
    await run({ dom, root, tick, unmount })
  } finally {
    await unmount()
    dom.window.close()
    await Promise.resolve()
    vi.unstubAllGlobals()
  }
}

async function openFontBrowser(dom: JSDOM, tick: () => Promise<void>): Promise<void> {
  if (dom.window.document.querySelector('[role="dialog"]')) return
  const trigger = dom.window.document.querySelector<HTMLButtonElement>('.font-browser-trigger')!
  await act(async () => { trigger.click() })
  await act(async () => { await tick() })
}

async function chooseFreshUpload(dom: JSDOM, file: File): Promise<void> {
  const input = dom.window.document.querySelector<HTMLInputElement>('.font-upload-entry input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
}

async function editTextInput(dom: JSDOM, input: HTMLInputElement, value: string): Promise<void> {
  input.focus()
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

describe('inspector section semantics', () => {
  beforeEach(() => useUiStore.setState(useUiStore.getInitialState(), true))

  it('uses a labelled button and region and restores the per-object open state', () => {
    const document = documentFor(createElement(
      InspectorSection,
      { objectType: 'text', sectionId: 'craft', title: '工艺' },
      createElement('span', null, 'controls'),
    ))
    const button = document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
    const region = document.querySelector<HTMLElement>('[role="region"]')

    expect(button?.type).toBe('button')
    expect(button?.getAttribute('aria-controls')).toBe(region?.id)
    expect(region?.getAttribute('aria-labelledby')).toBe(button?.id)
    expect(region?.hidden).toBe(true)
  })

  it('opens content sections by default and keeps craft sections closed', () => {
    const content = documentFor(createElement(InspectorSection, { objectType: 'text', sectionId: 'content', title: '内容' }, 'content'))
    const craft = documentFor(createElement(InspectorSection, { objectType: 'text', sectionId: 'craft', title: '工艺' }, 'craft'))

    expect(content.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(craft.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('inspector routing', () => {
  const shape: ShapeLayer = {
    id: 'shape', kind: 'shape', shape: 'rectangle', width: 80, height: 40,
    fill: '#222222', stroke: '#222222', strokeWidth: 0, cornerRadius: 0,
    x: 20, y: 20, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [],
  }
  const text = textLayer('text', 10)

  it('gives an unbound selected mesh priority over layer and area contexts', () => {
    expect(resolveInspectorRoute({
      selectedMesh: { id: 'mesh', name: 'Pump', meshIndex: 2 }, selectedMeshHasArea: false,
      selectedLayers: [text, shape], activeArea: area([text, shape]), modelStatus: 'ready',
    })).toEqual({ kind: 'model', meshId: 'mesh' })
  })

  it.each([
    [[text, shape], 'multi'],
    [[text], 'text'],
    [[shape], 'shape'],
    [[], 'area'],
  ] as const)('routes %s selected layers to %s', (selectedLayers, kind) => {
    expect(resolveInspectorRoute({
      selectedMesh: null, selectedMeshHasArea: false, selectedLayers: [...selectedLayers],
      activeArea: area([text, shape]), modelStatus: 'ready',
    }).kind).toBe(kind)
  })

  it('returns a guided empty route when nothing is loaded', () => {
    expect(resolveInspectorRoute({
      selectedMesh: null, selectedMeshHasArea: false, selectedLayers: [], activeArea: null, modelStatus: 'idle',
    })).toEqual({ kind: 'empty' })
  })
})

describe('shape fill semantics', () => {
  it('shows transparent as an explicit state and restores the last deliberate opaque fill', async () => {
    const patches: Array<Partial<LabelLayer>> = []
    const transparent: ShapeLayer = {
      id: 'frame', kind: 'shape', shape: 'frame', width: 240, height: 140,
      fill: 'transparent', stroke: '#222222', strokeWidth: 2, cornerRadius: 0,
      x: 200, y: 140, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [],
    }

    await withMountedDom(async ({ dom, root, tick }) => {
      await act(async () => root.render(createElement(ShapeFillHarness, { initial: transparent, patches })))
      const transparentToggle = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="无填色（透明）"]')!
      let colorInput = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="填色颜色"]')!

      expect(transparentToggle.checked).toBe(true)
      expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe('当前填色：透明')
      expect(colorInput.type).toBe('text')
      expect(colorInput.value).toBe('transparent')
      expect(colorInput.disabled).toBe(false)
      expect(colorInput.hidden).toBe(false)

      await act(async () => { transparentToggle.click(); await tick() })
      expect(patches.at(-1)).toEqual({ fill: '#111111' })
      expect(transparentToggle.checked).toBe(false)
      colorInput = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="填色颜色"]')!
      expect(colorInput.disabled).toBe(false)
      expect(colorInput.hidden).toBe(false)

      await act(async () => root.render(createElement(ShapeFillHarness, {
        key: 'cream-fill',
        initial: { ...transparent, fill: '#c7bfa9' },
        patches,
      })))
      const opaqueToggle = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="无填色（透明）"]')!
      colorInput = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="填色颜色"]')!
      expect(opaqueToggle.checked).toBe(false)
      expect(colorInput.value).toBe('#c7bfa9')

      await act(async () => { opaqueToggle.click(); await tick() })
      expect(patches.at(-1)).toEqual({ fill: 'transparent' })
      colorInput = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="填色颜色"]')!
      expect(colorInput.value).toBe('transparent')
      expect(colorInput.hidden).toBe(false)

      await act(async () => { opaqueToggle.click(); await tick() })
      expect(patches.at(-1)).toEqual({ fill: '#c7bfa9' })
    })
  })
})

describe('CSS color inspector controls', () => {
  it('shows exact rgba and named values without mutating text or shape layers on mount', async () => {
    const textPatch = vi.fn()
    const shapePatch = vi.fn()
    const text = { ...textLayer('css-text', 10), color: 'rgba(125, 63, 42, 0.5)' }
    const shape: ShapeLayer = {
      id: 'css-shape', kind: 'shape', shape: 'rectangle', width: 80, height: 40,
      fill: 'rebeccapurple', stroke: 'rgba(10, 20, 30, 0.25)', strokeWidth: 2, cornerRadius: 4,
      x: 20, y: 20, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [],
    }

    await withMountedDom(async ({ dom, root, tick }) => {
      await act(async () => root.render(createElement('div', null,
        createElement(TextInspector, {
          area: area([text]), layer: text, patch: textPatch, commitUploadedFont: vi.fn(),
        }),
        createElement(ShapeInspector, { layer: shape, patch: shapePatch }),
      )))
      await act(async () => { await tick() })

      expect(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="文字颜色"]')?.value).toBe('rgba(125, 63, 42, 0.5)')
      expect(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="填色颜色"]')?.value).toBe('rebeccapurple')
      expect(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="描边颜色"]')?.value).toBe('rgba(10, 20, 30, 0.25)')
      expect(textPatch).not.toHaveBeenCalled()
      expect(shapePatch).not.toHaveBeenCalled()
    })
  })

  it('commits exact CSS strings only after authoritative text edits', async () => {
    const textPatch = vi.fn()
    const shapePatch = vi.fn()
    const text = { ...textLayer('css-text', 10), color: 'rgba(125, 63, 42, 0.5)' }
    const shape: ShapeLayer = {
      id: 'css-shape', kind: 'shape', shape: 'rectangle', width: 80, height: 40,
      fill: 'rebeccapurple', stroke: 'rgba(10, 20, 30, 0.25)', strokeWidth: 2, cornerRadius: 4,
      x: 20, y: 20, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [],
    }

    await withMountedDom(async ({ dom, root }) => {
      await act(async () => root.render(createElement('div', null,
        createElement(TextInspector, {
          area: area([text]), layer: text, patch: textPatch, commitUploadedFont: vi.fn(),
        }),
        createElement(ShapeInspector, { layer: shape, patch: shapePatch }),
      )))
      const textColor = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="文字颜色"]')!
      const fillColor = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="填色颜色"]')!
      const strokeColor = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="描边颜色"]')!

      await editTextInput(dom, textColor, 'color(display-p3 0.8 0.2 0.1)')
      await editTextInput(dom, fillColor, 'light-dark(white, black)')
      await editTextInput(dom, strokeColor, 'hsl(20 70% 40% / 0.75)')

      expect(textPatch).toHaveBeenLastCalledWith({ color: 'color(display-p3 0.8 0.2 0.1)' })
      expect(shapePatch).toHaveBeenCalledWith({ fill: 'light-dark(white, black)' })
      expect(shapePatch).toHaveBeenLastCalledWith({ stroke: 'hsl(20 70% 40% / 0.75)' })
    })
  })
})

describe('selected-object header', () => {
  it('exposes visibility and unlock but omits destructive mutation controls for a locked object', () => {
    const document = documentFor(createElement(InspectorHeader, {
      title: '锁定文字', visible: true, locked: true,
      onToggleVisible: vi.fn(), onToggleLocked: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
    }))

    expect(document.querySelector('button[aria-label="隐藏对象"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="解锁对象"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="复制对象"]')).toBeNull()
    expect(document.querySelector('button[aria-label="删除对象"]')).toBeNull()
  })

  it('shows duplicate and delete actions for an unlocked object', () => {
    const document = documentFor(createElement(InspectorHeader, {
      title: '文字', visible: true, locked: false,
      onToggleVisible: vi.fn(), onToggleLocked: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
    }))

    expect(document.querySelector('button[aria-label="复制对象"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="删除对象"]')).not.toBeNull()
  })
})

describe('font browser boundaries', () => {
  it('searches all 61 catalog entries while capping only rendered result rows', () => {
    const all = buildFontBrowserView('', 'all', [], [], 20)
    const chineseSans = buildFontBrowserView('Noto Sans SC', 'chinese', [], [], 20)

    expect(FONT_CATALOG).toHaveLength(61)
    expect(all.total).toBe(61)
    expect(all.rows).toHaveLength(20)
    expect(chineseSans.rows.map((font) => font.id)).toEqual(['noto-sans-sc'])
  })

  it('orders deduplicated favorites and recent sections from UI preferences', () => {
    const view = buildFontBrowserView('', 'all', ['outfit', 'outfit', 'roboto'], ['roboto', 'outfit'], 20)

    expect(view.favorites.map((font) => font.id)).toEqual(['outfit', 'roboto'])
    expect(view.recent.map((font) => font.id)).toEqual(['roboto', 'outfit'])
  })

  it('keeps catalog previews unloaded until their row intersects the viewport', async () => {
    const document = new JSDOM('<!doctype html><button id="font-row">Font</button>').window.document
    const row = document.querySelector<HTMLElement>('#font-row')!
    const ensure = vi.fn(async () => ({ id: 'inter', ok: true, cssFamily: '__catalog_inter' }))
    let callback: IntersectionObserverCallback | null = null
    const disconnect = vi.fn()

    const cleanup = observeFontPreview(row, ensure, (nextCallback) => {
      callback = nextCallback
      return { observe: vi.fn(), disconnect }
    })

    expect(ensure).not.toHaveBeenCalled()
    callback!([{ isIntersecting: false, target: row } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(ensure).not.toHaveBeenCalled()
    callback!([{ isIntersecting: true, target: row } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    await Promise.resolve()
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledOnce()
    cleanup()
  })

  it('falls back to hover or focus loading when IntersectionObserver is unavailable', () => {
    const dom = new JSDOM('<!doctype html><button id="font-row">Font</button>')
    const row = dom.window.document.querySelector<HTMLElement>('#font-row')!
    const ensure = vi.fn()

    const cleanup = observeFontPreview(row, ensure, null)
    expect(ensure).not.toHaveBeenCalled()
    row.dispatchEvent(new dom.window.Event('pointerenter'))
    row.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
    expect(ensure).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('exposes every legacy system stack without duplicating catalog results', () => {
    const all = buildFontBrowserView('', 'all', [], [], 60)
    const arial = buildFontBrowserView('Arial', 'all', [], [], 60)
    const systemOnly = buildFontBrowserView('', 'system', [], [], 60)

    expect(systemOnly.systems).toHaveLength(11)
    expect(arial.systems.map((font) => font.id)).toEqual(['arial'])
    expect(new Set([...all.rows.map((font) => font.id), ...all.systems.map((font) => font.id)]).size)
      .toBe(all.rows.length + all.systems.length)
  })

  it('reports nearest real assets instead of claiming synthetic bold or italic support', () => {
    const outfit = FONT_CATALOG.find((font) => font.id === 'outfit')!

    expect(fontVariantSupport(outfit, 700, true)).toEqual({
      weights: [400], styles: ['normal'], resolvedWeight: 400, resolvedStyle: 'normal',
      usesNearestWeight: true, usesNearestStyle: true,
    })
  })

  it('keeps the old font when catalog loading fails', async () => {
    const outfit = FONT_CATALOG.find((font) => font.id === 'outfit')!
    const select = vi.fn()

    const result = await loadAndSelectCatalogFont(outfit, 700, true, select, async () => ({
      id: 'outfit', ok: false, cssFamily: 'sans-serif', error: 'asset unavailable',
    }))

    expect(result.ok).toBe(false)
    expect(select).not.toHaveBeenCalled()
  })

  it('selects the stable catalog id only after loading succeeds', async () => {
    const outfit = FONT_CATALOG.find((font) => font.id === 'outfit')!
    const select = vi.fn()

    await loadAndSelectCatalogFont(outfit, 400, false, select, async () => ({
      id: 'outfit', ok: true, cssFamily: '__catalog_outfit',
    }))

    expect(select).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledWith('outfit')
  })

  it('keeps the old font when an uploaded-font registration result fails', () => {
    const select = vi.fn()

    expect(commitLoadedFontSelection({
      id: 'upload:broken', ok: false, cssFamily: 'sans-serif', error: 'corrupt font',
    }, 'upload:broken', select)).toBe(false)
    expect(select).not.toHaveBeenCalled()
  })

  it('applies only the latest in-flight font selection', async () => {
    let resolveA!: (value: string) => void
    let resolveB!: (value: string) => void
    const a = new Promise<string>((resolve) => { resolveA = resolve })
    const b = new Promise<string>((resolve) => { resolveB = resolve })
    const controller = createLatestFontSelectionController()
    const apply = vi.fn()

    const requestA = controller.run(() => a, apply)
    const requestB = controller.run(() => b, apply)
    resolveB('font-b')
    expect(await requestB).toMatchObject({ applied: true, value: 'font-b' })
    resolveA('font-a')
    expect(await requestA).toMatchObject({ applied: false, value: 'font-a' })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('font-b')
  })

  it('ignores a font selection that finishes after the browser unmounts', async () => {
    let resolve!: (value: string) => void
    const pending = new Promise<string>((next) => { resolve = next })
    const controller = createLatestFontSelectionController()
    const apply = vi.fn()

    const request = controller.run(() => pending, apply)
    controller.dispose()
    resolve('font-a')

    expect(await request).toMatchObject({ applied: false })
    expect(apply).not.toHaveBeenCalled()
  })

  it('uses a labelled nonmodal dialog, manages focus, and closes on Escape or outside pointer', async () => {
    await withMountedDom(async ({ dom, root, tick }) => {
      const select = vi.fn()
      await act(async () => root.render(createElement(FontBrowser, {
        selectionKey: 'area-a/text-a', currentFontId: 'inter', currentWeight: 400,
        italic: false, sampleText: 'Sample', uploadedFonts: [], onSelect: select,
        uploadFont: vi.fn(), onUploadCommit: vi.fn(),
      })))
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('.font-browser-trigger')!

      await openFontBrowser(dom, tick)
      const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
      const search = dom.window.document.querySelector<HTMLInputElement>('input[type="search"]')!
      expect(dialog.getAttribute('aria-modal')).toBe('false')
      expect(dom.window.document.getElementById(dialog.getAttribute('aria-labelledby')!)).not.toBeNull()
      expect(dom.window.document.activeElement).toBe(search)

      await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      await act(async () => { await tick() })
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull()
      expect(dom.window.document.activeElement).toBe(trigger)

      await act(async () => { trigger.click() })
      await act(async () => { await tick() })
      const arial = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.font-browser-row.system .font-choice')]
        .find((button) => button.textContent?.includes('Arial'))!
      await act(async () => { arial.click() })
      await act(async () => { await tick() })
      expect(select).toHaveBeenCalledWith('arial')
      expect(dom.window.document.activeElement).toBe(trigger)

      await act(async () => { trigger.click() })
      await act(async () => { await tick() })
      await act(async () => { dom.window.document.querySelector('#outside')!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })) })
      await act(async () => { await tick() })
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull()
      expect(dom.window.document.activeElement).toBe(trigger)
    })
  })

  it('commits a successful fresh upload through the mounted TextInspector boundary without a separate layer patch', async () => {
    await withMountedDom(async ({ dom, root, tick }) => {
      const layer = textLayer('text-a', 10)
      const config = area([layer])
      const uploaded: UploadedFont = {
        id: 'upload:fresh-brand', name: 'Fresh Brand', css: '"__upload_fresh_brand", sans-serif',
        dataUrl: 'data:font/woff2;base64,RlJFU0g=',
      }
      const uploadFont = vi.fn(async () => uploaded)
      const commitUploadedFont = vi.fn()
      const patch = vi.fn()
      await act(async () => root.render(createElement(TextInspector, {
        area: config, layer, patch, uploadFont, commitUploadedFont,
      })))

      await openFontBrowser(dom, tick)
      const file = new dom.window.File(['font'], 'fresh-brand.woff2') as unknown as File
      await chooseFreshUpload(dom, file)
      await act(async () => { await tick() })

      expect(uploadFont).toHaveBeenCalledWith(file)
      expect(commitUploadedFont).toHaveBeenCalledOnce()
      expect(commitUploadedFont).toHaveBeenCalledWith(uploaded)
      expect(patch).not.toHaveBeenCalled()
    })
  })

  it('drops a slow fresh upload when a later system selection wins', async () => {
    await withMountedDom(async ({ dom, root, tick }) => {
      const layer = textLayer('text-a', 10)
      const config = area([layer])
      let resolveUpload!: (font: UploadedFont) => void
      const pending = new Promise<UploadedFont>((resolve) => { resolveUpload = resolve })
      const uploadFont = vi.fn(() => pending)
      const commitUploadedFont = vi.fn()
      const patch = vi.fn()
      await act(async () => root.render(createElement(TextInspector, {
        area: config, layer, patch, uploadFont, commitUploadedFont,
      })))

      await openFontBrowser(dom, tick)
      await chooseFreshUpload(dom, new dom.window.File(['font'], 'slow.woff2') as unknown as File)
      expect(uploadFont).toHaveBeenCalledOnce()
      const arial = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.font-browser-row.system .font-choice')]
        .find((button) => button.textContent?.includes('Arial'))!
      await act(async () => { arial.click() })
      resolveUpload({ id: 'upload:slow', name: 'Slow', css: '"__upload_slow", sans-serif', dataUrl: 'data:font/woff2;base64,U0xPVw==' })
      await act(async () => { await pending; await tick() })

      expect(patch).toHaveBeenCalledTimes(1)
      expect(patch).toHaveBeenCalledWith({ fontFamily: 'arial' })
      expect(commitUploadedFont).not.toHaveBeenCalled()
      await openFontBrowser(dom, tick)
      expect(dom.window.document.querySelector<HTMLButtonElement>('.font-upload-entry button')?.disabled).toBe(false)
      expect(dom.window.document.body.textContent).not.toContain('已上传')
    })
  })

  it('ends upload busy state when a newer catalog selection fails and ignores the stale upload completion', async () => {
    await withMountedDom(async ({ dom, root, tick }) => {
      useUiStore.setState(useUiStore.getInitialState(), true)
      const layer = textLayer('text-a', 10)
      let resolveUpload!: (font: UploadedFont) => void
      const pending = new Promise<UploadedFont>((resolve) => { resolveUpload = resolve })
      const commitUploadedFont = vi.fn()
      const patch = vi.fn()
      await act(async () => root.render(createElement(TextInspector, {
        area: area([layer]), layer, patch, uploadFont: () => pending, commitUploadedFont,
      })))

      await openFontBrowser(dom, tick)
      await chooseFreshUpload(dom, new dom.window.File(['font'], 'slow.woff2') as unknown as File)
      expect(dom.window.document.querySelector<HTMLButtonElement>('.font-upload-entry button')?.disabled).toBe(true)

      const catalogChoice = dom.window.document.querySelector<HTMLButtonElement>('.font-browser-list .font-choice')!
      await act(async () => { catalogChoice.click(); await tick() })
      const uploadButtonAfterFailure = dom.window.document.querySelector<HTMLButtonElement>('.font-upload-entry button')!
      expect(uploadButtonAfterFailure.disabled).toBe(false)
      expect(uploadButtonAfterFailure.textContent).toBe('上传字体')
      expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('原字体保持不变')

      resolveUpload({ id: 'upload:slow', name: 'Slow', css: 'sans-serif', dataUrl: 'data:font/woff2;base64,U0xPVw==' })
      await act(async () => { await pending; await tick() })
      expect(uploadButtonAfterFailure.disabled).toBe(false)
      expect(commitUploadedFont).not.toHaveBeenCalled()
      expect(patch).not.toHaveBeenCalled()
      expect(useUiStore.getState().recentFontIds).toEqual([])
    })
  })

  it('clears upload busy state and keeps the old font when the current upload fails', async () => {
    await withMountedDom(async ({ dom, root, tick }) => {
      const layer = textLayer('text-a', 10)
      const commitUploadedFont = vi.fn()
      const patch = vi.fn()
      await act(async () => root.render(createElement(TextInspector, {
        area: area([layer]), layer, patch,
        uploadFont: async () => { throw new Error('font validation failed') },
        commitUploadedFont,
      })))

      await openFontBrowser(dom, tick)
      await chooseFreshUpload(dom, new dom.window.File(['font'], 'broken.woff2') as unknown as File)
      await act(async () => { await tick() })

      const uploadButton = dom.window.document.querySelector<HTMLButtonElement>('.font-upload-entry button')!
      expect(uploadButton.disabled).toBe(false)
      expect(uploadButton.textContent).toBe('上传字体')
      expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('font validation failed')
      expect(commitUploadedFont).not.toHaveBeenCalled()
      expect(patch).not.toHaveBeenCalled()
    })
  })

  it('drops a fresh upload after selection-key change or TextInspector unmount', async () => {
    await withMountedDom(async ({ dom, root, tick, unmount }) => {
      const firstLayer = textLayer('text-a', 10)
      const secondLayer = textLayer('text-b', 20)
      let resolveFirst!: (font: UploadedFont) => void
      let resolveUnmounted!: (font: UploadedFont) => void
      const firstPending = new Promise<UploadedFont>((resolve) => { resolveFirst = resolve })
      const unmountedPending = new Promise<UploadedFont>((resolve) => { resolveUnmounted = resolve })
      const firstUploadFont = vi.fn(() => firstPending)
      const unmountedUploadFont = vi.fn(() => unmountedPending)
      const commitUploadedFont = vi.fn()
      const patch = vi.fn()
      await act(async () => root.render(createElement(TextInspector, {
        area: area([firstLayer]), layer: firstLayer, patch,
        uploadFont: firstUploadFont, commitUploadedFont,
      })))
      await openFontBrowser(dom, tick)
      await chooseFreshUpload(dom, new dom.window.File(['font'], 'first.woff2') as unknown as File)
      expect(firstUploadFont).toHaveBeenCalledOnce()

      await act(async () => root.render(createElement(TextInspector, {
        area: { ...area([secondLayer]), id: 'area-b' }, layer: secondLayer, patch,
        uploadFont: unmountedUploadFont, commitUploadedFont,
      })))
      resolveFirst({ id: 'upload:first', name: 'First', css: 'sans-serif', dataUrl: 'data:font/woff2;base64,RklSU1Q=' })
      await act(async () => { await firstPending; await tick() })
      expect(commitUploadedFont).not.toHaveBeenCalled()

      await openFontBrowser(dom, tick)
      await chooseFreshUpload(dom, new dom.window.File(['font'], 'unmounted.woff2') as unknown as File)
      expect(unmountedUploadFont).toHaveBeenCalledOnce()
      await unmount()
      resolveUnmounted({ id: 'upload:unmounted', name: 'Unmounted', css: 'sans-serif', dataUrl: 'data:font/woff2;base64,VU5NT1VOVEVE' })
      await unmountedPending
      await Promise.resolve()
      expect(commitUploadedFont).not.toHaveBeenCalled()
    })
  })

  it('persists and selects a fresh upload in one area mutation', async () => {
    const module = await import('../src/ui/inspectors/TextInspector') as unknown as {
      commitFreshUploadedFont?: (
        areaId: string,
        layerId: string,
        font: UploadedFont,
        applyAreaOp: (areaId: string, updater: (area: LabelAreaConfig) => LabelAreaConfig) => void,
      ) => void
    }
    expect(module.commitFreshUploadedFont).toBeTypeOf('function')
    let current = area([textLayer('text-a', 10)])
    const applyAreaOp = vi.fn((_areaId: string, updater: (area: LabelAreaConfig) => LabelAreaConfig) => {
      current = updater(current)
    })
    const font: UploadedFont = {
      id: 'upload:brand', name: 'Brand', css: '"__upload_brand", sans-serif', dataUrl: 'data:font/woff2;base64,QlJBTkQ=',
    }

    module.commitFreshUploadedFont!(current.id, 'text-a', font, applyAreaOp)

    expect(applyAreaOp).toHaveBeenCalledOnce()
    expect(current.fonts).toEqual([{ name: 'Brand', dataUrl: font.dataUrl }])
    expect(current.layers[0]).toMatchObject({ id: 'text-a', fontFamily: 'upload:brand' })
  })
})

describe('multi-selection gateway', () => {
  it('applies a locked-safe opacity change through exactly one area operation', () => {
    let current = area([textLayer('a', 10), textLayer('b', 20), textLayer('locked', 30, true)])
    const applyAreaOp = vi.fn((_areaId: string, updater: (value: LabelAreaConfig) => LabelAreaConfig) => {
      current = updater(current)
    })

    runMultiSelectionAction(current.id, current.layers.map((layer) => layer.id), { type: 'opacity', value: 0.35 }, applyAreaOp)

    expect(applyAreaOp).toHaveBeenCalledTimes(1)
    expect(current.layers.map((layer) => layer.opacity)).toEqual([0.35, 0.35, 1])
  })

  it('deletes only unlocked selected layers through one operation', () => {
    let current = area([textLayer('a', 10), textLayer('locked', 30, true)])
    const applyAreaOp = vi.fn((_areaId: string, updater: (value: LabelAreaConfig) => LabelAreaConfig) => {
      current = updater(current)
    })

    runMultiSelectionAction(current.id, ['a', 'locked'], { type: 'delete' }, applyAreaOp)

    expect(applyAreaOp).toHaveBeenCalledTimes(1)
    expect(current.layers.map((layer) => layer.id)).toEqual(['locked'])
  })

  it('enables distribution only for selections of at least three objects', () => {
    expect(canDistributeSelection(2)).toBe(false)
    expect(canDistributeSelection(3)).toBe(true)
  })
})
