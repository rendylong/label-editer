import type {
  FlattenedFallback,
  LayoutBlueprintArea,
  LayoutBlueprintLayer,
  LayoutBlueprintV1,
  PhysicalBounds,
  ProcessIntent,
} from './designContracts'
import { WorkflowGateError } from './workflowGateError'
import type { LabelSpecAreaV2, LabelSpecLayerV2 } from './labelSpecSchema'
import type { CraftEffect, ShapeKind } from '../label/types'
import { canonicalFontStack } from '../label/fontStack'
import { compareLayerZOrder } from '../label/layerOrder'

export interface ResolvedModelAreaShell {
  blueprintAreaId?: string
  name?: string
  target: LabelSpecAreaV2['target']
  surfaceMode?: LabelSpecAreaV2['surfaceMode']
  range?: LabelSpecAreaV2['range']
  remap?: unknown
}

export interface UnrepresentableLayerDetails extends Record<string, unknown> {
  areaId: string
  layerId: string
  reason: string
  flattenedFallback: FlattenedFallback
}

export class BlueprintCompilerError extends WorkflowGateError {
  declare readonly details: UnrepresentableLayerDetails

  constructor(details: UnrepresentableLayerDetails) {
    super(
      'UNREPRESENTABLE_LAYER',
      `Layer ${details.areaId}/${details.layerId} is not representable as editable artwork: ${details.reason}`,
      details,
    )
    this.name = 'BlueprintCompilerError'
  }
}

function fallbackFor(layer: Partial<LayoutBlueprintLayer>): FlattenedFallback {
  return structuredClone(layer.flattenedFallback ?? {
    accepted: false,
    nonEditableLayerIds: [layer.id ?? 'unknown-layer'],
    nonEditableTextIds: layer.kind === 'text' ? [layer.id ?? 'unknown-layer'] : [],
    lostSeparations: (layer.processes ?? []).map((process) => process.spotName ?? process.process),
    vectorAlternative: 'Provide a supported editable vector path or explicitly approve flattened artwork with all losses disclosed.',
  })
}

function unrepresentable(area: LayoutBlueprintArea, layer: Partial<LayoutBlueprintLayer>, reason: string): never {
  throw new BlueprintCompilerError({
    areaId: area.id,
    layerId: layer.id ?? 'unknown-layer',
    reason,
    flattenedFallback: fallbackFor(layer),
  })
}

function normalizedBounds(area: LayoutBlueprintArea, layer: LayoutBlueprintLayer): PhysicalBounds {
  if (layer.normalizedBounds) return structuredClone(layer.normalizedBounds)
  const bounds = layer.boundsMm!
  return {
    x: bounds.x / area.artboard.widthMm,
    y: bounds.y / area.artboard.heightMm,
    width: bounds.width / area.artboard.widthMm,
    height: bounds.height / area.artboard.heightMm,
  }
}

