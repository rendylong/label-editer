import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { SceneController } from '../src/scene/SceneController'
import type { RemapOutput } from '../src/glb/uvRemap'

const REMAP: RemapOutput = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uv: new Float32Array([0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  vertexCount: 3,
  seamCrossingTriangles: 0,
  frontAngle: 0,
  maxSpan: 1,
}

function canvas(): HTMLCanvasElement {
  return { width: 4, height: 4 } as HTMLCanvasElement
}

function sourceMesh(name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshPhysicalMaterial({ color: 0xf4f4f4, clearcoat: 0.6 }),
  )
  mesh.name = name
  return mesh
}

function controllerWithModel(model: THREE.Group): SceneController {
  const controller = Object.create(SceneController.prototype) as SceneController
  Object.assign(controller as object, {
    failed: false,
    disposed: false,
    model,
    scene: new THREE.Scene(),
    labelMeshes: new Map(),
    labelSources: new Map(),
    labelTextures: new Map(),
    pendingBakes: new Map(),
    modelMeshesByIndex: new Map(),
    requestRender: vi.fn(),
    setOutlineTargets: vi.fn(),
  })
  return controller
}

describe('per-area 3D overlay lifecycle', () => {
  it('keeps front and back overlays independent when both target the same mesh', () => {
    const model = new THREE.Group()
    const source = sourceMesh('Bottle')
    model.add(source)
    const controller = controllerWithModel(model)
    const applyGeometry = controller.applyLabelGeometry as unknown as (
      remap: RemapOutput,
      nodeName: string,
      mode: 'overlay',
      meshIndex: number | undefined,
      areaId: string,
    ) => void

    applyGeometry.call(controller, REMAP, source.name, 'overlay', undefined, 'front')
    applyGeometry.call(controller, { ...REMAP, uv: new Float32Array([0.5, 0, 1, 0, 0.5, 1]) }, source.name, 'overlay', undefined, 'back')
    controller.applyLabelBake('front', { color: canvas(), metalness: canvas(), roughness: canvas(), bump: canvas() })
    controller.applyLabelBake('back', { color: canvas(), metalness: canvas(), roughness: canvas(), bump: canvas() })

    const internals = controller as unknown as {
      labelMeshes: Map<string, THREE.Mesh>
      labelTextures: Map<string, { color: THREE.Texture }>
    }
    expect([...internals.labelMeshes.keys()]).toEqual(['front', 'back'])
    expect(internals.labelMeshes.get('front')).not.toBe(internals.labelMeshes.get('back'))
    expect(internals.labelTextures.get('front')?.color).not.toBe(internals.labelTextures.get('back')?.color)
  })

  it('resolves a Three.js-sanitized perfume mesh by stable mesh index, preserves it until bake, and highlights the overlay', () => {
    const model = new THREE.Group()
    const source = sourceMesh('label_Material008_0')
    model.add(source)
    const controller = controllerWithModel(model)
    const internals = controller as unknown as {
      modelMeshesByIndex: Map<number, THREE.Mesh>
      labelMeshes: Map<string, THREE.Mesh>
      setOutlineTargets: ReturnType<typeof vi.fn>
    }
    internals.modelMeshesByIndex.set(6, source)
    const applyGeometry = controller.applyLabelGeometry as unknown as (
      remap: RemapOutput,
      nodeName: string,
      mode: 'replace',
      meshIndex: number,
    ) => void

    applyGeometry.call(controller, REMAP, 'label_Material.008_0', 'replace', 6)

    const overlay = internals.labelMeshes.get('label_Material.008_0')
    expect(overlay).toBeDefined()
    expect(source.visible).toBe(true)

    controller.applyLabelBake('label_Material.008_0', { color: canvas(), metalness: canvas(), roughness: canvas(), bump: canvas() })
    expect(source.visible).toBe(false)

    controller.setActiveAreaHighlight('label_Material.008_0')
    expect(internals.setOutlineTargets).toHaveBeenLastCalledWith([overlay])
  })

  it('removes only the deleted area, disposes its overlay resources, and restores its replace source', () => {
    const model = new THREE.Group()
    const sourceA = sourceMesh('Part A')
    const sourceB = sourceMesh('Part B')
    const materialA = sourceA.material
    const materialB = sourceB.material
    model.add(sourceA, sourceB)
    const controller = controllerWithModel(model)

    controller.applyLabelGeometry(REMAP, sourceA.name, 'replace')
    controller.applyLabelGeometry(REMAP, sourceB.name, 'overlay')
    controller.applyLabelBake(sourceA.name, { color: canvas(), metalness: canvas(), roughness: canvas(), bump: canvas() })
    controller.applyLabelBake(sourceB.name, { color: canvas(), metalness: canvas(), roughness: canvas(), bump: canvas() })

    const internals = controller as unknown as {
      labelMeshes: Map<string, THREE.Mesh>
      labelTextures: Map<string, { color: THREE.Texture; metal: THREE.Texture; rough: THREE.Texture; bump: THREE.Texture }>
    }
    const removedOverlay = internals.labelMeshes.get(sourceA.name)!
    const retainedOverlay = internals.labelMeshes.get(sourceB.name)!
    const removedGeometryDispose = vi.spyOn(removedOverlay.geometry, 'dispose')
    const removedMaterialDispose = vi.spyOn(removedOverlay.material as THREE.Material, 'dispose')
    const removedTextures = internals.labelTextures.get(sourceA.name)!
    const removedTextureDisposals = [removedTextures.color, removedTextures.metal, removedTextures.rough, removedTextures.bump]
      .map((texture) => vi.spyOn(texture, 'dispose'))
    const retainedTextureDispose = vi.spyOn(internals.labelTextures.get(sourceB.name)!.color, 'dispose')
    const reconcile = (controller as unknown as { reconcileLabelAreas?: (nodeNames: Iterable<string>) => void }).reconcileLabelAreas

    expect(sourceA.visible).toBe(false)
    expect(sourceB.visible).toBe(true)
    expect(reconcile).toBeTypeOf('function')
    reconcile?.call(controller, [sourceB.name])

    expect(internals.labelMeshes.has(sourceA.name)).toBe(false)
    expect(internals.labelTextures.has(sourceA.name)).toBe(false)
    expect(removedOverlay.parent).toBeNull()
    expect(removedGeometryDispose).toHaveBeenCalledTimes(1)
    expect(removedMaterialDispose).toHaveBeenCalledTimes(1)
    removedTextureDisposals.forEach((dispose) => expect(dispose).toHaveBeenCalledTimes(1))
    expect(sourceA.visible).toBe(true)
    expect(sourceA.material).toBe(materialA)

    expect(internals.labelMeshes.get(sourceB.name)).toBe(retainedOverlay)
    expect(retainedOverlay.parent).toBe(model)
    expect(retainedTextureDispose).not.toHaveBeenCalled()
    expect(sourceB.material).toBe(materialB)
  })
})
