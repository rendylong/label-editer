// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindImageAssetReceipt,
  currentImageAssetReceipt,
  loadAreaContentBoundImage,
  loadContentBoundImage,
  resetImageAssetProject,
  syncImageAssetProject,
  visibleImageLayersForRuntime,
} from '../src/label/imageAssetReceipt'
import type { ImageLayer, LabelAreaConfig } from '../src/label/types'
import { pngBytes } from './pngTestUtils'

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function withTextChunk(bytes: Uint8Array): Uint8Array {
  const payload = new TextEncoder().encode('receipt\0changed')
  const type = new TextEncoder().encode('tEXt')
  const chunk = new Uint8Array(12 + payload.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, payload.length, false)
  chunk.set(type, 4)
  chunk.set(payload, 8)
  view.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)), false)
  const iendOffset = bytes.length - 12
  const result = new Uint8Array(bytes.length + chunk.length)
  result.set(bytes.subarray(0, iendOffset))
  result.set(chunk, iendOffset)
  result.set(bytes.subarray(iendOffset), iendOffset + chunk.length)
  return result
}

class ImmediateImage {
  static sources: string[] = []
  static naturalWidth = 2
  static naturalHeight = 1
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = ImmediateImage.naturalWidth
  naturalHeight = ImmediateImage.naturalHeight
  private value = ''
  set src(value: string) {
    this.value = value
    ImmediateImage.sources.push(value)
    queueMicrotask(() => this.onload?.())
  }
  get src(): string { return this.value }
}

