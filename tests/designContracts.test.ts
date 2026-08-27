import { describe, expect, it } from 'vitest'
import {
  assertDigestBinding,
  canonicalCarrier,
  migrateLegacyApplication,
  WorkflowGateError,
  validateApprovalRecord,
  validateDesignReviewManifest,
  validateEditorHandoff,
  validateLayoutBlueprint,
  validateReviewManifest,
  type CarrierMode,
  type DesignReviewManifestV1,
  type EditorHandoffV2,
  type LayoutBlueprintV1,
  type ReviewManifestV1,
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

describe('layout blueprint font stack validation', () => {
  it.each([
    [['   '], 'space-only'], [['\t'], 'tab-only'], [['\u00a0'], 'NBSP-only'], [['Arial', '   '], 'mixed valid and blank'],
  ] as const)('rejects %s font families before runtime consumption', (fontStack, _label) => {
    const blueprint = carrierBlueprint('direct_surface_print')
    blueprint.areas[0].layers[0].fontStack = [...fontStack]
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/fontStack|schema/i)
  })
})

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

function designReviewManifest(): DesignReviewManifestV1 {
  return {
    version: 1,
    createdAt: '2026-08-26T12:30:00.000Z',
    blueprint: { revision: 'rev-001', sha256: SHA_A },
    html: { sha256: SHA_B },
    references: [],
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'mockup-front', path: 'mockup-front.png', sha256: SHA_A,
      mimeType: 'image/png', width: 1600, height: 1200,
      viewKind: 'mockup-front',
    }, {
      id: 'mockup-back', path: 'mockup-back.png', sha256: SHA_B,
      mimeType: 'image/png', width: 1600, height: 1200,
      viewKind: 'mockup-back',
    }, {
      id: 'mockup-area-front', path: 'mockup-area-front.png', sha256: SHA_A,
      mimeType: 'image/png', width: 1200, height: 1200,
      viewKind: 'mockup-area', areaId: 'front', carrier: 'direct_surface_print',
    }],
  }
}

function productionReviewManifest(): ReviewManifestV1 {
  return {
    version: 1,
    createdAt: '2026-08-26T13:00:00.000Z',
    input: { kind: 'label-spec-v2', revision: 'sha256:current', sha256: SHA_A },
    blueprint: { revision: 'rev-001', sha256: SHA_B },
    designReviewManifest: { sha256: SHA_A },
    model: { fingerprint: 'model-fingerprint-001' },
    areaTargetsSha256: SHA_B,
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'label-front', path: 'label-front.png', sha256: SHA_B,
      mimeType: 'image/png', width: 1600, height: 1600,
      viewKind: 'flat-artwork', areaId: 'front', carrier: 'direct_surface_print',
    }, {
      id: 'surface-front', path: 'surface-front.png', sha256: SHA_A,
      mimeType: 'image/png', width: 1600, height: 1600,
      viewKind: 'surface-face', areaId: 'front', carrier: 'direct_surface_print',
    }],
  }
}

