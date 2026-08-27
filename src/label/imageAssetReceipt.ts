import { parsePortablePng } from '../../scripts/lib/png-core.mjs'
import { sha256HexSync } from '../agent/syncSha256'
import { decodeBoundedDataUrl, MAX_EMBEDDED_ASSET_BYTES } from './boundedAssetBytes'
import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS_PER_LAYER,
  MAX_PROJECT_IMAGE_PIXELS,
} from './imageResourceLimits'
import type { ImageLayer, LabelAreaConfig } from './types'

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_CONCURRENT_IMAGE_LOADS = 4
const MAX_CONCURRENT_IMAGE_BYTES = 64 * 1024 * 1024

export interface ContentBoundImage {
  image: HTMLImageElement
  width: number
  height: number
  mimeType: string
  byteLength: number
  sha256: string
  receiptKey: string
  /** Release the retained decoded browser resource. Idempotent. */
  release: () => void
}

interface CurrentImageReceipt {
  sourceIdentity: string
  receiptKey: string
}

const currentReceipts = new Map<string, Map<string, CurrentImageReceipt>>()
interface AreaImageLoad {
  identity: string
  sourceIdentity: string
  controller: AbortController
  load: Promise<ContentBoundImage>
  resource?: ContentBoundImage
}
const areaImageLoads = new Map<string, AreaImageLoad>()
let activeImageLoads = 0
let reservedImageBytes = 0
let retainedDecodedPixels = 0
const imageLoadQueue: Array<{ signal?: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void }> = []

function sourceIdentity(src: string, width: number, height: number): string {
  return `${src}\u0000${width}\u0000${height}`
}

/** Invalidate the previous successful payload before an activation begins refetching it. */
export function beginImageAssetLoad(areaId: string, layerId: string): void {
  currentReceipts.get(areaId)?.delete(layerId)
}

export function bindImageAssetReceipt(
  areaId: string,
  layerId: string,
  src: string,
  width: number,
  height: number,
  receiptKey: string,
): void {
  const area = currentReceipts.get(areaId) ?? new Map<string, CurrentImageReceipt>()
  area.set(layerId, { sourceIdentity: sourceIdentity(src, width, height), receiptKey })
  currentReceipts.set(areaId, area)
}

export function currentImageAssetReceipt(
  areaId: string,
  layerId: string,
  src: string,
  width: number,
  height: number,
): string | undefined {
  const receipt = currentReceipts.get(areaId)?.get(layerId)
  return receipt?.sourceIdentity === sourceIdentity(src, width, height) ? receipt.receiptKey : undefined
}

function abortError(): Error {
  const error = new Error('Image load was aborted')
  error.name = 'AbortError'
  return error
}

function drainImageLoadQueue(): void {
  while (activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS && imageLoadQueue.length > 0) {
    const queued = imageLoadQueue.shift()!
    if (queued.signal?.aborted) { queued.reject(abortError()); continue }
    activeImageLoads += 1
    let released = false
    queued.resolve(() => {
      if (released) return
      released = true
      activeImageLoads -= 1
      drainImageLoadQueue()
    })
  }
}

function acquireImageLoadSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const queued = { signal, resolve, reject }
    imageLoadQueue.push(queued)
    const onAbort = () => {
      const index = imageLoadQueue.indexOf(queued)
      if (index >= 0) {
        imageLoadQueue.splice(index, 1)
        reject(abortError())
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const wrappedResolve = queued.resolve
    queued.resolve = (release) => {
      signal?.removeEventListener('abort', onAbort)
      wrappedResolve(release)
    }
    drainImageLoadQueue()
  })
}

function reserveImageBytes(length: number): () => void {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_EMBEDDED_ASSET_BYTES
    || length > MAX_CONCURRENT_IMAGE_BYTES - reservedImageBytes) {
    throw new Error('Image exceeds the aggregate concurrent byte limit')
  }
  reservedImageBytes += length
  let released = false
  return () => {
    if (released) return
    released = true
    reservedImageBytes -= length
  }
}

function reserveDecodedPixels(width: number, height: number): () => void {
  const pixels = width * height
  if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > MAX_IMAGE_PIXELS_PER_LAYER
    || pixels > MAX_PROJECT_IMAGE_PIXELS - retainedDecodedPixels) {
    throw new Error('Image exceeds the retained decoded pixel limit')
  }
  retainedDecodedPixels += pixels
  let released = false
  return () => {
    if (released) return
    released = true
    retainedDecodedPixels -= pixels
  }
}

function readU16Be(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 256 + bytes[offset + 1]
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 256
}

