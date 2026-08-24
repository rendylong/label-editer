import { describe, expect, it } from 'vitest'
import { validateLabelSpec } from '../src/agent/labelSpecSchema'

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
})
