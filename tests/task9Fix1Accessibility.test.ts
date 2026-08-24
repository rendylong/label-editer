import { act, createElement, Fragment } from 'react'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelAreaConfig, TextLayer } from '../src/label/types'
import { uploadedFontId } from '../src/label/fontRuntime'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'
import { ElementLibrary } from '../src/ui/ElementLibrary'
import { EditorSidebar } from '../src/ui/EditorSidebar'
import { FontBrowser } from '../src/ui/FontBrowser'
import { Inspector } from '../src/ui/Inspector'
import { TextInspector } from '../src/ui/inspectors/TextInspector'
import { AreaInspector } from '../src/ui/inspectors/AreaInspector'
import { AreaDeleteConfirmation, LabelWorkspace } from '../src/ui/LabelWorkspace'
import { Toolbar } from '../src/ui/Toolbar'
import { AreaSetupView } from '../src/app/AreaSetupView'
import { CraftEditor } from '../src/ui/CraftEditor'

const mocks = vi.hoisted(() => ({
  loadModelFromBytes: vi.fn(async () => ({ labelActivated: true })),
  loadSample: vi.fn(async () => undefined),
  importProject: vi.fn(async () => undefined),
  exportPng: vi.fn(async () => undefined),
  exportGlbFile: vi.fn(async () => undefined),
}))

vi.mock('../src/app/modelLoader', () => ({
  loadModelFromBytes: mocks.loadModelFromBytes,
  loadSample: mocks.loadSample,
}))
vi.mock('../src/app/actions', () => ({
  exportPng: mocks.exportPng,
  exportGlbFile: mocks.exportGlbFile,
  exportProject: vi.fn(),
  importProject: mocks.importProject,
}))

const css = readFileSync(new URL('../src/app/styles.css', import.meta.url), 'utf8')

