import type { LabelLayer } from './types'
import { compareLayerZOrder, compareLayerZOrderDescending } from './layerOrder'

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
  const sorted = [...layers].sort(compareLayerZOrder)
  const index = sorted.findIndex((layer) => layer.id === id)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= sorted.length) return layers
  const target = sorted[index]
  const neighbor = sorted[nextIndex]
  if (target.locked || neighbor.locked) return layers
  sorted[index] = { ...target, zIndex: neighbor.zIndex }
  sorted[nextIndex] = { ...neighbor, zIndex: target.zIndex }
  return sorted
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
  const visual = [...layers].sort(compareLayerZOrderDescending)
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

  const zIndices = visual.map((layer) => layer.zIndex)
  const zById = new Map(reordered.map((layer, index) => [layer.id, zIndices[index]]))
  return layers.map((layer) => {
    const zIndex = zById.get(layer.id)
    return zIndex === undefined || Object.is(zIndex, layer.zIndex) ? layer : { ...layer, zIndex }
  })
}
