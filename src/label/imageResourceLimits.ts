export const MAX_IMAGE_LAYER_COUNT = 64
export const MAX_IMAGE_DIMENSION = 8192
export const MAX_IMAGE_PIXELS_PER_LAYER = 16 * 1024 * 1024
export const MAX_PROJECT_IMAGE_PIXELS = 32 * 1024 * 1024

export interface ImageResourceLayerLike {
  kind?: unknown
  type?: unknown
  naturalWidth?: unknown
  naturalHeight?: unknown
}

export interface ImageResourceAreaLike {
  layers: readonly ImageResourceLayerLike[]
}

export interface ImageResourceBudgetIssue {
  areaIndex: number
  layerIndex: number
  message: string
}

function isImageLayer(layer: ImageResourceLayerLike): boolean {
  return layer.kind === 'image' || layer.type === 'image'
}

/** Validate declarations before any encoded bytes or decoded browser resources are allocated. */
export function imageResourceBudgetIssue(areas: readonly ImageResourceAreaLike[]): ImageResourceBudgetIssue | undefined {
  let count = 0
  let aggregatePixels = 0
  for (const [areaIndex, area] of areas.entries()) {
    for (const [layerIndex, layer] of area.layers.entries()) {
      if (!isImageLayer(layer)) continue
      count += 1
      if (count > MAX_IMAGE_LAYER_COUNT) {
        return { areaIndex, layerIndex, message: `Image layer count exceeds ${MAX_IMAGE_LAYER_COUNT}` }
      }
      const width = layer.naturalWidth
      const height = layer.naturalHeight
      if (width === undefined || height === undefined) continue
      if (!Number.isInteger(width) || !Number.isInteger(height)
        || (width as number) < 1 || (height as number) < 1
        || (width as number) > MAX_IMAGE_DIMENSION || (height as number) > MAX_IMAGE_DIMENSION
        || (width as number) > MAX_IMAGE_PIXELS_PER_LAYER / (height as number)) {
        return { areaIndex, layerIndex, message: 'Image dimensions exceed the per-layer decoded pixel limit' }
      }
      aggregatePixels += (width as number) * (height as number)
      if (aggregatePixels > MAX_PROJECT_IMAGE_PIXELS) {
        return { areaIndex, layerIndex, message: 'Aggregate image decoded pixel budget exceeded' }
      }
    }
  }
  return undefined
}
