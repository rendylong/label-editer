import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelAreaConfig } from '../src/label/types'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'
import { LabelWorkspace } from '../src/ui/LabelWorkspace'

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
  naturalWidth = DecodedImage.width
  naturalHeight = DecodedImage.height
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private value = ''

  set src(source: string) {
    this.value = source
    if (DecodedImage.pending) DecodedImage.waiting.add(this)
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
  bytes: number[],
  size = bytes.length,
): File {
  return {
    name,
    type,
    size,
    arrayBuffer: vi.fn(async () => Uint8Array.from(bytes).buffer),
  } as unknown as File
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

function deferredFile(name: string, type: string, bytes: number[]): { file: File; release: () => void } {
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
  })

  it('embeds accepted PNG bytes, preserves natural proportions, records one undo mutation, and selects the result', async () => {
    const file = uploadFile('reference.png', 'image/png', [137, 80, 78, 71])

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    const state = useLabelStore.getState()
    const result = state.areas[0].layers[0]
    expect(result).toMatchObject({
      kind: 'image',
      src: 'data:image/png;base64,iVBORw==',
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
    const file = uploadFile('reference.webp', '', [82, 73, 70, 70])

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    const result = useLabelStore.getState().areas[0].layers[0]
    expect(result).toMatchObject({ kind: 'image', src: 'data:image/webp;base64,UklGRg==' })
  })

  it('rejects a file above 64 MB without decoding or mutating history', async () => {
    const file = uploadFile('reference.webp', 'image/webp', [82, 73, 70, 70], 64 * 1024 * 1024 + 1)

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(useLabelStore.getState().areas[0].layers).toEqual([])
    expect(useLabelStore.getState().areas[0].undoStack).toEqual([])
    expect(useUiStore.getState().toast).toEqual({ msg: '图片超过 64MB 上限', kind: 'error' })
  })

  it('rejects decoded images above 16 megapixels without adding a layer', async () => {
    DecodedImage.width = 5000
    DecodedImage.height = 4000
    const file = uploadFile('oversized.jpg', 'image/jpeg', [255, 216, 255])

    await withMountedWorkspace(async (dom) => chooseImage(dom, file))

    expect(file.arrayBuffer).toHaveBeenCalledOnce()
    expect(useLabelStore.getState().areas[0].layers).toEqual([])
    expect(useLabelStore.getState().areas[0].undoStack).toEqual([])
    expect(useUiStore.getState().toast).toEqual({ msg: '图片像素过大（>1600 万像素），已拒绝', kind: 'error' })
  })

  it('cancels a slow decoded upload when the user switches to another area', async () => {
    const backArea = { ...baseArea, id: 'area-b', name: 'Back label', layers: [], undoStack: [], redoStack: [] }
    useLabelStore.setState({ areas: [baseArea, backArea], activeAreaId: baseArea.id, activeArea: baseArea })
    DecodedImage.pending = true

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, uploadFile('slow.png', 'image/png', [1]))
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

  it('keeps a slow upload cancelled after switching away and back to its original area', async () => {
    const backArea = { ...baseArea, id: 'area-b', name: 'Back label', layers: [], undoStack: [], redoStack: [] }
    useLabelStore.setState({ areas: [baseArea, backArea], activeAreaId: baseArea.id, activeArea: baseArea })
    DecodedImage.pending = true

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, uploadFile('slow.png', 'image/png', [1]))
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
    const pending = deferredFile('slow.png', 'image/png', [2])

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
    const pending = deferredFile('slow.png', 'image/png', [3])
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
    const older = deferredFile('older.png', 'image/png', [1])
    const newer = uploadFile('newer.png', 'image/png', [2])

    await withMountedWorkspace(async (dom) => {
      await chooseImage(dom, older.file)
      await chooseImage(dom, newer)
      await flushAsyncWork()
      older.release()
      await flushAsyncWork()
    })

    const state = useLabelStore.getState()
    expect(state.areas[0].layers).toHaveLength(1)
    expect(state.areas[0].layers[0]).toMatchObject({ kind: 'image', src: 'data:image/png;base64,Ag==' })
    expect(state.areas[0].undoStack).toHaveLength(1)
    expect(state.selectedLayerIds).toEqual([state.areas[0].layers[0].id])
    expect(useUiStore.getState().toast).toEqual({ msg: '已添加图片', kind: 'success' })
  })

  it('does not mutate stores after the workspace unmounts while an upload is pending', async () => {
    const pending = deferredFile('slow.png', 'image/png', [4])
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
