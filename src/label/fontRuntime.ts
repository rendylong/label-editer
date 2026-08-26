import { FONT_STACKS, type LabelLayer, type UploadedFontRecord } from './types'
import { fontEntry, legacyFontId, type FontCatalogEntry } from './fontCatalog'
import { fontStackCss } from './fontStack'

export interface FontLoadResult {
  id: string
  ok: boolean
  cssFamily: string
  error?: string
}

export interface FontLoadReport {
  ready: string[]
  unavailable: string[]
}

type FontStyle = 'normal' | 'italic'
type ResolvedAsset = { weight: number; style: FontStyle; path: string }

export interface SystemFontEntry {
  id: string
  name: string
  css: string
}

export type DesignFontRequest =
  | { key: string; kind: 'catalog'; id: string; name: string; weight: number; style: FontStyle }
  | { key: string; kind: 'uploaded'; id: string; name: string; record: UploadedFontRecord }
  | { key: string; kind: 'system'; id: string; name: string; css: string }
  | { key: string; kind: 'unresolved'; id: string; name: string }

const fontLoads = new Map<string, Promise<FontLoadResult>>()
const uploadedFontLoads = new Map<string, Promise<FontLoadResult>>()

const SYSTEM_FONT_IDS = [
  'system-sans', 'pingfang-sc', 'microsoft-yahei', 'noto-sans-cjk-system', 'system-serif',
  'system-hei', 'times', 'georgia', 'arial', 'impact', 'courier-new',
] as const

/** Selectable legacy/system faces. They are immediately ready and retain their exact CSS stacks. */
export const SYSTEM_FONT_ENTRIES: SystemFontEntry[] = FONT_STACKS.map((font, index) => ({
  id: SYSTEM_FONT_IDS[index],
  name: font.name,
  css: font.css,
}))

const systemFontsByRef = new Map<string, SystemFontEntry>()
for (const font of SYSTEM_FONT_ENTRIES) {
  systemFontsByRef.set(font.id.toLocaleLowerCase(), font)
  systemFontsByRef.set(font.name.toLocaleLowerCase(), font)
}

