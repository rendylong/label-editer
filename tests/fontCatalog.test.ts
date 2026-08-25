import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FONT_CATALOG, fontEntry, legacyFontId, searchFonts } from '../src/label/fontCatalog'

const expectedIdsByCategory = {
  chinese: [
    'noto-sans-sc', 'noto-serif-sc', 'source-han-sans-sc', 'source-han-serif-sc',
    'lxgw-wenkai', 'zcool-qingke-huangyou', 'zcool-xiaowei', 'ma-shan-zheng',
    'long-cang', 'liu-jian-mao-cao', 'zhi-mang-xing', 'noto-sans-tc',
  ],
  sans: [
    'inter', 'montserrat', 'roboto', 'open-sans', 'lato', 'poppins', 'manrope', 'dm-sans',
    'nunito-sans', 'work-sans', 'raleway', 'urbanist', 'outfit', 'figtree', 'source-sans-3', 'ibm-plex-sans',
  ],
  serif: [
    'playfair-display', 'cormorant-garamond', 'libre-baskerville', 'lora', 'merriweather',
    'eb-garamond', 'dm-serif-display', 'bodoni-moda', 'prata', 'cinzel', 'spectral', 'source-serif-4',
  ],
  display: [
    'oswald', 'bebas-neue', 'roboto-condensed', 'archivo-narrow', 'barlow-condensed',
    'anton', 'fjalla-one', 'teko', 'staatliches', 'league-gothic',
  ],
  handwriting: ['caveat', 'dancing-script', 'pacifico', 'sacramento', 'great-vibes', 'satisfy'],
  mono: ['ibm-plex-mono', 'jetbrains-mono', 'space-mono', 'roboto-mono'],
  arabic: ['noto-sans-arabic'],
} as const

describe('font catalog', () => {
  it('contains the curated families plus a bundled Arabic family', () => {
    expect(FONT_CATALOG).toHaveLength(61)
    expect(new Set(FONT_CATALOG.map((font) => font.id)).size).toBe(61)

    for (const [category, ids] of Object.entries(expectedIdsByCategory)) {
      expect(FONT_CATALOG.filter((font) => font.category === category).map((font) => font.id)).toEqual(ids)
    }
  })

  it('provides real Arabic coverage instead of a system fallback', () => {
    expect(fontEntry('noto-sans-arabic')).toMatchObject({ category: 'arabic', languages: expect.arrayContaining(['ar', 'latin']) })
  })

  it('maps old saved names to stable ids while preserving unknown names', () => {
    expect(legacyFontId('Arial')).toBe('arial')
    expect(legacyFontId('系统默认')).toBe('system-sans')
    expect(legacyFontId('PingFang SC')).toBe('pingfang-sc')
    expect(legacyFontId('Playfair Display')).toBe('playfair-display')
    expect(legacyFontId('黑体 (Hei)')).toBe('system-hei')
    expect(legacyFontId('Unmapped Brand Font')).toBe('Unmapped Brand Font')
  })

  it('looks up stable ids and searches by display name, family, and category', () => {
    expect(fontEntry('inter')?.name).toBe('Inter')
    expect(fontEntry('missing-font')).toBeNull()
    expect(searchFonts('playfair').map((font) => font.id)).toContain('playfair-display')
    expect(searchFonts('IBM Plex Sans').map((font) => font.id)).toContain('ibm-plex-sans')
    expect(searchFonts('', 'chinese')).toHaveLength(12)
    expect(searchFonts('sans', 'serif')).toEqual([])
  })

  it('exposes only entries with real normal-400 WOFF2 assets and license metadata', () => {
    for (const entry of FONT_CATALOG) {
      const fontPath = resolve(process.cwd(), `public${entry.files['400-normal']}`)
      const licensePath = resolve(process.cwd(), `public${entry.license.path}`)
      expect(existsSync(fontPath), `${entry.id} is missing ${fontPath}`).toBe(true)
      const signature = readFileSync(fontPath).subarray(0, 4)
      expect([signature.toString('ascii'), signature.toString('hex')], `${entry.id} is not WOFF2 or TrueType`).toEqual(expect.arrayContaining([expect.stringMatching(/^(wOF2|00010000)$/)]))
      expect(existsSync(licensePath), `${entry.id} is missing ${licensePath}`).toBe(true)
      expect(readFileSync(licensePath, 'utf8').trim().length, `${entry.id} has an empty license`).toBeGreaterThan(100)
    }
  })

  it('reports the upstream license instead of labeling every font as OFL', () => {
    expect(fontEntry('satisfy')?.license).toEqual({
      name: 'Apache License 2.0',
      path: '/fonts/satisfy/LICENSE.txt',
    })
    expect(fontEntry('inter')?.license.name).toBe('SIL Open Font License 1.1')
  })
})