afterEach(() => {
  syncImageAssetProject([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  ImmediateImage.sources = []
  ImmediateImage.naturalWidth = 2
  ImmediateImage.naturalHeight = 1
})

describe('content-bound image receipts', () => {
  it('reloads the same URL from bounded bytes and changes identity when server content changes', async () => {
    const first = pngBytes(2, 1)
    const replacement = withTextChunk(first)
    const responses = [first, replacement]
    let index = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(responses[index++]).buffer, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(responses[index - 1]?.byteLength ?? first.byteLength) },
    })))
    vi.stubGlobal('Image', ImmediateImage)
    let objectIndex = 0
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => `blob:content-${++objectIndex}`),
      revokeObjectURL: vi.fn(),
    })

    const loadedFirst = await loadContentBoundImage('https://assets.test/mark.png', 2, 1)
    const loadedSecond = await loadContentBoundImage('https://assets.test/mark.png', 2, 1)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://assets.test/mark.png', expect.objectContaining({
      cache: 'no-store', redirect: 'error', credentials: 'same-origin',
    }))
    expect(loadedFirst.receiptKey).toMatch(/^image\/image\/png\/2x1\/sha256:[a-f0-9]{64}$/)
    expect(loadedSecond.receiptKey).not.toBe(loadedFirst.receiptKey)
    expect(ImmediateImage.sources).toEqual(['blob:content-1', 'blob:content-2'])
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    loadedFirst.release()
    loadedSecond.release()
  })

  it('rejects declared dimensions that do not match structurally parsed bytes before image decode', async () => {
    const bytes = pngBytes(1, 1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes).buffer, {
      status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
    })))
    vi.stubGlobal('Image', ImmediateImage)

    await expect(loadContentBoundImage('https://assets.test/claimed-large.png', 1600, 1600))
      .rejects.toThrow(/dimensions/i)
    expect(ImmediateImage.sources).toHaveLength(0)
  })

  it('rejects an oversized content-length before reading or allocating the response body', async () => {
    const body = new ReadableStream({ pull: vi.fn(() => { throw new Error('must not read') }) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200, headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) },
    })))

    await expect(loadContentBoundImage('https://assets.test/huge.png', 1, 1)).rejects.toThrow(/byte limit/i)
  })

  it('reserves unknown-length response chunks incrementally across concurrent streams', async () => {
    const chunk = new Uint8Array(17 * 1024 * 1024)
    let closeStreams!: () => void
    const closeGate = new Promise<void>((resolve) => { closeStreams = resolve })
    const cancellations: ReturnType<typeof vi.fn>[] = []
    vi.stubGlobal('fetch', vi.fn(async () => {
      let pulled = false
      const cancel = vi.fn()
      cancellations.push(cancel)
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (!pulled) {
            pulled = true
            controller.enqueue(chunk)
            return
          }
          await closeGate
          controller.close()
        },
        cancel,
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } })
    }))

    const errors: Error[] = []
    const loads = Array.from({ length: 4 }, (_, index) => loadContentBoundImage(`/stream-${index}.png`, 1, 1)
      .catch((error: Error) => { errors.push(error); throw error }))
    for (let index = 0; index < 30; index += 1) await Promise.resolve()

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/aggregate concurrent byte limit/i)
    expect(cancellations.some((cancel) => cancel.mock.calls.length > 0)).toBe(true)
    closeStreams()
    await Promise.allSettled(loads)
  })

  it('keeps the same project-scoped image and receipt across activation switches, then evicts removed areas', async () => {
    const visible = { id: 'visible', kind: 'image', src: '/visible.png', naturalWidth: 2, naturalHeight: 1, visible: true } as ImageLayer
    const hidden = { ...visible, id: 'hidden', src: '/hidden.png', visible: false }
    const area = { id: 'area', layers: [visible, hidden] } as LabelAreaConfig
    expect(visibleImageLayersForRuntime(area).map((layer) => layer.id)).toEqual(['visible'])

    const bytes = pngBytes(2, 1)
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal)
      return new Response(new Uint8Array(bytes).buffer, {
        status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
      })
    }))
    vi.stubGlobal('Image', ImmediateImage)
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:shared'), revokeObjectURL: vi.fn() })
    syncImageAssetProject([area])

    const first = await loadAreaContentBoundImage('area', 1, visible)
    bindImageAssetReceipt('area', visible.id, visible.src, visible.naturalWidth, visible.naturalHeight, first.receiptKey)
    const second = await loadAreaContentBoundImage('area', 2, visible)

    expect(second).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(signals[0].aborted).toBe(false)
    expect(currentImageAssetReceipt('area', visible.id, visible.src, 2, 1)).toBe(first.receiptKey)

    resetImageAssetProject()
    expect(signals[0].aborted).toBe(true)
    expect(currentImageAssetReceipt('area', visible.id, visible.src, 2, 1)).toBeUndefined()
    expect(first.image.src).toBe('')

    syncImageAssetProject([area])
    await loadAreaContentBoundImage('area', 3, visible)
    expect(fetch).toHaveBeenCalledTimes(2)
    syncImageAssetProject([])
  })

  it('keeps control-delimiter area/layer owner tuples distinct without cross-eviction', async () => {
    const firstLayer = {
      id: 'c', kind: 'image', src: '/first.png', naturalWidth: 2, naturalHeight: 1, visible: true,
    } as ImageLayer
    const secondLayer = {
      id: 'b\u0000c', kind: 'image', src: '/second.png', naturalWidth: 2, naturalHeight: 1, visible: true,
    } as ImageLayer
    const areas = [
      { id: 'a\u0000b', layers: [firstLayer] },
      { id: 'a', layers: [secondLayer] },
    ] as LabelAreaConfig[]
    const bytes = pngBytes(2, 1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes).buffer, {
      status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
    })))
    vi.stubGlobal('Image', ImmediateImage)
    let objectIndex = 0
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:tuple-${++objectIndex}`), revokeObjectURL: vi.fn() })
    syncImageAssetProject(areas)

    const first = await loadAreaContentBoundImage(areas[0].id, 1, firstLayer)
    const second = await loadAreaContentBoundImage(areas[1].id, 1, secondLayer)
    const firstAgain = await loadAreaContentBoundImage(areas[0].id, 2, firstLayer)

    expect(firstAgain).toBe(first)
    expect(second).not.toBe(first)
    expect(fetch).toHaveBeenCalledTimes(2)
    syncImageAssetProject([])
  })

  it('rejects a structurally oversized decoded image before constructing an Image', async () => {
    const bytes = pngBytes(4097, 4096)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes).buffer, {
      status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
    })))
    vi.stubGlobal('Image', ImmediateImage)

    await expect(loadContentBoundImage('/too-many-pixels.png', 4097, 4096)).rejects.toThrow(/dimensions/i)
    expect(ImmediateImage.sources).toHaveLength(0)
  })

  it('bounds retained decoded pixels and releases the HTMLImageElement when its owner is dropped', async () => {
    const bytes = pngBytes(4096, 4096)
    ImmediateImage.naturalWidth = 4096
    ImmediateImage.naturalHeight = 4096
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes).buffer, {
      status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
    })))
    vi.stubGlobal('Image', ImmediateImage)
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:decoded-${Math.random()}`), revokeObjectURL: vi.fn() })

    const first = await loadContentBoundImage('/first.png', 4096, 4096)
    const second = await loadContentBoundImage('/second.png', 4096, 4096)
    await expect(loadContentBoundImage('/third.png', 4096, 4096)).rejects.toThrow(/decoded.*limit/i)

    first.release()
    expect(first.image.src).toBe('')
    const third = await loadContentBoundImage('/third.png', 4096, 4096)
    second.release()
    third.release()
  })

  it('bounds concurrent content image fetches and releases queued work after completion', async () => {
    const bytes = pngBytes(2, 1)
    let active = 0
    let maximum = 0
    const releases: Array<() => void> = []
    vi.stubGlobal('fetch', vi.fn(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return new Response(new Uint8Array(bytes).buffer, {
        status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
      })
    }))
    vi.stubGlobal('Image', ImmediateImage)
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:bounded'), revokeObjectURL: vi.fn() })

    const loads = Array.from({ length: 5 }, (_, index) => loadContentBoundImage(`/asset-${index}.png`, 2, 1))
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    expect(maximum).toBe(4)
    for (let index = 0; index < 100; index += 1) {
      releases.splice(0).forEach((release) => release())
      await Promise.resolve()
    }
    const loaded = await Promise.all(loads)
    expect(loaded).toHaveLength(5)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(5)
    loaded.forEach((image) => image.release())
  })
})
