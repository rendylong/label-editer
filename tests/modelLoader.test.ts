import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadModelFromBytes, addAreaForNode, computeLabelSetup, getAreaPreview } from '../src/app/modelLoader'
import { makeDefaultRemap, type MeshAccessors } from '../src/glb/uvRemap'
import { useLabelStore, useModelStore } from '../src/state/stores'

const SAMPLE = new URL('../public/sample/面霜瓶.glb', import.meta.url)

function squareBottleSideMesh(): MeshAccessors {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const addFace = (corners: number[][], normal: number[]) => {
    const start = positions.length / 3
    for (const corner of corners) {
      positions.push(corner[0], corner[1], corner[2])
      normals.push(normal[0], normal[1], normal[2])
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
  }
  addFace([[-1, -1, -2], [1, -1, -2], [1, -1, 2], [-1, -1, 2]], [0, -1, 0])
  addFace([[1, -1, -2], [1, 1, -2], [1, 1, 2], [1, -1, 2]], [1, 0, 0])
  addFace([[1, 1, -2], [-1, 1, -2], [-1, 1, 2], [1, 1, 2]], [0, 1, 0])
  addFace([[-1, 1, -2], [-1, -1, -2], [-1, -1, 2], [-1, 1, 2]], [-1, 0, 0])
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uv: new Float32Array((positions.length / 3) * 2),
    indices: new Uint16Array(indices),
    triangleCount: indices.length / 3,
  }
}

function roundBottleSideMesh(segments = 32): MeshAccessors {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (let segment = 0; segment < segments; segment++) {
    const angle0 = segment / segments * Math.PI * 2
    const angle1 = (segment + 1) / segments * Math.PI * 2
    const start = positions.length / 3
    for (const [angle, z] of [[angle0, -2], [angle1, -2], [angle1, 2], [angle0, 2]]) {
      const x = Math.cos(angle)
      const y = Math.sin(angle)
      positions.push(x, y, z)
      normals.push(x, y, 0)
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uv: new Float32Array((positions.length / 3) * 2),
    indices: new Uint16Array(indices),
    triangleCount: indices.length / 3,
  }
}

describe('贴标区域设置提交', () => {
  beforeEach(() => {
    useLabelStore.getState().clearAll()
    useModelStore.getState().selectPart(null)
  })

  it('已有网格也会应用用户在 2D 展开图中确认的新范围', async () => {
    const bytes = new Uint8Array(readFileSync(SAMPLE))
    const loaded = await loadModelFromBytes('面霜瓶.glb', bytes)
    expect(loaded.labelActivated).toBe(true)

    const analysis = useModelStore.getState().analysis!
    const nodeId = analysis.labelCandidates[0]
    const requested = { uStart: 0.3, uWidth: 0.4, vStart: 0.3, vHeight: 0.4 }
    const result = await addAreaForNode(nodeId, requested)

    expect(result.ok).toBe(true)
    expect(useLabelStore.getState().areas).toHaveLength(1)
    expect(useLabelStore.getState().activeArea?.range).toEqual(requested)
  })

  it('原模型贴图不会作为新 UV 画布的参考层而被拉伸显示', async () => {
    const bytes = new Uint8Array(readFileSync(SAMPLE))
    const loaded = await loadModelFromBytes('面霜瓶.glb', bytes)
    expect(loaded.labelActivated).toBe(true)

    const area = useLabelStore.getState().activeArea
    expect(area?.referenceVisible).toBe(false)
    expect(area?.referenceUrl).toBeUndefined()

    const nodeId = useModelStore.getState().analysis!.labelCandidates[0]
    const preview = await getAreaPreview(nodeId)
    expect(preview.ok).toBe(true)
    expect(preview.referenceUrl).toBeUndefined()
  })

  it('方瓶按贴标中心的真实表面尺度生成画布，避免文字被横向拉伸', () => {
    const mesh = squareBottleSideMesh()
    const params = makeDefaultRemap(mesh, false, [0, -1, 0])

    const { spec } = computeLabelSetup(mesh, params, undefined, 'overlay')

    // 方瓶前面宽 2、高 4；在环绕 UV 中前面占 1/4 圈，故归一化画布的
    // 真实横向长度为 2 / 0.25 = 8，纵向为 4，比例应为 2:1。
    expect(spec.aspect).toBeCloseTo(2, 2)
  })

  it('圆瓶使用真实表面尺度后仍保持圆周与瓶高的原有比例', () => {
    const mesh = roundBottleSideMesh()
    const params = makeDefaultRemap(mesh, false, [0, -1, 0])

    const { spec } = computeLabelSetup(mesh, params, undefined, 'overlay')

    // 半径 1、高 4，理论比例为 2π / 4 = π/2；32 段折线逼近允许少量弦长误差。
    expect(spec.aspect).toBeCloseTo(Math.PI / 2, 2)
  })
})
