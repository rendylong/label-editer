import * as THREE from 'three'

export interface QcTargetFrame {
  center: THREE.Vector3
  size: THREE.Vector3
  normal?: THREE.Vector3
}

const NORMAL_EPSILON = 1e-8

function invalidUsage(message: string): never {
  throw new Error(`INVALID_USAGE: ${message}`)
}

function triangleNormal(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  matrixWorld: THREE.Matrix4,
  first: number,
  second: number,
  third: number,
): THREE.Vector3 {
  const a = new THREE.Vector3().fromBufferAttribute(position, first).applyMatrix4(matrixWorld)
  const b = new THREE.Vector3().fromBufferAttribute(position, second).applyMatrix4(matrixWorld)
  const c = new THREE.Vector3().fromBufferAttribute(position, third).applyMatrix4(matrixWorld)
  return b.sub(a).cross(c.sub(a)).normalize()
}

function averageFaceNormals(
  geometry: THREE.BufferGeometry,
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  matrixWorld: THREE.Matrix4,
): THREE.Vector3 {
  const normal = new THREE.Vector3()
  const index = geometry.getIndex()
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3)
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3
    const face = index
      ? triangleNormal(position, matrixWorld, index.getX(offset), index.getX(offset + 1), index.getX(offset + 2))
      : triangleNormal(position, matrixWorld, offset, offset + 1, offset + 2)
    if (face.lengthSq() > NORMAL_EPSILON) normal.add(face)
  }
  // World-space triangle winding reverses under reflection, while the normal
  // matrix used by renderer-facing vertex normals does not.
  if (matrixWorld.determinant() < 0) normal.multiplyScalar(-1)
  return normal
}

export function surfaceFrameForGeometry(
  geometry: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
): Required<QcTargetFrame> {
  const position = geometry.getAttribute('position')
  if (!position || position.count === 0) invalidUsage('geometry must include positions')

  const bounds = new THREE.Box3().makeEmpty()
  const point = new THREE.Vector3()
  for (let index = 0; index < position.count; index += 1) {
    bounds.expandByPoint(point.fromBufferAttribute(position, index).applyMatrix4(matrixWorld))
  }
  if (bounds.isEmpty() || !Number.isFinite(bounds.min.x) || !Number.isFinite(bounds.max.x)
    || !Number.isFinite(bounds.min.y) || !Number.isFinite(bounds.max.y)
    || !Number.isFinite(bounds.min.z) || !Number.isFinite(bounds.max.z)) {
    invalidUsage('geometry bounds are empty or non-finite')
  }

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrixWorld)
  const normal = new THREE.Vector3()
  const vertexNormals = geometry.getAttribute('normal')
  if (vertexNormals) {
    for (let index = 0; index < vertexNormals.count; index += 1) {
      normal.add(point.fromBufferAttribute(vertexNormals, index).applyMatrix3(normalMatrix).normalize())
    }
  }
  if (normal.lengthSq() <= NORMAL_EPSILON) normal.copy(averageFaceNormals(geometry, position, matrixWorld))
  if (normal.lengthSq() <= NORMAL_EPSILON || !Number.isFinite(normal.lengthSq())) {
    invalidUsage('geometry has no stable surface normal')
  }

  normal.normalize()
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(normal[axis]) < NORMAL_EPSILON) normal[axis] = 0
  }
  return {
    center: bounds.getCenter(new THREE.Vector3()),
    size: bounds.getSize(new THREE.Vector3()),
    normal,
  }
}

export function cameraForFrame(
  frame: QcTargetFrame,
  direction: THREE.Vector3,
  options: { fov: number; aspect: number; margin: number },
): {
  position: THREE.Vector3
  target: THREE.Vector3
  direction: THREE.Vector3
  up: THREE.Vector3
} {
  if (![direction.x, direction.y, direction.z].every(Number.isFinite)
    || direction.lengthSq() <= NORMAL_EPSILON) {
    invalidUsage('camera direction must be finite and non-zero')
  }
  if (!Number.isFinite(options.fov) || options.fov <= 0 || options.fov >= 180
    || !Number.isFinite(options.aspect) || options.aspect <= 0
    || !Number.isFinite(options.margin) || options.margin <= 0) {
    invalidUsage('camera options must be finite and positive')
  }
  const sizeComponents = [frame.size.x, frame.size.y, frame.size.z]
  if (![frame.center.x, frame.center.y, frame.center.z, ...sizeComponents]
    .every(Number.isFinite) || Math.min(...sizeComponents) < 0) {
    invalidUsage('camera frame must be finite with non-negative size')
  }

  const normalizedDirection = direction.clone().normalize()
  const worldY = new THREE.Vector3(0, 1, 0)
  const upReference = Math.abs(normalizedDirection.dot(worldY)) >= 0.98
    ? new THREE.Vector3(0, 0, 1)
    : worldY
  const up = upReference.addScaledVector(normalizedDirection, -upReference.dot(normalizedDirection)).normalize()
  const right = normalizedDirection.clone().cross(up).normalize()
  const halfSize = frame.size.clone().multiplyScalar(0.5)
  const verticalHalfFov = THREE.MathUtils.degToRad(options.fov) / 2
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * options.aspect)
  const verticalSlope = Math.tan(verticalHalfFov)
  const horizontalSlope = Math.tan(horizontalHalfFov)
  let fitDistance = 0
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        const offset = new THREE.Vector3(x * halfSize.x, y * halfSize.y, z * halfSize.z)
        const depthOffset = offset.dot(normalizedDirection)
        fitDistance = Math.max(
          fitDistance,
          depthOffset + Math.abs(offset.dot(up)) / verticalSlope,
          depthOffset + Math.abs(offset.dot(right)) / horizontalSlope,
        )
      }
    }
  }
  const distance = Math.max(fitDistance, ...sizeComponents) * options.margin
  const target = frame.center.clone()

  return {
    position: target.clone().addScaledVector(normalizedDirection, distance),
    target,
    direction: normalizedDirection,
    up,
  }
}
