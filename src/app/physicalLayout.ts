import type {
  CanvasSpec,
  LabelAreaConfig,
  LabelLayer,
  LayerDesignMetrics,
  PhysicalArtboard,
  TargetAspectPolicy,
} from '../label/types'
import type { PhysicalBounds } from '../agent/designContracts'

const ASPECT_EPSILON = 1e-9

type LayerAnchor = LayerDesignMetrics['anchor']

export interface TargetAspectInput {
  artboardAspect: number
  targetAspect: number
  policy?: TargetAspectPolicy
  approvedCrop?: PhysicalBounds
}

export type TargetAspectResult =
  | { status: 'resolved'; scale: { x: number; y: number }; offsets: { x: number; y: number }; crop?: PhysicalBounds }
  | { status: 'blocked'; code: 'TARGET_ASPECT_MISMATCH' }

export interface PhysicalLayoutInput {
  artboard: Pick<PhysicalArtboard, 'widthMm' | 'heightMm'>
  canvas: CanvasSpec
  boundsMm?: PhysicalBounds
  normalizedBounds?: PhysicalBounds
  anchor?: LayerAnchor
  fontSizeMm?: number
  strokeWidthMm?: number
  cornerRadiusMm?: number
  policy?: TargetAspectPolicy
  approvedCrop?: PhysicalBounds
}

export interface PhysicalLayoutResolved {
  status: 'resolved'
  normalizedBounds?: PhysicalBounds
  mappedBounds?: PhysicalBounds
  pixelBounds?: PhysicalBounds
  anchorPx?: { x: number; y: number }
  fontSizeMm?: number
  fontSizePx?: number
  strokeWidthMm?: number
  strokeWidthPx?: number
  cornerRadiusMm?: number
  cornerRadiusPx?: number
  pixelsPerMm: number
  scale: { x: number; y: number }
  offsets: { x: number; y: number }
  crop?: PhysicalBounds
  validationDetails: { declaredAspect: number; resolvedAspect: number }
}

export interface PhysicalLayoutBlocked {
  status: 'blocked'
  code: 'TARGET_ASPECT_MISMATCH'
  validationDetails: { declaredAspect: number; resolvedAspect: number }
}

export type PhysicalLayoutResult = PhysicalLayoutResolved | PhysicalLayoutBlocked

export class PhysicalLayoutError extends Error {
  readonly code = 'TARGET_ASPECT_MISMATCH' as const
  readonly details: PhysicalLayoutBlocked['validationDetails']

  constructor(details: PhysicalLayoutBlocked['validationDetails']) {
    super(`TARGET_ASPECT_MISMATCH: approved artboard aspect ${details.declaredAspect} cannot map to target aspect ${details.resolvedAspect} without stretching`)
    this.name = 'PhysicalLayoutError'
    this.details = details
  }
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number`)
  return value
}

function nonNegativeFinite(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a non-negative finite number`)
  return value
}

function aspectMatches(left: number, right: number): boolean {
  return Math.abs(left - right) <= ASPECT_EPSILON * Math.max(1, Math.abs(left), Math.abs(right))
}

function validCrop(crop: PhysicalBounds | undefined): crop is PhysicalBounds {
  return Boolean(crop)
    && Number.isFinite(crop!.x)
    && Number.isFinite(crop!.y)
    && Number.isFinite(crop!.width)
    && Number.isFinite(crop!.height)
    && crop!.width > 0
    && crop!.height > 0
}

