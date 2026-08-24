import { describe, expect, it, vi } from 'vitest'
import type { LabelLayer, UploadedFontRecord } from '../src/label/types'
import { createFontReadinessRevisionGate } from '../src/label/designFontReadiness'
import { deriveDesignFontRequests, type FontLoadReport } from '../src/label/fontRuntime'

function textLayer(id: string, fontFamily: string, fontWeight = 400): LabelLayer {
  return {
    id, kind: 'text', text: id, fontFamily, fontSize: 32, fontWeight,
    letterSpacing: 0, lineHeight: 1.2, color: '#111111', align: 'left', italic: false,
    x: 0, y: 0, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
  }
}

describe('design font readiness', () => {
  it('derives and deduplicates only used catalog, uploaded, and system font requests', () => {
    const uploaded: UploadedFontRecord[] = [{ name: 'Brand Font', dataUrl: 'data:font/woff2;base64,AAAA' }]
    const requests = deriveDesignFontRequests([
      textLayer('a', 'inter'),
      textLayer('b', 'inter'),
      textLayer('c', 'upload:brand-font'),
      textLayer('d', 'arial'),
      { ...textLayer('e', 'inter'), kind: 'shape', shape: 'rectangle', width: 10, height: 10, fill: '#000', stroke: '#000', strokeWidth: 0, cornerRadius: 0 } as LabelLayer,
    ], uploaded)

    expect(requests).toHaveLength(3)
    expect(requests[0]).toMatchObject({ key: 'catalog/inter/400/normal', kind: 'catalog', name: 'Inter' })
    expect(requests[1]).toMatchObject({ kind: 'uploaded', name: 'Brand Font' })
    expect(requests[1].key).toMatch(/^uploaded\/upload:brand-font\/\d+-AAAA$/)
    expect(requests[2]).toMatchObject({ key: 'system/arial', kind: 'system', name: 'Arial' })
  })

  it('increments the redraw revision only for the latest active area request', async () => {
    let resolveA!: (report: FontLoadReport) => void
    let resolveB!: (report: FontLoadReport) => void
    const areaA = new Promise<FontLoadReport>((resolve) => { resolveA = resolve })
    const areaB = new Promise<FontLoadReport>((resolve) => { resolveB = resolve })
    const redraw = vi.fn()
    const gate = createFontReadinessRevisionGate(redraw)

    const a = gate.track('area-a', areaA)
    const b = gate.track('area-b', areaB)
    resolveA({ ready: ['Inter'], unavailable: [] })
    expect(await a).toBe(false)
    expect(redraw).not.toHaveBeenCalled()
    resolveB({ ready: ['Arial'], unavailable: [] })
    expect(await b).toBe(true)
    expect(redraw).toHaveBeenCalledWith({ areaId: 'area-b', revision: 1, readinessKey: '', report: { ready: ['Arial'], unavailable: [] } })
  })

  it('does not redraw after its owner is disposed', async () => {
    let resolve!: (report: FontLoadReport) => void
    const pending = new Promise<FontLoadReport>((next) => { resolve = next })
    const redraw = vi.fn()
    const gate = createFontReadinessRevisionGate(redraw)
    const tracked = gate.track('area-a', pending)

    gate.dispose()
    resolve({ ready: ['Inter'], unavailable: [] })

    expect(await tracked).toBe(false)
    expect(redraw).not.toHaveBeenCalled()
  })

  it('reports the exact font-request key whose completion owns the redraw revision', async () => {
    const redraw = vi.fn()
    const gate = createFontReadinessRevisionGate(redraw)

    await gate.track(
      'area-a',
      Promise.resolve({ ready: ['Playfair Display'], unavailable: [] }),
      'catalog/playfair-display/400/normal',
    )

    expect(redraw).toHaveBeenCalledWith({
      areaId: 'area-a',
      revision: 1,
      readinessKey: 'catalog/playfair-display/400/normal',
      report: { ready: ['Playfair Display'], unavailable: [] },
    })
  })
})