export function systemFontEntry(ref: string): SystemFontEntry | null {
  return systemFontsByRef.get(ref.trim().toLocaleLowerCase()) ?? null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function firstCssFamily(css: string): string {
  return css.split(',')[0].trim().replace(/^"|"$/g, '')
}

function catalogFamily(id: string): string {
  return `__catalog_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function sanitizeUploadedName(name: string): string {
  const sanitized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || 'font'
}

export function uploadedFontId(name: string): string {
  return `upload:${sanitizeUploadedName(name)}`
}

export function uploadFamily(name: string): string {
  return `__upload_${sanitizeUploadedName(name).replace(/-/g, '_')}`
}

export function uploadedFontRecord(ref: string, uploaded: UploadedFontRecord[]): UploadedFontRecord | undefined {
  return uploaded.find((record) => record.name === ref || uploadedFontId(record.name) === ref)
}

function resolveAsset(entry: FontCatalogEntry, requestedWeight: number, requestedStyle: FontStyle): ResolvedAsset | null {
  const variants = Object.entries(entry.files).flatMap(([key, path]) => {
    if (!path) return []
    const match = /^(\d+)-(normal|italic)$/.exec(key)
    if (!match) return []
    return [{ weight: Number(match[1]), style: match[2] as FontStyle, path }]
  })
  if (variants.length === 0) return null

  const preferredStyle = variants.some((variant) => variant.style === requestedStyle)
    ? requestedStyle
    : variants.some((variant) => variant.style === 'normal') ? 'normal' : variants[0].style

  return variants
    .filter((variant) => variant.style === preferredStyle)
    .sort((a, b) => Math.abs(a.weight - requestedWeight) - Math.abs(b.weight - requestedWeight) || a.weight - b.weight)[0] ?? null
}

function failedResult(id: string, cssFamily: string, error: string): FontLoadResult {
  return { id, ok: false, cssFamily, error }
}

/** Load one catalog face on demand. Unsupported variants use the nearest manifest asset. */
export function ensureFontLoaded(id: string, weight: number, style: FontStyle): Promise<FontLoadResult> {
  const entry = fontEntry(id)
  if (!entry) return Promise.resolve(failedResult(id, 'ui-sans-serif', `Unknown catalog font: ${id}`))

  const asset = resolveAsset(entry, weight, style)
  if (!asset) return Promise.resolve(failedResult(id, firstCssFamily(entry.fallback), `No local asset for ${id}`))

  const cacheKey = `${id}/${asset.weight}/${asset.style}`
  const cached = fontLoads.get(cacheKey)
  if (cached) return cached

  const family = catalogFamily(id)
  const load = (async (): Promise<FontLoadResult> => {
    try {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
        throw new Error('FontFace API is unavailable')
      }
      const face = new FontFace(family, `url("${asset.path}")`, {
        weight: String(asset.weight),
        style: asset.style,
      })
      const loadedFace = await face.load()
      document.fonts.add(loadedFace)
      await document.fonts.ready
      return { id, ok: true, cssFamily: family }
    } catch (error) {
      return failedResult(id, firstCssFamily(entry.fallback), errorMessage(error))
    }
  })()

  fontLoads.set(cacheKey, load)
  return load
}

/** Register a serialized uploaded font before selection, preview, canvas draw, or export. */
export function ensureUploadedFontLoaded(record: UploadedFontRecord): Promise<FontLoadResult> {
  const id = uploadedFontId(record.name)
  const cacheKey = `${id}/${record.dataUrl}`
  const cached = uploadedFontLoads.get(cacheKey)
  if (cached) return cached

  const family = uploadFamily(record.name)
  const load = (async (): Promise<FontLoadResult> => {
    try {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
        throw new Error('FontFace API is unavailable')
      }
      const face = new FontFace(family, `url("${record.dataUrl}")`)
      const loadedFace = await face.load()
      document.fonts.add(loadedFace)
      await document.fonts.ready
      return { id, ok: true, cssFamily: family }
    } catch (error) {
      return failedResult(id, 'sans-serif', errorMessage(error))
    }
  })()

  uploadedFontLoads.set(cacheKey, load)
  return load
}

function uploadRevision(record: UploadedFontRecord): string {
  const payload = record.dataUrl.slice(record.dataUrl.lastIndexOf(',') + 1)
  return `${record.dataUrl.length}-${payload.slice(-12)}`
}

/** Derive a stable, deduplicated load plan from only the text faces used by an area. */
export function deriveDesignFontRequests(layers: LabelLayer[], uploaded: UploadedFontRecord[]): DesignFontRequest[] {
  const requests = new Map<string, DesignFontRequest>()

  for (const layer of layers) {
    if (layer.kind !== 'text') continue
    if (layer.fontStack?.length) continue

    const record = uploadedFontRecord(layer.fontFamily, uploaded)
    if (record) {
      const id = uploadedFontId(record.name)
      const key = `uploaded/${id}/${uploadRevision(record)}`
      if (!requests.has(key)) requests.set(key, { key, kind: 'uploaded', id, name: record.name, record })
      continue
    }

    const system = systemFontEntry(layer.fontFamily)
    if (system) {
      const key = `system/${system.id}`
      if (!requests.has(key)) requests.set(key, { key, kind: 'system', id: system.id, name: system.name, css: system.css })
      continue
    }

    const stableId = legacyFontId(layer.fontFamily)
    const entry = fontEntry(stableId)
    if (!entry) {
      const key = `unresolved/${layer.fontFamily}`
      if (!requests.has(key)) requests.set(key, { key, kind: 'unresolved', id: layer.fontFamily, name: layer.fontFamily })
      continue
    }

    const weight = typeof layer.fontWeight === 'number' ? layer.fontWeight : layer.fontWeight === 'bold' ? 700 : 400
    const style = layer.italic ? 'italic' : 'normal'
    const asset = resolveAsset(entry, weight, style)
    const key = asset ? `catalog/${entry.id}/${asset.weight}/${asset.style}` : `catalog/${entry.id}/unavailable`
    if (!requests.has(key)) requests.set(key, { key, kind: 'catalog', id: entry.id, name: entry.name, weight, style })
  }

  return [...requests.values()]
}

export async function loadDesignFontRequests(requests: DesignFontRequest[]): Promise<FontLoadReport> {
  const ready = new Set<string>()
  const unavailable = new Set<string>()
  await Promise.all(requests.map(async (request) => {
    let result: FontLoadResult
    if (request.kind === 'catalog') result = await ensureFontLoaded(request.id, request.weight, request.style)
    else if (request.kind === 'uploaded') result = await ensureUploadedFontLoaded(request.record)
    else if (request.kind === 'system') result = { id: request.id, ok: true, cssFamily: firstCssFamily(request.css) }
    else result = failedResult(request.id, 'ui-sans-serif', `Unresolved font reference: ${request.id}`)
    ;(result.ok ? ready : unavailable).add(request.name)
  }))
  return { ready: [...ready], unavailable: [...unavailable] }
}

/** Wait for only the font families referenced by text layers. */
export async function waitForDesignFonts(layers: LabelLayer[], uploaded: UploadedFontRecord[]): Promise<FontLoadReport> {
  return loadDesignFontRequests(deriveDesignFontRequests(layers, uploaded))
}

/** Resolve a serialized font reference to a deterministic CSS fallback chain. */
export function fontCssFor(ref: string, uploaded: UploadedFontRecord[], fontStack?: string[]): string {
  if (fontStack?.length) return fontStackCss(fontStack)
  const record = uploadedFontRecord(ref, uploaded)
  if (record) return `"${uploadFamily(record.name)}", sans-serif`

  const system = systemFontEntry(ref)
  if (system) return system.css
  const stableId = legacyFontId(ref)
  const entry = fontEntry(stableId)
  if (entry) return `"${catalogFamily(entry.id)}", ${entry.fallback}`
  return systemFontEntry(stableId)?.css ?? FONT_STACKS[0].css
}
