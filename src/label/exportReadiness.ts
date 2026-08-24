import { deriveDesignFontRequests } from './fontRuntime'
import type { LabelAreaConfig } from './types'

/** Stable identity for the visible font assets a baked area was drawn with. */
export function designFontReadinessKey(area: Pick<LabelAreaConfig, 'layers' | 'fonts'>): string {
  return deriveDesignFontRequests(
    area.layers.filter((layer) => layer.visible),
    area.fonts,
  ).map((request) => request.key).join('|')
}
