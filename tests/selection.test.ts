import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alignLayers, applyLayerTransforms, commitLayerGesture, distributeLayers, nextLayerSelection, nudgeLayers } from '../src/label/selection'
import { duplicateUnlockedLayer, moveUnlockedLayer, patchUnlockedLayer, removeUnlockedLayer, reorderUnlockedLayer } from '../src/label/layerMutations'
import { installShortcuts } from '../src/app/actions'
import { useLabelStore } from '../src/state/stores'
import type { LabelAreaConfig, LabelLayer, ShapeLayer } from '../src/label/types'

function shape(id: string, x: number, y: number, locked = false): ShapeLayer {
  return {
    id,
    kind: 'shape',
    shape: 'rectangle',
    geometry: {},
    width: 40,
    height: 20,
    fill: '#000000',
    stroke: '#000000',
    strokeWidth: 0,
    cornerRadius: 0,
    x,
    y,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked,
    zIndex: 0,
    craft: [],
  }
}

function byId(layers: LabelLayer[], id: string): LabelLayer {
  const layer = layers.find((item) => item.id === id)
  if (!layer) throw new Error(`Missing layer ${id}`)
  return layer
}

function area(id = 'area-a', layers: LabelLayer[] = [shape('a', 10, 20), shape('locked', 40, 50, true), shape('b', 70, 80)]): LabelAreaConfig {
  return {
    id,
    name: id,
    meshIndex: 0,
    nodeName: id,
    remap: {
      mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 400, height: 300, aspect: 4 / 3 },
    layers,
    globalCraft: { craft: [] },
    fonts: [],
    referenceVisible: false,
    undoStack: [],
    redoStack: [],
  }
}

function gestureLayers(): LabelLayer[] {
  const image: LabelLayer = {
    id: 'image', kind: 'image', src: 'data:image/png;base64,AA==', naturalWidth: 60, naturalHeight: 30,
    width: 60, height: 30, x: 15, y: 25, rotation: 0, opacity: 1, visible: true,
    locked: false, zIndex: 1, craft: [],
  }
  const horizontal: LabelLayer = {
    id: 'horizontal', kind: 'text', text: 'H', fontFamily: 'font', fontSize: 20, fontWeight: 400,
    letterSpacing: 2, lineHeight: 1.2, color: '#000000', align: 'center', italic: false,
    direction: 'horizontal', x: 20, y: 30, rotation: 5, opacity: 1, visible: true, locked: false,
    zIndex: 2, craft: [],
  }
  const vertical: LabelLayer = {
    ...horizontal, id: 'vertical', text: 'V', direction: 'vertical', fontSize: 30, letterSpacing: 1,
    x: 25, y: 35, rotation: 10, zIndex: 3,
  }
  return [shape('shape', 10, 20), image, horizontal, vertical, { ...shape('locked', 40, 50, true), zIndex: 4 }]
}

