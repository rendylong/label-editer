import { describe, expect, it } from 'vitest'
import {
  assertDigestBinding,
  canonicalCarrier,
  migrateLegacyApplication,
  validateApprovalRecord,
  validateDesignReviewManifest,
  validateEditorHandoff,
  validateLayoutBlueprint,
  validateReviewManifest,
  type CarrierMode,
  type EditorHandoffV2,
  type LayoutBlueprintV1,
} from '../src/agent/designContracts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function carrierBlueprint(carrier: CarrierMode): LayoutBlueprintV1 {
  return {
    version: 1,
    revision: 'rev-001',
    carrierDefaults: { carrier },
    assets: [],
    areas: [{
      id: 'front',
      side: 'front',
      carrier,
      artboard: { widthMm: 40, heightMm: 60, background: 'transparent' },
      placementIntent: 'Centered on the front face.',
      layers: [{
        id: 'front-title',
        kind: 'text',
        boundsMm: { x: 4, y: 8, width: 32, height: 8 },
        anchor: 'top_left',
        rotation: 0,
        opacity: 1,
        visible: true,
        zIndex: 0,
        processes: [{ process: 'screen_print' }],
        text: 'LABEL',
        language: 'en',
        writingDirection: 'ltr',
        fontStack: ['Arial', 'sans-serif'],
        fontSizeMm: 4,
        fontWeight: 600,
        letterSpacingEm: 0,
        lineHeight: 1.1,
        alignment: 'center',
        wrapPolicy: 'none',
        maxLines: 1,
        color: '#111111',
      }],
    }],
  }
}

function approvedHandoff(): EditorHandoffV2 {
  return {
    handoff_version: 2,
    status: 'approved',
    source: {
      design_spec: 'design-spec.md',
      mockup_html: 'mockup.html',
      blueprint: 'layout-blueprint.json',
      design_review_manifest: 'design-review-manifest.json',
      blueprint_revision: 'rev-001',
      blueprint_sha256: SHA_A,
      review_manifest_sha256: SHA_B,
    },
    approval: {
      mode: 'explicit_approval',
      scope: 'current_task',
      blueprint_revision: 'rev-001',
      blueprint_sha256: SHA_A,
      review_manifest_sha256: SHA_B,
    },
    model: { package_type: 'bottle' },
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      placement: 'Centered on the front face.',
      physical_size_mm: { width: 40, height: 60 },
      blueprint_area_id: 'front',
    }],
    assets: [],
    production_constraints: {},
    assumptions: [],
    blockers: [],
  }
}

