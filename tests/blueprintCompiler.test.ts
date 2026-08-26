import { describe, expect, it } from 'vitest'
import { BlueprintCompilerError, compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
import type { LayoutBlueprintV1 } from '../src/agent/designContracts'
import { validateLabelSpec } from '../src/agent/labelSpecSchema'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import { serializeLabelProject } from '../src/app/projectSchema'
import type { LabelAreaConfig } from '../src/label/types'

const shell: LabelAreaConfig = {
  id: 'area-front', name: 'Front shell', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
  remap: { mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] } },
  range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, canvas: { width: 1000, height: 500, aspect: 2 },
  layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
}

function laviraBlueprint(): LayoutBlueprintV1 {
  const text = (
    id: string,
    value: string,
    y: number,
    fontSizeMm: number,
    color = '#4A2B24',
  ): LayoutBlueprintV1['areas'][number]['layers'][number] => ({
    id, kind: 'text', boundsMm: { x: 7, y, width: 28, height: 6 }, anchor: 'top_center',
    rotation: 0, opacity: 1, visible: true, zIndex: 0, processes: [{ process: 'screen_print' }],
    text: value, language: id === 'product-cn' ? 'zh-Hans' : 'en', writingDirection: 'ltr',
    fontStack: ['Noto Sans CJK SC', 'sans-serif'], fontSizeMm, fontWeight: 500,
    letterSpacingEm: id === 'product-cn' ? 0.04 : 0.08, lineHeight: 1.1,
    alignment: 'center', wrapPolicy: 'none', maxLines: 1, color,
  })
  return {
    version: 1,
    revision: 'lavira-ember-v1',
    carrierDefaults: { carrier: 'direct_surface_print' },
    assets: [],
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      artboard: { widthMm: 42, heightMm: 68, background: 'transparent' },
      placementIntent: 'Centered on the front bottle face.', placementPolicy: 'fit',
      layers: [
        text('brand', 'LAVIRA', 6, 2.8),
        text('product-cn', '烬木之息', 16, 5.6, '#7D3F2A'),
        text('product-en', 'EMBER WOODS', 24, 2.4),
        text('tagline', 'EAU DE PARFUM', 31, 1.7),
        text('category', 'WOODY AMBER', 38, 1.5),
        text('volume', '50 mL / 1.7 FL. OZ.', 54, 1.4),
        {
          id: 'copper-frame', kind: 'shape', boundsMm: { x: 3, y: 3, width: 36, height: 60 },
          anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 6,
          processes: [{ process: 'hot_stamp_foil', spotName: 'COPPER' }],
          shape: 'path', pathData: 'M 0 60 L 0 0 L 36 0 L 36 60', pathViewBox: [0, 0, 36, 60],
          fillRule: 'nonzero', fill: 'transparent', stroke: '#A5663B', strokeWidthMm: 0.3,
        },
        {
          id: 'contour-left', kind: 'shape', boundsMm: { x: 0, y: 12, width: 14, height: 36 },
          anchor: 'center', rotation: -12, opacity: 0.32, visible: true, zIndex: 7, processes: [],
          shape: 'ellipse', fill: 'transparent', stroke: '#A5663B', strokeWidthMm: 0.2,
        },
        {
          id: 'contour-right', kind: 'shape', boundsMm: { x: 28, y: 12, width: 14, height: 36 },
          anchor: 'center', rotation: 12, opacity: 0.32, visible: true, zIndex: 8, processes: [],
          shape: 'ellipse', fill: 'transparent', stroke: '#A5663B', strokeWidthMm: 0.2,
        },
      ],
    }],
  }
}

