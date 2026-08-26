import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { QcViewRequest } from '../src/agent/contracts'
import { SceneController } from '../src/scene/SceneController'
import { cameraForFrame, surfaceFrameForGeometry } from '../src/scene/qcCamera'

type QcCapture = (request: QcViewRequest) => Promise<{
  blob: Blob
  camera: {
    position: [number, number, number]
    direction: [number, number, number]
    target: [number, number, number]
    up: [number, number, number]
    fov: number
  }
}>

interface QcControllerInternals {
  camera: THREE.PerspectiveCamera
  controls: { target: THREE.Vector3 }
  renderer: {
    getSize(target: THREE.Vector2): THREE.Vector2
    setSize(width: number, height: number, updateStyle?: boolean): void
    getPixelRatio(): number
    setPixelRatio(value: number): void
    domElement: HTMLCanvasElement
  }
  composer: { setSize(width: number, height: number): void; render(): void }
  outline: { selectedObjects: THREE.Object3D[]; setSize(width: number, height: number): void }
  model: THREE.Group
  labelMeshes: Map<string, THREE.Mesh>
  labelTextures: Map<string, never>
  channelView: 'color' | 'metalness' | 'roughness' | 'bump' | null
  frontMarker: THREE.Object3D
  areaControlGroup: THREE.Group
  encodePng(canvas: HTMLCanvasElement): Promise<Blob>
}

function qcControllerHarness(areaRotationY = Math.PI / 2): { controller: SceneController; internals: QcControllerInternals } {
  const controller = Object.create(SceneController.prototype) as SceneController
  const model = new THREE.Group()
  const area = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshStandardMaterial())
  area.position.set(2, 0, 0)
  area.rotation.y = areaRotationY
  model.add(area)
  const camera = new THREE.PerspectiveCamera(52, 1.5, 0.01, 5000)
  camera.position.set(4, 3, 5)
  camera.up.set(0, 0.9, 0.1).normalize()
  camera.rotation.set(0.2, -0.3, 0.1)
  let width = 900
  let height = 700
  let pixelRatio = 2
  const outlineSelection = [new THREE.Object3D(), new THREE.Object3D()]
  const internals: QcControllerInternals = {
    camera,
    controls: { target: new THREE.Vector3(1, 2, 3) },
    renderer: {
      getSize: (target) => target.set(width, height),
      setSize: (nextWidth, nextHeight) => { width = nextWidth; height = nextHeight },
      getPixelRatio: () => pixelRatio,
      setPixelRatio: (value) => { pixelRatio = value },
      domElement: {} as HTMLCanvasElement,
    },
    composer: { setSize: vi.fn(), render: vi.fn() },
    outline: { selectedObjects: outlineSelection, setSize: vi.fn() },
    model,
    labelMeshes: new Map([['front.area', area]]),
    labelTextures: new Map<string, never>(),
    channelView: 'roughness',
    frontMarker: new THREE.Object3D(),
    areaControlGroup: new THREE.Group(),
    encodePng: async () => new Blob(['png'], { type: 'image/png' }),
  }
  Object.assign(controller as object, {
    ...internals,
    failed: false,
    disposed: false,
    requestRender: vi.fn(),
  })
  return { controller, internals: controller as unknown as QcControllerInternals }
}

function captureQc(controller: SceneController, request: QcViewRequest) {
  const capture = (controller as unknown as { captureQcPng?: QcCapture }).captureQcPng
  expect(capture).toBeTypeOf('function')
  return capture!.call(controller, request)
}

function captureState(internals: QcControllerInternals) {
  return {
    cameraPosition: internals.camera.position.toArray(),
    cameraQuaternion: internals.camera.quaternion.toArray(),
    cameraUp: internals.camera.up.toArray(),
    cameraFov: internals.camera.fov,
    cameraAspect: internals.camera.aspect,
    cameraWorldDirection: internals.camera.getWorldDirection(new THREE.Vector3()).toArray(),
    controlsTarget: internals.controls.target.toArray(),
    channel: internals.channelView,
    rendererSize: internals.renderer.getSize(new THREE.Vector2()).toArray(),
    pixelRatio: internals.renderer.getPixelRatio(),
    outlineSelection: [...internals.outline.selectedObjects],
    frontMarkerVisible: internals.frontMarker.visible,
    areaControlVisible: internals.areaControlGroup.visible,
  }
}

