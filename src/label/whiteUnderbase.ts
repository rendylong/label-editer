import type { LabelAreaConfig, LabelLayer } from './types'

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
