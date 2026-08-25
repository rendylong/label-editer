/**
 * three.js 场景控制器：加载、轨道、高亮、标签 UV/纹理热更新、正面标记、通道视图。
 * 渲染策略：脏标记按需渲染（编辑连帧、空闲停帧）。
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { RemapOutput } from '../glb/uvRemap'
import { basisForAxis } from '../glb/uvRemap'
import type { RemapParams, LabelAreaRange } from '../label/types'
import { surfaceToUV, uvToSurface, areaBoxPoints, areaControlPoints, type UV } from '../glb/areaMath'
import { offsetOverlayPositions } from '../glb/overlayGeometry'
import { LatestAsyncResourceOwner } from './LatestAsyncResourceOwner'
import type { QcCameraMetadata, QcViewRequest } from '../agent/contracts'
import { cameraForFrame, surfaceFrameForGeometry, type QcTargetFrame } from './qcCamera'

type PngEncoder = (canvas: HTMLCanvasElement) => Promise<Blob>

export interface LoadedSceneResource {
  scene: THREE.Group
  /** glTF mesh index is stable even when GLTFLoader sanitizes or deduplicates object names. */
  meshesByIndex?: Map<number, THREE.Mesh>
}

export type SceneModelLoader = (bytes: Uint8Array) => Promise<LoadedSceneResource>

interface SceneControllerOptions {
  container: HTMLElement
  onStatus?: (status: 'loading' | 'ready' | 'error', msg?: string) => void
  onMeshFound?: (mesh: THREE.Mesh, nodeName: string) => void
  /** Deterministic ownership seam; production uses the local GLTF/DRACO loader. */
  loadGltf?: SceneModelLoader
  /** PNG boundary seam used by deterministic capture tests. */
  encodePng?: PngEncoder
}

interface LabelTextureSet {
  color: THREE.CanvasTexture
  metal: THREE.CanvasTexture
  rough: THREE.CanvasTexture
  bump: THREE.CanvasTexture
  width: number
  height: number
}

export const LIGHT_STUDIO = {
  background: 0xeef1f4,
  gridCenter: 0xaeb7c4,
  gridLine: 0xd7dce3,
  outline: 0x356ae6,
} as const

/**
 * Complete display-energy contract for the neutral studio. RoomEnvironment,
 * hemisphere, direct lights, and tone-mapping exposure all contribute to the
 * same highlight budget, so they must be tuned as one system.
 */
export const LIGHT_STUDIO_RENDERING = {
  exposure: 0.68,
  environmentIntensity: 0.42,
  hemisphereIntensity: 0.42,
  keyIntensity: 0.78,
  fillIntensity: 0.18,
  rimIntensity: 0.3,
} as const

/** Apply the approved neutral studio palette to the real Three.js presentation objects. */
export function applyLightStudioPalette(
  scene: THREE.Scene,
  outline: Pick<OutlinePass, 'visibleEdgeColor' | 'hiddenEdgeColor'>,
): THREE.GridHelper {
  scene.background = new THREE.Color(LIGHT_STUDIO.background)
  outline.visibleEdgeColor.setHex(LIGHT_STUDIO.outline)
  outline.hiddenEdgeColor.setHex(LIGHT_STUDIO.outline)
  return new THREE.GridHelper(4, 20, LIGHT_STUDIO.gridCenter, LIGHT_STUDIO.gridLine)
}

/** Balanced neutral lights keep bright plastics below clipping while retaining glass/amber highlights. */
export function createLightStudioLights(): {
  hemisphere: THREE.HemisphereLight
  key: THREE.DirectionalLight
  fill: THREE.DirectionalLight
  rim: THREE.DirectionalLight
} {
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0xc3cad4, LIGHT_STUDIO_RENDERING.hemisphereIntensity)
  const key = new THREE.DirectionalLight(0xffffff, LIGHT_STUDIO_RENDERING.keyIntensity)
  key.position.set(4, 8, 6)
  const fill = new THREE.DirectionalLight(0xe5ebf5, LIGHT_STUDIO_RENDERING.fillIntensity)
  fill.position.set(-4, 4, 5)
  const rim = new THREE.DirectionalLight(0xcbd8ef, LIGHT_STUDIO_RENDERING.rimIntensity)
  rim.position.set(-6, 2, -4)
  return { hemisphere, key, fill, rim }
}

/** Install the complete studio rendering contract without touching model materials. */
export function configureLightStudioRendering(
  renderer: Pick<THREE.WebGLRenderer, 'outputColorSpace' | 'toneMapping' | 'toneMappingExposure'>,
  scene: THREE.Scene,
  environment: THREE.Texture,
): ReturnType<typeof createLightStudioLights> {
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = LIGHT_STUDIO_RENDERING.exposure
  installStudioEnvironment(scene, environment, LIGHT_STUDIO_RENDERING.environmentIntensity)
  const lights = createLightStudioLights()
  scene.add(lights.hemisphere, lights.key, lights.fill, lights.rim)
  return lights
}