function identityGestureSnapshots(): Parameters<typeof commitLayerGesture>[1] {
  return [
    { id: 'shape', x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    { id: 'image', x: 15, y: 25, rotation: 0, scaleX: 1, scaleY: 1 },
    { id: 'horizontal', x: 20, y: 30, rotation: 5, scaleX: 1, scaleY: 1 },
    { id: 'vertical', x: 25, y: 35, rotation: 100, scaleX: 1, scaleY: 1 },
    { id: 'locked', x: 0, y: 0, rotation: 90, scaleX: 3, scaleY: 3 },
    { id: 'missing', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  ]
}

describe('selection event reducer', () => {
  it('plain click replaces the current selection, including with a locked layer', () => {
    expect(nextLayerSelection(['a', 'b'], 'locked', false)).toEqual(['locked'])
  })

  it('Shift-click toggles the clicked id without disturbing the other selected ids', () => {
    expect(nextLayerSelection(['a', 'locked'], 'b', true)).toEqual(['a', 'locked', 'b'])
    expect(nextLayerSelection(['a', 'locked', 'b'], 'locked', true)).toEqual(['a', 'b'])
  })

  it('empty-canvas selection clears even when Shift is held', () => {
    expect(nextLayerSelection(['a', 'locked'], null, true)).toEqual([])
  })

  it('reduces rapid events from the latest selection rather than a stale render snapshot', () => {
    const afterFirstShift = nextLayerSelection(['a'], 'b', true)
    const afterSecondShift = nextLayerSelection(afterFirstShift, 'locked', true)
    const afterPlainClick = nextLayerSelection(afterSecondShift, 'b', false)

    expect(afterFirstShift).toEqual(['a', 'b'])
    expect(afterSecondShift).toEqual(['a', 'b', 'locked'])
    expect(afterPlainClick).toEqual(['b'])
  })
})

describe('selection geometry helpers', () => {
  it('aligns selected layers to the hand-derived left coordinate without changing unselected references', () => {
    const layers: LabelLayer[] = [shape('a', 40, 20), shape('b', 100, 70), shape('c', 190, 130)]

    const next = alignLayers(layers, ['a', 'b'], 'left')

    expect(byId(next, 'a').x).toBe(40)
    expect(byId(next, 'b').x).toBe(40)
    expect(byId(next, 'c')).toBe(layers[2])
  })

  it('distributes three layers by horizontal centers while retaining array order', () => {
    const layers: LabelLayer[] = [shape('right', 100, 10), shape('left', 10, 20), shape('middle', 70, 30)]

    const next = distributeLayers(layers, ['right', 'left', 'middle'], 'horizontal')

    expect(next.map((layer) => layer.id)).toEqual(['right', 'left', 'middle'])
    expect(byId(next, 'left').x).toBe(10)
    expect(byId(next, 'middle').x).toBe(55)
    expect(byId(next, 'right').x).toBe(100)
  })

  it('does not align, distribute, or nudge locked selected layers', () => {
    const locked = shape('locked', 100, 100, true)
    const layers: LabelLayer[] = [shape('a', 10, 20), locked, shape('b', 70, 80), shape('outside', 200, 200)]

    const aligned = alignLayers(layers, ['a', 'locked', 'b'], 'bottom')
    const distributed = distributeLayers(layers, ['a', 'locked', 'b'], 'vertical')
    const nudged = nudgeLayers(layers, ['a', 'locked'], 10, -4)

    expect(byId(aligned, 'a').y).toBe(80)
    expect(byId(aligned, 'b').y).toBe(80)
    expect(byId(aligned, 'locked')).toBe(locked)
    expect(distributed).toBe(layers)
    expect(byId(nudged, 'a')).toMatchObject({ x: 20, y: 16 })
    expect(byId(nudged, 'locked')).toBe(locked)
    expect(byId(nudged, 'outside')).toBe(layers[3])
  })

  it('persists one group transform for shapes and vertical text while preserving locked references', () => {
    const text: LabelLayer = {
      id: 'text', kind: 'text', text: 'A', fontFamily: 'font', fontSize: 20, fontWeight: 400,
      letterSpacing: 2, lineHeight: 1.2, color: '#000000', align: 'center', italic: false,
      direction: 'vertical', x: 30, y: 40, rotation: 5, opacity: 1, visible: true, locked: false,
      zIndex: 1, craft: [],
    }
    const locked = shape('locked', 100, 120, true)
    const layers: LabelLayer[] = [shape('shape', 10, 20), text, locked]

    const next = applyLayerTransforms(layers, [
      { id: 'shape', x: 20, y: 30, rotation: 15, scaleX: 2, scaleY: 0.5 },
      { id: 'text', x: 45, y: 60, rotation: 110, scaleX: 1.5, scaleY: 1.5 },
      { id: 'locked', x: 0, y: 0, rotation: 90, scaleX: 3, scaleY: 3 },
    ])

    expect(byId(next, 'shape')).toMatchObject({ x: 20, y: 30, rotation: 15, width: 80, height: 10 })
    expect(byId(next, 'text')).toMatchObject({ x: 45, y: 60, rotation: 20, fontSize: 30, letterSpacing: 3 })
    expect(byId(next, 'locked')).toBe(locked)
  })

  it('resizes a text box horizontally without flattening the glyphs', () => {
    const text: LabelLayer = {
      id: 'text', kind: 'text', text: 'Perfume label', width: 200, fontFamily: 'font', fontSize: 20, fontWeight: 400,
      letterSpacing: 2, lineHeight: 1.2, color: '#000000', align: 'center', italic: false,
      x: 30, y: 40, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [],
    }

    const resized = applyLayerTransforms([text], [
      { id: 'text', x: 30, y: 40, rotation: 0, scaleX: 0.5, scaleY: 1, baseWidth: 200 },
    ])

    expect(resized[0]).toMatchObject({ width: 100, fontSize: 20, letterSpacing: 2 })
  })

  it('ignores floating-point scale noise from a horizontal-only text resize', () => {
    const text: LabelLayer = {
      id: 'text', kind: 'text', text: 'Perfume label', width: 200, fontFamily: 'font', fontSize: 20, fontWeight: 400,
      letterSpacing: 2, lineHeight: 1.2, color: '#000000', align: 'center', italic: false,
      x: 30, y: 40, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [],
    }

    const resized = applyLayerTransforms([text], [
      { id: 'text', x: 30, y: 40, rotation: 0, scaleX: 1.5, scaleY: 0.9999999999999998, baseWidth: 200 },
    ])

    expect(resized[0]).toMatchObject({ width: 300, fontSize: 20, letterSpacing: 2 })
  })

  it('uses corner resizing to change both the text box width and font scale', () => {
    const text: LabelLayer = {
      id: 'text', kind: 'text', text: 'Perfume label', width: 200, fontFamily: 'font', fontSize: 20, fontWeight: 400,
      letterSpacing: 2, lineHeight: 1.2, color: '#000000', align: 'center', italic: false,
      x: 30, y: 40, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [],
    }

    const resized = applyLayerTransforms([text], [
      { id: 'text', x: 30, y: 40, rotation: 0, scaleX: 1.5, scaleY: 2, baseWidth: 200 },
    ])

    expect(resized[0]).toMatchObject({ width: 300, fontSize: 40, letterSpacing: 4 })
  })
})

describe('locked-safe legacy layer mutations', () => {
  it('rejects property and craft patches for locked layers at the mutation boundary', () => {
    const locked = shape('locked', 40, 50, true)
    const layers: LabelLayer[] = [shape('a', 10, 20), locked]

    expect(patchUnlockedLayer(layers, 'locked', { opacity: 0.2 })).toBe(layers)
    expect(patchUnlockedLayer(layers, 'locked', { craft: [{ type: 'foil', params: {} }] })).toBe(layers)
    expect(patchUnlockedLayer(layers, 'a', { opacity: 0.2 })).not.toBe(layers)
    expect(byId(patchUnlockedLayer(layers, 'a', { opacity: 0.2 }), 'a').opacity).toBe(0.2)
    expect(byId(layers, 'locked')).toBe(locked)
  })

  it('rejects delete and duplicate for locked layers while preserving unlocked behavior', () => {
    const locked = shape('locked', 40, 50, true)
    const layers: LabelLayer[] = [shape('a', 10, 20), locked]

    expect(removeUnlockedLayer(layers, 'locked')).toBe(layers)
    expect(duplicateUnlockedLayer(layers, 'locked', 'locked-copy')).toBe(layers)

    const removed = removeUnlockedLayer(layers, 'a')
    const duplicated = duplicateUnlockedLayer(layers, 'a', 'a-copy')
    expect(removed.map((layer) => layer.id)).toEqual(['locked'])
    expect(duplicated.map((layer) => layer.id)).toEqual(['a', 'locked', 'a-copy'])
    expect(byId(duplicated, 'a-copy')).toMatchObject({ x: 40, y: 50, zIndex: 1 })
    expect(byId(duplicated, 'locked')).toBe(locked)
  })

  it('does not move a locked layer or move an unlocked layer across a locked neighbor', () => {
    const a = shape('a', 10, 20)
    const locked = { ...shape('locked', 40, 50, true), zIndex: 1 }
    const b = { ...shape('b', 70, 80), zIndex: 2 }
    const c = { ...shape('c', 100, 110), zIndex: 3 }
    const layers: LabelLayer[] = [a, locked, b, c]

    expect(moveUnlockedLayer(layers, 'locked', 1)).toBe(layers)
    expect(moveUnlockedLayer(layers, 'a', 1)).toBe(layers)
    expect(moveUnlockedLayer(layers, 'b', -1)).toBe(layers)

    const moved = moveUnlockedLayer(layers, 'b', 1)
    expect(byId(moved, 'b').zIndex).toBe(3)
    expect(byId(moved, 'c').zIndex).toBe(2)
    expect(byId(moved, 'locked')).toBe(locked)
  })

  it('reorders unlocked rows in visual top-to-bottom order with one deterministic z-index update', () => {
    const layers: LabelLayer[] = [
      { ...shape('bottom', 0, 0), zIndex: 0 },
      { ...shape('middle', 0, 0), zIndex: 1 },
      { ...shape('top', 0, 0), zIndex: 2 },
    ]

    const reordered = reorderUnlockedLayer(layers, 'bottom', 'top', 'before')

    expect([...reordered].sort((a, b) => b.zIndex - a.zIndex).map((layer) => layer.id)).toEqual(['bottom', 'top', 'middle'])
  })

  it('does not allow a dragged layer to cross a locked layer barrier', () => {
    const locked = { ...shape('locked', 0, 0, true), zIndex: 1 }
    const layers: LabelLayer[] = [
      { ...shape('bottom', 0, 0), zIndex: 0 },
      locked,
      { ...shape('top', 0, 0), zIndex: 2 },
    ]

    expect(reorderUnlockedLayer(layers, 'bottom', 'top', 'before')).toBe(layers)
    expect(reorderUnlockedLayer(layers, 'locked', 'top', 'before')).toBe(layers)
  })
})

describe('label selection store', () => {
  beforeEach(() => useLabelStore.getState().clearAll())
  afterEach(() => useLabelStore.getState().clearAll())

  it('uses selectedLayerIds as the sole selection source and supports replace, toggle, and clear', () => {
    useLabelStore.getState().addArea(area())

    useLabelStore.getState().selectLayers(['a', 'locked', 'a'])
    expect(useLabelStore.getState().selectedLayerIds).toEqual(['a', 'locked'])
    expect('selectedLayerId' in useLabelStore.getState()).toBe(false)

    useLabelStore.getState().toggleLayerSelection('a')
    useLabelStore.getState().toggleLayerSelection('b')
    expect(useLabelStore.getState().selectedLayerIds).toEqual(['locked', 'b'])

    useLabelStore.getState().clearLayerSelection()
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
  })

  it('clears selection when changing areas and atomically removes deleted ids', () => {
    useLabelStore.getState().addArea(area('area-a'))
    useLabelStore.getState().selectLayers(['a', 'locked'])

    useLabelStore.getState().applyAreaOp('area-a', (current) => ({
      ...current,
      layers: current.layers.filter((layer) => layer.id !== 'a'),
    }))
    expect(useLabelStore.getState().selectedLayerIds).toEqual(['locked'])

    useLabelStore.getState().addArea(area('area-b', [shape('other', 1, 2)]))
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
    useLabelStore.getState().selectLayers(['other'])
    useLabelStore.getState().activateArea('area-a')
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
  })

  it('does not create history when a locked-safe mutation gateway update is rejected', () => {
    useLabelStore.getState().addArea(area())

    useLabelStore.getState().applyAreaOp('area-a', (current) => {
      const layers = patchUnlockedLayer(current.layers, 'locked', { opacity: 0.2 })
      return layers === current.layers ? current : { ...current, layers }
    })

    expect(byId(useLabelStore.getState().activeArea!.layers, 'locked').opacity).toBe(1)
    expect(useLabelStore.getState().activeArea!.undoStack).toHaveLength(0)
  })

  it('clears ids from the removed active area when removeArea activates a fallback', () => {
    useLabelStore.getState().addArea(area('area-a'))
    useLabelStore.getState().addArea(area('area-b', [shape('other', 5, 6)]))
    useLabelStore.getState().selectLayers(['other'])

    useLabelStore.getState().removeArea('area-b')

    expect(useLabelStore.getState().activeAreaId).toBe('area-a')
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
  })

  it('cleans selection when undo removes a layer and keeps it valid when redo restores the layer', () => {
    useLabelStore.getState().addArea(area())
    const added = shape('added', 120, 140)
    useLabelStore.getState().applyAreaOp('area-a', (current) => ({ ...current, layers: [...current.layers, added] }))
    useLabelStore.getState().selectLayers(['added'])

    useLabelStore.getState().undo()
    expect(useLabelStore.getState().activeArea!.layers.some((layer) => layer.id === 'added')).toBe(false)
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])

    useLabelStore.getState().redo()
    expect(useLabelStore.getState().activeArea!.layers.some((layer) => layer.id === 'added')).toBe(true)
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])

    useLabelStore.getState().selectLayers(['added'])
    useLabelStore.getState().undo()
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
  })

  it('commits shape, image, horizontal-text, and vertical-text node snapshots as one history entry', () => {
    const layers = gestureLayers()
    const locked = byId(layers, 'locked')
    useLabelStore.getState().addArea(area('area-a', layers))

    const committed = commitLayerGesture('area-a', [
      { id: 'shape', x: 20, y: 30, rotation: 15, scaleX: 2, scaleY: 0.5 },
      { id: 'image', x: 35, y: 45, rotation: 25, scaleX: 0.5, scaleY: 2 },
      { id: 'horizontal', x: 50, y: 60, rotation: 35, scaleX: 1.5, scaleY: 1.5 },
      { id: 'vertical', x: 70, y: 80, rotation: 130, scaleX: 0.5, scaleY: 0.5 },
      { id: 'locked', x: 0, y: 0, rotation: 90, scaleX: 3, scaleY: 3 },
    ], useLabelStore.getState().applyAreaOp)

    const state = useLabelStore.getState()
    expect(committed).toBe(true)
    expect(byId(state.activeArea!.layers, 'shape')).toMatchObject({ x: 20, y: 30, rotation: 15, width: 80, height: 10 })
    expect(byId(state.activeArea!.layers, 'image')).toMatchObject({ x: 35, y: 45, rotation: 25, width: 30, height: 60 })
    expect(byId(state.activeArea!.layers, 'horizontal')).toMatchObject({ x: 50, y: 60, rotation: 35, fontSize: 30, letterSpacing: 3 })
    expect(byId(state.activeArea!.layers, 'vertical')).toMatchObject({ x: 70, y: 80, rotation: 40, fontSize: 15, letterSpacing: 0.5 })
    expect(byId(state.activeArea!.layers, 'locked')).toBe(locked)
    expect(state.activeArea!.undoStack).toHaveLength(1)
  })

  it('treats identity snapshots for every layer kind as one all-no-op gesture', () => {
    const layers = gestureLayers()
    useLabelStore.getState().addArea(area('area-a', layers))
    const beforeArea = useLabelStore.getState().activeArea!
    const beforeLayers = beforeArea.layers
    const beforeById = new Map(beforeLayers.map((layer) => [layer.id, layer]))

    const committed = commitLayerGesture('area-a', identityGestureSnapshots(), useLabelStore.getState().applyAreaOp)

    const after = useLabelStore.getState().activeArea!
    expect(committed).toBe(false)
    expect(after).toBe(beforeArea)
    expect(after.layers).toBe(beforeLayers)
    expect(byId(after.layers, 'shape')).toBe(beforeById.get('shape'))
    expect(byId(after.layers, 'image')).toBe(beforeById.get('image'))
    expect(byId(after.layers, 'horizontal')).toBe(beforeById.get('horizontal'))
    expect(byId(after.layers, 'vertical')).toBe(beforeById.get('vertical'))
    expect(byId(after.layers, 'locked')).toBe(beforeById.get('locked'))
    expect(after.undoStack).toHaveLength(0)
  })

  it('commits one changed node while preserving all identity-node references', () => {
    const layers = gestureLayers()
    useLabelStore.getState().addArea(area('area-a', layers))
    const beforeLayers = useLabelStore.getState().activeArea!.layers
    const beforeById = new Map(beforeLayers.map((layer) => [layer.id, layer]))
    const transforms = identityGestureSnapshots().map((snapshot) => (
      snapshot.id === 'shape' ? { ...snapshot, x: 11 } : snapshot
    ))

    const committed = commitLayerGesture('area-a', transforms, useLabelStore.getState().applyAreaOp)

    const after = useLabelStore.getState().activeArea!
    expect(committed).toBe(true)
    expect(after.layers).not.toBe(beforeLayers)
    expect(byId(after.layers, 'shape')).not.toBe(beforeById.get('shape'))
    expect(byId(after.layers, 'shape').x).toBe(11)
    expect(byId(after.layers, 'image')).toBe(beforeById.get('image'))
    expect(byId(after.layers, 'horizontal')).toBe(beforeById.get('horizontal'))
    expect(byId(after.layers, 'vertical')).toBe(beforeById.get('vertical'))
    expect(byId(after.layers, 'locked')).toBe(beforeById.get('locked'))
    expect(after.undoStack).toHaveLength(1)
  })
})

