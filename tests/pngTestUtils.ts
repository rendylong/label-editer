function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  let value = 0xffffffff
  for (const byte of [...typeBytes, ...data]) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  const checksum = (value ^ 0xffffffff) >>> 0
  return Uint8Array.from([...u32(data.length), ...typeBytes, ...data, ...u32(checksum)])
}

export function pngBytes(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13)
  ihdr.set(u32(width), 0)
  ihdr.set(u32(height), 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  // The production structural policy validates PNG chunks, ordering, CRC, and
  // dimensions without inflating pixels. A tiny IDAT keeps adversarial tests cheap.
  const idat = new Uint8Array([0x78])
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', idat),
    ...chunk('IEND', new Uint8Array()),
  ])
}

export function pngBlob(width: number, height: number): Blob {
  const bytes = pngBytes(width, height)
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new NodeBlob([buffer], { type: 'image/png' }) as unknown as Blob
}
import { Blob as NodeBlob } from 'node:buffer'
