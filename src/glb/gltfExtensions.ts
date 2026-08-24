import type { NodeIO } from '@gltf-transform/core'
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRDracoMeshCompression,
} from '@gltf-transform/extensions'

/**
 * Canonical dependency-safe registry for every glTF Transform read/write boundary.
 * Codec extensions require both decoder and encoder dependencies. Registering either codec
 * without them lets optional fallback data read, but makes the subsequent write crash. Until
 * browser-safe read/write dependencies are provided, leave those extensions unregistered so
 * optional fallback bytes remain usable and required compression rejects explicitly.
 */
export const SUPPORTED_GLTF_EXTENSIONS = ALL_EXTENSIONS.filter(
  (ExtensionClass) => ExtensionClass !== EXTMeshoptCompression && ExtensionClass !== KHRDracoMeshCompression,
)

export function registerSupportedGltfExtensions<T extends NodeIO>(io: T): T {
  io.registerExtensions(SUPPORTED_GLTF_EXTENSIONS)
  return io
}
