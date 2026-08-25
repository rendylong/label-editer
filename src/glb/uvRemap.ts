/**
 * UV 重映射核心（纯函数，无 three 依赖）。
 *
 * 唯一数据源原则：本模块以「原始 accessor 数据 + 序列化 RemapParams」为输入，
 * 预览（three 侧）与导出（gltf-transform 侧）都从同一份输出派生，杜绝双源漂移。
 *
 * 要点：
 *  - 圆柱投影：u = (-angle/2π + 0.5)·wrap + offset，v = 沿轴归一化；
 *    U 正方向与模型正面的自然阅读方向一致，避免文字/图像水平镜像；
 *  - 接缝顶点拆分：跨缝三角形按「相对首顶点展开 ±1」生成新顶点（u 可越出 [0,1)，
 *    依赖 REPEAT 采样实现无缝环绕）—— 实测闭合标签带必有跨缝边，旋转接缝无法消除；
 *  - 正面原点：正面 = 画布 u=0.5，由同一圆柱逆变换计算（供 3D 标记对齐）。
 */

import type { RemapParams } from '../label/types'

export interface MeshAccessors {
  /** xyz 每 3 个一组 */
  positions: Float32Array
  normals?: Float32Array
  /** uv 每 2 个一组 */
  uv: Float32Array
  /** 索引（可为 null = 非索引，此时视作 0..n-1 顺次） */
  indices: Uint16Array | Uint32Array | null
  triangleCount: number
}

export interface RemapOutput {
  positions: Float32Array
  normals?: Float32Array
  /** 展开后 uv（可能越出 [0,1)，依赖 REPEAT） */
  uv: Float32Array
  indices: Uint32Array
  /** 新顶点数 */
  vertexCount: number
  /** 跨缝三角形数（拆分前） */
  seamCrossingTriangles: number
  /** 正面角（弧度，basis 参考方向起）：画布 u=0.5 对应的 3D 方向角 */
  frontAngle: number
  /** 拆分后最大三角形 u 跨度 */
  maxSpan: number
}

export interface CylinderFit {
  axis: [number, number, number]
  origin: [number, number, number]
  radius: number
  /** 质量 = |r−r̄|<0.5·r̄ 的顶点占比 */
  quality: number
  height: number
}

/**
 * 圆柱表面角度与画布 U 的唯一转换约定。
 * U 从左向右增大：从圆柱正面观察时，画布右侧也落在模型右侧，避免纹理水平镜像。
 */
export function cylindricalAngleToU(angle: number, wrap = 1, offset = 0): number {
  const u = (-angle / (2 * Math.PI) + 0.5) * wrap + offset
  return u - Math.floor(u)
}

/** cylindricalAngleToU 的逆变换（控制框/2D 展开图使用）。 */
export function cylindricalUToAngle(u: number, wrap = 1, offset = 0): number {
  return 2 * Math.PI * (0.5 - (u - offset) / Math.max(wrap, 1e-6))
}

/** 抵消节点层级中的负手性变换；保持结果在 [0,1)。 */
export function applyUHandedness(u: number, mirrorU = false): number {
  if (!mirrorU) return u
  const mirrored = 1 - u
  return mirrored - Math.floor(mirrored)
}

/** 3×3 对称矩阵 Jacobi 特征分解（返回特征向量列、特征值）。 */
export function eigenSymmetric(m: number[][]): { vectors: number[][]; values: number[] } {
  let a = m.map((r) => [...r])
  const n = 3
  let v = Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0)
    row[i] = 1
    return row
  })
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q]
    if (off < 1e-18) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-16) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]]
  return { vectors: v, values }
}

function norm3(x: number[]): number {
  return Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2])
}

/**
 * DCC tessellation density can nudge an otherwise axis-aligned bottle by a few degrees.
 * Snap only manufacturing-level drift (<= 5 degrees); deliberate model tilt stays intact.
 */
