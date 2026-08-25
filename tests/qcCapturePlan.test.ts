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
  })

  it.each([
    [{ id: '../escape', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }],
    [{ id: 'zero', direction: [0, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }],
    [{ id: 'missing', direction: [1, 0, 0], target: 'absent', framing: 'fit-area', channel: 'color' }],
  ])('rejects an invalid custom view', (view) => {
    expect(() => buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: [area('front')], customViews: [view as never],
    })).toThrow()
  })
})
