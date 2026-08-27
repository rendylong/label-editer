const GENERIC_FAMILIES = new Set(['serif','sans-serif','monospace','cursive','fantasy','system-ui','ui-serif','ui-sans-serif','ui-monospace','ui-rounded','math','fangsong','emoji'])
const CATALOG_FAMILIES = [
  ['noto-sans-arabic', 'Noto Sans Arabic'], ['noto-sans-sc', 'Noto Sans SC'], ['noto-serif-sc', 'Noto Serif SC'],
  ['source-han-sans-sc', 'Source Han Sans SC'], ['source-han-serif-sc', 'Source Han Serif SC'], ['lxgw-wenkai', 'LXGW WenKai'],
  ['zcool-qingke-huangyou', 'ZCOOL QingKe HuangYou'], ['zcool-xiaowei', 'ZCOOL XiaoWei'], ['ma-shan-zheng', 'Ma Shan Zheng'],
  ['long-cang', 'Long Cang'], ['liu-jian-mao-cao', 'Liu Jian Mao Cao'], ['zhi-mang-xing', 'Zhi Mang Xing'], ['noto-sans-tc', 'Noto Sans TC'],
  ['inter', 'Inter'], ['montserrat', 'Montserrat'], ['roboto', 'Roboto'], ['open-sans', 'Open Sans'], ['lato', 'Lato'], ['poppins', 'Poppins'],
  ['manrope', 'Manrope'], ['dm-sans', 'DM Sans'], ['nunito-sans', 'Nunito Sans'], ['work-sans', 'Work Sans'], ['raleway', 'Raleway'],
  ['urbanist', 'Urbanist'], ['outfit', 'Outfit'], ['figtree', 'Figtree'], ['source-sans-3', 'Source Sans 3'], ['ibm-plex-sans', 'IBM Plex Sans'],
  ['playfair-display', 'Playfair Display'], ['cormorant-garamond', 'Cormorant Garamond'], ['libre-baskerville', 'Libre Baskerville'],
  ['lora', 'Lora'], ['merriweather', 'Merriweather'], ['eb-garamond', 'EB Garamond'], ['dm-serif-display', 'DM Serif Display'],
  ['bodoni-moda', 'Bodoni Moda'], ['prata', 'Prata'], ['cinzel', 'Cinzel'], ['spectral', 'Spectral'], ['source-serif-4', 'Source Serif 4'],
  ['oswald', 'Oswald'], ['bebas-neue', 'Bebas Neue'], ['roboto-condensed', 'Roboto Condensed'], ['archivo-narrow', 'Archivo Narrow'],
  ['barlow-condensed', 'Barlow Condensed'], ['anton', 'Anton'], ['fjalla-one', 'Fjalla One'], ['teko', 'Teko'],
  ['staatliches', 'Staatliches'], ['league-gothic', 'League Gothic'], ['caveat', 'Caveat'], ['dancing-script', 'Dancing Script'],
  ['pacifico', 'Pacifico'], ['sacramento', 'Sacramento'], ['great-vibes', 'Great Vibes'], ['satisfy', 'Satisfy'],
  ['ibm-plex-mono', 'IBM Plex Mono'], ['jetbrains-mono', 'JetBrains Mono'], ['space-mono', 'Space Mono'], ['roboto-mono', 'Roboto Mono'],
]
const FAMILY_ALIASES = new Map(CATALOG_FAMILIES.flatMap(([id, name]) => [[id, id], [name.toLocaleLowerCase(), id]]))
for (const [alias, id] of [['times','times'],['georgia','georgia'],['arial','arial'],['impact','impact'],['courier','courier-new'],['courier new','courier-new'],['pingfang sc','pingfang-sc'],['microsoft yahei','microsoft-yahei'],['noto sans cjk','noto-sans-sc'],['系统默认','system-sans'],['宋体 (serif)','system-serif'],['黑体 (hei)','system-hei']]) FAMILY_ALIASES.set(alias, id)
const CSS_ALIASES = new Map(CATALOG_FAMILIES.map(([id, name]) => [id, name]))
for (const [id, css] of [['arial','Arial'],['times','Times'],['georgia','Georgia'],['impact','Impact'],['courier-new','Courier New'],['pingfang-sc','PingFang SC'],['microsoft-yahei','Microsoft YaHei'],['system-sans','system-ui'],['system-serif','serif'],['system-hei','sans-serif']]) CSS_ALIASES.set(id, css)
export function canonicalPortableFontFamily(family) {
  const trimmed = family.trim(); const normalized = trimmed.toLocaleLowerCase()
  return GENERIC_FAMILIES.has(normalized) ? normalized : FAMILY_ALIASES.get(normalized) ?? trimmed
}
export function canonicalPortableFontStack(stack) {
  if (!validatePortableFontStack(stack)) throw new Error('Invalid fontStack')
  return stack.map(canonicalPortableFontFamily)
}
export function validatePortableFontStack(stack) {
  return Array.isArray(stack) && stack.length > 0 && stack.length <= 16
    && stack.every((family) => typeof family === 'string' && family.length > 0 && family.length <= 128 && /^[\p{L}\p{N} ._-]+$/u.test(family))
}
export function portableFontStackCss(stack) {
  if (!validatePortableFontStack(stack)) throw new Error('Invalid fontStack')
  return canonicalPortableFontStack(stack).map((family) => GENERIC_FAMILIES.has(family.toLowerCase()) ? family.toLowerCase() : `"${CSS_ALIASES.get(family) ?? family}"`).join(',')
}
