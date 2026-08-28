import { color as parseCssColor, SyntaxFlag } from '@csstools/css-color-parser'
import {
  isCommentNode,
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
  isWhitespaceNode,
  parseListOfComponentValues,
  type ComponentValue,
} from '@csstools/css-parser-algorithms'
import {
  isTokenComma,
  isTokenDelim,
  isTokenDimension,
  isTokenIdent,
  isTokenNumber,
  isTokenPercentage,
  tokenize,
} from '@csstools/css-tokenizer'

const MAX_CSS_COLOR_LENGTH = 4096
const MAX_COMPONENT_NODES = 512
const MAX_COMPONENT_DEPTH = 24

const UNSUPPORTED_CHROMIUM_FLAGS = [
  SyntaxFlag.ColorMixVariadic,
  SyntaxFlag.Experimental,
  SyntaxFlag.RelativeAlphaSyntax,
] as const

interface NumericValue {
  value: number
  dimensions: Map<string, number>
}

interface ColorStop {
  color: ComponentValue
  weight?: { value: number, literal: boolean }
}

const UNIT_SCALE = new Map<string, readonly [kind: string, factor: number]>([
  ['deg', ['angle', 1]], ['grad', ['angle', 0.9]], ['rad', ['angle', 180 / Math.PI]], ['turn', ['angle', 360]],
  ['px', ['length', 1]], ['in', ['length', 96]], ['cm', ['length', 96 / 2.54]],
  ['mm', ['length', 96 / 25.4]], ['q', ['length', 96 / 101.6]], ['pt', ['length', 4 / 3]], ['pc', ['length', 16]],
  ['s', ['time', 1]], ['ms', ['time', 0.001]],
  ['hz', ['frequency', 1]], ['khz', ['frequency', 1000]],
  ['dppx', ['resolution', 1]], ['dpi', ['resolution', 1 / 96]], ['dpcm', ['resolution', 2.54 / 96]],
])

function significant(values: ComponentValue[]): ComponentValue[] {
  return values.filter((entry) => !isWhitespaceNode(entry) && !isCommentNode(entry))
}

function boundedComponentTree(node: ComponentValue, depth = 0, state = { count: 0 }): boolean {
  if (depth > MAX_COMPONENT_DEPTH || ++state.count > MAX_COMPONENT_NODES) return false
  if (!isFunctionNode(node) && !isSimpleBlockNode(node)) return true
  return node.value.every((child) => boundedComponentTree(child, depth + 1, state))
}

function singleComponent(source: string): ComponentValue | undefined {
  const values = significant(parseListOfComponentValues(tokenize({ css: source })))
  if (values.length !== 1 || !boundedComponentTree(values[0])) return undefined
  return values[0]
}

function contextualColor(node: ComponentValue): boolean {
  if (isTokenNode(node) && isTokenIdent(node.value)) {
    return node.value[4].value.toLowerCase() === 'currentcolor'
  }
  if (!isFunctionNode(node) && !isSimpleBlockNode(node)) return false
  if (isFunctionNode(node) && ['var', 'env', 'attr'].includes(node.getName().toLowerCase())) return true
  return node.value.some(contextualColor)
}

function sameDimensions(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false
  return [...left].every(([name, exponent]) => right.get(name) === exponent)
}

function combineDimensions(left: Map<string, number>, right: Map<string, number>, sign: 1 | -1): Map<string, number> {
  const result = new Map(left)
  for (const [name, exponent] of right) {
    const next = (result.get(name) ?? 0) + sign * exponent
    if (next === 0) result.delete(name)
    else result.set(name, next)
  }
  return result
}

function numericToken(node: ComponentValue): NumericValue | undefined {
  if (!isTokenNode(node)) return undefined
  if (isTokenNumber(node.value)) return { value: node.value[4].value, dimensions: new Map() }
  if (isTokenPercentage(node.value)) {
    return { value: node.value[4].value, dimensions: new Map([['percentage', 1]]) }
  }
  if (!isTokenDimension(node.value)) return undefined
  const unit = UNIT_SCALE.get(node.value[4].unit.toLowerCase())
  if (!unit) return undefined
  return { value: node.value[4].value * unit[1], dimensions: new Map([[unit[0], 1]]) }
}

