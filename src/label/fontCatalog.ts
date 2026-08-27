import { canonicalPortableFontFamily } from '../../scripts/lib/font-stack-core.mjs'

export type FontCategory = 'chinese' | 'arabic' | 'sans' | 'serif' | 'display' | 'handwriting' | 'mono'

export interface FontCatalogEntry {
  id: string
  name: string
  family: string
  category: FontCategory
  languages: Array<'zh-Hans' | 'zh-Hant' | 'ar' | 'latin'>
  weights: number[]
  styles: Array<'normal' | 'italic'>
  files: Partial<Record<`${number}-${'normal' | 'italic'}`, string>>
  license: { name: string; path: string }
  fallback: string
}

const OFL = 'SIL Open Font License 1.1'

function catalogEntry(
  id: string,
  name: string,
  category: FontCategory,
  languages: FontCatalogEntry['languages'] = ['latin'],
  license: FontCatalogEntry['license'] = { name: OFL, path: `/fonts/${id}/OFL.txt` },
  normalAsset = `/fonts/${id}/400-normal.woff2`,
): FontCatalogEntry {
  const genericFallback = category === 'serif' ? 'serif' : category === 'mono' ? 'monospace' : 'sans-serif'
  const fallback = category === 'chinese'
    ? '"PingFang SC", "Microsoft YaHei", sans-serif'
    : genericFallback
  return {
    id,
    name,
    family: name,
    category,
    languages,
    weights: [400],
    styles: ['normal'],
    files: { '400-normal': normalAsset },
    license,
    fallback,
  }
}

/**
 * First-release font manifest. The ordering is intentional and is also the
 * ordering used by category browsers.
 */
export const FONT_CATALOG: FontCatalogEntry[] = [
  catalogEntry('noto-sans-arabic', 'Noto Sans Arabic', 'arabic', ['ar', 'latin'], { name: OFL, path: '/fonts/noto-sans-arabic/OFL.txt' }, '/fonts/noto-sans-arabic/400-normal.ttf'),
  catalogEntry('noto-sans-sc', 'Noto Sans SC', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('noto-serif-sc', 'Noto Serif SC', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('source-han-sans-sc', 'Source Han Sans SC', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('source-han-serif-sc', 'Source Han Serif SC', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('lxgw-wenkai', 'LXGW WenKai', 'chinese', ['zh-Hans', 'zh-Hant', 'latin']),
  catalogEntry('zcool-qingke-huangyou', 'ZCOOL QingKe HuangYou', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('zcool-xiaowei', 'ZCOOL XiaoWei', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('ma-shan-zheng', 'Ma Shan Zheng', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('long-cang', 'Long Cang', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('liu-jian-mao-cao', 'Liu Jian Mao Cao', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('zhi-mang-xing', 'Zhi Mang Xing', 'chinese', ['zh-Hans', 'latin']),
  catalogEntry('noto-sans-tc', 'Noto Sans TC', 'chinese', ['zh-Hant', 'latin']),

  catalogEntry('inter', 'Inter', 'sans'),
  catalogEntry('montserrat', 'Montserrat', 'sans'),
  catalogEntry('roboto', 'Roboto', 'sans'),
  catalogEntry('open-sans', 'Open Sans', 'sans'),
  catalogEntry('lato', 'Lato', 'sans'),
  catalogEntry('poppins', 'Poppins', 'sans'),
  catalogEntry('manrope', 'Manrope', 'sans'),
  catalogEntry('dm-sans', 'DM Sans', 'sans'),
  catalogEntry('nunito-sans', 'Nunito Sans', 'sans'),
  catalogEntry('work-sans', 'Work Sans', 'sans'),
  catalogEntry('raleway', 'Raleway', 'sans'),
  catalogEntry('urbanist', 'Urbanist', 'sans'),
  catalogEntry('outfit', 'Outfit', 'sans'),
  catalogEntry('figtree', 'Figtree', 'sans'),
  catalogEntry('source-sans-3', 'Source Sans 3', 'sans'),
  catalogEntry('ibm-plex-sans', 'IBM Plex Sans', 'sans'),

  catalogEntry('playfair-display', 'Playfair Display', 'serif'),
  catalogEntry('cormorant-garamond', 'Cormorant Garamond', 'serif'),
  catalogEntry('libre-baskerville', 'Libre Baskerville', 'serif'),
  catalogEntry('lora', 'Lora', 'serif'),
  catalogEntry('merriweather', 'Merriweather', 'serif'),
  catalogEntry('eb-garamond', 'EB Garamond', 'serif'),
  catalogEntry('dm-serif-display', 'DM Serif Display', 'serif'),
  catalogEntry('bodoni-moda', 'Bodoni Moda', 'serif'),
  catalogEntry('prata', 'Prata', 'serif'),
  catalogEntry('cinzel', 'Cinzel', 'serif'),
  catalogEntry('spectral', 'Spectral', 'serif'),
  catalogEntry('source-serif-4', 'Source Serif 4', 'serif'),

  catalogEntry('oswald', 'Oswald', 'display'),
  catalogEntry('bebas-neue', 'Bebas Neue', 'display'),
  catalogEntry('roboto-condensed', 'Roboto Condensed', 'display'),
  catalogEntry('archivo-narrow', 'Archivo Narrow', 'display'),
  catalogEntry('barlow-condensed', 'Barlow Condensed', 'display'),
  catalogEntry('anton', 'Anton', 'display'),
  catalogEntry('fjalla-one', 'Fjalla One', 'display'),
  catalogEntry('teko', 'Teko', 'display'),
  catalogEntry('staatliches', 'Staatliches', 'display'),
  catalogEntry('league-gothic', 'League Gothic', 'display'),

  catalogEntry('caveat', 'Caveat', 'handwriting'),
  catalogEntry('dancing-script', 'Dancing Script', 'handwriting'),
  catalogEntry('pacifico', 'Pacifico', 'handwriting'),
  catalogEntry('sacramento', 'Sacramento', 'handwriting'),
  catalogEntry('great-vibes', 'Great Vibes', 'handwriting'),
  catalogEntry('satisfy', 'Satisfy', 'handwriting', ['latin'], {
    name: 'Apache License 2.0',
    path: '/fonts/satisfy/LICENSE.txt',
  }),

  catalogEntry('ibm-plex-mono', 'IBM Plex Mono', 'mono'),
  catalogEntry('jetbrains-mono', 'JetBrains Mono', 'mono'),
  catalogEntry('space-mono', 'Space Mono', 'mono'),
  catalogEntry('roboto-mono', 'Roboto Mono', 'mono'),
]

const entriesById = new Map(FONT_CATALOG.map((entry) => [entry.id, entry]))
/** Map a legacy display name to its stable reference; unknown names survive. */
export function legacyFontId(name: string): string {
  return canonicalPortableFontFamily(name)
}

export function fontEntry(id: string): FontCatalogEntry | null {
  return entriesById.get(id) ?? null
}

export function searchFonts(query: string, category?: FontCategory): FontCatalogEntry[] {
  const normalized = query.trim().toLocaleLowerCase()
  return FONT_CATALOG.filter((entry) => {
    if (category && entry.category !== category) return false
    if (!normalized) return true
    return `${entry.id} ${entry.name} ${entry.family}`.toLocaleLowerCase().includes(normalized)
  })
}
