/**
 * 圆柱坐标辅助（3D 区域控制框）黄金用例：surfaceToUV ↔ uvToSurface 互逆、控制点、拖拽语义。
 */

import { describe, it, expect } from 'vitest'
import { makeDefaultRemap, computeRemap } from '../src/glb/uvRemap'
import * as areaMath from '../src/glb/areaMath'
import { surfaceToUV, uvToSurface, areaBoxPoints, areaControlPoints, applyDragToRange } from '../src/glb/areaMath'
import type { MeshAccessors } from '../src/glb/uvRemap'

// 合成圆柱（半径 10、高 20、沿 Y）
function synthCylinder(seg = 32, heightSeg = 8): MeshAccessors {
  const positions: number[] = []
  const uv: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= heightSeg; i++) {
    const y = -10 + (20 * i) / heightSeg
    for (let j = 0; j <= seg; j++) {
      const a = (2 * Math.PI * j) / seg
      positions.push(Math.cos(a) * 10, y, Math.sin(a) * 10)
      uv.push(j / seg, i / heightSeg)
    }
  }
  const cols = seg + 1
  for (let i = 0; i < heightSeg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * cols + j
      const b = a + 1
      const c = a + cols
      const d = c + 1
      indices.push(a, b, c, b, d, c)
    }
  }
  return { positions: new Float32Array(positions), uv: new Float32Array(uv), indices: new Uint32Array(indices), triangleCount: indices.length / 3 }
}

const remapParams = { mode: 'cylindrical' as const, axis: [0, 1, 0] as [number, number, number], origin: [0, 0, 0] as [number, number, number], radius: 10, wrap: 1, offset: 0, planarBox: { min: [-1, 0, 0] as [number, number, number], max: [1, 0, 0] as [number, number, number] } }