function operator(node: ComponentValue): string | undefined {
  return isTokenNode(node) && isTokenDelim(node.value) ? node.value[4].value : undefined
}

function evaluateMath(values: ComponentValue[], depth = 0): NumericValue | undefined {
  if (depth > MAX_COMPONENT_DEPTH) return undefined
  const nodes = significant(values)
  let index = 0

  const factor = (): NumericValue | undefined => {
    const node = nodes[index++]
    if (!node) return undefined
    const numeric = numericToken(node)
    if (numeric) return numeric
    if (isFunctionNode(node)) {
      const name = node.getName().toLowerCase()
      if (name === 'calc') return evaluateMath(node.value, depth + 1)
      if (['min', 'max', 'clamp'].includes(name)) {
        const segments: ComponentValue[][] = [[]]
        for (const entry of node.value) {
          if (isTokenNode(entry) && isTokenComma(entry.value)) segments.push([])
          else segments.at(-1)!.push(entry)
        }
        if ((name === 'clamp' && segments.length !== 3)
          || (name !== 'clamp' && segments.length < 1)) return undefined
        const candidates = segments.map((segment) => evaluateMath(segment, depth + 1))
        if (candidates.some((candidate) => candidate === undefined)) return undefined
        const resolved = candidates as NumericValue[]
        if (!resolved.every((candidate) => sameDimensions(candidate.dimensions, resolved[0].dimensions))) return undefined
        if (name === 'min') return { value: Math.min(...resolved.map(({ value }) => value)), dimensions: resolved[0].dimensions }
        if (name === 'max') return { value: Math.max(...resolved.map(({ value }) => value)), dimensions: resolved[0].dimensions }
        return {
          value: Math.max(resolved[0].value, Math.min(resolved[1].value, resolved[2].value)),
          dimensions: resolved[0].dimensions,
        }
      }
    }
    if (isSimpleBlockNode(node) && node.startToken[1] === '(') {
      return evaluateMath(node.value, depth + 1)
    }
    return undefined
  }

  const product = (): NumericValue | undefined => {
    let result = factor()
    if (!result) return undefined
    while (index < nodes.length && ['*', '/'].includes(operator(nodes[index]) ?? '')) {
      const op = operator(nodes[index++])
      const right = factor()
      if (!right || (op === '/' && right.value === 0)) return undefined
      result = {
        value: op === '*' ? result.value * right.value : result.value / right.value,
        dimensions: combineDimensions(result.dimensions, right.dimensions, op === '*' ? 1 : -1),
      }
      if (!Number.isFinite(result.value)) return undefined
    }
    return result
  }

  let result = product()
  if (!result) return undefined
  while (index < nodes.length && ['+', '-'].includes(operator(nodes[index]) ?? '')) {
    const op = operator(nodes[index++])
    const right = product()
    if (!right || !sameDimensions(result.dimensions, right.dimensions)) return undefined
    result = { value: op === '+' ? result.value + right.value : result.value - right.value, dimensions: result.dimensions }
    if (!Number.isFinite(result.value)) return undefined
  }
  return index === nodes.length ? result : undefined
}

function percentageWeight(node: ComponentValue): { value: number, literal: boolean } | undefined {
  if (isTokenNode(node) && isTokenPercentage(node.value)) {
    const value = node.value[4].value
    if (!Number.isFinite(value) || value < 0 || value > 100) return undefined
    return { value, literal: true }
  }
  if (!isFunctionNode(node) || node.getName().toLowerCase() !== 'calc') return undefined
  const result = evaluateMath(node.value)
  if (!result || !sameDimensions(result.dimensions, new Map([['percentage', 1]]))) return undefined
  return { value: Math.min(100, Math.max(0, result.value)), literal: false }
}

