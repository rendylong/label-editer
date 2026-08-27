import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { canvasToPngBytes } from '../src/glb/textures'
import { parsePortablePng } from '../scripts/lib/png-core.mjs'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  view.setUint32(29, crc32(bytes.subarray(12, 29)))
  return bytes
}

function chunk(type: string, data = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(12 + data.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, data.length)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(data, 8)
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)))
  return bytes
}

function withExcessiveChunks(count: number): Uint8Array {
  const ihdrEnd = 8 + 25
  const extras = Array.from({ length: count }, () => chunk('tEXt'))
  const byteLength = PNG.length + extras.reduce((sum, bytes) => sum + bytes.length, 0)
  const output = new Uint8Array(byteLength)
  output.set(PNG.subarray(0, ihdrEnd), 0)
  let offset = ihdrEnd
  for (const extra of extras) { output.set(extra, offset); offset += extra.length }
  output.set(PNG.subarray(ihdrEnd), offset)
  return output
}

function encoder(blob: Blob | null, width = 1, height = 1): HTMLCanvasElement {
  return {
    width,
    height,
    toBlob(callback: BlobCallback) { queueMicrotask(() => callback(blob)) },
  } as unknown as HTMLCanvasElement
}

async function settlesPromptly(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('PNG encoder promise hung')), 100)),
  ])
}

describe('canvas PNG encoding', () => {
  it('propagates a rejected Blob.arrayBuffer without leaving the outer promise pending', async () => {
    const marker = new Error('blob read failed')
    const blob = { arrayBuffer: () => Promise.reject(marker) } as Blob

    await expect(settlesPromptly(canvasToPngBytes(encoder(blob)))).rejects.toBe(marker)
  })

  it('rejects a null encoder result promptly', async () => {
    await expect(settlesPromptly(canvasToPngBytes(encoder(null)))).rejects.toThrow(/PNG/i)
  })

  it('rejects malformed bytes returned under an image/png blob', async () => {
    const blob = { arrayBuffer: () => Promise.resolve(Uint8Array.from([1, 2, 3, 4]).buffer) } as Blob

    await expect(settlesPromptly(canvasToPngBytes(encoder(blob)))).rejects.toThrow(/PNG/i)
  })

  it.each([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64').subarray(0, 40)),
    (() => { const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')); bytes[29] ^= 1; return bytes })(),
  ])('rejects signature-only, truncated, or CRC-corrupt PNG structure promptly', async (bytes) => {
    const blob = { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) } as Blob
    await expect(settlesPromptly(canvasToPngBytes(encoder(blob)))).rejects.toThrow(/PNG/i)
  })

  it('bounds PNG structure work by rejecting excessive tiny chunks and malicious chunk lengths', () => {
    expect(() => parsePortablePng(withExcessiveChunks(4_097))).toThrow(/chunk|work|limit/i)

    const maliciousLength = new Uint8Array(20)
    maliciousLength.set(PNG.subarray(0, 8))
    new DataView(maliciousLength.buffer).setUint32(8, 0xffff_ffff)
    maliciousLength.set(new TextEncoder().encode('IHDR'), 12)
    expect(() => parsePortablePng(maliciousLength)).toThrow(/chunk length/i)
  })

  it('uses the already-created canvas dimensions as encoder policy and rejects mismatched IHDR values', async () => {
    const largeConfiguredOutput = pngWithDimensions(20_000, 20_000)
    const matchingBlob = { arrayBuffer: () => Promise.resolve(largeConfiguredOutput.buffer) } as Blob
    await expect(canvasToPngBytes(encoder(matchingBlob, 20_000, 20_000))).resolves.toEqual(largeConfiguredOutput)

    const wrongHeader = pngWithDimensions(2, 3)
    const mismatchedBlob = { arrayBuffer: () => Promise.resolve(wrongHeader.buffer) } as Blob
    await expect(canvasToPngBytes(encoder(mismatchedBlob, 3, 2))).rejects.toThrow(/dimension|PNG/i)
  })

  it('accepts a structurally valid PNG emitted by a real Chromium canvas', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const bytes = await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 3
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('null blob')), 'image/png'))
        return [...new Uint8Array(await blob.arrayBuffer())]
      })
      const blob = { arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer) } as Blob
      await expect(settlesPromptly(canvasToPngBytes(encoder(blob, 2, 3)))).resolves.toEqual(Uint8Array.from(bytes))
    } finally {
      await browser.close()
    }
  })
})
