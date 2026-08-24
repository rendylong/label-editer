import { describe, expect, it } from 'vitest'
import { Document } from '@gltf-transform/core'
import { applyLabelJobToDocument } from '../src/glb/rebuildCore'

describe('GLB 贴标叠加导出', () => {
  it('普通瓶身导出时保留原 mesh/material，并新增同变换的标签节点', () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const position = doc
      .createAccessor('body-position')
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer)
    const normal = doc
      .createAccessor('body-normal')
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]))
      .setBuffer(buffer)
    const indices = doc
      .createAccessor('body-indices')
      .setType('SCALAR')
      .setArray(new Uint16Array([0, 1, 2]))
      .setBuffer(buffer)
    const bodyMaterial = doc.createMaterial('Bottle Body').setBaseColorFactor([0.8, 0.8, 0.8, 1])
    const bodyPrimitive = doc
      .createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('NORMAL', normal)
      .setIndices(indices)
      .setMaterial(bodyMaterial)
    const bodyMesh = doc.createMesh('Bottle').addPrimitive(bodyPrimitive)
    const bodyNode = doc.createNode('瓶身').setMesh(bodyMesh).setTranslation([3, 4, 5])
    doc.createScene('Scene').addChild(bodyNode)

    const targetMeshIndex = applyLabelJobToDocument(doc, {
      meshIndex: 0,
      nodeName: '瓶身',
      surfaceMode: 'overlay',
      fullRange: false,
      remap: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uv: new Float32Array([0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
      },
      colorPng: new ArrayBuffer(0),
    })

    const root = doc.getRoot()
    expect(targetMeshIndex).toBe(1)
    expect(root.listMeshes()).toHaveLength(2)
    expect(root.listNodes()).toHaveLength(2)
    expect(bodyPrimitive.getAttribute('POSITION')).toBe(position)
    expect(bodyPrimitive.getMaterial()).toBe(bodyMaterial)
    const labelNode = root.listNodes().find((node) => node.getName() === '瓶身__label_overlay')
    expect(labelNode).toBeDefined()
    expect(labelNode?.getTranslation()).toEqual([3, 4, 5])
    expect(labelNode?.getMesh()).not.toBe(bodyMesh)
    const labelPrimitive = labelNode?.getMesh()?.listPrimitives()[0]
    expect(labelPrimitive?.getMaterial()).not.toBe(bodyMaterial)
    const exportedPosition = labelPrimitive?.getAttribute('POSITION')?.getArray() as Float32Array
    expect(exportedPosition[2]).toBeGreaterThan(0)
  })
})
