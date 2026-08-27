import type { CarrierMode, LabelSide } from './designContracts'
import type { ReviewViewRequest } from './contracts'
import { compareOrdinalText } from '../label/layerOrder'

const DEFAULT_REVIEW_DIMENSION = 1600
const MAX_REVIEW_DIMENSION = 4096
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const SIDE_ORDER: readonly LabelSide[] = [
  'front', 'back', 'left', 'right', 'wrap', 'top', 'bottom', 'neck', 'custom',
]

function invalidUsage(message: string): never {
  const error = new Error(message) as Error & { code: 'INVALID_USAGE' }
  error.code = 'INVALID_USAGE'
  throw error
}

function boundedDimension(value: number | undefined, field: string): number {
  const dimension = value ?? DEFAULT_REVIEW_DIMENSION
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_REVIEW_DIMENSION) {
    invalidUsage(`Review ${field} must be an integer from 1 through ${MAX_REVIEW_DIMENSION}`)
  }
  return dimension
}

function stableHash(value: string, seed: number): string {
  let hash = seed
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function tokenHash(value: string, attempt = 0): string {
  const input = attempt === 0 ? value : `${value}\u0000${attempt}`
  return `${stableHash(input, 2166136261)}${stableHash([...input].reverse().join(''), 0x9e3779b9)}`
}

function baseAreaToken(areaId: string): string {
  if (areaId.length <= 48 && SAFE_TOKEN_PATTERN.test(areaId)) return areaId
  const stem = areaId.normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 31) || 'area'
  return `${stem}-${tokenHash(areaId)}`
}

function publicationKey(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function areaTokens(areaIds: readonly string[]): Map<string, string> {
  const bases = new Map(areaIds.map((areaId) => [areaId, baseAreaToken(areaId)]))
  const resolved = new Map(bases)
  for (let attempt = 0; attempt <= 8; attempt += 1) {
    const groups = new Map<string, string[]>()
    for (const [areaId, token] of resolved) {
      const key = publicationKey(token)
      groups.set(key, [...(groups.get(key) ?? []), areaId])
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1)
    if (collisions.length === 0) return resolved
    for (const group of collisions) {
      for (const areaId of group) {
        resolved.set(areaId, `${bases.get(areaId)!.slice(0, 45)}-${tokenHash(areaId, attempt + 1)}`)
      }
    }
  }
  return invalidUsage('Review area tokens cannot be made publication-safe and unique')
}

function assertResultId(id: string, ids: Set<string>): void {
  if (!SAFE_ID_PATTERN.test(id)) invalidUsage(`Invalid review view id: ${id}`)
  const key = publicationKey(id)
  if (ids.has(key)) invalidUsage(`Duplicate or case-fold-colliding review view id: ${id}`)
  ids.add(key)
}

export function buildReviewCapturePlan(input: {
  areas: Array<{ id: string; side: LabelSide; carrier: CarrierMode }>
  width?: number
  height?: number
}): ReviewViewRequest[] {
  const width = boundedDimension(input.width, 'width')
  const height = boundedDimension(input.height, 'height')
  const ids = new Set<string>()
  for (const area of input.areas) {
    if (typeof area.id !== 'string' || area.id.length === 0 || area.id.length > 4096) {
      invalidUsage('Review area id must be a non-empty bounded string')
    }
    if (ids.has(area.id)) invalidUsage(`Duplicate area id: ${area.id}`)
    ids.add(area.id)
  }
  const ordered = [...input.areas]
    .sort((left, right) => SIDE_ORDER.indexOf(left.side) - SIDE_ORDER.indexOf(right.side)
      || compareOrdinalText(left.id, right.id))
  const tokens = areaTokens(ordered.map((area) => area.id))
  const resultIds = new Set<string>()
  const plan: ReviewViewRequest[] = []
  const add = (view: ReviewViewRequest) => {
    assertResultId(view.id, resultIds)
    plan.push(view)
  }
  for (const area of ordered) {
    if (area.carrier === 'bare') continue
    const areaToken = tokens.get(area.id)!
    const metadata = {
      width, height, areaId: area.id, areaToken, side: area.side, carrier: area.carrier,
    }
    add({ id: `label-${areaToken}`, kind: 'flat-artwork', ...metadata })
    add({ id: `surface-${areaToken}`, kind: 'surface-face', ...metadata })
  }
  add({ id: 'model-front', kind: 'model-front', width, height })
  add({ id: 'model-back', kind: 'model-back', width, height })
  add({
    id: 'review-sheet', kind: 'review-sheet', width, height,
    sourceViewIds: plan.map((view) => view.id),
  })
  return plan
}

function withoutClaims(value: string): string {
  return value
    .replace(/approved/gi, '[redacted]')
    .replace(/production[ -]?ready/gi, '[redacted]')
    .replace(/press[ -]?ready/gi, '[redacted]')
    .replace(/certif(?:ied|ication|y)?/gi, '[redacted]')
    .replace(/\bqc\b/gi, '[redacted]')
}

function compactLabelToken(value: string, maximum = 28): string {
  const clean = withoutClaims(value).replace(/\s+/g, ' ').trim()
  if (/^sha256:[a-f0-9]{64}$/i.test(clean)) return `${clean.slice(0, 19)}…`
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`
}

/** Human evidence labels are descriptive only and cannot state approval/certification. */
export function reviewSheetLabel(input: {
  viewId?: string
  areaToken?: string
  side?: LabelSide
  carrier?: CarrierMode
  blueprintRevision: string
  inputRevision: string
}): string {
  const areaIdentity = [
    input.areaToken ? `Area ${compactLabelToken(input.areaToken, 20)}` : undefined,
    input.side,
    input.carrier,
  ].filter((value): value is string => Boolean(value)).join(' | ')
  const identity = (areaIdentity || `View ${compactLabelToken(input.viewId ?? 'review')}`).slice(0, 72)
  const evidence = [
    `Design ${compactLabelToken(input.blueprintRevision)}`,
    `Input ${compactLabelToken(input.inputRevision)}`,
  ].join(' | ').slice(0, 72)
  return `${identity}\n${evidence}`
}