function parseColorStop(segment: ComponentValue[]): ColorStop | undefined {
  const values = significant(segment)
  if (values.length < 1 || values.length > 2) return undefined
  if (values.length === 1) return { color: values[0] }
  const firstWeight = percentageWeight(values[0])
  const secondWeight = percentageWeight(values[1])
  if (Boolean(firstWeight) === Boolean(secondWeight)) return undefined
  return firstWeight
    ? { color: values[1], weight: firstWeight }
    : { color: values[0], weight: secondWeight }
}

function colorMixSegments(node: ComponentValue): ComponentValue[][] | undefined {
  if (!isFunctionNode(node) || node.getName().toLowerCase() !== 'color-mix') return undefined
  const segments: ComponentValue[][] = [[]]
  for (const entry of node.value) {
    if (isTokenNode(entry) && isTokenComma(entry.value)) segments.push([])
    else segments.at(-1)!.push(entry)
  }
  return segments.length === 3 ? segments : undefined
}

function compatibleParsedAlpha(node: ComponentValue): number | undefined {
  const parsed = parseCssColor(node)
  if (parsed === false
    || UNSUPPORTED_CHROMIUM_FLAGS.some((flag) => parsed.syntaxFlags.has(flag))
    || typeof parsed.alpha !== 'number') return undefined
  if (Number.isNaN(parsed.alpha) && parsed.syntaxFlags.has(SyntaxFlag.HasNoneKeywords)) return 0
  return Number.isFinite(parsed.alpha) ? parsed.alpha : undefined
}

function validInterpolationHeader(segment: ComponentValue[]): boolean {
  const source = segment.map((entry) => entry.toString()).join('')
  const probe = singleComponent(`color-mix(${source}, transparent, transparent)`)
  return Boolean(probe && compatibleParsedAlpha(probe) !== undefined)
}

function resolvedAlpha(node: ComponentValue, depth = 0): number | undefined {
  if (depth > MAX_COMPONENT_DEPTH || contextualColor(node)) return undefined
  const segments = colorMixSegments(node)
  if (!segments) return compatibleParsedAlpha(node)
  if (!validInterpolationHeader(segments[0])) return undefined
  const first = parseColorStop(segments[1])
  const second = parseColorStop(segments[2])
  if (!first || !second) return undefined
  const firstAlpha = resolvedAlpha(first.color, depth + 1)
  const secondAlpha = resolvedAlpha(second.color, depth + 1)
  if (firstAlpha === undefined || secondAlpha === undefined) return undefined

  const specifiedFirstWeight = first.weight?.value
  const specifiedSecondWeight = second.weight?.value
  const firstWeight = specifiedFirstWeight ?? (specifiedSecondWeight === undefined ? 50 : 100 - specifiedSecondWeight)
  const secondWeight = specifiedSecondWeight ?? (specifiedFirstWeight === undefined ? 50 : 100 - specifiedFirstWeight)
  if (firstWeight === 0 && secondWeight === 0) {
    return first.weight?.literal && second.weight?.literal ? undefined : 0
  }
  const total = firstWeight + secondWeight
  if (!(total > 0)) return undefined
  const alphaMultiplier = Math.min(total, 100) / 100
  return ((firstAlpha * firstWeight + secondAlpha * secondWeight) / total) * alphaMultiplier
}

/**
 * Resolve transparency through one bounded DOM-free parser/evaluator in Node
 * and the browser. Invalid or context-dependent colors fail closed.
 */
export function isTransparentCssColor(value: string): boolean {
  try {
    const source = value.trim()
    if (!source || source.length > MAX_CSS_COLOR_LENGTH) return false
    const component = singleComponent(source)
    if (!component) return false
    const alpha = resolvedAlpha(component)
    return alpha !== undefined && alpha <= 0
  } catch {
    return false
  }
}
