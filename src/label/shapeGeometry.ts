import type { ShapeGeometry, ShapeLayer } from './types'
import { traceValidatedSvgPath } from './svgPath'

export interface MoveTo {
  type: 'moveTo'
  x: number
  y: number
}

export interface LineTo {
  type: 'lineTo'
  x: number
  y: number
}

export interface BezierTo {
  type: 'bezierTo'
  cp1x: number
  cp1y: number
  cp2x: number
  cp2y: number
  x: number
  y: number
}

export interface Arc {
  type: 'arc'
  x: number
  y: number
  radius: number
  startAngle: number
  endAngle: number
  anticlockwise?: boolean
}

export interface Close {
  type: 'close'
}

export type ShapeCommand = MoveTo | LineTo | BezierTo | Arc | Close

export interface ShapeDrawingContext {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean): void
  closePath(): void
}

const DEFAULT_GEOMETRY = {
  sides: 6,
  points: 5,
  innerRatio: 0.5,
  frequency: 3,
  arrowStart: false,
  arrowEnd: false,
  rows: 3,
  columns: 5,
} as const

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function clampedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.round(clamp(finite(value, fallback), minimum, maximum))
}

function normalizeDimension(value: number): number {
  const normalized = Math.abs(finite(value, 1))
  return Math.max(1, normalized)
}