describe('shared design contracts', () => {
  it.each([
    ['paper_label', 'applied_label'],
    ['direct_print', 'direct_surface_print'],
    ['clear_label', 'clear_label'],
    ['foil_stamp', 'foil_or_ink_only'],
    ['bare_no_label', 'bare'],
  ])('migrates %s to %s', (legacy, canonical) => {
    expect(canonicalCarrier(legacy)).toBe(canonical)
  })

  it('rejects a synthesized paper panel on direct surface print', () => {
    const blueprint = carrierBlueprint('direct_surface_print')
    blueprint.areas[0].substrate = {
      kind: 'opaque', color: '#ffffff', opacity: 1,
      boundary: { shape: 'rounded_rectangle', radiusMm: 2 },
    }
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/direct_surface_print.*substrate/i)
  })

  it('preserves hot-stamp intent when migrating the legacy foil application', () => {
    expect(migrateLegacyApplication('foil_stamp')).toEqual({
      carrier: 'foil_or_ink_only',
      processes: [{ process: 'hot_stamp_foil' }],
    })
  })

  it('enforces carrier-specific substrate and decoration invariants', () => {
    const applied = carrierBlueprint('applied_label')
    expect(() => validateLayoutBlueprint(applied)).toThrow(/applied_label.*substrate.*boundary/i)
    applied.areas[0].substrate = {
      kind: 'opaque', color: '#ffffff', opacity: 1,
      boundary: { shape: 'rounded_rectangle', radiusMm: 2 },
    }
    expect(validateLayoutBlueprint(applied).version).toBe(1)

    const clear = carrierBlueprint('clear_label')
    clear.areas[0].substrate = {
      kind: 'transparent', opacity: 0,
      boundary: { shape: 'rectangle' },
    }
    clear.areas[0].layers[0].processes = [{ process: 'white_underbase' }]
    expect(() => validateLayoutBlueprint(clear)).toThrow(/white_underbase.*requiredMask/i)
    clear.areas[0].layers[0].processes = [{ process: 'white_underbase', requiredMask: 'white_underbase' }]
    expect(validateLayoutBlueprint(clear).version).toBe(1)

    const bare = carrierBlueprint('bare')
    expect(() => validateLayoutBlueprint(bare)).toThrow(/bare.*layers/i)
    bare.areas[0].layers = []
    expect(validateLayoutBlueprint(bare).areas[0].carrier).toBe('bare')
  })

  it('requires exactly one coordinate source and globally unique ids', () => {
    const blueprint = carrierBlueprint('direct_surface_print')
    blueprint.areas[0].layers[0].normalizedBounds = { x: 0.1, y: 0.1, width: 0.8, height: 0.2 }
    expect(() => validateLayoutBlueprint(blueprint)).toThrowError(expect.objectContaining({
      code: 'INVALID_LAYOUT_BLUEPRINT',
    }))
    delete blueprint.areas[0].layers[0].normalizedBounds
    blueprint.areas.push(structuredClone(blueprint.areas[0]))
    blueprint.areas[1].id = 'back'
    blueprint.areas[1].side = 'back'
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/duplicate layer id/i)
  })

  it('requires explicit accepted losses for flattened artwork', () => {
    const blueprint = carrierBlueprint('direct_surface_print')
    blueprint.areas[0].layers[0].flattenedFallback = {
      accepted: false,
      nonEditableLayerIds: ['front-title'],
      nonEditableTextIds: ['front-title'],
      lostSeparations: ['spot-varnish'],
      vectorAlternative: 'Supply outlined SVG paths.',
    }
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/flattened.*accepted/i)
    blueprint.areas[0].layers[0].flattenedFallback = {
      accepted: true,
      nonEditableLayerIds: ['front-glow', 'front-title'],
      nonEditableTextIds: ['front-title'],
      lostSeparations: ['spot-varnish'],
      vectorAlternative: 'Supply outlined SVG paths for the glow contour.',
    }
    expect(validateLayoutBlueprint(blueprint).version).toBe(1)
  })

  it('caps hostile copy, vector, font, and asset inputs', () => {
    const blueprint = carrierBlueprint('direct_surface_print')
    blueprint.areas[0].layers[0].text = 'x'.repeat(32769)
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/schema/i)
    blueprint.areas[0].layers[0].text = 'LABEL'
    blueprint.assets.push({ id: 'art', path: `assets/${'x'.repeat(2048)}`, sha256: SHA_A, mimeType: 'image/png' })
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/schema/i)
  })

  it('blocks an awaiting, blocked, or digest-mismatched handoff', () => {
    const handoff = approvedHandoff()
    handoff.status = 'awaiting_user_approval'
    expect(() => validateEditorHandoff(handoff)).toThrow(/awaiting_user_approval/)
    handoff.status = 'approved'
    handoff.blockers.push('Missing supplier confirmation.')
    expect(() => validateEditorHandoff(handoff)).toThrow(/blocker/i)
    handoff.blockers = []
    handoff.approval.blueprint_sha256 = '0'.repeat(64)
    expect(() => validateEditorHandoff(handoff)).toThrow(/digest/i)
  })

  it('validates a current, digest-bound handoff and direct digest assertions', () => {
    expect(validateEditorHandoff(approvedHandoff()).handoff_version).toBe(2)
    expect(() => assertDigestBinding(SHA_A, SHA_B, 'blueprint')).toThrow(/blueprint.*digest/i)
    expect(assertDigestBinding(SHA_A, SHA_A, 'blueprint')).toBeUndefined()
  })

  it('strictly validates versioned approval records', () => {
    const approval = {
      version: 1 as const,
      gate: 'design' as const,
      mode: 'explicit_approval' as const,
      scope: 'current_task' as const,
      design_revision: 'rev-001',
      blueprint_sha256: SHA_A,
      review_manifest_sha256: SHA_B,
      recorded_at: '2026-08-26T12:30:00.000Z',
    }
    expect(validateApprovalRecord(approval)).toEqual(approval)
    expect(() => validateApprovalRecord({ ...approval, blueprint_sha256: SHA_A.toUpperCase() })).toThrow(/schema/i)
    expect(() => validateApprovalRecord({ ...approval, extra: true })).toThrow(/schema/i)
  })

  it('strictly validates design and production review manifests', () => {
    const designManifest = {
      version: 1 as const,
      createdAt: '2026-08-26T12:30:00.000Z',
      blueprint: { revision: 'rev-001', sha256: SHA_A },
      html: { sha256: SHA_B },
      references: [],
      areas: [{ id: 'front', side: 'front' as const, carrier: 'direct_surface_print' as const }],
      artifacts: [{
        id: 'mockup-front', path: 'mockup-front.png', sha256: SHA_A,
        mimeType: 'image/png', width: 1600, height: 1200,
        viewKind: 'mockup-front' as const, areaId: 'front', carrier: 'direct_surface_print' as const,
      }],
    }
    expect(validateDesignReviewManifest(designManifest).version).toBe(1)

    const reviewManifest = {
      version: 1 as const,
      createdAt: '2026-08-26T13:00:00.000Z',
      input: { kind: 'label-spec-v2' as const, revision: 'sha256:current', sha256: SHA_A },
      blueprint: { revision: 'rev-001', sha256: SHA_B },
      designReviewManifest: { sha256: SHA_A },
      model: { fingerprint: 'model-fingerprint-001' },
      areas: [{ id: 'front', side: 'front' as const, carrier: 'direct_surface_print' as const }],
      artifacts: [{
        id: 'label-front', path: 'label-front.png', sha256: SHA_B,
        mimeType: 'image/png', width: 1600, height: 1600,
        viewKind: 'flat-artwork' as const, areaId: 'front', carrier: 'direct_surface_print' as const,
      }],
    }
    expect(validateReviewManifest(reviewManifest).version).toBe(1)
    reviewManifest.artifacts.push(structuredClone(reviewManifest.artifacts[0]))
    expect(() => validateReviewManifest(reviewManifest)).toThrow(/duplicate artifact id/i)
  })
})
