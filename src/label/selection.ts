import type { LabelAreaConfig, LabelLayer } from './types'

export type LayerAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributionAxis = 'horizontal' | 'vertical'

export interface LayerNodeTransform {
  id: string
  x: number
  y: number
  /** Konva node rotation, including the renderer's vertical-text base rotation. */
  rotation: number
  scaleX: number
  scaleY: number
  /** Text layout width before the Konva transform, including legacy natural-width text. */
  baseWidth?: number
}

export type AreaMutationGateway = (
  areaId: string,
  updater: (area: LabelAreaConfig) => LabelAreaConfig,
) => void

function normalizedScale(value: number): number {
  const absolute = Math.abs(value)
  return Math.abs(absolute - 1) < 1e-9 ? 1 : absolute
}

/** Reduces one completed click from the latest selection state. */
export function nextLayerSelection(current: string[], clickedId: string | null, shiftKey: boolean): string[] {
  if (clickedId === null) return []
  if (!shiftKey) return [clickedId]
  return current.includes(clickedId)
    ? current.filter((id) => id !== clickedId)
    : [...current, clickedId]
}

function mutableSelection(layers: LabelLayer[], ids: string[]): LabelLayer[] {
  const selected = new Set(ids)
  return layers.filter((layer) => selected.has(layer.id) && !layer.locked)
}

function replaceCoordinates(
  layers: LabelLayer[],
  coordinates: ReadonlyMap<string, { x?: number; y?: number }>,
): LabelLayer[] {
  let changed = false
  const next = layers.map((layer) => {
    const coordinate = coordinates.get(layer.id)
    if (!coordinate) return layer
    const x = coordinate.x ?? layer.x
    const y = coordinate.y ?? layer.y
    if (x === layer.x && y === layer.y) return layer
    changed = true
    return { ...layer, x, y }
  })
  return changed ? next : layers
}

/** Aligns the center anchors of selected, unlocked layers. */
export function alignLayers(layers: LabelLayer[], ids: string[], mode: LayerAlignment): LabelLayer[] {
  const selected = mutableSelection(layers, ids)
  if (selected.length < 2) return layers
  const horizontal = mode === 'left' || mode === 'center' || mode === 'right'
  const values = selected.map((layer) => (horizontal ? layer.x : layer.y))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const target = mode === 'left' || mode === 'top'
    ? min
    : mode === 'right' || mode === 'bottom'
      ? max
      : (min + max) / 2
  const coordinates = new Map(selected.map((layer) => [layer.id, horizontal ? { x: target } : { y: target }]))
  return replaceCoordinates(layers, coordinates)
}

/** Evenly distributes selected, unlocked layer centers between the two extrema. */
export function distributeLayers(layers: LabelLayer[], ids: string[], axis: DistributionAxis): LabelLayer[] {
  const horizontal = axis === 'horizontal'
  const selected = mutableSelection(layers, ids)
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => {
      const delta = (horizontal ? a.layer.x - b.layer.x : a.layer.y - b.layer.y)
      return delta === 0 ? a.index - b.index : delta
    })
  if (selected.length < 3) return layers
  const first = horizontal ? selected[0].layer.x : selected[0].layer.y
  const last = horizontal ? selected[selected.length - 1].layer.x : selected[selected.length - 1].layer.y
  const step = (last - first) / (selected.length - 1)
  const coordinates = new Map(selected.map(({ layer }, index) => [
    layer.id,
    horizontal ? { x: first + step * index } : { y: first + step * index },
  ]))
  return replaceCoordinates(layers, coordinates)
}

/** Moves selected, unlocked layers by an exact canvas-coordinate delta. */
export function nudgeLayers(layers: LabelLayer[], ids: string[], dx: number, dy: number): LabelLayer[] {
  if (dx === 0 && dy === 0) return layers
  const coordinates = new Map(mutableSelection(layers, ids).map((layer) => [
    layer.id,
    { x: layer.x + dx, y: layer.y + dy },
  ]))
  return replaceCoordinates(layers, coordinates)
}

/** Converts completed Konva node transforms back into serializable layer data. */
export function applyLayerTransforms(layers: LabelLayer[], transforms: LayerNodeTransform[]): LabelLayer[] {
  const byId = new Map(transforms.map((transform) => [transform.id, transform]))
  let changed = false
  const next = layers.map((layer) => {
    const transform = byId.get(layer.id)
    if (!transform || layer.locked) return layer
    if (layer.kind === 'text') {
      const scale = normalizedScale(transform.scaleY)
      const scaleX = normalizedScale(transform.scaleX)
      const baseRotation = layer.direction === 'vertical' ? 90 : 0
      const rotation = transform.rotation - baseRotation
      const fontSize = Math.max(4, layer.fontSize * scale)
      const letterSpacing = layer.letterSpacing * scale
      const shouldPersistWidth = layer.width !== undefined || !Object.is(scaleX, 1)
      const baseWidth = layer.width ?? transform.baseWidth
      const width = shouldPersistWidth && baseWidth !== undefined
        ? Math.max(12, baseWidth * scaleX)
        : layer.width
      if (
        Object.is(transform.x, layer.x)
        && Object.is(transform.y, layer.y)
        && Object.is(rotation, layer.rotation)
        && Object.is(fontSize, layer.fontSize)
        && Object.is(letterSpacing, layer.letterSpacing)
        && Object.is(width, layer.width)
      ) return layer
      changed = true
      return {
        ...layer,
        x: transform.x,
        y: transform.y,
        rotation,
        fontSize,
        letterSpacing,
        ...(width === undefined ? {} : { width }),
      }
    }
    const width = Math.max(4, layer.width * Math.abs(transform.scaleX))
    const height = Math.max(4, layer.height * Math.abs(transform.scaleY))
    if (
      Object.is(transform.x, layer.x)
      && Object.is(transform.y, layer.y)
      && Object.is(transform.rotation, layer.rotation)
      && Object.is(width, layer.width)
      && Object.is(height, layer.height)
    ) return layer
    changed = true
    return {
      ...layer,
      x: transform.x,
      y: transform.y,
      rotation: transform.rotation,
      width,
      height,
    }
  })
  return changed ? next : layers
}

/** Commits one completed multi-node gesture through exactly one area mutation. */
export function commitLayerGesture(
  areaId: string,
  transforms: LayerNodeTransform[],
  applyAreaOp: AreaMutationGateway,
): boolean {
  if (transforms.length === 0) return false
  let committed = false
  applyAreaOp(areaId, (area) => {
    const layers = applyLayerTransforms(area.layers, transforms)
    if (layers === area.layers) return area
    committed = true
    return { ...area, layers }
  })
  return committed
}
