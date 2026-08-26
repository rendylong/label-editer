import { uploadedFontRecord } from './fontRuntime'
import { resolveCarrierSurface } from './paper'
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
  | 'id'
  | 'carrier'
  | 'substrate'
  | 'paper'
  | 'legacyPaperCarrier'
  | 'canvas'
  | 'artboard'
  | 'placementPolicy'
  | 'designBinding'
  | 'layers'
  | 'fonts'
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

function stableText(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function whiteProcessProjection(layer: LabelLayer): unknown[] {
  return (layer.processes ?? [])
    .filter((process) => process.process === 'white_underbase' || process.requiredMask === 'white_underbase')
    .map((process) => ({
      process: process.process,
      requiredMask: process.requiredMask,
    }))
    .sort((left, right) => compareText(stableText(left), stableText(right)))
}

function contributorProjection(layer: LabelLayer): unknown {
  const common = {
    id: layer.id,
    kind: layer.kind,
    zIndex: layer.zIndex,
    x: layer.x,
    y: layer.y,
    rotation: layer.rotation,
    opacity: layer.opacity,
    designMetrics: layer.designMetrics,
    whiteProcesses: whiteProcessProjection(layer),
  }
  if (layer.kind === 'text') {
    return {
      ...common,
      text: layer.text,
      fontFamily: layer.fontFamily,
      fontSize: layer.fontSize,
      fontWeight: layer.fontWeight,
      letterSpacing: layer.letterSpacing,
      lineHeight: layer.lineHeight,
      width: layer.width,
      align: layer.align,
      italic: layer.italic,
      direction: layer.direction,
      writingDirection: layer.writingDirection,
    }
  }
  if (layer.kind === 'image') {
    return {
      ...common,
      src: layer.src,
      width: layer.width,
      height: layer.height,
    }
  }
  return {
    ...common,
    shape: layer.shape,
    geometry: layer.geometry,
    pathData: layer.pathData,
    pathViewBox: layer.pathViewBox,
    fillRule: layer.fillRule,
    width: layer.width,
    height: layer.height,
    strokeWidth: layer.strokeWidth,
    cornerRadius: layer.cornerRadius,
  }
}

/** Exact stable key for only the state that can affect the current white raster. */
export function whiteUnderbaseIntentKey(area: WhiteUnderbaseIntentArea): string {
  const contributors = area.carrier === 'bare'
    ? []
    : area.layers
        .filter(isRenderableWhiteUnderbaseLayer)
        .map(contributorProjection)
        .sort((left, right) => {
          const leftLayer = left as { zIndex: number; id: string }
          const rightLayer = right as { zIndex: number; id: string }
          return leftLayer.zIndex - rightLayer.zIndex || compareText(leftLayer.id, rightLayer.id)
        })
  const usedFonts = new Map<string, { name: string; dataUrl: string }>()
  for (const layer of area.layers) {
    if (layer.kind !== 'text' || !isRenderableWhiteUnderbaseLayer(layer)) continue
    const record = uploadedFontRecord(layer.fontFamily, area.fonts)
    if (record) usedFonts.set(`${record.name}\u0000${record.dataUrl}`, { name: record.name, dataUrl: record.dataUrl })
  }
  const surface = resolveCarrierSurface(area)
  return JSON.stringify(canonicalValue({
    areaId: area.id,
    carrier: surface.carrier,
    renderDecoration: surface.renderDecoration,
    substrateBacked: surface.carrier === 'legacy' || surface.substrateVisible,
    canvas: area.canvas,
    physicalLayout: {
      artboard: area.artboard ? { widthMm: area.artboard.widthMm, heightMm: area.artboard.heightMm } : undefined,
      placementPolicy: area.placementPolicy,
      approvedCrop: area.designBinding?.approvedCrop,
    },
    contributors,
    usedFonts: [...usedFonts.values()].sort((left, right) => (
      compareText(left.name, right.name) || compareText(left.dataUrl, right.dataUrl)
    )),
  }))
}

export interface WhiteUnderbaseRasterSignature {
  key: string
  hasSelectivePixels: boolean
}

export interface WhiteUnderbaseRasterSnapshot extends WhiteUnderbaseRasterSignature {
  canvas: HTMLCanvasElement
}

/**
 * Reads every RGBA pixel while bounding each getImageData allocation to at
 * most 256K pixels. The four independent 32-bit accumulators make mutation
 * checks deterministic. Signature-only callers retain no second raster;
 * artifact callers deliberately copy the verified chunks for immutable PNG encoding.
 */
function scanWhiteUnderbaseRaster(
  canvas: HTMLCanvasElement,
  copy: boolean,
): WhiteUnderbaseRasterSignature | WhiteUnderbaseRasterSnapshot | undefined {
  const width = canvas.width
  const height = canvas.height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return undefined
    const snapshot = copy ? document.createElement('canvas') : undefined
    if (snapshot) {
      snapshot.width = width
      snapshot.height = height
    }
    const snapshotContext = snapshot?.getContext('2d')
    if (snapshot && !snapshotContext) return undefined
    let hashA = (0x811c9dc5 ^ width) >>> 0
    let hashB = (0x9e3779b9 ^ height) >>> 0
    let hashC = (0x85ebca6b ^ (width * 31 + height)) >>> 0
    let hashD = (0xc2b2ae35 ^ (height * 31 + width)) >>> 0
    let hasSelectivePixels = false
    const rowsPerChunk = Math.max(1, Math.floor(MAX_SCAN_PIXELS_PER_CHUNK / width))
    for (let y = 0; y < height; y += rowsPerChunk) {
      const chunkHeight = Math.min(rowsPerChunk, height - y)
      const image = context.getImageData(0, y, width, chunkHeight)
      const pixels = image.data
      snapshotContext?.putImageData(image, 0, y)
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
    const signature = {
      key: `${width}x${height}:${hex(hashA)}${hex(hashB)}${hex(hashC)}${hex(hashD)}`,
      hasSelectivePixels,
    }
    return snapshot ? { ...signature, canvas: snapshot } : signature
  } catch {
    return undefined
  }
}

export function readWhiteUnderbaseRasterSignature(canvas: HTMLCanvasElement): WhiteUnderbaseRasterSignature | undefined {
  return scanWhiteUnderbaseRaster(canvas, false)
}

/** Copies the exact RGBA chunks used to calculate the returned signature. */
export function snapshotWhiteUnderbaseRaster(canvas: HTMLCanvasElement): WhiteUnderbaseRasterSnapshot | undefined {
  return scanWhiteUnderbaseRaster(canvas, true) as WhiteUnderbaseRasterSnapshot | undefined
}
