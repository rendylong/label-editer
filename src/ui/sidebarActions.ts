import { createLayerFromPreset, ELEMENT_PRESETS, type ElementPreset, type ElementPresetCategory } from '../label/elementPresets'
import type { LabelAreaConfig, LabelLayer } from '../label/types'
import { useLabelStore } from '../state/stores'

export type ElementCategoryFilter = ElementPresetCategory | 'all'
export type AreaDeleteIntent = 'delete' | 'confirm'

export function filterElementPresets(category: ElementCategoryFilter, query: string): ElementPreset[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return ELEMENT_PRESETS.filter((preset) => {
    if (category !== 'all' && preset.category !== category) return false
    if (!normalizedQuery) return true
    return `${preset.name} ${preset.id}`.toLocaleLowerCase().includes(normalizedQuery)
  })
}

export function addElementPreset(presetId: string): string | null {
  const state = useLabelStore.getState()
  const area = state.activeArea
  if (!area) return null
  const layer = createLayerFromPreset(presetId, area)
  state.applyAreaOp(area.id, (config) => ({ ...config, layers: [...config.layers, layer] }))
  useLabelStore.getState().selectLayers([layer.id])
  return layer.id
}

export function getAreaDeleteIntent(area: LabelAreaConfig): AreaDeleteIntent {
  return area.layers.length === 0 ? 'delete' : 'confirm'
}

export function deleteSelectedLayers(): number {
  const state = useLabelStore.getState()
  const area = state.activeArea
  if (!area) return 0
  const selectedIds = new Set(state.selectedLayerIds)
  const deletableIds = new Set(area.layers.filter((layer) => selectedIds.has(layer.id) && !layer.locked).map((layer) => layer.id))
  if (deletableIds.size === 0) return 0
  state.applyAreaOp(area.id, (config) => ({ ...config, layers: config.layers.filter((layer) => !deletableIds.has(layer.id)) }))
  return deletableIds.size
}

let duplicateSequence = 0

function nextDuplicateId(existing: Set<string>): string {
  let id = ''
  do {
    const uuid = globalThis.crypto?.randomUUID?.()
    id = uuid ? `layer-${uuid}` : `layer-copy-${Date.now().toString(36)}-${++duplicateSequence}`
  } while (existing.has(id))
  existing.add(id)
  return id
}

export function duplicateSelectedLayers(): string[] {
  const state = useLabelStore.getState()
  const area = state.activeArea
  if (!area) return []
  const selectedIds = new Set(state.selectedLayerIds)
  const originals = area.layers.filter((layer) => selectedIds.has(layer.id) && !layer.locked)
  if (originals.length === 0) return []
  const existingIds = new Set(area.layers.map((layer) => layer.id))
  const baseZIndex = Math.max(-1, ...area.layers.map((layer) => layer.zIndex))
  const copies = originals.map((layer, index) => ({
    ...layer,
    id: nextDuplicateId(existingIds),
    x: layer.x + 30,
    y: layer.y + 30,
    zIndex: baseZIndex + index + 1,
  } as LabelLayer))
  state.applyAreaOp(area.id, (config) => ({ ...config, layers: [...config.layers, ...copies] }))
  useLabelStore.getState().selectLayers(copies.map((layer) => layer.id))
  return copies.map((layer) => layer.id)
}