describe('圆柱坐标辅助（3D 区域控制框）', () => {
  it('2D 展开图顶部对应 3D 高处，并可无损转换回区域范围', () => {
    const toRect = (areaMath as typeof areaMath & {
      rangeToPickerRect?: (range: { uStart: number; uWidth: number; vStart: number; vHeight: number }) => {
        x: number
        y: number
        width: number
        height: number
      }
    }).rangeToPickerRect
    const toRange = (areaMath as typeof areaMath & {
      pickerRectToRange?: (rect: { x: number; y: number; width: number; height: number }) => {
        uStart: number
        uWidth: number
        vStart: number
        vHeight: number
      }
    }).pickerRectToRange

    const rect = toRect?.({ uStart: 0.2, uWidth: 0.4, vStart: 0.1, vHeight: 0.3 })
    expect(rect).toEqual({ x: 0.2, y: 0.6, width: 0.4, height: 0.3 })
    expect(toRange?.(rect!)).toEqual({ uStart: 0.2, uWidth: 0.4, vStart: 0.1, vHeight: 0.3 })
  })

  it('2D 选区移动或缩放后始终完整留在展开图内', () => {
    const toRange = (areaMath as typeof areaMath & {
      pickerRectToRange?: (rect: { x: number; y: number; width: number; height: number }) => {
        uStart: number
        uWidth: number
        vStart: number
        vHeight: number
      }
    }).pickerRectToRange

    expect(toRange?.({ x: 0.9, y: -0.2, width: 0.4, height: 0.5 })).toEqual({
      uStart: 0.6,
      uWidth: 0.4,
      vStart: 0.5,
      vHeight: 0.5,
    })
  })

  it('画布 U 增大时沿模型正面从左向右，避免文字水平镜像', () => {
    const center = uvToSurface(0.5, 0.5, remapParams, -10, 10)
    const right = uvToSurface(0.6, 0.5, remapParams, -10, 10)

    // axis=Y 时默认正面是 -X；从 -X 朝原点看，屏幕右方是 +Z。
    expect(center[0]).toBeCloseTo(-10, 4)
    expect(center[2]).toBeCloseTo(0, 4)
    expect(right[2]).toBeGreaterThan(0)
  })

  it('surfaceToUV 与 uvToSurface 互逆（u 扫描全圈、v 扫描全高）', () => {
    const axisMin = -10
    const axisMax = 10
    for (const u of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.999]) {
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        const p = uvToSurface(u, v, remapParams, axisMin, axisMax)
        const back = surfaceToUV(p, remapParams, axisMin, axisMax)
        // u 允许环绕误差（0.999 → ~0）
        let du = Math.abs(back.u - u)
        if (du > 0.5) du = 1 - du
        expect(du).toBeLessThan(1e-3)
        expect(Math.abs(back.v - v)).toBeLessThan(1e-3)
      }
    }
  })

  it('uvToSurface 的点落在圆柱面上（半径 = remap.radius）', () => {
    const p = uvToSurface(0.3, 0.4, remapParams, -10, 10)
    const r = Math.sqrt(p[0] * p[0] + p[2] * p[2])
    expect(r).toBeCloseTo(10, 4)
  })

  it('区域边界线覆盖区域矩形且控制点 = 8 个（4 角 + 4 边中点）', () => {
    const range = { uStart: 0.2, uWidth: 0.4, vStart: 0.3, vHeight: 0.4 }
    const box = areaBoxPoints(remapParams, range, -10, 10, 8)
    expect(box.top.length).toBe(9)
    expect(box.bottom.length).toBe(9)
    expect(box.left.length).toBe(9)
    expect(box.right.length).toBe(9)
    // 顶部边 v = vStart+vHeight
    const [_, vy] = [box.top[0][0], box.top[0][1]]
    const vTop = (vy - -10) / 20
    expect(vTop).toBeCloseTo(range.vStart + range.vHeight, 3)
    const cps = areaControlPoints(range)
    expect(cps.length).toBe(8)
    expect(cps.map((c) => c.key)).toEqual(['tl', 'tr', 'bl', 'br', 'left', 'right', 'top', 'bottom'])
  })

  it('拖拽语义：拖右边界调 uWidth、拖上边界调 vHeight、拖角点组合调整', () => {
    const range = { uStart: 0.2, uWidth: 0.4, vStart: 0.3, vHeight: 0.4 }
    // 拖 right 到 u=0.8 → uWidth = 0.6
    let r1 = applyDragToRange('right', 0.8, 0.5, range)
    expect(r1.uWidth).toBeCloseTo(0.6, 6)
    // 拖 top 到 v=0.9 → vHeight = 0.6
    let r2 = applyDragToRange('top', 0.5, 0.9, range)
    expect(r2.vHeight).toBeCloseTo(0.6, 6)
    // 拖 tl 到 (0.1, 0.2) → uStart=0.1, vStart=0.2（宽度/高度保持）
    const r3 = applyDragToRange('tl', 0.1, 0.2, range)
    expect(r3.uStart).toBeCloseTo(0.1, 6)
    expect(r3.vStart).toBeCloseTo(0.2, 6)
    expect(r3.uWidth).toBeCloseTo(0.5, 6) // uStart+uWidth=0.6 不变
    expect(r3.vHeight).toBeCloseTo(0.5, 6) // vStart+vHeight=0.7 不变
    // 最小尺寸约束
    const r4 = applyDragToRange('right', 0.1, 0.5, range)
    expect(r4.uWidth).toBeGreaterThanOrEqual(0.05)
    const r4b = applyDragToRange('right', 1.5, 0.5, range)
    expect(r4b.uStart + r4b.uWidth).toBeLessThanOrEqual(1)
    // 范围外 clamp
    const r5 = applyDragToRange('bottom', 0.5, 1.5, range)
    expect(r5.vStart).toBeLessThanOrEqual(1 - r5.vHeight)
    void r1
    void r2
  })

  it('与 uvRemap 的 u/v 定义一致（合成圆柱 remap 后表面点映射回原 u）', () => {
    const mesh = synthCylinder()
    const params = makeDefaultRemap(mesh)
    // 轴 ≈ Y，axisMin/axisMax ≈ [-10, 10]
    const { axisMin, axisMax } = (() => {
      const fit = params
      let mn = Infinity
      let mx = -Infinity
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        const along = mesh.positions[i * 3 + 1]
        if (along < mn) mn = along
        if (along > mx) mx = along
      }
      return { axisMin: mn, axisMax: mx }
    })()
    // 取一个 remap 后的顶点，其 UV 应等于 surfaceToUV(该顶点 3D 位置)
    const out = computeRemap(mesh, params)
    const i = Math.floor(mesh.positions.length / 3 / 2) // 中间某顶点
    const p: [number, number, number] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]
    // 找到该顶点在 remap 输出中的 UV（可能被接缝拆分/退化处理，用 surfaceToUV 作为期望）
    const uv = surfaceToUV(p, params, axisMin, axisMax)
    // 验证 remap 输出的区域内顶点与该映射一致（允许区域外/退化顶点差异）
    let found = false
    for (let k = 0; k < out.vertexCount; k++) {
      const u = out.uv[k * 2]
      const v = out.uv[k * 2 + 1]
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && Math.abs(v - uv.v) < 1e-3) {
        let du = Math.abs(u - uv.u)
        if (du > 0.5) du = 1 - du
        if (du < 1e-2) {
          found = true
          break
        }
      }
    }
    expect(found).toBe(true)
  })
})
