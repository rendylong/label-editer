import { describe, expect, it } from 'vitest'
import { Document, NodeIO } from '@gltf-transform/core'
import { ModelTargetResolutionError, resolveTarget } from '../src/agent/targetResolver'
import { inspectModel, stableMeshSelector } from '../src/agent/modelInspection'

const meshes = [
  {
    stableSelector: 'mesh:0/node:2',
    meshIndex: 0,
    nodeIndex: 2,
    nodeName: 'Bottle',
    materialNames: ['Glass'],
    mappingMode: 'cylindrical' as const,
    labelCandidate: true,
    warnings: [],
  },
  {
    stableSelector: 'mesh:1/node:4',
    meshIndex: 1,
    nodeIndex: 4,
    nodeName: 'Bottle',
    materialNames: ['Label'],
    mappingMode: 'planar' as const,
    labelCandidate: true,
    warnings: [],
  },
]

describe('Agent target resolution', () => {
  it('inspects GLB meshes with selectors derived from glTF indices', async () => {
    const document = new Document()
    const buffer = document.createBuffer()
    const primitive = document.createPrimitive()
      .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(new Float32Array([
        -1, 0, 0, 1, 0, 0, 0, 2, 0,
      ])).setBuffer(buffer))
      .setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer))
      .setMaterial(document.createMaterial('Glass'))
    const mesh = document.createMesh('BottleMesh').addPrimitive(primitive)
    document.createScene('Scene').addChild(document.createNode('Bottle').setMesh(mesh))
    const bytes = await new NodeIO().writeBinary(document)

    const inspection = await inspectModel(bytes, 'bottle.glb')

    expect(stableMeshSelector(0, 0)).toBe('mesh:0/node:0')
    expect(inspection.meshes).toMatchObject([{
      stableSelector: 'mesh:0/node:0',
      meshIndex: 0,
      nodeIndex: 0,
      nodeName: 'Bottle',
      materialNames: ['Glass'],
    }])
    expect(inspection.dimensions).toEqual({ width: 2, height: 2, depth: 0 })
  })

  it('resolves the exact inspected stable selector', () => {
    expect(resolveTarget({ stableSelector: 'mesh:1/node:4' }, meshes).meshIndex).toBe(1)
  })

  it('rejects a duplicate exact node name with inspectable candidates', () => {
    try {
      resolveTarget({ nodeName: 'Bottle' }, meshes)
      throw new Error('expected ambiguity')
    } catch (error) {
      expect(error).toBeInstanceOf(ModelTargetResolutionError)
      expect(error).toMatchObject({
        code: 'AMBIGUOUS_MODEL_TARGET',
        candidates: ['mesh:0/node:2', 'mesh:1/node:4'],
      })
    }
  })

  it('does not silently combine selector fields', () => {
    expect(() => resolveTarget({ meshIndex: 0, materialName: 'Label' }, meshes)).toThrow(/conflicting/i)
  })

  it('reports a missing target separately from ambiguity', () => {
    try {
      resolveTarget({ materialName: 'Paper' }, meshes)
      throw new Error('expected missing target')
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_TARGET_NOT_FOUND', candidates: [] })
    }
  })
})
