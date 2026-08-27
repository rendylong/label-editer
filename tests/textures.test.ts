import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { canvasToPngBytes } from '../src/glb/textures'

function encoder(blob: Blob | null): HTMLCanvasElement {
  return {
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
      await expect(settlesPromptly(canvasToPngBytes(encoder(blob)))).resolves.toEqual(Uint8Array.from(bytes))
    } finally {
      await browser.close()
    }
  })
})
