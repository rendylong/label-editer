import { Document } from '@gltf-transform/core'
import { describe, expect, it } from 'vitest'
import { buildPartTree, displayPartName, meshLocalFrontDirection } from '../src/glb/analyze'

describe('原生标签面语义识别', () => {
  it('repairs the common Blender Bezier replacement-character display without changing stable identity', () => {
    expect(displayPartName('B��zierCurve_Material.006_0')).toBe('BézierCurve_Material.006_0')
    expect(displayPartName('label_Material.008_0')).toBe('label_Material.008_0')
  })

  it('converts a rotated Blender node world front into mesh-local space', () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const primitive = doc.createPrimitive().setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer),
    )
    const mesh = doc.createMesh('Bottle').addPrimitive(primitive)
    const node = doc.createNode('Bottle').setMesh(mesh).setMatrix([
      1, 0, 0, 0,
      0, 0, -1, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    ])
    doc.createScene().addChild(node)

    const direction = meshLocalFrontDirection(doc, 0)
    expect(direction[0]).toBeCloseTo(0, 8)
    expect(direction[1]).toBeCloseTo(-1, 8)
    expect(direction[2]).toBeCloseTo(0, 8)
  })

  it('节点名通用但材质名为 Wall_paper 时仍识别为标签候选', () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const material = doc.createMaterial('Wall_paper')
    const primitive = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer))
      .setMaterial(material)
    const node = doc.createNode('Object_3').setMesh(doc.createMesh('generic').addPrimitive(primitive))
    doc.createScene('Scene').addChild(node)

    const analysis = buildPartTree(doc)
    const candidate = analysis.labelCandidates[0]

    expect(candidate).toBeDefined()
    expect(analysis.parts[0].kind).toBe('label')
    expect(candidate).toBe(analysis.parts[0].id)
  })

  it('does not auto-promote a radial neck ring merely because it is named label', () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const positions: number[] = []
    const normals: number[] = []
    const indices: number[] = []
    const segments = 12
    for (let segment = 0; segment < segments; segment++) {
      const a0 = segment / segments * Math.PI * 2
      const a1 = (segment + 1) / segments * Math.PI * 2
      const start = positions.length / 3
      // Matches the real perfume neck decoration proportions: a shallow,
      // elliptical full ring rather than an ideal circular sliver.
      for (const [angle, z] of [[a0, 0], [a1, 0], [a1, 0.25], [a0, 0.25]]) {
        positions.push(0.7 * Math.cos(angle), 0.45 * Math.sin(angle), z)
        normals.push(Math.cos(angle), Math.sin(angle), 0)
      }
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
    }
    const primitive = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer))
    const node = doc.createNode('label').setMesh(doc.createMesh('neck-ring').addPrimitive(primitive))
    doc.createScene('Scene').addChild(node)

    const analysis = buildPartTree(doc)

    expect(analysis.parts[0].kind).toBe('mesh')
    expect(analysis.labelCandidates).toEqual([])
  })
})
