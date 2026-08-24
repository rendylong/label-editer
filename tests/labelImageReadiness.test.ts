import { act, createElement, forwardRef, Fragment, useImperativeHandle } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelAreaConfig } from '../src/label/types'
import { useLabelStore, useUiStore } from '../src/state/stores'

const konvaHarness = vi.hoisted(() => ({
  latestPreview: null as (HTMLCanvasElement & { sourceReady?: boolean; sourceLayerWidth?: number }) | null,
}))

vi.mock('react-konva', async () => {
  const { createElement, forwardRef, Fragment, useImperativeHandle } = await import('react')
  const PassThrough = ({ children }: { children?: unknown }) => createElement(Fragment, null, children as never)
  const Empty = () => null
  const Stage = forwardRef(function TestStage(
    { children, width, height }: { children?: unknown; width: number; height: number },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      width: () => width,
      find: () => [],
      findOne: () => undefined,
      draw: () => undefined,
      toCanvas: () => {
        const canvas = document.createElement('canvas') as HTMLCanvasElement & {
          sourceReady?: boolean
          sourceLayerWidth?: number
        }
        canvas.width = width
        canvas.height = height
        canvas.sourceReady = konvaHarness.latestPreview?.sourceReady
        canvas.sourceLayerWidth = konvaHarness.latestPreview?.sourceLayerWidth
        return canvas
      },
    }), [height, width])
    return createElement('div', { 'data-stage': true }, children as never)
  })
  const Image = ({ image }: { image: HTMLCanvasElement & { sourceReady?: boolean; sourceLayerWidth?: number } }) => {
    konvaHarness.latestPreview = image
    return createElement('div', {
      'data-image-preview': true,
      'data-source-ready': String(image.sourceReady),
      'data-layer-width': String(image.sourceLayerWidth),
    })
  }
  return {
    Stage,
    Layer: PassThrough,
    Group: PassThrough,
    Text: Empty,
    Image,
    Rect: Empty,
    Shape: Empty,
    Line: Empty,
    Transformer: forwardRef(() => null),
  }
})

import { LabelCanvas } from '../src/label/LabelCanvas'

class DeferredImage {
  static instances: DeferredImage[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  complete = false
  naturalWidth = 160
  naturalHeight = 80
  private value = ''

  constructor() {
    DeferredImage.instances.push(this)
  }

  set src(value: string) { this.value = value }
  get src(): string { return this.value }

  resolve(): void {
    this.complete = true
    this.onload?.()
  }

  reject(): void {
    this.onerror?.()
  }
}

interface MarkedCanvas extends HTMLCanvasElement {
  sourceReady?: boolean
  sourceLayerWidth?: number
}

function contextFor(canvas: MarkedCanvas): CanvasRenderingContext2D {
  return {
    save: () => undefined,
    restore: () => undefined,
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    drawImage: (source: CanvasImageSource) => {
      const marked = source as unknown as { complete?: boolean; sourceReady?: boolean; sourceLayerWidth?: number }
      canvas.sourceReady = marked.complete ?? marked.sourceReady
      canvas.sourceLayerWidth = marked.sourceLayerWidth ?? canvas.width
    },
  } as unknown as CanvasRenderingContext2D
}

function area(src: string): LabelAreaConfig {
  return {
    id: `area-${src}`,
    name: 'Image area',
    meshIndex: 0,
    nodeName: 'Bottle',
    surfaceMode: 'overlay',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1,
      wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 400, height: 300, aspect: 4 / 3 },
    layers: [{
      id: 'image-1', kind: 'image', src, naturalWidth: 160, naturalHeight: 80,
      width: 100, height: 50, x: 200, y: 150, rotation: 0, opacity: 1,
      visible: true, locked: false, zIndex: 0, craft: [],
    }],
    globalCraft: { craft: [] },
    fonts: [],
    referenceVisible: false,
    undoStack: [],
    redoStack: [],
  }
}

describe('LabelCanvas image readiness ownership', () => {
  let dom: JSDOM
  let root: ReturnType<typeof createRoot>
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    vi.useFakeTimers()
    DeferredImage.instances = []
    konvaHarness.latestPreview = null
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Node', dom.window.Node)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('Image', DeferredImage)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(this: HTMLCanvasElement) {
      return contextFor(this as MarkedCanvas)
    })
    frames = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    root = createRoot(dom.window.document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('a restarted edit awaits the shared pending load and bakes only the latest ready preview', async () => {
    const config = area('deferred-shared.png')
    useLabelStore.getState().addArea(config)
    await act(async () => root.render(createElement(LabelCanvas, { displayWidth: 400 })))
    expect(DeferredImage.instances).toHaveLength(1)

    await act(async () => useLabelStore.getState().applyAreaOp(config.id, (current) => ({
      ...current,
      layers: current.layers.map((layer) => layer.kind === 'image' ? { ...layer, width: 200, height: 100 } : layer),
    })))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(dom.window.document.querySelector('[data-image-preview]')).toBeNull()
    expect(DeferredImage.instances).toHaveLength(1)

    await act(async () => {
      DeferredImage.instances[0].resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const preview = dom.window.document.querySelector('[data-image-preview]')
    expect(preview?.getAttribute('data-source-ready')).toBe('true')
    expect(preview?.getAttribute('data-layer-width')).toBe('200')

    await act(async () => vi.advanceTimersByTime(300))
    await act(async () => frames.splice(0).forEach((callback) => callback(300)))
    const bake = useLabelStore.getState().bakeMap[config.id]?.color as MarkedCanvas | undefined
    expect(bake?.sourceReady).toBe(true)
    expect(bake?.sourceLayerWidth).toBe(200)
  })

  it('evicts a rejected source so the next edit can retry and render after one successful load', async () => {
    const config = area('deferred-retry.png')
    useLabelStore.getState().addArea(config)
    await act(async () => root.render(createElement(LabelCanvas, { displayWidth: 400 })))
    expect(DeferredImage.instances).toHaveLength(1)

    await act(async () => {
      DeferredImage.instances[0].reject()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(dom.window.document.querySelector('[data-image-preview]')).toBeNull()

    await act(async () => useLabelStore.getState().applyAreaOp(config.id, (current) => ({
      ...current,
      layers: current.layers.map((layer) => layer.kind === 'image' ? { ...layer, width: 180, height: 90 } : layer),
    })))
    expect(DeferredImage.instances).toHaveLength(2)

    await act(async () => {
      DeferredImage.instances[1].resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const preview = dom.window.document.querySelector('[data-image-preview]')
    expect(preview?.getAttribute('data-source-ready')).toBe('true')
    expect(preview?.getAttribute('data-layer-width')).toBe('180')
  })
})
