/** GLB 重建的纯核心：可在 Worker 与 Node 测试中复用。 */

import type { Document, Material, Primitive } from '@gltf-transform/core'
import { configureTransparentLabelExport } from './textures'
import { offsetOverlayPositions } from './overlayGeometry'

export interface AreaJob {
  /** Stable editor area identity; required for multiple overlays on one source mesh. */
  areaId?: string
  meshIndex: number
  nodeName: string
  surfaceMode: 'overlay' | 'replace'
  /** 全圈全高时用 REPEAT（环绕连续）；部分范围用 CLAMP。 */
  fullRange: boolean
  remap: {
    positions: Float32Array
    normals?: Float32Array
    uv: Float32Array
    indices: Uint32Array
  }
  colorPng: ArrayBuffer
  metalRoughPng?: ArrayBuffer
  normalPng?: ArrayBuffer
}

function createRemappedPrimitive(doc: Document, job: AreaJob, material: Material): Primitive {
  const root = doc.getRoot()
  const existingBuffers = root.listBuffers()
  const buffer = existingBuffers.length > 0 ? existingBuffers[0] : doc.createBuffer()
  const positions = job.surfaceMode === 'overlay' ? offsetOverlayPositions(job.remap.positions, job.remap.normals) : job.remap.positions
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions as never).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(job.remap.uv as never).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(job.remap.indices as never).setBuffer(buffer))
    .setMaterial(material)
  if (job.remap.normals) {
    primitive.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(job.remap.normals as never).setBuffer(buffer))
  }
  return primitive
}

function applyTextures(doc: Document, material: Material, job: AreaJob): void {
  const wrap = job.fullRange ? 10497 : 33071
  const setTexture = (
    name: string,
    png: ArrayBuffer | undefined,
    setSlot: (texture: ReturnType<Document['createTexture']>) => void,
    getInfo: () => {
      setWrapS(value: number): { setWrapT(next: number): unknown }
      setWrapT(value: number): unknown
    } | null | undefined,
  ): void => {
    if (!png) return
    const texture = doc.createTexture(name).setImage(new Uint8Array(png)).setMimeType('image/png')
    setSlot(texture)
    getInfo()?.setWrapS(wrap).setWrapT(wrap)
  }
  const suffix = job.areaId ? `_${job.areaId}` : ''
  setTexture(`label_color${suffix}`, job.colorPng, (texture) => material.setBaseColorTexture(texture), () => material.getBaseColorTextureInfo())
  setTexture(`label_metalrough${suffix}`, job.metalRoughPng, (texture) => material.setMetallicRoughnessTexture(texture), () => material.getMetallicRoughnessTextureInfo())
  setTexture(`label_normal${suffix}`, job.normalPng, (texture) => material.setNormalTexture(texture), () => material.getNormalTextureInfo())
  material
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(job.metalRoughPng ? 1 : 0)
    .setRoughnessFactor(1)
  configureTransparentLabelExport(material)
}

/**
 * 应用一个贴标任务。
 * overlay 会复制节点变换并新增网格；原瓶身 primitive/material 保持原样。
 * replace 仅用于原本就是独立标签面的网格，兼容旧模型。
 */
export function applyLabelJobToDocument(doc: Document, job: AreaJob): number {
  const root = doc.getRoot()
  const sourceMesh = root.listMeshes()[job.meshIndex]
  if (!sourceMesh) throw new Error(`mesh[${job.meshIndex}] 不存在`)
  const sourcePrimitive = sourceMesh.listPrimitives()[0]
  if (!sourcePrimitive) throw new Error(`mesh[${job.meshIndex}] 无 primitive`)

  if (job.surfaceMode === 'replace') {
    const material = sourcePrimitive.getMaterial()
    if (!material) throw new Error('标签材质缺失')
    const replacement = createRemappedPrimitive(doc, job, material)
    sourceMesh.listPrimitives().forEach((primitive) => sourceMesh.removePrimitive(primitive))
    sourceMesh.addPrimitive(replacement)
    applyTextures(doc, material, job)
    return job.meshIndex
  }

  const identity = job.areaId ? ` ${job.areaId}` : ''
  const material = doc.createMaterial(`${job.nodeName} Label Overlay${identity}`)
  const overlayPrimitive = createRemappedPrimitive(doc, job, material)
  const overlayMesh = doc.createMesh(`${job.nodeName} Label Overlay${identity}`).addPrimitive(overlayPrimitive)
  applyTextures(doc, material, job)

  const sourceNodes = root.listNodes().filter((node) => node.getMesh() === sourceMesh)
  if (sourceNodes.length === 0) throw new Error(`mesh[${job.meshIndex}] 未被场景节点引用`)
  for (const sourceNode of sourceNodes) {
    const overlayNode = doc
      .createNode(`${sourceNode.getName() || job.nodeName}__label_overlay${job.areaId ? `__${job.areaId}` : ''}`)
      .setMesh(overlayMesh)
      .setMatrix(sourceNode.getMatrix())
    const parents = sourceNode.listParents()
    const parent = parents.find((candidate) => typeof (candidate as unknown as { addChild?: unknown }).addChild === 'function') as
      | { addChild(node: typeof overlayNode): unknown }
      | undefined
    if (!parent) throw new Error(`节点「${sourceNode.getName() || job.nodeName}」缺少场景父级`)
    parent.addChild(overlayNode)
  }
  const overlayMeshIndex = root.listMeshes().indexOf(overlayMesh)
  if (overlayMeshIndex < 0) throw new Error(`区域「${job.nodeName}」的叠加网格未进入导出文档`)
  return overlayMeshIndex
}

export const EDITABLE_PROJECT_EXTRAS_KEY = 'glbLabelEditorProject'

/** Embed the complete editable .lbl payload into GLB asset extras for one-file round trips. */
export function embedEditableProjectMetadata(doc: Document, project: unknown): void {
  doc.getRoot().setExtras({ ...doc.getRoot().getExtras(), [EDITABLE_PROJECT_EXTRAS_KEY]: project })
}

/** Read editable project metadata without trusting or normalizing it at this low-level boundary. */
export function readEditableProjectMetadata(doc: Document): unknown {
  return doc.getRoot().getExtras()[EDITABLE_PROJECT_EXTRAS_KEY]
}
