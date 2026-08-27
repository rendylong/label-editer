import type { LayoutBlueprintArea, LayoutBlueprintLayer, LayoutBlueprintV1, PhysicalBounds } from './designContracts'
import { craftEffectsForProcessIntents } from './blueprintCompiler'
import type { CraftEffect, LabelAreaConfig, LabelLayer, LayerDesignMetrics } from '../label/types'
import { canonicalFontStack } from '../label/fontStack'
import { canonicalLayerOrder, compareOrdinalText } from '../label/layerOrder'

export type FidelityIssueCode =
  | 'LAYER_SET_MISMATCH' | 'LAYER_ORDER_MISMATCH' | 'VISIBILITY_MISMATCH'
  | 'BOUNDS_MISMATCH' | 'ANCHOR_MISMATCH' | 'ROTATION_MISMATCH'
  | 'TEXT_MISMATCH' | 'TYPOGRAPHY_MISMATCH' | 'COLOR_MISMATCH'
  | 'VECTOR_MISMATCH' | 'PROCESS_MISMATCH' | 'CRAFT_MASK_MISMATCH'
  | 'ARTBOARD_ASPECT_MISMATCH'

export interface FidelityIssue {
  code: FidelityIssueCode
  areaId: string
  layerId?: string
  message: string
  expected?: unknown
  actual?: unknown
}

export interface FidelityReport {
  pass: boolean
  issues: FidelityIssue[]
  warnings?: string[]
}

export interface PerceptualComparison {
  pass: boolean
  warning?: string
}

export interface EditableLayerProjection {
  id: string
  kind: LabelLayer['kind']
  designMetrics?: LayerDesignMetrics
  rotation: number
  opacity: number
  visible: boolean
  zIndex: number
  processes: LabelLayer['processes']
  craft: CraftEffect[]
  text?: string
  language?: string
  writingDirection?: string
  fontFamily?: string
  fontStack?: string[]
  fontWeight?: number | 'normal' | 'bold'
  color?: string
  align?: string
  shape?: string
  pathData?: string
  pathViewBox?: [number, number, number, number]
  fillRule?: string
  fill?: string
  stroke?: string
  src?: string
}

export interface EditableAreaProjection {
  id: string
  carrier?: LabelAreaConfig['carrier']
  artboard?: LabelAreaConfig['artboard']
  layers: EditableLayerProjection[]
}

export function projectEditableArea(area: LabelAreaConfig): EditableAreaProjection {
  return {
    id: area.blueprintAreaId ?? area.id,
    carrier: area.carrier,
    artboard: area.artboard ? structuredClone(area.artboard) : undefined,
    layers: area.layers.map((layer): EditableLayerProjection => ({
      id: layer.id,
      kind: layer.kind,
      designMetrics: layer.designMetrics ? structuredClone(layer.designMetrics) : undefined,
      rotation: layer.rotation,
      opacity: layer.opacity,
      visible: layer.visible,
      zIndex: layer.zIndex,
      processes: layer.processes ? structuredClone(layer.processes) : undefined,
      craft: structuredClone(layer.craft),
      ...(layer.kind === 'text' ? {
        text: layer.text, language: layer.language, writingDirection: layer.writingDirection,
        fontFamily: layer.fontFamily, fontStack: layer.fontStack ? structuredClone(layer.fontStack) : undefined, fontWeight: layer.fontWeight, color: layer.color, align: layer.align,
      } : {}),
      ...(layer.kind === 'shape' ? {
        shape: layer.shape, pathData: layer.pathData,
        pathViewBox: layer.pathViewBox ? structuredClone(layer.pathViewBox) : undefined,
        fillRule: layer.fillRule, fill: layer.fill, stroke: layer.stroke,
      } : {}),
      ...(layer.kind === 'image' ? { src: layer.src } : {}),
    })),
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => compareOrdinalText(left, right))
      .map(([key, nested]) => [key, canonical(nested)]),
  )
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function near(left: number | undefined, right: number | undefined, tolerance: number): boolean {
  return left === undefined || right === undefined ? left === right : Math.abs(left - right) <= tolerance
}

function toMm(bounds: PhysicalBounds | undefined, normalized: PhysicalBounds | undefined, area: LayoutBlueprintArea): PhysicalBounds | undefined {
  if (bounds) return bounds
  if (!normalized) return undefined
  return {
    x: normalized.x * area.artboard.widthMm,
    y: normalized.y * area.artboard.heightMm,
    width: normalized.width * area.artboard.widthMm,
    height: normalized.height * area.artboard.heightMm,
  }
}

