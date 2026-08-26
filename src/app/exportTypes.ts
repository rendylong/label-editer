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
}
