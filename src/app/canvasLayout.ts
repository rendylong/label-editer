export interface CanvasDisplayFitInput {
  containerWidth: number
  containerHeight: number
  aspect: number
  maxWidth: number
  padding: number
}

export interface SplitPointerInput {
  clientX: number
  containerLeft: number
  containerWidth: number
}

export interface BakeCanvasSize {
  width: number
  height: number
}

export interface RasterAspectDetails {
  declaredAspect: number
  rasterAspect: number
  width: number
  height: number
  tolerance: number
}

export class RasterAspectError extends Error {
  readonly code = 'RASTER_ASPECT_MISMATCH' as const

  constructor(readonly details: RasterAspectDetails) {
    super(`RASTER_ASPECT_MISMATCH: ${details.width}x${details.height} raster aspect ${details.rasterAspect} does not match declared aspect ${details.declaredAspect}`)
    this.name = 'RasterAspectError'
  }
}

/** Canonical integer raster height for a chosen width and authoritative aspect. */
export function canonicalRasterHeight(width: number, aspect: number): number {
  if (!Number.isInteger(width) || width <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    throw new RangeError('Raster width and aspect must be positive')
  }
  return Math.max(1, Math.round(width / aspect))
}

/** Require the one deterministic integer raster derived from width and aspect. */
export function assertRasterAspect(canvas: { width: number; height: number; aspect: number }): void {
  if (!Number.isInteger(canvas.width) || canvas.width <= 0 || !Number.isInteger(canvas.height) || canvas.height <= 0
    || !Number.isFinite(canvas.aspect) || canvas.aspect <= 0) {
    throw new RasterAspectError({
      declaredAspect: canvas.aspect,
      rasterAspect: canvas.width / canvas.height,
      width: canvas.width,
      height: canvas.height,
      tolerance: 0,
    })
  }
  const rasterAspect = canvas.width / canvas.height
  if (canvas.height !== canonicalRasterHeight(canvas.width, canvas.aspect)) {
    throw new RasterAspectError({
      declaredAspect: canvas.aspect,
      rasterAspect,
      width: canvas.width,
      height: canvas.height,
      tolerance: 0,
    })
  }
}

/** Require an actual capture/channel to match the explicit canonical canvas. */
export function assertRasterDimensions(
  actual: { width: number; height: number },
  expected: { width: number; height: number; aspect: number },
): void {
  assertRasterAspect(expected)
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new RasterAspectError({
      declaredAspect: expected.aspect,
      rasterAspect: actual.width / actual.height,
      width: actual.width,
      height: actual.height,
      tolerance: 0,
    })
  }
}

/** Display height whose export pixel ratio lands on the canonical raster exactly. */
export function fitRasterDisplayHeight(
  displayWidth: number,
  canvas: { width: number; height: number; aspect: number },
): number {
  assertRasterAspect(canvas)
  if (!Number.isFinite(displayWidth) || displayWidth <= 0) throw new RangeError('Display width must be positive')
  return displayWidth * canvas.height / canvas.width
}

export const INITIAL_SPLIT_PERCENT = 65
export const MIN_SPLIT_PERCENT = 25
export const MAX_SPLIT_PERCENT = 80

export function clampSplitPercent(percent: number): number {
  if (!Number.isFinite(percent)) return INITIAL_SPLIT_PERCENT
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, percent))
}

export function splitPercentFromPointer(input: SplitPointerInput): number {
  if (!Number.isFinite(input.containerWidth) || input.containerWidth <= 0) return INITIAL_SPLIT_PERCENT
  const percent = ((input.clientX - input.containerLeft) / input.containerWidth) * 100
  return clampSplitPercent(Math.round(percent * 10) / 10)
}

export function resizeSplitPercent(current: number, key: string): number | null {
  if (key === 'Home') return MIN_SPLIT_PERCENT
  if (key === 'End') return MAX_SPLIT_PERCENT
  if (key === 'ArrowLeft') return clampSplitPercent(current - 5)
  if (key === 'ArrowRight') return clampSplitPercent(current + 5)
  return null
}

/** 在保持真实标签宽高比的前提下，同时适配容器宽度和高度。 */
export function fitCanvasDisplayWidth(input: CanvasDisplayFitInput): number {
  const availableWidth = Math.max(1, input.containerWidth - input.padding)
  const availableHeight = Math.max(1, input.containerHeight - input.padding)
  const aspect = Math.max(input.aspect, 1e-6)
  return Math.min(availableWidth, input.maxWidth, availableHeight * aspect)
}

/** Change only raster resolution; the model-derived target aspect remains authoritative. */
export function withBakeCanvasSize<T extends { width: number; height: number; aspect: number }>(
  canvas: T,
  size: BakeCanvasSize,
): T {
  if (!Number.isInteger(size.width) || size.width <= 0 || !Number.isInteger(size.height) || size.height <= 0) {
    throw new RangeError('Bake canvas width and height must be positive integers')
  }
  const resized = { ...canvas, width: size.width, height: size.height }
  assertRasterAspect(resized)
  return resized
}