export function disposeObjectTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const skeletons = new Set<THREE.Skeleton>()
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry instanceof THREE.BufferGeometry) geometries.add(mesh.geometry)
    const skinnedMesh = object as THREE.SkinnedMesh
    if (skinnedMesh.isSkinnedMesh && skinnedMesh.skeleton) skeletons.add(skinnedMesh.skeleton)
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const material of meshMaterials) {
      materials.add(material)
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
    }
  })
  for (const skeleton of skeletons) {
    if (skeleton.boneTexture) textures.delete(skeleton.boneTexture)
    skeleton.dispose()
  }
  for (const texture of textures) texture.dispose()
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}

/** 多区域通道查看必须按 nodeName 一一匹配，不能把最后一套纹理覆盖到全部网格。 */
export function applyChannelViewToLabels(
  meshes: Map<string, THREE.Mesh>,
  textureSets: Map<string, Pick<LabelTextureSet, 'color' | 'metal' | 'rough' | 'bump'>>,
  view: 'color' | 'metalness' | 'roughness' | 'bump' | null,
): void {
  for (const [nodeName, mesh] of meshes) {
    const texs = textureSets.get(nodeName)
    if (!texs) continue
    const mat = mesh.material as THREE.MeshStandardMaterial
    if (view === 'color' || view === null) {
      mat.map = texs.color
      mat.metalnessMap = texs.metal
      mat.roughnessMap = texs.rough
      mat.bumpMap = texs.bump
      mat.metalness = 1
      mat.roughness = 1
    } else {
      mat.map = view === 'metalness' ? texs.metal : view === 'roughness' ? texs.rough : texs.bump
      mat.metalnessMap = null
      mat.roughnessMap = null
      mat.bumpMap = null
      mat.metalness = 0
      mat.roughness = 1
    }
    mat.needsUpdate = true
  }
}

/** GPU 纹理仅可在像素尺寸不变时安全替换 image。 */
export function labelTextureSizeMatches(
  current: { width: number; height: number },
  next: { color: { width: number; height: number } },
): boolean {
  return current.width === next.color.width && current.height === next.color.height
}

/** CanvasTexture 对齐 glTF 的纹理坐标方向，保证实时预览和导出文件一致。 */
export function configureLabelCanvasTexture(texture: THREE.Texture, color: boolean): void {
  texture.flipY = false
  // The canvas edge is deliberately transparent so UVs outside a label area disappear.
  // Mipmaps mix that edge with opaque paper and create dark bands on sibling overlays.
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  if (color) texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
}

function encodeCanvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('3D preview PNG encoding failed'))
    }, 'image/png')
  })
}

function captureDimensions(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.min(4096, Math.round(width))),
    height: Math.max(1, Math.min(4096, Math.round(height))),
  }
}

/** 为 PBR 材质安装图像环境光；不改变场景背景，只恢复金属、玻璃与清漆的反射细节。 */
export function installStudioEnvironment(scene: THREE.Scene, texture: THREE.Texture, intensity = 0.7): void {
  scene.environment = texture
  scene.environmentIntensity = intensity
}

/** 让编辑器烘焙完整接管标签表面，避免原 GLB 的 UV 贴图按重映射 UV 错位叠加。 */
export function configureLabelMaterial(
  material: THREE.MeshStandardMaterial,
  textures: { color: THREE.Texture; metal: THREE.Texture; rough: THREE.Texture; bump: THREE.Texture },
): void {
  material.map = textures.color
  material.metalnessMap = textures.metal
  material.roughnessMap = textures.rough
  material.bumpMap = textures.bump
  // 几何 UV 已由贴标展开逻辑重建；原模型 normalMap 仍使用旧 UV，继续保留会产生
  // 条纹、污点与高光错位。预览改用编辑器生成的 bumpMap 作为唯一微表面来源。
  material.normalMap = null
  material.bumpScale = 0.08
  // 颜色贴图是透明贴标叠加层；透明像素必须露出原模型材质。极低 alpha 先丢弃，
  // 其余像素写入深度，避免高细分闭合瓶壳在透明队列中因三角形顺序互相覆盖成条带。
  // 仍保留 transparent 以支持半透明纸张；旧 alphaMap 使用原 UV，需要一并移除。
  material.transparent = true
  material.opacity = 1
  material.alphaMap = null
  material.alphaTest = 1 / 255
  material.depthWrite = true
  // 标签网格通常由瓶身表面复制而来，二者几乎共面。保留正常深度测试，
  // 但把标签的深度轻微拉向相机，避免瓶身逐像素穿透形成 z-fighting 条纹。
  material.polygonOffset = true
  material.polygonOffsetFactor = -1
  material.polygonOffsetUnits = -4
  material.needsUpdate = true
}

/**
 * 由目标表面创建独立的贴标叠加网格。
 * 关键不变量：普通瓶身的原 geometry/material 永远不被贴标编辑器接管。
 */
