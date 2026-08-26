import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelLayer, UploadedFontRecord } from '../src/label/types'

class FontFaceDouble {
  static created: FontFaceDouble[] = []
  static failingSource = ''

  readonly family: string
  readonly source: string
  readonly descriptors: FontFaceDescriptors

  constructor(family: string, source: string, descriptors: FontFaceDescriptors = {}) {
    this.family = family
    this.source = source
    this.descriptors = descriptors
    FontFaceDouble.created.push(this)
  }

  async load(): Promise<FontFaceDouble> {
    if (FontFaceDouble.failingSource && this.source.includes(FontFaceDouble.failingSource)) {
      throw new Error('font unavailable')
    }
    return this
  }
}

const addFont = vi.fn()

function textLayer(fontFamily: string, fontWeight: number = 400, italic = false): LabelLayer {
  return {
    id: `text-${fontFamily}`,
    kind: 'text',
    text: 'Typography 字体',
    fontFamily,
    fontSize: 72,
    fontWeight,
    letterSpacing: 0,
    lineHeight: 1.2,
    color: '#000000',
    align: 'left',
    italic,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    craft: [],
  }
}

async function freshRuntime() {
  vi.resetModules()
  return import('../src/label/fontRuntime')
}

beforeEach(() => {
  FontFaceDouble.created = []
  FontFaceDouble.failingSource = ''
  addFont.mockReset()
  vi.stubGlobal('FontFace', FontFaceDouble)
  vi.stubGlobal('document', { fonts: { add: addFont, ready: Promise.resolve() } })
})

afterEach(() => {
  vi.doUnmock('../src/label/fontCatalog')
  vi.unstubAllGlobals()
})

