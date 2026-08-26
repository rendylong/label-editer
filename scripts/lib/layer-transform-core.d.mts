export interface PortableLayerTransformInput { x: number; y: number; rotation: number; width: number; height: number; anchor?: 'top_left'|'top_center'|'center'|'baseline_left'|'baseline_center'; baselineFromTop?: number }
export interface PortableLayerTransform { origin: {x:number;y:number}; rotation:number; box:{x:number;y:number;width:number;height:number}; worldBounds:{x:number;y:number;width:number;height:number} }
export function resolvePortableLayerTransform(input: PortableLayerTransformInput): PortableLayerTransform
export function fallbackTextBaselineFromTop(fontSize: number, lineHeight: number): number