export function stabilizeLabelAxis(axis: [number, number, number]): [number, number, number] {
  const cardinalIndex = [0, 1, 2].reduce((best, index) => Math.abs(axis[index]) > Math.abs(axis[best]) ? index : best, 0)
  if (Math.abs(axis[cardinalIndex]) < Math.cos(5 * Math.PI / 180)) return [...axis]
  const stable: [number, number, number] = [0, 0, 0]
  stable[cardinalIndex] = axis[cardinalIndex] < 0 ? -1 : 1
  return stable
}

/** 拟合圆柱：PCA 主轴为轴，均值点为原点。 */
export function fitCylinder(positions: Float32Array): CylinderFit {
  const n = positions.length / 3
  const cx = 0
  const cy = 0
  const cz = 0
  let mx = 0
  let my = 0
  let mz = 0
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    mx += x
    my += y
    mz += z
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }
  mx /= n
  my /= n
  mz /= n
  // 协方差
  const c = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3] - mx
    const y = positions[i * 3 + 1] - my
    const z = positions[i * 3 + 2] - mz
    c[0][0] += x * x
    c[0][1] += x * y
    c[0][2] += x * z
    c[1][1] += y * y
    c[1][2] += y * z
    c[2][2] += z * z
  }
  c[1][0] = c[0][1]
  c[2][0] = c[0][2]
  c[2][1] = c[1][2]
  const { vectors, values } = eigenSymmetric(c)
  // 圆柱轴候选：三个 PCA 方向全部评估。CAD 网格常在端面拥有远多于侧面的
  // 顶点，仅按“半径一致性”会把高矩形瓶的横轴误当成圆柱轴；因此评分同时考虑
  // 圆柱度与有限的长宽比先验。长宽比只作轻量加分并封顶，避免破坏矮胖圆罐。
  const candIdx = [0, 1, 2].sort((a, b) => values[b] - values[a])
  const candidates: { axis: number[]; origin: number[]; radius: number; quality: number; height: number; score: number }[] = []
  for (const li of candIdx) {
    const axis = [vectors[0][li], vectors[1][li], vectors[2][li]]
    const al = norm3(axis)
    axis[0] /= al
    axis[1] /= al
    axis[2] /= al
    const { radius, quality, height, rs } = fitAlongAxis(positions, mx, my, mz, axis)
    const aspect = height / Math.max(radius, 1e-6)
    const score = quality + 0.04 * Math.min(aspect, 4)
    candidates.push({ axis, origin: [mx, my, mz], radius, quality, height, score })
    void rs
  }
  let best = candidates[0]
  for (let i = 1; i < candidates.length; i++) if (candidates[i].score > best.score) best = candidates[i]
  // CAD 瓶身经常轴对齐，但不同面片的细分密度相差数十倍。此时顶点均值会偏心，
  // PCA 轴也会略微倾斜；局部贴标在长距离上因此产生明显横向漂移。若 AABB 有唯一
  // 的长轴，且某个 PCA 主方向与它相差不超过 15°，用包围盒长轴/中心稳定结果。
  // 旋转模型的 AABB 通常没有如此明确的唯一长轴，或 PCA 不满足对齐阈值，仍保留
  // 原始 PCA 方向。
  const extents = [maxX - minX, maxY - minY, maxZ - minZ]
  const bboxOrder = [0, 1, 2].sort((a, b) => extents[b] - extents[a])
  const bboxAxisIndex = bboxOrder[0]
  const extentRatio = extents[bboxAxisIndex] / Math.max(extents[bboxOrder[1]], 1e-6)
  const aligned = candidates.reduce((current, candidate) => (Math.abs(candidate.axis[bboxAxisIndex]) > Math.abs(current.axis[bboxAxisIndex]) ? candidate : current), candidates[0])
  if (extentRatio >= 1.5 && Math.abs(aligned.axis[bboxAxisIndex]) >= Math.cos(Math.PI / 12)) {
    const axis = [0, 0, 0]
    axis[bboxAxisIndex] = aligned.axis[bboxAxisIndex] < 0 ? -1 : 1
    const origin = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
    const snapped = fitAlongAxis(positions, origin[0], origin[1], origin[2], axis)
    return {
      axis: axis as [number, number, number],
      origin: origin as [number, number, number],
      radius: snapped.radius,
      quality: snapped.quality,
      height: snapped.height,
    }
  }
  return { axis: best.axis as [number, number, number], origin: best.origin as [number, number, number], radius: best.radius, quality: best.quality, height: best.height }
}

