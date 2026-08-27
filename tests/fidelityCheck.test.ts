import { describe, expect, it } from 'vitest'
import { compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
import type { LayoutBlueprintV1 } from '../src/agent/designContracts'
import { compareBlueprintFidelity } from '../src/agent/fidelityCheck'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import type { LabelAreaConfig } from '../src/label/types'

const blueprint: LayoutBlueprintV1 = {
  version: 1, revision: 'fidelity-v1', carrierDefaults: { carrier: 'direct_surface_print' }, assets: [],
  areas: [{
    id: 'front', side: 'front', carrier: 'direct_surface_print',
    artboard: { widthMm: 40, heightMm: 60, background: 'transparent' },
    placementIntent: 'Front face', placementPolicy: 'fit',
    layers: [{
      id: 'title', kind: 'text', boundsMm: { x: 4, y: 6, width: 32, height: 8 }, anchor: 'top_center',
      rotation: 0, opacity: 1, visible: true, zIndex: 0, processes: [{ process: 'screen_print' }],
      text: 'EMBER', language: 'en', writingDirection: 'ltr', fontStack: ['Arial', 'sans-serif'],
      fontSizeMm: 4, fontWeight: 600, letterSpacingEm: 0.08, lineHeight: 1.1,
      alignment: 'center', wrapPolicy: 'none', maxLines: 1, color: '#7D3F2A',
    }, {
      id: 'frame', kind: 'shape', boundsMm: { x: 2, y: 2, width: 36, height: 56 }, anchor: 'top_left',
      rotation: 0, opacity: 0.8, visible: true, zIndex: 1,
      processes: [{ process: 'hot_stamp_foil', spotName: 'COPPER', requiredMask: 'metalness' }],
      shape: 'path', pathData: 'M0 56V0H36V56', pathViewBox: [0, 0, 36, 56], fillRule: 'nonzero',
      fill: 'transparent', stroke: '#A5663B', strokeWidthMm: 0.25, cornerRadiusMm: 1.5,
    }],
  }],
}

const shell: LabelAreaConfig = {
  id: 'area-front', name: 'Front shell', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', side: 'front',
  remap: { mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] } },
  range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
  canvas: { width: 1000, height: 500, aspect: 2 }, layers: [], globalCraft: { craft: [] },
  fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
}

function editableAreas(): LabelAreaConfig[] {
  const areas = compileBlueprintToSpecAreas(blueprint)
  return applyStructuredLabelSpec(shell, { version: 2, areas }).areas
}

function codes(mutator?: (areas: LabelAreaConfig[]) => void): string[] {
  const areas = editableAreas()
  mutator?.(areas)
  return compareBlueprintFidelity({ blueprint, editableAreas: areas }).issues.map((issue) => issue.code)
}