describe('multi-selection shortcuts', () => {
  let shortcut: ((event: KeyboardEvent) => void) | null = null
  let uninstall: (() => void) | null = null
  const originalWindow = globalThis.window

  beforeEach(() => {
    useLabelStore.getState().clearAll()
    useLabelStore.getState().addArea(area())
    const fakeWindow = {
      addEventListener(type: string, listener: EventListener): void {
        if (type === 'keydown') shortcut = listener as (event: KeyboardEvent) => void
      },
      removeEventListener(type: string, listener: EventListener): void {
        if (type === 'keydown' && shortcut === listener) shortcut = null
      },
    }
    globalThis.window = fakeWindow as unknown as Window & typeof globalThis
    uninstall = installShortcuts()
  })

  afterEach(() => {
    uninstall?.()
    uninstall = null
    shortcut = null
    useLabelStore.getState().clearAll()
    globalThis.window = originalWindow
  })

  function key(key: string, options: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; target?: unknown } = {}): ReturnType<typeof vi.fn> {
    const preventDefault = vi.fn()
    shortcut?.({ key, target: null, preventDefault, ctrlKey: false, metaKey: false, shiftKey: false, ...options } as unknown as KeyboardEvent)
    return preventDefault
  }

  it('nudges all selected unlocked layers by one or ten canvas pixels in one history entry', () => {
    useLabelStore.getState().selectLayers(['a', 'locked', 'b'])

    expect(key('ArrowRight')).toHaveBeenCalledOnce()
    expect(byId(useLabelStore.getState().activeArea!.layers, 'a')).toMatchObject({ x: 11, y: 20 })
    expect(byId(useLabelStore.getState().activeArea!.layers, 'b')).toMatchObject({ x: 71, y: 80 })
    expect(byId(useLabelStore.getState().activeArea!.layers, 'locked')).toMatchObject({ x: 40, y: 50 })
    expect(useLabelStore.getState().activeArea!.undoStack).toHaveLength(1)

    expect(key('ArrowUp', { shiftKey: true })).toHaveBeenCalledOnce()
    expect(byId(useLabelStore.getState().activeArea!.layers, 'a')).toMatchObject({ x: 11, y: 10 })
    expect(byId(useLabelStore.getState().activeArea!.layers, 'b')).toMatchObject({ x: 71, y: 70 })
    expect(useLabelStore.getState().activeArea!.undoStack).toHaveLength(2)
  })

  it('does not treat modified arrow keys as canvas nudges', () => {
    useLabelStore.getState().selectLayers(['a'])

    expect(key('ArrowRight', { ctrlKey: true })).not.toHaveBeenCalled()
    expect(byId(useLabelStore.getState().activeArea!.layers, 'a')).toMatchObject({ x: 10, y: 20 })
    expect(useLabelStore.getState().activeArea!.undoStack).toHaveLength(0)
  })

  it('ignores arrow, delete, and duplicate shortcuts from buttons and composite editor controls', () => {
    useLabelStore.getState().selectLayers(['a'])
    const button = { tagName: 'BUTTON', isContentEditable: false, closest: () => null }
    const tabControl = {
      tagName: 'SPAN',
      isContentEditable: false,
      closest: (selector: string) => selector.includes('[role="tablist"]') ? {} : null,
    }

    expect(key('ArrowRight', { target: button })).not.toHaveBeenCalled()
    expect(key('Delete', { target: button })).not.toHaveBeenCalled()
    expect(key('d', { metaKey: true, target: button })).not.toHaveBeenCalled()
    expect(key('ArrowLeft', { target: tabControl })).not.toHaveBeenCalled()
    expect(byId(useLabelStore.getState().activeArea!.layers, 'a')).toMatchObject({ x: 10, y: 20 })
    expect(useLabelStore.getState().activeArea!.layers).toHaveLength(3)
    expect(useLabelStore.getState().activeArea!.undoStack).toHaveLength(0)
  })

  it('duplicates every selected unlocked layer with unique ids and selects only the copies', () => {
    useLabelStore.getState().selectLayers(['a', 'locked', 'b'])

    expect(key('d', { metaKey: true })).toHaveBeenCalledOnce()

    const state = useLabelStore.getState()
    const copies = state.activeArea!.layers.filter((layer) => !['a', 'locked', 'b'].includes(layer.id))
    expect(copies).toHaveLength(2)
    expect(new Set(copies.map((layer) => layer.id)).size).toBe(2)
    expect(copies.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 40, y: 50 }, { x: 100, y: 110 }])
    expect(state.selectedLayerIds).toEqual(copies.map((layer) => layer.id))
    expect(state.activeArea!.undoStack).toHaveLength(1)
  })

  it('deletes every selected unlocked layer while retaining locked selection in one history entry', () => {
    useLabelStore.getState().selectLayers(['a', 'locked', 'b'])

    expect(key('Delete')).toHaveBeenCalledOnce()

    const state = useLabelStore.getState()
    expect(state.activeArea!.layers.map((layer) => layer.id)).toEqual(['locked'])
    expect(state.selectedLayerIds).toEqual(['locked'])
    expect(state.activeArea!.undoStack).toHaveLength(1)
  })
})
