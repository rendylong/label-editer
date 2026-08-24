import { afterEach, describe, expect, it, vi } from 'vitest'

class FileReaderDouble {
  result: string | ArrayBuffer | null = 'data:font/woff2;base64,QkFE'
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  readAsDataURL(): void { this.onload?.() }
}

afterEach(() => vi.unstubAllGlobals())

describe('font upload', () => {
  it('throws and returns no saved upload when FontFace validation fails', async () => {
    class CorruptFontFace {
      constructor(readonly family: string, readonly source: string) {}
      async load(): Promise<never> { throw new Error('corrupt font') }
    }
    vi.stubGlobal('FileReader', FileReaderDouble)
    vi.stubGlobal('FontFace', CorruptFontFace)
    vi.stubGlobal('document', { fonts: { add: vi.fn(), ready: Promise.resolve() } })
    const { uploadFontFile } = await import('../src/label/fonts')
    const file = { name: 'broken.woff2', size: 4 } as File

    await expect(uploadFontFile(file)).rejects.toThrow('corrupt font')
  })
})