async function withMountedDom(run: (dom: JSDOM, root: ReturnType<typeof createRoot>) => Promise<void>): Promise<void> {
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>`, { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('Node', dom.window.Node)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(dom.window.HTMLElement.prototype as unknown as { attachEvent: () => void; detachEvent: () => void }).attachEvent = () => {}
  ;(dom.window.HTMLElement.prototype as unknown as { attachEvent: () => void; detachEvent: () => void }).detachEvent = () => {}
  const root = createRoot(dom.window.document.querySelector('#root')!)
  try {
    await run(dom, root)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  }
}

function buttonByText(document: Document, text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}

const area: LabelAreaConfig = {
  id: 'area-a', name: '正面标签', meshIndex: 0, nodeName: 'Bottle',
  remap: { mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] } },
  range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
  canvas: { width: 400, height: 300, aspect: 4 / 3 },
  layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
}

const textLayer: TextLayer = {
  id: 'text-a', kind: 'text', text: '精华', fontFamily: 'outfit', fontSize: 40, fontWeight: 400,
  letterSpacing: 0, lineHeight: 1.2, color: '#000000', align: 'left', italic: false,
  x: 0, y: 0, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
}

describe('Task 9 Fix Round 1 accessibility and visual contracts', () => {
  beforeEach(() => {
    mocks.loadModelFromBytes.mockClear()
    mocks.importProject.mockClear()
    mocks.exportPng.mockReset().mockResolvedValue(undefined)
    mocks.exportGlbFile.mockReset().mockResolvedValue(undefined)
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState(useModelStore.getInitialState(), true)
  })

  it('uses visible keyboard buttons for both toolbar file pickers and preserves each file flow', async () => {
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Toolbar)))
      const openButton = buttonByText(dom.window.document, '打开 GLB')
      const projectButton = buttonByText(dom.window.document, '项目↑')
      const glbInput = dom.window.document.querySelector<HTMLInputElement>('input[type="file"][accept=".glb"]')!
      const projectInput = dom.window.document.querySelector<HTMLInputElement>('input[type="file"][accept=".json,.lbl"]')!

      expect(openButton.tagName).toBe('BUTTON')
      expect(projectButton.tagName).toBe('BUTTON')
      expect(glbInput.hidden).toBe(true)
      expect(projectInput.hidden).toBe(true)
      expect(glbInput.tabIndex).toBe(-1)
      expect(projectInput.tabIndex).toBe(-1)

      const glbClick = vi.spyOn(glbInput, 'click')
      openButton.focus()
      expect(dom.window.document.activeElement).toBe(openButton)
      expect(openButton.matches(':focus-visible')).toBe(true)
      expect(dom.window.getComputedStyle(openButton).outline).toBe('2px solid var(--color-accent)')
      expect(dom.window.getComputedStyle(openButton).outlineOffset).toBe('2px')
      await act(async () => openButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
      expect(glbClick).toHaveBeenCalledTimes(1)

      const projectClick = vi.spyOn(projectInput, 'click')
      projectButton.focus()
      await act(async () => projectButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })))
      expect(projectClick).toHaveBeenCalledTimes(1)

      const glbFile = { name: 'serum.glb', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
      Object.defineProperty(glbInput, 'files', { configurable: true, value: [glbFile] })
      await act(async () => glbInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
      expect(mocks.loadModelFromBytes).toHaveBeenCalledWith('serum.glb', new Uint8Array([1, 2, 3]))

      const projectFile = { name: 'serum.lbl' }
      Object.defineProperty(projectInput, 'files', { configurable: true, value: [projectFile] })
      await act(async () => projectInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
      expect(mocks.importProject).toHaveBeenCalledWith(projectFile)

    })
  })

  it('renders essential guidance and meaningful font metadata with secondary contrast and legible compact size', async () => {
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Fragment, null,
        createElement(ElementLibrary),
        createElement(FontBrowser, {
          currentFontId: 'outfit', currentWeight: 400, italic: false, sampleText: '精华',
          uploadedFonts: [], selectionKey: 'area-a/text-a', onSelect: vi.fn(), onUploadCommit: vi.fn(),
          uploadFont: async () => ({ id: 'upload:test', name: 'Test', css: 'sans-serif', dataUrl: 'data:font/woff2;base64,' }),
        }),
      )))
      const guidance = dom.window.document.querySelector<HTMLElement>('.element-guidance')!
      expect(guidance.textContent).toContain('需要先在模型中创建贴标区域')
      expect(dom.window.getComputedStyle(guidance).color).toBe('var(--color-text-secondary)')
      expect(Number.parseFloat(dom.window.getComputedStyle(guidance).fontSize)).toBeGreaterThanOrEqual(11)

      await act(async () => dom.window.document.querySelector<HTMLButtonElement>('.font-browser-trigger')!.click())
      const metadata = dom.window.document.querySelector<HTMLElement>('.font-row-meta')!
      const loadState = dom.window.document.querySelector<HTMLElement>('.font-load-state')!
      expect(dom.window.getComputedStyle(metadata).color).toBe('var(--color-text-secondary)')
      expect(['var(--color-text-secondary)', 'var(--success)']).toContain(dom.window.getComputedStyle(loadState).color)
      for (const element of [metadata, loadState]) expect(Number.parseFloat(dom.window.getComputedStyle(element).fontSize)).toBeGreaterThanOrEqual(10)
    })
  })

  it('lays out element filters as a two-row segmented grid with clear active and focus states', async () => {
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(ElementLibrary)))
      const categories = dom.window.document.querySelector<HTMLElement>('.element-categories')!
      const active = dom.window.document.querySelector<HTMLElement>('.element-category.active')!
      const inactive = [...dom.window.document.querySelectorAll<HTMLElement>('.element-category')].find((item) => !item.classList.contains('active'))!

      expect(dom.window.getComputedStyle(categories).display).toBe('grid')
      expect(dom.window.getComputedStyle(categories).gridTemplateColumns).toContain('repeat(4')
      expect(dom.window.getComputedStyle(categories).overflowX).not.toBe('auto')
      expect(Number.parseFloat(dom.window.getComputedStyle(active).minHeight)).toBeGreaterThanOrEqual(28)
      expect(dom.window.getComputedStyle(active).boxShadow).not.toBe(dom.window.getComputedStyle(inactive).boxShadow)
    })
  })

  it('shows a distinct material cue and explanation for every layer craft', () => {
    const craft = [
      { type: 'foil', params: { foilColor: 'gold' } },
      { type: 'emboss', params: { depth: 0.08 } },
      { type: 'deboss', params: { depth: 0.08 } },
      { type: 'matte', params: { intensity: 0.3 } },
      { type: 'uv', params: { gloss: 0.5 } },
      { type: 'stroke', params: { strokeColor: '#222222', strokeWidth: 4 } },
    ] as TextLayer['craft']
    const document = new JSDOM(`<!doctype html><body>${renderToStaticMarkup(createElement(CraftEditor, { craft, scope: 'layer', onChange: vi.fn() }))}</body>`).window.document

    expect(document.querySelectorAll('.craft-effect-preview[data-craft-effect]')).toHaveLength(6)
    expect(document.querySelectorAll('.craft-effect-description')).toHaveLength(6)
  })

  it('closes the element library after adding a preset and exposes an explicit close control', async () => {
    useLabelStore.getState().addArea(area)
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(LabelWorkspace)))
      await act(async () => buttonByText(dom.window.document, '添加元素').click())
      expect(dom.window.document.querySelector('.element-library')).not.toBeNull()
      expect(dom.window.document.querySelector<HTMLButtonElement>('[aria-label="关闭元素库"]')).not.toBeNull()

      const firstPreset = dom.window.document.querySelector<HTMLButtonElement>('.preset-tile')!
      await act(async () => firstPreset.click())
      expect(useLabelStore.getState().activeArea?.layers).toHaveLength(1)
      expect(dom.window.document.querySelector('.element-library')).toBeNull()
    })
  })

  it('replaces the non-functional original-texture toggle with truthful UV guidance', () => {
    const document = new JSDOM(`<!doctype html><body>${renderToStaticMarkup(createElement(AreaInspector, { area, patchArea: vi.fn() }))}</body>`).window.document

    expect(document.body.textContent).not.toContain('显示原始参考纹理')
    expect(document.body.textContent).toContain('重建 UV 后原始纹理不能直接作为参考')
  })

  it('uses repaired Blender names in the area target picker', async () => {
    useModelStore.setState({
      parts: [{ id: 'broken', name: 'B��zierCurve_Material.006_0', kind: 'mesh', meshIndex: 4, visible: true, children: [] }],
    })
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(AreaSetupView)))
      expect(dom.window.document.body.textContent).toContain('BézierCurve_Material.006_0')
      expect(dom.window.document.body.textContent).not.toContain('B��zier')
    })
  })

  it('shows export progress and prevents duplicate PNG or GLB submissions', async () => {
    let finish!: () => void
    mocks.exportPng.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined) }))
    useLabelStore.getState().addArea(area)
    useLabelStore.getState().setBake(area.id, {
      color: {} as HTMLCanvasElement, metalness: {} as HTMLCanvasElement,
      roughness: {} as HTMLCanvasElement, bump: {} as HTMLCanvasElement,
      spec: area.canvas, version: 1,
    })
    useModelStore.setState({ status: 'ready' })
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Toolbar)))
      const png = buttonByText(dom.window.document, '导出纹理 PNG')
      const glb = buttonByText(dom.window.document, '导出 GLB')

      await act(async () => png.click())
      expect(png.textContent).toContain('导出中')
      expect(png.getAttribute('aria-busy')).toBe('true')
      expect(png.disabled).toBe(true)
      expect(glb.disabled).toBe(true)

      await act(async () => { finish(); await Promise.resolve() })
      expect(buttonByText(dom.window.document, '导出纹理 PNG').disabled).toBe(false)
    })
  })

  it('keeps the toolbar title single-line while assigning shrink to the optional model name', async () => {
    useModelStore.setState({ modelName: '10_treatment_serum_dropper.glb' })
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Toolbar)))
      const brand = dom.window.document.querySelector<HTMLElement>('.brand')!
      const title = brand.children[1] as HTMLElement
      const modelName = dom.window.document.querySelector<HTMLElement>('.model-name')!
      const fixedGroups = [...dom.window.document.querySelectorAll<HTMLElement>('.toolbar-group, .toolbar-view-modes')]
      expect(dom.window.getComputedStyle(brand).whiteSpace).toBe('nowrap')
      for (const group of fixedGroups) expect(dom.window.getComputedStyle(group).flexShrink).toBe('0')
      expect(dom.window.getComputedStyle(brand).minWidth).toBe('0')
      expect(dom.window.getComputedStyle(brand).flexShrink).toBe('1')
      expect(dom.window.getComputedStyle(title).flexShrink).toBe('0')
      expect(dom.window.getComputedStyle(modelName).minWidth).toBe('0')
      expect(dom.window.getComputedStyle(modelName).flexShrink).toBe('1')
    })
  })

  it('uses semantic badge surfaces and preserves a two-pixel focused active-swatch gap on a rendered inspector control', async () => {
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Fragment, null,
        createElement('span', { className: 'tree-badge' }, '贴标'),
        createElement('span', { className: 'tree-badge craft' }, '烫金'),
        createElement(TextInspector, { area, layer: textLayer, patch: vi.fn(), commitUploadedFont: vi.fn() }),
      )))
      const selectedBadge = dom.window.document.querySelector<HTMLElement>('.tree-badge:not(.craft)')!
      const warningBadge = dom.window.document.querySelector<HTMLElement>('.tree-badge.craft')!
      expect(dom.window.getComputedStyle(selectedBadge).backgroundColor).toBe('var(--color-selected)')
      expect(dom.window.getComputedStyle(warningBadge).backgroundColor).toBe('var(--color-warning-selected)')

      const activeSwatch = dom.window.document.querySelector<HTMLButtonElement>('.swatch.active')!
      activeSwatch.focus()
      expect(activeSwatch.matches(':focus-visible')).toBe(true)
      expect(dom.window.getComputedStyle(activeSwatch).outlineOffset).toBe('2px')
    })
  })
})

describe('Task 9 Fix Round 2 essential text contrast', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState(useModelStore.getInitialState(), true)
  })

  it('renders navigation, area selection, category actions, and destructive explanation at secondary contrast', async () => {
    const populatedArea = { ...area, layers: [textLayer] }
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Fragment, null,
        createElement(EditorSidebar),
        createElement(ElementLibrary),
        createElement(AreaDeleteConfirmation, { area: populatedArea, onCancel: vi.fn(), onConfirm: vi.fn() }),
      )))

      const inactiveWorkspaceTab = dom.window.document.querySelector<HTMLElement>('.workspace-tab:not(.active)')!
      const areaLabel = dom.window.document.querySelector<HTMLElement>('.area-select-label')!
      const category = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.element-category')].find((item) => item.textContent === '文字')!
      const destructiveExplanation = dom.window.document.querySelector<HTMLElement>('#area-delete-description')!
      for (const element of [inactiveWorkspaceTab, areaLabel, category, destructiveExplanation]) {
        expect(dom.window.getComputedStyle(element).color, element.className).toBe('var(--color-text-secondary)')
        const computedSize = dom.window.getComputedStyle(element).fontSize
        const effectiveSize = computedSize === 'inherit'
          ? Number.parseFloat(dom.window.getComputedStyle(dom.window.document.documentElement).fontSize)
          : Number.parseFloat(computedSize)
        expect(effectiveSize, element.className).toBeGreaterThanOrEqual(11)
      }
    })
  })

  it('renders real inspector form labels, generic help, and font warnings at readable secondary contrast', async () => {
    const customName = 'Retail Display Sans'
    const customArea = {
      ...area,
      fonts: [{ name: customName, dataUrl: 'data:font/woff2;base64,Rk9OVA==' }],
    }
    const customLayer = { ...textLayer, fontFamily: uploadedFontId(customName) }
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Fragment, null,
        createElement(TextInspector, { area: customArea, layer: customLayer, patch: vi.fn(), commitUploadedFont: vi.fn() }),
        createElement(AreaInspector, { area, patchArea: vi.fn() }),
      )))

      const formLabel = dom.window.document.querySelector<HTMLElement>('.props label')!
      const help = dom.window.document.querySelector<HTMLElement>('.hint')!
      const warning = dom.window.document.querySelector<HTMLElement>('.font-variant-note')!
      expect(warning.textContent).toContain('不合成粗体或斜体资源')
      for (const element of [formLabel, help, warning]) {
        expect(dom.window.getComputedStyle(element).color, element.className).toBe('var(--color-text-secondary)')
        expect(Number.parseFloat(dom.window.getComputedStyle(element).fontSize), element.className).toBeGreaterThanOrEqual(element === help ? 12 : 11)
      }
    })
  })

  it('renders Inspector empty and locked guidance with readable secondary text', async () => {
    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Inspector)))
      const empty = dom.window.document.querySelector<HTMLElement>('.inspector-empty-content')!
      const emptyHelp = empty.querySelector<HTMLElement>('p')!
      expect(dom.window.getComputedStyle(empty).color).toBe('var(--color-text-secondary)')
      expect(Number.parseFloat(dom.window.getComputedStyle(emptyHelp).fontSize)).toBeGreaterThanOrEqual(12)

      const lockedLayer = { ...textLayer, locked: true }
      const lockedArea = { ...area, layers: [lockedLayer] }
      await act(async () => useLabelStore.setState({
        areas: [lockedArea], activeAreaId: lockedArea.id, activeArea: lockedArea,
        meshIndex: lockedArea.meshIndex, nodeName: lockedArea.nodeName, selectedLayerIds: [lockedLayer.id],
      }))

      const locked = dom.window.document.querySelector<HTMLElement>('.inspector-locked-state')!
      const lockedHelp = locked.querySelector<HTMLElement>('p')!
      const visibilityLabel = locked.querySelector<HTMLElement>('.inline-toggle')!
      for (const element of [locked, visibilityLabel]) expect(dom.window.getComputedStyle(element).color).toBe('var(--color-text-secondary)')
      expect(Number.parseFloat(dom.window.getComputedStyle(lockedHelp).fontSize)).toBeGreaterThanOrEqual(12)
    })
  })
})

describe('Task 9 Fix Round 3 meaningful count contrast', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState(useModelStore.getInitialState(), true)
  })

  it('renders real element, layer, and selected counts at readable secondary contrast', async () => {
    const populatedArea = { ...area, layers: [textLayer] }
    useLabelStore.setState({
      areas: [populatedArea], activeAreaId: populatedArea.id, activeArea: populatedArea,
      meshIndex: populatedArea.meshIndex, nodeName: populatedArea.nodeName, selectedLayerIds: [textLayer.id],
    })

    await withMountedDom(async (dom, root) => {
      await act(async () => root.render(createElement(Fragment, null,
        createElement(ElementLibrary),
        createElement(LabelWorkspace),
      )))

      const elementCount = dom.window.document.querySelector<HTMLElement>('.element-library > .sidebar-section-head .sidebar-count')!
      const layerCount = dom.window.document.querySelector<HTMLElement>('.label-workspace-actions .sidebar-count')!
      const selectedCount = dom.window.document.querySelector<HTMLElement>('.sidebar-selection-count')!
      expect(elementCount.textContent).toMatch(/^\d+$/)
      expect(layerCount.textContent).toBe('1 图层')
      expect(selectedCount.textContent).toBe('已选 1')
      for (const element of [elementCount, layerCount, selectedCount]) {
        expect(dom.window.getComputedStyle(element).color, element.textContent ?? '').toBe('var(--color-text-secondary)')
        expect(Number.parseFloat(dom.window.getComputedStyle(element).fontSize), element.textContent ?? '').toBeGreaterThanOrEqual(11)
      }
    })
  })
})
