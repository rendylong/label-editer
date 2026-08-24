import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LatestAsyncResourceOwner } from '../src/scene/LatestAsyncResourceOwner'
import { SceneController } from '../src/scene/SceneController'

interface LoadedGltf {
  scene: THREE.Group
}

function controlledLoad<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  // The pre-seam RED run intentionally leaves these controlled promises
  // unconsumed by production. Mark rejections handled without changing the
  // promise observed by SceneController once the seam exists.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

function disposableScene(name: string) {
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const texture = new THREE.Texture()
  const material = new THREE.MeshStandardMaterial({ map: texture })
  const scene = new THREE.Group()
  scene.name = name
  scene.add(new THREE.Mesh(geometry, material))
  return {
    scene,
    disposeGeometry: vi.spyOn(geometry, 'dispose'),
    disposeMaterial: vi.spyOn(material, 'dispose'),
    disposeTexture: vi.spyOn(texture, 'dispose'),
  }
}

function disposableSharedSkeletonScene(name: string) {
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial()
  const bone = new THREE.Bone()
  const skeleton = new THREE.Skeleton([bone])
  const boneTexture = new THREE.DataTexture(new Float32Array(16), 4, 1, THREE.RGBAFormat, THREE.FloatType)
  skeleton.boneTexture = boneTexture
  const first = new THREE.SkinnedMesh(geometry, material)
  const second = new THREE.SkinnedMesh(geometry, material)
  first.bind(skeleton)
  second.bind(skeleton)
  const scene = new THREE.Group()
  scene.name = name
  scene.add(first, second)
  return {
    scene,
    disposeSkeleton: vi.spyOn(skeleton, 'dispose'),
    disposeBoneTexture: vi.spyOn(boneTexture, 'dispose'),
  }
}

function controllerHarness(
  loadGltf: (bytes: Uint8Array) => Promise<LoadedGltf>,
  onStatus: (status: 'loading' | 'ready' | 'error', message?: string) => void,
  onMeshFound = vi.fn(),
): SceneController {
  const container = { removeChild: vi.fn() }
  const controller = Object.create(SceneController.prototype) as SceneController
  Object.assign(controller as object, {
    container,
    onStatus,
    onMeshFound,
    renderer: { dispose: vi.fn(), domElement: { parentNode: null } },
    scene: new THREE.Scene(),
    controls: { dispose: vi.fn() },
    environmentTarget: null,
    raf: 0,
    disposed: false,
    failed: false,
    model: null,
    draco: { dispose: vi.fn() },
    resizeObserver: { disconnect: vi.fn() },
    modelLoads: new LatestAsyncResourceOwner(),
    loadGltf,
    clearModel: vi.fn(),
    fitCamera: vi.fn(),
    requestRender: vi.fn(),
  })
  return controller
}

function harnessScene(controller: SceneController): THREE.Scene {
  return (controller as unknown as { scene: THREE.Scene }).scene
}

