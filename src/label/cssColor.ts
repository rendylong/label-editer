function isZeroAlphaToken(value: string): boolean {
  const token = value.trim().toLowerCase()
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%)?$/.exec(token)
  if (!match) return false
  const numeric = Number(match[1])
  return Number.isFinite(numeric) && numeric === 0
}

/**
 * Classifies the zero-alpha CSS colors accepted by label shape inputs without
 * depending on DOM or canvas color canonicalization (the craft path also runs in Node).
 */
export function isTransparentCssColor(color: string): boolean {
  const value = color.trim().toLowerCase()
  if (value === 'transparent') return true
  if (/^#[0-9a-f]{3}0$/.test(value) || /^#[0-9a-f]{6}00$/.test(value)) return true

  const functional = /^(?:rgba?|hsla?)\(([\s\S]*)\)$/.exec(value)
  if (!functional) return false
  const body = functional[1]
  const slashParts = body.split('/')
  if (slashParts.length === 2 && slashParts[0].trim() && isZeroAlphaToken(slashParts[1])) return true
  if (slashParts.length !== 1) return false
  const commaParts = body.split(',')
  return commaParts.length === 4
    && commaParts.slice(0, 3).every((part) => part.trim().length > 0)
    && isZeroAlphaToken(commaParts[3])
}