describe('shared design contracts', () => {
  it('bounds structured workflow error details at the exported error boundary', () => {
    const error = new WorkflowGateError('STALE_APPROVAL', 'Approval is stale', {
      payload: 'x'.repeat(5000),
      blockers: Array.from({ length: 100 }, (_, index) => `blocker-${index}`),
    })
    expect(String(error.details?.payload)).toHaveLength(256)
    expect(error.details?.blockers).toHaveLength(32)
  })

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

    applied.areas[0].substrate = {
      kind: 'transparent', opacity: 0.2,
      boundary: { shape: 'rectangle' },
    }
    expect(() => validateLayoutBlueprint(applied)).toThrow(/applied_label.*opaque/i)
    applied.areas[0].substrate = {
      kind: 'opaque', color: '#ffffff', opacity: 0,
      boundary: { shape: 'rectangle' },
    }
    expect(() => validateLayoutBlueprint(applied)).toThrow(/applied_label.*opacity/i)

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

  it('reserves white_underbase for the canonical renderer channel at the blueprint boundary', () => {
    const blueprint = carrierBlueprint('direct_surface_print')
    blueprint.areas[0].layers[0].processes = [{
      process: 'screen_print',
      spotName: 'white_underbase',
      requiredMask: 'color',
    }]

    expect(() => validateLayoutBlueprint(blueprint)).toThrowError(expect.objectContaining({
      code: 'INVALID_LAYOUT_BLUEPRINT',
    }))

    blueprint.areas[0].layers[0].processes = [{
      process: 'white_underbase',
      requiredMask: 'white_underbase',
    }]
    expect(validateLayoutBlueprint(blueprint).version).toBe(1)
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
      nonEditableLayerIds: ['front-title'],
      nonEditableTextIds: ['front-title'],
      lostSeparations: ['spot-varnish'],
      vectorAlternative: 'Supply outlined SVG paths for the glow contour.',
    }
    expect(validateLayoutBlueprint(blueprint).version).toBe(1)
  })

  it('requires flattened disclosures to reference existing layers and real text layers', () => {
    const blueprint = carrierBlueprint('direct_surface_print')
    blueprint.areas[0].layers.push({
      id: 'front-frame', kind: 'shape',
      boundsMm: { x: 2, y: 2, width: 36, height: 56 },
      anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 1,
      processes: [{ process: 'hot_stamp_foil' }],
      shape: 'rectangle', fill: 'transparent', stroke: '#a5663b', strokeWidthMm: 0.2,
    })
    blueprint.areas[0].layers[0].flattenedFallback = {
      accepted: true,
      nonEditableLayerIds: ['missing-layer'],
      nonEditableTextIds: ['front-title'],
      lostSeparations: ['spot-varnish'],
      vectorAlternative: 'Supply outlined SVG paths.',
    }
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/nonEditableLayerIds.*missing-layer/i)

    blueprint.areas[0].layers[0].flattenedFallback.nonEditableLayerIds = ['front-title']
    blueprint.areas[0].layers[0].flattenedFallback.nonEditableTextIds = ['missing-text']
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/nonEditableTextIds.*missing-text/i)

    blueprint.areas[0].layers[0].flattenedFallback.nonEditableTextIds = ['front-frame']
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/nonEditableTextIds.*text layer/i)
  })

  it('caps hostile copy, vector, font, and asset inputs', () => {
    const blueprint = carrierBlueprint('direct_surface_print')
    blueprint.areas[0].layers[0].text = 'x'.repeat(32769)
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/schema/i)
    blueprint.areas[0].layers[0].text = 'LABEL'
    blueprint.assets.push({ id: 'art', path: `assets/${'x'.repeat(2048)}`, sha256: SHA_A, mimeType: 'image/png' })
    expect(() => validateLayoutBlueprint(blueprint)).toThrow(/schema/i)
  })

  it('represents awaiting and blocked handoff states while still rejecting contradictory digests', () => {
    const handoff = approvedHandoff()
    handoff.status = 'awaiting_user_approval'
    expect(validateEditorHandoff(handoff).status).toBe('awaiting_user_approval')
    handoff.status = 'approved'
    handoff.blockers.push('Missing supplier confirmation.')
    expect(validateEditorHandoff(handoff).blockers).toEqual(['Missing supplier confirmation.'])
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

  it('rejects impossible calendar dates in every timestamped contract', () => {
    const approval = {
      version: 1 as const,
      gate: 'design' as const,
      mode: 'explicit_approval' as const,
      scope: 'current_task' as const,
      design_revision: 'rev-001',
      blueprint_sha256: SHA_A,
      review_manifest_sha256: SHA_B,
      recorded_at: '2026-02-31T12:00:00Z',
    }
    expect(() => validateApprovalRecord(approval)).toThrow(/schema/i)

    const designManifest = designReviewManifest()
    designManifest.createdAt = '2026-02-31T12:00:00Z'
    expect(() => validateDesignReviewManifest(designManifest)).toThrow(/schema/i)

    const reviewManifest = productionReviewManifest()
    reviewManifest.createdAt = '2026-02-31T12:00:00Z'
    expect(() => validateReviewManifest(reviewManifest)).toThrow(/schema/i)
  })

  it('rejects out-of-range RFC3339 timezone offsets in the shared manifest contract', () => {
    const designManifest = designReviewManifest()
    designManifest.createdAt = '2026-08-27T00:00:00+99:99'
    expect(() => validateDesignReviewManifest(designManifest)).toThrow(/schema|date-time|RFC3339/i)

    const reviewManifest = productionReviewManifest()
    reviewManifest.createdAt = '2026-08-27T00:00:00+24:00'
    expect(() => validateReviewManifest(reviewManifest)).toThrow(/schema|date-time|RFC3339/i)
  })

  it('allows global front/back mockups while requiring scoped evidence for every design area', () => {
    expect(validateDesignReviewManifest(designReviewManifest()).version).toBe(1)

    const unbound = designReviewManifest()
    const areaArtifact = unbound.artifacts.find((artifact) => artifact.viewKind === 'mockup-area')!
    delete areaArtifact.areaId
    delete areaArtifact.carrier
    expect(() => validateDesignReviewManifest(unbound)).toThrow(/areaId.*carrier/i)

    const incomplete = designReviewManifest()
    incomplete.areas.push({ id: 'back', side: 'back', carrier: 'applied_label' })
    expect(() => validateDesignReviewManifest(incomplete)).toThrow(/back.*design-review evidence/i)
  })

  it('requires area identity and both flat and surface evidence for every production area', () => {
    const unbound = productionReviewManifest()
    delete unbound.artifacts[0].areaId
    delete unbound.artifacts[0].carrier
    expect(() => validateReviewManifest(unbound)).toThrow(/areaId.*carrier/i)

    const incomplete = productionReviewManifest()
    incomplete.artifacts = incomplete.artifacts.filter((artifact) => artifact.viewKind !== 'surface-face')
    expect(() => validateReviewManifest(incomplete)).toThrow(/front.*surface-face/i)

    const missingArea = productionReviewManifest()
    missingArea.areas.push({ id: 'back', side: 'back', carrier: 'applied_label' })
    expect(() => validateReviewManifest(missingArea)).toThrow(/back.*flat-artwork.*surface-face/i)
  })

  it('strictly validates design and production review manifests', () => {
    const designManifest = designReviewManifest()
    expect(validateDesignReviewManifest(designManifest).version).toBe(1)

    const reviewManifest = productionReviewManifest()
    expect(validateReviewManifest(reviewManifest).version).toBe(1)
    reviewManifest.artifacts.push(structuredClone(reviewManifest.artifacts[0]))
    expect(() => validateReviewManifest(reviewManifest)).toThrow(/duplicate artifact id/i)
  })
})