function fitAlongAxis(
  positions: Float32Array,
  mx: number,
  my: number,
  mz: number,
  axis: number[],
): { radius: number; quality: number; height: number; rs: Float32Array } {
  const n = positions.length / 3
  let sumR = 0
  const rs = new Float32Array(n)
  let aMin = Infinity
  let aMax = -Infinity
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - mx
    const dy = positions[i * 3 + 1] - my
    const dz = positions[i * 3 + 2] - mz
    const along = dx * axis[0] + dy * axis[1] + dz * axis[2]
    const px = dx - along * axis[0]
    const py = dy - along * axis[1]
    const pz = dz - along * axis[2]
    const r = Math.sqrt(px * px + py * py + pz * pz)
    rs[i] = r
    sumR += r
    if (along < aMin) aMin = along
    if (along > aMax) aMax = along
  }
  const radius = sumR / n
  let good = 0
  for (let i = 0; i < n; i++) if (Math.abs(rs[i] - radius) < 0.5 * radius) good++
  return { radius, quality: good / n, height: Math.max(aMax - aMin, 1e-6), rs }
}

/** 根据圆柱度自动选择模式：质量 < 0.5 → 平面投影。 */
export function detectLabelMode(mesh: MeshAccessors): 'cylindrical' | 'planar' {
  const fit = fitCylinder(mesh.positions)
  return isNearlyPlanar(mesh.positions) || fit.quality < 0.5 ? 'planar' : 'cylindrical'
}

/** A sparse rectangular label plane can have perfectly constant radius around its long axis. */
function isNearlyPlanar(positions: Float32Array): boolean {
  const count = positions.length / 3
  if (count < 3) return false
  const mean = [0, 0, 0]
  for (let index = 0; index < count; index++) {
    mean[0] += positions[index * 3]
    mean[1] += positions[index * 3 + 1]
    mean[2] += positions[index * 3 + 2]
  }
  mean[0] /= count
  mean[1] /= count
  mean[2] /= count
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let index = 0; index < count; index++) {
    const delta = [
      positions[index * 3] - mean[0],
      positions[index * 3 + 1] - mean[1],
      positions[index * 3 + 2] - mean[2],
    ]
    for (let row = 0; row < 3; row++) for (let column = row; column < 3; column++) covariance[row][column] += delta[row] * delta[column]
  }
  covariance[1][0] = covariance[0][1]
  covariance[2][0] = covariance[0][2]
  covariance[2][1] = covariance[1][2]
  const values = eigenSymmetric(covariance).values.map(Math.abs).sort((a, b) => a - b)
  return values[2] > 1e-12 && values[1] > values[2] * 1e-8 && values[0] <= values[2] * 1e-6
}

/** 由几何推导画布规格：width 固定 2048，height 按宽高比（含区域尺寸）。 */
export function deriveCanvasSpec(radius: number, height: number, wrap: number, uWidth = 1, vHeight = 1): { width: number; height: number; aspect: number } {
  const circ = 2 * Math.PI * radius * wrap * Math.max(uWidth, 0.05)
  const h = Math.max(height * Math.max(vHeight, 0.05), 1e-3)
  return canvasSpecForAspect(circ / h)
}

function canvasSpecForAspect(rawAspect: number): { width: number; height: number; aspect: number } {
  const aspect = Number.isFinite(rawAspect) && rawAspect > 1e-6 ? rawAspect : 1
  const width = 2048
  const heightPx = Math.max(64, Math.round(width / aspect))
  return { width, height: heightPx, aspect }
}

/**
 * 根据已重映射表面在画布中心附近的 UV→几何雅可比推导画布比例。
 *
 * 圆瓶上该比例等价于 2πr:h；方瓶/圆角瓶的角度 UV 并非等弧长参数化，继续使用
 * 平均半径会让正面文字横向拉伸。这里直接测量一个归一化 U、V 分别对应的实际
 * 表面切向长度，因此无需先把瓶型硬分类为“圆形”或“方形”。
 */
