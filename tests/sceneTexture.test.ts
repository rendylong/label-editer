import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import * as sceneController from '../src/scene/SceneController'

describe('3D 标签纹理尺寸更新', () => {
  it('浅色摄影棚契约会应用到场景背景、网格和选择描边', () => {
    const studio = (sceneController as typeof sceneController & {
      LIGHT_STUDIO?: {
        background: number
        gridCenter: number
        gridLine: number
        outline: number
      }
    }).LIGHT_STUDIO
    const applyStudio = (sceneController as typeof sceneController & {
      applyLightStudioPalette?: (
        scene: THREE.Scene,
        outline: { visibleEdgeColor: THREE.Color; hiddenEdgeColor: THREE.Color },
      ) => THREE.GridHelper
    }).applyLightStudioPalette
    const scene = new THREE.Scene()
    const outline = {
      visibleEdgeColor: new THREE.Color(0),
      hiddenEdgeColor: new THREE.Color(0),
    }

    expect(studio).toEqual({
      background: 0xeef1f4,
      gridCenter: 0xaeb7c4,
      gridLine: 0xd7dce3,
      outline: 0x356ae6,
    })
    expect(applyStudio).toBeTypeOf('function')

    const grid = applyStudio?.(scene, outline)
    expect((scene.background as THREE.Color).getHex()).toBe(0xeef1f4)
    expect(outline.visibleEdgeColor.getHex()).toBe(0x356ae6)
    expect(outline.hiddenEdgeColor.getHex()).toBe(0x356ae6)
    const colors = grid?.geometry.getAttribute('color')
    const gridPalette = new Set(Array.from({ length: colors?.count ?? 0 }, (_, index) => new THREE.Color(
      colors!.getX(index),
      colors!.getY(index),
      colors!.getZ(index),
    ).getHex()))
    expect(gridPalette).toEqual(new Set([0xaeb7c4, 0xd7dce3]))
  })

  it('浅色摄影棚约束环境、半球、直射光与曝光的组合能量', () => {
    const rendering = (sceneController as typeof sceneController & {
      LIGHT_STUDIO_RENDERING?: {
        exposure: number
        environmentIntensity: number
        hemisphereIntensity: number
        keyIntensity: number
        fillIntensity: number
        rimIntensity: number
      }
    }).LIGHT_STUDIO_RENDERING
    const createLights = (sceneController as typeof sceneController & {
      createLightStudioLights?: () => {
        hemisphere: THREE.HemisphereLight
        key: THREE.DirectionalLight
        fill: THREE.DirectionalLight
        rim: THREE.DirectionalLight
      }
    }).createLightStudioLights
    const configureRendering = (sceneController as typeof sceneController & {
      configureLightStudioRendering?: (
        renderer: Pick<THREE.WebGLRenderer, 'outputColorSpace' | 'toneMapping' | 'toneMappingExposure'>,
        scene: THREE.Scene,
        environment: THREE.Texture,
      ) => ReturnType<NonNullable<typeof createLights>>
    }).configureLightStudioRendering

    expect(configureRendering).toBeTypeOf('function')
    expect(rendering).toBeDefined()
    expect(createLights).toBeTypeOf('function')
    const lights = createLights?.()
    expect(lights?.hemisphere.groundColor.getHex()).toBe(0xc3cad4)
    expect(lights?.hemisphere.intensity).toBe(rendering?.hemisphereIntensity)
    expect(lights?.key.intensity).toBe(rendering?.keyIntensity)
    expect(lights?.fill.intensity).toBe(rendering?.fillIntensity)
    expect(lights?.rim.intensity).toBe(rendering?.rimIntensity)
    const directEnergy = (rendering?.keyIntensity ?? Infinity) + (rendering?.fillIntensity ?? 0) + (rendering?.rimIntensity ?? 0)
    const combinedDisplayEnergy = (
      (rendering?.hemisphereIntensity ?? Infinity)
      + directEnergy
      + (rendering?.environmentIntensity ?? Infinity)
    ) * (rendering?.exposure ?? Infinity)
    expect(rendering?.exposure).toBeLessThanOrEqual(0.72)
    expect(rendering?.environmentIntensity).toBeLessThanOrEqual(0.5)
    expect(rendering?.hemisphereIntensity).toBeLessThanOrEqual(0.5)
    expect(directEnergy).toBeLessThanOrEqual(1.4)
    expect(combinedDisplayEnergy).toBeLessThanOrEqual(1.45)
    expect(rendering?.keyIntensity).toBeGreaterThan(rendering?.rimIntensity ?? Infinity)
    expect(rendering?.rimIntensity).toBeGreaterThan(rendering?.fillIntensity ?? Infinity)
    expect(lights?.key.position.toArray()).toEqual([4, 8, 6])
    expect(lights?.fill.position.toArray()).toEqual([-4, 4, 5])
    expect(lights?.rim.position.toArray()).toEqual([-6, 2, -4])

    const renderer = {
      outputColorSpace: THREE.LinearSRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 2,
    }
    const scene = new THREE.Scene()
    const environment = new THREE.Texture()
    const installedLights = configureRendering?.(renderer, scene, environment)
    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace)
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping)
    expect(renderer.toneMappingExposure).toBe(rendering?.exposure)
    expect(scene.environment).toBe(environment)
    expect(scene.environmentIntensity).toBe(rendering?.environmentIntensity)
    expect(scene.children).toEqual(expect.arrayContaining(Object.values(installedLights ?? {})))
  })

  it('CanvasTexture 使用 glTF 的 V 方向，预览与导出不会上下颠倒', () => {
    const configure = (sceneController as typeof sceneController & {
      configureLabelCanvasTexture?: (texture: THREE.Texture, color: boolean) => void
    }).configureLabelCanvasTexture
    const texture = new THREE.Texture()

    configure?.(texture, true)

    expect(configure).toBeDefined()
    expect(texture.flipY).toBe(false)
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
  })

  it('普通瓶身使用独立贴标叠加层，不替换原几何或原材质', () => {
    const createOverlay = (sceneController as typeof sceneController & {
      createLabelOverlayMesh?: (
        source: THREE.Mesh,
        remap: {
          positions: Float32Array
          normals?: Float32Array
          uv: Float32Array
          indices: Uint32Array
        },
        mode: 'overlay' | 'replace',
      ) => THREE.Mesh
    }).createLabelOverlayMesh
    const parent = new THREE.Group()
    const originalGeometry = new THREE.BoxGeometry(1, 2, 1)
    const originalMaterial = new THREE.MeshPhysicalMaterial({ color: 0xf5f5f5, roughness: 0.4, clearcoat: 0.72 })
    const sourceMap = new THREE.Texture()
    const sourceNormalMap = new THREE.Texture()
    const sourceBumpMap = new THREE.Texture()
    originalMaterial.map = sourceMap
    originalMaterial.normalMap = sourceNormalMap
    originalMaterial.bumpMap = sourceBumpMap
    const source = new THREE.Mesh(originalGeometry, originalMaterial)
    source.name = '瓶身'
    parent.add(source)
    const remap = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    }

    const overlay = createOverlay?.(source, remap, 'overlay')

    expect(overlay).toBeDefined()
    expect(source.geometry).toBe(originalGeometry)
    expect(source.material).toBe(originalMaterial)
    expect(originalMaterial.map).toBe(sourceMap)
    expect(originalMaterial.normalMap).toBe(sourceNormalMap)
    expect(originalMaterial.bumpMap).toBe(sourceBumpMap)
    expect(originalMaterial.clearcoat).toBe(0.72)
    expect(source.visible).toBe(true)
    expect(overlay).not.toBe(source)
    expect(overlay?.geometry).not.toBe(originalGeometry)
    expect(overlay?.material).not.toBe(originalMaterial)
    expect(overlay?.parent).toBe(parent)
    // 共面透明贴标不能只依赖 GPU 的 polygonOffset；高精度 CAD 网格和
    // 后处理深度缓冲下会整层被瓶身遮住。叠加壳应沿法线有可忽略的物理间隙。
    const overlayPosition = overlay?.geometry.getAttribute('position')
    expect(overlayPosition?.getZ(0)).toBeGreaterThan(0)
  })

  it('inherits a perfume label source double-sided contract for the live overlay', () => {
    const parent = new THREE.Group()
    const sourceMaterial = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
    const source = new THREE.Mesh(new THREE.BufferGeometry(), sourceMaterial)
    source.name = 'label_Material008_0'
    parent.add(source)
    const overlay = sceneController.createLabelOverlayMesh(source, {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    }, 'replace')

    expect((overlay.material as THREE.MeshStandardMaterial).side).toBe(THREE.DoubleSide)
  })

  it('标签颜色贴图保持透明混合且不引入默认白色纸张', () => {
    const configure = (sceneController as typeof sceneController & {
      configureLabelMaterial?: (
        material: THREE.MeshStandardMaterial,
        textures: { color: THREE.Texture; metal: THREE.Texture; rough: THREE.Texture; bump: THREE.Texture },
      ) => void
    }).configureLabelMaterial
    const material = new THREE.MeshStandardMaterial({ color: 0x7f6a54 })
    const textures = {
      color: new THREE.Texture(),
      metal: new THREE.Texture(),
      rough: new THREE.Texture(),
      bump: new THREE.Texture(),
    }

    configure?.(material, textures)

    expect(configure).toBeTypeOf('function')
    expect(material.map).toBe(textures.color)
    expect(material.transparent).toBe(true)
    expect(material.opacity).toBe(1)
    expect(material.alphaMap).toBeNull()
    expect(material.alphaTest).toBeGreaterThan(0)
    expect(material.color.getHex()).toBe(0x7f6a54)
  })

  it('画布尺寸变化时要求重建 GPU 纹理，尺寸不变时允许热更新', () => {
    const matches = (sceneController as typeof sceneController & {
      labelTextureSizeMatches?: (
        current: { width: number; height: number },
        next: { color: { width: number; height: number } },
      ) => boolean
    }).labelTextureSizeMatches

    expect(matches?.({ width: 2048, height: 318 }, { color: { width: 2048, height: 318 } })).toBe(true)
    expect(matches?.({ width: 2048, height: 318 }, { color: { width: 2048, height: 338 } })).toBe(false)
  })

  it('多贴标区域的通道视图各自使用本区域纹理', () => {
    const apply = (sceneController as typeof sceneController & {
      applyChannelViewToLabels?: (
        meshes: Map<string, THREE.Mesh>,
        textureSets: Map<string, { color: THREE.Texture; metal: THREE.Texture; rough: THREE.Texture; bump: THREE.Texture }>,
        view: 'color' | 'metalness' | 'roughness' | 'bump' | null,
      ) => void
    }).applyChannelViewToLabels
    const materialA = new THREE.MeshStandardMaterial()
    const materialB = new THREE.MeshStandardMaterial()
    const meshA = new THREE.Mesh(undefined, materialA)
    const meshB = new THREE.Mesh(undefined, materialB)
    const setA = { color: new THREE.Texture(), metal: new THREE.Texture(), rough: new THREE.Texture(), bump: new THREE.Texture() }
    const setB = { color: new THREE.Texture(), metal: new THREE.Texture(), rough: new THREE.Texture(), bump: new THREE.Texture() }

    apply?.(new Map([['a', meshA], ['b', meshB]]), new Map([['a', setA], ['b', setB]]), 'metalness')

    expect(materialA.map).toBe(setA.metal)
    expect(materialB.map).toBe(setB.metal)
  })
})
