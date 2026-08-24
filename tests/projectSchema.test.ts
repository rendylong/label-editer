import { afterEach, describe, expect, it, vi } from 'vitest'
import { Document, NodeIO } from '@gltf-transform/core'
import { importProject } from '../src/app/actions'
import { parseLabelProject, serializeLabelProject } from '../src/app/projectSchema'
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

afterEach(() => {
  useLabelStore.getState().clearAll()
  useModelStore.setState(useModelStore.getInitialState(), true)
  useUiStore.setState(useUiStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

describe('label project v3', () => {
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
