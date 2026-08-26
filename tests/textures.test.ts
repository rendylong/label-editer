import { describe, expect, it } from 'vitest'
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
})
