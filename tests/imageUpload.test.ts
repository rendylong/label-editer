import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelAreaConfig } from '../src/label/types'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'
import { LabelWorkspace } from '../src/ui/LabelWorkspace'
import { bytesToDataUrl } from '../src/label/imageSource'
import { pngBytes } from './pngTestUtils'

const baseArea: LabelAreaConfig = {
  id: 'area-a', name: 'Front label', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
  remap: {
    mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
    planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
  },
  range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
  canvas: { width: 400, height: 300, aspect: 4 / 3 },
  paper: { enabled: false, color: '#ffffff', opacity: 1 },
  layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
  undoStack: [], redoStack: [],
}

class DecodedImage {
  static width = 1600
  static height = 800
  static pending = false
  static waiting = new Set<DecodedImage>()
  static created: DecodedImage[] = []
  naturalWidth = DecodedImage.width
  naturalHeight = DecodedImage.height
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private value = ''

  constructor() { DecodedImage.created.push(this) }

  set src(source: string) {
    this.value = source
    if (source === '') DecodedImage.waiting.delete(this)
    else if (DecodedImage.pending) DecodedImage.waiting.add(this)
    else queueMicrotask(() => this.onload?.())
  }

  get src(): string {
    return this.value
  }

  static releaseAll(): void {
    const waiting = [...DecodedImage.waiting]
    DecodedImage.waiting.clear()
    waiting.forEach((image) => queueMicrotask(() => image.onload?.()))
  }
}

function uploadFile(
  name: string,
  type: string,
  bytes: ArrayLike<number>,
  size = bytes.length,
): File {
  return {
    name,
    type,
    size,
    arrayBuffer: vi.fn(async () => Uint8Array.from(bytes).buffer),
  } as unknown as File
}

function jpegBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
  ])
}

function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  new DataView(bytes.buffer).setUint32(4, 22, true)
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8)
  new DataView(bytes.buffer).setUint32(16, 10, true)
  const view = new DataView(bytes.buffer)
  view.setUint8(24, (width - 1) & 0xff)
  view.setUint8(25, ((width - 1) >>> 8) & 0xff)
  view.setUint8(26, ((width - 1) >>> 16) & 0xff)
  view.setUint8(27, (height - 1) & 0xff)
  view.setUint8(28, ((height - 1) >>> 8) & 0xff)
  view.setUint8(29, ((height - 1) >>> 16) & 0xff)
  return bytes
}

async function mountWorkspace(): Promise<{ dom: JSDOM; unmount: () => Promise<void>; dispose: () => void }> {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('Node', dom.window.Node)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('Image', DecodedImage)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = createRoot(dom.window.document.querySelector('#root')!)
  await act(async () => root.render(createElement(LabelWorkspace)))
  return {
    dom,
    async unmount() {
      await act(async () => root.unmount())
    },
    dispose() {
      dom.window.close()
      vi.unstubAllGlobals()
    },
  }
}

async function withMountedWorkspace(run: (dom: JSDOM) => Promise<void>): Promise<void> {
  const mounted = await mountWorkspace()
  try {
    await run(mounted.dom)
  } finally {
    await mounted.unmount()
    mounted.dispose()
  }
}

