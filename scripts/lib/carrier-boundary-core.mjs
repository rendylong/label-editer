import { parseNormalizedSvgPath, svgPathBounds, validatedSvgGeometry } from './svg-path-core.mjs'

function drawableClosedCommands(commands) {
  const contours = []
  let start
  let current = []
  let drawable = false
  let closed = false
  const finish = () => {
    if (drawable && !closed) return false
    if (drawable) contours.push(current)
    current = []; drawable = false; closed = false; start = undefined
    return true
  }
  for (const command of commands) {
    if (command.kind === 'moveTo') {
      if (!finish()) return undefined
      start = command; current = [command]
      continue
    }
    if (command.kind === 'close') {
      if (drawable) { current.push(command); closed = true }
      continue
    }
    if (closed) {
      contours.push(current)
      current = start ? [start, command] : [command]
      drawable = true; closed = false
      continue
    }
    current.push(command); drawable = true
  }
  if (!finish() || contours.length === 0) return undefined
  return contours.flat()
}

function hasPositiveRenderedArea(pathData, pathBounds) {
  const operations = validatedSvgGeometry(
    pathData,
    [pathBounds.x, pathBounds.y, pathBounds.width, pathBounds.height],
    pathBounds.width,
    pathBounds.height,
  ).commands
  const contourAreas = []
  let points = []
  let current
  const finish = () => {
    if (points.length < 3) { points = []; return }
    let twiceArea = 0
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]; const next = points[(index + 1) % points.length]
      twiceArea += point.x * next.y - next.x * point.y
    }
    contourAreas.push(Math.abs(twiceArea) / 2); points = []
  }
  for (const operation of operations) {
    if (operation.kind === 'moveTo') {
      finish(); current = { x: operation.x, y: operation.y }; points = [current]
    } else if (operation.kind === 'lineTo') {
      current = { x: operation.x, y: operation.y }; points.push(current)
    } else if (operation.kind === 'cubicTo') {
      const start = current
      if (!start) return false
      for (let step = 1; step <= 16; step += 1) {
        const time = step / 16; const inverse = 1 - time
        points.push({
          x: inverse ** 3 * start.x + 3 * inverse ** 2 * time * operation.cp1x + 3 * inverse * time ** 2 * operation.cp2x + time ** 3 * operation.x,
          y: inverse ** 3 * start.y + 3 * inverse ** 2 * time * operation.cp1y + 3 * inverse * time ** 2 * operation.cp2y + time ** 3 * operation.y,
        })
      }
      current = { x: operation.x, y: operation.y }
    } else if (operation.kind === 'close') finish()
  }
  finish()
  return contourAreas.some((area) => Number.isFinite(area) && area > 0)
}

export function resolveCustomCarrierBoundary(pathData) {
  if (typeof pathData !== 'string' || pathData.length === 0) return undefined
  try {
    const commands = parseNormalizedSvgPath(pathData)
    const drawable = drawableClosedCommands(commands)
    if (!drawable) return undefined
    const pathBounds = svgPathBounds(drawable)
    if (!(pathBounds.width > 0) || !(pathBounds.height > 0) || !hasPositiveRenderedArea(pathData, pathBounds)) return undefined
    return Object.freeze({ pathData, pathBounds: Object.freeze(pathBounds) })
  } catch {
    return undefined
  }
}