export function resolveTargetAspect(input: TargetAspectInput): TargetAspectResult {
  const artboardAspect = positiveFinite(input.artboardAspect, 'artboardAspect')
  const targetAspect = positiveFinite(input.targetAspect, 'targetAspect')
  const policy = input.policy ?? 'fit'

  if (policy === 'crop-approved') {
    if (!validCrop(input.approvedCrop) || !aspectMatches(input.approvedCrop.width / input.approvedCrop.height, targetAspect)) {
      return { status: 'blocked', code: 'TARGET_ASPECT_MISMATCH' }
    }
    return {
      status: 'resolved',
      scale: { x: 1, y: 1 },
      offsets: { x: 0, y: 0 },
      crop: { ...input.approvedCrop },
    }
  }

  if (aspectMatches(artboardAspect, targetAspect)) {
    return { status: 'resolved', scale: { x: 1, y: 1 }, offsets: { x: 0, y: 0 } }
  }
  if (policy === 'block') return { status: 'blocked', code: 'TARGET_ASPECT_MISMATCH' }

  if (artboardAspect < targetAspect) {
    const width = artboardAspect / targetAspect
    return { status: 'resolved', scale: { x: width, y: 1 }, offsets: { x: (1 - width) / 2, y: 0 } }
  }
  const height = targetAspect / artboardAspect
  return { status: 'resolved', scale: { x: 1, y: height }, offsets: { x: 0, y: (1 - height) / 2 } }
}

function normalizeBounds(bounds: PhysicalBounds, artboard: PhysicalLayoutInput['artboard']): PhysicalBounds {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) throw new RangeError('bounds position must be finite')
  positiveFinite(bounds.width, 'bounds.width')
  positiveFinite(bounds.height, 'bounds.height')
  return {
    x: bounds.x / artboard.widthMm,
    y: bounds.y / artboard.heightMm,
    width: bounds.width / artboard.widthMm,
    height: bounds.height / artboard.heightMm,
  }
}

function validateNormalizedBounds(bounds: PhysicalBounds): PhysicalBounds {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (values.some((value) => !Number.isFinite(value))) throw new RangeError('normalizedBounds must be finite')
  if (bounds.x < 0 || bounds.x > 1 || bounds.y < 0 || bounds.y > 1
    || bounds.width <= 0 || bounds.width > 1 || bounds.height <= 0 || bounds.height > 1) {
    throw new RangeError('normalizedBounds positions and dimensions must be within 0..1')
  }
  return { ...bounds }
}

function mapBounds(bounds: PhysicalBounds, scale: { x: number; y: number }, offsets: { x: number; y: number }): PhysicalBounds {
  return {
    x: bounds.x * scale.x + offsets.x,
    y: bounds.y * scale.y + offsets.y,
    width: bounds.width * scale.x,
    height: bounds.height * scale.y,
  }
}

function anchorPoint(bounds: PhysicalBounds, anchor: LayerAnchor): { x: number; y: number } {
  if (anchor === 'center') return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  if (anchor === 'top_center' || anchor === 'baseline_center') return { x: bounds.x + bounds.width / 2, y: bounds.y }
  return { x: bounds.x, y: bounds.y }
}

function cropTransform(crop: PhysicalBounds, artboard: PhysicalLayoutInput['artboard']): {
  cropNormalized: PhysicalBounds
  scale: { x: number; y: number }
  offsets: { x: number; y: number }
} | null {
  const right = crop.x + crop.width
  const bottom = crop.y + crop.height
  if (crop.x < 0 || crop.y < 0 || right > artboard.widthMm || bottom > artboard.heightMm) return null
  const cropNormalized = normalizeBounds(crop, artboard)
  const scale = { x: 1 / cropNormalized.width, y: 1 / cropNormalized.height }
  return {
    cropNormalized,
    scale,
    offsets: { x: -cropNormalized.x * scale.x, y: -cropNormalized.y * scale.y },
  }
}

