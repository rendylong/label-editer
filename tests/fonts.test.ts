import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FileReaderDouble {
  result: string | ArrayBuffer | null = 'data:font/woff2;base64,QkFE'
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  readAsDataURL(): void { this.onload?.() }
}

beforeEach(() => vi.resetModules())

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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

  it('deletes an uploaded face when managed registration readiness rejects', async () => {
    class LoadedFontFace {
      async load(): Promise<LoadedFontFace> { return this }
    }
    const remove = vi.fn()
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject })
    vi.stubGlobal('FileReader', FileReaderDouble)
    vi.stubGlobal('FontFace', LoadedFontFace)
    vi.stubGlobal('document', {
      fonts: { add: vi.fn(), delete: remove, ready },
    })
    const { uploadFontFile } = await import('../src/label/fonts')

    const loading = uploadFontFile({ name: 'brand.woff2', size: 4 } as File)
    for (let index = 0; index < 4; index += 1) await Promise.resolve()
    rejectReady(new Error('registration failed'))
    await expect(loading).rejects.toThrow('registration failed')
    expect(remove).toHaveBeenCalledOnce()
  })

  it('hands upload validation to the managed cache without constructing a duplicate face', async () => {
    class ValidFontFace {
      static created: ValidFontFace[] = []
      constructor(readonly family: string, readonly source: string) { ValidFontFace.created.push(this) }
      async load(): Promise<ValidFontFace> { return this }
    }
    const add = vi.fn()
    const remove = vi.fn()
    vi.stubGlobal('FileReader', FileReaderDouble)
    vi.stubGlobal('FontFace', ValidFontFace)
    vi.stubGlobal('document', { fonts: { add, delete: remove, ready: Promise.resolve() } })
    const { uploadFontFile } = await import('../src/label/fonts')
    const runtime = await import('../src/label/fontRuntime')

    const uploaded = await uploadFontFile({ name: 'brand.woff2', size: 4 } as File)
    const record = { name: uploaded.name, dataUrl: uploaded.dataUrl }
    runtime.syncUploadedFontProject([record])
    await expect(runtime.ensureUploadedFontLoaded(record)).resolves.toMatchObject({ ok: true })

    expect(ValidFontFace.created).toHaveLength(1)
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
  })

  it('retires a successfully validated upload when the caller never adopts it into a project', async () => {
    vi.useFakeTimers()
    class ValidFontFace {
      static created: ValidFontFace[] = []
      constructor(readonly family: string, readonly source: string) { ValidFontFace.created.push(this) }
      async load(): Promise<ValidFontFace> { return this }
    }
    const remove = vi.fn()
    vi.stubGlobal('FileReader', FileReaderDouble)
    vi.stubGlobal('FontFace', ValidFontFace)
    vi.stubGlobal('document', { fonts: { add: vi.fn(), delete: remove, ready: Promise.resolve() } })
    const { uploadFontFile } = await import('../src/label/fonts')

    await uploadFontFile({ name: 'discarded.woff2', size: 4 } as File)
    await vi.runAllTimersAsync()

    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith(ValidFontFace.created[0])
  })
})
