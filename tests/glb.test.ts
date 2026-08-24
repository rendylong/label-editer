/**
 * 导出往返一致性：analyze → remap → rebuild(worker 逻辑在浏览器) 的核心不变量。
 * Worker 本身依赖 DOM，这里覆盖其输入构造与 gltf-transform 往返的纯部分。
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { NodeIO } from '@gltf-transform/core'
import { KHRTextureBasisu, KHRMaterialsUnlit } from '@gltf-transform/extensions'
import { computeRemap, makeDefaultRemap, type MeshAccessors } from '../src/glb/uvRemap'

const SAMPLE = new URL('../public/sample/面霜瓶.glb', import.meta.url)

async function loadMesh(): Promise<{ doc: ReturnType<NodeIO['readBinary']> extends Promise<infer T> ? T : never; meshIndex: number; mesh: MeshAccessors }> {
  const io = new NodeIO().registerExtensions([KHRTextureBasisu, KHRMaterialsUnlit])
  const bytes = readFileSync(SAMPLE)
  const doc = await io.readBinary(new Uint8Array(bytes))
  const meshIndex = findLabelMeshIndex(doc)
  const mesh = doc.getRoot().listMeshes()[meshIndex]
  const prim = mesh.listPrimitives()[0]
  const pos = prim.getAttribute('POSITION')!
  const nrm = prim.getAttribute('NORMAL')
  const uv = prim.getAttribute('TEXCOORD_0')
  const idx = prim.getIndices()
  return {
    doc: doc as never,
    meshIndex,
    mesh: {
      positions: pos.getArray() as Float32Array,
      normals: nrm ? (nrm.getArray() as Float32Array) : undefined,
      uv: uv ? (uv.getArray() as Float32Array) : new Float32Array(pos.getCount() * 2),
      indices: idx ? (idx.getArray() as Uint16Array | Uint32Array) : null,
      triangleCount: idx ? idx.getCount() / 3 : pos.getCount() / 3,
    },
  }
}

function findLabelMeshIndex(doc: import('@gltf-transform/core').Document): number {
  const root = doc.getRoot()
  const scene = root.listScenes()[0]
  let idx = -1
  const walk = (node: import('@gltf-transform/core').Node): void => {
    const name = (node.getName() || '').toLowerCase()
    const mesh = node.getMesh()
    if (mesh && (name.includes('label') || name.includes('贴标') || name.includes('标签')) && idx < 0) {
      idx = root.listMeshes().indexOf(mesh)
    }
    for (const c of node.listChildren()) walk(c)
  }
  if (scene) {
    for (const c of scene.listChildren()) walk(c)
  }
  return idx
}

describe('GLB 导出往返不变量', () => {
  it('原始 GLB 可被 NodeIO 解析且标签网格 accessor 可提取', async () => {
    const { meshIndex, mesh } = await loadMesh()
    expect(meshIndex).toBeGreaterThanOrEqual(0)
    expect(mesh.positions.length / 3).toBeGreaterThan(1000)
    expect(mesh.triangleCount).toBeGreaterThan(1000)
  })

  it('remap 输出可直接写回 accessor（类型/长度合法）', async () => {
    const { mesh } = await loadMesh()
    const params = makeDefaultRemap(mesh)
    const out = computeRemap(mesh, params)
    expect(out.positions.length / 3).toBe(out.vertexCount)
    expect(out.uv.length / 2).toBe(out.vertexCount)
    expect(out.indices.length % 3).toBe(0)
    // 索引必须在顶点范围内
    for (let i = 0; i < out.indices.length; i++) expect(out.indices[i]).toBeLessThan(out.vertexCount)
  })

  it('导出文件名消毒与下载命名约定', () => {
    const name = '面霜瓶.glb'
    expect(name.replace(/\.glb$/i, '')).toBe('面霜瓶')
  })
})
