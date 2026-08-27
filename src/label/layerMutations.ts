import type { LabelLayer } from './types'
import { canonicalLayerOrder, canonicalLayerOrderDescending } from './layerOrder'

function nextFiniteUp(value: number): number | undefined {
  if (value === Number.POSITIVE_INFINITY) return undefined
  if (value === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE
  if (Object.is(value, -0) || value === 0) return Number.MIN_VALUE
  const buffer = new ArrayBuffer(8)
  const number = new Float64Array(buffer)
  const bits = new BigUint64Array(buffer)
  number[0] = value
  bits[0] += value > 0 ? 1n : -1n
  return Number.isFinite(number[0]) ? number[0] : undefined
}

function nextFiniteDown(value: number): number | undefined {
  const next = nextFiniteUp(-value)
  return next === undefined ? undefined : -next
}

function finiteSequence(
  count: number,
  lowerExclusive: number | undefined,
  upperExclusive: number | undefined,
): number[] | undefined {
  if (count === 0) return []
  if (lowerExclusive === undefined && upperExclusive === undefined) {
    return Array.from({ length: count }, (_, index) => index)
  }
  if (lowerExclusive === undefined) {
    const reversed: number[] = []
    let cursor = upperExclusive!
    for (let index = 0; index < count; index += 1) {
      const next = nextFiniteDown(cursor)
      if (next === undefined) return undefined
      reversed.push(next)
      cursor = next
    }
    return reversed.reverse()
  }
  if (upperExclusive === undefined) {
    const values: number[] = []
    let cursor = lowerExclusive
    for (let index = 0; index < count; index += 1) {
      const next = nextFiniteUp(cursor)
      if (next === undefined) return undefined
      values.push(next)
      cursor = next
    }
    return values
  }
  if (lowerExclusive > upperExclusive) return undefined
  if (lowerExclusive === upperExclusive) return Array.from({ length: count }, () => lowerExclusive)

  const interpolated = Array.from({ length: count }, (_, index) => {
    const ratio = (index + 1) / (count + 1)
    return lowerExclusive * (1 - ratio) + upperExclusive * ratio
  })
  if (interpolated.every((value, index) => (
    Number.isFinite(value)
    && value > (index === 0 ? lowerExclusive : interpolated[index - 1])
    && value < upperExclusive
  ))) return interpolated

  const values: number[] = []
  let cursor = lowerExclusive
  for (let index = 0; index < count; index += 1) {
    const next = nextFiniteUp(cursor)
    if (next === undefined || next >= upperExclusive) return undefined
    values.push(next)
    cursor = next
  }
  return values
}

function orderMatches(layers: LabelLayer[], expected: readonly LabelLayer[]): boolean {
  return canonicalLayerOrder(layers).every((layer, index) => layer.id === expected[index]?.id)
}

function applyZById(layers: LabelLayer[], zById: Map<string, number>): LabelLayer[] {
  return layers.map((layer) => {
    const zIndex = zById.get(layer.id)
    return zIndex === undefined || Object.is(zIndex, layer.zIndex) ? layer : { ...layer, zIndex }
  })
}

/** Encodes a requested visual order into finite z values without mutating locked layers. */
function encodeCanonicalOrder(layers: LabelLayer[], desiredBottomToTop: LabelLayer[]): LabelLayer[] {
  const current = canonicalLayerOrder(layers)
  const existingZ = current.map((layer) => layer.zIndex)
  const reassigned = new Map(desiredBottomToTop.map((layer, index) => [layer.id, existingZ[index]]))
  if (current.every((layer) => !layer.locked || Object.is(reassigned.get(layer.id), layer.zIndex))) {
    const candidate = applyZById(layers, reassigned)
    if (orderMatches(candidate, desiredBottomToTop)) return candidate
  }

  const canonicalZ = new Map<string, number>()
  let index = 0
  while (index < desiredBottomToTop.length) {
    const layer = desiredBottomToTop[index]
    if (layer.locked) {
      canonicalZ.set(layer.id, layer.zIndex)
      index += 1
      continue
    }
    const start = index
    while (index < desiredBottomToTop.length && !desiredBottomToTop[index].locked) index += 1
    const lower = start > 0 ? desiredBottomToTop[start - 1].zIndex : undefined
    const upper = index < desiredBottomToTop.length ? desiredBottomToTop[index].zIndex : undefined
    const values = finiteSequence(index - start, lower, upper)
    if (!values) return layers
    for (let offset = 0; offset < values.length; offset += 1) {
      canonicalZ.set(desiredBottomToTop[start + offset].id, values[offset])
    }
  }
  const candidate = applyZById(layers, canonicalZ)
  return orderMatches(candidate, desiredBottomToTop) ? candidate : layers
}

export function patchUnlockedLayer(layers: LabelLayer[], id: string, patch: Partial<LabelLayer>): LabelLayer[] {
  const target = layers.find((layer) => layer.id === id)
  if (!target || target.locked) return layers
  return layers.map((layer) => (layer.id === id ? ({ ...layer, ...patch } as LabelLayer) : layer))
}

export function removeUnlockedLayer(layers: LabelLayer[], id: string): LabelLayer[] {
  const target = layers.find((layer) => layer.id === id)
  if (!target || target.locked) return layers
  return layers.filter((layer) => layer.id !== id)
}

export function duplicateUnlockedLayer(layers: LabelLayer[], id: string, copyId: string): LabelLayer[] {
  const target = layers.find((layer) => layer.id === id)
  if (!target || target.locked || layers.some((layer) => layer.id === copyId)) return layers
  const copy = {
    ...target,
    id: copyId,
    x: target.x + 30,
    y: target.y + 30,
    zIndex: Math.max(-1, ...layers.map((layer) => layer.zIndex)) + 1,
  } as LabelLayer
  return [...layers, copy]
}

export function moveUnlockedLayer(layers: LabelLayer[], id: string, direction: -1 | 1): LabelLayer[] {
  const sorted = canonicalLayerOrder(layers)
  const index = sorted.findIndex((layer) => layer.id === id)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= sorted.length) return layers
  const target = sorted[index]
  const neighbor = sorted[nextIndex]
  if (target.locked || neighbor.locked) return layers
  const desired = [...sorted]
  desired[index] = neighbor
  desired[nextIndex] = target
  return encodeCanonicalOrder(layers, desired)
}

export type LayerDropPlacement = 'before' | 'after'

/** Reorders the visual top-to-bottom stack without allowing locked barriers to be crossed. */
export function reorderUnlockedLayer(
  layers: LabelLayer[],
  draggedId: string,
  targetId: string,
  placement: LayerDropPlacement,
): LabelLayer[] {
  if (draggedId === targetId) return layers
  const visual = canonicalLayerOrderDescending(layers)
  const sourceIndex = visual.findIndex((layer) => layer.id === draggedId)
  const targetIndex = visual.findIndex((layer) => layer.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0 || visual[sourceIndex].locked || visual[targetIndex].locked) return layers
  const crossed = visual.slice(Math.min(sourceIndex, targetIndex), Math.max(sourceIndex, targetIndex) + 1)
  if (crossed.some((layer) => layer.id !== draggedId && layer.locked)) return layers

  const reordered = [...visual]
  const [source] = reordered.splice(sourceIndex, 1)
  const adjustedTargetIndex = reordered.findIndex((layer) => layer.id === targetId)
  const insertionIndex = adjustedTargetIndex + (placement === 'after' ? 1 : 0)
  reordered.splice(insertionIndex, 0, source)
  if (reordered.every((layer, index) => layer.id === visual[index].id)) return layers

  return encodeCanonicalOrder(layers, [...reordered].reverse())
}
