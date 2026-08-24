import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { LatestAsyncResourceOwner } from '../src/scene/LatestAsyncResourceOwner'
import { disposeObjectTree } from '../src/scene/SceneController'

interface LoadedResource {
  name: string
}

function controlledResource(): { promise: Promise<LoadedResource>; resolve: (resource: LoadedResource) => void } {
  let resolve!: (resource: LoadedResource) => void
  const promise = new Promise<LoadedResource>((next) => { resolve = next })
  return { promise, resolve }
}

describe('SceneController async load ownership', () => {
  it('disposes a pending old load after view disposal while a remounted owner alone installs and continues', async () => {
    const oldLoad = controlledResource()
    const remountedLoad = controlledResource()
    const installed: string[] = []
    const disposed: string[] = []
    const continued: string[] = []
    const oldOwner = new LatestAsyncResourceOwner()
    const oldResult = oldOwner.run(() => oldLoad.promise, {
      install: (resource) => installed.push(resource.name),
      dispose: (resource) => disposed.push(resource.name),
    }).then((accepted) => { if (accepted) continued.push('old') ; return accepted })

    oldOwner.dispose()
    const remountedOwner = new LatestAsyncResourceOwner()
    const remountedResult = remountedOwner.run(() => remountedLoad.promise, {
      install: (resource) => installed.push(resource.name),
      dispose: (resource) => disposed.push(resource.name),
    }).then((accepted) => { if (accepted) continued.push('remounted') ; return accepted })
    oldLoad.resolve({ name: 'stale-scene' })
    remountedLoad.resolve({ name: 'current-scene' })

    await expect(oldResult).resolves.toBe(false)
    await expect(remountedResult).resolves.toBe(true)
    expect(disposed).toEqual(['stale-scene'])
    expect(installed).toEqual(['current-scene'])
    expect(continued).toEqual(['remounted'])
  })

  it('disposes a superseded generation and installs only the latest load', async () => {
    const firstLoad = controlledResource()
    const secondLoad = controlledResource()
    const installed: string[] = []
    const disposed: string[] = []
    const owner = new LatestAsyncResourceOwner()
    const lifecycle = {
      install: (resource: LoadedResource) => installed.push(resource.name),
      dispose: (resource: LoadedResource) => disposed.push(resource.name),
    }

    const firstResult = owner.run(() => firstLoad.promise, lifecycle)
    const secondResult = owner.run(() => secondLoad.promise, lifecycle)
    firstLoad.resolve({ name: 'first-scene' })
    secondLoad.resolve({ name: 'second-scene' })

    await expect(firstResult).resolves.toBe(false)
    await expect(secondResult).resolves.toBe(true)
    expect(disposed).toEqual(['first-scene'])
    expect(installed).toEqual(['second-scene'])
  })

  it('disposes stale Three geometry, material, and textures exactly once', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const texture = new THREE.Texture()
    const material = new THREE.MeshStandardMaterial({ map: texture })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(geometry, material))
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')

    disposeObjectTree(root)

    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(textureDispose).toHaveBeenCalledTimes(1)
  })

  it('disposes one shared SkinnedMesh skeleton and its bone texture exactly once', () => {
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
    const root = new THREE.Group()
    root.add(first, second)
    const skeletonDispose = vi.spyOn(skeleton, 'dispose')
    const boneTextureDispose = vi.spyOn(boneTexture, 'dispose')

    disposeObjectTree(root)

    expect(skeletonDispose).toHaveBeenCalledTimes(1)
    expect(boneTextureDispose).toHaveBeenCalledTimes(1)
  })
})
