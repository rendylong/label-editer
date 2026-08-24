/**
 * 区域坐标辅助：3D 表面点 ↔ (u, v) 映射、2D 展开图转换与区域边界几何。
 * 与 uvRemap 的 u/v 定义完全一致（纯函数，可单测）。
 */

import type { RemapParams, LabelAreaRange } from '../label/types'
import { basisForAxis, cylindricalAngleToU, cylindricalUToAngle, applyUHandedness } from './uvRemap'

export interface UV {
  u: number
  v: number
}

export interface PickerRect {
  x: number
  y: number
  width: number
  height: number
}

const MIN_AREA_SIZE = 0.05
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const clean = (value: number): number => Number(value.toFixed(12))

/** 将区域约束在完整的 0..1 展开面内。 */
export function normalizeAreaRange(range: LabelAreaRange): LabelAreaRange {
  const uWidth = clamp(range.uWidth, MIN_AREA_SIZE, 1)
  const vHeight = clamp(range.vHeight, MIN_AREA_SIZE, 1)
  return {
    uStart: clean(clamp(range.uStart, 0, 1 - uWidth)),
    uWidth: clean(uWidth),
    vStart: clean(clamp(range.vStart, 0, 1 - vHeight)),
    vHeight: clean(vHeight),
  }
}

/** 3D UV 范围（v=0 在底部）→ 2D 选择框（y=0 在顶部）。 */
export function rangeToPickerRect(range: LabelAreaRange): PickerRect {
  const normalized = normalizeAreaRange(range)
  return {
    x: normalized.uStart,
    y: clean(1 - normalized.vStart - normalized.vHeight),
    width: normalized.uWidth,
    height: normalized.vHeight,
  }
}

/** 2D 选择框 → 3D UV 范围，并保证选区不会越出展开面。 */
export function pickerRectToRange(rect: PickerRect): LabelAreaRange {
  const width = clamp(rect.width, MIN_AREA_SIZE, 1)
  const height = clamp(rect.height, MIN_AREA_SIZE, 1)
  const x = clamp(rect.x, 0, 1 - width)
  const y = clamp(rect.y, 0, 1 - height)
  return normalizeAreaRange({
    uStart: x,
    uWidth: width,
    vStart: clean(1 - y - height),
    vHeight: height,
  })
}

/** 表面点 → 圆柱 (u, v)。点必须在圆柱表面附近（用半径方向投影近似）。 */
export function surfaceToUV(point: [number, number, number], remap: RemapParams, axisMin: number, axisMax: number): UV {
  const { axis, origin } = remap
  const { u0, u1 } = basisForAxis(axis)
  const dx = point[0] - origin[0]
  const dy = point[1] - origin[1]
  const dz = point[2] - origin[2]
  const along = dx * axis[0] + dy * axis[1] + dz * axis[2]
  const px = dx - along * axis[0]
  const py = dy - along * axis[1]
  const pz = dz - along * axis[2]
  const angle = Math.atan2(px * u0[0] + py * u0[1] + pz * u0[2], px * u1[0] + py * u1[1] + pz * u1[2])
  const u = applyUHandedness(cylindricalAngleToU(angle, remap.wrap, remap.offset), remap.mirrorU)
  const v = (along - axisMin) / Math.max(axisMax - axisMin, 1e-6)
  return { u, v }
}

/** 由 (u, v) 生成圆柱表面上一点（控制框几何用）。 */
export function uvToSurface(u: number, v: number, remap: RemapParams, axisMin: number, axisMax: number): [number, number, number] {
  const { axis, origin, radius } = remap
  const { u0, u1 } = basisForAxis(axis)
  // angle = atan2(p·u0, p·u1) = π/2 - θ；由统一 U 约定反解 θ。
  const localU = applyUHandedness(u, remap.mirrorU)
  const theta = Math.PI / 2 - cylindricalUToAngle(localU, remap.wrap, remap.offset)
  const dirX = Math.cos(theta) * u0[0] + Math.sin(theta) * u1[0]
  const dirY = Math.cos(theta) * u0[1] + Math.sin(theta) * u1[1]
  const dirZ = Math.cos(theta) * u0[2] + Math.sin(theta) * u1[2]
  const along = axisMin + v * (axisMax - axisMin)
  return [origin[0] + axis[0] * along + dirX * radius, origin[1] + axis[1] * along + dirY * radius, origin[2] + axis[2] * along + dirZ * radius]
}

