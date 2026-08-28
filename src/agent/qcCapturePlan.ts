import type { LabelAreaConfig, CraftType } from '../label/types'
import type { QcChannel, QcCustomView, QcDiagnosticChannel, QcViewRequest, QcVector3 } from './contracts'
import {
  areaArtifactToken,
  deriveAreaArtifactTokens,
} from './areaArtifactToken.mjs'

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
const CRAFT_CHANNEL_ORDER: QcDiagnosticChannel[] = ['metalness', 'roughness', 'bump']

function invalidUsage(message: string): never {
  const error = new Error(message) as Error & { code: 'INVALID_USAGE' }
  error.code = 'INVALID_USAGE'
  throw error
}

function assertOpaqueAreaId(areaId: unknown): asserts areaId is string {
  if (typeof areaId !== 'string' || areaId.length === 0) invalidUsage('Area id must be a non-empty string')
}

/** Compatibility names over the single Node/browser area artifact token core. */
export const qcAreaToken = areaArtifactToken as (areaId: string) => string
export const deriveQcAreaTokens = deriveAreaArtifactTokens as (areaIds: Iterable<string>) => Map<string, string>

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
