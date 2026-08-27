import { compileBlueprintToSpecAreas } from './blueprintCompiler'
import type { LayoutBlueprintV1 } from './designContracts'
import { canonicalFontStack } from '../label/fontStack'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneOrNull(value: unknown): unknown {
  return value === undefined ? null : structuredClone(value)
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizedFontStack(value: unknown): string[] | null {
  return Array.isArray(value) ? canonicalFontStack(value as string[]) : null
}

function layerProjection(layer: UnknownRecord, version: unknown): UnknownRecord {
  const kind = version === 2 ? layer.type : layer.kind
  const fontStack = normalizedFontStack(layer.fontStack)
  // Project pixel coordinates and dimensions are derived from the physical
  // designMetrics plus its current canvas. Keep the physical facts here; the
  // canvas/remap/axis inputs are bound independently by the production target projection.
  const common: UnknownRecord = {
    id: layer.id,
    kind,
    rotation: finite(layer.rotation),
    opacity: finite(layer.opacity),
    visible: layer.visible ?? null,
    craft: cloneOrNull(Array.isArray(layer.craft) ? layer.craft : []),
    designMetrics: cloneOrNull(layer.designMetrics),
    processes: cloneOrNull(Array.isArray(layer.processes) ? layer.processes : []),
  }
  if (kind === 'text') {
    return {
      ...common,
      text: layer.text,
      fontFamily: fontStack?.[0] ?? layer.fontFamily ?? null,
      fontStack,
      fontWeight: layer.fontWeight ?? null,
      color: layer.color ?? null,
      align: layer.align ?? null,
      italic: layer.italic ?? false,
      direction: layer.direction ?? 'horizontal',
      writingDirection: layer.writingDirection ?? null,
      language: layer.language ?? null,
    }
  }
  if (kind === 'image') {
    return {
      ...common,
      asset: version === 2 ? layer.asset ?? null : layer.src ?? null,
    }
  }
  if (kind === 'shape') {
    return {
      ...common,
      shape: layer.shape ?? null,
      geometry: cloneOrNull(isRecord(layer.geometry) ? layer.geometry : {}),
      fill: layer.fill ?? null,
      stroke: layer.stroke ?? null,
      pathData: layer.pathData ?? null,
      pathViewBox: cloneOrNull(layer.pathViewBox),
      fillRule: layer.fillRule ?? null,
    }
  }
  return common
}

function orderedLayers(area: UnknownRecord, version: unknown): UnknownRecord[] {
  const layers = Array.isArray(area.layers) ? area.layers.filter(isRecord) : []
  if (version !== 3) return layers
  return layers.map((layer, index) => ({ layer, index, zIndex: finite(layer.zIndex) ?? index }))
    .sort((left, right) => left.zIndex - right.zIndex || left.index - right.index)
    .map(({ layer }) => layer)
}

function areaProjection(area: UnknownRecord, version: unknown): UnknownRecord {
  const globalCraft = version === 3 && isRecord(area.globalCraft)
    ? area.globalCraft.craft
    : area.globalCraft
  return {
    id: area.blueprintAreaId ?? area.id,
    side: area.side ?? null,
    carrier: area.carrier ?? null,
    artboard: cloneOrNull(area.artboard),
    substrate: cloneOrNull(area.substrate),
    globalCraft: cloneOrNull(Array.isArray(globalCraft) ? globalCraft : []),
    layers: orderedLayers(area, version).map((layer) => layerProjection(layer, version)),
  }
}

function stableAreas(areas: UnknownRecord[], version: unknown): UnknownRecord[] {
  return areas.map((area) => areaProjection(area, version))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

export function canonicalDocumentDesignProjection(document: unknown): UnknownRecord {
  if (!isRecord(document)) return { version: null, areas: [] }
  const areas = Array.isArray(document.areas) ? document.areas.filter(isRecord) : []
  return { areas: stableAreas(areas, document.version) }
}

export function canonicalApprovedBlueprintDesignProjection(blueprint: LayoutBlueprintV1): UnknownRecord {
  const compiled = compileBlueprintToSpecAreas(blueprint).map((area) => {
    const source = blueprint.areas.find((candidate) => candidate.id === area.blueprintAreaId)!
    return { ...area, side: source.side }
  })
  return canonicalDocumentDesignProjection({ version: 2, areas: compiled })
}
