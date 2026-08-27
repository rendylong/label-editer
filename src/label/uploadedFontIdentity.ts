export interface UploadedFontIdentity {
  id: string
  cssFamily: string
}

function normalizedUploadedFontName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'font'
}

/** One identity source for project validation, runtime lookup, and CSS registration. */
export function uploadedFontIdentity(name: string): UploadedFontIdentity {
  const normalized = normalizedUploadedFontName(name)
  return {
    id: `upload:${normalized}`,
    cssFamily: `__upload_${normalized.replace(/-/g, '_')}`,
  }
}