describe('blueprint compiler', () => {
  it('preserves copy, order, color, metrics, vectors, and processes', () => {
    const front = compileBlueprintToSpecAreas(laviraBlueprint()).find((area) => area.id === 'front')!

    expect(front.carrier).toBe('direct_surface_print')
    expect(front.layers.map((layer) => layer.id)).toEqual([
      'brand', 'product-cn', 'product-en', 'tagline', 'category',
      'volume', 'copper-frame', 'contour-left', 'contour-right',
    ])
    expect(front.layers.find((layer) => layer.id === 'product-cn')).toMatchObject({
      type: 'text', text: '烬木之息', language: 'zh-Hans', color: '#7D3F2A',
      designMetrics: { fontSizeMm: 5.6, letterSpacingEm: 0.04, anchor: 'top_center' },
      processes: [{ process: 'screen_print' }],
    })
    expect(front.layers.find((layer) => layer.id === 'copper-frame')).toMatchObject({
      type: 'shape', shape: 'path', fill: 'transparent',
      pathData: 'M 0 60 L 0 0 L 36 0 L 36 60', pathViewBox: [0, 0, 36, 60],
      designMetrics: { strokeWidthMm: 0.3 },
      processes: [{ process: 'hot_stamp_foil', spotName: 'COPPER' }],
      craft: [{ type: 'foil', params: { foilColor: 'custom', foilCustomColor: '#A5663B', foilSpotName: 'COPPER' } }],
    })
  })

  it('resolves blueprint asset ids into an applicable image spec', () => {
    const blueprint = laviraBlueprint()
    blueprint.assets.push({
      id: 'botanical-art', path: 'assets/botanical-art.png', sha256: 'a'.repeat(64),
      mimeType: 'image/png', width: 1200, height: 800,
    })
    blueprint.areas[0].layers = [{
      id: 'botanical', kind: 'image', normalizedBounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
      anchor: 'center', rotation: 0, opacity: 0.75, visible: true, zIndex: 0, processes: [],
      assetId: 'botanical-art', fit: 'contain',
    }]

    const areas = compileBlueprintToSpecAreas(blueprint)

    expect(areas[0].layers[0]).toMatchObject({
      id: 'botanical', type: 'image', asset: 'assets/botanical-art.png', opacity: 0.75,
      designMetrics: { normalizedBounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 }, anchor: 'center' },
    })
    expect(validateLabelSpec({ version: 2, areas }).ok).toBe(true)
  })

  it('rejects an unsupported editable kind with the disclosed flattened option', () => {
    const blueprint = laviraBlueprint()
    blueprint.areas[0].layers = [{
      id: 'glow', kind: 'gradient', boundsMm: { x: 2, y: 2, width: 38, height: 64 },
      anchor: 'center', rotation: 0, opacity: 1, visible: true, zIndex: 0, processes: [{ process: 'varnish' }],
      flattenedFallback: {
        accepted: true, nonEditableLayerIds: ['glow'], nonEditableTextIds: [],
        lostSeparations: ['gradient-varnish'], vectorAlternative: 'Provide stepped vector contours.',
      },
    } as unknown as LayoutBlueprintV1['areas'][number]['layers'][number]]

    expect(() => compileBlueprintToSpecAreas(blueprint)).toThrowError(expect.objectContaining({
      code: 'UNREPRESENTABLE_LAYER',
      details: {
        areaId: 'front', layerId: 'glow', reason: 'unsupported editable kind gradient',
        flattenedFallback: {
          accepted: true, nonEditableLayerIds: ['glow'], nonEditableTextIds: [],
          lostSeparations: ['gradient-varnish'], vectorAlternative: 'Provide stepped vector contours.',
        },
      },
    } satisfies Partial<BlueprintCompilerError>))
  })

  it('keeps out-of-artboard physical bounds exact while bounding legacy proxies', () => {
    const blueprint = laviraBlueprint()
    const layer = blueprint.areas[0].layers[0]
    layer.boundsMm = { x: -2, y: -3, width: 46, height: 74 }

    const areas = compileBlueprintToSpecAreas(blueprint)

    expect(areas[0].layers[0]).toMatchObject({
      x: 0.5, y: 0,
      designMetrics: { boundsMm: { x: -2, y: -3, width: 46, height: 74 } },
    })
    expect(validateLabelSpec({ version: 2, areas }).ok).toBe(true)
  })

  it('keeps physical typography exact while bounding legacy pixel proxies', () => {
    const blueprint = laviraBlueprint()
    const layer = blueprint.areas[0].layers[0]
    layer.fontSizeMm = 1000
    layer.fontWeight = 50
    layer.letterSpacingEm = 100
    layer.lineHeight = 100

    const areas = compileBlueprintToSpecAreas(blueprint)

    expect(areas[0].layers[0]).toMatchObject({
      fontSize: 2048, fontWeight: 50, letterSpacing: 100, lineHeight: 5,
      designMetrics: { fontSizeMm: 1000, letterSpacingEm: 100, lineHeight: 100 },
    })
    expect(validateLabelSpec({ version: 2, areas }).ok).toBe(true)
  })

  it.each([50, 'normal', 'bold'] as const)('round-trips authoritative fontWeight %s through apply and Project v3', (fontWeight) => {
    const blueprint = laviraBlueprint()
    blueprint.areas[0].layers = [blueprint.areas[0].layers[0]]
    blueprint.areas[0].layers[0].fontWeight = fontWeight

    const specAreas = compileBlueprintToSpecAreas(blueprint)
    const applied = applyStructuredLabelSpec(shell, { version: 2, areas: specAreas })
    const project = serializeLabelProject('bottle.glb', applied.areas)

    expect(specAreas[0].layers[0].fontWeight).toBe(fontWeight)
    expect(project.areas[0].layers[0]).toMatchObject({ kind: 'text', fontWeight })
  })

  it('round-trips rgba, named, and transparent colors without rewriting source strings', () => {
    const blueprint = laviraBlueprint()
    blueprint.areas[0].layers[0].color = 'rgba(125, 63, 42, 0.72)'
    const frame = blueprint.areas[0].layers.find((layer) => layer.id === 'copper-frame')!
    frame.fill = 'transparent'
    frame.stroke = 'copper'

    const specAreas = compileBlueprintToSpecAreas(blueprint)
    const project = serializeLabelProject('bottle.glb', applyStructuredLabelSpec(shell, { version: 2, areas: specAreas }).areas)

    expect(specAreas[0].layers[0].color).toBe('rgba(125, 63, 42, 0.72)')
    expect(project.areas[0].layers[0]).toMatchObject({ kind: 'text', color: 'rgba(125, 63, 42, 0.72)' })
    expect(project.areas[0].layers.find((layer) => layer.id === 'copper-frame')).toMatchObject({
      kind: 'shape', fill: 'transparent', stroke: 'copper',
    })
  })
})