export function resolvePhysicalLayout(input: PhysicalLayoutInput): PhysicalLayoutResult {
  const artboard = {
    widthMm: positiveFinite(input.artboard.widthMm, 'artboard.widthMm'),
    heightMm: positiveFinite(input.artboard.heightMm, 'artboard.heightMm'),
  }
  const canvas = {
    width: positiveFinite(input.canvas.width, 'canvas.width'),
    height: positiveFinite(input.canvas.height, 'canvas.height'),
    aspect: positiveFinite(input.canvas.aspect, 'canvas.aspect'),
  }
  const declaredAspect = artboard.widthMm / artboard.heightMm
  const validationDetails = { declaredAspect, resolvedAspect: canvas.aspect }
  const decision = resolveTargetAspect({
    artboardAspect: declaredAspect,
    targetAspect: canvas.aspect,
    policy: input.policy,
    approvedCrop: input.approvedCrop,
  })
  if (decision.status === 'blocked') return { ...decision, validationDetails }

  let scale = decision.scale
  let offsets = decision.offsets
  let crop: PhysicalBounds | undefined
  if (decision.crop) {
    const transform = cropTransform(decision.crop, artboard)
    if (!transform) return { status: 'blocked', code: 'TARGET_ASPECT_MISMATCH', validationDetails }
    scale = transform.scale
    offsets = transform.offsets
    crop = transform.cropNormalized
  }

  const normalizedBounds = input.boundsMm
    ? normalizeBounds(input.boundsMm, artboard)
    : input.normalizedBounds ? validateNormalizedBounds(input.normalizedBounds) : undefined
  const mappedBounds = normalizedBounds ? mapBounds(normalizedBounds, scale, offsets) : undefined
  const pixelBounds = mappedBounds ? {
    x: mappedBounds.x * canvas.width,
    y: mappedBounds.y * canvas.height,
    width: mappedBounds.width * canvas.width,
    height: mappedBounds.height * canvas.height,
  } : undefined
  const anchor = input.anchor ?? 'top_left'
  const mappedAnchor = mappedBounds ? anchorPoint(mappedBounds, anchor) : undefined
  const pixelsPerMmX = canvas.width * scale.x / artboard.widthMm
  const pixelsPerMmY = canvas.height * scale.y / artboard.heightMm
  const pixelsPerMm = Math.min(pixelsPerMmX, pixelsPerMmY)
  const fontSizeMm = input.fontSizeMm === undefined
    ? undefined
    : positiveFinite(input.fontSizeMm, 'fontSizeMm')
  const strokeWidthMm = nonNegativeFinite(input.strokeWidthMm, 'strokeWidthMm')
  const cornerRadiusMm = nonNegativeFinite(input.cornerRadiusMm, 'cornerRadiusMm')

  return {
    status: 'resolved',
    ...(normalizedBounds ? { normalizedBounds } : {}),
    ...(mappedBounds ? { mappedBounds } : {}),
    ...(pixelBounds ? { pixelBounds } : {}),
    ...(mappedAnchor ? { anchorPx: { x: mappedAnchor.x * canvas.width, y: mappedAnchor.y * canvas.height } } : {}),
    ...(fontSizeMm === undefined ? {} : { fontSizeMm, fontSizePx: fontSizeMm * pixelsPerMm }),
    ...(strokeWidthMm === undefined ? {} : { strokeWidthMm, strokeWidthPx: strokeWidthMm * pixelsPerMm }),
    ...(cornerRadiusMm === undefined ? {} : { cornerRadiusMm, cornerRadiusPx: cornerRadiusMm * pixelsPerMm }),
    pixelsPerMm,
    scale,
    offsets,
    ...(crop ? { crop } : {}),
    validationDetails,
  }
}

