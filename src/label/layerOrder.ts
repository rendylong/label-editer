export interface LayerZOrder {
  id: string
  zIndex: number
}

/** Exact bottom-to-top comparator shared with immutable design review. */
export function compareLayerZOrder(left: LayerZOrder, right: LayerZOrder): number {
  return left.zIndex - right.zIndex || left.id.localeCompare(right.id)
}

/** Exact top-to-bottom inverse used by layer-list controls. */
export function compareLayerZOrderDescending(left: LayerZOrder, right: LayerZOrder): number {
  return compareLayerZOrder(right, left)
}
