const NUMBER_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const PERCENT_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%$/i
const ANGLE_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:deg|grad|rad|turn)?$/i
const COLOR_SPACES = new Set([
  'srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020',
  'xyz', 'xyz-d50', 'xyz-d65',
])

function numericValue(token: string): number | undefined {
  const value = token.trim()
  const numeric = NUMBER_TOKEN.test(value)
    ? Number(value)
    : PERCENT_TOKEN.test(value)
      ? Number(value.slice(0, -1)) / 100
      : Number.NaN
  return Number.isFinite(numeric) ? numeric : undefined
}

function transparentAlpha(token: string): boolean {
  if (token.trim().toLowerCase() === 'none') return true
  const value = numericValue(token)
  // CSS alpha is clamped to [0, 1], so finite negative values render as zero.
  return value !== undefined && value <= 0
}

function numericOrNone(token: string): boolean {
  const value = token.toLowerCase()
  return value === 'none' || NUMBER_TOKEN.test(value) || PERCENT_TOKEN.test(value)
}

function angleOrNone(token: string): boolean {
  const value = token.toLowerCase()
  return value === 'none' || ANGLE_TOKEN.test(value)
}

function validRgbComponents(tokens: string[]): boolean {
  return tokens.length === 3 && tokens.every(numericOrNone)
}

function validHslComponents(tokens: string[]): boolean {
  return tokens.length === 3
    && angleOrNone(tokens[0])
    && numericOrNone(tokens[1])
    && numericOrNone(tokens[2])
}

function validLegacyRgbComponents(tokens: string[]): boolean {
  if (tokens.length !== 3 || tokens.some((token) => !NUMBER_TOKEN.test(token) && !PERCENT_TOKEN.test(token))) return false
  const percentage = tokens.map((token) => PERCENT_TOKEN.test(token))
  return percentage.every((value) => value === percentage[0])
}

function validLegacyHslComponents(tokens: string[]): boolean {
  return tokens.length === 3
    && ANGLE_TOKEN.test(tokens[0])
    && PERCENT_TOKEN.test(tokens[1])
    && PERCENT_TOKEN.test(tokens[2])
}

function validPortableFunctionalColor(name: string, head: string): boolean {
  const tokens = head.trim().split(/\s+/).filter(Boolean)
  if (name === 'rgb' || name === 'rgba') return validRgbComponents(tokens)
  if (name === 'hsl' || name === 'hsla' || name === 'hwb') return validHslComponents(tokens)
  if (name === 'lab' || name === 'oklab') {
    return tokens.length === 3 && tokens.every(numericOrNone)
  }
  if (name === 'lch' || name === 'oklch') {
    return tokens.length === 3
      && numericOrNone(tokens[0])
      && numericOrNone(tokens[1])
      && angleOrNone(tokens[2])
  }
  if (name === 'color') {
    return tokens.length === 4
      && COLOR_SPACES.has(tokens[0].toLowerCase())
      && tokens.slice(1).every(numericOrNone)
  }
  return false
}

function portableTransparentCssColor(color: string): boolean {
  const value = color.trim().toLowerCase()
  if (value === 'transparent') return true
  if (/^#[0-9a-f]{3}0$/.test(value) || /^#[0-9a-f]{6}00$/.test(value)) return true

  const functional = /^([a-z-]+)\(([\s\S]*)\)$/.exec(value)
  if (!functional) return false
  const [, name, body] = functional
  if (body.includes(',')) {
    if (!['rgb', 'rgba', 'hsl', 'hsla'].includes(name) || body.includes('/')) return false
    const parts = body.split(',').map((part) => part.trim())
    if (parts.length !== 4 || !transparentAlpha(parts[3])) return false
    return name === 'rgb' || name === 'rgba'
      ? validLegacyRgbComponents(parts.slice(0, 3))
      : validLegacyHslComponents(parts.slice(0, 3))
  }

  const slashParts = body.split('/')
  if (slashParts.length !== 2 || !transparentAlpha(slashParts[1])) return false
  return validPortableFunctionalColor(name, slashParts[0])
}

function browserTransparentCssColor(color: string): boolean | undefined {
  const browserCss = globalThis.CSS
  const browserDocument = globalThis.document
  if (!browserCss || typeof browserCss.supports !== 'function'
    || !browserDocument || typeof browserDocument.createElement !== 'function') return undefined
  if (!browserCss.supports('color', color)) return false
  try {
    const canvas = browserDocument.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return undefined
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data[3] === 0
  } catch {
    return undefined
  }
}

/**
 * Uses the browser's own CSS parser and rendered alpha whenever a real canvas is
 * available. Node workflows use a conservative validator for direct CSS Color
 * functions, so malformed zero-alpha-looking strings never become mask holes.
 */
export function isTransparentCssColor(color: string): boolean {
  return browserTransparentCssColor(color) ?? portableTransparentCssColor(color)
}
