import { describe, expect, it } from 'vitest'
import { buildQcCapturePlan } from '../src/agent/qcCapturePlan'
import type { CraftType, LabelAreaConfig } from '../src/label/types'

function area(id: string, crafts: CraftType[] = []): LabelAreaConfig {
  return {
    id,
    meshIndex: id === 'front' ? 1 : 2,
    nodeName: `${id}-mesh`,
    surfaceMode: 'overlay',
    side: id === 'back' ? 'back' : 'front',
    layers: [{
      id: `${id}-layer`, kind: 'shape', shape: 'rectangle',
      width: 100, height: 100, fill: '#ffffff', stroke: '#000000',
      strokeWidth: 0, cornerRadius: 0, x: 0, y: 0, rotation: 0,
      opacity: 1, visible: true, locked: false, zIndex: 0,
      craft: crafts.map((type) => ({ type, params: {} })),
    }],
    globalCraft: { craft: [] },
  } as unknown as LabelAreaConfig
}

describe('QC capture plan', () => {
  it.each([1, 4096])('accepts boundary dimension %s', (dimension) => {
    expect(() => buildQcCapturePlan({ preset: 'qc-standard', width: dimension, height: dimension, areas: [], customViews: [] })).not.toThrow()
  })

  it.each([0, 4097, 1440.5])('rejects invalid dimension %s', (dimension) => {
    expect(() => buildQcCapturePlan({ preset: 'qc-standard', width: dimension, height: 1440, areas: [], customViews: [] })).toThrow()
  })

  it('preserves a valid 80-character area id while bounding derived color view ids', () => {
    const longId = 'a'.repeat(80)
    const plan = buildQcCapturePlan({ preset: 'qc-standard', width: 1440, height: 1440, areas: [area(longId)], customViews: [] })
    const views = plan.filter((view) => view.areaId === longId)
    expect(views.map((view) => view.id)).toHaveLength(2)
    expect(views.every((view) => view.id.length <= 80)).toBe(true)
  })

  it('preserves a valid 80-character area id while bounding derived craft view ids', () => {
    const longId = 'a'.repeat(80)
    const plan = buildQcCapturePlan({ preset: 'qc-standard', width: 1440, height: 1440, areas: [area(longId, ['foil'])], customViews: [] })
    const views = plan.filter((view) => view.areaId === longId)
    expect(views.map((view) => view.id)).toHaveLength(4)
    expect(views.every((view) => view.id.length <= 80)).toBe(true)
  })

  it('preserves long and Unicode area ids while deriving safe unique view tokens', () => {
    const areaIds = [
      `opaque-${'a'.repeat(180)}`,
      '正面 标签／α',
      'front/label',
      'front\\label',
    ]
    const plan = buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: areaIds.map((id) => area(id)), customViews: [],
    })
    const areaViews = plan.filter((view) => view.areaId !== undefined)

    expect(new Set(areaViews.map((view) => view.id)).size).toBe(areaViews.length)
    expect(areaViews.every((view) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(view.id))).toBe(true)
    for (const areaId of areaIds) {
      expect(areaViews.filter((view) => view.areaId === areaId)).toHaveLength(2)
      expect(areaViews.filter((view) => view.areaId === areaId).every((view) => view.target.kind === 'area' && view.target.areaId === areaId)).toBe(true)
    }
  })

  it('disambiguates case-fold-colliding area ids without changing an isolated safe token', () => {
    const build = (ids: string[]) => buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: ids.map((id) => area(id)), customViews: [],
    }).filter((view) => view.areaId !== undefined)
    const expected = new Map([
      ['Front', ['area-Front-6de898785ca4f504-face', 'area-Front-6de898785ca4f504-craft']],
      ['front', ['area-front-e179dbd83ca4c2a4-face', 'area-front-e179dbd83ca4c2a4-craft']],
    ])

    for (const views of [build(['Front', 'front']), build(['front', 'Front'])]) {
      for (const [areaId, viewIds] of expected) {
        expect(views.filter((view) => view.areaId === areaId).map((view) => view.id)).toEqual(viewIds)
      }
      expect(new Set(views.map((view) => view.id.normalize('NFKC').toLowerCase())).size).toBe(views.length)
    }
    expect(build(['Front']).map((view) => view.id)).toEqual(['area-Front-face', 'area-Front-craft'])
  })

  it('allows a safe custom view id to target a known opaque area id', () => {
    const areaId = '正面 标签／α'
    const plan = buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: [area(areaId)],
      customViews: [{ id: 'unicode-detail', direction: [0, 0, 1], target: areaId, framing: 'fit-area', channel: 'color' }],
    })

    expect(plan.at(-1)).toMatchObject({
      id: 'unicode-detail', areaId,
      target: { kind: 'area', areaId },
    })
  })

  it('uses framing to distinguish the whole-model sentinel from an opaque area id named model', () => {
    const plan = buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: [area('model')],
      customViews: [
        { id: 'whole-model', direction: [0, 0, 1], target: 'model', framing: 'fit-model', channel: 'color' },
        { id: 'model-area', direction: [0, 0, 1], target: 'model', framing: 'fit-area', channel: 'color' },
      ],
    })

    expect(plan.slice(-2)).toEqual([
      expect.objectContaining({ id: 'whole-model', target: { kind: 'model' }, framing: 'fit-model' }),
      expect.objectContaining({ id: 'model-area', target: { kind: 'area', areaId: 'model' }, areaId: 'model', framing: 'fit-area' }),
    ])
  })

  it('keeps six model views and two color close-ups for every area', () => {
    const plan = buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: [area('front'), area('back')], customViews: [],
    })
    expect(plan.filter((view) => view.target.kind === 'model').map((view) => view.id)).toEqual([
      'model-front', 'model-back', 'model-left', 'model-right',
      'model-front-right', 'model-back-left',
    ])
    expect(plan.filter((view) => view.areaId === 'front' && view.channel === 'color').map((view) => view.id)).toEqual([
      'area-front-face', 'area-front-craft',
    ])
    expect(plan).toHaveLength(10)
  })

  it('adds only channels required by each area craft', () => {
    const plan = buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: [area('front', ['foil', 'emboss'])], customViews: [],
    })
    expect(plan.filter((view) => view.areaId === 'front').map((view) => [view.id, view.channel])).toEqual([
      ['area-front-face', 'color'],
      ['area-front-craft', 'color'],
      ['area-front-metalness', 'metalness'],
      ['area-front-roughness', 'roughness'],
      ['area-front-bump', 'bump'],
    ])
    expect(plan.filter((view) => view.areaId === 'front').map((view) => [view.channel, view.pose.kind])).toEqual([
      ['color', 'area-face'],
      ['color', 'area-craft'],
      ['metalness', 'area-face'],
      ['roughness', 'area-face'],
      ['bump', 'area-face'],
    ])
  })

  it.each([
    [{ id: '../escape', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }],
    [{ id: 'zero', direction: [0, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }],
    [{ id: 'missing', direction: [1, 0, 0], target: 'absent', framing: 'fit-area', channel: 'color' }],
    [{ id: 'missing-model-area', direction: [1, 0, 0], target: 'model', framing: 'fit-area', channel: 'color' }],
  ])('rejects an invalid custom view', (view) => {
    expect(() => buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: [area('front')], customViews: [view as never],
    })).toThrow()
  })
})