export function deriveSurfaceCanvasSpec(output: RemapOutput, fallbackAspect: number): { width: number; height: number; aspect: number } {
  const samples: { distance: number; aspect: number }[] = []
  const { indices, positions, uv } = output
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const i0 = indices[triangle]
    const i1 = indices[triangle + 1]
    const i2 = indices[triangle + 2]
    const u0 = uv[i0 * 2]
    const v0 = uv[i0 * 2 + 1]
    const u1 = uv[i1 * 2]
    const v1 = uv[i1 * 2 + 1]
    const u2 = uv[i2 * 2]
    const v2 = uv[i2 * 2 + 1]
    const du1 = u1 - u0
    const dv1 = v1 - v0
    const du2 = u2 - u0
    const dv2 = v2 - v0
    const determinant = du1 * dv2 - du2 * dv1
    if (Math.abs(determinant) < 1e-9) continue

    const tangentU = [0, 0, 0]
    const tangentV = [0, 0, 0]
    for (let dimension = 0; dimension < 3; dimension++) {
      const edge1 = positions[i1 * 3 + dimension] - positions[i0 * 3 + dimension]
      const edge2 = positions[i2 * 3 + dimension] - positions[i0 * 3 + dimension]
      tangentU[dimension] = (edge1 * dv2 - edge2 * dv1) / determinant
      tangentV[dimension] = (-edge1 * du2 + edge2 * du1) / determinant
    }
    const lengthU = Math.hypot(tangentU[0], tangentU[1], tangentU[2])
    const lengthV = Math.hypot(tangentV[0], tangentV[1], tangentV[2])
    const aspect = lengthU / Math.max(lengthV, 1e-12)
    if (!Number.isFinite(aspect) || aspect < 1e-3 || aspect > 1e3) continue

    const centerU = (u0 + u1 + u2) / 3
    const centerV = (v0 + v1 + v2) / 3
    samples.push({
      distance: Math.hypot(centerU - 0.5, centerV - 0.5),
      aspect,
    })
  }
  if (samples.length === 0) return canvasSpecForAspect(fallbackAspect)

  samples.sort((a, b) => a.distance - b.distance)
  const neighborhoodLimit = samples[0].distance + 0.05
  const localAspects = samples
    .filter((sample) => sample.distance <= neighborhoodLimit)
    .slice(0, 24)
    .map((sample) => sample.aspect)
    .sort((a, b) => a - b)
  const middle = Math.floor(localAspects.length / 2)
  const aspect = localAspects.length % 2 === 0
    ? (localAspects[middle - 1] + localAspects[middle]) / 2
    : localAspects[middle]
  return canvasSpecForAspect(aspect)
}

/** 供 3D 视口放置"正面"标记等使用。 */
export function basisForAxis(axis: [number, number, number]): { u0: [number, number, number]; u1: [number, number, number] } {
  const { u0, u1 } = buildBasis(axis)
  return { u0: [u0[0], u0[1], u0[2]], u1: [u1[0], u1[1], u1[2]] }
}

function buildBasis(axis: [number, number, number]): { u0: number[]; u1: number[] } {
  const a = axis
  const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u0 = [
    a[1] * ref[2] - a[2] * ref[1],
    a[2] * ref[0] - a[0] * ref[2],
    a[0] * ref[1] - a[1] * ref[0],
  ]
  const l = norm3(u0)
  u0[0] /= l
  u0[1] /= l
  u0[2] /= l
  const u1 = [a[1] * u0[2] - a[2] * u0[1], a[2] * u0[0] - a[0] * u0[2], a[0] * u0[1] - a[1] * u0[0]]
  return { u0, u1 }
}

/**
 * 执行重映射 + 接缝顶点拆分。
 * @param mesh 原始 accessor 数据
 * @param params 序列化参数
 * @param range 贴标区域范围（默认整圈整高）；区域外顶点映射到画布外，
 *              配合 ClampToEdge 采样显示为画布边缘（背景色）
 */