describe('blueprint structural fidelity', () => {
  it('passes a complete editable round-trip', () => {
    expect(compareBlueprintFidelity({ blueprint, editableAreas: editableAreas() })).toEqual({ pass: true, issues: [] })
  })

  it('reports I/i z-order drift against code-unit order even under a reversed ambient locale', () => {
    const source = structuredClone(blueprint)
    source.areas[0].layers[0].id = 'I'
    source.areas[0].layers[1].id = 'i'
    source.areas[0].layers.forEach((layer) => { layer.zIndex = 0 })
    const areas = applyStructuredLabelSpec(shell, { version: 2, areas: compileBlueprintToSpecAreas(source) }).areas
    areas[0].layers.find((layer) => layer.id === 'I')!.zIndex = 1
    areas[0].layers.find((layer) => layer.id === 'i')!.zIndex = 0
    const original = String.prototype.localeCompare
    let codes: string[] = []
    try {
      String.prototype.localeCompare = function (other: string): number {
        return String(this) < other ? 1 : String(this) > other ? -1 : 0
      }
      codes = compareBlueprintFidelity({ blueprint: source, editableAreas: areas }).issues.map((issue) => issue.code)
    } finally {
      String.prototype.localeCompare = original
    }

    expect(codes).toContain('LAYER_ORDER_MISMATCH')
  })

  it.each([
    ['exact copy', (areas: LabelAreaConfig[]) => { if (areas[0].layers[0].kind === 'text') areas[0].layers[0].text = 'ASH' }, 'TEXT_MISMATCH'],
    ['z-index', (areas: LabelAreaConfig[]) => { areas[0].layers[0].zIndex = 2 }, 'LAYER_ORDER_MISMATCH'],
    ['font size', (areas: LabelAreaConfig[]) => { if (areas[0].layers[0].designMetrics) areas[0].layers[0].designMetrics.fontSizeMm = 4.5 }, 'TYPOGRAPHY_MISMATCH'],
    ['font stack', (areas: LabelAreaConfig[]) => { if (areas[0].layers[0].kind === 'text') areas[0].layers[0].fontStack = ['Arial', 'serif'] }, 'TYPOGRAPHY_MISMATCH'],
    ['alpha', (areas: LabelAreaConfig[]) => { areas[0].layers[1].opacity = 0.4 }, 'COLOR_MISMATCH'],
    ['path data', (areas: LabelAreaConfig[]) => { if (areas[0].layers[1].kind === 'shape') areas[0].layers[1].pathData = 'M0 0H36' }, 'VECTOR_MISMATCH'],
    ['stroke width mm', (areas: LabelAreaConfig[]) => { if (areas[0].layers[1].designMetrics) areas[0].layers[1].designMetrics.strokeWidthMm = 0.5 }, 'VECTOR_MISMATCH'],
    ['corner radius mm', (areas: LabelAreaConfig[]) => { if (areas[0].layers[1].designMetrics) areas[0].layers[1].designMetrics.cornerRadiusMm = 2 }, 'VECTOR_MISMATCH'],
    ['process assignment', (areas: LabelAreaConfig[]) => { areas[0].layers[1].processes = [{ process: 'screen_print' }] }, 'PROCESS_MISMATCH'],
    ['artboard aspect', (areas: LabelAreaConfig[]) => { if (areas[0].artboard) areas[0].artboard.widthMm = 50 }, 'ARTBOARD_ASPECT_MISMATCH'],
  ] as const)('reports %s mutations against stable ids', (_name, mutate, expectedCode) => {
    const areas = editableAreas()
    mutate(areas)
    const report = compareBlueprintFidelity({ blueprint, editableAreas: areas })
    const issue = report.issues.find((item) => item.code === expectedCode)

    expect(report.pass).toBe(false)
    expect(issue).toMatchObject({ areaId: 'front' })
    if (expectedCode !== 'ARTBOARD_ASPECT_MISMATCH') expect(issue).toMatchObject({ layerId: expect.any(String) })
  })

  it('ignores redundant fontFamily aliases when the canonical approved stack is unchanged', () => {
    const areas = editableAreas()
    if (areas[0].layers[0].kind === 'text') areas[0].layers[0].fontFamily = 'Arial'

    expect(compareBlueprintFidelity({ blueprint, editableAreas: areas })).toEqual({ pass: true, issues: [] })
  })

  it('does not allow a perceptual warning to hide a structural failure', () => {
    const areas = editableAreas()
    if (areas[0].layers[0].kind === 'text') areas[0].layers[0].text = 'ASH'
    expect(compareBlueprintFidelity({
      blueprint, editableAreas: areas,
      perceptualComparison: { pass: true, warning: 'Images are visually close.' },
    }).pass).toBe(false)
  })

  it('keeps a perceptual mismatch warning-only when structure passes', () => {
    expect(compareBlueprintFidelity({
      blueprint, editableAreas: editableAreas(), perceptualComparison: { pass: false },
    })).toEqual({
      pass: true, issues: [], warnings: ['Perceptual image comparison reported a mismatch.'],
    })
  })

  it('reports a missing craft mask separately from retained process intent', () => {
    expect(codes((areas) => { areas[0].layers[1].craft = [] })).toContain('CRAFT_MASK_MISMATCH')
  })

  it('treats reordered object keys as equal while preserving array and value semantics', () => {
    const areas = editableAreas()
    areas[0].layers[1].processes = [{ requiredMask: 'metalness', spotName: 'COPPER', process: 'hot_stamp_foil' }]
    areas[0].layers[1].craft = [{
      params: { foilSpotName: 'COPPER', foilCustomColor: '#A5663B', foilColor: 'custom' }, type: 'foil',
    }]
    expect(compareBlueprintFidelity({ blueprint, editableAreas: areas })).toEqual({ pass: true, issues: [] })

    areas[0].layers[1].processes = [{ requiredMask: 'metalness', spotName: 'BRASS', process: 'hot_stamp_foil' }]
    expect(compareBlueprintFidelity({ blueprint, editableAreas: areas }).issues.map((item) => item.code)).toContain('PROCESS_MISMATCH')
    areas[0].layers[1].processes = structuredClone(blueprint.areas[0].layers[1].processes)
    if (areas[0].layers[1].craft[0]?.type === 'foil') areas[0].layers[1].craft[0].params.foilSpotName = 'BRASS'
    expect(compareBlueprintFidelity({ blueprint, editableAreas: areas }).issues.map((item) => item.code)).toContain('CRAFT_MASK_MISMATCH')
  })

  it('treats carrier, artboard color, and extra editable areas as structural changes', () => {
    expect(codes((areas) => { areas[0].carrier = 'foil_or_ink_only' })).toContain('PROCESS_MISMATCH')
    expect(codes((areas) => { if (areas[0].artboard) areas[0].artboard.background = '#FFFFFF' })).toContain('COLOR_MISMATCH')
    expect(codes((areas) => { areas.push({ ...structuredClone(areas[0]), id: 'unexpected', blueprintAreaId: 'unexpected' }) })).toContain('LAYER_SET_MISMATCH')
  })
})