/** 区域边界采样点（3D 控制框）。segments = 每条边采样数。 */
export function areaBoxPoints(
  remap: RemapParams,
  range: LabelAreaRange,
  axisMin: number,
  axisMax: number,
  segments = 24,
): { top: [number, number, number][]; bottom: [number, number, number][]; left: [number, number, number][]; right: [number, number, number][] } {
  const u0 = range.uStart
  const u1 = range.uStart + range.uWidth
  const v0 = range.vStart
  const v1 = range.vStart + range.vHeight
  const top: [number, number, number][] = []
  const bottom: [number, number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const u = u0 + ((u1 - u0) * i) / segments
    top.push(uvToSurface(u, v1, remap, axisMin, axisMax))
    bottom.push(uvToSurface(u, v0, remap, axisMin, axisMax))
  }
  const left: [number, number, number][] = []
  const right: [number, number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const v = v0 + ((v1 - v0) * i) / segments
    left.push(uvToSurface(u0, v, remap, axisMin, axisMax))
    right.push(uvToSurface(u1, v, remap, axisMin, axisMax))
  }
  return { top, bottom, left, right }
}

/** 控制点（角 + 边中点），返回 (u, v, key)。 */
export function areaControlPoints(range: LabelAreaRange): { key: string; u: number; v: number }[] {
  const { uStart, uWidth, vStart, vHeight } = range
  return [
    { key: 'tl', u: uStart, v: vStart },
    { key: 'tr', u: uStart + uWidth, v: vStart },
    { key: 'bl', u: uStart, v: vStart + vHeight },
    { key: 'br', u: uStart + uWidth, v: vStart + vHeight },
    { key: 'left', u: uStart, v: vStart + vHeight / 2 },
    { key: 'right', u: uStart + uWidth, v: vStart + vHeight / 2 },
    { key: 'top', u: uStart + uWidth / 2, v: vStart + vHeight },
    { key: 'bottom', u: uStart + uWidth / 2, v: vStart },
  ]
}

/** 由拖拽目标 (u, v) 更新 range（角点/边语义，对角/对边固定）。返回新 range。 */
export function applyDragToRange(key: string, u: number, v: number, range: LabelAreaRange): LabelAreaRange {
  const r = { ...range }
  const minSize = MIN_AREA_SIZE
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
  const right = clamp01(range.uStart + range.uWidth)
  const top = clamp01(range.vStart + range.vHeight)
  switch (key) {
    case 'tl':
      r.uStart = clamp01(Math.min(u, right - minSize))
      r.vStart = clamp01(Math.min(v, top - minSize))
      r.uWidth = right - r.uStart
      r.vHeight = top - r.vStart
      break
    case 'tr':
      r.uWidth = clamp01(Math.max(u - r.uStart, minSize))
      r.vStart = clamp01(Math.min(v, top - minSize))
      r.vHeight = top - r.vStart
      break
    case 'bl':
      r.uStart = clamp01(Math.min(u, right - minSize))
      r.uWidth = right - r.uStart
      r.vHeight = clamp01(Math.max(v - r.vStart, minSize))
      break
    case 'br':
      r.uWidth = clamp01(Math.max(u - r.uStart, minSize))
      r.vHeight = clamp01(Math.max(v - r.vStart, minSize))
      break
    case 'left':
      r.uStart = clamp01(Math.min(u, right - minSize))
      r.uWidth = right - r.uStart
      break
    case 'right':
      r.uWidth = clamp01(Math.max(u - r.uStart, minSize))
      break
    case 'top':
      r.vHeight = clamp01(Math.max(v - r.vStart, minSize))
      break
    case 'bottom':
      r.vStart = clamp01(Math.min(v, top - minSize))
      r.vHeight = top - r.vStart
      break
  }
  return normalizeAreaRange(r)
}
