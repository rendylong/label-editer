import { traceValidatedSvgPath, validateSvgPathViewBox } from './svgPath'

export type VectorPathField = 'pathData' | 'pathViewBox'

export interface VectorPathValidationIssue {
  field: VectorPathField
  message: string
}

/**
 * Authoritative validation for the deliberately bounded Task 5 SVG subset.
 * Rendering may still catch failures to clear stale channels, but input and
 * readiness boundaries must use this parser instead of treating a catch as a
 * valid empty vector.
 */
export function validateVectorPath(
  pathData: unknown,
  pathViewBox: unknown,
  width = 1,
  height = 1,
): VectorPathValidationIssue | undefined {
  if (!Array.isArray(pathViewBox) || pathViewBox.length !== 4
    || pathViewBox.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return { field: 'pathViewBox', message: 'pathViewBox 必须是 4 个有限数字' }
  }
  if (pathViewBox[2] <= 0 || pathViewBox[3] <= 0) {
    return { field: 'pathViewBox', message: 'pathViewBox 宽高必须大于 0' }
  }
  if (typeof pathData !== 'string' || pathData.length === 0) {
    return { field: 'pathData', message: 'pathData 必须是非空字符串' }
  }
  try {
    validateSvgPathViewBox(pathViewBox)
  } catch (error) {
    return {
      field: 'pathViewBox',
      message: `pathViewBox 不是受支持的有限坐标系：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  try {
    traceValidatedSvgPath({
      moveTo: () => undefined,
      lineTo: () => undefined,
      bezierCurveTo: () => undefined,
      closePath: () => undefined,
    }, pathData, pathViewBox, width, height)
  } catch (error) {
    return {
      field: 'pathData',
      message: `pathData 不是受支持的有限 SVG 路径：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return undefined
}
