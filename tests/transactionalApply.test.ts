import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPreparedAreaTransaction } from '../src/agent/transactionalApply'
import type { LabelAreaConfig } from '../src/label/types'
import { useLabelStore } from '../src/state/stores'

function area(id: string, meshIndex = 0): LabelAreaConfig {
  return {
    id,
    name: id,
    meshIndex,
    nodeName: `mesh-${meshIndex}`,
    surfaceMode: 'overlay',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 256, height: 256, aspect: 1 },
    layers: [],
    globalCraft: { craft: [] },
    fonts: [],
    referenceVisible: false,
    undoStack: [],
    redoStack: [],
  }
}

const runtime = {
  meshAccessors: { positions: new Float32Array(9), uv: new Float32Array(6), indices: null, triangleCount: 1 },
  remapOutput: { positions: new Float32Array(9), uv: new Float32Array(6), indices: new Uint32Array(3), vertexCount: 3, seamCrossingTriangles: 0, frontAngle: 0, maxSpan: 1 },
  remap: area('runtime').remap,
}

describe('transactional area apply', () => {
  beforeEach(() => useLabelStore.getState().clearAll())

  it('keeps the original store identity when any runtime restore fails', async () => {
    useLabelStore.getState().addArea(area('existing'))
    const before = useLabelStore.getState().areas
    const restoreRuntime = vi.fn()
      .mockResolvedValueOnce(runtime)
      .mockRejectedValueOnce(new Error('bad back'))

    await expect(applyPreparedAreaTransaction({
      glbBytes: new Uint8Array([1]),
      areas: [area('front'), area('back')],
      restoreRuntime,
    })).rejects.toThrow('bad back')

    expect(useLabelStore.getState().areas).toBe(before)
    expect(useLabelStore.getState().activeAreaId).toBe('existing')
  })

  it('commits every restored area in one state change', async () => {
    useLabelStore.getState().addArea(area('existing'))
    const activationsBefore = useLabelStore.getState().activations

    await applyPreparedAreaTransaction({
      glbBytes: new Uint8Array([1]),
      areas: [area('front'), area('back')],
      restoreRuntime: vi.fn().mockResolvedValue(runtime),
    })

    expect(useLabelStore.getState().areas.map((value) => value.id)).toEqual(['front', 'back'])
    expect(useLabelStore.getState().activeAreaId).toBe('back')
    expect(useLabelStore.getState().activations).toBe(activationsBefore + 1)
  })
})
