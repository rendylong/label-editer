import { color as parseCssColor, SyntaxFlag } from '@csstools/css-color-parser'
import {
  isCommentNode,
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
  isWhitespaceNode,
  parseComponentValue,
  type ComponentValue,
} from '@csstools/css-parser-algorithms'
import { isTokenComma, isTokenPercentage, tokenize } from '@csstools/css-tokenizer'

const UNSUPPORTED_CHROMIUM_FLAGS = [
  SyntaxFlag.ColorMixVariadic,
  SyntaxFlag.Experimental,
  SyntaxFlag.RelativeAlphaSyntax,
] as const

function chromiumCompatibleColorMix(node: ComponentValue): boolean {
  if (!isFunctionNode(node) || node.getName().toLowerCase() !== 'color-mix') return true

  const segments: ComponentValue[][] = [[]]
  for (const entry of node.value) {
    if (isTokenNode(entry) && isTokenComma(entry.value)) segments.push([])
    else segments.at(-1)!.push(entry)
  }
  if (segments.length !== 3) return false

  const colorStop = (segment: ComponentValue[]): { valid: boolean, literalWeight?: number } => {
    const values = segment.filter((entry) => !isWhitespaceNode(entry) && !isCommentNode(entry))
    if (values.length < 1 || values.length > 2) return { valid: false }
    const percentage = values.find((entry) => isTokenNode(entry) && isTokenPercentage(entry.value))
    return {
      valid: true,
      literalWeight: percentage && isTokenNode(percentage) && isTokenPercentage(percentage.value)
        ? percentage.value[4].value
        : undefined,
    }
  }
  const first = colorStop(segments[1])
  const second = colorStop(segments[2])
  if (!first.valid || !second.valid) return false
  const firstWeight = first.literalWeight
  const secondWeight = second.literalWeight
  return firstWeight === undefined || secondWeight === undefined || firstWeight + secondWeight > 0
}

function chromiumCompatibleColorSyntax(node: ComponentValue): boolean {
  if (!chromiumCompatibleColorMix(node)) return false
  if (!isFunctionNode(node) && !isSimpleBlockNode(node)) return true
  return node.value.every(chromiumCompatibleColorSyntax)
}

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
    if (parsed === false
      || UNSUPPORTED_CHROMIUM_FLAGS.some((flag) => parsed.syntaxFlags.has(flag))
      || !chromiumCompatibleColorSyntax(component)
      || typeof parsed.alpha !== 'number') return false
    return parsed.alpha <= 0
      || (Number.isNaN(parsed.alpha) && parsed.syntaxFlags.has(SyntaxFlag.HasNoneKeywords))
  } catch {
    return false
  }
}
