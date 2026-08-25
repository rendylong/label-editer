/**
 * 导出 Worker：@gltf-transform 重打包（多区域：换纹理 + 覆盖 UV + BLEND→OPAQUE）。
 * 在主线程之外执行，避免 6MB 模型 + PNG 编码阻塞 UI。
 */

import { NodeIO, VertexLayout } from '@gltf-transform/core'
import { applyLabelJobToDocument, embedEditableProjectMetadata, type AreaJob } from './rebuildCore'
import { registerSupportedGltfExtensions } from './gltfExtensions'
export type { AreaJob } from './rebuildCore'

export interface RebuildRequest {
  kind: 'rebuild'
  requestId: number
  glb: ArrayBuffer
  areas: AreaJob[]
  editableProject?: unknown
}

export interface RebuildResponse {
  kind: 'rebuild-result'
  requestId: number
  ok: boolean
  glb?: ArrayBuffer
  /** 与 areas 同序；指向写出 GLB 中应由主线程交叉校验的稳定 mesh 索引。 */
  targetMeshIndices?: number[]
  error?: string
}

async function makeIO(): Promise<NodeIO> {
  // 注：v1 不注册 draco3d（npm 包依赖 node:fs，浏览器不可用——M1 spike 结论）。
  // Draco 压缩模型的标签导出 → 主线程兜底"仅导出 PNG"；预览由 three 本地 decoder 支持。
  // vertexLayout 强制 non-interleaved：three GLTFLoader 对 writer 默认的 interleaved
  // 顶点布局读取错位（实测），连续布局可被 three/标准查看器正确读取。
  return registerSupportedGltfExtensions(new NodeIO()).setVertexLayout(VertexLayout.SEPARATE)
}

function applyJobs(doc: import('@gltf-transform/core').Document, jobs: AreaJob[]): number[] {
  const root = doc.getRoot()
  const targetMeshIndices = jobs.map((job) => applyLabelJobToDocument(doc, job))
  // 合并多余 buffer（浏览器端 readBinary 可能延迟创建原 buffer）
  const all = root.listBuffers()
  if (all.length > 1) {
    const target = doc.createBuffer().setURI('merged.bin')
    for (const a of root.listAccessors()) a.setBuffer(target)
    for (const b of all) b.dispose()
  }
  return targetMeshIndices
}

self.onmessage = async (ev: MessageEvent<RebuildRequest>) => {
  const req = ev.data
  console.log('[rebuild-worker] v5 start, areas=', req.areas.length)
  try {
    if (req.kind !== 'rebuild') return
    const io = await makeIO()
    const doc = await io.readBinary(new Uint8Array(req.glb))

    const targetMeshIndices = applyJobs(doc, req.areas)
    if (req.editableProject !== undefined) embedEditableProjectMetadata(doc, req.editableProject)

    // 4) 写出。
    // 注：浏览器端第一次 writeBinary 会物化/延迟创建 buffer，二次写出同一 doc 会触发
    // "GLB must have 0–1 buffers"（Node 端不物化故测试通过）。确定性由主线程交叉自检
    // （独立实现 three GLTFLoader 重解析 + UV 采样比对）保证，不再二次写出。
    const out1 = await io.writeBinary(doc)

    const resp: RebuildResponse = {
      kind: 'rebuild-result',
      requestId: req.requestId,
      ok: true,
      glb: out1.buffer as ArrayBuffer,
      targetMeshIndices,
    }
    ;(self as unknown as Worker).postMessage(resp, { transfer: [out1.buffer as ArrayBuffer] })
  } catch (err) {
    const resp: RebuildResponse = { kind: 'rebuild-result', requestId: req.requestId, ok: false, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as Worker).postMessage(resp)
  }
}
