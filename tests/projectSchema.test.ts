import { afterEach, describe, expect, it, vi } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { Document, NodeIO } from '@gltf-transform/core'
import labelProjectV3Schema from '../src/agent/label-project-v3.schema.json'
import { importProject } from '../src/app/actions'
import { parseLabelProject, serializeLabelProject } from '../src/app/projectSchema'
import { resolveCarrierSurface } from '../src/label/paper'
import type { LabelAreaConfig, ShapeKind } from '../src/label/types'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'

function makeArea(): LabelAreaConfig {
  return {
    id: 'area-1',
    name: 'Front',
    meshIndex: 0,
    nodeName: 'Bottle',
    surfaceMode: 'overlay',
    remap: {
      mode: 'cylindrical',
      axis: [0, 1, 0],
      origin: [0, 0, 0],
      radius: 1,
      wrap: 1,
      offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 2048, height: 1024, aspect: 2 },
    layers: [
      {
        id: 's1', kind: 'shape', shape: 'rectangle', width: 300, height: 80,
        fill: '#000000', stroke: '#000000', strokeWidth: 0, cornerRadius: 0,
        x: 100, y: 100, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
      },
    ],
    globalCraft: { craft: [] },
    fonts: [],
    referenceVisible: false,
    referenceUrl: 'blob:runtime-only',
    undoStack: [],
    redoStack: [],
  }
}

function makeTextLayer(): Record<string, unknown> {
  return {
    id: 't1', kind: 'text', text: 'Aesop', fontFamily: 'Arial', fontSize: 80, fontWeight: 400,
    letterSpacing: 0, lineHeight: 1.2, color: '#000000', align: 'left', italic: false,
    x: 100, y: 100, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [],
  }
}

function makeImageLayer(): Record<string, unknown> {
  return {
    id: 'i1', kind: 'image', src: 'data:image/png;base64,AA==', naturalWidth: 8, naturalHeight: 8,
    width: 80, height: 80, x: 100, y: 100, rotation: 0, opacity: 1,
    visible: true, locked: false, zIndex: 2, craft: [],
  }
}

function projectWithLayers(layers: unknown[]): Record<string, unknown> {
  return {
    version: 3,
    modelFileName: 'bottle.glb',
    areas: [{ ...makeArea(), layers }],
  }
}

function physicalProjectFixture(): Record<string, unknown> {
  return {
    version: 3,
    modelFileName: 'bottle.glb',
    areas: [{
      ...makeArea(),
      carrier: 'applied_label',
      artboard: { widthMm: 42, heightMm: 68, background: 'transparent' },
      substrate: {
        kind: 'transparent', color: '#ffffff', opacity: 0.2,
        boundary: { shape: 'rounded_rectangle', radiusMm: 2 }, material: 'PET', adhesive: 'acrylic',
      },
      placementPolicy: 'fit',
      blueprintAreaId: 'front-blueprint',
      designBinding: {
        blueprintRevision: 'lavira-v1',
        blueprintSha256: '1'.repeat(64),
        reviewManifestSha256: '2'.repeat(64),
      },
      layers: [
        {
          ...makeTextLayer(),
          designMetrics: {
            boundsMm: { x: 4, y: 6, width: 34, height: 10 },
            anchor: 'center', fontSizeMm: 4.2, letterSpacingEm: 0.08,
            lineHeight: 1.1, wrapPolicy: 'none', maxLines: 1,
          },
          processes: [{ process: 'screen_print', spotName: 'BRAND_BLACK', requiredMask: 'color' }],
        },
        {
          ...makeArea().layers[0], shape: 'path',
          pathData: 'M 0 1 L 0 0 L 1 0 L 1 1', pathViewBox: [0, 0, 1, 1], fillRule: 'evenodd',
          designMetrics: {
            normalizedBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, anchor: 'center',
            strokeWidthMm: 0.25, cornerRadiusMm: 1.5,
          },
          processes: [{ process: 'hot_stamp_foil', requiredMask: 'metalness' }],
        },
      ],
    }],
  }
}