export function createLabelOverlayMesh(
  source: THREE.Mesh,
  remap: Pick<RemapOutput, 'positions' | 'normals' | 'uv' | 'indices'>,
  mode: 'overlay' | 'replace',
): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  const positions = mode === 'overlay' ? offsetOverlayPositions(remap.positions, remap.normals) : remap.positions
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (remap.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(remap.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(remap.uv, 2))
  geometry.setIndex(new THREE.BufferAttribute(remap.indices, 1))

  // 纹理尚未烘焙时保持完全透明，避免新增区域的一瞬间用白材质盖住瓶身。
  const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    alphaTest: 1 / 255,
    depthWrite: true,
    side: sourceMaterial?.side ?? THREE.FrontSide,
  })
  const overlay = new THREE.Mesh(geometry, material)
  overlay.name = `__label_overlay__${source.name}`
  overlay.position.copy(source.position)
  overlay.quaternion.copy(source.quaternion)
  overlay.scale.copy(source.scale)
  overlay.matrixAutoUpdate = source.matrixAutoUpdate
  if (!source.matrixAutoUpdate) overlay.matrix.copy(source.matrix)
  overlay.castShadow = source.castShadow
  overlay.receiveShadow = source.receiveShadow
  overlay.renderOrder = source.renderOrder + 1
  source.parent?.add(overlay)
  return overlay
}

/** 创建 WebGLRenderer 并逐级降级重试（覆盖受限环境/远程桌面/无 GPU 场景）。 */
function createRendererWithFallback(): THREE.WebGLRenderer {
  const attempts: THREE.WebGLRendererParameters[] = [{ antialias: true, alpha: true }, { antialias: false, alpha: false }, { antialias: false, alpha: false, powerPreference: 'low-power' }]
  for (const params of attempts) {
    try {
      return new THREE.WebGLRenderer(params)
    } catch {
      /* 尝试下一级 */
    }
  }
  // 最后尝试显式 webgl1 上下文（three 支持传入既有 context）
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('webgl') as WebGLRenderingContext | null
    if (ctx) {
      return new THREE.WebGLRenderer({ canvas, context: ctx as never })
    }
  } catch {
    /* ignore */
  }
  throw new Error('WebGL unavailable')
}

