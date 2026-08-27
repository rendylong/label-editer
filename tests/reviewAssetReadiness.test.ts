import { describe, expect, it } from 'vitest'
import {
  designAssetReadinessKey,
  designFontReadinessKey,
  isBakeAssetReadyForArea,
} from '../src/label/exportReadiness'
import type { LabelAreaConfig } from '../src/label/types'
import type { BakeResult } from '../src/state/stores'

function owner(): LabelAreaConfig {
  return {
    id: 'front', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
    remap: { mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] } },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 32, height: 32, aspect: 1 }, carrier: 'direct_surface_print',
    layers: [{
      id: 'copy', kind: 'text', text: 'Brand', fontFamily: 'arial', fontSize: 10,
      fontWeight: 400, letterSpacing: 0, lineHeight: 1.2, color: '#111111', align: 'left', italic: false,
      x: 0, y: 0, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
    }, {
      id: 'mark', kind: 'image', src: 'asset://brand-mark', naturalWidth: 20, naturalHeight: 10,
      width: 20, height: 10, x: 0, y: 10, rotation: 0, opacity: 1,
      visible: true, locked: false, zIndex: 1, craft: [],
    }],
    globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

describe('review bake asset readiness', () => {
  it('requires an explicit successful font and image identity bound to the current bake', () => {
    const area = owner()
    const bake = {
      color: { width: 32, height: 32 } as HTMLCanvasElement,
      spec: area.canvas, version: 1, areaOwner: area,
      fontReadinessKey: designFontReadinessKey(area),
    } satisfies BakeResult

    expect(isBakeAssetReadyForArea(area, bake)).toBe(false)
    expect(isBakeAssetReadyForArea(area, {
      ...bake, assetReadinessKey: designAssetReadinessKey(area),
    })).toBe(true)
    expect(designAssetReadinessKey({
      ...area,
      layers: area.layers.map((layer) => layer.kind === 'image' ? { ...layer, src: 'asset://replacement' } : layer),
    })).not.toBe(designAssetReadinessKey(area))
  })
})
