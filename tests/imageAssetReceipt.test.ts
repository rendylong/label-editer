// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadAreaContentBoundImage,
  loadContentBoundImage,
  releaseImageAssetArea,
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
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 2
  naturalHeight = 1
  set src(value: string) {
    ImmediateImage.sources.push(value)
    queueMicrotask(() => this.onload?.())
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  ImmediateImage.sources = []
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

  it('skips hidden images and aborts stale pending revisions, removed areas, and explicit unmounts', async () => {
    const visible = { id: 'visible', kind: 'image', src: '/visible.png', naturalWidth: 2, naturalHeight: 1, visible: true } as ImageLayer
    const hidden = { ...visible, id: 'hidden', src: '/hidden.png', visible: false }
    const area = { id: 'area', layers: [visible, hidden] } as LabelAreaConfig
    expect(visibleImageLayersForRuntime(area).map((layer) => layer.id)).toEqual(['visible'])

    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal)
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }))
    const first = loadAreaContentBoundImage('area', 1, visible)
    await Promise.resolve()
    const second = loadAreaContentBoundImage('area', 2, visible)
    await Promise.resolve()
    expect(signals[0].aborted).toBe(true)
    syncImageAssetProject([])
    expect(signals[1].aborted).toBe(true)
    void first.catch(() => undefined)
    void second.catch(() => undefined)

    const third = loadAreaContentBoundImage('area', 3, visible)
    await Promise.resolve()
    releaseImageAssetArea('area')
    expect(signals[2].aborted).toBe(true)
    void third.catch(() => undefined)
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
    await expect(Promise.all(loads)).resolves.toHaveLength(5)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(5)
  })
})
