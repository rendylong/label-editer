import {
  compareCodeUnitOrdinal,
  comparePortableLayerZOrder,
  orderedPortableLayers,
} from '../../scripts/lib/layer-order-core.mjs'

export interface LayerZOrder {
  id: string
  zIndex: number
}

/** Exact bottom-to-top comparator shared with immutable design review. */
export function compareLayerZOrder(left: LayerZOrder, right: LayerZOrder): number {
  return comparePortableLayerZOrder(left, right)
}

/** Exact top-to-bottom inverse used by layer-list controls. */
export function compareLayerZOrderDescending(left: LayerZOrder, right: LayerZOrder): number {
  return compareLayerZOrder(right, left)
}

/** Locale-independent ordinal comparison for ids and other canonical text. */
export function compareOrdinalText(left: string, right: string): number {
  return compareCodeUnitOrdinal(left, right)
}

/** Non-mutating exact bottom-to-top layer order with duplicate-id rejection. */
export function canonicalLayerOrder<T extends LayerZOrder>(layers: readonly T[]): T[] {
  return orderedPortableLayers(layers)
}

/** Non-mutating exact top-to-bottom inverse used by layer-list controls. */
export function canonicalLayerOrderDescending<T extends LayerZOrder>(layers: readonly T[]): T[] {
  return canonicalLayerOrder(layers).reverse()
}
