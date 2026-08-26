import type { LabelAreaConfig, CraftType } from '../label/types'
import type { QcChannel, QcCustomView, QcDiagnosticChannel, QcViewRequest, QcVector3 } from './contracts'

const MODEL_VIEWS = [
  ['model-front', [0, 0, 1]],
  ['model-back', [0, 0, -1]],
  ['model-left', [-1, 0, 0]],
  ['model-right', [1, 0, 0]],
  ['model-front-right', [1, 0, 1]],
  ['model-back-left', [-1, 0, -1]],
] as const

const CRAFT_CHANNELS: Record<CraftType, QcDiagnosticChannel[]> = {
  foil: ['metalness', 'roughness'],
  emboss: ['bump'],
  deboss: ['bump'],
  matte: ['roughness', 'bump'],
  uv: ['roughness'],
  stroke: [],
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CRAFT_CHANNEL_ORDER: QcDiagnosticChannel[] = ['metalness', 'roughness', 'bump']

function invalidUsage(message: string): never {
  const error = new Error(message) as Error & { code: 'INVALID_USAGE' }
  error.code = 'INVALID_USAGE'
  throw error
}

function stableAreaHash(areaId: string, seed: number, reverse = false): string {
  let hash = seed
  for (let offset = 0; offset < areaId.length; offset += 1) {
    const index = reverse ? areaId.length - 1 - offset : offset
    hash ^= areaId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function areaFingerprint(areaId: string, attempt = 0): string {
  const value = attempt === 0 ? areaId : `${areaId}\u0000${attempt}`
  return `${stableAreaHash(value, 2166136261)}${stableAreaHash(value, 0x9e3779b9, true)}`
}

function assertOpaqueAreaId(areaId: unknown): asserts areaId is string {
  if (typeof areaId !== 'string' || areaId.length === 0) invalidUsage('Area id must be a non-empty string')
}

/** Deterministic ASCII token for paths/view ids; the canonical area id stays opaque. */
export function qcAreaToken(areaId: string): string {
  assertOpaqueAreaId(areaId)
  if (areaId.length <= 48 && SAFE_TOKEN_PATTERN.test(areaId)) return areaId
  const stem = areaId.normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 31) || 'area'
  return `${stem}-${areaFingerprint(areaId)}`
}

function publicationTokenKey(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function deriveQcAreaTokens(areaIds: Iterable<string>): Map<string, string> {
  const baseTokens = new Map<string, string>()
  for (const areaId of areaIds) baseTokens.set(areaId, qcAreaToken(areaId))
  const tokens = new Map(baseTokens)
  const attempts = new Map<string, number>()
  for (let pass = 0; pass <= 8; pass += 1) {
    const groups = new Map<string, string[]>()
    for (const [areaId, token] of tokens) {
      const key = publicationTokenKey(token)
      groups.set(key, [...(groups.get(key) ?? []), areaId])
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1)
    if (collisions.length === 0) return tokens
    for (const group of collisions) {
      for (const areaId of group) {
        const attempt = (attempts.get(areaId) ?? -1) + 1
        attempts.set(areaId, attempt)
        tokens.set(areaId, `${baseTokens.get(areaId)!.slice(0, 48)}-${areaFingerprint(areaId, attempt)}`)
      }
    }
  }
  invalidUsage('QC area tokens cannot be made publication-safe and unique')
}

function areaViewId(areaToken: string, suffix: string): string {
  return `area-${areaToken}-${suffix}`
}

function assertValidId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) invalidUsage(`Invalid ${label} id: ${id}`)
}

function assertDirection(direction: readonly number[], label: string): asserts direction is QcVector3 {
  if (direction.length !== 3 || direction.some((value) => !Number.isFinite(value))) {
    invalidUsage(`Invalid ${label} direction`)
  }
  if (direction.every((value) => value === 0)) invalidUsage(`Invalid ${label} direction: zero vector`)
}

export function craftChannelsForArea(area: LabelAreaConfig): QcDiagnosticChannel[] {
  const crafts = [
    ...area.layers.flatMap((layer) => layer.craft ?? []),
    ...(area.globalCraft?.craft ?? []),
  ]
  const required = new Set<QcDiagnosticChannel>()
  for (const craft of crafts) {
    for (const channel of CRAFT_CHANNELS[craft.type]) required.add(channel)
  }
  return CRAFT_CHANNEL_ORDER.filter((channel) => required.has(channel))
}

export function buildQcCapturePlan(input: {
  preset: 'qc-standard'
  width: number
  height: number
  areas: LabelAreaConfig[]
  customViews: QcCustomView[]
}): QcViewRequest[] {
  if (input.preset !== 'qc-standard') invalidUsage(`Unsupported QC preset: ${input.preset}`)
  if (!Number.isInteger(input.width) || input.width < 1 || input.width > 4096
    || !Number.isInteger(input.height) || input.height < 1 || input.height > 4096) {
    invalidUsage('QC capture dimensions must be finite and positive')
  }
  const areaIds = new Set<string>()
  for (const area of input.areas) {
    assertOpaqueAreaId(area.id)
    if (areaIds.has(area.id)) invalidUsage(`Duplicate area id: ${area.id}`)
    areaIds.add(area.id)
  }
  const areaTokens = deriveQcAreaTokens(areaIds)
  const ids = new Set<string>()
  const plan: QcViewRequest[] = []
  const add = (view: QcViewRequest) => {
    assertValidId(view.id, 'view')
    if (ids.has(view.id)) invalidUsage(`Duplicate QC view id: ${view.id}`)
    ids.add(view.id)
    plan.push(view)
  }

  for (const [id, direction] of MODEL_VIEWS) {
    add({ id, target: { kind: 'model' }, framing: 'fit-model', pose: { kind: 'direction', direction: [...direction] }, channel: 'color', width: input.width, height: input.height, reason: 'Standard model orientation' })
  }
  for (const area of input.areas) {
    const areaToken = areaTokens.get(area.id)!
    const target = { kind: 'area' as const, areaId: area.id }
    for (const [id, pose, reason] of [
      [areaViewId(areaToken, 'face'), { kind: 'area-face' as const }, 'Area face color close-up'],
      [areaViewId(areaToken, 'craft'), { kind: 'area-craft' as const }, 'Area craft color close-up'],
    ] as const) {
      add({ id, target, framing: 'fit-area', pose, channel: 'color', width: input.width, height: input.height, areaId: area.id, reason })
    }
    for (const channel of craftChannelsForArea(area)) {
      add({ id: areaViewId(areaToken, channel), target, framing: 'fit-area', pose: { kind: 'area-face' }, channel, width: input.width, height: input.height, areaId: area.id, reason: `Area ${channel} craft channel` })
    }
  }
  for (const custom of input.customViews) {
    assertValidId(custom.id, 'custom view')
    assertDirection(custom.direction, `custom view ${custom.id}`)
    let isModel: boolean
    if (custom.framing === 'fit-model') {
      if (custom.target !== 'model') invalidUsage(`fit-model custom view must target model: ${custom.id}`)
      isModel = true
    } else if (custom.framing === 'fit-area') {
      if (!areaIds.has(custom.target)) invalidUsage(`Custom view targets missing area: ${custom.target}`)
      isModel = false
    } else {
      invalidUsage(`Invalid custom view framing: ${custom.id}`)
    }
    add({ id: custom.id, target: isModel ? { kind: 'model' } : { kind: 'area', areaId: custom.target }, framing: custom.framing, pose: { kind: 'direction', direction: [...custom.direction] }, channel: custom.channel, width: input.width, height: input.height, ...(isModel ? {} : { areaId: custom.target }), reason: 'Custom QC view' })
  }
  return plan
}
