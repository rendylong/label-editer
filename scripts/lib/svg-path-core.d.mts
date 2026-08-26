export interface PortableSvgPathTraceContext {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  closePath(): void
}

export type PortableSvgPathCommand = Readonly<Record<string, string | number | boolean>> & { readonly kind: string }

export function parseNormalizedSvgPath(source: string): readonly PortableSvgPathCommand[]
export function serializeNormalizedSvgPath(commands: readonly PortableSvgPathCommand[]): string
export function validateSvgPathViewBox(viewBox: readonly number[] | undefined): asserts viewBox is readonly [number, number, number, number]
export function traceNormalizedSvgPath(
  context: PortableSvgPathTraceContext,
  commands: readonly PortableSvgPathCommand[],
  viewBox: readonly [number, number, number, number] | undefined,
  width: number,
  height: number,
): void
export function svgPathBounds(commands: readonly PortableSvgPathCommand[]): { x: number; y: number; width: number; height: number }
export function traceValidatedSvgPath(
  context: PortableSvgPathTraceContext,
  source: string,
  viewBox: readonly [number, number, number, number] | undefined,
  width: number,
  height: number,
): readonly PortableSvgPathCommand[]
export function hasOpenSvgSubpath(commands: readonly PortableSvgPathCommand[]): boolean
