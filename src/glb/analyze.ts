/**
 * GLB 分析：部件树、标签候选、原始 accessor 提取（uvRemap 的唯一数据源）。
 * 基于 @gltf-transform/core（浏览器可用，fs/path 被 shim 为空）。
 */

import { NodeIO } from '@gltf-transform/core'
import type { Document, Node as GtNode, Mesh, Primitive, Material } from '@gltf-transform/core'
import type { GlbAnalysis, PartNode } from '../label/types'
import type { MeshAccessors } from './uvRemap'
import { registerSupportedGltfExtensions } from './gltfExtensions'

let ioPromise: Promise<NodeIO> | null = null

/** Display-only repair for a common Blender UTF-8 replacement sequence. Raw identity stays unchanged. */
export function displayPartName(name: string): string {
  return name.replace(/B�+zier/g, 'Bézier')
}

/** 创建 NodeIO（使用与导出 Worker 共享的无外部编解码依赖扩展集）。 */
export function getIO(): Promise<NodeIO> {
  if (ioPromise) return ioPromise
  ioPromise = (async () => {
    return registerSupportedGltfExtensions(new NodeIO())
  })()
  return ioPromise
}

/** 读取 GLB 字节 → Document。 */
export async function readGlb(bytes: Uint8Array): Promise<Document> {
  const io = await getIO()
  return io.readBinary(bytes)
}

/** 遍历场景图 → 部件树。 */
export function buildPartTree(doc: Document): GlbAnalysis {
  const root = doc.getRoot()
  const scene = root.listScenes()[0]
  if (!scene) throw new Error('GLB 无场景')
  const meshToNode: Record<number, string> = {}
  const labelCandidates: string[] = []
  let uid = 0

  const walk = (gtNode: GtNode, visible: boolean): PartNode => {
    const id = `n${uid++}`
    const mesh = gtNode.getMesh()
    let kind: PartNode['kind'] = 'group'
    let materialName: string | undefined
    let meshIndex: number | undefined
    let triangleCount: number | undefined
    let hasTexture = false
    if (mesh) {
      kind = 'mesh'
      meshIndex = meshIndexOf(root, mesh)
      meshToNode[meshIndex] = id
      const prim = mesh.listPrimitives()[0]
      const mat = prim?.getMaterial()
      materialName = mat?.getName() || undefined
      const idx = prim?.getIndices()
      triangleCount = idx ? idx.getCount() / 3 : Math.floor((prim?.getAttribute('POSITION')?.getCount() ?? 0) / 3)
      hasTexture = mat?.getBaseColorTexture() !== null && mat?.getBaseColorTexture() !== undefined
      // 标签候选：优先使用节点/材质的标签语义；DCC 与素材库常把独立纸标材质命名为
      // Wall_paper / sticker / decal，而节点仍是无语义的 Object_3。
      const name = (gtNode.getName() || '').toLowerCase()
      const matName = (materialName || '').toLowerCase()
      const semantic = `${name} ${matName}`
      if (/label|贴标|标签|sticker|decal|wall[_\s-]?paper/.test(semantic)) {
        kind = 'label'
        labelCandidates.push(id)
      } else if (hasTexture && mesh.listParents().length > 0) {
        // 含纹理的叶子网格也可作候选（后置）
        labelCandidates.push(id)
      }
    }
    const children = gtNode.listChildren().map((c) => walk(c, visible))
    const name = gtNode.getName() || `节点${meshIndex !== undefined ? meshIndex : ''}` || '未命名'
    return { id, name, kind, children, material: materialName, meshIndex, visible, triangleCount }
  }

  const parts = scene.listChildren().map((c) => walk(c, true))
  // 候选优先级：名字命中（label/贴标/标签）优先，含纹理的叶子网格其次；
  // 过滤掉「非标签名 + 有子节点」的组，避免把瓶身本体当候选。
  const prioritized: { id: string; pri: number }[] = []
  for (const id of labelCandidates) {
    const node = findPart(parts, id)
    if (!node) continue
    if (node.kind === 'label') prioritized.push({ id, pri: 0 })
    else if (node.children.length === 0) prioritized.push({ id, pri: 1 })
  }
  prioritized.sort((a, b) => a.pri - b.pri)
  const candidates = prioritized.map((p) => p.id)
  const modelName = parts[0]?.name || 'model'
  return { parts, meshToNode, labelCandidates: candidates, modelName }
}

