import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFlushableDebouncedBake } from '../src/label/useFlushableDebouncedBake'
import { useLabelStore, useUiStore, type BakeResult } from '../src/state/stores'

function bakeResult(document: Document, version: number): BakeResult {
  const canvas = (): HTMLCanvasElement => {
    const element = document.createElement('canvas')
    element.width = 400
    element.height = 300
    return element
  }
  return {
    color: canvas(),
    metalness: canvas(),
    roughness: canvas(),
    bump: canvas(),
    spec: { width: 400, height: 300, aspect: 4 / 3 },
    version,
  }
}

function BakeOwner({ revision, document }: { revision: number; document: Document }): React.JSX.Element {
  useFlushableDebouncedBake(() => {
    useLabelStore.getState().setBake('area-a', bakeResult(document, revision))
  }, [revision], 300)
  return createElement('div', { 'data-editor-canvas': revision })
}

function BakeCallbackOwner({ revision, onBake }: { revision: number; onBake: (revision: number) => void }): React.JSX.Element {
  useFlushableDebouncedBake(() => onBake(revision), [revision], 300)
  return createElement('div', { 'data-bake-revision': revision })
}

function BakeVisibilityHarness({ visible, revision, onBake }: { visible: boolean; revision: number; onBake: (revision: number) => void }): React.JSX.Element | null {
  return visible ? createElement(BakeCallbackOwner, { revision, onBake }) : null
}

function EditorModeHarness({ revision, document }: { revision: number; document: Document }): React.JSX.Element {
  const mode = useUiStore((state) => state.editorViewMode)
  const bakedVersion = useLabelStore((state) => state.bakeMap['area-a']?.version ?? 0)
  if (mode === '3d') return createElement('div', { 'data-three-dimensional-bake': bakedVersion })
  return createElement(BakeOwner, { revision, document })
}

describe('label bake lifecycle across central view modes', () => {
  let dom: JSDOM
  let root: ReturnType<typeof createRoot>
  let frameSequence: number
  let frames: Map<number, FrameRequestCallback>

  beforeEach(() => {
    vi.useFakeTimers()
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Node', dom.window.Node)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    frameSequence = 0
    frames = new Map()
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = ++frameSequence
      frames.set(id, callback)
      return id
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => {
      frames.delete(id)
    }))
    root = createRoot(dom.window.document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('flushes the latest committed edit into bake state before an immediate 3D switch unmounts the canvas', async () => {
    useLabelStore.getState().setBake('area-a', bakeResult(dom.window.document, 1))
    await act(async () => root.render(createElement(EditorModeHarness, { revision: 1, document: dom.window.document })))

    await act(async () => root.render(createElement(EditorModeHarness, { revision: 2, document: dom.window.document })))
    expect(useLabelStore.getState().bakeMap['area-a']?.version).toBe(1)

    await act(async () => useUiStore.getState().setEditorViewMode('3d'))

    expect(useLabelStore.getState().bakeMap['area-a']?.version).toBe(2)
    expect(dom.window.document.querySelector('[data-three-dimensional-bake]')?.getAttribute('data-three-dimensional-bake')).toBe('2')
  })

  it('waits for the debounce timeout and queued animation frame before baking', async () => {
    const baked: number[] = []
    await act(async () => root.render(createElement(BakeCallbackOwner, { revision: 1, onBake: (revision) => baked.push(revision) })))

    await act(async () => vi.advanceTimersByTime(299))
    expect(baked).toEqual([])
    expect(frames.size).toBe(0)

    await act(async () => vi.advanceTimersByTime(1))
    expect(baked).toEqual([])
    expect(frames.size).toBe(1)

    const [id, callback] = [...frames.entries()][0]
    frames.delete(id)
    await act(async () => callback(300))
    expect(baked).toEqual([1])
  })

  it('cancels a queued frame on revision change and invokes only the latest callback', async () => {
    const baked: number[] = []
    const onBake = (revision: number): void => { baked.push(revision) }
    await act(async () => root.render(createElement(BakeCallbackOwner, { revision: 1, onBake })))
    await act(async () => vi.advanceTimersByTime(300))
    const staleFrameId = [...frames.keys()][0]

    await act(async () => root.render(createElement(BakeCallbackOwner, { revision: 2, onBake })))
    expect(cancelAnimationFrame).toHaveBeenCalledWith(staleFrameId)
    expect(frames.size).toBe(0)

    await act(async () => vi.advanceTimersByTime(300))
    const [currentFrameId, currentCallback] = [...frames.entries()][0]
    frames.delete(currentFrameId)
    await act(async () => currentCallback(600))
    expect(baked).toEqual([2])
  })

  it('flushes a pending timeout synchronously on unmount exactly once with no later duplicate', async () => {
    const baked: number[] = []
    const onBake = (revision: number): void => { baked.push(revision) }
    await act(async () => root.render(createElement(BakeVisibilityHarness, { visible: true, revision: 1, onBake })))

    await act(async () => root.render(createElement(BakeVisibilityHarness, { visible: false, revision: 1, onBake })))
    expect(baked).toEqual([1])

    await act(async () => vi.runAllTimers())
    expect(frames.size).toBe(0)
    expect(baked).toEqual([1])
  })

  it('cancels a queued frame and synchronously flushes the latest callback once on unmount', async () => {
    const baked: number[] = []
    const onBake = (revision: number): void => { baked.push(revision) }
    await act(async () => root.render(createElement(BakeVisibilityHarness, { visible: true, revision: 1, onBake })))
    await act(async () => vi.advanceTimersByTime(300))
    expect(frames.size).toBe(1)

    await act(async () => root.render(createElement(BakeVisibilityHarness, { visible: false, revision: 1, onBake })))
    expect(frames.size).toBe(0)
    expect(baked).toEqual([1])

    await act(async () => vi.runAllTimers())
    expect(baked).toEqual([1])
  })
})