function anchorPoint(bounds: PhysicalBounds, anchor: LayoutBlueprintLayer['anchor']): { x: number; y: number } {
  if (anchor === 'center') return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  if (anchor === 'top_center' || anchor === 'baseline_center') return { x: bounds.x + bounds.width / 2, y: bounds.y }
  return { x: bounds.x, y: bounds.y }
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function designMetrics(layer: LayoutBlueprintLayer) {
  return {
    ...(layer.boundsMm ? { boundsMm: structuredClone(layer.boundsMm) } : {}),
    ...(layer.normalizedBounds ? { normalizedBounds: structuredClone(layer.normalizedBounds) } : {}),
    anchor: layer.anchor,
    ...(layer.fontSizeMm === undefined ? {} : { fontSizeMm: layer.fontSizeMm }),
    ...(layer.letterSpacingEm === undefined ? {} : { letterSpacingEm: layer.letterSpacingEm }),
    ...(layer.lineHeight === undefined ? {} : { lineHeight: layer.lineHeight }),
    ...(layer.wrapPolicy === undefined ? {} : { wrapPolicy: layer.wrapPolicy }),
    ...(layer.maxLines === undefined ? {} : { maxLines: layer.maxLines }),
    ...(layer.strokeWidthMm === undefined ? {} : { strokeWidthMm: layer.strokeWidthMm }),
    ...(layer.cornerRadiusMm === undefined ? {} : { cornerRadiusMm: layer.cornerRadiusMm }),
  }
}

function visibleColor(layer: LayoutBlueprintLayer): string | undefined {
  const candidates = [layer.stroke, layer.fill, layer.color]
  return candidates.find((value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
}

export function craftEffectsForProcessIntents(layer: LayoutBlueprintLayer): CraftEffect[] {
  const effects: CraftEffect[] = []
  for (const process of layer.processes) {
    if (process.process === 'hot_stamp_foil' && !effects.some((effect) => effect.type === 'foil')) {
      const color = visibleColor(layer)
      effects.push({
        type: 'foil',
        params: {
          foilColor: color ? 'custom' : 'gold',
          ...(color ? { foilCustomColor: color } : {}),
          ...(process.spotName ? { foilSpotName: process.spotName } : {}),
        },
      })
    } else if ((process.process === 'emboss' || process.process === 'deboss')
      && !effects.some((effect) => effect.type === process.process)) {
      effects.push({ type: process.process, params: {} })
    } else if (process.process === 'varnish' && !effects.some((effect) => effect.type === 'uv')) {
      effects.push({ type: 'uv', params: {} })
    }
  }
  return effects
}

function assetPath(blueprint: LayoutBlueprintV1, layer: LayoutBlueprintLayer, area: LayoutBlueprintArea): string {
  const asset = blueprint.assets.find((candidate) => candidate.id === layer.assetId)
  if (!asset) unrepresentable(area, layer, `asset ${layer.assetId ?? '(missing)'} is unavailable`)
  return asset.path
}

function imageAsset(blueprint: LayoutBlueprintV1, layer: LayoutBlueprintLayer, area: LayoutBlueprintArea) {
  const asset = blueprint.assets.find((candidate) => candidate.id === layer.assetId)
  if (!asset) unrepresentable(area, layer, `asset ${layer.assetId ?? '(missing)'} is unavailable`)
  if (!asset.width || !asset.height) unrepresentable(area, layer, `image asset ${asset.id} has no intrinsic dimensions`)
  return asset
}

function fontFamily(blueprint: LayoutBlueprintV1, area: LayoutBlueprintArea, layer: LayoutBlueprintLayer): string {
  if (layer.fontAsset) return assetPath(blueprint, { ...layer, assetId: layer.fontAsset }, area)
  if (layer.fontStack?.length) return canonicalFontStack(layer.fontStack)[0]
  return unrepresentable(area, layer, 'text has no editable font asset or font stack')
}

function polygonPath(points: Array<[number, number]>): { pathData: string; pathViewBox: [number, number, number, number] } {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  return {
    pathData: `${points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')} Z`,
    pathViewBox: [minX, minY, maxX - minX, maxY - minY],
  }
}

function compileLayer(blueprint: LayoutBlueprintV1, area: LayoutBlueprintArea, layer: LayoutBlueprintLayer): LabelSpecLayerV2 {
  if (layer.kind !== 'text' && layer.kind !== 'image' && layer.kind !== 'shape') {
    return unrepresentable(area, layer, `unsupported editable kind ${String((layer as { kind?: unknown }).kind)}`)
  }
  const bounds = normalizedBounds(area, layer)
  const rawAnchor = anchorPoint(bounds, layer.anchor)
  const anchor = { x: bounded(rawAnchor.x, 0, 1), y: bounded(rawAnchor.y, 0, 1) }
  const common = {
    id: layer.id,
    x: anchor.x,
    y: anchor.y,
    rotation: layer.rotation,
    opacity: layer.opacity,
    visible: layer.visible,
    locked: false,
    craft: craftEffectsForProcessIntents(layer),
    designMetrics: designMetrics(layer),
    processes: structuredClone(layer.processes) as ProcessIntent[],
  }

  if (layer.kind === 'text') {
    if (layer.alignment === 'justify') return unrepresentable(area, layer, 'justify alignment is not supported by editable text')
    const proxyFontSize = bounded((layer.fontSizeMm! / area.artboard.heightMm) * 1024, 1, 2048)
    return {
      ...common,
      type: 'text',
      text: layer.text!,
      fontFamily: fontFamily(blueprint, area, layer),
      ...(layer.fontStack?.length ? { fontStack: canonicalFontStack(layer.fontStack) } : {}),
      fontSize: proxyFontSize,
      fontWeight: layer.fontWeight!,
      letterSpacing: bounded(layer.letterSpacingEm! * proxyFontSize, -100, 100),
      lineHeight: bounded(layer.lineHeight!, 0.5, 5),
      width: bounded(bounds.width, 0.001, 1),
      color: layer.color!,
      align: layer.alignment!,
      italic: false,
      direction: 'horizontal',
      writingDirection: layer.writingDirection!,
      language: layer.language!,
    }
  }

  if (layer.kind === 'image') {
    const fit = layer.fit ?? 'contain'
    if (fit !== 'contain' && fit !== 'cover' && fit !== 'stretch') {
      return unrepresentable(area, layer, `image fit ${String(fit)} is not representable`)
    }
    const asset = imageAsset(blueprint, layer, area)
    return {
      ...common,
      type: 'image',
      asset: asset.path,
      fit,
      naturalWidth: asset.width!,
      naturalHeight: asset.height!,
      width: bounded(bounds.width, 0.001, 4),
      height: bounded(bounds.height, 0.001, 4),
    }
  }

  let shape = layer.shape as ShapeKind
  let path: { pathData: string; pathViewBox: [number, number, number, number] } | undefined
  if (layer.shape === 'rounded_rectangle') shape = 'rectangle'
  if (layer.shape === 'polygon' && layer.points?.length) {
    shape = 'path'
    path = polygonPath(layer.points)
  }
  return {
    ...common,
    type: 'shape',
    shape,
    width: bounded(bounds.width, 0.001, 4),
    height: bounded(bounds.height, 0.001, 4),
    fill: layer.fill ?? 'transparent',
    stroke: layer.stroke ?? '#000000',
    strokeWidth: layer.strokeWidthMm ?? 0,
    cornerRadius: layer.cornerRadiusMm ?? 0,
    ...(layer.pathData ? { pathData: layer.pathData } : path ?? {}),
    ...(layer.pathViewBox ? { pathViewBox: structuredClone(layer.pathViewBox) } : {}),
    ...(layer.fillRule ? { fillRule: layer.fillRule } : {}),
  }
}

function shellFor(
  area: LayoutBlueprintArea,
  shells?: readonly ResolvedModelAreaShell[] | Record<string, ResolvedModelAreaShell>,
): ResolvedModelAreaShell | undefined {
  if (Array.isArray(shells)) return shells.find((shell) => shell.blueprintAreaId === area.id)
    ?? shells.find((shell) => shell.name === area.id)
  return (shells as Record<string, ResolvedModelAreaShell> | undefined)?.[area.id]
}

export function compileBlueprintArea(
  blueprint: LayoutBlueprintV1,
  area: LayoutBlueprintArea,
  shell?: ResolvedModelAreaShell,
): LabelSpecAreaV2 {
  return {
    id: area.id,
    name: shell?.name ?? area.id,
    target: structuredClone(shell?.target ?? { nodeName: area.id }),
    surfaceMode: shell?.surfaceMode ?? 'overlay',
    side: area.side,
    range: structuredClone(shell?.range ?? { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }),
    ...(shell?.remap === undefined ? {} : { remap: structuredClone(shell.remap) }),
    carrier: area.carrier,
    artboard: structuredClone(area.artboard),
    ...(area.substrate ? { substrate: structuredClone(area.substrate) } : {}),
    ...(area.placementPolicy ? { placementPolicy: area.placementPolicy } : {}),
    blueprintAreaId: area.id,
    layers: area.layers.slice().sort(compareLayerZOrder).map((layer) => compileLayer(blueprint, area, layer)),
  }
}

export function compileBlueprintToSpecAreas(
  blueprint: LayoutBlueprintV1,
  shells?: readonly ResolvedModelAreaShell[] | Record<string, ResolvedModelAreaShell>,
): LabelSpecAreaV2[] {
  return blueprint.areas.map((area) => compileBlueprintArea(blueprint, area, shellFor(area, shells)))
}
