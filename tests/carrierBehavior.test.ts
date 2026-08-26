import { describe, expect, it } from 'vitest'
import { fitCarrierBoundaryToCanvas, resolveCarrierSurface } from '../src/label/paper'
import { carrierReadinessChecks } from '../src/label/exportReadiness'
import { buildPrintManifest, validatePrintReadiness } from '../src/label/printReadiness'
import type { CarrierMode, LabelAreaConfig, LabelLayer, ProcessIntent } from '../src/label/types'

function decorationLayer(processes: ProcessIntent[] = []): LabelLayer {
  return {
    id: 'brand', kind: 'shape', shape: 'rectangle', x: 10, y: 10, width: 80, height: 40,
    fill: '#18212b', stroke: 'transparent', strokeWidth: 0, cornerRadius: 0,
    rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [], processes,
  }
}

function carrierArea(
  carrier: CarrierMode,
  options: {
    substrate?: LabelAreaConfig['substrate']
    processes?: ProcessIntent[]
    layers?: LabelLayer[]
    printSpec?: LabelAreaConfig['printSpec']
    paper?: LabelAreaConfig['paper']
  } = {},
): LabelAreaConfig {
  return {
    id: `area-${carrier}`, name: `Area ${carrier}`, meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 400, height: 600, aspect: 2 / 3 },
    carrier,
    artboard: { widthMm: 40, heightMm: 60, background: 'transparent' },
    ...(options.substrate === undefined ? {} : { substrate: options.substrate }),
    ...(options.printSpec === undefined ? {} : { printSpec: options.printSpec }),
    ...(options.paper === undefined ? {} : { paper: options.paper }),
    layers: options.layers ?? [decorationLayer(options.processes)],
    globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

const appliedSubstrate: NonNullable<LabelAreaConfig['substrate']> = {
  kind: 'opaque', color: '#f2efe4', opacity: 0.92,
  boundary: { shape: 'rounded_rectangle', radiusMm: 1.5 }, adhesive: 'pressure-sensitive',
}

const clearSubstrate: NonNullable<LabelAreaConfig['substrate']> = {
  kind: 'transparent', opacity: 0.08,
  boundary: { shape: 'rectangle' }, adhesive: 'clear pressure-sensitive',
}

describe('canonical carrier rendering and readiness', () => {
  it.each([
    ['direct_surface_print', undefined, false, true, ['ink-adhesion', 'opacity', 'curvature', 'registration', 'rub-resistance']],
    ['applied_label', appliedSubstrate, true, true, ['bleed', 'die-cut', 'edge-adhesion']],
    ['clear_label', clearSubstrate, false, true, ['white-underbase', 'film-extent', 'registration', 'edge-adhesion']],
    ['in_mold', undefined, false, true, ['in-mold-process', 'registration']],
    ['foil_or_ink_only', undefined, false, true, ['registration', 'declared-process']],
    ['bare', undefined, false, false, []],
  ] as const)(
    'resolves %s without fabricating carrier geometry',
    (carrier, substrate, substrateVisible, renderDecoration, expectedChecks) => {
      const processes: ProcessIntent[] = carrier === 'direct_surface_print'
        ? [{ process: 'screen_print', requiredMask: 'color' }]
        : carrier === 'clear_label'
          ? [{ process: 'white_underbase', spotName: 'WHITE', requiredMask: 'white_underbase' }]
          : carrier === 'in_mold'
            ? [{ process: 'in_mold', requiredMask: 'color' }]
            : carrier === 'foil_or_ink_only'
              ? [{ process: 'hot_stamp_foil', spotName: 'GOLD', requiredMask: 'metalness' }]
              : []
      const area = carrierArea(carrier, { substrate, processes })
      const surface = resolveCarrierSurface(area)
      const checks = carrierReadinessChecks(area).map((check) => check.code)

      expect(surface).toMatchObject({ carrier, substrateVisible, renderDecoration })
      expect(checks).toEqual(expect.arrayContaining([...expectedChecks]))
      if (carrier === 'bare') expect(checks).toEqual([])
      if (['direct_surface_print', 'in_mold', 'foil_or_ink_only', 'bare'].includes(carrier)) {
        expect(surface).toMatchObject({ boundaryVisible: false, adhesiveApplicable: false, bleedApplicable: false, dieCutApplicable: false })
      }
      if (carrier === 'clear_label') {
        expect(surface).toMatchObject({ diagnosticFilmExtent: true, substrateVisible: false, boundaryVisible: false })
      }
    },
  )

  it('adds white-underbase applicability only when a direct-print layer declares it', () => {
    const ordinary = carrierArea('direct_surface_print', { processes: [{ process: 'screen_print' }] })
    const underbase = carrierArea('direct_surface_print', {
      processes: [{ process: 'white_underbase', requiredMask: 'white_underbase' }],
    })

    expect(carrierReadinessChecks(ordinary).map((check) => check.code)).not.toContain('white-underbase')
    expect(carrierReadinessChecks(underbase).map((check) => check.code)).toContain('white-underbase')
  })

  it('preserves enabled and disabled legacy paper resolution exactly', () => {
    const enabled = carrierArea('applied_label')
    delete enabled.carrier
    enabled.paper = { enabled: true, color: '#ece9dd', opacity: 0.92 }
    delete enabled.substrate
    const disabled = { ...enabled, paper: { enabled: false, color: '#ece9dd', opacity: 0.92 } }

    expect(resolveCarrierSurface(enabled)).toMatchObject({
      carrier: 'legacy', substrateVisible: true, substrateColor: '#ece9dd', substrateOpacity: 0.92,
      renderDecoration: true,
    })
    expect(resolveCarrierSurface(disabled)).toMatchObject({
      carrier: 'legacy', substrateVisible: false, substrateColor: '#ece9dd', substrateOpacity: 0.92,
      renderDecoration: true,
    })
  })

  it('reports carrier invariant conflicts while rendering refuses forbidden panels', () => {
    const direct = carrierArea('direct_surface_print', { substrate: appliedSubstrate })
    const applied = carrierArea('applied_label')
    const clear = carrierArea('clear_label', { substrate: appliedSubstrate })
    const bare = carrierArea('bare', { layers: [decorationLayer()] })

    expect(resolveCarrierSurface(direct).substrateVisible).toBe(false)
    expect(validatePrintReadiness(direct)).toContainEqual(expect.objectContaining({
      code: 'carrier-forbidden-substrate', areaId: direct.id, fields: ['substrate'],
    }))
    expect(validatePrintReadiness(applied)).toContainEqual(expect.objectContaining({
      code: 'missing-applied-substrate', areaId: applied.id, fields: ['substrate'],
    }))
    expect(validatePrintReadiness(clear)).toContainEqual(expect.objectContaining({
      code: 'non-transparent-clear-substrate', areaId: clear.id, fields: ['substrate.kind'],
    }))
    expect(validatePrintReadiness(bare)).toContainEqual(expect.objectContaining({
      code: 'decoration-on-bare', areaId: bare.id, fields: ['layers'],
    }))
  })

  it('does not emit paper-only readiness or fabricate a print manifest for bare', () => {
    const bare = carrierArea('bare', { layers: [] })

    expect(validatePrintReadiness(bare)).toEqual([])
    expect(buildPrintManifest(bare)).toMatchObject({
      carrier: 'bare', dimensionsMm: null, dieCutShape: null, minimumTextHeightMm: null,
      separations: [], issues: [],
    })
  })

  it.each(['direct_surface_print', 'clear_label', 'in_mold', 'foil_or_ink_only', 'bare'] as const)(
    'does not emit paper-only issues for %s',
    (carrier) => {
      const substrate = carrier === 'clear_label' ? clearSubstrate : undefined
      const area = carrierArea(carrier, { substrate, layers: [] })
      const issueCodes = validatePrintReadiness(area).map((issue) => issue.code)

      expect(issueCodes).not.toContain('missing-print-spec')
      expect(issueCodes).not.toContain('missing-bleed')
    },
  )

  it('accepts a declared hot-foil process spot name as the foil separation identity', () => {
    const layer = decorationLayer([{ process: 'hot_stamp_foil', spotName: 'COPPER' }])
    layer.craft = [{ type: 'foil', params: { foilColor: 'custom', foilCustomColor: '#b56f52' } }]
    const area = carrierArea('foil_or_ink_only', { layers: [layer] })

    expect(validatePrintReadiness(area).map((issue) => issue.code)).not.toContain('foil-without-spot-name')
  })

  it('retains explicitly declared print and process separations in carrier-aware manifests', () => {
    const area = carrierArea('applied_label', {
      substrate: appliedSubstrate,
      processes: [{ process: 'screen_print', spotName: 'BRAND_BLUE', requiredMask: 'color' }],
      printSpec: {
        physicalWidthMm: 40, physicalHeightMm: 60, bleedMm: 2, cornerRadiusMm: 1.5,
        minTextHeightMm: 1.2, dieCutShape: 'rounded-rectangle', spotColors: ['VARNISH_SPOT'],
      },
    })

    expect(buildPrintManifest(area).separations).toEqual(['color', 'BRAND_BLUE', 'VARNISH_SPOT'])
  })

  it('limits an invalid bare area to the structured decoration conflict', () => {
    const layer = decorationLayer()
    layer.craft = [{ type: 'foil', params: {} }]
    const area = carrierArea('bare', {
      layers: [layer],
      printSpec: {
        physicalWidthMm: 40, physicalHeightMm: 60, bleedMm: 0, cornerRadiusMm: 0,
        minTextHeightMm: 1.2, dieCutShape: 'rectangle', spotColors: [],
      },
    })

    expect(validatePrintReadiness(area).map((issue) => issue.code)).toEqual(['decoration-on-bare'])
  })

  it.each([
    ['legacy without printSpec', (() => {
      const value = carrierArea('applied_label', { layers: [] })
      delete value.carrier
      delete value.printSpec
      return value
    })()],
    ['bare', carrierArea('bare', { layers: [] })],
  ] as const)('blocks malformed runtime vector geometry before the %s early return', (_label, target) => {
    const path = {
      ...decorationLayer(),
      shape: 'path' as const,
      pathData: 'M0 0A1 1 0 0 1 0 0',
      pathViewBox: [0, 0, 1, 1] as [number, number, number, number],
    }
    const area = { ...target, layers: [path] }
    const issues = validatePrintReadiness(area)

    expect(issues).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'invalid-vector-path', areaId: area.id,
      layerId: path.id, field: 'pathData', fields: ['pathData'],
    }))
    if (area.carrier === 'bare') {
      const codes = issues.map((issue) => issue.code)
      expect(codes).not.toContain('missing-print-spec')
      expect(codes).not.toContain('missing-bleed')
      expect(codes).not.toContain('text-below-minimum-height')
      expect(codes).not.toContain('foil-without-spot-name')
    }
  })

  it.each([
    ['rectangle', undefined],
    ['rounded_rectangle', undefined],
    ['ellipse', undefined],
    ['custom', 'M0 0H40V60H0Z'],
  ] as const)('accepts a valid %s physical boundary without changing its kind', (shape, pathData) => {
    const area = carrierArea('applied_label', {
      substrate: {
        kind: 'opaque', color: '#f2efe4', opacity: 1,
        boundary: { shape, ...(pathData ? { pathData } : {}) },
      },
    })

    expect(resolveCarrierSurface(area)).toMatchObject({
      substrateVisible: true, boundaryVisible: true,
      boundary: expect.objectContaining({ shape }),
    })
    expect(validatePrintReadiness(area).map((issue) => issue.code)).not.toContain('invalid-custom-boundary')
  })

  it('fits a positive sub-unit custom boundary exactly to the render artboard', () => {
    const surface = resolveCarrierSurface(carrierArea('applied_label', {
      substrate: {
        kind: 'opaque', color: '#f2efe4', opacity: 1,
        boundary: { shape: 'custom', pathData: 'M0 0H0.5V0.5H0Z' },
      },
    }))

    expect(fitCarrierBoundaryToCanvas(surface.boundary!, { width: 400, height: 600 })).toEqual({
      x: 0, y: 0, scaleX: 800, scaleY: 1200,
    })
  })

  it.each([
    [undefined, 'substrate.boundary.pathData'],
    ['', 'substrate.boundary.pathData'],
    ['M0 0 L', 'substrate.boundary.pathData'],
    ['M0 0H40V60', 'substrate.boundary.pathData'],
    ['M0 0Z', 'substrate.boundary.pathData'],
  ] as const)('never fabricates a rectangle for invalid custom boundary %j', (pathData, field) => {
    const area = carrierArea('applied_label', {
      substrate: {
        kind: 'opaque', color: '#f2efe4', opacity: 1,
        boundary: { shape: 'custom', ...(pathData === undefined ? {} : { pathData }) },
      },
    })

    expect(resolveCarrierSurface(area)).toMatchObject({ substrateVisible: false, boundaryVisible: false })
    expect(validatePrintReadiness(area)).toContainEqual(expect.objectContaining({
      code: 'invalid-custom-boundary', areaId: area.id, fields: [field],
    }))
  })

  it('requires a valid transparent film boundary for clear labels', () => {
    const missing = carrierArea('clear_label', {
      substrate: { kind: 'transparent', opacity: 0.08 },
    })
    const invalid = carrierArea('clear_label', {
      substrate: { kind: 'transparent', opacity: 0.08, boundary: { shape: 'custom', pathData: 'M0 0L' } },
    })

    expect(resolveCarrierSurface(missing).diagnosticFilmExtent).toBe(false)
    expect(validatePrintReadiness(missing)).toContainEqual(expect.objectContaining({
      code: 'missing-clear-boundary', fields: ['substrate.boundary'],
    }))
    expect(resolveCarrierSurface(invalid).diagnosticFilmExtent).toBe(false)
    expect(validatePrintReadiness(invalid)).toContainEqual(expect.objectContaining({
      code: 'invalid-custom-boundary', fields: ['substrate.boundary.pathData'],
    }))
  })

  it('rejects an opaque applied substrate with zero opacity', () => {
    const area = carrierArea('applied_label', {
      substrate: { ...appliedSubstrate, opacity: 0 },
    })

    expect(resolveCarrierSurface(area).substrateVisible).toBe(false)
    expect(validatePrintReadiness(area)).toContainEqual(expect.objectContaining({
      code: 'invalid-applied-substrate-opacity', areaId: area.id, fields: ['substrate.opacity'],
    }))
  })

  it('does not list white underbase from an unproven injected separation canvas', () => {
    const area = carrierArea('clear_label', {
      substrate: clearSubstrate,
      processes: [{ process: 'white_underbase', spotName: 'WHITE', requiredMask: 'white_underbase' }],
    })
    const color = { width: 400, height: 600 } as HTMLCanvasElement
    const whiteUnderbase = { width: 400, height: 600 } as HTMLCanvasElement

    expect(buildPrintManifest(area).separations).not.toContain('white_underbase')
    expect(buildPrintManifest(area, { color, whiteUnderbase }).separations).toEqual([])
  })
})
