import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { inspectProject, patchLabelSpec, revisionOf } from '../scripts/lib/project-control.mjs'
import { parseLabelProject } from '../src/app/projectSchema'

const fixturePath = path.resolve(import.meta.dirname, 'fixtures/specs/perfume-front-back-v2.json')

async function fixture(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(fixturePath, 'utf8'))
}

function projectV3(): Record<string, any> {
  return {
    version: 3,
    modelFileName: 'bottle.glb',
    areas: [{
      id: 'a1', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
      remap: {
        mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
        planarBox: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
      range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
      canvas: { width: 2048, height: 1024, aspect: 2 },
      paper: { enabled: false, color: '#ffffff', opacity: 0 },
      layers: [{
        id: 'l1', kind: 'text', text: 'Label', fontFamily: 'system-sans', fontSize: 64,
        fontWeight: 400, letterSpacing: 0, lineHeight: 1.2, color: '#000000', align: 'center',
        italic: false, x: 512, y: 256, rotation: 0, opacity: 1, visible: true, locked: false,
        zIndex: 0, craft: [],
      }],
      globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
    }],
  }
}

describe('project control domain', () => {
  it('creates deterministic revisions with canonical object keys and ordered arrays', () => {
    expect(revisionOf({ b: 2, a: 1 })).toBe(revisionOf({ a: 1, b: 2 }))
    expect(revisionOf({ values: [1, 2] })).not.toBe(revisionOf({ values: [2, 1] }))
    expect(revisionOf({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('strictly inspects a Label Spec v2 and returns stable ids plus the full value', async () => {
    const spec = await fixture()
    const result = inspectProject(spec)

    expect(result).toMatchObject({
      kind: 'label-spec-v2',
      revision: revisionOf(spec),
      areaCount: 2,
      areas: [
        { id: 'front', name: '正标', layerCount: 2, layerIds: ['brand', 'rule'] },
        { id: 'back', name: '背标', layerCount: 1, layerIds: ['description'] },
      ],
      value: spec,
    })
  })

  it('inspects a Label Project v3 without treating it as a patchable spec', () => {
    const project = projectV3()

    expect(inspectProject(project)).toMatchObject({
      kind: 'label-project-v3',
      areaCount: 1,
      areas: [{ id: 'a1', name: 'Front', layerIds: ['l1'] }],
    })
  })

  it('rejects invalid specs and duplicate address ids', async () => {
    const spec = await fixture()
    const duplicate = structuredClone(spec)
    duplicate.areas[1].id = 'front'

    expect(() => inspectProject({ version: 2, areas: [] })).toThrowError(expect.objectContaining({ code: 'INVALID_LABEL_SPEC' }))
    expect(() => inspectProject(duplicate)).toThrowError(expect.objectContaining({ code: 'INVALID_LABEL_SPEC' }))
  })

  it.each([
    ['incomplete area and layer', { version: 3, modelFileName: 'x', areas: [{ id: 'a', name: 'A', layers: [{ id: 'l', kind: 'text' }] }] }],
    ['zero remap axis', (() => { const value = projectV3(); value.areas[0].remap.axis = [0, 0, 0]; return value })()],
    ['out-of-bounds range', (() => { const value = projectV3(); value.areas[0].range = { uStart: 0.8, uWidth: 0.4, vStart: 0, vHeight: 1 }; return value })()],
    ['malformed canvas', (() => { const value = projectV3(); value.areas[0].canvas.width = 0; return value })()],
    ['non-positive optional text width', (() => { const value = projectV3(); value.areas[0].layers[0].width = 0; return value })()],
    ['malformed fonts', (() => { const value = projectV3(); value.areas[0].fonts = [{ name: '', dataUrl: 42 }]; return value })()],
    ['malformed craft', (() => { const value = projectV3(); value.areas[0].globalCraft = { craft: [{ type: 'laser', params: {} }] }; return value })()],
  ])('rejects a structurally unusable Label Project v3: %s', (_label, value) => {
    expect(() => parseLabelProject(value)).toThrow()
    expect(() => inspectProject(value)).toThrowError(expect.objectContaining({ code: 'INVALID_LABEL_SPEC' }))
  })

  it('applies all supported area and layer operations in one transaction', async () => {
    const spec = await fixture()
    const original = structuredClone(spec)
    const result = patchLabelSpec(spec, {
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [
        { op: 'update-area', areaId: 'front', changes: { name: 'Front label' } },
        {
          op: 'add-layer',
          areaId: 'front',
          index: 1,
          layer: { id: 'subtitle', type: 'text', text: 'N° 01', x: 0.5, y: 0.52 },
        },
        { op: 'update-layer', areaId: 'front', layerId: 'brand', changes: { text: 'REALIBOX LAB' } },
        { op: 'move-layer', areaId: 'front', layerId: 'subtitle', index: 0 },
        { op: 'remove-layer', areaId: 'front', layerId: 'rule' },
        {
          op: 'add-area',
          index: 2,
          area: {
            id: 'neck', name: '颈标', target: { meshIndex: 0 }, surfaceMode: 'overlay',
            range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, layers: [],
          },
        },
        { op: 'update-area', areaId: 'neck', changes: { side: 'front' } },
        { op: 'remove-area', areaId: 'back' },
      ],
    })

    expect(result.previousRevision).toBe(revisionOf(spec))
    expect(result.revision).not.toBe(result.previousRevision)
    expect(result.appliedOperationCount).toBe(8)
    expect(result.value.areas.map((area: any) => area.id)).toEqual(['front', 'neck'])
    expect(result.value.areas[0].name).toBe('Front label')
    expect(result.value.areas[0].layers.map((layer: any) => layer.id)).toEqual(['subtitle', 'brand'])
    expect(result.value.areas[0].layers[1].text).toBe('REALIBOX LAB')
    expect(spec).toEqual(original)
  })

  it('returns a revision conflict before applying operations', async () => {
    const spec = await fixture()

    expect(() => patchLabelSpec(spec, {
      version: 1,
      baseRevision: `sha256:${'0'.repeat(64)}`,
      operations: [],
    })).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  })

  it.each([
    ['missing area', { op: 'remove-area', areaId: 'missing' }],
    ['duplicate area', { op: 'add-area', area: { id: 'front', name: 'Duplicate', target: { meshIndex: 0 }, surfaceMode: 'overlay', range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, layers: [] } }],
    ['missing layer', { op: 'remove-layer', areaId: 'front', layerId: 'missing' }],
    ['duplicate layer', { op: 'add-layer', areaId: 'front', layer: { id: 'brand', type: 'text', text: 'x', x: 0.5, y: 0.5 } }],
    ['immutable area id', { op: 'update-area', areaId: 'front', changes: { id: 'renamed' } }],
    ['immutable layer type', { op: 'update-layer', areaId: 'front', layerId: 'brand', changes: { type: 'shape' } }],
    ['invalid move index', { op: 'move-layer', areaId: 'front', layerId: 'brand', index: 99 }],
  ])('rejects an invalid operation: %s', async (_label, operation) => {
    const spec = await fixture()
    expect(() => patchLabelSpec(spec, {
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [operation],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PATCH_OPERATION' }))
  })

  it('rolls back earlier operations when a later operation fails', async () => {
    const spec = await fixture()
    const original = structuredClone(spec)

    expect(() => patchLabelSpec(spec, {
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [
        { op: 'update-layer', areaId: 'front', layerId: 'brand', changes: { text: 'NEW' } },
        { op: 'remove-layer', areaId: 'missing', layerId: 'x' },
      ],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PATCH_OPERATION' }))
    expect(spec).toEqual(original)
  })

  it('rejects a transaction whose final Label Spec is invalid', async () => {
    const spec = await fixture()

    expect(() => patchLabelSpec(spec, {
      version: 1,
      baseRevision: revisionOf(spec),
      operations: [
        { op: 'remove-area', areaId: 'front' },
        { op: 'remove-area', areaId: 'back' },
      ],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PATCH_OPERATION' }))
  })
})
