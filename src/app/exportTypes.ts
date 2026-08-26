/**
 * 导出跨模块共享类型。
 */

export interface BakeInput {
  color: HTMLCanvasElement
  metalness?: HTMLCanvasElement
  roughness?: HTMLCanvasElement
  bump?: HTMLCanvasElement
  /** Selective production separation; not attached to the GLB material shader. */
  whiteUnderbase?: HTMLCanvasElement
  /** Runtime bake revision used to bind production-separation proof. */
  version?: number
}