afterEach(() => {
  useLabelStore.getState().clearAll()
  useModelStore.setState(useModelStore.getInitialState(), true)
  useUiStore.setState(useUiStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

describe('label project v3', () => {
  it('round-trips physical metrics without changing bake dimensions', () => {
    const project = parseLabelProject(physicalProjectFixture())
    const serialized = serializeLabelProject('bottle.glb', project.areas)

    expect(serialized.areas[0].canvas).toEqual({ width: 2048, height: 1024, aspect: 2 })
    expect(serialized.areas[0].artboard).toEqual({ widthMm: 42, heightMm: 68, background: 'transparent' })
    expect(serialized.areas[0].layers[0].designMetrics).toEqual({
      boundsMm: { x: 4, y: 6, width: 34, height: 10 },
      anchor: 'center', fontSizeMm: 4.2, letterSpacingEm: 0.08,
      lineHeight: 1.1, wrapPolicy: 'none', maxLines: 1,
    })
    expect(serialized.areas[0]).toMatchObject({
      carrier: 'applied_label', placementPolicy: 'fit', blueprintAreaId: 'front-blueprint',
      substrate: { kind: 'transparent', opacity: 0.2, material: 'PET', adhesive: 'acrylic' },
      designBinding: { blueprintRevision: 'lavira-v1' },
    })
    expect(serialized.areas[0].layers[0].processes).toEqual([
      { process: 'screen_print', spotName: 'BRAND_BLACK', requiredMask: 'color' },
    ])
    expect(serialized.areas[0].layers[1]).toMatchObject({
      kind: 'shape', shape: 'path', pathData: 'M 0 1 L 0 0 L 1 0 L 1 1', pathViewBox: [0, 0, 1, 1], fillRule: 'evenodd',
      designMetrics: { strokeWidthMm: 0.25, cornerRadiusMm: 1.5 },
      processes: [{ process: 'hot_stamp_foil', requiredMask: 'metalness' }],
    })
  })

  it('rejects normalized design bounds outside the normalized 0..1 domain', () => {
    const project = physicalProjectFixture()
    const layers = (project.areas as Array<Record<string, unknown>>)[0].layers as Array<Record<string, unknown>>
    layers[1].designMetrics = {
      normalizedBounds: { x: 0.1, y: 0.1, width: 1.2, height: 0.8 },
      anchor: 'center',
    }

    expect(() => parseLabelProject(project)).toThrow(/designMetrics\.normalizedBounds/)
    expect(new Ajv2020({ allErrors: true, strict: true }).compile(labelProjectV3Schema)(project)).toBe(false)
  })

  it('normalizes an old enabled paper area to applied_label without changing the paper appearance', () => {
    const paper = { enabled: true, color: '#ede7dc', opacity: 0.84 }
    const project = parseLabelProject({
      version: 2,
      modelFileName: 'legacy.glb',
      areas: [{ ...makeArea(), paper }],
    })

    expect(project.areas[0].carrier).toBe('applied_label')
    expect(project.areas[0].paper).toEqual(paper)
    expect(resolveCarrierSurface(project.areas[0])).toMatchObject({
      carrier: 'legacy', substrateVisible: true, substrateColor: paper.color, substrateOpacity: paper.opacity,
    })

    const reparsed = parseLabelProject(serializeLabelProject('legacy.glb', project.areas))
    expect(resolveCarrierSurface(reparsed.areas[0])).toMatchObject({ carrier: 'legacy', substrateVisible: true })
    const serialized = serializeLabelProject('legacy.glb', project.areas)
    expect(serialized.areas[0]).not.toHaveProperty('legacyPaperCarrier')
    expect(serialized.areas[0]).not.toHaveProperty('carrier')
  })

  it('retires legacy provenance after carrier and paper edits', () => {
    const project = parseLabelProject({
      version: 2,
      modelFileName: 'legacy.glb',
      areas: [{ ...makeArea(), paper: { enabled: true, color: '#ede7dc', opacity: 0.84 } }],
    })
    project.areas[0].carrier = 'direct_surface_print'
    project.areas[0].paper = { enabled: false, color: '#ede7dc', opacity: 0.84 }

    const serialized = serializeLabelProject('edited.glb', project.areas)
    expect(serialized.areas[0]).toMatchObject({
      carrier: 'direct_surface_print',
      paper: { enabled: false, color: '#ede7dc', opacity: 0.84 },
    })
    expect(serialized.areas[0]).not.toHaveProperty('legacyPaperCarrier')
    const reparsed = parseLabelProject(serialized)
    expect(reparsed.areas[0].carrier).toBe('direct_surface_print')
    expect(resolveCarrierSurface(reparsed.areas[0]).carrier).toBe('direct_surface_print')
  })

  it('retires legacy provenance after an explicit substrate edit', () => {
    const project = parseLabelProject({
      version: 2,
      modelFileName: 'legacy.glb',
      areas: [{ ...makeArea(), paper: { enabled: true, color: '#ede7dc', opacity: 0.84 } }],
    })
    project.areas[0].substrate = {
      kind: 'opaque', color: '#ffffff', opacity: 1, boundary: { shape: 'rectangle' },
    }

    const serialized = serializeLabelProject('edited.glb', project.areas)
    expect(serialized.areas[0]).toMatchObject({ carrier: 'applied_label', substrate: project.areas[0].substrate })
    expect(serialized.areas[0]).not.toHaveProperty('legacyPaperCarrier')
    const reparsed = parseLabelProject(serialized)
    expect(resolveCarrierSurface(reparsed.areas[0])).toMatchObject({ carrier: 'applied_label', substrateVisible: true })
  })

  it('retires legacy provenance after changing the migrated paper appearance', () => {
    const project = parseLabelProject({
      version: 2,
      modelFileName: 'legacy.glb',
      areas: [{ ...makeArea(), paper: { enabled: true, color: '#ede7dc', opacity: 0.84 } }],
    })
    project.areas[0].paper = { enabled: true, color: '#123456', opacity: 0.5 }

    const serialized = serializeLabelProject('edited.glb', project.areas)
    expect(serialized.areas[0]).toMatchObject({ carrier: 'applied_label', paper: project.areas[0].paper })
    expect(serialized.areas[0]).not.toHaveProperty('legacyPaperCarrier')
  })

  it('does not treat an explicit carrier-aware applied label as legacy paper fallback', () => {
    const project = parseLabelProject({
      version: 3,
      modelFileName: 'canonical.glb',
      areas: [{
        ...makeArea(), carrier: 'applied_label',
        paper: { enabled: true, color: '#ede7dc', opacity: 0.84 },
      }],
    })

    expect(resolveCarrierSurface(project.areas[0])).toMatchObject({
      carrier: 'applied_label', substrateVisible: false,
    })
  })

  it('keeps a newly-authored direct print substrate-free', () => {
    const project = parseLabelProject({
      ...physicalProjectFixture(),
      areas: [{ ...makeArea(), carrier: 'direct_surface_print' }],
    })

    expect(project.areas[0].carrier).toBe('direct_surface_print')
    expect(project.areas[0].substrate).toBeUndefined()
  })

  it.each(['direct_surface_print', 'in_mold', 'foil_or_ink_only', 'bare'])('rejects substrate for %s', (carrier) => {
    const invalid = {
      ...physicalProjectFixture(),
      areas: [{
        ...makeArea(), carrier,
        substrate: { kind: 'opaque', opacity: 1, boundary: { shape: 'rectangle' } },
      }],
    }

    expect(() => parseLabelProject(invalid)).toThrow(/substrate/)
    expect(new Ajv2020({ allErrors: true, strict: true }).compile(labelProjectV3Schema)(invalid)).toBe(false)
  })

  it('migrates a v2 rectangle and legacy font name', () => {
    const project = parseLabelProject({
      version: 2,
      modelFileName: 'bottle.glb',
      areas: [{
        ...makeArea(),
        paper: undefined,
        layers: [
          makeTextLayer(),
          makeArea().layers[0],
        ],
      }],
    })

    expect(project.version).toBe(3)
    expect(project.areas[0].paper).toEqual({ enabled: false, color: '#f2efe4', opacity: 1 })
    expect(project.areas[0].layers[0]).toMatchObject({ kind: 'text', fontFamily: 'arial' })
    expect(project.areas[0].layers[1]).toMatchObject({ kind: 'shape', shape: 'rectangle', geometry: {} })
  })

  it('migrates a v1 single-area file into a v3 project', () => {
    const project = parseLabelProject({ ...makeArea(), version: 1, modelFileName: 'legacy.glb' })

    expect(project).toMatchObject({ version: 3, modelFileName: 'legacy.glb' })
    expect(project.areas).toHaveLength(1)
    expect(project.areas[0].id).toBe('area-1')
  })

  it('accepts complete text, image, and rectangle records from a v3 project', () => {
    const project = parseLabelProject(projectWithLayers([{ ...makeTextLayer(), width: 420 }, makeImageLayer(), makeArea().layers[0]]))

    expect(project.areas[0].layers.map((layer) => layer.kind)).toEqual(['text', 'image', 'shape'])
    expect(project.areas[0].layers[0]).toMatchObject({ kind: 'text', width: 420 })
  })

  it.each<ShapeKind>([
    'rectangle', 'ellipse', 'triangle', 'diamond', 'polygon', 'star', 'line',
    'wave', 'burst', 'cross', 'bracket', 'dot-grid', 'frame',
  ])('accepts the supported %s shape kind and preserves its serializable geometry', (shape) => {
    const geometry = shape === 'line' ? { parallel: true, gap: 8 } : { inset: 6 }
    const input = { ...makeArea().layers[0], shape, geometry }

    expect(parseLabelProject(projectWithLayers([input])).areas[0].layers[0]).toMatchObject({
      kind: 'shape', shape, geometry,
    })
  })

  it.each([
    ['an unknown layer kind', { ...makeTextLayer(), kind: 'video' }],
    ['a text layer without craft', (() => { const layer = makeTextLayer(); delete layer.craft; return layer })()],
    ['a non-finite layer coordinate', { ...makeTextLayer(), x: Number.POSITIVE_INFINITY }],
    ['an invalid layer boolean', { ...makeTextLayer(), visible: 'yes' }],
    ['an invalid text alignment', { ...makeTextLayer(), align: 'justify' }],
    ['a non-positive text box width', { ...makeTextLayer(), width: 0 }],
    ['an image without a source', (() => { const layer = makeImageLayer(); delete layer.src; return layer })()],
    ['an arbitrary shape value', { ...makeArea().layers[0], shape: 'not-a-shape' }],
  ])('rejects %s', (_label, layer) => {
    expect(() => parseLabelProject(projectWithLayers([layer]))).toThrow()
  })

  it.each([
    ['a non-finite numeric geometry field', { points: Number.NaN }],
    ['a non-boolean geometry flag', { parallel: 'yes' }],
    ['a malformed dash array', { dash: [8, Number.POSITIVE_INFINITY] }],
    ['an unknown geometry field', { curvature: 0.5 }],
  ])('rejects %s', (_label, geometry) => {
    expect(() => parseLabelProject(projectWithLayers([{ ...makeArea().layers[0], shape: 'star', geometry }]))).toThrow()
  })

  it('migrates only a missing legacy shape property and rejects explicit null or undefined', () => {
    const legacyRectangle = { ...makeArea().layers[0] }
    delete (legacyRectangle as { shape?: unknown }).shape

    expect(parseLabelProject(projectWithLayers([legacyRectangle])).areas[0].layers[0]).toMatchObject({
      kind: 'shape', shape: 'rectangle', geometry: {},
    })
    expect(() => parseLabelProject(projectWithLayers([{ ...makeArea().layers[0], shape: null }]))).toThrow()
    expect(() => parseLabelProject(projectWithLayers([{ ...makeArea().layers[0], shape: undefined }]))).toThrow()
  })

  it('rejects nested prototype-pollution fields', () => {
    const unsafe = JSON.parse('{"version":3,"modelFileName":"bottle.glb","areas":[{"id":"a1","remap":{"__proto__":{"polluted":true}}}]}')

    expect(() => parseLabelProject(unsafe)).toThrow('非法字段')
  })

  it('does not serialize undo history or runtime reference URLs', () => {
    const output = serializeLabelProject('bottle.glb', [makeArea()])
    const json = JSON.stringify(output)

    expect(json).not.toContain('undoStack')
    expect(json).not.toContain('redoStack')
    expect(json).not.toContain('referenceUrl')
    expect(output.areas[0].layers[0]).toMatchObject({ kind: 'shape', geometry: {} })
  })

  it('rejects an empty project before import can clear the existing label store', async () => {
    class EmptyProjectReader {
      result = JSON.stringify({ version: 3, modelFileName: 'empty.glb', areas: [] })
      onload: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      readAsText(): void {
        queueMicrotask(() => this.onload?.(new Event('load')))
      }
    }

    useLabelStore.getState().addArea(makeArea())
    vi.stubGlobal('FileReader', EmptyProjectReader)

    await expect(importProject({} as File)).rejects.toThrow('项目至少需要一个区域')
    expect(useLabelStore.getState().areas.map((area) => area.id)).toEqual(['area-1'])
  })

  it('restores a matching project from pure 3D into split view so its design can bake immediately', async () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer)
    const primitive = doc.createPrimitive().setAttribute('POSITION', position)
    const mesh = doc.createMesh('Bottle').addPrimitive(primitive)
    doc.createScene().addChild(doc.createNode('Bottle').setMesh(mesh))
    const glbBytes = await new NodeIO().writeBinary(doc)
    const project = serializeLabelProject('perfume.glb', [makeArea()])
    class MatchingProjectReader {
      result = JSON.stringify(project)
      onload: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      readAsText(): void { queueMicrotask(() => this.onload?.(new Event('load'))) }
    }
    vi.stubGlobal('FileReader', MatchingProjectReader)
    useModelStore.setState({ ...useModelStore.getInitialState(), modelName: 'perfume.glb', glbBytes, status: 'ready' }, true)
    useUiStore.setState({ ...useUiStore.getInitialState(), editorViewMode: '3d' }, true)

    await importProject({} as File)

    expect(useUiStore.getState().editorViewMode).toBe('split')
    expect(useLabelStore.getState().areas).toHaveLength(1)
    expect(useLabelStore.getState().remapOutput).not.toBeNull()
  })

  it('rejects a project for another model before replacing the current design', async () => {
    const project = serializeLabelProject('other.glb', [{ ...makeArea(), id: 'imported' }])
    class MismatchedProjectReader {
      result = JSON.stringify(project)
      onload: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      readAsText(): void { queueMicrotask(() => this.onload?.(new Event('load'))) }
    }
    vi.stubGlobal('FileReader', MismatchedProjectReader)
    useModelStore.setState({ ...useModelStore.getInitialState(), modelName: 'perfume.glb', glbBytes: new Uint8Array([1]), status: 'ready' }, true)
    useLabelStore.getState().addArea({ ...makeArea(), id: 'existing' })

    await expect(importProject({} as File)).rejects.toThrow('项目基于 other.glb，当前模型是 perfume.glb')
    expect(useLabelStore.getState().areas.map((candidate) => candidate.id)).toEqual(['existing'])
  })

  it.each([
    [
      'canvas.aspect string',
      (valid: LabelAreaConfig) => ({ ...valid, canvas: { ...valid.canvas, aspect: '2' } }),
      'canvas.aspect',
    ],
    [
      'out-of-range area range',
      (valid: LabelAreaConfig) => ({ ...valid, range: { ...valid.range, uStart: -0.1 } }),
      'range.uStart',
    ],
    [
      'malformed remap axis',
      (valid: LabelAreaConfig) => ({ ...valid, remap: { ...valid.remap, axis: [0, 1] } }),
      'remap.axis',
    ],
    [
      'malformed global craft list',
      (valid: LabelAreaConfig) => ({ ...valid, globalCraft: { craft: 'foil' } }),
      'globalCraft.craft',
    ],
    [
      'malformed uploaded font record',
      (valid: LabelAreaConfig) => ({ ...valid, fonts: [{ name: 42, dataUrl: 'data:font/woff2;base64,AA==' }] }),
      'fonts[0].name',
    ],
  ])('rejects %s at the actual import boundary without replacing the current project', async (_label, mutate, expectedField) => {
    const malformedProject = {
      version: 3,
      modelFileName: 'malformed.glb',
      areas: [mutate({ ...makeArea(), id: 'malformed-area' })],
    }
    class MalformedProjectReader {
      result = JSON.stringify(malformedProject)
      onload: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      readAsText(): void {
        queueMicrotask(() => this.onload?.(new Event('load')))
      }
    }

    useLabelStore.getState().addArea({ ...makeArea(), id: 'existing-area' })
    const beforeAreas = useLabelStore.getState().areas
    const beforeActiveArea = useLabelStore.getState().activeArea
    vi.stubGlobal('FileReader', MalformedProjectReader)

    await expect(importProject({} as File)).rejects.toThrow(expectedField)
    expect(useLabelStore.getState().areas).toBe(beforeAreas)
    expect(useLabelStore.getState().activeArea).toBe(beforeActiveArea)
    expect(useLabelStore.getState().areas.map((area) => area.id)).toEqual(['existing-area'])
  })
})
