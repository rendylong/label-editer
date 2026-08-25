import type { LabelAreaConfig, CraftType } from '../label/types'
import type { QcChannel, QcCustomView, QcViewRequest, QcVector3 } from './contracts'

const MODEL_VIEWS = [
  ['model-front', [0, 0, 1]],
  ['model-back', [0, 0, -1]],
  ['model-left', [-1, 0, 0]],
  ['model-right', [1, 0, 0]],
  ['model-front-right', [1, 0, 1]],
  ['model-back-left', [-1, 0, -1]],
] as const

const CRAFT_CHANNELS: Record<CraftType, QcChannel[]> = {
  foil: ['metalness', 'roughness'],
  emboss: ['bump'],
  deboss: ['bump'],
  matte: ['roughness', 'bump'],
  uv: ['roughness'],
  stroke: [],
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const CRAFT_CHANNEL_ORDER: QcChannel[] = ['metalness', 'roughness', 'bump']

function stableAreaHash(areaId: string): string {
  let hash = 2166136261
  for (let index = 0; index < areaId.length; index += 1) {
    hash ^= areaId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function areaViewId(areaId: string, suffix: string): string {
  const plain = `area-${areaId}-${suffix}`
  if (plain.length <= 80) return plain
  const hash = stableAreaHash(areaId)
  const prefixLength = 80 - `area--${hash}-${suffix}`.length
  return `area-${areaId.slice(0, Math.max(1, prefixLength))}-${hash}-${suffix}`
}

function assertValidId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid ${label} id: ${id}`)
}

function assertDirection(direction: readonly number[], label: string): asserts direction is QcVector3 {
  if (direction.length !== 3 || direction.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid ${label} direction`)
  }
  if (direction.every((value) => value === 0)) throw new Error(`Invalid ${label} direction: zero vector`)
}

export function craftChannelsForArea(area: LabelAreaConfig): QcChannel[] {
  const crafts = [
    ...area.layers.flatMap((layer) => layer.craft ?? []),
    ...(area.globalCraft?.craft ?? []),
  ]
  const required = new Set<QcChannel>()
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
  if (input.preset !== 'qc-standard') throw new Error(`Unsupported QC preset: ${input.preset}`)
  if (!Number.isInteger(input.width) || input.width < 1 || input.width > 4096
    || !Number.isInteger(input.height) || input.height < 1 || input.height > 4096) {
    throw new Error('QC capture dimensions must be finite and positive')
  }
  const areaIds = new Set<string>()
  for (const area of input.areas) {
    assertValidId(area.id, 'area')
    if (areaIds.has(area.id)) throw new Error(`Duplicate area id: ${area.id}`)
    areaIds.add(area.id)
  }
  const ids = new Set<string>()
  const plan: QcViewRequest[] = []
  const add = (view: QcViewRequest) => {
    assertValidId(view.id, 'view')
    if (ids.has(view.id)) throw new Error(`Duplicate QC view id: ${view.id}`)
    ids.add(view.id)
    plan.push(view)
  }

  for (const [id, direction] of MODEL_VIEWS) {
    add({ id, target: { kind: 'model' }, framing: 'fit-model', pose: { kind: 'direction', direction: [...direction] }, channel: 'color', width: input.width, height: input.height, reason: 'Standard model orientation' })
  }
  for (const area of input.areas) {
    const target = { kind: 'area' as const, areaId: area.id }
    for (const [id, pose, reason] of [
      [areaViewId(area.id, 'face'), { kind: 'area-face' as const }, 'Area face color close-up'],
      [areaViewId(area.id, 'craft'), { kind: 'area-craft' as const }, 'Area craft color close-up'],
    ] as const) {
      add({ id, target, framing: 'fit-area', pose, channel: 'color', width: input.width, height: input.height, areaId: area.id, reason })
    }
    for (const channel of craftChannelsForArea(area)) {
      add({ id: areaViewId(area.id, channel), target, framing: 'fit-area', pose: { kind: 'area-craft' }, channel, width: input.width, height: input.height, areaId: area.id, reason: `Area ${channel} craft channel` })
    }
  }
  for (const custom of input.customViews) {
    assertValidId(custom.id, 'custom view')
    assertDirection(custom.direction, `custom view ${custom.id}`)
    const isModel = custom.target === 'model'
    if (custom.framing === 'fit-area' && isModel) throw new Error(`fit-area custom view must target an area: ${custom.id}`)
    if (!isModel && !areaIds.has(custom.target)) throw new Error(`Custom view targets missing area: ${custom.target}`)
    if (custom.framing === 'fit-model' && !isModel) throw new Error(`fit-model custom view must target model: ${custom.id}`)
    add({ id: custom.id, target: isModel ? { kind: 'model' } : { kind: 'area', areaId: custom.target }, framing: custom.framing, pose: { kind: 'direction', direction: [...custom.direction] }, channel: custom.channel, width: input.width, height: input.height, ...(isModel ? {} : { areaId: custom.target }), reason: 'Custom QC view' })
  }
  return plan
}