function sameBounds(expected: LayoutBlueprintLayer, actual: EditableLayerProjection, area: LayoutBlueprintArea, tolerance: number): boolean {
  const left = toMm(expected.boundsMm, expected.normalizedBounds, area)
  const right = toMm(actual.designMetrics?.boundsMm, actual.designMetrics?.normalizedBounds, area)
  return Boolean(left && right
    && near(left.x, right.x, tolerance)
    && near(left.y, right.y, tolerance)
    && near(left.width, right.width, tolerance)
    && near(left.height, right.height, tolerance))
}

function expectedFont(blueprint: LayoutBlueprintV1, layer: LayoutBlueprintLayer): string | undefined {
  if (layer.fontStack) return canonicalFontStack(layer.fontStack)[0]
  return blueprint.assets.find((asset) => asset.id === layer.fontAsset)?.path
}

function typographyMatches(blueprint: LayoutBlueprintV1, expected: LayoutBlueprintLayer, actual: EditableLayerProjection): boolean {
  if (expected.kind !== 'text' || actual.kind !== 'text') return expected.kind === actual.kind
  const expectedStack = expected.fontStack ? canonicalFontStack(expected.fontStack) : undefined
  const actualStack = actual.fontStack ? canonicalFontStack(actual.fontStack) : undefined
  return actual.language === expected.language
    && actual.writingDirection === expected.writingDirection
    && (expectedStack ? true : actual.fontFamily === expectedFont(blueprint, expected))
    && same(actualStack, expectedStack)
    && actual.fontWeight === expected.fontWeight
    && actual.align === expected.alignment
    && actual.designMetrics?.fontSizeMm === expected.fontSizeMm
    && actual.designMetrics?.letterSpacingEm === expected.letterSpacingEm
    && actual.designMetrics?.lineHeight === expected.lineHeight
    && actual.designMetrics?.wrapPolicy === expected.wrapPolicy
    && actual.designMetrics?.maxLines === expected.maxLines
}

function colorValues(layer: LayoutBlueprintLayer | EditableLayerProjection): unknown[] {
  return layer.kind === 'text'
    ? [(layer as LayoutBlueprintLayer).color ?? (layer as EditableLayerProjection).color, layer.opacity]
    : layer.kind === 'shape'
      ? [(layer as LayoutBlueprintLayer).fill ?? (layer as EditableLayerProjection).fill,
        (layer as LayoutBlueprintLayer).stroke ?? (layer as EditableLayerProjection).stroke, layer.opacity]
      : [layer.opacity]
}

function expectedShape(layer: LayoutBlueprintLayer): string | undefined {
  if (layer.shape === 'rounded_rectangle') return 'rectangle'
  if (layer.shape === 'polygon' && layer.points?.length) return 'path'
  return layer.shape
}

function polygonData(points: Array<[number, number]>): { data: string; viewBox: [number, number, number, number] } {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  return {
    data: `${points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')} Z`,
    viewBox: [minX, minY, maxX - minX, maxY - minY],
  }
}

function vectorMatches(expected: LayoutBlueprintLayer, actual: EditableLayerProjection): boolean {
  if (expected.kind !== 'shape' || actual.kind !== 'shape') return expected.kind === actual.kind
  const polygon = expected.points?.length ? polygonData(expected.points) : undefined
  return actual.shape === expectedShape(expected)
    && actual.pathData === (expected.pathData ?? polygon?.data)
    && same(actual.pathViewBox, expected.pathViewBox ?? polygon?.viewBox)
    && actual.fillRule === expected.fillRule
    && actual.designMetrics?.strokeWidthMm === expected.strokeWidthMm
    && actual.designMetrics?.cornerRadiusMm === expected.cornerRadiusMm
}

function issue(
  issues: FidelityIssue[], code: FidelityIssueCode, areaId: string, message: string,
  layerId?: string, expected?: unknown, actual?: unknown,
): void {
  issues.push({ code, areaId, ...(layerId ? { layerId } : {}), message, expected, actual })
}

