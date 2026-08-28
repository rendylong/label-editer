import { color as parseCssColor } from '@csstools/css-color-parser'
import { parseComponentValue } from '@csstools/css-parser-algorithms'
import { tokenize } from '@csstools/css-tokenizer'

/**
 * Resolve transparency through one DOM-free CSS Color parser in Node and the
 * browser. Invalid or context-dependent colors fail closed as non-transparent.
 */
export function isTransparentCssColor(value: string): boolean {
  try {
    const source = value.trim()
    if (!source) return false
    const component = parseComponentValue(tokenize({ css: source }))
    if (component === undefined) return false
    const parsed = parseCssColor(component)
    return parsed !== false
      && typeof parsed.alpha === 'number'
      && (parsed.alpha <= 0 || Number.isNaN(parsed.alpha))
  } catch {
    return false
  }
}
