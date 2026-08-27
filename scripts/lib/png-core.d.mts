export interface PortablePngDimensionPolicy {
  expectedWidth?: number
  expectedHeight?: number
  maxWidth?: number
  maxHeight?: number
  maxPixels?: number
}
export function parsePortablePng(input: Uint8Array | ArrayBuffer, policy?: PortablePngDimensionPolicy): Readonly<{ width: number; height: number }>
export function portablePngDimensions(input: Uint8Array | ArrayBuffer, policy?: PortablePngDimensionPolicy): Readonly<{ width: number; height: number }> | undefined
