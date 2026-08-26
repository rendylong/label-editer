export function resolveCustomCarrierBoundary(pathData: unknown): Readonly<{
  pathData: string
  pathBounds: Readonly<{ x: number; y: number; width: number; height: number }>
}> | undefined