async function loadGltfBytes(bytes: Uint8Array, draco: DRACOLoader): Promise<LoadedSceneResource> {
  const blob = new Blob([bytes as BlobPart], { type: 'model/gltf-binary' })
  const url = URL.createObjectURL(blob)
  const loader = new GLTFLoader()
  loader.setDRACOLoader(draco)
  try {
    return await new Promise<LoadedSceneResource>((resolve, reject) => {
      loader.load(url, (gltf) => {
        const meshesByIndex = new Map<number, THREE.Mesh>()
        gltf.scene.traverse((object) => {
          const mesh = object as THREE.Mesh
          const association = gltf.parser.associations.get(object)
          if (mesh.isMesh && typeof association?.meshes === 'number' && !meshesByIndex.has(association.meshes)) {
            meshesByIndex.set(association.meshes, mesh)
          }
        })
        resolve({ scene: gltf.scene, meshesByIndex })
      }, undefined, reject)
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export class SceneController {
  private container: HTMLElement
  private onStatus?: SceneControllerOptions['onStatus']
  private onMeshFound?: SceneControllerOptions['onMeshFound']
  private renderer!: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera!: THREE.PerspectiveCamera
  private controls!: OrbitControls
  private composer!: EffectComposer
  private outline!: OutlinePass
  private environmentTarget: THREE.WebGLRenderTarget | null = null
  private raf = 0
  private needsRender = true
  private disposed = false
  private model: THREE.Group | null = null
  private modelMeshesByIndex = new Map<number, THREE.Mesh>()
  private draco = new DRACOLoader()
  /** 贴标区域相关：每个区域一个 mesh + 独立纹理 */
  private labelMeshes = new Map<string, THREE.Mesh>()
  private labelSources = new Map<string, {
    mesh: THREE.Mesh
    mode: 'overlay' | 'replace'
    visibleWithoutLabel: boolean
  }>()
  private labelTextures = new Map<string, LabelTextureSet>()
  /** 待应用烘焙（mesh 未就绪时缓存） */
  private pendingBakes = new Map<string, { color: HTMLCanvasElement; metalness: HTMLCanvasElement; roughness: HTMLCanvasElement; bump: HTMLCanvasElement }>()
  private frontMarker: THREE.Mesh | null = null
  private frontMarkerNode = ''
  /** 3D 区域控制框 */
  private areaControlGroup: THREE.Group | null = null
  private areaControlPoints: THREE.Mesh[] = []
  private areaControlLines: THREE.LineSegments | null = null
  private areaControlData: { remap: RemapParams; range: LabelAreaRange; axisMin: number; axisMax: number } | null = null
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private grid!: THREE.GridHelper
  private resizeObserver: ResizeObserver
  private fit = { center: new THREE.Vector3(), size: 1 }
  private autoRotate = false
  private failed = false
  private modelLoads = new LatestAsyncResourceOwner()
  private loadGltf: SceneModelLoader
  private encodePng: PngEncoder = encodeCanvasPng
  private channelView: 'color' | 'metalness' | 'roughness' | 'bump' | null = null

  constructor(opts: SceneControllerOptions) {
    this.container = opts.container
    this.onStatus = opts.onStatus
    this.onMeshFound = opts.onMeshFound
    this.loadGltf = opts.loadGltf ?? ((bytes) => loadGltfBytes(bytes, this.draco))
    this.encodePng = opts.encodePng ?? encodeCanvasPng

    let renderer: THREE.WebGLRenderer
    try {
      // WebGL 创建：逐级降级（抗锯齿+透明 → 基础 → webgl1 上下文），最大化可用性
      renderer = createRendererWithFallback()
    } catch (err) {
      // WebGL 不可用（无 GPU/受限环境）——优雅降级，不崩溃
      this.failed = true
      this.renderer = undefined as never
      this.onStatus?.('error', '当前环境不支持 WebGL，3D 预览不可用（2D 标签编辑仍可用）')
      this.resizeObserver = new ResizeObserver(() => undefined)
      return
    }
    this.failed = false
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer = renderer
    this.container.appendChild(renderer.domElement)

    // 模型材质大量使用 metallic/clearcoat。仅靠直射光时，金属的环境反射为黑，
    // 会让瓶身、标签和盖子丢失颜色与微表面层次。使用本地 RoomEnvironment 生成
    // PMREM，不依赖远程 HDR，同时让白色、琥珀色与高光材质保留微表面层次。
    const roomEnvironment = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(renderer)
    this.environmentTarget = pmrem.fromScene(roomEnvironment, 0.04)
    configureLightStudioRendering(renderer, this.scene, this.environmentTarget.texture)
    roomEnvironment.dispose()
    pmrem.dispose()

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000)
    this.camera.position.set(2.2, 1.7, 2.8)

    this.controls = new OrbitControls(this.camera, renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.autoRotate = false
    this.controls.addEventListener('change', () => this.requestRender())

    this.composer = new EffectComposer(renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.outline = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera)
    this.grid = applyLightStudioPalette(this.scene, this.outline)
    this.scene.add(this.grid)
    this.outline.edgeStrength = 4
    this.outline.edgeGlow = 0
    this.outline.edgeThickness = 1.6
    this.composer.addPass(this.outline)

    this.draco.setDecoderPath('/draco/')

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
    this.resize()
    this.loop()
  }

  get available(): boolean {
    return !this.failed
  }

  private loop = (): void => {
    if (this.disposed || this.failed) return
    this.raf = requestAnimationFrame(this.loop)
    this.controls.update()
    if (this.needsRender) {
      this.needsRender = false
      this.composer.render()
    }
  }

  requestRender(): void {
    if (this.disposed || this.failed) return
    this.needsRender = true
  }

  /** Render a deterministic PNG without depending on toolbar or DOM selectors. */
  async capturePng(width: number, height: number): Promise<Blob> {
    if (this.disposed || this.failed) throw new Error('3D preview is not ready')
    return this.renderPng(width, height)
  }

  private async renderPng(width: number, height: number): Promise<Blob> {
    const size = captureDimensions(width, height)
    const previousSize = this.renderer.getSize(new THREE.Vector2())
    const previousPixelRatio = this.renderer.getPixelRatio()
    const previousAspect = this.camera.aspect
    try {
      this.renderer.setPixelRatio(1)
      this.renderer.setSize(size.width, size.height, false)
      this.composer.setSize(size.width, size.height)
      this.outline.setSize(size.width, size.height)
      this.camera.aspect = size.width / size.height
      this.camera.updateProjectionMatrix()
      this.composer.render()
      return await this.encodePng(this.renderer.domElement)
    } finally {
      this.renderer.setPixelRatio(previousPixelRatio)
      this.renderer.setSize(previousSize.x, previousSize.y, false)
      this.composer.setSize(previousSize.x, previousSize.y)
      this.outline.setSize(previousSize.x, previousSize.y)
      this.camera.aspect = previousAspect
      this.camera.updateProjectionMatrix()
      this.requestRender()
    }
  }

  async captureQcPng(request: QcViewRequest): Promise<{ blob: Blob; camera: QcCameraMetadata }> {
    if (this.disposed || this.failed) throw new Error('3D preview is not ready')
    const target = request.target.kind === 'model'
      ? this.model
      : this.labelMeshes.get(request.target.areaId)
    if (!target) {
      if (request.target.kind === 'area') throw new Error(`QC area is not ready: ${request.target.areaId}`)
      throw new Error('QC model is not ready')
    }
    target.updateWorldMatrix(true, true)

    let frame: QcTargetFrame
    if (request.target.kind === 'area') {
      const mesh = target as THREE.Mesh
      if (!(mesh.geometry instanceof THREE.BufferGeometry)) {
        throw new Error(`QC area has no capture geometry: ${request.target.areaId}`)
      }
      frame = surfaceFrameForGeometry(mesh.geometry, mesh.matrixWorld)
    } else {
      const bounds = new THREE.Box3().setFromObject(target)
      if (bounds.isEmpty()) throw new Error('QC model has no capture geometry')
      frame = {
        center: bounds.getCenter(new THREE.Vector3()),
        size: bounds.getSize(new THREE.Vector3()),
      }
    }

    let direction: THREE.Vector3
    if (request.pose.kind === 'direction') {
      direction = new THREE.Vector3(...request.pose.direction)
    } else {
      if (!frame.normal) throw new Error(`QC pose ${request.pose.kind} requires an area target`)
      direction = frame.normal.clone()
      if (request.pose.kind === 'area-craft') {
        const worldUp = new THREE.Vector3(0, 1, 0)
        const tangentReference = Math.abs(frame.normal.dot(worldUp)) >= 0.98
          ? new THREE.Vector3(0, 0, 1)
          : worldUp
        const tangent = tangentReference.cross(frame.normal).normalize()
        direction.addScaledVector(tangent, 0.35).addScaledVector(worldUp, 0.2).normalize()
      }
    }

    const captureSize = captureDimensions(request.width, request.height)
    const qcCamera = cameraForFrame(frame, direction, {
      fov: this.camera.fov,
      aspect: captureSize.width / captureSize.height,
      margin: 1.15,
    })
    const previous = {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
      up: this.camera.up.clone(),
      fov: this.camera.fov,
      aspect: this.camera.aspect,
      target: this.controls.target.clone(),
      channel: this.channelView,
      outlineSelection: [...this.outline.selectedObjects],
      frontMarker: this.frontMarker
        ? { object: this.frontMarker, visible: this.frontMarker.visible }
        : null,
      areaControl: this.areaControlGroup
        ? { object: this.areaControlGroup, visible: this.areaControlGroup.visible }
        : null,
    }

    try {
      this.outline.selectedObjects = []
      if (this.frontMarker) this.frontMarker.visible = false
      if (this.areaControlGroup) this.areaControlGroup.visible = false
      this.setChannelView(request.channel)
      this.camera.position.copy(qcCamera.position)
      this.camera.up.copy(qcCamera.up)
      this.controls.target.copy(qcCamera.target)
      this.camera.lookAt(qcCamera.target)
      this.camera.updateProjectionMatrix()

      const camera: QcCameraMetadata = {
        position: qcCamera.position.toArray(),
        direction: this.camera.getWorldDirection(new THREE.Vector3()).toArray(),
        target: qcCamera.target.toArray(),
        up: qcCamera.up.toArray(),
        fov: this.camera.fov,
      }
      const blob = await this.renderPng(captureSize.width, captureSize.height)
      return { blob, camera }
    } finally {
      this.camera.position.copy(previous.position)
      this.camera.quaternion.copy(previous.quaternion)
      this.camera.up.copy(previous.up)
      this.camera.fov = previous.fov
      this.camera.aspect = previous.aspect
      this.camera.updateProjectionMatrix()
      this.controls.target.copy(previous.target)
      this.setChannelView(previous.channel)
      this.outline.selectedObjects = previous.outlineSelection
      if (this.frontMarker && this.frontMarker === previous.frontMarker?.object) {
        this.frontMarker.visible = previous.frontMarker.visible
      }
      if (this.areaControlGroup && this.areaControlGroup === previous.areaControl?.object) {
        this.areaControlGroup.visible = previous.areaControl.visible
      }
      this.requestRender()
    }
  }

  private resize(): void {
    if (this.failed) return
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    this.outline.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.requestRender()
  }

  setAutoRotate(on: boolean): void {
    if (this.failed) return
    this.autoRotate = on
    this.controls.autoRotate = on
    this.requestRender()
  }

  /** 加载 GLB 字节；异步资源只有当前、存活的控制器可以接管。 */
  async loadModel(bytes: Uint8Array): Promise<boolean> {
    if (this.failed || this.disposed) return false
    this.clearModel()
    this.onStatus?.('loading')
    return this.modelLoads.run(
      () => this.loadGltf(bytes),
      {
        install: (gltf) => {
          this.model = gltf.scene
          this.modelMeshesByIndex = gltf.meshesByIndex ?? new Map()
          this.scene.add(this.model)
          this.fitCamera(this.model)
          this.onStatus?.('ready')
          // 通知宿主模型已就绪（宿主负责应用贴标区域几何/烘焙）
          this.onMeshFound?.(null as never, '')
          this.requestRender()
        },
        dispose: (gltf) => disposeObjectTree(gltf.scene),
        onError: (err) => this.onStatus?.('error', err instanceof Error ? err.message : String(err)),
      },
    )
  }

  private clearModel(): void {
    if (this.model) {
      this.scene.remove(this.model)
      disposeObjectTree(this.model)
      this.model = null
    }
    this.labelMeshes.clear()
    this.labelSources.clear()
    this.labelTextures.clear()
    this.pendingBakes.clear()
    this.modelMeshesByIndex.clear()
    this.showAreaControl(null)
    this.removeMarker()
    this.setOutlineTargets([])
  }

  /** 用重映射几何创建/更新独立贴标层（uvRemap 输出为唯一数据源）。 */
  applyLabelGeometry(
    remap: RemapOutput,
    nodeName: string,
    mode: 'overlay' | 'replace' = 'replace',
    meshIndex?: number,
    areaId = nodeName,
  ): void {
    if (this.failed) return
    if (!this.model) return
    const existingSource = this.labelSources.get(areaId)
    const source = existingSource?.mesh
      ?? (meshIndex === undefined ? undefined : this.modelMeshesByIndex.get(meshIndex))
      ?? (this.model.getObjectByName(nodeName) as THREE.Mesh | null)
    if (!source || !source.isMesh) return
    const visibleWithoutLabel = existingSource?.visibleWithoutLabel ?? source.visible
    let overlay = this.labelMeshes.get(areaId)
    if (!overlay) {
      overlay = createLabelOverlayMesh(source, remap, mode)
      overlay.name = `__label_overlay__${nodeName}__${areaId}`
      this.labelMeshes.set(areaId, overlay)
    } else {
      const next = new THREE.BufferGeometry()
      const positions = mode === 'overlay' ? offsetOverlayPositions(remap.positions, remap.normals) : remap.positions
      next.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      if (remap.normals) next.setAttribute('normal', new THREE.BufferAttribute(remap.normals, 3))
      next.setAttribute('uv', new THREE.BufferAttribute(remap.uv, 2))
      next.setIndex(new THREE.BufferAttribute(remap.indices, 1))
      overlay.geometry.dispose()
      overlay.geometry = next
    }
    // A replace overlay starts transparent. Keep the original surface visible until the
    // first real bake arrives, otherwise re-importing an already-labelled GLB looks blank.
    source.visible = mode === 'replace' && this.labelTextures.has(areaId) ? false : visibleWithoutLabel
    this.labelSources.set(areaId, { mesh: source, mode, visibleWithoutLabel })
    // 补应用缓存的烘焙
    const pending = this.pendingBakes.get(areaId)
    if (pending) {
      this.applyLabelBake(areaId, pending)
      this.pendingBakes.delete(areaId)
    }
    this.requestRender()
  }

  /** Remove one area's runtime overlay without disturbing any remaining area. */
  removeLabelArea(areaId: string): void {
    if (this.failed) return
    const overlay = this.labelMeshes.get(areaId)
    if (overlay) {
      overlay.parent?.remove(overlay)
      disposeObjectTree(overlay)
      this.labelMeshes.delete(areaId)
    }
    this.labelTextures.delete(areaId)
    this.pendingBakes.delete(areaId)
    const source = this.labelSources.get(areaId)
    if (source) {
      this.labelSources.delete(areaId)
      const retainedReplacement = [...this.labelSources.entries()].some(([retainedId, retained]) => (
        retained.mesh === source.mesh && retained.mode === 'replace' && this.labelTextures.has(retainedId)
      ))
      source.mesh.visible = retainedReplacement ? false : source.visibleWithoutLabel
    }
    if (this.frontMarkerNode === areaId) this.removeMarker()
    if (this.outline?.selectedObjects.includes(overlay as THREE.Object3D)) {
      this.outline.selectedObjects = this.outline.selectedObjects.filter((object) => object !== overlay)
    }
    this.requestRender()
  }

  /** Reconcile store-owned areas with currently installed per-node overlays and pending bakes. */
  reconcileLabelAreas(areaIds: Iterable<string>): void {
    if (this.failed) return
    const retained = new Set(areaIds)
    const installed = new Set([
      ...this.labelMeshes.keys(),
      ...this.labelSources.keys(),
      ...this.labelTextures.keys(),
      ...this.pendingBakes.keys(),
    ])
    for (const areaId of installed) {
      if (!retained.has(areaId)) this.removeLabelArea(areaId)
    }
  }

  /** 热更新标签纹理（同一 texture 对象换源，避免程序重编译）。mesh 未就绪时缓存。 */
  applyLabelBake(areaId: string, bake: { color: HTMLCanvasElement; metalness: HTMLCanvasElement; roughness: HTMLCanvasElement; bump: HTMLCanvasElement } | null): void {
    if (this.failed) return
    const mesh = this.labelMeshes.get(areaId)
    if (!mesh) {
      if (bake) this.pendingBakes.set(areaId, bake)
      return
    }
    if (!bake) return
    let texs = this.labelTextures.get(areaId)
    if (texs && !labelTextureSizeMatches(texs, bake)) {
      texs.color.dispose()
      texs.metal.dispose()
      texs.rough.dispose()
      texs.bump.dispose()
      this.labelTextures.delete(areaId)
      texs = undefined
    }
    if (!texs) {
      const color = new THREE.CanvasTexture(bake.color)
      const metal = new THREE.CanvasTexture(bake.metalness)
      const rough = new THREE.CanvasTexture(bake.roughness)
      const bump = new THREE.CanvasTexture(bake.bump)
      configureLabelCanvasTexture(color, true)
      configureLabelCanvasTexture(metal, false)
      configureLabelCanvasTexture(rough, false)
      configureLabelCanvasTexture(bump, false)
      texs = { color, metal, rough, bump, width: bake.color.width, height: bake.color.height }
      this.labelTextures.set(areaId, texs)
      const mat = mesh.material as THREE.MeshStandardMaterial
      // 贴标区域闭合带：完整接管颜色/PBR/微表面，并强制不透明避免透过。
      configureLabelMaterial(mat, { color, metal, rough, bump })
      mat.opacity = 1
    }
    const source = this.labelSources.get(areaId)
    if (source?.mode === 'replace') source.mesh.visible = false
    texs.color.image = bake.color
    texs.color.needsUpdate = true
    texs.metal.image = bake.metalness
    texs.metal.needsUpdate = true
    texs.rough.image = bake.roughness
    texs.rough.needsUpdate = true
    texs.bump.image = bake.bump
    texs.bump.needsUpdate = true
    this.requestRender()
  }

  /** 通道视图：切换激活区域材质的贴图显示。 */
  setChannelView(view: 'color' | 'metalness' | 'roughness' | 'bump' | null): void {
    if (this.failed) return
    this.channelView = view
    applyChannelViewToLabels(this.labelMeshes, this.labelTextures, view)
    this.requestRender()
  }

  /** 正面标记（画布 u=0.5 对应的 3D 位置）。 */
  setFrontMarker(areaId: string, remap: RemapParams, remapOutput: RemapOutput): void {
    if (this.failed) return
    const mesh = this.labelMeshes.get(areaId)
    if (this.frontMarker && this.frontMarkerNode !== areaId) this.removeMarker()
    if (!mesh) return
    const { u0, u1 } = basisForAxis(remap.axis)
    const ang = remapOutput.frontAngle
    const cx = Math.cos(ang)
    const sy = Math.sin(ang)
    const dir = new THREE.Vector3(u0[0] * cx + u1[0] * sy, u0[1] * cx + u1[1] * sy, u0[2] * cx + u1[2] * sy)
    // 标签中心高度：沿轴投影中心
    const origin = new THREE.Vector3(remap.origin[0], remap.origin[1], remap.origin[2])
    const pos = origin.clone().addScaledVector(dir, remap.radius * 1.12)
    const cone = new THREE.Mesh(new THREE.ConeGeometry(remap.radius * 0.045, remap.radius * 0.12, 12), new THREE.MeshBasicMaterial({ color: LIGHT_STUDIO.outline }))
    cone.position.copy(pos)
    cone.lookAt(pos.clone().addScaledVector(dir, 1))
    cone.name = '__front_marker'
    this.scene.add(cone)
    this.frontMarker = cone
    this.frontMarkerNode = areaId
    this.requestRender()
  }

  /** 正式 3D 检视不显示编辑辅助标记。 */
  hideFrontMarker(): void {
    this.removeMarker()
    this.requestRender()
  }

  /** 高亮激活区域所在网格。 */
  setActiveAreaHighlight(areaId: string | null): void {
    if (this.failed) return
    const targets: THREE.Object3D[] = []
    if (areaId) {
      const mesh = this.labelMeshes.get(areaId)
      if (mesh) targets.push(mesh)
    }
    this.setOutlineTargets(targets)
  }

  /** Highlight/focus a raw model mesh without relying on its sanitized Three.js name. */
  setSelectedMesh(meshIndex: number, focus = true): void {
    if (this.failed) return
    const mesh = this.modelMeshesByIndex.get(meshIndex)
    if (!mesh) return
    this.setOutlineTargets([mesh])
    if (focus) this.fitCamera(mesh)
  }

  /** 显示/更新 3D 区域控制框（线框 + 8 个控制点）。幂等：首次创建，后续只更新几何。 */
  showAreaControl(data: { remap: RemapParams; range: LabelAreaRange; axisMin: number; axisMax: number } | null): void {
    if (this.failed) return
    if (!data) {
      if (this.areaControlGroup) {
        this.scene.remove(this.areaControlGroup)
        for (const c of this.areaControlGroup.children) {
          const m = c as THREE.Mesh
          if (m.geometry) m.geometry.dispose()
          const mat = m.material as THREE.Material | THREE.Material[] | undefined
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
          else if (mat) mat.dispose()
        }
        this.areaControlGroup = null
        this.areaControlPoints = []
        this.areaControlLines = null
        this.areaControlData = null
      }
      this.requestRender()
      return
    }
    this.areaControlData = data
    if (!this.areaControlGroup) {
      const group = new THREE.Group()
      this.scene.add(group)
      this.areaControlGroup = group
      // 线框（首次创建）
      const lineMat = new THREE.LineBasicMaterial({ color: LIGHT_STUDIO.outline, linewidth: 2 })
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat)
      lines.renderOrder = 10
      group.add(lines)
      this.areaControlLines = lines
      // 控制点（首次创建）
      this.areaControlPoints = []
      for (const cp of areaControlPoints(data.range)) {
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 10), new THREE.MeshBasicMaterial({ color: LIGHT_STUDIO.outline }))
        sphere.userData.areaControlKey = cp.key
        sphere.renderOrder = 11
        group.add(sphere)
        this.areaControlPoints.push(sphere)
      }
    }
    this.updateAreaControlGeometry(data)
  }

  /** 增量更新控制框几何（拖拽中高频调用，不重建对象）。 */
  updateAreaControlGeometry(data: { remap: RemapParams; range: LabelAreaRange; axisMin: number; axisMax: number }): void {
    if (this.failed || !this.areaControlGroup) return
    this.areaControlData = data
    // 更新线框顶点
    const { top, bottom, left, right } = areaBoxPoints(data.remap, data.range, data.axisMin, data.axisMax, 24)
    const pts: number[] = []
    const pushLine = (arr: [number, number, number][]): void => {
      for (let i = 0; i < arr.length - 1; i++) {
        pts.push(arr[i][0], arr[i][1], arr[i][2], arr[i + 1][0], arr[i + 1][1], arr[i + 1][2])
      }
    }
    pushLine(top)
    pushLine(bottom)
    pushLine(left)
    pushLine(right)
    if (this.areaControlLines) {
      const attr = this.areaControlLines.geometry.getAttribute('position')
      if (!attr || attr.count !== pts.length / 3) {
        this.areaControlLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      } else {
        for (let i = 0; i < pts.length; i++) attr.array[i] = pts[i]
        attr.needsUpdate = true
      }
      this.areaControlLines.geometry.computeBoundingSphere()
    }
    // 更新控制点位置
    const cps = areaControlPoints(data.range)
    for (let i = 0; i < this.areaControlPoints.length && i < cps.length; i++) {
      const pos = uvToSurface(cps[i].u, cps[i].v, data.remap, data.axisMin, data.axisMax)
      this.areaControlPoints[i].position.set(pos[0], pos[1], pos[2])
    }
    this.requestRender()
  }

  /** 屏幕坐标 → 命中的控制点 key（ndcX/ndcY ∈ [-1,1]）。 */
  pickAreaControl(ndcX: number, ndcY: number): string | null {
    if (this.failed || this.areaControlPoints.length === 0) return null
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    this.raycaster.params.Points = { threshold: 2 }
    const hits = this.raycaster.intersectObjects(this.areaControlPoints, false)
    if (hits.length > 0) return hits[0].object.userData.areaControlKey as string
    return null
  }

  /** 屏幕坐标 → 标签网格表面的 (u, v)（区域拖拽用）。 */
  pickSurfaceUV(ndcX: number, ndcY: number, nodeName: string): UV | null {
    if (this.failed) return null
    const mesh = this.labelMeshes.get(nodeName)
    const data = this.areaControlData
    if (!mesh || !data) return null
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObject(mesh, false)
    if (hits.length === 0) return null
    const p = hits[0].point
    return surfaceToUV([p.x, p.y, p.z], data.remap, data.axisMin, data.axisMax)
  }

  private removeMarker(): void {
    const m = this.frontMarker
    if (m) {
      this.scene.remove(m)
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
      this.frontMarker = null
    }
  }

  setOutlineTargets(objects: THREE.Object3D[]): void {
    if (this.failed) return
    this.outline.selectedObjects = objects
    this.requestRender()
  }

  setHidden(names: Set<string>): void {
    if (this.failed) return
    if (!this.model) return
    this.model.traverse((o) => {
      o.visible = !names.has(o.name)
    })
    for (const [areaId, source] of this.labelSources) {
      source.visibleWithoutLabel = !names.has(source.mesh.name)
      const hiddenByReplacement = [...this.labelSources.entries()].some(([candidateId, candidate]) => (
        candidate.mesh === source.mesh && candidate.mode === 'replace' && this.labelTextures.has(candidateId)
      ))
      source.mesh.visible = hiddenByReplacement ? false : source.visibleWithoutLabel
      const overlay = this.labelMeshes.get(areaId)
      if (overlay) overlay.visible = source.visibleWithoutLabel
    }
    this.requestRender()
  }

  private fitCamera(root: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(root)
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 0.001)
    const dist = maxDim * 2.4
    this.camera.position.set(center.x + dist * 0.75, center.y + dist * 0.55, center.z + dist)
    this.controls.target.copy(center)
    this.controls.minDistance = maxDim * 0.08
    this.controls.maxDistance = maxDim * 12
    this.controls.update()
    this.grid.position.set(center.x, center.y - size.y / 2 - maxDim * 0.005, center.z)
    this.grid.scale.setScalar(maxDim)
    this.fit = { center, size: maxDim }
  }

  dispose(): void {
    this.disposed = true
    this.modelLoads.dispose()
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    if (this.failed) return
    this.controls.dispose()
    this.clearModel()
    this.scene.environment = null
    this.environmentTarget?.dispose()
    this.environmentTarget = null
    this.renderer.dispose()
    this.draco.dispose()
    if (this.renderer.domElement.parentNode === this.container) this.container.removeChild(this.renderer.domElement)
  }
}
