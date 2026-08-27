import { sha256HexSync } from '../agent/syncSha256'

export const MAX_EMBEDDED_ASSET_BYTES = 20 * 1024 * 1024
const MAX_DATA_URL_CHARS = Math.ceil(MAX_EMBEDDED_ASSET_BYTES / 3) * 4 + 256

export interface BoundedAssetReceipt {
  bytes: Uint8Array
  byteLength: number
  mimeType: string
  sha256: string
}

/** Decode an embedded asset only after proving its encoded representation is bounded. */
export function decodeBoundedDataUrl(value: string): BoundedAssetReceipt {
  if (value.length > MAX_DATA_URL_CHARS) throw new Error('Embedded asset exceeds the bounded byte limit')
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(value)
  if (!match) throw new Error('Embedded asset is not a valid data URL')
  const payload = match[3]
  let bytes: Uint8Array
  try {
    if (match[2]) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
        throw new Error('Malformed base64')
      }
      const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
      const decodedLength = payload.length / 4 * 3 - padding
      if (!Number.isSafeInteger(decodedLength) || decodedLength > MAX_EMBEDDED_ASSET_BYTES) {
        throw new Error('Embedded asset exceeds the bounded byte limit')
      }
      const binary = globalThis.atob(payload)
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    } else {
      if (payload.length > MAX_EMBEDDED_ASSET_BYTES * 3) throw new Error('Embedded asset exceeds the bounded byte limit')
      bytes = new TextEncoder().encode(decodeURIComponent(payload))
    }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Embedded asset contains malformed bytes')
  }
  if (bytes.byteLength > MAX_EMBEDDED_ASSET_BYTES) throw new Error('Embedded asset exceeds the bounded byte limit')
  return {
    bytes,
    byteLength: bytes.byteLength,
    mimeType: match[1].toLowerCase(),
    sha256: sha256HexSync(bytes),
  }
}