function safeInteger(value: number | undefined, fallback: number): number {
  return clamp(Math.round(finite(value, fallback)), Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
}

function normalizeGeometry(geometry: ShapeGeometry | undefined, width: number, height: number): Required<ShapeGeometry> {
  const source = geometry ?? {}
  const maximumInset = Math.min(width, height) / 2
  const defaultGap = Math.min(width / (DEFAULT_GEOMETRY.columns + 1), height / (DEFAULT_GEOMETRY.rows + 1))
  return {
    sides: clampedInteger(source.sides, DEFAULT_GEOMETRY.sides, 3, 32),
    points: clampedInteger(source.points, DEFAULT_GEOMETRY.points, 3, 32),
    innerRatio: clamp(finite(source.innerRatio, DEFAULT_GEOMETRY.innerRatio), 0.05, 0.95),
    amplitude: clamp(finite(source.amplitude, height / 4), 0, height / 2),
    frequency: clamp(finite(source.frequency, DEFAULT_GEOMETRY.frequency), 0.5, 32),
    arrowStart: source.arrowStart === true,
    arrowEnd: source.arrowEnd === true,
    parallel: source.parallel === true,
    dash: Array.isArray(source.dash) ? source.dash.filter((value) => Number.isFinite(value) && value > 0) : [],
    inset: clamp(finite(source.inset, Math.min(12, maximumInset)), 0, maximumInset),
    rows: clampedInteger(source.rows, DEFAULT_GEOMETRY.rows, 1, 32),
    columns: clampedInteger(source.columns, DEFAULT_GEOMETRY.columns, 1, 32),
    gap: clamp(finite(source.gap, defaultGap), 0, Math.max(width, height)),
  }
}

/** Return a safe copy without changing the project layer supplied by the caller. */
export function normalizeShapeLayer(layer: ShapeLayer): ShapeLayer {
  const width = normalizeDimension(layer.width)
  const height = normalizeDimension(layer.height)
  const geometry = normalizeGeometry(layer.geometry, width, height)
  return {
    ...layer,
    width,
    height,
    geometry,
    cornerRadius: clamp(finite(layer.cornerRadius, 0), 0, Math.min(width, height) / 2),
    strokeWidth: Math.max(0, finite(layer.strokeWidth, 0)),
    x: finite(layer.x, 0),
    y: finite(layer.y, 0),
    rotation: finite(layer.rotation, 0),
    opacity: clamp(finite(layer.opacity, 1), 0, 1),
    zIndex: safeInteger(layer.zIndex, 0),
  }
}

function polygonCommands(width: number, height: number, points: number, alternatingRatio?: number): ShapeCommand[] {
  const commands: ShapeCommand[] = []
  const vertexCount = alternatingRatio === undefined ? points : points * 2
  for (let index = 0; index < vertexCount; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / vertexCount
    const ratio = alternatingRatio !== undefined && index % 2 === 1 ? alternatingRatio : 1
    const point = {
      x: Math.cos(angle) * width * 0.5 * ratio,
      y: Math.sin(angle) * height * 0.5 * ratio,
    }
    commands.push(index === 0 ? { type: 'moveTo', ...point } : { type: 'lineTo', ...point })
  }
  commands.push({ type: 'close' })
  return commands
}

function rectangleCommands(width: number, height: number, radius: number): ShapeCommand[] {
  const halfWidth = width / 2
  const halfHeight = height / 2
  if (radius <= 0) {
    return [
      { type: 'moveTo', x: -halfWidth, y: -halfHeight },
      { type: 'lineTo', x: halfWidth, y: -halfHeight },
      { type: 'lineTo', x: halfWidth, y: halfHeight },
      { type: 'lineTo', x: -halfWidth, y: halfHeight },
      { type: 'close' },
    ]
  }
  return [
    { type: 'moveTo', x: -halfWidth + radius, y: -halfHeight },
    { type: 'lineTo', x: halfWidth - radius, y: -halfHeight },
    { type: 'arc', x: halfWidth - radius, y: -halfHeight + radius, radius, startAngle: -Math.PI / 2, endAngle: 0 },
    { type: 'lineTo', x: halfWidth, y: halfHeight - radius },
    { type: 'arc', x: halfWidth - radius, y: halfHeight - radius, radius, startAngle: 0, endAngle: Math.PI / 2 },
    { type: 'lineTo', x: -halfWidth + radius, y: halfHeight },
    { type: 'arc', x: -halfWidth + radius, y: halfHeight - radius, radius, startAngle: Math.PI / 2, endAngle: Math.PI },
    { type: 'lineTo', x: -halfWidth, y: -halfHeight + radius },
    { type: 'arc', x: -halfWidth + radius, y: -halfHeight + radius, radius, startAngle: Math.PI, endAngle: Math.PI * 1.5 },
    { type: 'close' },
  ]
}

function counterClockwiseRectangleCommands(width: number, height: number, radius: number): ShapeCommand[] {
  const halfWidth = width / 2
  const halfHeight = height / 2
  if (radius <= 0) {
    return [
      { type: 'moveTo', x: -halfWidth, y: -halfHeight },
      { type: 'lineTo', x: -halfWidth, y: halfHeight },
      { type: 'lineTo', x: halfWidth, y: halfHeight },
      { type: 'lineTo', x: halfWidth, y: -halfHeight },
      { type: 'close' },
    ]
  }
  return [
    { type: 'moveTo', x: -halfWidth + radius, y: -halfHeight },
    { type: 'arc', x: -halfWidth + radius, y: -halfHeight + radius, radius, startAngle: -Math.PI / 2, endAngle: -Math.PI, anticlockwise: true },
    { type: 'lineTo', x: -halfWidth, y: halfHeight - radius },
    { type: 'arc', x: -halfWidth + radius, y: halfHeight - radius, radius, startAngle: Math.PI, endAngle: Math.PI / 2, anticlockwise: true },
    { type: 'lineTo', x: halfWidth - radius, y: halfHeight },
    { type: 'arc', x: halfWidth - radius, y: halfHeight - radius, radius, startAngle: Math.PI / 2, endAngle: 0, anticlockwise: true },
    { type: 'lineTo', x: halfWidth, y: -halfHeight + radius },
    { type: 'arc', x: halfWidth - radius, y: -halfHeight + radius, radius, startAngle: 0, endAngle: -Math.PI / 2, anticlockwise: true },
    { type: 'close' },
  ]
}

function ellipseCommands(width: number, height: number): ShapeCommand[] {
  const rx = width / 2
  const ry = height / 2
  const kappa = 0.5522847498307936
  return [
    { type: 'moveTo', x: rx, y: 0 },
    { type: 'bezierTo', cp1x: rx, cp1y: ry * kappa, cp2x: rx * kappa, cp2y: ry, x: 0, y: ry },
    { type: 'bezierTo', cp1x: -rx * kappa, cp1y: ry, cp2x: -rx, cp2y: ry * kappa, x: -rx, y: 0 },
    { type: 'bezierTo', cp1x: -rx, cp1y: -ry * kappa, cp2x: -rx * kappa, cp2y: -ry, x: 0, y: -ry },
    { type: 'bezierTo', cp1x: rx * kappa, cp1y: -ry, cp2x: rx, cp2y: -ry * kappa, x: rx, y: 0 },
    { type: 'close' },
  ]
}

function lineCommands(width: number, height: number, geometry: Required<ShapeGeometry>): ShapeCommand[] {
  const halfWidth = width / 2
  if (geometry.parallel) {
    const halfGap = Math.min(height / 2, geometry.gap / 2)
    return [
      { type: 'moveTo', x: -halfWidth, y: -halfGap },
      { type: 'lineTo', x: halfWidth, y: -halfGap },
      { type: 'moveTo', x: -halfWidth, y: halfGap },
      { type: 'lineTo', x: halfWidth, y: halfGap },
    ]
  }
  const arrowDepth = Math.min(width / 4, Math.max(6, height / 2))
  const arrowHalfHeight = Math.min(height / 2, Math.max(3, arrowDepth / 2))
  const commands: ShapeCommand[] = [
    { type: 'moveTo', x: -halfWidth, y: 0 },
    { type: 'lineTo', x: halfWidth, y: 0 },
  ]
  if (geometry.arrowStart) {
    commands.push(
      { type: 'moveTo', x: -halfWidth + arrowDepth, y: -arrowHalfHeight },
      { type: 'lineTo', x: -halfWidth, y: 0 },
      { type: 'lineTo', x: -halfWidth + arrowDepth, y: arrowHalfHeight },
    )
  }
  if (geometry.arrowEnd) {
    commands.push(
      { type: 'moveTo', x: halfWidth - arrowDepth, y: -arrowHalfHeight },
      { type: 'lineTo', x: halfWidth, y: 0 },
      { type: 'lineTo', x: halfWidth - arrowDepth, y: arrowHalfHeight },
    )
  }
  return commands
}

function waveCommands(width: number, amplitude: number, frequency: number): ShapeCommand[] {
  const segments = Math.max(8, Math.ceil(frequency * 16))
  const commands: ShapeCommand[] = [{ type: 'moveTo', x: -width / 2, y: 0 }]
  for (let index = 1; index <= segments; index += 1) {
    const progress = index / segments
    commands.push({
      type: 'lineTo',
      x: -width / 2 + width * progress,
      y: Math.sin(progress * frequency * Math.PI * 2) * amplitude,
    })
  }
  return commands
}

function crossCommands(width: number, height: number, inset: number): ShapeCommand[] {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const armHalfWidth = Math.max(0.5, Math.min(halfWidth, inset || width * 0.15))
  const armHalfHeight = Math.max(0.5, Math.min(halfHeight, inset || height * 0.15))
  return [
    { type: 'moveTo', x: -armHalfWidth, y: -halfHeight },
    { type: 'lineTo', x: armHalfWidth, y: -halfHeight },
    { type: 'lineTo', x: armHalfWidth, y: -armHalfHeight },
    { type: 'lineTo', x: halfWidth, y: -armHalfHeight },
    { type: 'lineTo', x: halfWidth, y: armHalfHeight },
    { type: 'lineTo', x: armHalfWidth, y: armHalfHeight },
    { type: 'lineTo', x: armHalfWidth, y: halfHeight },
    { type: 'lineTo', x: -armHalfWidth, y: halfHeight },
    { type: 'lineTo', x: -armHalfWidth, y: armHalfHeight },
    { type: 'lineTo', x: -halfWidth, y: armHalfHeight },
    { type: 'lineTo', x: -halfWidth, y: -armHalfHeight },
    { type: 'lineTo', x: -armHalfWidth, y: -armHalfHeight },
    { type: 'close' },
  ]
}

function bracketCommands(width: number, height: number, inset: number): ShapeCommand[] {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const depth = Math.min(width / 2, inset || width / 5)
  return [
    { type: 'moveTo', x: -halfWidth + depth, y: -halfHeight },
    { type: 'lineTo', x: -halfWidth, y: -halfHeight },
    { type: 'lineTo', x: -halfWidth, y: halfHeight },
    { type: 'lineTo', x: -halfWidth + depth, y: halfHeight },
    { type: 'moveTo', x: halfWidth - depth, y: -halfHeight },
    { type: 'lineTo', x: halfWidth, y: -halfHeight },
    { type: 'lineTo', x: halfWidth, y: halfHeight },
    { type: 'lineTo', x: halfWidth - depth, y: halfHeight },
  ]
}

function dotGridCommands(width: number, height: number, rows: number, columns: number, requestedGap: number): ShapeCommand[] {
  const dotRadius = Math.max(0.25, Math.min(width / (columns * 4), height / (rows * 4), requestedGap > 0 ? requestedGap / 4 : Number.POSITIVE_INFINITY))
  const maxHorizontalGap = columns > 1 ? (width - dotRadius * 2) / (columns - 1) : 0
  const maxVerticalGap = rows > 1 ? (height - dotRadius * 2) / (rows - 1) : 0
  const horizontalGap = columns > 1 ? Math.min(requestedGap || maxHorizontalGap, maxHorizontalGap) : 0
  const verticalGap = rows > 1 ? Math.min(requestedGap || maxVerticalGap, maxVerticalGap) : 0
  const commands: ShapeCommand[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = (column - (columns - 1) / 2) * horizontalGap
      const y = (row - (rows - 1) / 2) * verticalGap
      commands.push(
        { type: 'moveTo', x: x + dotRadius, y },
        { type: 'arc', x, y, radius: dotRadius, startAngle: 0, endAngle: Math.PI * 2 },
        { type: 'close' },
      )
    }
  }
  return commands
}

