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
