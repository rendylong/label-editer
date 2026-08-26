/**
 * 导出主线程封装：纹理编码 → Worker 重打包（多区域）→ 交叉实现自检（three GLTFLoader 独立解析）。
 */

import type { RemapOutput } from './uvRemap'
import type { RebuildRequest, RebuildResponse, AreaJob } from './rebuild.worker'

let worker: Worker | null = null
let nextRequestId = 1
const DEFAULT_WORKER_TIMEOUT_MS = 120_000
const workerAborters = new Map<Worker, Set<(error: Error) => void>>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./rebuild.worker.ts', import.meta.url), { type: 'module' })
  }
  return worker
}

function resetWorker(target: Worker, error: Error): void {
  const registeredAborters = workerAborters.get(target)
  if (worker !== target && !registeredAborters) return
  if (worker === target) worker = null
  target.terminate()
  const aborters = [...(registeredAborters ?? [])]
  workerAborters.delete(target)
  aborters.forEach((abort) => abort(error))
}

export interface ExportAreaInput {
  areaId?: string
  meshIndex: number
  nodeName: string
  surfaceMode: 'overlay' | 'replace'
  fullRange: boolean
  remap: RemapOutput
  colorPng: Uint8Array
  metalRoughPng?: Uint8Array
  normalPng?: Uint8Array
}

export interface ExportOptions {
  glb: Uint8Array
  /** 一个或多个贴标区域 */
  areas: ExportAreaInput[]
  /** Complete editable project embedded into GLB extras for round-trip editing. */
  editableProject?: unknown
  /** Worker 重打包超时；生产默认 120 秒，测试可注入更短边界。 */
  workerTimeoutMs?: number
}

export interface ExportResult {
  ok: boolean
  glbBytes?: Uint8Array
  error?: string
  /** 主线程交叉自检 */
  crossCheck?: CrossCheckResult
}

export interface CrossCheckAreaResult {
  nodeName: string
  targetNodeName: string
  loaded: boolean
  uvSampleOk: boolean
  error?: string
}

export interface CrossCheckResult {
  loaded: boolean
  uvSampleOk: boolean
  error?: string
  /** 多区域详情；顶层字段保持旧的单区域响应契约。 */
  areas?: CrossCheckAreaResult[]
}

interface CrossCheckObject {
  isMesh?: boolean
  geometry?: { attributes?: Record<string, { array: ArrayLike<number>; count: number }> }
}

interface CrossCheckAssociation {
  meshes?: number
  nodes?: number
}

function exportedTargetName(area: ExportAreaInput): string {
  return area.surfaceMode === 'overlay'
    ? `${area.nodeName}__label_overlay${area.areaId ? `__${area.areaId}` : ''}`
    : area.nodeName
}

function areaIdentity(area: ExportAreaInput): string {
  return `区域「${area.nodeName}」(mesh[${area.meshIndex}])`
}

function inspectAreaUv(
  objects: CrossCheckObject[],
  associations: Map<object, CrossCheckAssociation>,
  area: ExportAreaInput,
  targetMeshIndex: number,
): CrossCheckAreaResult {
  const targetNodeName = exportedTargetName(area)
  const targetMeshes = objects.filter(
    (object) => object.isMesh && associations.get(object as object)?.meshes === targetMeshIndex,
  )
  const expectedUv = area.remap.uv

  if (targetMeshes.length === 0) {
    const error = `${areaIdentity(area)}：GLTFLoader 场景中未找到关联导出 mesh[${targetMeshIndex}] 的网格`
    return { nodeName: area.nodeName, targetNodeName, loaded: false, uvSampleOk: false, error }
  }

  for (const mesh of targetMeshes) {
    const uv = mesh.geometry?.attributes?.uv
    if (!uv) {
      const error = `${areaIdentity(area)}：关联导出 mesh[${targetMeshIndex}] 缺少 UV`
      return { nodeName: area.nodeName, targetNodeName, loaded: true, uvSampleOk: false, error }
    }
    const expectedCount = expectedUv.length / 2
    if (uv.count !== expectedCount) {
      const error = `${areaIdentity(area)}：关联导出 mesh[${targetMeshIndex}] UV 顶点数不一致（期望 ${expectedCount}，实际 ${uv.count}）`
      return { nodeName: area.nodeName, targetNodeName, loaded: true, uvSampleOk: false, error }
    }
    for (let i = 0; i < expectedUv.length; i++) {
      if (Math.abs(uv.array[i] - expectedUv[i]) > 1e-3) {
        const error = `${areaIdentity(area)}：关联导出 mesh[${targetMeshIndex}] UV 在顶点 ${Math.floor(i / 2)} 不一致`
        return { nodeName: area.nodeName, targetNodeName, loaded: true, uvSampleOk: false, error }
      }
    }
  }

  return { nodeName: area.nodeName, targetNodeName, loaded: true, uvSampleOk: true }
}