const AREA_FACE_REQUEST: QcViewRequest = {
  id: 'area-front-face',
  target: { kind: 'area', areaId: 'front.area' },
  framing: 'fit-area',
  pose: { kind: 'area-face' },
  channel: 'color',
  width: 640,
  height: 320,
  areaId: 'front.area',
  reason: 'Area face color close-up',
}

function expectAllCornersInsideFrustum(
  frame: { center: THREE.Vector3; size: THREE.Vector3 },
  camera: ReturnType<typeof cameraForFrame>,
  fov: number,
  aspect: number,
) {
  const halfSize = frame.size.clone().multiplyScalar(0.5)
  const right = camera.direction.clone().cross(camera.up).normalize()
  const forward = camera.direction.clone().negate()
  const verticalSlope = Math.tan(THREE.MathUtils.degToRad(fov) / 2)
  const horizontalSlope = verticalSlope * aspect
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        const corner = frame.center.clone().add(new THREE.Vector3(
          x * halfSize.x, y * halfSize.y, z * halfSize.z,
        ))
        const cameraToCorner = corner.sub(camera.position)
        const depth = cameraToCorner.dot(forward)
        expect(depth).toBeGreaterThan(0)
        expect(Math.abs(cameraToCorner.dot(right))).toBeLessThanOrEqual(depth * horizontalSlope + 1e-8)
        expect(Math.abs(cameraToCorner.dot(camera.up))).toBeLessThanOrEqual(depth * verticalSlope + 1e-8)
      }
    }
  }
}

