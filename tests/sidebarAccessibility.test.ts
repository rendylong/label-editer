import { createElement, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorSidebar, nextWorkspaceTab } from '../src/ui/EditorSidebar'
import { LabelWorkspace, LayerList, AreaDeleteConfirmation } from '../src/ui/LabelWorkspace'
import { ModelHierarchy } from '../src/ui/ModelPartTree'
import { ElementLibrary } from '../src/ui/ElementLibrary'
import { ShapeInspector } from '../src/ui/inspectors/ShapeInspector'
import { createLayerFromPreset } from '../src/label/elementPresets'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'
import type { LabelAreaConfig, PartNode, ShapeLayer } from '../src/label/types'

function area(): Omit<LabelAreaConfig, 'id' | 'undoStack' | 'redoStack'> & { id: string } {
  return {
    id: 'area-a',
    name: '正面标签',
    meshIndex: 0,
    nodeName: 'Bottle',
    remap: {
      mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 400, height: 300, aspect: 4 / 3 },
    layers: [],
    globalCraft: { craft: [] },
    fonts: [],
    referenceVisible: false,
  }
}

const PARTS: PartNode[] = [{
  id: 'root', name: 'Bottle', kind: 'group', visible: true,
  children: [{ id: 'mesh', name: 'Body', kind: 'mesh', meshIndex: 0, material: 'Glass', triangleCount: 3217, visible: true, children: [] }],
}]

function documentFor(element: ReactNode): Document {
  return new JSDOM(`<!doctype html><body>${renderToStaticMarkup(element)}</body>`, { url: 'http://localhost/' }).window.document
}

describe('workspace tab keyboard reducer', () => {
  it.each([
    ['labels', 'ArrowRight', 'model'],
    ['model', 'ArrowRight', 'labels'],
    ['labels', 'ArrowLeft', 'model'],
    ['model', 'ArrowLeft', 'labels'],
    ['model', 'Home', 'labels'],
    ['labels', 'End', 'model'],
  ] as const)('moves from %s with %s to %s', (current, key, expected) => {
    expect(nextWorkspaceTab(current, key)).toBe(expected)
  })

  it('ignores keys outside the tab navigation contract', () => {
    expect(nextWorkspaceTab('labels', 'ArrowDown')).toBeNull()
    expect(nextWorkspaceTab('model', 'Enter')).toBeNull()
  })
})

describe('sidebar rendered accessibility semantics', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState(useModelStore.getInitialState(), true)
  })

  it('keeps both controlled tab panels mounted and hides only the inactive panel', () => {
    const document = documentFor(createElement(EditorSidebar))
    const panels = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]

    expect(panels).toHaveLength(2)
    expect(document.querySelector('#workspace-panel-model')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('#workspace-panel-labels')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('#workspace-tab-model')?.getAttribute('tabindex')).toBe('0')
    expect(document.querySelector('#workspace-tab-labels')?.getAttribute('tabindex')).toBe('-1')
  })

  it('renders layer rows as list items with a dedicated pressed selection button and sibling actions', () => {
    const target: LabelAreaConfig = { ...area(), undoStack: [], redoStack: [] }
    const layer = createLayerFromPreset('basic-circle', target)

    const document = documentFor(createElement(LayerList, {
      layers: [layer],
      selectedLayerIds: [layer.id],
      onSelect: vi.fn(),
      onPatchState: vi.fn(),
      onReorder: vi.fn(),
      onDelete: vi.fn(),
    }))
    const list = document.querySelector('ul.sidebar-layer-list')
    const row = list?.querySelector(':scope > li.sidebar-layer-row')
    const directButtons = row?.querySelectorAll(':scope > button') ?? []

    expect(list).not.toBeNull()
    expect(document.querySelector('[role="listbox"], [role="option"]')).toBeNull()
    expect(row?.querySelector('.layer-selection-button')?.getAttribute('aria-pressed')).toBe('true')
    expect(row?.querySelector('.layer-selection-button')?.getAttribute('aria-label')).toBe('已选择形状椭圆')
    expect(row?.querySelector('button[draggable="true"]')?.getAttribute('aria-label')).toBe('拖动形状椭圆调整层级')
    expect(row?.querySelector('button[aria-label="删除椭圆"]')).not.toBeNull()
    expect(directButtons).toHaveLength(5)
  })

  it('renders the model hierarchy as nested lists with sibling selection and visibility buttons', () => {
    const document = documentFor(createElement(ModelHierarchy, {
      nodes: PARTS,
      selectedPartId: 'mesh',
      hiddenIds: new Set<string>(),
      areas: [],
      onActivate: vi.fn(),
      onToggleVisible: vi.fn(),
    }))
    const rootItem = document.querySelector('ul.model-tree > li.model-tree-item')
    const rootRowButtons = rootItem?.querySelectorAll(':scope > .model-tree-row > button') ?? []

    expect(document.querySelector('[role="tree"], [role="treeitem"]')).toBeNull()
    expect(rootItem?.querySelector(':scope > ul.model-tree-children > li.model-tree-item')).not.toBeNull()
    expect(rootRowButtons).toHaveLength(2)
  })

  it('renders element filters as a labelled pressed-button group rather than tabs', () => {
    const document = documentFor(createElement(ElementLibrary))
    const group = document.querySelector('[role="group"][aria-label="元素分类"]')

    expect(group).not.toBeNull()
    expect(group?.querySelectorAll('button[aria-pressed]')).toHaveLength(7)
    expect(document.querySelector('[role="tablist"], [role="tab"]')).toBeNull()
  })

  it('renders deletion confirmation as an inline non-modal group with status text', () => {
    const target = { ...area(), undoStack: [], redoStack: [] }
    const document = documentFor(createElement(AreaDeleteConfirmation, { area: target, onCancel: vi.fn(), onConfirm: vi.fn() }))

    expect(document.querySelector('[role="group"][aria-label="确认删除贴标区域"]')).not.toBeNull()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('keeps image upload reachable from the current label workspace', () => {
    const target: LabelAreaConfig = {
      ...area(),
      paper: { enabled: false, color: '#ffffff', opacity: 1 },
      undoStack: [],
      redoStack: [],
    }
    useLabelStore.setState({ areas: [target], activeAreaId: target.id, activeArea: target })

    const document = documentFor(createElement(LabelWorkspace))
    const upload = document.querySelector<HTMLInputElement>('input[type="file"][accept=".png,.jpg,.jpeg,.webp"]')

    expect(document.querySelector('button[aria-label="上传图片"]')).not.toBeNull()
    expect(upload).not.toBeNull()
  })

  it('keeps transparent exact in the authoritative field and a valid native picker fallback', () => {
    const target = {
      ...createLayerFromPreset('container-outer-frame', { ...area(), paper: { enabled: false, color: '#ffffff', opacity: 1 }, undoStack: [], redoStack: [] }),
      fill: 'transparent',
    } as ShapeLayer

    const document = documentFor(createElement(ShapeInspector, { layer: target, patch: vi.fn() }))
    const fill = document.querySelector<HTMLInputElement>('input[aria-label="填色颜色"]')
    const picker = document.querySelector<HTMLInputElement>('input[aria-label="填色颜色取色器"]')

    expect(fill?.getAttribute('value')).toBe('transparent')
    expect(fill?.hasAttribute('hidden')).toBe(false)
    expect(fill?.hasAttribute('disabled')).toBe(false)
    expect(picker?.getAttribute('value')).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
