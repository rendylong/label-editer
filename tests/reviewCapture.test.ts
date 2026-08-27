// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CarrierMode } from '../src/agent/designContracts'
import type { ReviewViewRequest } from '../src/agent/contracts'
import {
  captureFlatArtworkReview,
  composeReviewSheet,
  type AgentReviewCaptureContext,
  type AgentReviewCaptureResult,
} from '../src/agent/previewCapture'
import { pngBlob } from './pngTestUtils'

function flatRequest(carrier: CarrierMode): ReviewViewRequest {
  return {
    id: `label-${carrier}`, kind: 'flat-artwork', width: 1600, height: 1600,
    areaId: carrier, areaToken: carrier, side: 'front', carrier,
  }
}

function result(request: ReviewViewRequest, blob = pngBlob(request.width, request.height)): AgentReviewCaptureResult {
  return { id: request.id, kind: request.kind, blob, width: request.width, height: request.height }
}

describe('clean review browser composition', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    'direct_surface_print', 'applied_label', 'clear_label', 'in_mold', 'foil_or_ink_only',
  ] as const)('composites the current %s bake without synthesizing a carrier panel', async (carrier) => {
    const source = { width: 400, height: 600 } as HTMLCanvasElement
    const calls: unknown[][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: (...args: unknown[]) => calls.push(['setTransform', ...args]),
      fillStyle: '',
      fillRect: (...args: unknown[]) => calls.push(['fillRect', ...args]),
      drawImage: (...args: unknown[]) => calls.push(['drawImage', ...args]),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(callback) {
      callback(new Blob(['flat'], { type: 'image/png' }))
    })

    const captured = await captureFlatArtworkReview(flatRequest(carrier), source)

    expect(captured).toMatchObject({
      id: `label-${carrier}`, kind: 'flat-artwork', width: 1600, height: 1600,
      blob: expect.objectContaining({ type: 'image/png' }),
    })
    expect(calls.filter(([name]) => name === 'fillRect')).toEqual([['fillRect', 0, 0, 1600, 1600]])
    expect(calls.filter(([name]) => name === 'drawImage')).toEqual([
      ['drawImage', source, expect.closeTo(266.6666667), 0, expect.closeTo(1066.6666667), 1600],
    ])
  })

  it('rejects bare and stale/mismatched flat sources before allocation', async () => {
    await expect(captureFlatArtworkReview(flatRequest('bare'), { width: 400, height: 600 } as HTMLCanvasElement))
      .rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    await expect(captureFlatArtworkReview(flatRequest('clear_label'), { width: 0, height: 600 } as HTMLCanvasElement))
      .rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
  })

  it('composes the sheet from exactly planned bounded PNG sources with claim-free labels', async () => {
    const flat = flatRequest('direct_surface_print')
    flat.areaToken = 'approved-front'
    const surface: ReviewViewRequest = { ...flat, id: 'surface-front', kind: 'surface-face' }
    const model: ReviewViewRequest = { id: 'model-front', kind: 'model-front', width: 1600, height: 1600 }
    const sheet: ReviewViewRequest = {
      id: 'review-sheet', kind: 'review-sheet', width: 1600, height: 1600,
      sourceViewIds: [flat.id, surface.id, model.id],
    }
    const context: AgentReviewCaptureContext = {
      blueprintRevision: 'approved-v1', inputRevision: 'production-ready-v2',
      sources: [flat, surface, model].map((request) => ({ request, result: result(request) })),
    }
    const drawCalls: unknown[][] = []
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1600, height: 1600, close: vi.fn() })))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
      fillRect: (...args: unknown[]) => drawCalls.push(['fillRect', ...args]),
      drawImage: (...args: unknown[]) => drawCalls.push(['drawImage', ...args]),
      fillText: (...args: unknown[]) => drawCalls.push(['fillText', ...args]),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(callback) {
      callback(new Blob(['sheet'], { type: 'image/png' }))
    })

    const captured = await composeReviewSheet(sheet, context)

    expect(captured).toMatchObject({ id: 'review-sheet', kind: 'review-sheet', width: 1600, height: 1600 })
    expect(createImageBitmap).toHaveBeenCalledTimes(3)
    const labelCalls = drawCalls.filter(([name]) => name === 'fillText')
    expect(labelCalls).toHaveLength(6)
    const labels = labelCalls.map((call) => String(call[1])).join(' ')
    expect(labels).toContain('front')
    expect(labels).toContain('View 03 | Model front')
    expect(labels).not.toMatch(/approved|approval|accepted|passed|production[ -]?ready|manufacturing[ -]?ready|\bqc\b|certif|press[ -]?ready/i)
  })

  it.each([
    ['missing', (sources: AgentReviewCaptureContext['sources']) => sources.slice(0, 1)],
    ['duplicate', (sources: AgentReviewCaptureContext['sources']) => [...sources, sources[0]]],
    ['wrong id', (sources: AgentReviewCaptureContext['sources']) => sources.map((source, index) => index === 0 ? { ...source, result: { ...source.result, id: 'wrong' } } : source)],
    ['wrong type', (sources: AgentReviewCaptureContext['sources']) => sources.map((source, index) => index === 0 ? { ...source, result: result(source.request, new Blob(['x'], { type: 'text/plain' })) } : source)],
    ['wrong dimensions', (sources: AgentReviewCaptureContext['sources']) => sources.map((source, index) => index === 0 ? { ...source, result: { ...source.result, width: 1 } } : source)],
  ])('rejects %s sheet sources before image decode', async (_label, mutate) => {
    const flat = flatRequest('clear_label')
    const model: ReviewViewRequest = { id: 'model-front', kind: 'model-front', width: 1600, height: 1600 }
    const sheet: ReviewViewRequest = {
      id: 'review-sheet', kind: 'review-sheet', width: 1600, height: 1600,
      sourceViewIds: [flat.id, model.id],
    }
    const sources = [flat, model].map((request) => ({ request, result: result(request) }))
    vi.stubGlobal('createImageBitmap', vi.fn())

    await expect(composeReviewSheet(sheet, {
      blueprintRevision: 'v1', inputRevision: 'v2', sources: mutate(sources),
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it.each([
    ['a 1x1 PNG claiming planned 1600x1600 dimensions', pngBlob(1, 1)],
    ['an oversized IHDR before bitmap allocation', pngBlob(9000, 9000)],
  ])('structurally rejects %s', async (_label, blob) => {
    const flat = flatRequest('clear_label')
    const sheet: ReviewViewRequest = {
      id: 'review-sheet', kind: 'review-sheet', width: 1600, height: 1600,
      sourceViewIds: [flat.id],
    }
    vi.stubGlobal('createImageBitmap', vi.fn())

    await expect(composeReviewSheet(sheet, {
      blueprintRevision: 'opaque-approved-revision', inputRevision: 'opaque-passed-revision',
      sources: [{ request: flat, result: result(flat, blob) }],
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    expect(createImageBitmap).not.toHaveBeenCalled()
  })
})
