/**
 * 完整导出管线集成测试（Node 端复刻 Worker 逻辑）：
 * read → remap → 写回 accessor/纹理/OPAQUE → writeBinary → readBinary 重读校验。
 * 判定浏览器端"交叉自检"是否应通过。
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { Document, Logger, NodeIO, VertexLayout } from '@gltf-transform/core'
const VERTEX_LAYOUT = VertexLayout.SEPARATE
import {
  ALL_EXTENSIONS,
  KHRMaterialsIOR,
  KHRMaterialsSheen,
  KHRMaterialsSpecular,
  KHRMaterialsTransmission,
  KHRMaterialsVolume,
} from '@gltf-transform/extensions'
import { getIO } from '../src/glb/analyze'
import { registerSupportedGltfExtensions } from '../src/glb/gltfExtensions'
import { computeRemap, makeDefaultRemap, type MeshAccessors } from '../src/glb/uvRemap'
import { configureTransparentLabelExport } from '../src/glb/textures'

const SAMPLE = new URL('../public/sample/面霜瓶.glb', import.meta.url)

const MESHOPT_POSITION_PAYLOAD = new Uint8Array([
  160, 0, 0, 1, 60, 0, 0, 0, 255, 255, 1, 60, 0, 0, 0, 126, 125, 0, 0, 1, 12, 0, 0, 0,
  255, 1, 12, 0, 0, 0, 126, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
])

/** One-buffer GLB with normal POSITION fallback bytes and a valid optional Meshopt payload. */
function meshoptFallbackGlb(required = false): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const fallback = new Uint8Array(positions.buffer)
  const binLength = fallback.length + MESHOPT_POSITION_PAYLOAD.length
  const bin = new Uint8Array(Math.ceil(binLength / 4) * 4)
  bin.set(fallback)
  bin.set(MESHOPT_POSITION_PAYLOAD, fallback.length)
  const json = {
    asset: { version: '2.0', generator: 'meshopt-fallback-fixture' },
    extensionsUsed: ['EXT_meshopt_compression'],
    ...(required ? { extensionsRequired: ['EXT_meshopt_compression'] } : {}),
    buffers: [{ byteLength: binLength }],
    bufferViews: [{
      buffer: 0,
      byteOffset: 0,
      byteLength: fallback.length,
      byteStride: 12,
      target: 34962,
      extensions: {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset: fallback.length,
          byteLength: MESHOPT_POSITION_PAYLOAD.length,
          byteStride: 12,
          count: 3,
          mode: 'ATTRIBUTES',
          filter: 'NONE',
        },
      },
    }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    nodes: [{ name: 'Fallback Triangle', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const paddedJsonLength = Math.ceil(jsonBytes.length / 4) * 4
  const totalLength = 12 + 8 + paddedJsonLength + 8 + bin.length
  const glb = new Uint8Array(totalLength)
  const view = new DataView(glb.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)
  view.setUint32(12, paddedJsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  glb.fill(0x20, 20, 20 + paddedJsonLength)
  glb.set(jsonBytes, 20)
  const binHeader = 20 + paddedJsonLength
  view.setUint32(binHeader, bin.length, true)
  view.setUint32(binHeader + 4, 0x004e4942, true)
  glb.set(bin, binHeader + 8)
  return glb
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
  if (scene) for (const c of scene.listChildren()) walk(c)
  return idx
}

/** 生成一张纯色 PNG 字节（无需 DOM）。 */
function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  // 最小合法 PNG（IHDR + IDAT(zlib 单个 deflate 块) + IEND），RGBA 无滤波
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0
    for (let x = 0; x < width; x++) {
      const o = y * (1 + width * 4) + 1 + x * 4
      raw[o] = rgb[0]
      raw[o + 1] = rgb[1]
      raw[o + 2] = rgb[2]
      raw[o + 3] = 255
    }
  }
  // 用 zlib 压缩 IDAT
  const zlib = require('node:zlib')
  const idat = zlib.deflateSync(raw)
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = require('node:zlib').crc32
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, data])) >>> 0)
    return Buffer.concat([len, typeBuf, data, crcBuf])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return new Uint8Array(png)
}

