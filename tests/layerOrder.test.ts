import { describe, expect, it } from 'vitest'
import { canonicalLayerOrder, compareLayerZOrder, compareLayerZOrderDescending } from '../src/label/layerOrder'

describe('canonical layer ordering', () => {
  it('uses Unicode code-unit id order without consulting the ambient locale', () => {
    const original = String.prototype.localeCompare
    let bottomToTop: string[] = []
    let topToBottom: string[] = []
    try {
      String.prototype.localeCompare = () => {
        throw new Error('ambient locale must not participate in layer ordering')
      }
      const layers = [{ id: 'i', zIndex: 0 }, { id: 'I', zIndex: 0 }]
      bottomToTop = [...layers].sort(compareLayerZOrder).map((layer) => layer.id)
      topToBottom = [...layers].sort(compareLayerZOrderDescending).map((layer) => layer.id)
    } finally {
      String.prototype.localeCompare = original
    }

    expect(bottomToTop).toEqual(['I', 'i'])
    expect(topToBottom).toEqual(['i', 'I'])
  })

  it('orders finite zIndex values numerically and fails closed on non-finite values', () => {
    expect([
      { id: 'ten', zIndex: 10 },
      { id: 'two', zIndex: 2 },
      { id: 'negative', zIndex: -1 },
    ].sort(compareLayerZOrder).map((layer) => layer.id)).toEqual(['negative', 'two', 'ten'])

    expect(() => compareLayerZOrder({ id: 'nan', zIndex: Number.NaN }, { id: 'zero', zIndex: 0 })).toThrow(/finite/i)
    expect(() => compareLayerZOrder({ id: 'infinite', zIndex: Number.POSITIVE_INFINITY }, { id: 'zero', zIndex: 0 })).toThrow(/finite/i)
  })

  it('returns a new array without mutating storage and rejects duplicate ids', () => {
    const input = [{ id: 'i', zIndex: 0 }, { id: 'I', zIndex: 0 }]

    expect(canonicalLayerOrder(input).map((layer) => layer.id)).toEqual(['I', 'i'])
    expect(input.map((layer) => layer.id)).toEqual(['i', 'I'])
    expect(() => canonicalLayerOrder([{ id: 'same', zIndex: 0 }, { id: 'same', zIndex: 1 }])).toThrow(/duplicate layer id/i)
  })
})
