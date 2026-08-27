import { act, createElement, forwardRef, Fragment, useImperativeHandle } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportPng } from '../src/app/actions'
import { isBakeAssetReadyForArea } from '../src/label/exportReadiness'
import type { LabelAreaConfig } from '../src/label/types'
import { useLabelStore, useUiStore } from '../src/state/stores'
import { pngBytes } from './pngTestUtils'

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
      height: () => height,
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
  get opaque(): boolean { return !this.value.includes('transparent') && !this.value.includes('invalid') }

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
  sourceIdentity?: string
  selectiveTone?: number
  sourceOpaque?: boolean
}

function contextFor(canvas: MarkedCanvas): CanvasRenderingContext2D {
  const context = {
    fillStyle: '#000000' as string | CanvasGradient | CanvasPattern,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    save: () => undefined,
    restore: () => undefined,
    setTransform: () => undefined,
    clearRect: () => { canvas.selectiveTone = 0 },
    fillRect: (x: number, y: number, width: number, height: number) => {
      if (x >= canvas.width || y >= canvas.height || x + width <= 0 || y + height <= 0) return
      const match = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(context.fillStyle))
      const tone = match ? Number(match[1]) : String(context.fillStyle) === '#ffffff' ? 255 : 0
      canvas.selectiveTone = context.globalCompositeOperation === 'source-in' && !canvas.sourceOpaque ? 0 : tone
    },
    translate: () => undefined,
    rotate: () => undefined,
    drawImage: (source: CanvasImageSource) => {
      const marked = source as unknown as {
        complete?: boolean
        opaque?: boolean
        src?: string
        sourceReady?: boolean
        sourceLayerWidth?: number
        sourceIdentity?: string
        selectiveTone?: number
        sourceOpaque?: boolean
      }
      canvas.sourceReady = marked.complete ?? marked.sourceReady
      canvas.sourceLayerWidth = marked.sourceLayerWidth ?? canvas.width
      canvas.sourceIdentity = marked.src ?? marked.sourceIdentity
      canvas.sourceOpaque = marked.opaque ?? marked.sourceOpaque
      canvas.selectiveTone = marked.selectiveTone ?? (canvas.sourceOpaque ? 255 : 0)
    },
    getImageData: (_x: number, y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4)
      if (y === 0 && (canvas.selectiveTone ?? 0) > 0) {
        data[0] = canvas.selectiveTone!
        data[1] = canvas.selectiveTone!
        data[2] = canvas.selectiveTone!
        data[3] = 255
      }
      return { data, width, height, colorSpace: 'srgb' } as ImageData
    },
  }
  return context as unknown as CanvasRenderingContext2D
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
    carrier: 'clear_label',
    substrate: { kind: 'transparent', opacity: 0.1, boundary: { shape: 'rectangle' } },
    layers: [{
      id: 'image-1', kind: 'image', src, naturalWidth: 160, naturalHeight: 80,
      width: 100, height: 50, x: 200, y: 150, rotation: 0, opacity: 1,
      visible: true, locked: false, zIndex: 0, craft: [],
      processes: [{ process: 'white_underbase', requiredMask: 'white_underbase', spotName: 'WHITE' }],
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
    const fetchedSources: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      fetchedSources.push(String(input))
      const bytes = pngBytes(160, 80)
      return new Response(new Uint8Array(bytes).buffer, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
      })
    }))
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => `blob:${fetchedSources.shift() ?? 'image'}`),
      revokeObjectURL: vi.fn(),
    })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(this: HTMLCanvasElement) {
      return contextFor(this as MarkedCanvas)
    })
    vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(callback) {
      callback(new Blob([new Uint8Array([1])], { type: 'image/png' }))
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
    expect(isBakeAssetReadyForArea(
      useLabelStore.getState().areas[0],
      useLabelStore.getState().bakeMap[config.id],
    )).toBe(true)
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
    await act(async () => vi.advanceTimersByTime(300))
    await act(async () => frames.splice(0).forEach((callback) => callback(300)))
    expect(useLabelStore.getState().bakeMap[config.id]?.assetReadinessKey).toBeUndefined()

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

  it('never reuses old opaque pixels after a same-id source change during synchronous export bake', async () => {
    const config = area('opaque-first.png')
    useLabelStore.getState().addArea(config)
    await act(async () => root.render(createElement(LabelCanvas, { displayWidth: 400 })))
    await act(async () => {
      DeferredImage.instances[0].resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => { await exportPng() })
    expect(useLabelStore.getState().bakeMap[config.id]?.whiteUnderbase).toBeDefined()

    await act(async () => useLabelStore.getState().applyAreaOp(config.id, (current) => ({
      ...current,
      layers: current.layers.map((layer) => layer.kind === 'image' ? { ...layer, src: 'transparent-next.png' } : layer),
    })))
    expect(DeferredImage.instances).toHaveLength(2)

    await act(async () => { await exportPng() })
    expect(useLabelStore.getState().bakeMap[config.id]?.whiteUnderbase).toBeUndefined()

    await act(async () => {
      DeferredImage.instances[1].resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => { await exportPng() })
    expect(useLabelStore.getState().bakeMap[config.id]?.whiteUnderbase).toBeUndefined()

    await act(async () => useLabelStore.getState().applyAreaOp(config.id, (current) => ({
      ...current,
      layers: current.layers.map((layer) => layer.kind === 'image' ? { ...layer, src: 'opaque-current.png' } : layer),
    })))
    await act(async () => {
      DeferredImage.instances[2].resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => { await exportPng() })
    expect(useLabelStore.getState().bakeMap[config.id]?.whiteUnderbase).toBeDefined()
  })
})