export function resolvePhysicalLayer(area: LabelAreaConfig, layer: LabelLayer, canvas: CanvasSpec = area.canvas): LabelLayer {
  const metrics = layer.designMetrics
  if (!area.artboard || !metrics) return layer
  const result = resolvePhysicalLayout({
    artboard: area.artboard,
    canvas,
    boundsMm: metrics.boundsMm,
    normalizedBounds: metrics.normalizedBounds,
    anchor: metrics.anchor,
    fontSizeMm: metrics.fontSizeMm,
    strokeWidthMm: metrics.strokeWidthMm,
    cornerRadiusMm: metrics.cornerRadiusMm,
    policy: area.placementPolicy,
    approvedCrop: area.designBinding?.approvedCrop,
  })
  if (result.status === 'blocked') throw new PhysicalLayoutError(result.validationDetails)

  const positioned = {
    ...layer,
    ...(result.anchorPx ? { x: result.anchorPx.x, y: result.anchorPx.y } : {}),
  }
  if (positioned.kind === 'text') {
    const fontSize = result.fontSizePx ?? positioned.fontSize
    return {
      ...positioned,
      ...(result.pixelBounds ? { width: result.pixelBounds.width } : {}),
      fontSize,
      ...(metrics.letterSpacingEm === undefined ? {} : { letterSpacing: metrics.letterSpacingEm * fontSize }),
      ...(metrics.lineHeight === undefined ? {} : { lineHeight: metrics.lineHeight }),
    }
  }
  if (positioned.kind === 'shape') {
    return {
      ...positioned,
      ...(result.pixelBounds ? { width: result.pixelBounds.width, height: result.pixelBounds.height } : {}),
      ...(result.strokeWidthPx === undefined ? {} : { strokeWidth: result.strokeWidthPx }),
      ...(result.cornerRadiusPx === undefined ? {} : { cornerRadius: result.cornerRadiusPx }),
    }
  }
  return {
    ...positioned,
    ...(result.pixelBounds ? { width: result.pixelBounds.width, height: result.pixelBounds.height } : {}),
  }
}

function scaleLegacyCraft(layer: LabelLayer, scalar: number): LabelLayer['craft'] {
  return layer.craft.map((effect) => effect.type === 'stroke' && typeof effect.params.strokeWidth === 'number'
    ? { ...effect, params: { ...effect.params, strokeWidth: effect.params.strokeWidth * scalar } }
    : effect)
}

function scaleLegacyLayer(layer: LabelLayer, scaleX: number, scaleY: number, scalar: number): LabelLayer {
  const common = {
    ...layer,
    x: layer.x * scaleX,
    y: layer.y * scaleY,
    craft: scaleLegacyCraft(layer, scalar),
  }
  if (common.kind === 'text') {
    return {
      ...common,
      fontSize: common.fontSize * scalar,
      letterSpacing: common.letterSpacing * scalar,
      ...(common.width === undefined ? {} : { width: common.width * scaleX }),
    }
  }
  if (common.kind === 'image') {
    return { ...common, width: common.width * scaleX, height: common.height * scaleY }
  }
  const geometry = common.geometry ? {
    ...common.geometry,
    ...(common.geometry.amplitude === undefined ? {} : { amplitude: common.geometry.amplitude * scaleY }),
    ...(common.geometry.inset === undefined ? {} : { inset: common.geometry.inset * scalar }),
    ...(common.geometry.gap === undefined ? {} : { gap: common.geometry.gap * scalar }),
    ...(common.geometry.dash === undefined ? {} : { dash: common.geometry.dash.map((value) => value * scalar) }),
  } : common.geometry
  return {
    ...common,
    width: common.width * scaleX,
    height: common.height * scaleY,
    strokeWidth: common.strokeWidth * scalar,
    cornerRadius: common.cornerRadius * scalar,
    geometry,
  }
}

/** Re-resolve approved physical layers and proportionally migrate legacy pixel layers. */
export function resolveLayersForCanvas(area: LabelAreaConfig, canvas: CanvasSpec): LabelLayer[] {
  const scaleX = canvas.width / area.canvas.width
  const scaleY = canvas.height / area.canvas.height
  const scalar = Math.sqrt(scaleX * scaleY)
  const nextArea = { ...area, canvas }
  return area.layers.map((layer) => {
    const scaled = scaleLegacyLayer(layer, scaleX, scaleY, scalar)
    return area.artboard && layer.designMetrics
      ? resolvePhysicalLayer(nextArea, scaled)
      : scaled
  })
}

export function assertPhysicalAreaPlacement(area: LabelAreaConfig, canvas: CanvasSpec = area.canvas): void {
  if (!area.artboard) return
  const result = resolvePhysicalLayout({
    artboard: area.artboard,
    canvas,
    policy: area.placementPolicy,
    approvedCrop: area.designBinding?.approvedCrop,
  })
  if (result.status === 'blocked') throw new PhysicalLayoutError(result.validationDetails)
}
