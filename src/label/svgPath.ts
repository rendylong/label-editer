import {
  hasOpenSvgSubpath as portableHasOpenSvgSubpath,
  parseNormalizedSvgPath as portableParseNormalizedSvgPath,
  serializeNormalizedSvgPath as portableSerializeNormalizedSvgPath,
  svgPathBounds as portableSvgPathBounds,
  traceNormalizedSvgPath as portableTraceNormalizedSvgPath,
  traceValidatedSvgPath as portableTraceValidatedSvgPath,
  validateSvgPathViewBox as portableValidateSvgPathViewBox,
} from '../../scripts/lib/svg-path-core.mjs'

export interface SvgMoveTo { readonly kind: 'moveTo'; readonly x: number; readonly y: number }
export interface SvgLineTo { readonly kind: 'lineTo'; readonly x: number; readonly y: number }
export interface SvgCubicTo { readonly kind: 'cubicTo'; readonly cp1x: number; readonly cp1y: number; readonly cp2x: number; readonly cp2y: number; readonly x: number; readonly y: number }
export interface SvgQuadraticTo { readonly kind: 'quadraticTo'; readonly cpx: number; readonly cpy: number; readonly x: number; readonly y: number }
export interface SvgArcTo {
  readonly kind: 'arcTo'
  readonly rx: number
  readonly ry: number
  readonly rotation: number
  readonly largeArc: boolean
  readonly sweep: boolean
  readonly x: number
  readonly y: number
}
export interface SvgClose { readonly kind: 'close' }

export type NormalizedSvgPathCommand = SvgMoveTo | SvgLineTo | SvgCubicTo | SvgQuadraticTo | SvgArcTo | SvgClose
export type NormalizedSvgPath = readonly NormalizedSvgPathCommand[]

export interface SvgPathTraceContext {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  closePath(): void
}

export interface SvgPathBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Typed browser/editor facade over the single portable Node/browser core. */
export const parseNormalizedSvgPath = portableParseNormalizedSvgPath as (source: string) => NormalizedSvgPath
export const serializeNormalizedSvgPath = portableSerializeNormalizedSvgPath as (commands: readonly NormalizedSvgPathCommand[]) => string
export const validateSvgPathViewBox: (viewBox: readonly number[] | undefined) => asserts viewBox is readonly [number, number, number, number]
  = portableValidateSvgPathViewBox
export const traceNormalizedSvgPath = portableTraceNormalizedSvgPath as (
  context: SvgPathTraceContext,
  commands: readonly NormalizedSvgPathCommand[],
  viewBox: readonly [number, number, number, number] | undefined,
  width: number,
  height: number,
) => void
export const svgPathBounds = portableSvgPathBounds as (commands: readonly NormalizedSvgPathCommand[]) => SvgPathBounds
export const traceValidatedSvgPath = portableTraceValidatedSvgPath as (
  context: SvgPathTraceContext,
  source: string,
  viewBox: readonly [number, number, number, number] | undefined,
  width: number,
  height: number,
) => NormalizedSvgPath
export const hasOpenSvgSubpath = portableHasOpenSvgSubpath as (commands: readonly NormalizedSvgPathCommand[]) => boolean
