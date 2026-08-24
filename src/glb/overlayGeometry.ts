/**
 * 为透明贴标叠加壳创建稳定的几何间隙。
 *
 * polygonOffset 在高精度 CAD 网格、不同 WebGL 深度格式和导出的查看器中并不
 * 一致。这里按模型自身尺度沿顶点法线偏移万分之一，既避免 z-fighting，也不会
 * 形成肉眼可见的悬浮标签。导出与实时预览共用此函数，防止两条链路漂移。
 */
export function offsetOverlayPositions(positions: Float32Array, normals?: Float32Array): Float32Array {
  const output = new Float32Array(positions)
  if (!normals || normals.length !== positions.length || positions.length < 3) return output

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3)
  const bias = extent * 1e-4
  for (let i = 0; i < positions.length; i += 3) {
    const nx = normals[i]
    const ny = normals[i + 1]
    const nz = normals[i + 2]
    const length = Math.hypot(nx, ny, nz) || 1
    output[i] += (nx / length) * bias
    output[i + 1] += (ny / length) * bias
    output[i + 2] += (nz / length) * bias
  }
  return output
}
