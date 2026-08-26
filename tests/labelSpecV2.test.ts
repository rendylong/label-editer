import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { labelSpecV2Schema, validateLabelSpec } from '../src/agent/labelSpecSchema'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import { serializeLabelProject } from '../src/app/projectSchema'
import type { LabelAreaConfig } from '../src/label/types'
import existingPerfumeFixture from './fixtures/specs/perfume-front-back-v2.json'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { patchLabelSpec, revisionOf } from '../scripts/lib/project-control.mjs'

const baseArea: LabelAreaConfig = {
  id: 'base', name: 'Base', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
  remap: { mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] } },
  range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
  canvas: { width: 1000, height: 500, aspect: 2 }, layers: [], globalCraft: { craft: [] },
  fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
}

describe('Label Spec v2', () => {
  it.each([
    ['malformed path syntax', 'M0 0 L', [0, 0, 1, 1], '/pathData'],
    ['unsupported path command', 'M0 0 R1 1', [0, 0, 1, 1], '/pathData'],
    ['zero-width viewBox', 'M0 0L1 1', [0, 0, 0, 1], '/pathViewBox'],
    ['negative-height viewBox', 'M0 0L1 1', [0, 0, 1, -1], '/pathViewBox'],
  ] as const)('rejects %s before structured apply', (_label, pathData, pathViewBox, expectedPath) => {
    const spec = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{
          id: 'vector', type: 'shape', shape: 'path', x: 0.5, y: 0.5, width: 0.8, height: 0.8,
          pathData, pathViewBox,
        }],
      }],
    }

    const validation = validateLabelSpec(spec)
    expect(validation.ok).toBe(false)
    expect(validation.issues).toContainEqual(expect.objectContaining({
      path: expect.stringContaining(expectedPath), keyword: 'invalid-vector-path',
    }))
    expect(() => applyStructuredLabelSpec(baseArea, spec)).toThrow(/Label Spec 校验失败/)
  })

  it('accepts and maps a valid bounded open Task 5 path', () => {
    const spec = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{
          id: 'vector', type: 'shape', shape: 'path', x: 0.5, y: 0.5, width: 0.8, height: 0.8,
          pathData: 'M0 0L1 1', pathViewBox: [0, 0, 1, 1],
        }],
      }],
    }

    expect(validateLabelSpec(spec).ok).toBe(true)
    expect(applyStructuredLabelSpec(baseArea, spec).areas[0].layers[0]).toMatchObject({
      kind: 'shape', shape: 'path', pathData: 'M0 0L1 1', pathViewBox: [0, 0, 1, 1],
    })
  })

  it('keeps the existing pixel-only Label Spec v2 fixture valid', () => {
    expect(validateLabelSpec(existingPerfumeFixture).ok).toBe(true)
  })

  it('accepts optional physical, process, vector, and design-binding metadata', () => {
    const physicalSpec = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay', side: 'front',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        carrier: 'direct_surface_print',
        artboard: { widthMm: 42, heightMm: 68, background: 'transparent' },
        placementPolicy: 'fit',
        blueprintAreaId: 'front-blueprint',
        designBinding: {
          blueprintRevision: 'lavira-v1',
          blueprintSha256: '1'.repeat(64),
          reviewManifestSha256: '2'.repeat(64),
        },
        layers: [{
          id: 'open-frame', type: 'shape', shape: 'path', x: 0.5, y: 0.5, width: 0.8, height: 0.8,
          pathData: 'M 0 1 L 0 0 L 1 0 L 1 1', pathViewBox: [0, 0, 1, 1], fillRule: 'evenodd',
          designMetrics: {
            normalizedBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
            anchor: 'center',
          },
          processes: [{ process: 'hot_stamp_foil', spotName: 'COPPER', requiredMask: 'metalness' }],
        }],
      }],
    }

    const result = validateLabelSpec(physicalSpec)
    const ajvResult = new Ajv2020({ allErrors: true, strict: true }).compile(labelSpecV2Schema)(physicalSpec)
    expect(result.ok).toBe(true)
    expect(result.ok).toBe(ajvResult)
    if (result.ok) expect(result.spec).toEqual(physicalSpec)

    const invalid = {
      ...physicalSpec,
      areas: [{
        ...physicalSpec.areas[0],
        layers: [{ ...physicalSpec.areas[0].layers[0], processes: [{ process: 'laser_print' }] }],
      }],
    }
    expect(validateLabelSpec(invalid).ok).toBe(false)
    expect(validateLabelSpec(invalid).ok).toBe(new Ajv2020({ allErrors: true, strict: true }).compile(labelSpecV2Schema)(invalid))
  })

  it('preserves physical metadata through structured apply and Project v3 serialization', () => {
    const physicalSpec = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay', side: 'front',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        carrier: 'applied_label',
        artboard: { widthMm: 42, heightMm: 68, background: '#f8f4ea' },
        substrate: {
          kind: 'opaque', color: '#f8f4ea', opacity: 0.92,
          boundary: { shape: 'rounded_rectangle', radiusMm: 2 }, material: 'paper', adhesive: 'acrylic',
        },
        placementPolicy: 'fit',
        blueprintAreaId: 'front-blueprint',
        designBinding: {
          blueprintRevision: 'lavira-v2', blueprintSha256: 'a'.repeat(64), reviewManifestSha256: 'b'.repeat(64),
          approvedCrop: { x: 1, y: 2, width: 40, height: 64 },
        },
        layers: [{
          id: 'open-frame', type: 'shape', shape: 'path', x: 0.5, y: 0.5, width: 0.8, height: 0.8,
          pathData: 'M 0 1 L 0 0 L 1 0 L 1 1', pathViewBox: [0, 0, 1, 1], fillRule: 'evenodd',
          designMetrics: {
            boundsMm: { x: 4, y: 6, width: 34, height: 56 }, anchor: 'center',
            strokeWidthMm: 0.3, cornerRadiusMm: 1.5,
          },
          processes: [{ process: 'hot_stamp_foil', spotName: 'COPPER', requiredMask: 'metalness' }],
        }],
      }],
    }

    const applied = applyStructuredLabelSpec(baseArea, physicalSpec)
    physicalSpec.areas[0].artboard.widthMm = 99
    physicalSpec.areas[0].substrate.boundary.radiusMm = 99
    physicalSpec.areas[0].layers[0].designMetrics.boundsMm.x = 99
    const project = serializeLabelProject('bottle.glb', applied.areas)

    expect(project.areas[0].canvas).toEqual({ width: 1000, height: 500, aspect: 2 })
    expect(project.areas[0]).toMatchObject({
      carrier: 'applied_label',
      artboard: { widthMm: 42, heightMm: 68, background: '#f8f4ea' },
      substrate: {
        kind: 'opaque', color: '#f8f4ea', opacity: 0.92,
        boundary: { shape: 'rounded_rectangle', radiusMm: 2 }, material: 'paper', adhesive: 'acrylic',
      },
      placementPolicy: 'fit', blueprintAreaId: 'front-blueprint',
      designBinding: {
        blueprintRevision: 'lavira-v2', blueprintSha256: 'a'.repeat(64), reviewManifestSha256: 'b'.repeat(64),
        approvedCrop: { x: 1, y: 2, width: 40, height: 64 },
      },
    })
    expect(project.areas[0].layers[0]).toMatchObject({
      kind: 'shape', shape: 'path', pathData: 'M 0 1 L 0 0 L 1 0 L 1 1', pathViewBox: [0, 0, 1, 1], fillRule: 'evenodd',
      designMetrics: { boundsMm: { x: 4, y: 6, width: 34, height: 56 }, anchor: 'center' },
      processes: [{ process: 'hot_stamp_foil', spotName: 'COPPER', requiredMask: 'metalness' }],
    })
  })

  it('accepts bounded authoritative CSS color strings and rejects empty or overlong colors', () => {
    const colors = ['rgba(125, 63, 42, 0.72)', 'copper', 'transparent']
    const spec = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{ id: 'text', type: 'text', text: 'LABEL', x: 0.5, y: 0.4, color: colors[0] }, {
          id: 'shape', type: 'shape', shape: 'rectangle', x: 0.5, y: 0.5, width: 0.5, height: 0.5,
          fill: colors[1], stroke: colors[2],
        }],
      }],
    }

    expect(validateLabelSpec(spec).ok).toBe(true)
    expect(new Ajv2020({ allErrors: true, strict: true }).compile(labelSpecV2Schema)(spec)).toBe(true)
    for (const color of ['', 'x'.repeat(65)]) {
      const invalid = structuredClone(spec)
      invalid.areas[0].layers[0].color = color
      expect(validateLabelSpec(invalid).ok).toBe(false)
    }
  })

  it.each(['auto', 'ltr'] as const)('preserves explicit Arabic writingDirection %s through apply and Project v3', (writingDirection) => {
    const spec = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{
          id: 'arabic', type: 'text', text: 'عطر', x: 0.5, y: 0.5,
          language: 'ar', writingDirection, fontWeight: 'normal', color: 'currentColor',
        }],
      }],
    }

    const project = serializeLabelProject('bottle.glb', applyStructuredLabelSpec(baseArea, spec).areas)

    expect(project.areas[0].layers[0]).toMatchObject({ kind: 'text', language: 'ar', writingDirection, fontWeight: 'normal' })
  })

  it.each([
    ['clear_label', 'direct_surface_print'],
    ['applied_label', 'in_mold'],
  ] as const)('clears inherited %s substrate when applying valid %s', (baseCarrier, carrier) => {
    const substrateBase: LabelAreaConfig = {
      ...baseArea,
      carrier: baseCarrier,
      substrate: {
        kind: baseCarrier === 'clear_label' ? 'transparent' : 'opaque',
        color: baseCarrier === 'clear_label' ? '#ffffff' : '#f8f4ea',
        opacity: 0.9,
        boundary: { shape: 'rounded_rectangle', radiusMm: 2 },
      },
    }
    const sourceSpec = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, carrier, layers: [],
      }],
    }

    expect(validateLabelSpec(sourceSpec).ok).toBe(true)
    const applied = applyStructuredLabelSpec(substrateBase, sourceSpec)
    const project = serializeLabelProject('bottle.glb', applied.areas)

    expect(project.areas[0].carrier).toBe(carrier)
    expect(project.areas[0].substrate).toBeUndefined()
  })

  it.each(['applied_label', 'clear_label'] as const)('keeps inherited substrate for %s', (carrier) => {
    const substrate = {
      kind: carrier === 'clear_label' ? 'transparent' as const : 'opaque' as const,
      color: '#f8f4ea', opacity: 0.9, boundary: { shape: 'rounded_rectangle' as const, radiusMm: 2 },
    }
    const substrateBase: LabelAreaConfig = { ...baseArea, carrier, substrate }
    const sourceSpec = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, carrier, layers: [],
      }],
    }

    const project = serializeLabelProject('bottle.glb', applyStructuredLabelSpec(substrateBase, sourceSpec).areas)

    expect(project.areas[0].substrate).toEqual(substrate)
  })

  it.each(['direct_surface_print', 'in_mold', 'foil_or_ink_only', 'bare'])('rejects substrate for %s', (carrier) => {
    const invalid = {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, carrier,
        substrate: { kind: 'opaque', opacity: 1, boundary: { shape: 'rectangle' } },
        layers: [],
      }],
    }

    expect(validateLabelSpec(invalid).ok).toBe(false)
    expect(new Ajv2020({ allErrors: true, strict: true }).compile(labelSpecV2Schema)(invalid)).toBe(false)
    expect(() => applyStructuredLabelSpec(baseArea, invalid)).toThrow(/Label Spec 校验失败/)
  })

  it('normalizes an old enabled paper spec to applied_label without changing its paper', () => {
    const oldPaperSpec = structuredClone(existingPerfumeFixture)
    oldPaperSpec.areas[0].paper = { enabled: true, color: '#EDE7DC', opacity: 0.84 }

    const result = validateLabelSpec(oldPaperSpec)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.areas[0].carrier).toBe('applied_label')
      expect(result.spec.areas[0].paper).toEqual(oldPaperSpec.areas[0].paper)
    }
  })

  it('patches optional physical metadata without losing canonical revision coverage', () => {
    const input = structuredClone(existingPerfumeFixture)
    const result = patchLabelSpec(input, {
      version: 1,
      baseRevision: revisionOf(input),
      operations: [
        {
          op: 'update-area', areaId: 'front', changes: {
            carrier: 'applied_label',
            artboard: { widthMm: 42, heightMm: 68, background: '#f8f4ea' },
            substrate: { kind: 'opaque', color: '#f8f4ea', opacity: 1, boundary: { shape: 'rectangle' } },
            placementPolicy: 'block', blueprintAreaId: 'front-blueprint',
            designBinding: {
              blueprintRevision: 'revision-2', blueprintSha256: 'a'.repeat(64), reviewManifestSha256: 'b'.repeat(64),
            },
          },
        },
        {
          op: 'update-layer', areaId: 'front', layerId: 'brand', changes: {
            designMetrics: {
              boundsMm: { x: 4, y: 6, width: 34, height: 10 }, anchor: 'center', fontSizeMm: 4.2,
              letterSpacingEm: 0.08, lineHeight: 1.1, wrapPolicy: 'none', maxLines: 1,
            },
            processes: [{ process: 'screen_print', requiredMask: 'color' }],
          },
        },
      ],
    })

    expect(result.revision).not.toBe(result.previousRevision)
    expect(result.value.areas[0]).toMatchObject({ carrier: 'applied_label', blueprintAreaId: 'front-blueprint' })
    expect(result.value.areas[0].layers[0].designMetrics.fontSizeMm).toBe(4.2)
  })

  it('rejects normalized design bounds outside the normalized 0..1 domain', () => {
    const input = structuredClone(existingPerfumeFixture) as unknown as {
      areas: Array<{ layers: Array<Record<string, unknown>> }>
    }
    input.areas[0].layers[0].designMetrics = {
      normalizedBounds: { x: -0.1, y: 0.1, width: 1.1, height: 0.8 },
      anchor: 'center',
    }

    expect(validateLabelSpec(input).ok).toBe(false)
    expect(new Ajv2020({ allErrors: true, strict: true }).compile(labelSpecV2Schema)(input)).toBe(false)
  })

  it('accepts deterministic front and back areas', () => {
    const result = validateLabelSpec({
      version: 2,
      areas: [
        {
          id: 'front',
          name: '正标',
          target: { meshIndex: 0 },
          surfaceMode: 'overlay',
          side: 'front',
          range: { uStart: 0.35, uWidth: 0.3, vStart: 0.2, vHeight: 0.6 },
          layers: [
            { id: 'brand', type: 'text', text: 'REALIBOX', x: 0.5, y: 0.5, width: 0.7 },
          ],
        },
        {
          id: 'back',
          name: '背标',
          target: { meshIndex: 0 },
          surfaceMode: 'overlay',
          side: 'back',
          range: { uStart: 0.35, uWidth: 0.3, vStart: 0.2, vHeight: 0.6 },
          layers: [],
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.version).toBe(2)
      expect(result.spec.areas.map((area) => area.id)).toEqual(['front', 'back'])
    }
  })

  it('rejects unknown fields and invalid craft parameters', () => {
    const unknown = validateLabelSpec({ version: 2, surprise: true, areas: [] })
    expect(unknown.ok).toBe(false)
    expect(unknown.issues.some((issue) => issue.path === '/surprise')).toBe(true)

    const craft = validateLabelSpec({
      version: 2,
      areas: [{
        id: 'front',
        name: 'Front',
        target: { meshIndex: 0 },
        surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{
          id: 'brand', type: 'text', text: 'Brand', x: 0.5, y: 0.5,
          craft: [{ type: 'foil', params: { highlight: 3 } }],
        }],
      }],
    })
    expect(craft.ok).toBe(false)
  })

  it('migrates v1 and reports every inferred execution field', () => {
    const result = validateLabelSpec({ version: 1, areas: [{ side: 'front', layers: [] }] })
    expect(result.ok).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('target'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('surfaceMode'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('range'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('print'))).toBe(true)
  })

  it('maps a v2 image asset to an editable image layer', () => {
    const result = applyStructuredLabelSpec(baseArea, {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{ id: 'logo', type: 'image', asset: 'logo', x: 0.5, y: 0.5, width: 0.4, height: 0.2 }],
      }],
    })
    expect(result.areas[0].layers[0]).toMatchObject({
      id: 'logo', kind: 'image', src: 'logo', width: 400, height: 100,
    })
  })

  it('preserves shape geometry when mapping a v2 spec to editable native layers', () => {
    const result = applyStructuredLabelSpec(baseArea, {
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{
          id: 'pulse-wave', type: 'shape', shape: 'wave', x: 0.5, y: 0.5,
          width: 0.8, height: 0.2, geometry: { amplitude: 0.18, frequency: 3, dash: [12, 6] },
        }],
      }],
    })

    expect(result.areas[0].layers[0]).toMatchObject({
      id: 'pulse-wave',
      kind: 'shape',
      geometry: { amplitude: 0.18, frequency: 3, dash: [12, 6] },
    })
  })

  it('accepts oversized native shapes so decorative artwork can bleed beyond the die cut', () => {
    const result = validateLabelSpec({
      version: 2,
      areas: [{
        id: 'front', name: 'Front', target: { meshIndex: 0 }, surfaceMode: 'overlay',
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        layers: [{ id: 'orbit', type: 'shape', shape: 'ellipse', x: 0.25, y: 0.8, width: 1.4, height: 0.3 }],
      }],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const mapped = applyStructuredLabelSpec(baseArea, result.spec)
      expect(mapped.areas[0].layers[0]).toMatchObject({ kind: 'shape', width: 1400 })
    }
  })
})