function readU24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return undefined
    const marker = bytes[offset++]
    if (marker === 0xd9) return undefined
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return undefined
    const length = readU16Be(bytes, offset)
    if (length < 2 || offset + length > bytes.length) return undefined
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return undefined
      return { height: readU16Be(bytes, offset + 3), width: readU16Be(bytes, offset + 5) }
    }
    offset += length
  }
  return undefined
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP'
    || readU32Le(bytes, 4) + 8 !== bytes.length) return undefined
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4)
    const size = readU32Le(bytes, offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > bytes.length) return undefined
    if (kind === 'VP8X' && size === 10) return { width: readU24Le(bytes, start + 4) + 1, height: readU24Le(bytes, start + 7) + 1 }
    if (kind === 'VP8 ' && size >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      return { width: readU16Le(bytes, start + 6) & 0x3fff, height: readU16Le(bytes, start + 8) & 0x3fff }
    }
    if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
      const packed = readU32Le(bytes, start + 1)
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
    }
    offset = end + (size % 2)
  }
  return undefined
}

function structuralDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
  let dimensions: { width: number; height: number } | undefined
  if (mimeType === 'image/png') {
    try {
      dimensions = parsePortablePng(bytes, {
        maxWidth: MAX_IMAGE_DIMENSION,
        maxHeight: MAX_IMAGE_DIMENSION,
        maxPixels: MAX_IMAGE_PIXELS_PER_LAYER,
      })
    } catch {
      throw new Error('Image bytes have invalid structure or dimensions')
    }
  }
  else if (mimeType === 'image/jpeg') dimensions = jpegDimensions(bytes)
  else if (mimeType === 'image/webp') dimensions = webpDimensions(bytes)
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1
    || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width > MAX_IMAGE_PIXELS_PER_LAYER / dimensions.height) {
    throw new Error('Image bytes have invalid structure or dimensions')
  }
  return dimensions
}

/** Parse trusted dimensions from supported encoded bytes before invoking a browser decoder. */
export function inspectBoundedImageBytes(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
  const normalizedMime = mimeType.split(';')[0].trim().toLowerCase()
  if (!IMAGE_MIMES.has(normalizedMime)) throw new Error(`Unsupported image MIME: ${normalizedMime || 'missing'}`)
  return structuralDimensions(bytes, normalizedMime)
}

async function readResponseBytes(response: Response, signal?: AbortSignal): Promise<{ bytes: Uint8Array; release: () => void }> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_EMBEDDED_ASSET_BYTES) {
      throw new Error('Image exceeds the bounded byte limit')
    }
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Image response is not stream-readable')
  const declaredLength = declared === null ? undefined : Number(declared)
  const releaseReservations: Array<() => void> = []
  if (declaredLength !== undefined) releaseReservations.push(reserveImageBytes(declaredLength))
  const chunks: Uint8Array[] = []
  let total = 0
  const releaseAll = (): void => releaseReservations.splice(0).forEach((release) => release())
  const onAbort = (): void => { void reader.cancel(abortError()) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (signal?.aborted) { await reader.cancel(); throw abortError() }
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (value.byteLength > MAX_EMBEDDED_ASSET_BYTES - total) {
        await reader.cancel()
        throw new Error('Image exceeds the bounded byte limit')
      }
      if (declaredLength !== undefined && value.byteLength > declaredLength - total) {
        await reader.cancel()
        throw new Error('Image byte length does not match its response')
      }
      if (declaredLength === undefined) {
        try { releaseReservations.push(reserveImageBytes(value.byteLength)) } catch (error) {
          void reader.cancel()
          throw error
        }
      }
      total += value.byteLength
      chunks.push(value)
    }
    if (total < 1 || (declaredLength !== undefined && total !== declaredLength)) throw new Error('Image byte length does not match its response')
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { bytes, release: releaseAll }
  } catch (error) {
    releaseAll()
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function exactImageBytes(src: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string; release: () => void }> {
  if (src.startsWith('data:')) {
    const embedded = decodeBoundedDataUrl(src)
    return { bytes: embedded.bytes, mimeType: embedded.mimeType, release: reserveImageBytes(embedded.bytes.byteLength) }
  }
  const response = await fetch(src, { cache: 'no-store', redirect: 'error', credentials: 'same-origin', signal })
  if (response.status !== 200 || !response.ok) throw new Error(`Image fetch failed (${response.status})`)
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  return { ...(await readResponseBytes(response, signal)), mimeType }
}

/** Fetch, structurally verify, hash, and decode one immutable image payload. */
export async function loadContentBoundImage(
  src: string,
  expectedWidth: number,
  expectedHeight: number,
  options: { signal?: AbortSignal } = {},
): Promise<ContentBoundImage> {
  if (!Number.isInteger(expectedWidth) || !Number.isInteger(expectedHeight) || expectedWidth < 1 || expectedHeight < 1) {
    throw new Error('Declared image dimensions are invalid')
  }
  const releaseSlot = await acquireImageLoadSlot(options.signal)
  let releaseBytes: (() => void) | undefined
  let releasePixels: (() => void) | undefined
  try {
    const exact = await exactImageBytes(src, options.signal)
    const { bytes, mimeType } = exact
    releaseBytes = exact.release
    if (!IMAGE_MIMES.has(mimeType)) throw new Error(`Unsupported image MIME: ${mimeType || 'missing'}`)
    const dimensions = structuralDimensions(bytes, mimeType)
    if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
      throw new Error('Image bytes do not match declared dimensions')
    }
    releasePixels = reserveDecodedPixels(dimensions.width, dimensions.height)
    const sha256 = sha256HexSync(bytes)
    const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mimeType }))
    const image = new Image()
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { image.src = ''; reject(abortError()) }
        image.onload = () => { options.signal?.removeEventListener('abort', onAbort); resolve() }
        image.onerror = () => { options.signal?.removeEventListener('abort', onAbort); reject(new Error('Image content cannot be decoded')) }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        image.src = objectUrl
      })
      if (image.naturalWidth !== expectedWidth || image.naturalHeight !== expectedHeight) {
        throw new Error('Decoded image dimensions do not match verified bytes')
      }
    } finally {
      image.onload = null
      image.onerror = null
      URL.revokeObjectURL(objectUrl)
    }
    const releaseRetainedPixels = releasePixels
    releasePixels = undefined
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      image.onload = null
      image.onerror = null
      image.src = ''
      releaseRetainedPixels?.()
    }
    return {
      image,
      width: dimensions.width,
      height: dimensions.height,
      mimeType,
      byteLength: bytes.byteLength,
      sha256,
      receiptKey: `image/${mimeType}/${dimensions.width}x${dimensions.height}/sha256:${sha256}`,
      release,
    }
  } finally {
    releasePixels?.()
    releaseBytes?.()
    releaseSlot()
  }
}

