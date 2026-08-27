function assertPortableLayerOrderValue(layer) {
  if (!layer || typeof layer !== 'object') throw new TypeError('Layer order entry must be an object')
  if (typeof layer.id !== 'string' || layer.id.length === 0) throw new TypeError('Layer order id must be a non-empty string')
  if (typeof layer.zIndex !== 'number' || !Number.isFinite(layer.zIndex)) throw new RangeError('Layer zIndex must be finite')
}

/** Locale-independent UTF-16/code-unit ordinal comparison. */
export function compareCodeUnitOrdinal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') throw new TypeError('Ordinal values must be strings')
  return left < right ? -1 : left > right ? 1 : 0
}

/** Exact bottom-to-top `(zIndex,id)` comparator shared by browser and Node. */
export function comparePortableLayerZOrder(left, right) {
  assertPortableLayerOrderValue(left)
  assertPortableLayerOrderValue(right)
  if (left.zIndex < right.zIndex) return -1
  if (left.zIndex > right.zIndex) return 1
  return compareCodeUnitOrdinal(left.id, right.id)
}

/** Returns a new canonical array and rejects ambiguous duplicate identities. */
export function orderedPortableLayers(layers) {
  if (!Array.isArray(layers)) throw new TypeError('Layer order input must be an array')
  const seen = new Set()
  for (const layer of layers) {
    assertPortableLayerOrderValue(layer)
    if (seen.has(layer.id)) throw new TypeError(`Duplicate layer id: ${layer.id}`)
    seen.add(layer.id)
  }
  return [...layers].sort(comparePortableLayerZOrder)
}
