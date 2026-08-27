import { describe, expect, it } from 'vitest'
import type { CarrierMode, LabelSide } from '../src/agent/designContracts'
import {
  assertReviewEncodedByteBudget,
  buildReviewCapturePlan,
  reviewSheetLabel,
} from '../src/agent/reviewCapturePlan'

function area(id: string, side: LabelSide, carrier: CarrierMode) {
  return { id, side, carrier }
}

describe('clean production review capture plan', () => {
  it('plans area evidence before useful model views and skips bare areas', () => {
    const plan = buildReviewCapturePlan({
      areas: [
        area('back', 'back', 'applied_label'),
        area('top', 'top', 'bare'),
        area('front', 'front', 'direct_surface_print'),
      ],
    })

    expect(plan.map((view) => view.id)).toEqual([
      'label-front', 'surface-front', 'label-back', 'surface-back',
      'model-front', 'model-back', 'review-sheet',
    ])
    expect(plan.some((view) => view.areaId === 'top')).toBe(false)
    expect(plan.every((view) => view.width === 1600 && view.height === 1600)).toBe(true)
    expect(plan.at(-1)).toMatchObject({
      kind: 'review-sheet',
      sourceViewIds: [
        'label-front', 'surface-front', 'label-back', 'surface-back',
        'model-front', 'model-back',
      ],
    })
  })

  it('orders equal-side opaque ids by code unit without consulting locale', () => {
    const original = String.prototype.localeCompare
    try {
      String.prototype.localeCompare = () => { throw new Error('locale ordering is forbidden') }
      const plan = buildReviewCapturePlan({
        areas: [
          area('custom-z', 'custom', 'in_mold'),
          area('custom-A', 'custom', 'clear_label'),
          area('custom-a', 'custom', 'foil_or_ink_only'),
        ],
        width: 800,
        height: 600,
      })
      expect(plan.filter((view) => view.kind === 'flat-artwork').map((view) => view.areaId)).toEqual([
        'custom-A', 'custom-a', 'custom-z',
      ])
    } finally {
      String.prototype.localeCompare = original
    }
  })

  it('keeps opaque ids out of paths and resolves safe-token case-fold collisions deterministically', () => {
    const first = buildReviewCapturePlan({
      areas: [
        area('../Front Label', 'front', 'direct_surface_print'),
        area('front', 'front', 'clear_label'),
        area('Front', 'front', 'applied_label'),
        area('前标', 'front', 'foil_or_ink_only'),
      ],
    })
    const second = buildReviewCapturePlan({
      areas: [...[
        area('../Front Label', 'front', 'direct_surface_print'),
        area('front', 'front', 'clear_label'),
        area('Front', 'front', 'applied_label'),
        area('前标', 'front', 'foil_or_ink_only'),
      ]].reverse(),
    })
    const ids = first.map((view) => view.id)

    expect(first).toEqual(second)
    expect(ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))).toBe(true)
    expect(new Set(ids.map((id) => id.normalize('NFKC').toLowerCase())).size).toBe(ids.length)
    expect(first.find((view) => view.areaId === '../Front Label')?.id).not.toContain('..')
    expect(first.find((view) => view.areaId === '前标')?.id).toMatch(/^label-area-/)
  })

  it('rejects duplicate areas and exact or case-fold result collisions', () => {
    expect(() => buildReviewCapturePlan({
      areas: [area('front', 'front', 'direct_surface_print'), area('front', 'back', 'applied_label')],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_USAGE' }))
  })

  it.each([0, -1, 4097, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsafe dimension %s',
    (width) => {
      expect(() => buildReviewCapturePlan({ areas: [area('front', 'front', 'direct_surface_print')], width }))
        .toThrowError(expect.objectContaining({ code: 'INVALID_USAGE' }))
    },
  )

  it('preserves exact custom dimensions and carrier metadata for every non-bare carrier', () => {
    const carriers: CarrierMode[] = [
      'direct_surface_print', 'applied_label', 'clear_label', 'in_mold', 'foil_or_ink_only', 'bare',
    ]
    const plan = buildReviewCapturePlan({
      areas: carriers.map((carrier, index) => area(`area-${index}`, 'custom', carrier)),
      width: 4096,
      height: 1,
    })
    const flat = plan.filter((view) => view.kind === 'flat-artwork')

    expect(flat).toHaveLength(5)
    expect(flat.map((view) => view.carrier)).toEqual(carriers.slice(0, -1))
    expect(flat.every((view) => view.width === 4096 && view.height === 1)).toBe(true)
  })

  it('builds bounded sheet labels without approval, QC, or certification claims', () => {
    const label = reviewSheetLabel({
      viewId: 'accepted-manufacturing-ready-passed-view',
      areaToken: 'approved-production-ready-QC-certified', ordinal: 7,
      side: 'front', carrier: 'direct_surface_print',
      blueprintRevision: 'approved-opaque-blueprint-v1', inputRevision: 'passed-opaque-input-v2',
    })
    expect(label.length).toBeLessThanOrEqual(256)
    expect(label.split('\n')).toHaveLength(2)
    expect(label.split('\n').every((line) => line.length <= 72)).toBe(true)
    expect(label).toContain('Front')
    expect(label).toContain('Direct surface print')
    expect(label).not.toContain('approved-opaque-blueprint-v1')
    expect(label).not.toContain('passed-opaque-input-v2')
    expect(label).not.toContain('accepted-manufacturing-ready-passed-view')
    expect(label).not.toMatch(/approved|approval|accepted|passed|production[ -]?ready|manufacturing[ -]?ready|\bqc\b|certif|press[ -]?ready/i)
  })

  it('rejects aggregate capture pixel work before returning an oversized plan', () => {
    expect(() => buildReviewCapturePlan({
      areas: Array.from({ length: 20 }, (_, index) => area(`area-${index}`, 'custom', 'direct_surface_print')),
      width: 4096,
      height: 4096,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_USAGE' }))
  })

  it('enforces a cumulative encoded-byte budget', () => {
    expect(() => assertReviewEncodedByteBudget(120 * 1024 * 1024, 9 * 1024 * 1024))
      .toThrowError(expect.objectContaining({ code: 'BROWSER_NOT_READY' }))
    expect(assertReviewEncodedByteBudget(120 * 1024 * 1024, 8 * 1024 * 1024)).toBe(128 * 1024 * 1024)
  })
})
