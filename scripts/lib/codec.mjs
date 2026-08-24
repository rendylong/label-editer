const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const unsupportedExtensions = ['EXT_meshopt_compression', 'KHR_texture_basisu']

function parseGlbJson(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (data.byteLength < 20) throw new Error('Invalid GLB: header is truncated')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Invalid GLB: magic is missing')
  if (view.getUint32(4, true) !== 2) throw new Error('Unsupported GLB version')
  const declaredLength = view.getUint32(8, true)
  if (declaredLength !== data.byteLength) throw new Error('Invalid GLB: declared length differs from bytes')
  const jsonLength = view.getUint32(12, true)
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > data.byteLength) {
    throw new Error('Invalid GLB: JSON chunk is missing')
  }
  return JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + jsonLength)).trim())
}

export function inspectCodec(bytes) {
  const json = parseGlbJson(bytes)
  const extensions = Array.isArray(json.extensionsUsed)
    ? json.extensionsUsed.filter((value) => typeof value === 'string')
    : []
  const unsupported = unsupportedExtensions.find((extension) => extensions.includes(extension))
  const sourceCompressed = extensions.includes('KHR_draco_mesh_compression')
  return {
    extensions,
    sourceCompressed,
    needsNormalization: sourceCompressed,
    outputCompressed: false,
    blocker: unsupported
      ? {
          code: 'UNSUPPORTED_CODEC',
          extension: unsupported,
          message: `Unsupported GLB extension: ${unsupported}`,
        }
      : undefined,
  }
}

export async function normalizeGlb(bytes) {
  const codec = inspectCodec(bytes)
  if (codec.blocker) {
    const error = new Error(codec.blocker.message)
    error.code = codec.blocker.code
    error.extension = codec.blocker.extension
    throw error
  }
  if (!codec.needsNormalization) return { bytes, codec: { ...codec, normalized: false } }
  const [{ NodeIO }, { KHRDracoMeshCompression }, draco3d] = await Promise.all([
    import('@gltf-transform/core'),
    import('@gltf-transform/extensions'),
    import('draco3dgltf'),
  ])
  const io = new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  })
  const document = await io.readBinary(bytes)
  document.getRoot().listExtensionsUsed()
    .filter((extension) => extension.extensionName === 'KHR_draco_mesh_compression')
    .forEach((extension) => extension.dispose())
  const normalizedBytes = await io.writeBinary(document)
  return { bytes: normalizedBytes, codec: { ...codec, normalized: true, outputCompressed: false } }
}
