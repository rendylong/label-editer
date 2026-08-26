import { hasOpenSvgSubpath, parseNormalizedSvgPath, svgPathBounds } from './svg-path-core.mjs'

export function resolveCustomCarrierBoundary(pathData) {
  if (typeof pathData !== 'string' || pathData.length === 0) return undefined
  try {
    const commands = parseNormalizedSvgPath(pathData)
    const pathBounds = svgPathBounds(commands)
    if (hasOpenSvgSubpath(commands) || !(pathBounds.width > 0) || !(pathBounds.height > 0)) return undefined
    return Object.freeze({ pathData, pathBounds: Object.freeze(pathBounds) })
  } catch {
    return undefined
  }
}