async function chooseImage(dom: JSDOM, file: File): Promise<void> {
  const input = dom.window.document.querySelector<HTMLInputElement>('input[type="file"][accept=".png,.jpg,.jpeg,.webp"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => {
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function deferredFile(name: string, type: string, bytes: ArrayLike<number>): { file: File; release: () => void } {
  let release!: (value: ArrayBuffer) => void
  const pending = new Promise<ArrayBuffer>((resolve) => { release = resolve })
  return {
    file: {
      name,
      type,
      size: bytes.length,
      arrayBuffer: vi.fn(() => pending),
    } as unknown as File,
    release: () => release(Uint8Array.from(bytes).buffer),
  }
}

describe('label image upload behavior', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState(useModelStore.getInitialState(), true)
    useLabelStore.setState({ areas: [baseArea], activeAreaId: baseArea.id, activeArea: baseArea })
    DecodedImage.width = 1600
    DecodedImage.height = 800
    DecodedImage.pending = false
    DecodedImage.waiting.clear()
    DecodedImage.created = []
  })

  it('embeds accepted PNG bytes, preserves natural proportions, records one undo mutation, and selects the result', async () => {
    const bytes = pngBytes(1600, 800)
    const file = uploadFile('reference.png', 'image/png', bytes)

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    const state = useLabelStore.getState()
    const result = state.areas[0].layers[0]
    expect(result).toMatchObject({
      kind: 'image',
      src: bytesToDataUrl(bytes, 'image/png'),
      naturalWidth: 1600,
      naturalHeight: 800,
      width: 200,
      height: 100,
      x: 200,
      y: 150,
      visible: true,
    })
    expect(state.areas[0].undoStack).toHaveLength(1)
    expect(state.selectedLayerIds).toEqual([result.id])
    expect(useUiStore.getState().toast).toEqual({ msg: '已添加图片', kind: 'success' })
  })

  it('rejects an unsupported extension before reading file bytes', async () => {
    const file = uploadFile('reference.gif', 'image/gif', [71, 73, 70])

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(useLabelStore.getState().areas[0].layers).toEqual([])
    expect(useLabelStore.getState().areas[0].undoStack).toEqual([])
    expect(useUiStore.getState().toast).toEqual({ msg: '仅支持 PNG / JPG / WebP', kind: 'error' })
  })

  it('rejects a spoofed supported extension whose MIME type is not an image', async () => {
    const file = uploadFile('reference.png', 'text/plain', [60, 115, 99, 114, 105, 112, 116])

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(useLabelStore.getState().areas[0].layers).toEqual([])
    expect(useUiStore.getState().toast).toEqual({ msg: '仅支持 PNG / JPG / WebP', kind: 'error' })
  })

  it('infers a stable embedded MIME type when the platform omits file.type', async () => {
    const bytes = webpBytes(1600, 800)
    const file = uploadFile('reference.webp', '', bytes)

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    const result = useLabelStore.getState().areas[0].layers[0]
    expect(result).toMatchObject({ kind: 'image', src: bytesToDataUrl(bytes, 'image/webp') })
  })

  it('rejects a file above the embedded-asset byte limit without decoding or mutating history', async () => {
    const file = uploadFile('reference.webp', 'image/webp', [82, 73, 70, 70], 20 * 1024 * 1024 + 1)

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(useLabelStore.getState().areas[0].layers).toEqual([])
    expect(useLabelStore.getState().areas[0].undoStack).toEqual([])
    expect(useUiStore.getState().toast).toEqual({ msg: '图片超过 20MB 上限', kind: 'error' })
  })

  it('rejects decoded images above 16 megapixels without adding a layer', async () => {
    DecodedImage.width = 5000
    DecodedImage.height = 4000
    const file = uploadFile('oversized.jpg', 'image/jpeg', jpegBytes(5000, 4000))

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    expect(file.arrayBuffer).toHaveBeenCalledOnce()
    expect(useLabelStore.getState().areas[0].layers).toEqual([])
    expect(useLabelStore.getState().areas[0].undoStack).toEqual([])
    expect(useUiStore.getState().toast).toEqual({ msg: '图片文件结构或尺寸无效，已拒绝', kind: 'error' })
  })

  it('rejects uploads that would exceed project image count or aggregate decoded pixels', async () => {
    const existingImage = (index: number, naturalWidth: number, naturalHeight: number) => ({
      id: `existing-${index}`, kind: 'image' as const, src: `data:image/png;base64,${index}`,
      naturalWidth, naturalHeight, width: 1, height: 1, x: 0, y: 0, rotation: 0,
      opacity: 1, visible: true, locked: false, zIndex: index, craft: [],
    })
    const countArea = {
      ...baseArea,
      layers: Array.from({ length: 64 }, (_, index) => existingImage(index, 1, 1)),
      undoStack: [], redoStack: [],
    }
    useLabelStore.setState({ areas: [countArea], activeAreaId: countArea.id, activeArea: countArea })
    DecodedImage.width = 1
    DecodedImage.height = 1

    await withMountedWorkspace(async (dom) => chooseImage(dom, uploadFile('count.png', 'image/png', pngBytes(1, 1))))
    expect(useLabelStore.getState().areas[0].layers).toHaveLength(64)
    expect(useUiStore.getState().toast).toEqual({ msg: '图片资源超出项目上限，已拒绝', kind: 'error' })

    const pixelArea = {
      ...baseArea,
      layers: [existingImage(1, 4096, 4096), existingImage(2, 4096, 4096)],
      undoStack: [], redoStack: [],
    }
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState({ areas: [pixelArea], activeAreaId: pixelArea.id, activeArea: pixelArea })
    await withMountedWorkspace(async (dom) => chooseImage(dom, uploadFile('pixels.png', 'image/png', pngBytes(1, 1))))
    expect(useLabelStore.getState().areas[0].layers).toHaveLength(2)
    expect(useUiStore.getState().toast).toEqual({ msg: '图片资源超出项目上限，已拒绝', kind: 'error' })
  })

  it('cancels a slow decoded upload when the user switches to another area', async () => {
    const backArea = { ...baseArea, id: 'area-b', name: 'Back label', layers: [], undoStack: [], redoStack: [] }
    useLabelStore.setState({ areas: [baseArea, backArea], activeAreaId: baseArea.id, activeArea: baseArea })
    DecodedImage.pending = true

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, uploadFile('slow.png', 'image/png', pngBytes(1600, 800)))
      expect(DecodedImage.waiting.size).toBe(1)
      await act(async () => {
        useLabelStore.getState().activateArea(backArea.id)
        DecodedImage.releaseAll()
        await Promise.resolve()
        await Promise.resolve()
      })
    })

    expect(useLabelStore.getState().areas.every((candidate) => candidate.layers.length === 0)).toBe(true)
    expect(useLabelStore.getState().activeAreaId).toBe(backArea.id)
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
    expect(useUiStore.getState().toast).toBeNull()
  })

  it('keeps at most one transient upload decoder and releases the superseded image immediately', async () => {
    DecodedImage.pending = true

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, uploadFile('older.png', 'image/png', pngBytes(1600, 800)))
      expect(DecodedImage.waiting.size).toBe(1)
      const older = DecodedImage.created[0]

      await chooseImage(dom, uploadFile('newer.png', 'image/png', pngBytes(1600, 800)))

      expect(DecodedImage.created).toHaveLength(2)
      expect(older.src).toBe('')
      expect(DecodedImage.waiting).toEqual(new Set([DecodedImage.created[1]]))
      DecodedImage.releaseAll()
      await flushAsyncWork()
    })

    expect(useLabelStore.getState().areas[0].layers).toHaveLength(1)
  })

  it('releases a transient upload decoder immediately when the workspace unmounts', async () => {
    DecodedImage.pending = true
    const mounted = await mountWorkspace()
    try {
      await chooseImage(mounted.dom, uploadFile('pending.png', 'image/png', pngBytes(1600, 800)))
      expect(DecodedImage.waiting.size).toBe(1)

      await mounted.unmount()

      expect(DecodedImage.waiting.size).toBe(0)
      expect(DecodedImage.created[0].src).toBe('')
    } finally {
      mounted.dispose()
    }
  })

  it('keeps a slow upload cancelled after switching away and back to its original area', async () => {
    const backArea = { ...baseArea, id: 'area-b', name: 'Back label', layers: [], undoStack: [], redoStack: [] }
    useLabelStore.setState({ areas: [baseArea, backArea], activeAreaId: baseArea.id, activeArea: baseArea })
    DecodedImage.pending = true

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, uploadFile('slow.png', 'image/png', pngBytes(1600, 800)))
      expect(DecodedImage.waiting.size).toBe(1)
      await act(async () => {
        useLabelStore.getState().activateArea(backArea.id)
        useLabelStore.getState().activateArea(baseArea.id)
        DecodedImage.releaseAll()
        await Promise.resolve()
        await Promise.resolve()
      })
    })

    expect(useLabelStore.getState().activeAreaId).toBe(baseArea.id)
    expect(useLabelStore.getState().areas.every((candidate) => candidate.layers.length === 0)).toBe(true)
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
    expect(useUiStore.getState().toast).toBeNull()
  })

  it('cancels a slow file read when its area is deleted', async () => {
    const pending = deferredFile('slow.png', 'image/png', pngBytes(1600, 800))

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, pending.file)
      await act(async () => {
        useLabelStore.getState().removeArea(baseArea.id)
        pending.release()
        await Promise.resolve()
        await Promise.resolve()
      })
    })

    expect(useLabelStore.getState().areas).toEqual([])
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
    expect(useUiStore.getState().toast).toBeNull()
  })

  it('does not apply a slow upload to a replacement area that reuses the same id', async () => {
    const pending = deferredFile('slow.png', 'image/png', pngBytes(1600, 800))
    const replacement = { ...baseArea, name: 'Imported replacement', layers: [], undoStack: [], redoStack: [] }

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, pending.file)
      await act(async () => {
        useLabelStore.setState({ areas: [replacement], activeAreaId: replacement.id, activeArea: replacement })
        pending.release()
        await Promise.resolve()
        await Promise.resolve()
      })
    })

    expect(useLabelStore.getState().areas[0]).toBe(replacement)
    expect(replacement.layers).toEqual([])
    expect(useLabelStore.getState().selectedLayerIds).toEqual([])
    expect(useUiStore.getState().toast).toBeNull()
  })

  it('lets a newer upload win and prevents the older completion from adding a second mutation', async () => {
    const older = deferredFile('older.png', 'image/png', pngBytes(100, 100))
    const newerBytes = pngBytes(1600, 800)
    const newer = uploadFile('newer.png', 'image/png', newerBytes)

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, older.file)
      await chooseImage(dom, newer)
      await flushAsyncWork()
      older.release()
      await flushAsyncWork()
    })

    const state = useLabelStore.getState()
    expect(state.areas[0].layers).toHaveLength(1)
    expect(state.areas[0].layers[0]).toMatchObject({ kind: 'image', src: bytesToDataUrl(newerBytes, 'image/png') })
    expect(state.areas[0].undoStack).toHaveLength(1)
    expect(state.selectedLayerIds).toEqual([state.areas[0].layers[0].id])
    expect(useUiStore.getState().toast).toEqual({ msg: '已添加图片', kind: 'success' })
  })

  it('does not mutate stores after the workspace unmounts while an upload is pending', async () => {
    const pending = deferredFile('slow.png', 'image/png', pngBytes(1600, 800))
    const mounted = await mountWorkspace()
    try {
      await chooseImage(mounted.dom, pending.file)
      await mounted.unmount()

      pending.release()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(useLabelStore.getState().areas[0].layers).toEqual([])
      expect(useLabelStore.getState().selectedLayerIds).toEqual([])
      expect(useUiStore.getState().toast).toBeNull()
    } finally {
      mounted.dispose()
    }
  })
})
