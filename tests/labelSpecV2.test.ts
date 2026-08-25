import { describe, expect, it } from 'vitest'
import { validateLabelSpec } from '../src/agent/labelSpecSchema'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import type { LabelAreaConfig } from '../src/label/types'

const baseArea: LabelAreaConfig = {
  id: 'base', name: 'Base', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
  remap: { mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] } },
  range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
  canvas: { width: 1000, height: 500, aspect: 2 }, layers: [], globalCraft: { craft: [] },
  fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
}

describe('Label Spec v2', () => {
  it('accepts deterministic front and back areas', () => {
    const result = validateLabelSpec({
      version: 2,
      areas: [
        {
          id: 'front',
          name: '正标',
          target: { meshIndex: 0 },
          surfaceMode: 'overlay',
          side: 'front',
          range: { uStart: 0.35, uWidth: 0.3, vStart: 0.2, vHeight: 0.6 },
          layers: [
            { id: 'brand', type: 'text', text: 'REALIBOX', x: 0.5, y: 0.5, width: 0.7 },
          ],
        },
        {
          id: 'back',
          name: '背标',
          target: { meshIndex: 0 },
          surfaceMode: 'overlay',
          side: 'back',
          range: { uStart: 0.35, uWidth: 0.3, vStart: 0.2, vHeight: 0.6 },
          layers: [],
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.version).toBe(2)
      expect(result.spec.areas.map((area) => area.id)).toEqual(['front', 'back'])
    }
  })

  it('rejects unknown fields and invalid craft parameters', () => {
    const unknown = validateLabelSpec({ version: 2, surprise: true, areas: [] })
    expect(unknown.ok).toBe(false)
    expect(unknown.issues.some((issue) => issue.path === '/surprise')).toBe(true)

    const craft = validateLabelSpec({
      version: 2,
      areas: [{
        id: 'front',
        name: 'Front',
        target: { meshIndex: 0 },
        surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{
          id: 'brand', type: 'text', text: 'Brand', x: 0.5, y: 0.5,
          craft: [{ type: 'foil', params: { highlight: 3 } }],
        }],
      }],
    })
    expect(craft.ok).toBe(false)
  })

  it('migrates v1 and reports every inferred execution field', () => {
    const result = validateLabelSpec({ version: 1, areas: [{ side: 'front', layers: [] }] })
    expect(result.ok).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('target'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('surfaceMode'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('range'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('print'))).toBe(true)
  })

  it('maps a v2 image asset to an editable image layer', () => {
    const result = applyStructuredLabelSpec(baseArea, {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{ id: 'logo', type: 'image', asset: 'logo', x: 0.5, y: 0.5, width: 0.4, height: 0.2 }],
      }],
    })
    expect(result.areas[0].layers[0]).toMatchObject({
      id: 'logo', kind: 'image', src: 'logo', width: 400, height: 100,
    })
  })

  it('preserves shape geometry when mapping a v2 spec to editable native layers', () => {
    const result = applyStructuredLabelSpec(baseArea, {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{
          id: 'pulse-wave', type: 'shape', shape: 'wave', x: 0.5, y: 0.5,
          width: 0.8, height: 0.2, geometry: { amplitude: 0.18, frequency: 3, dash: [12, 6] },
        }],
      }],
    })

    expect(result.areas[0].layers[0]).toMatchObject({
      id: 'pulse-wave',
      kind: 'shape',
      geometry: { amplitude: 0.18, frequency: 3, dash: [12, 6] },
    })
  })

  it('accepts oversized native shapes so decorative artwork can bleed beyond the die cut', () => {
    const result = validateLabelSpec({
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{ id: 'orbit', type: 'shape', shape: 'ellipse', x: 0.25, y: 0.8, width: 1.4, height: 0.3 }],
      }],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const mapped = applyStructuredLabelSpec(baseArea, result.spec)
      expect(mapped.areas[0].layers[0]).toMatchObject({ kind: 'shape', width: 1400 })
    }
  })
})
