import { parsePortablePng } from '../../scripts/lib/png-core.mjs'
import { sha256HexSync } from '../agent/syncSha256'
import { decodeBoundedDataUrl, MAX_EMBEDDED_ASSET_BYTES } from './boundedAssetBytes'

const MAX_IMAGE_DIMENSION = 8192
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export interface ContentBoundImage {
  image: HTMLImageElement
  width: number
  height: number
  mimeType: string
  byteLength: number
  sha256: string
  receiptKey: string
}

interface CurrentImageReceipt {
  sourceIdentity: string
  receiptKey: string
}

const currentReceipts = new Map<string, Map<string, CurrentImageReceipt>>()

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
  if (mimeType === 'image/png') dimensions = parsePortablePng(bytes, {
    maxWidth: MAX_IMAGE_DIMENSION,
    maxHeight: MAX_IMAGE_DIMENSION,
    maxPixels: MAX_IMAGE_PIXELS,
  })
  else if (mimeType === 'image/jpeg') dimensions = jpegDimensions(bytes)
  else if (mimeType === 'image/webp') dimensions = webpDimensions(bytes)
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1
    || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width > MAX_IMAGE_PIXELS / dimensions.height) {
    throw new Error('Image bytes have invalid structure or dimensions')
  }
  return dimensions
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_EMBEDDED_ASSET_BYTES) {
      throw new Error('Image exceeds the bounded byte limit')
    }
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Image response is not stream-readable')
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    if (value.byteLength > MAX_EMBEDDED_ASSET_BYTES - total) {
      await reader.cancel()
      throw new Error('Image exceeds the bounded byte limit')
    }
    total += value.byteLength
    chunks.push(value)
  }
  if (total < 1 || (declared !== null && total !== Number(declared))) throw new Error('Image byte length does not match its response')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

async function exactImageBytes(src: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (src.startsWith('data:')) {
    const embedded = decodeBoundedDataUrl(src)
    return { bytes: embedded.bytes, mimeType: embedded.mimeType }
  }
  const response = await fetch(src, { cache: 'no-store', redirect: 'error', credentials: 'same-origin' })
  if (response.status !== 200 || !response.ok) throw new Error(`Image fetch failed (${response.status})`)
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  return { bytes: await readResponseBytes(response), mimeType }
}

/** Fetch, structurally verify, hash, and decode one immutable image payload. */
export async function loadContentBoundImage(src: string, expectedWidth: number, expectedHeight: number): Promise<ContentBoundImage> {
  if (!Number.isInteger(expectedWidth) || !Number.isInteger(expectedHeight) || expectedWidth < 1 || expectedHeight < 1) {
    throw new Error('Declared image dimensions are invalid')
  }
  const { bytes, mimeType } = await exactImageBytes(src)
  if (!IMAGE_MIMES.has(mimeType)) throw new Error(`Unsupported image MIME: ${mimeType || 'missing'}`)
  const dimensions = structuralDimensions(bytes, mimeType)
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw new Error('Image bytes do not match declared dimensions')
  }
  const sha256 = sha256HexSync(bytes)
  const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mimeType }))
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Image content cannot be decoded'))
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
  return {
    image,
    width: dimensions.width,
    height: dimensions.height,
    mimeType,
    byteLength: bytes.byteLength,
    sha256,
    receiptKey: `image/${mimeType}/${dimensions.width}x${dimensions.height}/sha256:${sha256}`,
  }
}