export function computeRemap(
  mesh: MeshAccessors,
  params: RemapParams,
  range?: { uStart: number; uWidth: number; vStart: number; vHeight: number },
  options?: { exteriorOnly?: boolean },
): RemapOutput {
  const { positions, normals, uv: origUv } = mesh
  const n = positions.length / 3
  const { axis, origin, wrap, offset, mode, planarBox } = params
  const uStart = range?.uStart ?? 0
  const uWidth = Math.max(range?.uWidth ?? 1, 0.05)
  const vStart = range?.vStart ?? 0
  const vHeight = Math.max(range?.vHeight ?? 1, 0.05)

  const uArr = new Float32Array(n)
  const vArr = new Float32Array(n)
  const { u0, u1 } = buildBasis(axis as [number, number, number])

  if (mode === 'cylindrical') {
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3] - origin[0]
      const dy = positions[i * 3 + 1] - origin[1]
      const dz = positions[i * 3 + 2] - origin[2]
      const along = dx * axis[0] + dy * axis[1] + dz * axis[2]
      const px = dx - along * axis[0]
      const py = dy - along * axis[1]
      const pz = dz - along * axis[2]
      const angle = Math.atan2(pz * u0[2] + py * u0[1] + px * u0[0], pz * u1[2] + py * u1[1] + px * u1[0])
      // angle ∈ [-π, π]；u ∈ [0,1)
      uArr[i] = applyUHandedness(cylindricalAngleToU(angle, wrap, offset), params.mirrorU)
      const [aMin, aMax] = axisSpan(positions, axis, origin)
      vArr[i] = (along - aMin) / Math.max(aMax - aMin, 1e-6)
    }
  } else {
    const horizontalMin = planarBox.min[0]
    const verticalMin = planarBox.min[1]
    const horizontalSpan = Math.max(planarBox.max[0] - horizontalMin, 1e-6)
    const verticalSpan = Math.max(planarBox.max[1] - verticalMin, 1e-6)
    // 平面投影：U 沿标签横向，V 沿标签长轴。planarBox 存的是这两个投影坐标的范围。
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3] - origin[0]
      const dy = positions[i * 3 + 1] - origin[1]
      const dz = positions[i * 3 + 2] - origin[2]
      const along = dx * axis[0] + dy * axis[1] + dz * axis[2]
      const horizontal = dx * u0[0] + dy * u0[1] + dz * u0[2]
      const u = Math.min(1, Math.max(0, (horizontal - horizontalMin) / horizontalSpan))
      uArr[i] = params.mirrorU ? 1 - u : u
      vArr[i] = Math.min(1, Math.max(0, (along - verticalMin) / verticalSpan))
    }
  }

  // 退化顶点识别（圆柱模式）：r < 0.2·radius 的顶点位于底部扇区（不可见），
  // 含退化顶点的三角形整体塌缩到单一 u 列，避免扇区三角形跨越整幅画布产生拉伸。
  const degSet = new Set<number>()
  if (mode === 'cylindrical') {
    const thr = params.radius * 0.2
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3] - origin[0]
      const dy = positions[i * 3 + 1] - origin[1]
      const dz = positions[i * 3 + 2] - origin[2]
      const along = dx * axis[0] + dy * axis[1] + dz * axis[2]
      const px = dx - along * axis[0]
      const py = dy - along * axis[1]
      const pz = dz - along * axis[2]
      if (Math.sqrt(px * px + py * py + pz * pz) < thr) degSet.add(i)
    }
  }

  // —— 接缝顶点拆分 ——
  const indices = mesh.indices ?? new Uint32Array(n).map((_, i) => i)
  const triCount = indices.length / 3
  const exteriorEnvelope = new Map<number, number>()
  const envelopeAngularBins = 72
  const envelopeAxialBins = 64
  const exteriorMetrics = (i0: number, i1: number, i2: number): { key: number; radius: number; outward: boolean } => {
    const cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3 - origin[0]
    const cy = (positions[i0 * 3 + 1] + positions[i1 * 3 + 1] + positions[i2 * 3 + 1]) / 3 - origin[1]
    const cz = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3 - origin[2]
    const along = cx * axis[0] + cy * axis[1] + cz * axis[2]
    const rx = cx - along * axis[0]
    const ry = cy - along * axis[1]
    const rz = cz - along * axis[2]
    const radial = Math.sqrt(rx * rx + ry * ry + rz * rz)
    const nx = (normals?.[i0 * 3] ?? 0) + (normals?.[i1 * 3] ?? 0) + (normals?.[i2 * 3] ?? 0)
    const ny = (normals?.[i0 * 3 + 1] ?? 0) + (normals?.[i1 * 3 + 1] ?? 0) + (normals?.[i2 * 3 + 1] ?? 0)
    const nz = (normals?.[i0 * 3 + 2] ?? 0) + (normals?.[i1 * 3 + 2] ?? 0) + (normals?.[i2 * 3 + 2] ?? 0)
    const angle = Math.atan2(rx * u0[0] + ry * u0[1] + rz * u0[2], rx * u1[0] + ry * u1[1] + rz * u1[2])
    const u = applyUHandedness(cylindricalAngleToU(angle, wrap, offset), params.mirrorU)
    const v = (vArr[i0] + vArr[i1] + vArr[i2]) / 3
    const uBin = Math.min(envelopeAngularBins - 1, Math.max(0, Math.floor(u * envelopeAngularBins)))
    const vBin = Math.min(envelopeAxialBins - 1, Math.max(0, Math.floor(v * envelopeAxialBins)))
    return { key: vBin * envelopeAngularBins + uBin, radius: radial, outward: nx * rx + ny * ry + nz * rz >= 0 }
  }

  // 透明瓶常在同一 mesh 内同时包含外瓶壁、内瓶壁与导管等多个同心结构。
  // 仅凭法线朝向无法排除导管（它的法线同样朝外），所以为每个角度/高度格建立
  // 最外层径向包络，overlay 只保留贴近包络的三角面。
  if (options?.exteriorOnly && mode === 'cylindrical' && normals) {
    for (let t = 0; t < triCount; t++) {
      const metrics = exteriorMetrics(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2])
      if (!metrics.outward) continue
      exteriorEnvelope.set(metrics.key, Math.max(exteriorEnvelope.get(metrics.key) ?? 0, metrics.radius))
    }
  }
  const newPos: number[] = []
  const newNrm: number[] = normals ? [] : []
  const newUv: number[] = []
  const newIdx: number[] = []
  // 顶点表：key `${vi}:${uu}` → 新顶点下标
  const table = new Map<string, number>()
  let seamCrossing = 0
  let maxSpan = 0

  const addVertex = (vi: number, uu: number, vv: number): number => {
    // 定点 key：uu 取 6 位小数
    const key = `${vi}:${uu.toFixed(6)}`
    let ni = table.get(key)
    if (ni === undefined) {
      ni = newPos.length / 3
      table.set(key, ni)
      newPos.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2])
      if (normals) {
        let nx = normals[vi * 3]
        let ny = normals[vi * 3 + 1]
        let nz = normals[vi * 3 + 2]
        if (mode === 'cylindrical') {
          const dx = positions[vi * 3] - origin[0]
          const dy = positions[vi * 3 + 1] - origin[1]
          const dz = positions[vi * 3 + 2] - origin[2]
          const along = dx * axis[0] + dy * axis[1] + dz * axis[2]
          const rx = dx - along * axis[0]
          const ry = dy - along * axis[1]
          const rz = dz - along * axis[2]
          // 高精度玻璃瓶常把内外壳合并在同一 mesh，且局部法线方向不一致。
          // overlay 依赖法线产生纸张壳间隙；内向法线会把贴标推回瓶内并形成条带缺口。
          if (nx * rx + ny * ry + nz * rz < 0) {
            nx = -nx
            ny = -ny
            nz = -nz
          }
        }
        newNrm.push(nx, ny, nz)
      }
      newUv.push(uu, vv)
    }
    return ni
  }

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3]
    const i1 = indices[t * 3 + 1]
    const i2 = indices[t * 3 + 2]
    if (options?.exteriorOnly && mode === 'cylindrical' && normals) {
      const metrics = exteriorMetrics(i0, i1, i2)
      const envelope = exteriorEnvelope.get(metrics.key) ?? metrics.radius
      // 保留 6% 容差覆盖圆角瓶和离散网格，但排除明显位于瓶身内部的壳层/导管。
      if (!metrics.outward || metrics.radius < envelope * 0.94) continue
    }
    let u0v = uArr[i0]
    let u1v = uArr[i1]
    let u2v = uArr[i2]
    // 含退化顶点的三角形：全部 u 塌缩到首个非退化顶点的 u（底部扇区不可见，消除涂抹）
    if (degSet.has(i0) || degSet.has(i1) || degSet.has(i2)) {
      const ref = degSet.has(i0) ? (degSet.has(i1) ? (degSet.has(i2) ? 0.5 : u2v) : u1v) : u0v
      u0v = ref
      u1v = ref
      u2v = ref
    }
    // 圆柱接缝必须在“区域归一化之前”展开。若先除以局部区域宽度，部分贴标的
    // UV 跨度会被放大，再按整数折返就会把整张图压成窄条。
    if (mode === 'cylindrical') {
      u1v += Math.round(u0v - u1v)
      u2v += Math.round(u0v - u2v)
      // 为跨 0/1 接缝的三角形选取最靠近本次贴标区域中心的周期分支。
      const center = uStart + uWidth / 2
      const average = (u0v + u1v + u2v) / 3
      const branch = Math.round(center - average)
      u0v += branch
      u1v += branch
      u2v += branch
    }
    if (options?.exteriorOnly) {
      const centroidU = (u0v + u1v + u2v) / 3
      const centroidV = (vArr[i0] + vArr[i1] + vArr[i2]) / 3
      // overlay 是独立几何，必须在几何层限制到用户框选区域。过去把区域外 UV
      // 留给 ClampToEdge；一旦纸张底色不透明，边缘像素就会沿瓶身其余部分无限延伸。
      if (centroidU < uStart || centroidU > uStart + uWidth || centroidV < vStart || centroidV > vStart + vHeight) continue
    }
    const span = Math.max(u0v, u1v, u2v) - Math.min(u0v, u1v, u2v)
    if (span > maxSpan) maxSpan = span
    if (span > 0.5) seamCrossing++
    // 保持区域外 UV 的连续仿射值，并由 ClampToEdge + 透明画布边缘完成隐藏。
    // 固定改写为 -0.5/1.5 会破坏稀疏 CAD 大面的顶点插值，造成贴图条带化。
    // glTF 图像坐标原点位于左上：画布 y=0 应对应瓶身轴向顶部。
    // range.vStart 仍按“距底部”表达，因此先做区域归一化，再反转为纹理 V。
    const a = addVertex(i0, (u0v - uStart) / uWidth, 1 - (vArr[i0] - vStart) / vHeight)
    const b = addVertex(i1, (u1v - uStart) / uWidth, 1 - (vArr[i1] - vStart) / vHeight)
    const c = addVertex(i2, (u2v - uStart) / uWidth, 1 - (vArr[i2] - vStart) / vHeight)
    newIdx.push(a, b, c)
  }

  return {
    positions: new Float32Array(newPos),
    normals: normals ? new Float32Array(newNrm) : undefined,
    uv: new Float32Array(newUv),
    indices: new Uint32Array(newIdx),
    vertexCount: newPos.length / 3,
    seamCrossingTriangles: seamCrossing,
    // 正面（画布 u=0.5）：angle = atan2(p·u0, p·u1) = π/2 - θ（dir=cosθ·u0+sinθ·u1）。
    // 直接复用 U→angle 的逆变换，避免 wrap≠1 时辅助标记偏离实际纹理中心。
    frontAngle: mode === 'cylindrical' ? Math.PI / 2 - cylindricalUToAngle(0.5, wrap, offset) : 0,
    maxSpan,
  }
}