/** 主线程交叉自检：用 three GLTFLoader（与 gltf-transform 不同的实现）解析产物，
 *  并按 parser association 中的稳定 glTF mesh 索引逐区域比对完整 UV。 */
async function crossCheck(
  bytes: Uint8Array,
  areas: ExportAreaInput[],
  targetMeshIndices: number[] | undefined,
): Promise<CrossCheckResult> {
  if (areas.length === 0) {
    return { loaded: false, uvSampleOk: false, error: '没有可自检的贴标区域', areas: [] }
  }
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const blob = new Blob([bytes as BlobPart], { type: 'model/gltf-binary' })
    const url = URL.createObjectURL(blob)
    try {
      const gltf = await new Promise<{
        scene: unknown
        parser?: { associations?: Map<object, CrossCheckAssociation> }
      }>((res, rej) => {
        new GLTFLoader().load(url, (g) => res(g as never), undefined, (e) => rej(e))
      })
      const scene = gltf.scene as { traverse: (cb: (o: unknown) => void) => void }
      const associations = gltf.parser?.associations
      if (!associations) throw new Error('GLTFLoader 未提供稳定的 glTF 对象关联')
      const objects: CrossCheckObject[] = []
      scene.traverse((o) => {
        objects.push(o as CrossCheckObject)
      })
      const completeMapping = targetMeshIndices?.length === areas.length
      const areaResults = areas.map((area, index) => {
        const targetNodeName = exportedTargetName(area)
        const targetMeshIndex = targetMeshIndices?.[index]
        if (!completeMapping || !Number.isInteger(targetMeshIndex) || (targetMeshIndex ?? -1) < 0) {
          const error = `${areaIdentity(area)}：Worker 未返回完整、有效的导出目标 mesh 索引，无法稳定校验`
          return { nodeName: area.nodeName, targetNodeName, loaded: false, uvSampleOk: false, error }
        }
        const conflicts = areas.flatMap((candidate, candidateIndex) => (
          candidateIndex !== index && targetMeshIndices?.[candidateIndex] === targetMeshIndex ? [candidate] : []
        ))
        if (conflicts.length === 0) {
          return inspectAreaUv(objects, associations, area, targetMeshIndex!)
        }
        const loaded = objects.some(
          (object) => object.isMesh && associations.get(object as object)?.meshes === targetMeshIndex,
        )
        const conflictNames = conflicts.map(areaIdentity).join('、')
        const error = `${areaIdentity(area)}：导出 mesh[${targetMeshIndex}] 同时映射到 ${conflictNames}，无法唯一校验`
        return {
          nodeName: area.nodeName,
          targetNodeName,
          loaded,
          uvSampleOk: false,
          error,
        }
      })
      const errors = areaResults.flatMap((area) => area.error ? [area.error] : [])
      return {
        loaded: areaResults.every((area) => area.loaded),
        uvSampleOk: areaResults.every((area) => area.uvSampleOk),
        error: errors.length > 0 ? errors.join('；') : undefined,
        areas: areaResults,
      }
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const areaResults = areas.map((area) => {
      const targetNodeName = exportedTargetName(area)
      return {
        nodeName: area.nodeName,
        targetNodeName,
        loaded: false,
        uvSampleOk: false,
        error: `区域「${area.nodeName}」：交叉解析失败（${detail}）`,
      }
    })
    return { loaded: false, uvSampleOk: false, error: areaResults.map((area) => area.error).join('；'), areas: areaResults }
  }
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

/** 执行导出：纹理编码 → Worker 重打包（多区域）→ 交叉自检 → 返回字节。 */
export async function exportGlb(opts: ExportOptions): Promise<ExportResult> {
  const inputBefore = opts.glb.slice(0)
  try {
    // 区域纹理已在 areaExporter 预编码
    const jobs: AreaJob[] = opts.areas.map((area) => ({
      areaId: area.areaId,
      meshIndex: area.meshIndex,
      nodeName: area.nodeName,
      surfaceMode: area.surfaceMode,
      fullRange: area.fullRange,
      remap: { positions: area.remap.positions, normals: area.remap.normals, uv: area.remap.uv, indices: area.remap.indices },
      colorPng: toArrayBuffer(area.colorPng),
      ...(area.metalRoughPng ? { metalRoughPng: toArrayBuffer(area.metalRoughPng) } : {}),
      ...(area.normalPng ? { normalPng: toArrayBuffer(area.normalPng) } : {}),
    }))

    const req: RebuildRequest = {
      kind: 'rebuild',
      requestId: nextRequestId++,
      glb: toArrayBuffer(opts.glb),
      areas: jobs,
      editableProject: opts.editableProject,
    }

    const transfers: ArrayBuffer[] = [req.glb]
    for (const j of jobs) {
      transfers.push(j.colorPng)
      if (j.metalRoughPng) transfers.push(j.metalRoughPng)
      if (j.normalPng) transfers.push(j.normalPng)
    }

    const result = await new Promise<RebuildResponse>((res, rej) => {
      const w = getWorker()
      let settled = false
      const timeoutMs = Number.isFinite(opts.workerTimeoutMs) && (opts.workerTimeoutMs ?? 0) > 0
        ? opts.workerTimeoutMs!
        : DEFAULT_WORKER_TIMEOUT_MS
      let timeoutId: ReturnType<typeof setTimeout>
      const aborters = workerAborters.get(w) ?? new Set<(error: Error) => void>()
      workerAborters.set(w, aborters)
      const cleanup = (): void => {
        w.removeEventListener('message', onMsg)
        w.removeEventListener('error', onErr)
        clearTimeout(timeoutId)
        aborters.delete(abort)
        if (aborters.size === 0) workerAborters.delete(w)
      }
      const settle = (complete: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        complete()
      }
      const abort = (error: Error): void => settle(() => rej(error))
      const onMsg = (ev: MessageEvent<RebuildResponse>): void => {
        if (ev.data.requestId !== req.requestId) return
        settle(() => res(ev.data))
      }
      const onErr = (ev: ErrorEvent): void => {
        resetWorker(w, new Error(ev.message || 'Worker 错误'))
      }
      aborters.add(abort)
      w.addEventListener('message', onMsg)
      w.addEventListener('error', onErr)
      timeoutId = setTimeout(() => {
        const error = new Error('GLB 重打包超时，请重试')
        abort(error)
        resetWorker(w, error)
      }, timeoutMs)
      try {
        w.postMessage(req, transfers)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        abort(failure)
        resetWorker(w, failure)
      }
    })

    if (!result.ok || !result.glb) {
      return { ok: false, error: result.error ?? '重打包失败' }
    }

    const out = new Uint8Array(result.glb)
    const inputUnchanged = inputBefore.length === opts.glb.length && inputBefore.every((b, i) => b === opts.glb[i])
    const cross = await crossCheck(out, opts.areas, result.targetMeshIndices)
    const crossErrors = [cross.error, inputUnchanged ? undefined : '输入缓冲区被修改'].filter((value): value is string => Boolean(value))
    return {
      ok: true,
      glbBytes: out,
      crossCheck: { ...cross, error: crossErrors.length > 0 ? crossErrors.join('；') : undefined },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 浏览器下载 Blob。 */
export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
