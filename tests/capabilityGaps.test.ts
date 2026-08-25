import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Document } from '@gltf-transform/core'
import { describe, expect, it } from 'vitest'
import { applyLabelJobToDocument } from '../src/glb/rebuildCore'
import { parseLabelProject } from '../src/app/projectSchema'
import { TextInspector } from '../src/ui/inspectors/TextInspector'
import type { LabelAreaConfig, TextLayer } from '../src/label/types'

function textLayer(): TextLayer {
  return {
    id: 'text-a', kind: 'text', text: 'لافا', fontFamily: 'system-sans', fontSize: 40,
    fontWeight: 400, letterSpacing: 0, lineHeight: 1.2, width: 180, color: '#111111', align: 'right',
    italic: false, direction: 'horizontal', x: 200, y: 150, rotation: 0, opacity: 1,
    visible: true, locked: false, zIndex: 0, craft: [],
  }
}

function area(): LabelAreaConfig {
  return {
    id: 'area-a', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
    remap: { mode: 'cylindrical', axis: [0, 0, 1], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0.75, planarBox: { min: [-1, 0, 0], max: [1, 0, 0] } },
    range: { uStart: 0.4, uWidth: 0.2, vStart: 0.2, vHeight: 0.6 },
    canvas: { width: 400, height: 300, aspect: 4 / 3 }, paper: { enabled: true, color: '#111111', opacity: 1 },
    layers: [textLayer()], globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
    undoStack: [], redoStack: [],
  }
}

function documentWithBottle(): Document {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const primitive = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer))
    .setMaterial(doc.createMaterial('Bottle'))
  doc.createScene().addChild(doc.createNode('Bottle').setMesh(doc.createMesh('Bottle').addPrimitive(primitive)))
  return doc
}