/** Build renderer-independent path commands in layer-local centered coordinates. */
export function shapeCommands(layer: ShapeLayer): ShapeCommand[] {
  const normalized = normalizeShapeLayer(layer)
  const { width, height } = normalized
  const geometry = normalized.geometry as Required<ShapeGeometry>
  switch (normalized.shape) {
    case 'path': {
      if (!normalized.pathData || !normalized.pathViewBox) throw new Error('Path shapes require pathData and pathViewBox')
      const commands: ShapeCommand[] = []
      traceValidatedSvgPath({
        moveTo: (x, y) => commands.push({ type: 'moveTo', x, y }),
        lineTo: (x, y) => commands.push({ type: 'lineTo', x, y }),
        bezierCurveTo: (cp1x, cp1y, cp2x, cp2y, x, y) => commands.push({ type: 'bezierTo', cp1x, cp1y, cp2x, cp2y, x, y }),
        closePath: () => commands.push({ type: 'close' }),
      }, normalized.pathData, normalized.pathViewBox, width, height)
      return commands
    }
    case 'rectangle': return rectangleCommands(width, height, normalized.cornerRadius)
    case 'ellipse': return ellipseCommands(width, height)
    case 'triangle': return [
      { type: 'moveTo', x: 0, y: -height / 2 },
      { type: 'lineTo', x: width / 2, y: height / 2 },
      { type: 'lineTo', x: -width / 2, y: height / 2 },
      { type: 'close' },
    ]
    case 'diamond': return [
      { type: 'moveTo', x: 0, y: -height / 2 },
      { type: 'lineTo', x: width / 2, y: 0 },
      { type: 'lineTo', x: 0, y: height / 2 },
      { type: 'lineTo', x: -width / 2, y: 0 },
      { type: 'close' },
    ]
    case 'polygon': return polygonCommands(width, height, geometry.sides)
    case 'star': return polygonCommands(width, height, geometry.points, geometry.innerRatio)
    case 'line': return lineCommands(width, height, geometry)
    case 'wave': return waveCommands(width, geometry.amplitude, geometry.frequency)
    case 'burst': return polygonCommands(width, height, geometry.points, geometry.innerRatio)
    case 'cross': return crossCommands(width, height, geometry.inset)
    case 'bracket': return bracketCommands(width, height, geometry.inset)
    case 'dot-grid': return dotGridCommands(width, height, geometry.rows, geometry.columns, geometry.gap)
    case 'frame': {
      const inset = geometry.inset
      const innerWidth = Math.max(1, width - inset * 2)
      const innerHeight = Math.max(1, height - inset * 2)
      return [
        ...rectangleCommands(width, height, normalized.cornerRadius),
        ...counterClockwiseRectangleCommands(innerWidth, innerHeight, Math.max(0, normalized.cornerRadius - inset)),
      ]
    }
  }
}

/** Replay an already-derived command list without rebuilding or mutating it. */
export function traceShapeCommands(ctx: ShapeDrawingContext, commands: readonly ShapeCommand[]): void {
  for (const command of commands) {
    switch (command.type) {
      case 'moveTo': ctx.moveTo(command.x, command.y); break
      case 'lineTo': ctx.lineTo(command.x, command.y); break
      case 'bezierTo': ctx.bezierCurveTo(command.cp1x, command.cp1y, command.cp2x, command.cp2y, command.x, command.y); break
      case 'arc': ctx.arc(command.x, command.y, command.radius, command.startAngle, command.endAngle, command.anticlockwise); break
      case 'close': ctx.closePath(); break
    }
  }
}

/** Replay shared shape commands onto a Konva or Canvas-compatible path context. */
export function traceShape(ctx: ShapeDrawingContext, layer: ShapeLayer): void {
  traceShapeCommands(ctx, shapeCommands(layer))
}