function compareLayer(
  blueprint: LayoutBlueprintV1,
  area: LayoutBlueprintArea,
  expected: LayoutBlueprintLayer,
  actual: EditableLayerProjection,
  toleranceMm: number,
  issues: FidelityIssue[],
): void {
  const id = expected.id
  if (actual.visible !== expected.visible) issue(issues, 'VISIBILITY_MISMATCH', area.id, 'Layer visibility changed.', id, expected.visible, actual.visible)
  if (!sameBounds(expected, actual, area, toleranceMm)) issue(issues, 'BOUNDS_MISMATCH', area.id, 'Layer bounds changed.', id, expected.boundsMm ?? expected.normalizedBounds, actual.designMetrics)
  if (actual.designMetrics?.anchor !== expected.anchor) issue(issues, 'ANCHOR_MISMATCH', area.id, 'Layer anchor changed.', id, expected.anchor, actual.designMetrics?.anchor)
  if (!near(actual.rotation, expected.rotation, 1e-6)) issue(issues, 'ROTATION_MISMATCH', area.id, 'Layer rotation changed.', id, expected.rotation, actual.rotation)
  if (expected.kind === 'text' && (actual.kind !== 'text' || actual.text !== expected.text)) issue(issues, 'TEXT_MISMATCH', area.id, 'Exact text changed.', id, expected.text, actual.text)
  if (!typographyMatches(blueprint, expected, actual)) issue(issues, 'TYPOGRAPHY_MISMATCH', area.id, 'Typography metadata changed.', id)
  if (!same(colorValues(expected), colorValues(actual))) issue(issues, 'COLOR_MISMATCH', area.id, 'Color or opacity changed.', id, colorValues(expected), colorValues(actual))
  if (!vectorMatches(expected, actual)) issue(issues, 'VECTOR_MISMATCH', area.id, 'Editable vector geometry changed.', id)
  if (!same(actual.processes ?? [], expected.processes)) issue(issues, 'PROCESS_MISMATCH', area.id, 'Process assignment changed.', id, expected.processes, actual.processes ?? [])
  const expectedCraft = craftEffectsForProcessIntents(expected)
  if (!same(actual.craft, expectedCraft)) issue(issues, 'CRAFT_MASK_MISMATCH', area.id, 'Craft effects no longer represent process masks.', id, expectedCraft, actual.craft)
}

export function compareBlueprintFidelity(input: {
  blueprint: LayoutBlueprintV1
  editableAreas: LabelAreaConfig[]
  toleranceMm?: number
  perceptualComparison?: PerceptualComparison
}): FidelityReport {
  const issues: FidelityIssue[] = []
  for (const expectedArea of input.blueprint.areas) {
    const actualArea = input.editableAreas.find((area) => (area.blueprintAreaId ?? area.id) === expectedArea.id)
    if (!actualArea) {
      issue(issues, 'LAYER_SET_MISMATCH', expectedArea.id, 'Blueprint area is missing.', undefined, expectedArea.layers.map((layer) => layer.id), [])
      continue
    }
    const projected = projectEditableArea(actualArea)
    if (projected.carrier !== expectedArea.carrier) {
      issue(issues, 'PROCESS_MISMATCH', expectedArea.id, 'Area carrier changed.', undefined, expectedArea.carrier, projected.carrier)
    }
    if (projected.artboard?.background !== expectedArea.artboard.background) {
      issue(issues, 'COLOR_MISMATCH', expectedArea.id, 'Artboard background changed.', undefined, expectedArea.artboard.background, projected.artboard?.background)
    }
    const expectedIds = canonicalLayerOrder(expectedArea.layers).map((layer) => layer.id)
    const actualIds = projected.layers.map((layer) => layer.id)
    if (!same([...expectedIds].sort(), [...actualIds].sort())) issue(issues, 'LAYER_SET_MISMATCH', expectedArea.id, 'Layer ids changed.', undefined, expectedIds, actualIds)
    const actualOrder = canonicalLayerOrder(projected.layers).map((layer) => layer.id)
    if (!same(actualOrder, expectedIds)) issue(issues, 'LAYER_ORDER_MISMATCH', expectedArea.id, 'Layer z-order changed.', actualOrder.find((id, index) => id !== expectedIds[index]), expectedIds, actualOrder)
    const expectedAspect = expectedArea.artboard.widthMm / expectedArea.artboard.heightMm
    const actualAspect = projected.artboard ? projected.artboard.widthMm / projected.artboard.heightMm : undefined
    if (!near(expectedAspect, actualAspect, 1e-6)) issue(issues, 'ARTBOARD_ASPECT_MISMATCH', expectedArea.id, 'Physical artboard aspect changed.', undefined, expectedAspect, actualAspect)
    for (const expectedLayer of expectedArea.layers) {
      const actualLayer = projected.layers.find((layer) => layer.id === expectedLayer.id)
      if (actualLayer) compareLayer(input.blueprint, expectedArea, expectedLayer, actualLayer, input.toleranceMm ?? 0.01, issues)
    }
  }
  const blueprintAreaIds = new Set(input.blueprint.areas.map((area) => area.id))
  for (const extraArea of input.editableAreas) {
    const areaId = extraArea.blueprintAreaId ?? extraArea.id
    if (!blueprintAreaIds.has(areaId)) {
      issue(issues, 'LAYER_SET_MISMATCH', areaId, 'Editable area is not present in the blueprint.', undefined, [], extraArea.layers.map((layer) => layer.id))
    }
  }
  const perceptualWarning = input.perceptualComparison?.warning
    ?? (input.perceptualComparison?.pass === false ? 'Perceptual image comparison reported a mismatch.' : undefined)
  const warnings = perceptualWarning ? [perceptualWarning] : undefined
  return { pass: issues.length === 0, issues, ...(warnings ? { warnings } : {}) }
}
