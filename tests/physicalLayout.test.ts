import { describe, expect, it } from 'vitest'
import { resolvePhysicalLayout, resolveTargetAspect } from '../src/app/physicalLayout'
import * as canvasLayout from '../src/app/canvasLayout'

describe('physical label layout', () => {
  it('accepts proportional bake sizes that preserve the declared target aspect', () => {
    expect(canvasLayout.withBakeCanvasSize(
      { width: 1024, height: 1536, aspect: 2 / 3 },
      { width: 4096, height: 6144 },
    )).toEqual({ width: 4096, height: 6144, aspect: 2 / 3 })
  })

  it('rejects a bake raster that disagrees with the declared target aspect', () => {
    expect(() => canvasLayout.withBakeCanvasSize(
      { width: 1024, height: 1536, aspect: 2 / 3 },
      { width: 4096, height: 4096 },
    )).toThrow(expect.objectContaining({
      name: 'RasterAspectError',
      code: 'RASTER_ASPECT_MISMATCH',
      details: expect.objectContaining({ declaredAspect: 2 / 3, rasterAspect: 1, width: 4096, height: 4096 }),
    }))
  })

  it.each([
    [4096, 6143],
    [4095, 6144],
  ])('rejects a one-pixel raster mismatch at %ix%i', (width, height) => {
    expect(() => canvasLayout.withBakeCanvasSize(
      { width: 1024, height: 1536, aspect: 2 / 3 },
      { width, height },
    )).toThrow(expect.objectContaining({
      name: 'RasterAspectError',
      code: 'RASTER_ASPECT_MISMATCH',
      details: expect.objectContaining({ width, height, tolerance: 0 }),
    }))
  })

  it('uses one canonical rounded height for a non-integer ideal raster and its display stage', () => {
    const aspect = 1.9846801867572283

    expect(canvasLayout.canonicalRasterHeight?.(2048, aspect)).toBe(1032)
    expect(canvasLayout.withBakeCanvasSize(
      { width: 2048, height: 1032, aspect },
      { width: 2048, height: 1032 },
    )).toEqual({ width: 2048, height: 1032, aspect })
    expect(() => canvasLayout.withBakeCanvasSize(
      { width: 2048, height: 1032, aspect },
      { width: 2048, height: 1031 },
    )).toThrow(expect.objectContaining({ code: 'RASTER_ASPECT_MISMATCH' }))
    expect(canvasLayout.fitRasterDisplayHeight?.(900, { width: 2048, height: 1032, aspect })).toBe(453.515625)
  })

  it.each([[1024, 1024], [2048, 2048], [4096, 4096]])(
    'keeps apparent type and relative spacing at bake %ix%i',
    (width, height) => {
      const result = resolvePhysicalLayout({
        artboard: { widthMm: 40, heightMm: 60 },
        canvas: { width, height, aspect: 2 / 3 },
        boundsMm: { x: 5, y: 8, width: 30, height: 8 },
        fontSizeMm: 4,
      })

      expect(result.status).toBe('resolved')
      if (result.status !== 'resolved') return
      expect(result.normalizedBounds).toEqual({ x: 0.125, y: 8 / 60, width: 0.75, height: 8 / 60 })
      expect(result.fontSizeMm).toBe(4)
      expect(result.pixelBounds).toEqual({
        x: width * 0.125,
        y: height * (8 / 60),
        width: width * 0.75,
        height: height * (8 / 60),
      })
      expect(result.fontSizePx).toBeCloseTo(height * (4 / 60), 10)
    },
  )

  it('converts physical font, stroke, and corner metrics with one uniform bake scale', () => {
    const result = resolvePhysicalLayout({
      artboard: { widthMm: 40, heightMm: 60 },
      canvas: { width: 1200, height: 1800, aspect: 2 / 3 },
      boundsMm: { x: 5, y: 8, width: 30, height: 8 },
      fontSizeMm: 4,
      strokeWidthMm: 0.25,
      cornerRadiusMm: 1.5,
      anchor: 'center',
    })

    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') return
    expect(result.pixelsPerMm).toBe(30)
    expect(result.fontSizePx).toBe(120)
    expect(result.strokeWidthPx).toBe(7.5)
    expect(result.cornerRadiusPx).toBe(45)
    expect(result.anchorPx).toEqual({ x: 600, y: 360 })
  })

  it('fits a portrait artboard into a square target without stretching', () => {
    const result = resolvePhysicalLayout({
      artboard: { widthMm: 40, heightMm: 60 },
      canvas: { width: 1200, height: 1200, aspect: 1 },
      boundsMm: { x: 0, y: 0, width: 40, height: 60 },
      policy: 'fit',
    })

    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') return
    expect(result.scale).toEqual({ x: 2 / 3, y: 1 })
    expect(result.offsets.x).toBeCloseTo(1 / 6, 12)
    expect(result.offsets.y).toBe(0)
    expect(result.mappedBounds).toMatchObject({ y: 0, width: 2 / 3, height: 1 })
    expect(result.mappedBounds?.x).toBeCloseTo(1 / 6, 12)
    expect(result.pixelBounds).toMatchObject({ y: 0, width: 800, height: 1200 })
    expect(result.pixelBounds?.x).toBeCloseTo(200, 10)
    expect(result.pixelsPerMm).toBe(20)
  })

  it('uses only an approved physical crop rectangle for crop-approved placement', () => {
    const approvedCrop = { x: 5, y: 10, width: 30, height: 30 }
    const result = resolvePhysicalLayout({
      artboard: { widthMm: 40, heightMm: 60 },
      canvas: { width: 2048, height: 2048, aspect: 1 },
      boundsMm: approvedCrop,
      policy: 'crop-approved',
      approvedCrop,
    })

    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') return
    expect(result.crop).toEqual({ x: 0.125, y: 1 / 6, width: 0.75, height: 0.5 })
    expect(result.mappedBounds).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(result.validationDetails).toEqual({ declaredAspect: 2 / 3, resolvedAspect: 1 })
  })

  it('blocks crop-approved placement without an approved crop rectangle', () => {
    const result = resolvePhysicalLayout({
      artboard: { widthMm: 40, heightMm: 60 },
      canvas: { width: 2048, height: 2048, aspect: 1 },
      boundsMm: { x: 5, y: 8, width: 30, height: 8 },
      policy: 'crop-approved',
    })

    expect(result).toEqual({
      status: 'blocked',
      code: 'TARGET_ASPECT_MISMATCH',
      validationDetails: { declaredAspect: 2 / 3, resolvedAspect: 1 },
    })
  })

  it('blocks silent stretch when fit cannot preserve artboard aspect', () => {
    expect(resolveTargetAspect({ artboardAspect: 2 / 3, targetAspect: 1, policy: 'block' }))
      .toEqual({ status: 'blocked', code: 'TARGET_ASPECT_MISMATCH' })
  })

  it('accepts Float32-derived target aspect noise within one ppm but blocks a larger mismatch', () => {
    expect(resolveTargetAspect({ artboardAspect: 1, targetAspect: 1 + 0.9e-6, policy: 'block' }))
      .toEqual({ status: 'resolved', scale: { x: 1, y: 1 }, offsets: { x: 0, y: 0 } })
    expect(resolveTargetAspect({ artboardAspect: 1, targetAspect: 1 + 1.1e-6, policy: 'block' }))
      .toEqual({ status: 'blocked', code: 'TARGET_ASPECT_MISMATCH' })
  })
})
