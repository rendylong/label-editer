import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { cameraForFrame, surfaceFrameForGeometry } from '../src/scene/qcCamera'

describe('QC camera math', () => {
  it('fits a tall model with a deterministic front camera', () => {
    const frame = { center: new THREE.Vector3(0, 1, 0), size: new THREE.Vector3(1, 2, 1) }
    const result = cameraForFrame(frame, new THREE.Vector3(0, 0, 1), {
      fov: 45, aspect: 1, margin: 1.15,
    })
    expect(result.target.toArray()).toEqual([0, 1, 0])
    expect(result.position.z).toBeGreaterThan(2)
    expect(result.direction.clone().normalize().toArray()).toEqual([0, 0, 1])
  })

  it('transforms an area normal through its world matrix', () => {
    const geometry = new THREE.PlaneGeometry(2, 1)
    const matrix = new THREE.Matrix4().makeRotationY(Math.PI / 2)
    const frame = surfaceFrameForGeometry(geometry, matrix)
    expect(frame.normal.x).toBeCloseTo(1, 5)
    expect(frame.normal.z).toBeCloseTo(0, 5)
  })

  it('keeps mirrored surface normals aligned with the transformed winding', () => {
    const geometry = new THREE.PlaneGeometry(2, 1)
    const matrix = new THREE.Matrix4().makeScale(-1, 1, 1)
    const frame = surfaceFrameForGeometry(geometry, matrix)
    expect(frame.normal.toArray()).toEqual([0, 0, -1])
  })

  it('fits an oblique direction with a non-square capture frame', () => {
    const frame = { center: new THREE.Vector3(4, -2, 1), size: new THREE.Vector3(6, 2, 4) }
    const result = cameraForFrame(frame, new THREE.Vector3(1, 0, 1), {
      fov: 45, aspect: 16 / 9, margin: 1.15,
    })
    expect(result.target.toArray()).toEqual([4, -2, 1])
    expect(result.position.toArray().every(Number.isFinite)).toBe(true)
    expect(result.up.toArray().every(Number.isFinite)).toBe(true)
    expect(result.position.distanceTo(result.target)).toBeGreaterThan(0)
    expect(Math.abs(result.direction.dot(result.up))).toBeLessThan(0.999)
  })

  it('uses a stable up vector for a near-vertical camera direction', () => {
    const frame = { center: new THREE.Vector3(), size: new THREE.Vector3(2, 3, 1) }
    const result = cameraForFrame(frame, new THREE.Vector3(0.001, 1, 0), {
      fov: 45, aspect: 16 / 9, margin: 1.15,
    })
    expect(result.target.toArray()).toEqual([0, 0, 0])
    expect(result.up.toArray().every(Number.isFinite)).toBe(true)
    expect(Math.abs(result.direction.dot(result.up))).toBeLessThan(0.999)
  })
})
