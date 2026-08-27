export interface PortableLayerZOrder {
  id: string
  zIndex: number
}

export function compareCodeUnitOrdinal(left: string, right: string): number
export function comparePortableLayerZOrder(left: PortableLayerZOrder, right: PortableLayerZOrder): number
export function orderedPortableLayers<T extends PortableLayerZOrder>(layers: readonly T[]): T[]