export function axisSpan(positions: Float32Array, axis: number[], origin: number[]): [number, number] {
  let aMin = Infinity
  let aMax = -Infinity
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    const along = (positions[i * 3] - origin[0]) * axis[0] + (positions[i * 3 + 1] - origin[1]) * axis[1] + (positions[i * 3 + 2] - origin[2]) * axis[2]
    if (along < aMin) aMin = along
    if (along > aMax) aMax = along
  }
  return [aMin, aMax]
}

/** Choose an offset whose canvas center faces the default +Z camera side. */
export function defaultFrontOffset(axis: [number, number, number], preferredFront: [number, number, number] = [0, 0, 1]): number {
  const { u0, u1 } = buildBasis(axis)
  const projection = preferredFront[0] * axis[0] + preferredFront[1] * axis[1] + preferredFront[2] * axis[2]
  let direction = [
    preferredFront[0] - axis[0] * projection,
    preferredFront[1] - axis[1] * projection,
    preferredFront[2] - axis[2] * projection,
  ]
  if (norm3(direction) < 1e-6) {
    direction = [
      1 - axis[0] * axis[0],
      -axis[1] * axis[0],
      -axis[2] * axis[0],
    ]
  }
  const length = Math.max(norm3(direction), 1e-6)
  direction = direction.map((value) => value / length)
  const theta = Math.atan2(
    direction[0] * u1[0] + direction[1] * u1[1] + direction[2] * u1[2],
    direction[0] * u0[0] + direction[1] * u0[1] + direction[2] * u0[2],
  )
  const offset = (Math.PI / 2 - theta) / (2 * Math.PI)
  return offset - Math.floor(offset)
}

