import { beforeEach, describe, expect, it } from 'vitest'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'
import type { GlbAnalysis, LabelAreaConfig } from '../src/label/types'
import { addElementPreset, deleteSelectedLayers, duplicateSelectedLayers, filterElementPresets, getAreaDeleteIntent } from '../src/ui/sidebarActions'

function area(id = 'area-a'): Omit<LabelAreaConfig, 'id' | 'undoStack' | 'redoStack'> & { id?: string } {
  return {
    id,
    name: '正面标签',
    meshIndex: 0,
    nodeName: 'Bottle',
    remap: {
      mode: 'planar',
      axis: [0, 1, 0],
      origin: [0, 0, 0],
      radius: 1,
      wrap: 1,
      offset: 0,
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

const EMPTY_ANALYSIS: GlbAnalysis = {
  parts: [],
  meshToNode: {},
  labelCandidates: [],
  modelName: 'empty.glb',
}

describe('editor workspace tabs', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState(useModelStore.getInitialState(), true)
  })

  it('defaults to the model workspace and allows an explicit label-tab selection', () => {
    expect(useUiStore.getState().workspaceTab).toBe('model')

    useUiStore.getState().setWorkspaceTab('labels')

    expect(useUiStore.getState().workspaceTab).toBe('labels')
  })

  it('switches to labels when an area is created', () => {
    useUiStore.getState().setWorkspaceTab('model')

    useLabelStore.getState().addArea(area())

    expect(useUiStore.getState().workspaceTab).toBe('labels')
  })

  it('switches to labels when an existing area is activated', () => {
    useLabelStore.getState().addArea(area())
    useUiStore.getState().setWorkspaceTab('model')

    useLabelStore.getState().activateArea('area-a')

    expect(useUiStore.getState().workspaceTab).toBe('labels')
  })

  it('selects the model workspace when a model loads without an active area', () => {
    useUiStore.getState().setWorkspaceTab('labels')

    useModelStore.getState().loadModel('empty.glb', new Uint8Array(), EMPTY_ANALYSIS)

    expect(useLabelStore.getState().activeAreaId).toBeNull()
    expect(useUiStore.getState().workspaceTab).toBe('model')
  })

  it('returns to the model workspace when the last area is removed', () => {
    useLabelStore.getState().addArea(area())

    useLabelStore.getState().removeArea('area-a')

    expect(useUiStore.getState().workspaceTab).toBe('model')
  })

  it('returns to the model workspace when the active area is cleared', () => {
    useLabelStore.getState().addArea(area())

    useLabelStore.getState().activateArea(null)

    expect(useUiStore.getState().workspaceTab).toBe('model')
  })
})

describe('central editor view mode', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
  })

  it('defaults an active editing area to the 2D design view', () => {
    useLabelStore.getState().addArea(area())

    expect(useUiStore.getState().editorViewMode).toBe('2d')
  })

  it('preserves the exact ordered layer selection across every view-mode change', () => {
    useLabelStore.getState().addArea(area())
    const firstId = addElementPreset('basic-circle')!
    const secondId = addElementPreset('text-title')!
    useLabelStore.getState().selectLayers([secondId, firstId])
    const selectionBefore = useLabelStore.getState().selectedLayerIds

    for (const mode of ['split', '3d', '2d'] as const) {
      useUiStore.getState().setEditorViewMode(mode)
      expect(useUiStore.getState().editorViewMode).toBe(mode)
      expect(useLabelStore.getState().selectedLayerIds).toBe(selectionBefore)
      expect(useLabelStore.getState().selectedLayerIds).toEqual([secondId, firstId])
    }
  })

  it('keeps the legacy area-setup mode independent from the central editor mode', () => {
    useUiStore.getState().setMode('design')
    expect(useUiStore.getState().editorViewMode).toBe('2d')

    useUiStore.getState().setEditorViewMode('3d')

    expect(useUiStore.getState().mode).toBe('design')
    expect(useUiStore.getState().editorViewMode).toBe('3d')
  })
})

describe('inspector preferences', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
  })

  it('toggles font favorites without duplicates', () => {
    expect(useUiStore.getState().favoriteFontIds).toEqual([])

    useUiStore.getState().toggleFavoriteFont('outfit')
    useUiStore.getState().toggleFavoriteFont('outfit')
    useUiStore.getState().toggleFavoriteFont('outfit')

    expect(useUiStore.getState().favoriteFontIds).toEqual(['outfit'])
  })

  it('deduplicates recent fonts and retains only the latest eight', () => {
    for (let index = 0; index < 10; index += 1) {
      useUiStore.getState().rememberRecentFont(`font-${index}`)
    }
    useUiStore.getState().rememberRecentFont('font-5')

    expect(useUiStore.getState().recentFontIds).toEqual([
      'font-5', 'font-9', 'font-8', 'font-7', 'font-6', 'font-4', 'font-3', 'font-2',
    ])
  })

  it('persists section state per object type without changing label undo history', () => {
    useLabelStore.getState().addArea(area())
    const undoBefore = useLabelStore.getState().activeArea?.undoStack.length

    useUiStore.getState().setInspectorSectionOpen('text', 'typography', false)
    useUiStore.getState().setInspectorSectionOpen('shape', 'geometry', false)

    expect(useUiStore.getState().inspectorSections).toMatchObject({
      text: { typography: false },
      shape: { geometry: false },
    })
    expect(useLabelStore.getState().activeArea?.undoStack.length).toBe(undoBefore)
  })
})

