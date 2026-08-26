import type { LabelAreaConfig, LabelLayer } from './types'

const rendererProvenWhiteUnderbase = new WeakSet<HTMLCanvasElement>()
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

function rasterHasSelectivePixels(canvas: HTMLCanvasElement): boolean {
  const width = canvas.width
  const height = canvas.height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return false
    const rowsPerChunk = Math.max(1, Math.floor(MAX_SCAN_PIXELS_PER_CHUNK / width))
    for (let y = 0; y < height; y += rowsPerChunk) {
      const chunkHeight = Math.min(rowsPerChunk, height - y)
      const pixels = context.getImageData(0, y, width, chunkHeight).data
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] > 0 && (pixels[offset] > 0 || pixels[offset + 1] > 0 || pixels[offset + 2] > 0)) {
          return true
        }
      }
    }
  } catch {
    return false
  }
  return false
}

/** Called only by the production mask renderer after every contributor completed. */
export function proveRenderedWhiteUnderbase(canvas: HTMLCanvasElement): boolean {
  if (!rasterHasSelectivePixels(canvas)) {
    rendererProvenWhiteUnderbase.delete(canvas)
    return false
  }
  rendererProvenWhiteUnderbase.add(canvas)
  return true
}

export function isRendererProvenWhiteUnderbase(canvas: HTMLCanvasElement | undefined): canvas is HTMLCanvasElement {
  return canvas !== undefined && rendererProvenWhiteUnderbase.has(canvas)
}