describe('QC camera math', () => {
  it('fits a tall model with a deterministic front camera', () => {
    const frame = { center: new THREE.Vector3(0, 1, 0), size: new THREE.Vector3(1, 2, 1) }
    const result = cameraForFrame(frame, new THREE.Vector3(0, 0, 1), {
      fov: 45, aspect: 1, margin: 1.15,
    })
    expect(result.target.toArray()).toEqual([0, 1, 0])
    expect(result.position.z).toBeGreaterThan(2)
    expect(result.direction.clone().normalize().toArray()).toEqual([0, 0, 1])
    expectAllCornersInsideFrustum(frame, result, 45, 1)
  })

  it('transforms an area normal through its world matrix', () => {
    const geometry = new THREE.PlaneGeometry(2, 1)
    const matrix = new THREE.Matrix4().makeRotationY(Math.PI / 2)
    const frame = surfaceFrameForGeometry(geometry, matrix)
    expect(frame.normal.x).toBeCloseTo(1, 5)
    expect(frame.normal.z).toBeCloseTo(0, 5)
  })

  it('keeps the rendered front selected for mirrored vertex and triangle normals', () => {
    const geometry = new THREE.PlaneGeometry(2, 1)
    const matrix = new THREE.Matrix4().makeScale(-1, 1, 1)
    expect(surfaceFrameForGeometry(geometry, matrix).normal.toArray()).toEqual([0, 0, 1])
    geometry.deleteAttribute('normal')
    expect(surfaceFrameForGeometry(geometry, matrix).normal.toArray()).toEqual([0, 0, 1])
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
    expectAllCornersInsideFrustum(frame, result, 45, 16 / 9)
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

  it.each([
    new THREE.Vector3(),
    new THREE.Vector3(Number.NaN, 0, 1),
    new THREE.Vector3(Infinity, 0, 1),
  ])('rejects an invalid camera direction', (direction) => {
    const frame = { center: new THREE.Vector3(), size: new THREE.Vector3(1, 1, 1) }
    expect(() => cameraForFrame(frame, direction, { fov: 45, aspect: 1, margin: 1.15 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_USAGE' }))
  })

  it('captures an area-face camera and restores every mutated scene state after success', async () => {
    const { controller, internals } = qcControllerHarness()
    const before = captureState(internals)
    let during: ReturnType<typeof captureState> | undefined
    internals.encodePng = async () => {
      during = captureState(internals)
      return new Blob(['png'], { type: 'image/png' })
    }

    const result = await captureQc(controller, AREA_FACE_REQUEST)

    expect(result.blob.type).toBe('image/png')
    expect(result.camera.target).toEqual([2, 0, 0])
    expect(result.camera.direction[0]).toBeCloseTo(-1, 5)
    expect(result.camera.direction[1]).toBeCloseTo(0, 5)
    expect(result.camera.direction[2]).toBeCloseTo(0, 5)
    expect(result.camera.position).toEqual(during?.cameraPosition)
    expect(result.camera.direction).toEqual(during?.cameraWorldDirection)
    expect(result.camera.target).toEqual(during?.controlsTarget)
    expect(result.camera.up).toEqual(during?.cameraUp)
    expect(result.camera.fov).toBe(during?.cameraFov)
    expect(during).toMatchObject({
      channel: 'color',
      rendererSize: [640, 320],
      pixelRatio: 1,
      outlineSelection: [],
      frontMarkerVisible: false,
      areaControlVisible: false,
    })
    expect(captureState(internals)).toEqual(before)
  })

  it('uses the same canonical horizontal side for opposite area-craft normals without changing face cameras', async () => {
    for (const [areaRotationY, expectedNormalX] of [
      [Math.PI / 2, 1],
      [-Math.PI / 2, -1],
    ] as const) {
      const { controller, internals } = qcControllerHarness(areaRotationY)
      const before = captureState(internals)
      const face = await captureQc(controller, AREA_FACE_REQUEST)
      const craft = await captureQc(controller, {
        ...AREA_FACE_REQUEST,
        id: 'area-front-craft',
        pose: { kind: 'area-craft' },
      })
      const faceOffset = new THREE.Vector3(...face.camera.position)
        .sub(new THREE.Vector3(...face.camera.target)).normalize()
      const craftOffset = new THREE.Vector3(...craft.camera.position)
        .sub(new THREE.Vector3(...craft.camera.target)).normalize()

      expect(faceOffset.x).toBeCloseTo(expectedNormalX, 5)
      expect(faceOffset.y).toBeCloseTo(0, 5)
      expect(faceOffset.z).toBeCloseTo(0, 5)
      expect(craftOffset.x * expectedNormalX).toBeGreaterThan(0)
      expect(craftOffset.y).toBeGreaterThan(0)
      expect(craftOffset.z).toBeGreaterThan(0)
      expect(craft.camera.direction[0]).toBeCloseTo(-craftOffset.x, 5)
      expect(craft.camera.direction[1]).toBeCloseTo(-craftOffset.y, 5)
      expect(craft.camera.direction[2]).toBeCloseTo(-craftOffset.z, 5)
      expect(captureState(internals)).toEqual(before)
    }
  })

  it('does not restore stale visibility onto markers replaced during async PNG encoding', async () => {
    const { controller, internals } = qcControllerHarness()
    let resolveEncoding!: (blob: Blob) => void
    const encoding = new Promise<Blob>((resolve) => { resolveEncoding = resolve })
    internals.encodePng = () => encoding
    const originalMarker = internals.frontMarker
    const originalAreaControl = internals.areaControlGroup

    const capture = captureQc(controller, AREA_FACE_REQUEST)
    const replacementMarker = new THREE.Object3D()
    const replacementAreaControl = new THREE.Group()
    replacementMarker.visible = false
    replacementAreaControl.visible = false
    internals.frontMarker = replacementMarker
    internals.areaControlGroup = replacementAreaControl
    resolveEncoding(new Blob(['png'], { type: 'image/png' }))

    await expect(capture).resolves.toMatchObject({ blob: expect.any(Blob) })
    expect(replacementMarker.visible).toBe(false)
    expect(replacementAreaControl.visible).toBe(false)
    expect(originalMarker.visible).toBe(false)
    expect(originalAreaControl.visible).toBe(false)
  })

  it('restores every mutated scene state when PNG encoding rejects', async () => {
    const { controller, internals } = qcControllerHarness()
    const before = captureState(internals)
    internals.encodePng = async () => { throw new Error('forced PNG rejection') }

    await expect(captureQc(controller, {
      ...AREA_FACE_REQUEST,
      id: 'area-front-craft',
      pose: { kind: 'area-craft' },
      channel: 'bump',
    })).rejects.toMatchObject({ code: 'REBUILD_FAILED', message: expect.stringContaining('forced PNG rejection') })

    expect(captureState(internals)).toEqual(before)
  })

  it('rejects an unknown area with its exact id before encoding', async () => {
    const { controller, internals } = qcControllerHarness()
    const encodePng = vi.fn(internals.encodePng)
    internals.encodePng = encodePng

    await expect(captureQc(controller, {
      ...AREA_FACE_REQUEST,
      target: { kind: 'area', areaId: 'missing.area-42' },
      areaId: 'missing.area-42',
    })).rejects.toMatchObject({
      code: 'MODEL_TARGET_NOT_FOUND',
      message: expect.stringContaining('missing.area-42'),
    })
    expect(encodePng).not.toHaveBeenCalled()
  })
})