describe('font runtime', () => {
  it('deduplicates concurrent loads and resolves unsupported variants to the nearest local asset', async () => {
    const { ensureFontLoaded } = await freshRuntime()

    const [first, second] = await Promise.all([
      ensureFontLoaded('inter', 650, 'italic'),
      ensureFontLoaded('inter', 650, 'italic'),
    ])

    expect(first).toEqual({ id: 'inter', ok: true, cssFamily: '__catalog_inter' })
    expect(second).toEqual(first)
    expect(FontFaceDouble.created).toHaveLength(1)
    expect(FontFaceDouble.created[0].source).toBe('url("/fonts/inter/400-normal.woff2")')
    expect(FontFaceDouble.created[0].descriptors).toMatchObject({ weight: '400', style: 'normal' })
    expect(addFont).toHaveBeenCalledTimes(1)
  })

  it('returns a failed result for a font id without a local asset', async () => {
    const { ensureFontLoaded } = await freshRuntime()

    await expect(ensureFontLoaded('missing-font', 400, 'normal')).resolves.toMatchObject({
      id: 'missing-font',
      ok: false,
      cssFamily: 'ui-sans-serif',
    })
    expect(FontFaceDouble.created).toHaveLength(0)
  })

  it('reports unavailable used catalog families by display name without loading unused fonts', async () => {
    FontFaceDouble.failingSource = '/fonts/playfair-display/'
    const { waitForDesignFonts } = await freshRuntime()

    const report = await waitForDesignFonts(
      [textLayer('inter'), textLayer('playfair-display', 700), textLayer('inter')],
      [],
    )

    expect(report).toEqual({ ready: ['Inter'], unavailable: ['Playfair Display'] })
    expect(FontFaceDouble.created).toHaveLength(2)
  })

  it('counts a known system-font id as ready without invoking FontFace', async () => {
    const { waitForDesignFonts } = await freshRuntime()

    await expect(waitForDesignFonts([textLayer('system-sans')], [])).resolves.toEqual({
      ready: ['系统默认'],
      unavailable: [],
    })
    expect(FontFaceDouble.created).toHaveLength(0)
  })

  it('reports an unknown legacy font reference as unavailable', async () => {
    const { waitForDesignFonts } = await freshRuntime()

    await expect(waitForDesignFonts([textLayer('Missing Legacy Face')], [])).resolves.toEqual({
      ready: [],
      unavailable: ['Missing Legacy Face'],
    })
  })

  it('reports a namespaced upload reference as unavailable when its record is missing', async () => {
    const { waitForDesignFonts } = await freshRuntime()

    await expect(waitForDesignFonts([textLayer('upload:missing-brand')], [])).resolves.toEqual({
      ready: [],
      unavailable: ['upload:missing-brand'],
    })
  })

  it('loads each distinct resolved variant once while reporting its family once', async () => {
    const variantEntry = {
      id: 'variant-test',
      name: 'Variant Test',
      family: 'Variant Test',
      category: 'sans' as const,
      languages: ['latin' as const],
      weights: [400, 700],
      styles: ['normal' as const],
      files: {
        '400-normal': '/fonts/variant-test/400-normal.woff2',
        '700-normal': '/fonts/variant-test/700-normal.woff2',
      },
      license: { name: 'SIL Open Font License 1.1', path: '/fonts/variant-test/OFL.txt' },
      fallback: 'sans-serif',
    }
    vi.doMock('../src/label/fontCatalog', async () => {
      const actual = await vi.importActual<typeof import('../src/label/fontCatalog')>('../src/label/fontCatalog')
      return {
        ...actual,
        fontEntry: (id: string) => id === variantEntry.id ? variantEntry : actual.fontEntry(id),
      }
    })
    const { waitForDesignFonts } = await freshRuntime()

    const report = await waitForDesignFonts([
      textLayer('variant-test', 400),
      textLayer('variant-test', 700),
      textLayer('variant-test', 700),
    ], [])

    expect(report).toEqual({ ready: ['Variant Test'], unavailable: [] })
    expect(FontFaceDouble.created.map((face) => face.source)).toEqual([
      'url("/fonts/variant-test/400-normal.woff2")',
      'url("/fonts/variant-test/700-normal.woff2")',
    ])
  })

  it('loads namespaced uploaded records from their data URL and preserves legacy raw-name references', async () => {
    const uploaded: UploadedFontRecord[] = [{ name: 'Brand Font', dataUrl: 'data:font/woff2;base64,d09GMg==' }]
    const { fontCssFor, waitForDesignFonts } = await freshRuntime()

    expect(fontCssFor('upload:brand-font', uploaded)).toBe('"__upload_brand_font", sans-serif')
    expect(fontCssFor('Brand Font', uploaded)).toBe('"__upload_brand_font", sans-serif')
    await expect(waitForDesignFonts([textLayer('upload:brand-font')], uploaded)).resolves.toEqual({
      ready: ['Brand Font'],
      unavailable: [],
    })
    expect(FontFaceDouble.created[0].source).toBe('url("data:font/woff2;base64,d09GMg==")')
  })

  it('strictly registers a restored uploaded record before it is used', async () => {
    const record: UploadedFontRecord = { name: 'Restored Brand', dataUrl: 'data:font/woff2;base64,UkVTVE9SRUQ=' }
    const { ensureUploadedFontLoaded } = await freshRuntime()

    await expect(ensureUploadedFontLoaded(record)).resolves.toEqual({
      id: 'upload:restored-brand', ok: true, cssFamily: '__upload_restored_brand',
    })
    expect(FontFaceDouble.created[0].source).toBe('url("data:font/woff2;base64,UkVTVE9SRUQ=")')
    expect(addFont).toHaveBeenCalledOnce()
  })

  it('reports a corrupt restored upload as unavailable without treating it as selected-ready', async () => {
    FontFaceDouble.failingSource = 'Q09SUlVQVA=='
    const record: UploadedFontRecord = { name: 'Corrupt Brand', dataUrl: 'data:font/woff2;base64,Q09SUlVQVA==' }
    const { ensureUploadedFontLoaded } = await freshRuntime()

    await expect(ensureUploadedFontLoaded(record)).resolves.toMatchObject({
      id: 'upload:corrupt-brand', ok: false, error: 'font unavailable',
    })
    expect(addFont).not.toHaveBeenCalled()
  })

  it('keeps distinct non-Latin uploaded font names in their stable namespace', async () => {
    const { uploadedFontId } = await freshRuntime()

    expect(uploadedFontId('思源黑体')).toBe('upload:思源黑体')
    expect(uploadedFontId('霞鹜文楷')).toBe('upload:霞鹜文楷')
    expect(uploadedFontId('思源黑体')).not.toBe(uploadedFontId('霞鹜文楷'))
  })

  it('uses deterministic catalog and legacy fallback CSS families', async () => {
    const { fontCssFor } = await freshRuntime()

    expect(fontCssFor('inter', [])).toBe('"__catalog_inter", sans-serif')
    expect(fontCssFor('arial', [])).toBe('Arial, Helvetica, sans-serif')
    expect(fontCssFor('Unknown Legacy Face', [])).toBe('ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif')
  })

  it('uses the approved safe stack verbatim without loading its fallback families as assets', async () => {
    const { deriveDesignFontRequests, fontCssFor } = await freshRuntime()
    const layer = { ...(textLayer('Noto Sans CJK SC') as Extract<LabelLayer, { kind: 'text' }>), fontStack: ['Noto Sans CJK SC', 'system-ui', 'sans-serif'] }

    expect(fontCssFor(layer.fontFamily, [], layer.fontStack)).toBe('"Noto Sans CJK SC",system-ui,sans-serif')
    expect(deriveDesignFontRequests([layer], [])).toEqual([])
    expect(FontFaceDouble.created).toEqual([])
  })

  it('preserves every legacy system stack including the dedicated Hei stack', async () => {
    const { fontCssFor, SYSTEM_FONT_ENTRIES } = await freshRuntime()

    expect([
      fontCssFor('系统默认', []),
      fontCssFor('PingFang SC', []),
      fontCssFor('Microsoft YaHei', []),
      fontCssFor('noto-sans-cjk-system', []),
      fontCssFor('宋体 (Serif)', []),
      fontCssFor('黑体 (Hei)', []),
      fontCssFor('Times', []),
      fontCssFor('Georgia', []),
      fontCssFor('Arial', []),
      fontCssFor('Impact', []),
      fontCssFor('Courier', []),
    ]).toEqual([
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
      '"PingFang SC", "Microsoft YaHei", sans-serif',
      '"Microsoft YaHei", "PingFang SC", sans-serif',
      '"Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
      'SimSun, "Songti SC", serif',
      'SimHei, "Heiti SC", sans-serif',
      'Times, "Times New Roman", serif',
      'Georgia, serif',
      'Arial, Helvetica, sans-serif',
      'Impact, Haettenschweiler, sans-serif',
      '"Courier New", Courier, monospace',
    ])
    expect(SYSTEM_FONT_ENTRIES).toHaveLength(11)
  })
})
