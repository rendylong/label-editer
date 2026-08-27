export interface UploadedFontIdentity {
  id: string
  cssFamily: string
}

export function revisionedUploadedFontFamily(name: string, sha256: string): string {
  const normalized = normalizedUploadedFontName(name)
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Uploaded font SHA-256 is invalid')
  return `__upload_${normalized.replace(/-/g, '_')}_${sha256}`
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
