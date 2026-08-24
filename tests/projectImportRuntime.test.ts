import { describe, expect, it } from 'vitest'
import { Document, NodeIO } from '@gltf-transform/core'
import { restoreImportedAreaRuntime } from '../src/app/projectImportRuntime'
import type { LabelAreaConfig } from '../src/label/types'

describe('项目导入运行时恢复', () => {
  it('从当前 GLB 重新提取目标网格并重建 UV 输出', async () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const position = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer)
    const primitive = doc.createPrimitive().setAttribute('POSITION', position)
    const mesh = doc.createMesh('Bottle').addPrimitive(primitive)
    doc.createScene().addChild(doc.createNode('瓶身').setMesh(mesh).setScale([-1, 1, 1]))
    const bytes = await new NodeIO().writeBinary(doc)
    const area = {
      id: 'area-1',
      name: '瓶身',
      nodeName: '瓶身',
      meshIndex: 0,
      surfaceMode: 'overlay',
      remap: {
        mode: 'planar',
        axis: [0, 0, 1],
        origin: [0, 0, 0],
        radius: 1,
        wrap: 1,
        offset: 0,
        planarBox: { min: [-1, -1, 0], max: [1, 1, 0] },
      },
      range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
      canvas: { width: 2048, height: 2048, aspect: 1 },
      layers: [],
      globalCraft: { craft: [] },
      fonts: [],
      referenceVisible: false,
      undoStack: [],
      redoStack: [],
    } as LabelAreaConfig

    const restored = await restoreImportedAreaRuntime(bytes, area)

    expect(restored.meshAccessors.positions).toHaveLength(9)
    expect(restored.remapOutput.indices).toHaveLength(3)
    expect(restored.remapOutput.uv).toHaveLength(6)
    expect(restored.remap.mirrorU).toBe(true)
  })
})