describe('SceneController.loadModel integration ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(((...args: unknown[]) => {
      const onError = args[3] as ((error: unknown) => void) | undefined
      onError?.(new Error('unexpected default GLTFLoader path'))
      return undefined
    }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('installs and continues only the current controlled load', async () => {
    const load = controlledLoad<LoadedGltf>()
    const statuses: string[] = []
    const onMeshFound = vi.fn()
    const controller = controllerHarness(
      () => load.promise,
      (status) => statuses.push(status),
      onMeshFound,
    )
    const resource = disposableScene('current')

    const result = controller.loadModel(new Uint8Array([1, 2, 3]))
    load.resolve({ scene: resource.scene })

    await expect(result).resolves.toBe(true)
    expect(harnessScene(controller).children).toContain(resource.scene)
    expect(statuses).toEqual(['loading', 'ready'])
    expect(onMeshFound).toHaveBeenCalledTimes(1)
    expect(resource.disposeGeometry).not.toHaveBeenCalled()
  })

  it('rejects a load resolved after controller disposal and disposes all acquired model resources', async () => {
    const load = controlledLoad<LoadedGltf>()
    const statuses: string[] = []
    const onMeshFound = vi.fn()
    const controller = controllerHarness(
      () => load.promise,
      (status) => statuses.push(status),
      onMeshFound,
    )
    const resource = disposableScene('disposed')

    const result = controller.loadModel(new Uint8Array([1]))
    controller.dispose()
    load.resolve({ scene: resource.scene })

    await expect(result).resolves.toBe(false)
    expect(harnessScene(controller).children).not.toContain(resource.scene)
    expect(statuses).toEqual(['loading'])
    expect(onMeshFound).not.toHaveBeenCalled()
    expect(resource.disposeGeometry).toHaveBeenCalledTimes(1)
    expect(resource.disposeMaterial).toHaveBeenCalledTimes(1)
    expect(resource.disposeTexture).toHaveBeenCalledTimes(1)
  })

  it('uses the same deduplicated skeleton teardown for an installed model on normal controller disposal', async () => {
    const load = controlledLoad<LoadedGltf>()
    const controller = controllerHarness(() => load.promise, vi.fn())
    const resource = disposableSharedSkeletonScene('installed-skinned-model')
    const result = controller.loadModel(new Uint8Array([1]))
    load.resolve({ scene: resource.scene })
    await expect(result).resolves.toBe(true)

    const internals = controller as unknown as Record<string, unknown>
    delete internals.clearModel
    Object.assign(internals, {
      labelMeshes: new Map(),
      labelSources: new Map(),
      labelTextures: new Map(),
      pendingBakes: new Map(),
      showAreaControl: vi.fn(),
      removeMarker: vi.fn(),
      setOutlineTargets: vi.fn(),
    })
    controller.dispose()

    expect(resource.disposeSkeleton).toHaveBeenCalledTimes(1)
    expect(resource.disposeBoneTexture).toHaveBeenCalledTimes(1)
  })

  it('disposes a superseded resolution while the latest resolution installs', async () => {
    const first = controlledLoad<LoadedGltf>()
    const second = controlledLoad<LoadedGltf>()
    const loads = [first, second]
    const statuses: string[] = []
    const onMeshFound = vi.fn()
    const controller = controllerHarness(
      () => loads.shift()!.promise,
      (status) => statuses.push(status),
      onMeshFound,
    )
    const staleResource = disposableScene('stale')
    const currentResource = disposableScene('latest')

    const staleResult = controller.loadModel(new Uint8Array([1]))
    const currentResult = controller.loadModel(new Uint8Array([2]))
    first.resolve({ scene: staleResource.scene })
    second.resolve({ scene: currentResource.scene })

    await expect(staleResult).resolves.toBe(false)
    await expect(currentResult).resolves.toBe(true)
    expect(harnessScene(controller).children).not.toContain(staleResource.scene)
    expect(harnessScene(controller).children).toContain(currentResource.scene)
    expect(staleResource.disposeGeometry).toHaveBeenCalledTimes(1)
    expect(currentResource.disposeGeometry).not.toHaveBeenCalled()
    expect(onMeshFound).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual(['loading', 'loading', 'ready'])
  })

  it('reports only an active load error and ignores an error from a stale generation', async () => {
    const stale = controlledLoad<LoadedGltf>()
    const current = controlledLoad<LoadedGltf>()
    const activeError = controlledLoad<LoadedGltf>()
    const loads = [stale, current, activeError]
    const statuses: Array<[string, string | undefined]> = []
    const controller = controllerHarness(
      () => loads.shift()!.promise,
      (status, message) => statuses.push([status, message]),
    )
    const currentResource = disposableScene('current')

    const staleResult = controller.loadModel(new Uint8Array([1]))
    const currentResult = controller.loadModel(new Uint8Array([2]))
    stale.reject(new Error('stale failure'))
    current.resolve({ scene: currentResource.scene })

    await expect(staleResult).resolves.toBe(false)
    await expect(currentResult).resolves.toBe(true)
    expect(statuses).not.toContainEqual(['error', 'stale failure'])

    const errorResult = controller.loadModel(new Uint8Array([3]))
    activeError.reject(new Error('active failure'))
    await expect(errorResult).resolves.toBe(false)
    expect(statuses).toContainEqual(['error', 'active failure'])
  })
})