/** 由 mesh + 拟合结果生成完整 RemapParams（默认把画布中心对准模型 +Z 正面）。 */
export function makeDefaultRemap(
  mesh: MeshAccessors,
  mirrorU = false,
  preferredFront: [number, number, number] = [0, 0, 1],
): RemapParams {
  const fit = fitCylinder(mesh.positions)
  const mode = isNearlyPlanar(mesh.positions) || fit.quality < 0.5 ? 'planar' : 'cylindrical'
  let axis = stabilizeLabelAxis(fit.axis)
  if (mode === 'planar') {
    const dominant = [0, 1, 2].reduce((best, index) => Math.abs(axis[index]) > Math.abs(axis[best]) ? index : best, 0)
    if (axis[dominant] < 0) axis = axis.map((value) => -value) as [number, number, number]
  }
  const [verticalMin, verticalMax] = axisSpan(mesh.positions, axis, fit.origin)
  const { u0 } = buildBasis(axis)
  let horizontalMin = Infinity
  let horizontalMax = -Infinity
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const horizontal = (mesh.positions[index] - fit.origin[0]) * u0[0]
      + (mesh.positions[index + 1] - fit.origin[1]) * u0[1]
      + (mesh.positions[index + 2] - fit.origin[2]) * u0[2]
    horizontalMin = Math.min(horizontalMin, horizontal)
    horizontalMax = Math.max(horizontalMax, horizontal)
  }
  let resolvedMirrorU = mirrorU
  if (mode === 'planar') {
    const right = [
      axis[1] * preferredFront[2] - axis[2] * preferredFront[1],
      axis[2] * preferredFront[0] - axis[0] * preferredFront[2],
      axis[0] * preferredFront[1] - axis[1] * preferredFront[0],
    ]
    if (norm3(right) > 1e-6 && u0[0] * right[0] + u0[1] * right[1] + u0[2] * right[2] < 0) resolvedMirrorU = !resolvedMirrorU
  }
  return {
    mode,
    axis,
    origin: fit.origin,
    radius: fit.radius,
    wrap: 1,
    offset: mode === 'cylindrical' ? defaultFrontOffset(axis, preferredFront) : 0,
    mirrorU: resolvedMirrorU,
    planarBox: {
      min: [horizontalMin, verticalMin, 0],
      max: [horizontalMax, verticalMax, 0],
    },
  }
}