function meshIndexOf(root: ReturnType<Document['getRoot']>, mesh: Mesh): number {
  return root.listMeshes().indexOf(mesh)
}

export function findPart(parts: PartNode[], id: string): PartNode | null {
  for (const p of parts) {
    if (p.id === id) return p
    if (p.children.length) {
      const f = findPart(p.children, id)
      if (f) return f
    }
  }
  return null
}

/** 提取 mesh 的原始 accessor（POSITION/NORMAL/TEXCOORD_0/索引）。 */
export function extractMeshAccessors(doc: Document, meshIndex: number): MeshAccessors {
  const root = doc.getRoot()
  const mesh = root.listMeshes()[meshIndex]
  if (!mesh) throw new Error(`mesh[${meshIndex}] 不存在`)
  const prim: Primitive = mesh.listPrimitives()[0]
  const pos = prim.getAttribute('POSITION')
  if (!pos) throw new Error(`mesh[${meshIndex}] 无 POSITION`)
  const nrm = prim.getAttribute('NORMAL')
  const uv = prim.getAttribute('TEXCOORD_0')
  const idx = prim.getIndices()
  return {
    positions: pos.getArray() as Float32Array,
    normals: nrm ? (nrm.getArray() as Float32Array) : undefined,
    uv: uv ? (uv.getArray() as Float32Array) : new Float32Array(pos.getCount() * 2),
    indices: idx ? (idx.getArray() as Uint16Array | Uint32Array) : null,
    triangleCount: idx ? idx.getCount() / 3 : pos.getCount() / 3,
  }
}

/** 目标 mesh 所在节点的世界变换是否包含镜像（3×3 行列式 < 0）。 */
export function isMeshWorldMirrored(doc: Document, meshIndex: number): boolean {
  const root = doc.getRoot()
  const mesh = root.listMeshes()[meshIndex]
  if (!mesh) throw new Error(`mesh[${meshIndex}] 不存在`)
  const node = root.listNodes().find((candidate) => candidate.getMesh() === mesh)
  if (!node) return false
  const m = node.getWorldMatrix()
  const determinant =
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  return determinant < 0
}

/** Convert the editor camera-facing world +Z direction into the target mesh local space. */
export function meshLocalFrontDirection(
  doc: Document,
  meshIndex: number,
  worldDirection: [number, number, number] = [0, 0, 1],
): [number, number, number] {
  const root = doc.getRoot()
  const mesh = root.listMeshes()[meshIndex]
  const node = mesh ? root.listNodes().find((candidate) => candidate.getMesh() === mesh) : undefined
  if (!node) return worldDirection
  const m = node.getWorldMatrix()
  const a = m[0], b = m[4], c = m[8]
  const d = m[1], e = m[5], f = m[9]
  const g = m[2], h = m[6], i = m[10]
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(determinant) < 1e-12) return worldDirection
  const inverseDeterminant = 1 / determinant
  const [x, y, z] = worldDirection
  const local: [number, number, number] = [
    ((e * i - f * h) * x + (c * h - b * i) * y + (b * f - c * e) * z) * inverseDeterminant,
    ((f * g - d * i) * x + (a * i - c * g) * y + (c * d - a * f) * z) * inverseDeterminant,
    ((d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d) * z) * inverseDeterminant,
  ]
  const length = Math.hypot(local[0], local[1], local[2])
  if (length < 1e-12) return worldDirection
  return [local[0] / length, local[1] / length, local[2] / length]
}

/** 提取 mesh 材质 baseColorTexture 图像（供参考层显示）。 */
export function extractBaseColorImage(doc: Document, meshIndex: number): { data: Uint8Array; mime: string; url: string } | null {
  const root = doc.getRoot()
  const mesh = root.listMeshes()[meshIndex]
  if (!mesh) return null
  const mat: Material | null = mesh.listPrimitives()[0]?.getMaterial() ?? null
  const tex = mat?.getBaseColorTexture()
  if (!tex) return null
  const data = tex.getImage()
  if (!data) return null
  const mime = tex.getMimeType() || 'image/png'
  const blob = new Blob([data as BlobPart], { type: mime })
  return { data, mime, url: URL.createObjectURL(blob) }
}

/** 解码图像字节 → HTMLImageElement/ImageBitmap。 */
export async function decodeImage(data: Uint8Array, mime: string): Promise<HTMLImageElement> {
  const blob = new Blob([data as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('图片解码失败'))
    })
    return img
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
