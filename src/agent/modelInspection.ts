import type { Document, Node as GltfNode } from '@gltf-transform/core'
import { buildPartTree, extractMeshAccessors, readGlb } from '../glb/analyze'
import { detectLabelMode } from '../glb/uvRemap'
import type { MeshInspection, ModelInspection } from './contracts'

export function stableMeshSelector(meshIndex: number, nodeIndex: number): string {
  return `mesh:${meshIndex}/node:${nodeIndex}`
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: Uint8Array): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)))
}

function transformPoint(matrix: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ]
}

function modelDimensions(doc: Document): { width: number; height: number; depth: number } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const node of doc.getRoot().listNodes()) {
    const position = node.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')?.getArray()
    if (!position) continue
    const matrix = node.getWorldMatrix()
    for (let index = 0; index < position.length; index += 3) {
      const point = transformPoint(matrix, Number(position[index]), Number(position[index + 1]), Number(position[index + 2]))
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis])
        max[axis] = Math.max(max[axis], point[axis])
      }
    }
  }
  if (!Number.isFinite(min[0])) return { width: 0, height: 0, depth: 0 }
  return { width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] }
}

function materialNames(node: GltfNode): string[] {
  const names = node.getMesh()?.listPrimitives()
    .map((primitive) => primitive.getMaterial()?.getName() ?? '')
    .filter(Boolean) ?? []
  return [...new Set(names)]
}

function isSemanticLabel(node: GltfNode, materials: string[]): boolean {
  const semantic = `${node.getName()} ${materials.join(' ')}`.toLowerCase()
  return /label|贴标|标签|sticker|decal|wall[_\s-]?paper/.test(semantic)
}

function inspectMeshes(doc: Document): MeshInspection[] {
  const root = doc.getRoot()
  return root.listNodes().flatMap((node, nodeIndex): MeshInspection[] => {
    const mesh = node.getMesh()
    if (!mesh) return []
    const meshIndex = root.listMeshes().indexOf(mesh)
    const materials = materialNames(node)
    const accessors = extractMeshAccessors(doc, meshIndex)
    const warnings: string[] = []
    if (!accessors.normals) warnings.push('Mesh has no NORMAL accessor')
    if (accessors.triangleCount < 2) warnings.push('Mesh has very little surface geometry')
    return [{
      stableSelector: stableMeshSelector(meshIndex, nodeIndex),
      meshIndex,
      nodeIndex,
      nodeName: node.getName() || `node-${nodeIndex}`,
      materialNames: materials,
      mappingMode: detectLabelMode(accessors),
      labelCandidate: isSemanticLabel(node, materials) || materials.length > 0,
      warnings,
    }]
  })
}

export async function inspectModel(bytes: Uint8Array, name: string): Promise<ModelInspection> {
  const doc = await readGlb(bytes)
  const partTree = buildPartTree(doc).parts
  const extensions = doc.getRoot().listExtensionsUsed().map((extension) => extension.extensionName)
  const sourceCompressed = extensions.includes('KHR_draco_mesh_compression')
  return {
    name,
    fingerprint: await sha256(bytes),
    dimensions: modelDimensions(doc),
    meshes: inspectMeshes(doc),
    partTree,
    codec: { sourceCompressed, normalized: false, outputCompressed: sourceCompressed, extensions },
    warnings: [],
  }
}