describe('导出管线往返（Worker 逻辑 Node 复刻）', () => {
  it('对不支持的可选 Meshopt 压缩使用同缓冲回退几何并可安全重写', async () => {
    const io = registerSupportedGltfExtensions(new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)))
    const parsed = await io.readBinary(meshoptFallbackGlb())
    const parsedPosition = parsed.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION')!.getArray()!
    expect(Array.from(parsedPosition)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])

    const output = await io.writeBinary(parsed)
    const roundtrip = await new NodeIO().readBinary(output)
    const roundtripPosition = roundtrip.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION')!.getArray()!

    expect(Array.from(roundtripPosition)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(roundtrip.getRoot().listExtensionsUsed().map((extension) => extension.extensionName)).not.toContain('EXT_meshopt_compression')
  })

  it('明确拒绝必需 Meshopt 解码器的输入而不宣称可保留压缩', async () => {
    const io = registerSupportedGltfExtensions(new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)))
    await expect(io.readBinary(meshoptFallbackGlb(true))).rejects.toThrow(/^Missing required extension, "EXT_meshopt_compression"\.$/)
  })

  it('导出解析往返保留受支持的材质扩展、参数与源元数据', async () => {
    const sourceIO = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    const source = new Document()
    const buffer = source.createBuffer()
    const material = source.createMaterial('Glass')
    const transmission = source
      .createExtension(KHRMaterialsTransmission)
      .createTransmission()
      .setTransmissionFactor(0.73)
    material.setExtension('KHR_materials_transmission', transmission)
    material.setExtension('KHR_materials_ior', source.createExtension(KHRMaterialsIOR).createIOR().setIOR(1.33))
    material.setExtension('KHR_materials_volume', source.createExtension(KHRMaterialsVolume).createVolume().setThicknessFactor(0.42))
    material.setExtension(
      'KHR_materials_sheen',
      source.createExtension(KHRMaterialsSheen).createSheen().setSheenColorFactor([0.1, 0.2, 0.3]).setSheenRoughnessFactor(0.47),
    )
    material.setExtension('KHR_materials_specular', source.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularFactor(0.61))
    const position = source
      .createAccessor('positions')
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer)
    const primitive = source.createPrimitive().setAttribute('POSITION', position).setMaterial(material)
    const node = source.createNode('Glass Bottle').setMesh(source.createMesh('Glass Mesh').addPrimitive(primitive))
    node.setExtras({ sourceAssetId: 'glass-source-01' })
    source.createScene('Scene').addChild(node)
    source.getRoot().getAsset().generator = 'roundtrip-fixture'
    source.getRoot().getAsset().copyright = 'fixture-copyright'

    const input = await sourceIO.writeBinary(source)
    const productionIO = await getIO()
    const parsed = await productionIO.readBinary(input)
    const output = await productionIO.writeBinary(parsed)
    const roundtrip = await sourceIO.readBinary(output)
    const roundtripMaterial = roundtrip.getRoot().listMaterials()[0]
    const roundtripTransmission = roundtripMaterial.getExtension('KHR_materials_transmission') as
      | { getTransmissionFactor(): number }
      | null
    const roundtripIOR = roundtripMaterial.getExtension('KHR_materials_ior') as { getIOR(): number } | null
    const roundtripVolume = roundtripMaterial.getExtension('KHR_materials_volume') as { getThicknessFactor(): number } | null
    const roundtripSheen = roundtripMaterial.getExtension('KHR_materials_sheen') as
      | { getSheenColorFactor(): number[]; getSheenRoughnessFactor(): number }
      | null
    const roundtripSpecular = roundtripMaterial.getExtension('KHR_materials_specular') as { getSpecularFactor(): number } | null

    expect(roundtrip.getRoot().listExtensionsUsed().map((extension) => extension.extensionName)).toEqual(expect.arrayContaining([
      'KHR_materials_transmission',
      'KHR_materials_ior',
      'KHR_materials_volume',
      'KHR_materials_sheen',
      'KHR_materials_specular',
    ]))
    expect(roundtripTransmission?.getTransmissionFactor()).toBeCloseTo(0.73)
    expect(roundtripIOR?.getIOR()).toBeCloseTo(1.33)
    expect(roundtripVolume?.getThicknessFactor()).toBeCloseTo(0.42)
    expect(roundtripSheen?.getSheenColorFactor()).toEqual([0.1, 0.2, 0.3])
    expect(roundtripSheen?.getSheenRoughnessFactor()).toBeCloseTo(0.47)
    expect(roundtripSpecular?.getSpecularFactor()).toBeCloseTo(0.61)
    // glTF Transform intentionally stamps its own generator while preserving
    // source-owned copyright and property extras.
    expect(roundtrip.getRoot().getAsset()).toMatchObject({ copyright: 'fixture-copyright' })
    expect(roundtrip.getRoot().listNodes()[0].getExtras()).toEqual({ sourceAssetId: 'glass-source-01' })
  })

  it('写回 UV/透明纹理后重读：UV 逐值一致、纹理存在、alphaMode=BLEND、单 buffer', async () => {
    const io = registerSupportedGltfExtensions(new NodeIO()).setVertexLayout(VERTEX_LAYOUT)
    const bytes = readFileSync(SAMPLE)
    const doc = await io.readBinary(new Uint8Array(bytes))
    const root = doc.getRoot()
    const meshIndex = findLabelMeshIndex(doc)
    expect(meshIndex).toBeGreaterThanOrEqual(0)

    const mesh = root.listMeshes()[meshIndex]
    const prim = mesh.listPrimitives()[0]
    const pos = prim.getAttribute('POSITION')!
    const nrm = prim.getAttribute('NORMAL')
    const uv = prim.getAttribute('TEXCOORD_0')
    const idxx = prim.getIndices()
    const accessors: MeshAccessors = {
      positions: pos.getArray() as Float32Array,
      normals: nrm ? (nrm.getArray() as Float32Array) : undefined,
      uv: uv ? (uv.getArray() as Float32Array) : new Float32Array(pos.getCount() * 2),
      indices: idxx ? (idxx.getArray() as Uint16Array | Uint32Array) : null,
      triangleCount: idxx ? idxx.getCount() / 3 : pos.getCount() / 3,
    }
    const params = makeDefaultRemap(accessors)
    const out = computeRemap(accessors, params)

    // 复刻 Worker：覆盖 accessor（复用原 buffer）+ 换透明纹理
    const existing = root.listBuffers()
    const buf = existing.length > 0 ? existing[0] : doc.createBuffer()
    prim
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(out.positions as never).setBuffer(buf))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(out.normals as never).setBuffer(buf))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(out.uv as never).setBuffer(buf))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(out.indices as never).setBuffer(buf))

    const mat = prim.getMaterial()!
    const colorTex = doc.createTexture('label_color').setImage(solidPng(64, 64, [230, 30, 30])).setMimeType('image/png')
    mat.setBaseColorTexture(colorTex)
    configureTransparentLabelExport(mat)

    const out1 = await io.writeBinary(doc)
    const out2 = await io.writeBinary(doc)
    expect(out1.length).toBe(out2.length)
    expect(out1.every((b, i) => b === out2[i])).toBe(true) // 确定性

    // 重读校验
    const doc2 = await io.readBinary(out1)
    const root2 = doc2.getRoot()
    expect(root2.listBuffers().length).toBeLessThanOrEqual(1)
    const mesh2 = root2.listMeshes()[meshIndex]
    const prim2 = mesh2.listPrimitives()[0]
    const uv2 = prim2.getAttribute('TEXCOORD_0')!.getArray() as Float32Array
    expect(uv2.length).toBe(out.uv.length)
    for (let i = 0; i < out.uv.length; i++) {
      expect(Math.abs(uv2[i] - out.uv[i])).toBeLessThan(1e-5)
    }
    const mat2 = prim2.getMaterial()!
    expect(mat2.getAlphaMode()).toBe('BLEND')
    expect(mat2.getBaseColorTexture()?.getImage()?.length).toBeGreaterThan(0)
    // 顶点数与索引合法
    const pos2 = prim2.getAttribute('POSITION')!.getArray() as Float32Array
    const idx2 = prim2.getIndices()!.getArray() as Uint32Array
    expect(pos2.length / 3).toBe(uv2.length / 2)
    for (let i = 0; i < idx2.length; i++) expect(idx2[i]).toBeLessThan(pos2.length / 3)
  })
})