describe('sidebar actions', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
  })

  it('filters the element catalog by category and trimmed case-insensitive search', () => {
    expect(filterElementPresets('label', '  PRICE  ').map((preset) => preset.id)).toEqual(['label-price-tag'])
    expect(filterElementPresets('all', '')).toHaveLength(32)
  })

  it('adds a preset through one undoable area operation and selects the new layer', () => {
    useLabelStore.getState().addArea(area())

    const layerId = addElementPreset('basic-circle')
    const state = useLabelStore.getState()

    expect(layerId).toBeTruthy()
    expect(state.activeArea?.layers).toHaveLength(1)
    expect(state.activeArea?.layers[0]).toMatchObject({ id: layerId, kind: 'shape', shape: 'ellipse' })
    expect(state.activeArea?.undoStack).toHaveLength(1)
    expect(state.selectedLayerIds).toEqual([layerId])
  })

  it('does not add or select an element when no area is active', () => {
    expect(addElementPreset('text-title')).toBeNull()
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
  })

  it('requires confirmation only when the target area contains design layers', () => {
    useLabelStore.getState().addArea(area())
    const emptyArea = useLabelStore.getState().activeArea!
    addElementPreset('text-title')
    const designedArea = useLabelStore.getState().activeArea!

    expect(getAreaDeleteIntent(emptyArea)).toBe('delete')
    expect(getAreaDeleteIntent(designedArea)).toBe('confirm')
  })

  it('deletes all selected unlocked layers while retaining locked selection', () => {
    useLabelStore.getState().addArea(area())
    const lockedId = addElementPreset('basic-circle')!
    const unlockedId = addElementPreset('text-title')!
    const store = useLabelStore.getState()
    store.applyAreaOp('area-a', (config) => ({
      ...config,
      layers: config.layers.map((layer) => layer.id === lockedId ? { ...layer, locked: true } : layer),
    }))
    useLabelStore.getState().selectLayers([lockedId, unlockedId])

    expect(deleteSelectedLayers()).toBe(1)
    expect(useLabelStore.getState().activeArea?.layers.map((layer) => layer.id)).toEqual([lockedId])
    expect(useLabelStore.getState().selectedLayerIds).toEqual([lockedId])
  })

  it('duplicates all selected unlocked layers and selects only the copies', () => {
    useLabelStore.getState().addArea(area())
    const lockedId = addElementPreset('basic-circle')!
    const unlockedId = addElementPreset('text-title')!
    const store = useLabelStore.getState()
    store.applyAreaOp('area-a', (config) => ({
      ...config,
      layers: config.layers.map((layer) => layer.id === lockedId ? { ...layer, locked: true } : layer),
    }))
    useLabelStore.getState().selectLayers([lockedId, unlockedId])

    const copyIds = duplicateSelectedLayers()

    expect(copyIds).toHaveLength(1)
    expect(useLabelStore.getState().activeArea?.layers).toHaveLength(3)
    expect(useLabelStore.getState().selectedLayerIds).toEqual(copyIds)
    expect(useLabelStore.getState().activeArea?.layers.find((layer) => layer.id === copyIds[0])).toMatchObject({ x: 230, y: 180, locked: false })
  })

  it('rejects image-budget overflow through the mutation gateway and duplication path without partial state', () => {
    const image = (index: number) => ({
      id: `image-${index}`, kind: 'image' as const, src: `data:image/png;base64,${index}`,
      naturalWidth: 1, naturalHeight: 1, width: 1, height: 1,
      x: 10, y: 10, rotation: 0, opacity: 1, visible: true, locked: false,
      zIndex: index, craft: [],
    })
    useLabelStore.getState().addArea({ ...area(), layers: Array.from({ length: 64 }, (_, index) => image(index)) })
    useLabelStore.getState().selectLayers(['image-0'])

    expect(() => duplicateSelectedLayers()).toThrow(/image.*count|image.*layer/i)
    expect(useLabelStore.getState().activeArea?.layers).toHaveLength(64)
    expect(useLabelStore.getState().selectedLayerIds).toEqual(['image-0'])

    expect(() => useLabelStore.getState().applyAreaOp('area-a', (config) => ({
      ...config,
      layers: config.layers.map((layer) => layer.id === 'image-0' ? { ...layer, width: 8193 } : layer),
    }))).toThrow(/rendered|frame|image.*dimension/i)
    expect(useLabelStore.getState().activeArea?.layers[0]).toMatchObject({ width: 1, height: 1 })
  })
})