const emptyPng = new ArrayBuffer(0)
const remap = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uv: new Float32Array([0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
}

describe('capability gap regression contracts', () => {
  it('exports two same-mesh overlay areas with unique editable identities', () => {
    const doc = documentWithBottle()
    applyLabelJobToDocument(doc, { areaId: 'front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', fullRange: false, remap, colorPng: emptyPng } as never)
    applyLabelJobToDocument(doc, { areaId: 'back', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', fullRange: false, remap, colorPng: emptyPng } as never)

    const overlayNames = doc.getRoot().listNodes().map((node) => node.getName()).filter((name) => name.includes('__label_overlay'))
    expect(overlayNames).toEqual(['Bottle__label_overlay__front', 'Bottle__label_overlay__back'])
  })

  it('exposes a real channel selector for independent PNG output', async () => {
    const actions = await import('../src/app/actions') as typeof import('../src/app/actions') & {
      selectBakeChannel?: (bake: { color: object; metalness: object; roughness: object; bump: object }, channel: string | null) => object
    }
    const bake = { color: {}, metalness: {}, roughness: {}, bump: {} }
    expect(actions.selectBakeChannel).toBeTypeOf('function')
    expect(actions.selectBakeChannel?.(bake, 'metalness')).toBe(bake.metalness)
    expect(actions.selectBakeChannel?.(bake, 'roughness')).toBe(bake.roughness)
    expect(actions.selectBakeChannel?.(bake, 'bump')).toBe(bake.bump)
    expect(actions.selectBakeChannel?.(bake, null)).toBe(bake.color)
  })

  it('renders numeric text-box width and RTL writing controls', () => {
    const html = renderToStaticMarkup(createElement(TextInspector, {
      area: area(), layer: textLayer(), patch: () => undefined, commitUploadedFont: () => undefined,
    }))
    expect(html).toContain('>文本框宽度<')
    expect(html).toContain('>书写方向<')
    expect(html).toContain('value="rtl"')
  })

  it('preserves print production settings and a custom foil spot color in project data', () => {
    const source = area()
    const raw = {
      version: 3,
      modelFileName: 'bottle.glb',
      areas: [{
        ...source,
        printSpec: { physicalWidthMm: 42, physicalHeightMm: 60, bleedMm: 2, cornerRadiusMm: 1.5, minTextHeightMm: 1.2, dieCutShape: 'rounded-rectangle', spotColors: ['FOIL_COPPER_RED'] },
        layers: [{ ...source.layers[0], craft: [{ type: 'foil', params: { foilColor: 'custom', foilCustomColor: '#b56f52', foilSpotName: 'FOIL_COPPER_RED' } }] }],
      }],
    }

    const parsed = parseLabelProject(raw)

    expect(parsed.areas[0].printSpec).toEqual(raw.areas[0].printSpec)
    expect(parsed.areas[0].layers[0].craft[0].params).toMatchObject({ foilColor: 'custom', foilCustomColor: '#b56f52', foilSpotName: 'FOIL_COPPER_RED' })
  })

  it('provides structured Label Spec mapping and GLB editable metadata helpers', async () => {
    const labelSpec = await import('../src/app/labelSpec')
    const rebuild = await import('../src/glb/rebuildCore')
    expect(labelSpec.applyStructuredLabelSpec).toBeTypeOf('function')
    expect(labelSpec.targetAreaIdsForSpecReplacement).toBeTypeOf('function')
    expect(rebuild.embedEditableProjectMetadata).toBeTypeOf('function')
    expect(rebuild.readEditableProjectMetadata).toBeTypeOf('function')

    const mapped = labelSpec.applyStructuredLabelSpec(area(), {
      version: 1,
      areas: [
        { name: 'Front', side: 'front', layers: [{ type: 'text', text: 'LAVA', x: 0.5, y: 0.4, width: 0.7 }] },
        { name: 'Back', side: 'back', layers: [{ type: 'text', text: 'من قلب الصحراء', language: 'ar', x: 0.5, y: 0.5, width: 0.8 }] },
      ],
    }, 'test')
    expect(mapped.areas).toHaveLength(2)
    expect(mapped.areas[1].meshIndex).toBe(mapped.areas[0].meshIndex)
    expect(mapped.areas[1].remap.offset).toBeCloseTo((mapped.areas[0].remap.offset + 0.5) % 1)
    expect(mapped.areas.map((mappedArea) => mappedArea.side)).toEqual(['front', 'back'])
    expect(mapped.areas[1].layers[0]).toMatchObject({ kind: 'text', fontFamily: 'noto-sans-arabic', writingDirection: 'rtl', language: 'ar' })
    const remappedFromBack = labelSpec.applyStructuredLabelSpec({ ...area(), side: 'back', remap: { ...area().remap, offset: 0.25 } }, {
      version: 1,
      areas: [{ side: 'front', layers: [] }, { side: 'back', layers: [] }],
    })
    expect(remappedFromBack.areas.map((mappedArea) => mappedArea.remap.offset)).toEqual([0.75, 0.25])
    const remappedFromLegacyBack = labelSpec.applyStructuredLabelSpec({ ...area(), name: 'Legacy Back Label', remap: { ...area().remap, offset: 0.25 } }, {
      version: 1,
      areas: [{ side: 'front', layers: [] }, { side: 'back', layers: [] }],
    })
    expect(remappedFromLegacyBack.areas.map((mappedArea) => mappedArea.remap.offset)).toEqual([0.75, 0.25])
    expect(labelSpec.targetAreaIdsForSpecReplacement([area(), { ...area(), id: 'area-back' }, { ...area(), id: 'cap', meshIndex: 2 }], area())).toEqual(['area-a', 'area-back'])

    const doc = documentWithBottle()
    const project = { version: 3, modelFileName: 'bottle.glb', areas: [] }
    rebuild.embedEditableProjectMetadata(doc, project)
    expect(rebuild.readEditableProjectMetadata(doc)).toEqual(project)
  })

  it('reports physical print violations and produces a separation manifest', async () => {
    const module = await import('../src/label/printReadiness').catch(() => ({})) as {
      validatePrintReadiness?: (area: LabelAreaConfig) => Array<{ code: string }>
      buildPrintManifest?: (area: LabelAreaConfig) => { dimensionsMm: unknown; separations: string[] }
    }
    expect(module.validatePrintReadiness).toBeTypeOf('function')
    expect(module.buildPrintManifest).toBeTypeOf('function')
    const source = area()
    source.printSpec = { physicalWidthMm: 42, physicalHeightMm: 60, bleedMm: 2, cornerRadiusMm: 1.5, minTextHeightMm: 8.5, dieCutShape: 'rounded-rectangle', spotColors: ['FOIL_COPPER_RED'] }
    source.layers[0].craft = [{ type: 'foil', params: { foilColor: 'custom', foilCustomColor: '#b56f52', foilSpotName: 'FOIL_COPPER_RED' } }]
    expect(module.validatePrintReadiness?.(source).map((issue) => issue.code)).toContain('text-below-minimum-height')
    expect(module.buildPrintManifest?.(source)).toMatchObject({
      dimensionsMm: { width: 42, height: 60, bleed: 2, cornerRadius: 1.5 },
      separations: ['color', 'metalness', 'roughness', 'bump', 'FOIL_COPPER_RED'],
    })
  })
})