export function visibleImageLayersForRuntime(area: Pick<LabelAreaConfig, 'layers'>): ImageLayer[] {
  return area.layers.filter((layer): layer is ImageLayer => layer.kind === 'image' && layer.visible)
}

export function loadAreaContentBoundImage(
  areaId: string,
  _activationRevision: number,
  layer: ImageLayer,
): Promise<ContentBoundImage> {
  const owner = `${areaId}\u0000${layer.id}`
  const source = sourceIdentity(layer.src, layer.naturalWidth, layer.naturalHeight)
  const identity = source
  const cached = areaImageLoads.get(owner)
  if (cached?.identity === identity) return cached.load
  if (cached) evictAreaImageOwner(owner, cached)
  beginImageAssetLoad(areaId, layer.id)
  const controller = new AbortController()
  const load = loadContentBoundImage(layer.src, layer.naturalWidth, layer.naturalHeight, { signal: controller.signal })
  const entry: AreaImageLoad = { identity, sourceIdentity: source, controller, load }
  areaImageLoads.set(owner, entry)
  void load.then((resource) => {
    if (areaImageLoads.get(owner) === entry) entry.resource = resource
    else resource.release()
  }, () => {
    if (areaImageLoads.get(owner) === entry) areaImageLoads.delete(owner)
  })
  return load
}

function evictAreaImageOwner(owner: string, entry: AreaImageLoad): void {
  entry.controller.abort()
  entry.resource?.release()
  if (areaImageLoads.get(owner) === entry) areaImageLoads.delete(owner)
  const separator = owner.indexOf('\u0000')
  if (separator >= 0) currentReceipts.get(owner.slice(0, separator))?.delete(owner.slice(separator + 1))
}

/** Abort and evict image work not required by the exact visible project layer set. */
export function syncImageAssetProject(areas: readonly Pick<LabelAreaConfig, 'id' | 'layers'>[]): void {
  const allowed = new Map<string, string>()
  for (const area of areas) for (const layer of visibleImageLayersForRuntime(area)) {
    allowed.set(`${area.id}\u0000${layer.id}`, sourceIdentity(layer.src, layer.naturalWidth, layer.naturalHeight))
  }
  for (const [owner, entry] of areaImageLoads) {
    if (allowed.get(owner) !== entry.sourceIdentity) evictAreaImageOwner(owner, entry)
  }
  for (const [areaId, receipts] of currentReceipts) {
    for (const [layerId, receipt] of receipts) {
      if (allowed.get(`${areaId}\u0000${layerId}`) !== receipt.sourceIdentity) receipts.delete(layerId)
    }
    if (receipts.size === 0) currentReceipts.delete(areaId)
  }
}

/** Explicit area/project disposal boundary; normal active-area switches must not call this. */
export function releaseImageAssetArea(areaId: string): void {
  const prefix = `${areaId}\u0000`
  for (const [owner, entry] of areaImageLoads) if (owner.startsWith(prefix)) evictAreaImageOwner(owner, entry)
  currentReceipts.delete(areaId)
}

/** Imported-project replacement boundary, including replacements that reuse ids and sources. */
export function resetImageAssetProject(): void {
  for (const [owner, entry] of [...areaImageLoads]) evictAreaImageOwner(owner, entry)
  currentReceipts.clear()
}
