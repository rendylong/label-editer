import type { LabelAreaConfig, LabelLayer } from './types'

const MAX_SCAN_PIXELS_PER_CHUNK = 256 * 1024

export function declaresWhiteUnderbase(layer: LabelLayer): boolean {
  return (layer.processes ?? []).some(
    (process) => process.process === 'white_underbase' || process.requiredMask === 'white_underbase',
  )
}

/** Conservative intent check used before allocating or publishing a separation. */
export function canRenderMaskLayer(layer: LabelLayer): boolean {
  if (!layer.visible || layer.opacity <= 0) return false
  if (layer.kind === 'text') return layer.text.trim().length > 0 && layer.fontSize > 0 && (layer.width === undefined || layer.width > 0)
  if (layer.kind === 'image') return layer.src.trim().length > 0 && layer.width > 0 && layer.height > 0
  return layer.width > 0 && layer.height > 0
}

export function isRenderableWhiteUnderbaseLayer(layer: LabelLayer): boolean {
  return canRenderMaskLayer(layer) && declaresWhiteUnderbase(layer)
}

export function hasRenderableWhiteUnderbaseDeclaration(
  area: Pick<LabelAreaConfig, 'carrier' | 'layers'>,
): boolean {
  return area.carrier !== 'bare' && area.layers.some(isRenderableWhiteUnderbaseLayer)
}

type WhiteUnderbaseIntentArea = Pick<
  LabelAreaConfig,
  'id' | 'carrier' | 'substrate' | 'paper' | 'legacyPaperCarrier' | 'layers' | 'fonts'
>

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  )
}

/** Exact stable key for the current visible white-underbase contributor intent. */
export function whiteUnderbaseIntentKey(area: WhiteUnderbaseIntentArea): string {
  return JSON.stringify(canonicalValue({
    areaId: area.id,
    carrier: area.carrier,
    substrate: area.substrate,
    paper: area.paper,
    legacyPaperCarrier: area.legacyPaperCarrier,
    fonts: area.fonts,
    layers: area.carrier === 'bare' ? [] : area.layers.filter(isRenderableWhiteUnderbaseLayer),
  }))
}

export interface WhiteUnderbaseRasterSignature {
  key: string
  hasSelectivePixels: boolean
}

/**
 * Reads every RGBA pixel while bounding each getImageData allocation to at
 * most 256K pixels. The four independent 32-bit accumulators make mutation
 * checks deterministic without retaining a second 64 MiB 4096-class raster.
 */
export function readWhiteUnderbaseRasterSignature(canvas: HTMLCanvasElement): WhiteUnderbaseRasterSignature | undefined {
  const width = canvas.width
  const height = canvas.height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return undefined
    let hashA = (0x811c9dc5 ^ width) >>> 0
    let hashB = (0x9e3779b9 ^ height) >>> 0
    let hashC = (0x85ebca6b ^ (width * 31 + height)) >>> 0
    let hashD = (0xc2b2ae35 ^ (height * 31 + width)) >>> 0
    let hasSelectivePixels = false
    const rowsPerChunk = Math.max(1, Math.floor(MAX_SCAN_PIXELS_PER_CHUNK / width))
    for (let y = 0; y < height; y += rowsPerChunk) {
      const chunkHeight = Math.min(rowsPerChunk, height - y)
      const pixels = context.getImageData(0, y, width, chunkHeight).data
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const rgba = (
          pixels[offset]
          | (pixels[offset + 1] << 8)
          | (pixels[offset + 2] << 16)
          | (pixels[offset + 3] << 24)
        ) >>> 0
        const pixelIndex = y * width + (offset >>> 2)
        hashA = Math.imul(hashA ^ rgba, 0x01000193) >>> 0
        hashB = Math.imul(hashB ^ ((rgba + pixelIndex) >>> 0), 0x27d4eb2d) >>> 0
        hashC = (Math.imul(hashC ^ (rgba >>> 16), 0x85ebca6b) + rgba) >>> 0
        hashD = (Math.imul(hashD ^ ((rgba << 7) | (rgba >>> 25)), 0xc2b2ae35) + pixelIndex) >>> 0
        if (pixels[offset + 3] > 0 && (pixels[offset] > 0 || pixels[offset + 1] > 0 || pixels[offset + 2] > 0)) {
          hasSelectivePixels = true
        }
      }
    }
    const hex = (value: number): string => value.toString(16).padStart(8, '0')
    return {
      key: `${width}x${height}:${hex(hashA)}${hex(hashB)}${hex(hashC)}${hex(hashD)}`,
      hasSelectivePixels,
    }
  } catch {
    return undefined
  }
}
