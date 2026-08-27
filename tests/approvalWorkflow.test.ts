import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BlueprintCompilerError, compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import { serializeLabelProject } from '../src/app/projectSchema'
import type { LabelAreaConfig } from '../src/label/types'
import {
  WorkflowGateError,
  classifyRevisionChange,
  computeAreaTargetsSha256,
  verifyDesignGate,
  verifyProductionGate,
  type ApprovalRecordV1,
  type DesignReviewManifestV1,
  type EditorHandoffV2,
  type LayoutBlueprintV1,
  type ReviewManifestV1,
  type WorkflowJsonSource,
  type WorkflowRevisionSnapshot,
} from '../src/agent/designContracts'
// @ts-expect-error Pure Node ESM canonical revision helper is consumed directly by tests.
import { revisionOf } from '../scripts/lib/project-control.mjs'

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
    key, canonicalValue((value as Record<string, unknown>)[key]),
  ]))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalSha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(value)))
}

function source(read: () => unknown): WorkflowJsonSource {
  return { read: () => JSON.stringify(read()) }
}

function alternatingSource(first: unknown, second: unknown): WorkflowJsonSource {
  let reads = 0
  return { read: () => JSON.stringify(reads++ === 0 ? first : second) }
}

function areaTargetsSha256(document: any): string {
  const areas = document.areas.map((area: any) => ({
    id: area.id,
    blueprintAreaId: area.blueprintAreaId ?? null,
    target: area.target ?? { meshIndex: area.meshIndex, nodeName: area.nodeName },
    surfaceMode: area.surfaceMode,
    side: area.side ?? null,
    range: area.range,
    remap: area.remap ?? null,
    placementPolicy: area.placementPolicy ?? null,
    canvas: area.canvas ?? null,
    axisMin: area.axisMin ?? null,
    axisMax: area.axisMax ?? null,
  })).sort((left: any, right: any) => left.id.localeCompare(right.id))
  return canonicalSha256({ areas })
}

function blueprint(): LayoutBlueprintV1 {
  const text = (id: string, value: string, y: number, zIndex: number): LayoutBlueprintV1['areas'][number]['layers'][number] => ({
    id, kind: 'text', boundsMm: { x: 4, y, width: 32, height: 8 }, anchor: 'top_left', rotation: 0,
    opacity: 1, visible: true, zIndex, processes: [{ process: 'screen_print' }], text: value,
    language: 'en', writingDirection: 'ltr', fontStack: ['Arial', 'sans-serif'], fontSizeMm: 4,
    fontWeight: 600, letterSpacingEm: 0, lineHeight: 1.1, alignment: 'center', wrapPolicy: 'none',
    maxLines: 1, color: '#111111',
  })
  return {
    version: 1, revision: 'design-rev-001', carrierDefaults: { carrier: 'direct_surface_print' }, assets: [],
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      artboard: { widthMm: 40, heightMm: 60, background: 'transparent' },
      placementIntent: 'Centered on the front face.', placementPolicy: 'fit',
      layers: [text('brand', 'LAVIRA', 8, 0), text('product', 'EMBER WOODS', 20, 1)],
    }],
  }
}

function designManifest(blueprintSha256: string, side: LayoutBlueprintV1['areas'][number]['side'] = 'front'): DesignReviewManifestV1 {
  return {
    version: 1, createdAt: '2026-08-27T10:00:00.000Z',
    blueprint: { revision: 'design-rev-001', sha256: blueprintSha256 },
    html: { sha256: '1'.repeat(64) }, references: [],
    areas: [{ id: 'front', side, carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'mockup-front', path: 'mockup-front.png', sha256: '2'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1200, viewKind: 'mockup-front',
    }, {
      id: 'mockup-back', path: 'mockup-back.png', sha256: '3'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1200, viewKind: 'mockup-back',
    }, {
      id: 'mockup-area-front', path: 'areas/front.png', sha256: '4'.repeat(64), mimeType: 'image/png',
      width: 800, height: 1200, viewKind: 'mockup-area', areaId: 'front', carrier: 'direct_surface_print',
    }],
  }
}

function labelDocument(sourceBlueprint: LayoutBlueprintV1, blueprintSha256: string, designManifestSha256: string): any {
  const [compiledArea] = compileBlueprintToSpecAreas(sourceBlueprint)
  return {
    version: 2,
    areas: [{
      id: 'front', name: 'Front', target: { stableSelector: 'mesh:0/node:1' }, surfaceMode: 'overlay', side: compiledArea.side,
      range: { uStart: 0.1, uWidth: 0.3, vStart: 0.2, vHeight: 0.5 },
      remap: { mode: 'cylindrical', wrap: 1, offset: 0, mirrorU: false },
      carrier: 'direct_surface_print', artboard: { widthMm: 40, heightMm: 60, background: 'transparent' },
      placementPolicy: 'fit', blueprintAreaId: 'front',
      designBinding: {
        blueprintRevision: 'design-rev-001', blueprintSha256, reviewManifestSha256: designManifestSha256,
      },
      layers: compiledArea.layers,
    }],
  }
}

function projectDocument(sourceBlueprint: LayoutBlueprintV1, blueprintSha256: string, designManifestSha256: string): any {
  const shell: LabelAreaConfig = {
    id: 'front', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', side: 'front',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      mirrorU: false, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    },
    range: { uStart: 0.1, uWidth: 0.3, vStart: 0.2, vHeight: 0.5 },
    canvas: { width: 1024, height: 1536, aspect: 2 / 3 },
    paper: { enabled: false, color: '#ffffff', opacity: 0 }, layers: [], globalCraft: { craft: [] },
    fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
  const spec = labelDocument(sourceBlueprint, blueprintSha256, designManifestSha256)
  return serializeLabelProject('bottle.glb', applyStructuredLabelSpec(shell, spec).areas)
}

function handoff(
  blueprintSha256: string,
  designManifestSha256: string,
  side: LayoutBlueprintV1['areas'][number]['side'] = 'front',
): EditorHandoffV2 {
  return {
    handoff_version: 2, status: 'approved',
    source: {
      design_spec: 'design-spec.md', mockup_html: 'mockup.html', blueprint: 'layout-blueprint.json',
      design_review_manifest: 'design-review-manifest.json', blueprint_revision: 'design-rev-001',
      blueprint_sha256: blueprintSha256, review_manifest_sha256: designManifestSha256,
    },
    approval: {
      mode: 'explicit_approval', scope: 'current_task', blueprint_revision: 'design-rev-001',
      blueprint_sha256: blueprintSha256, review_manifest_sha256: designManifestSha256,
    },
    model: { package_type: 'bottle' },
    areas: [{
      id: 'front', side, carrier: 'direct_surface_print', placement: 'Centered front.',
      physical_size_mm: { width: 40, height: 60 }, blueprint_area_id: 'front',
    }],
    assets: [], production_constraints: {}, assumptions: [], blockers: [],
  }
}

function legacyHandoff(status: 'approved' | 'assumed_for_fast_run' | 'awaiting_user_approval' | 'rejected' = 'approved') {
  return {
    handoff_version: 1,
    status,
    source: { design_spec: 'design-spec.md', mockup: 'mockup.html' },
    model: { package_type: 'bottle' },
    design_intent: {
      selected_direction: 'Ember', positioning: 'premium woody fragrance',
      convention_basis: ['category benchmark'], differentiation_axes: ['layout', 'typography'],
    },
    areas: [{
      id: 'front', side: 'front', application: 'direct_print', placement: 'Centered front.',
      physical_size_mm: { width: 40, height: 60 }, shape: 'rectangle',
      layer_order: ['brand', 'product'],
      copy: [{ text: 'LAVIRA', role: 'brand', language: 'en', writing_direction: 'ltr', placeholder: false }],
      typography: { class: 'sans', font_preference: 'Arial', weight: 600, case: 'uppercase', letter_spacing: 0, alignment: 'center' },
      palette: [{ role: 'ink', color: '#111111' }],
      processes: [{ element: 'brand', process: 'screen_print' }],
    }],
    assets: [],
    print_constraints: { bleed_mm: 'unknown', minimum_text_height_mm: 'unknown', spot_colors: [] },
    assumptions: [], blockers: [],
  }
}

function productionManifest(input: {
  document: any
  blueprintSha256: string
  designManifestSha256: string
  modelFingerprint: string
}): ReviewManifestV1 {
  return {
    version: 1, createdAt: '2026-08-27T10:30:00.000Z',
    input: {
      kind: 'label-spec-v2', revision: revisionOf(input.document), sha256: sha256(JSON.stringify(input.document)),
    },
    blueprint: { revision: 'design-rev-001', sha256: input.blueprintSha256 },
    designReviewManifest: { sha256: input.designManifestSha256 }, model: { fingerprint: input.modelFingerprint },
    areaTargetsSha256: areaTargetsSha256(input.document),
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'label-front', path: 'label-front.png', sha256: '5'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1600, viewKind: 'flat-artwork', areaId: 'front', carrier: 'direct_surface_print',
    }, {
      id: 'surface-front', path: 'surface-front.png', sha256: '6'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1600, viewKind: 'surface-face', areaId: 'front', carrier: 'direct_surface_print',
      camera: { position: [0, 0, 3], direction: [0, 0, -1], target: [0, 0, 0], up: [0, 1, 0], fov: 45 },
    }, {
      id: 'model-front', path: 'model-front.png', sha256: '7'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1600, viewKind: 'model-front',
      camera: { position: [0, 0, 3], direction: [0, 0, -1], target: [0, 0, 0], up: [0, 1, 0], fov: 45 },
    }, {
      id: 'model-back', path: 'model-back.png', sha256: '8'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1600, viewKind: 'model-back',
      camera: { position: [0, 0, -3], direction: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], fov: 45 },
    }, {
      id: 'review-sheet', path: 'review-sheet.png', sha256: '9'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1600, viewKind: 'review-sheet',
    }],
  }
}

function workflowFixture(sourceBlueprint = blueprint()) {
  const state: any = { blueprint: sourceBlueprint, modelFingerprint: 'model-fingerprint-001' }
  state.blueprintSha256 = sha256(JSON.stringify(state.blueprint))
  state.designManifest = designManifest(state.blueprintSha256, sourceBlueprint.areas[0].side)
  state.designManifestSha256 = sha256(JSON.stringify(state.designManifest))
  state.document = labelDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
  state.handoff = handoff(state.blueprintSha256, state.designManifestSha256, sourceBlueprint.areas[0].side)
  state.productionManifest = productionManifest(state)
  state.productionManifestSha256 = sha256(JSON.stringify(state.productionManifest))
  state.productionApproval = {
    version: 1, gate: 'production', mode: 'explicit_approval', scope: 'current_task',
    design_revision: 'design-rev-001', blueprint_sha256: state.blueprintSha256,
    review_manifest_sha256: state.productionManifestSha256, spec_revision: revisionOf(state.document),
    model_fingerprint: state.modelFingerprint, area_targets_sha256: areaTargetsSha256(state.document),
    recorded_at: '2026-08-27T10:31:00.000Z',
  } satisfies ApprovalRecordV1
  return state
}

function designGateInput(state: any) {
  return {
    handoff: state.handoff,
    blueprint: source(() => state.blueprint),
    designReviewManifest: source(() => state.designManifest),
    currentDocument: source(() => state.document),
    ...(state.designApproval ? { approvalRecord: state.designApproval } : {}),
  }
}

function productionGateInput(state: any) {
  return {
    ...designGateInput(state), approvalRecord: state.productionApproval,
    productionReviewManifest: source(() => state.productionManifest),
    modelFingerprint: state.modelFingerprint,
  }
}

async function expectWorkflowCode(promise: Promise<unknown>, code: WorkflowGateError['code'], field?: string) {
  await expect(promise).rejects.toMatchObject({
    name: 'WorkflowGateError', code, ...(field ? { details: { field } } : {}),
  })
}

describe('design approval gate', () => {
  it('accepts an approved v2 handoff bound to current blueprint, review evidence, and Spec binding', async () => {
    const state = workflowFixture()
    await expect(verifyDesignGate(designGateInput(state))).resolves.toMatchObject({
      valid: true, status: 'approved', blueprintRevision: 'design-rev-001',
      blueprintSha256: state.blueprintSha256, designReviewManifestSha256: state.designManifestSha256,
    })
  })

  it.each(['front', 'back', 'left', 'right', 'wrap', 'top', 'bottom', 'neck', 'custom'] as const)(
    'accepts approved %s side identity without lossy front/back coercion',
    async (side) => {
      const sourceBlueprint = blueprint()
      sourceBlueprint.areas[0].side = side
      const state = workflowFixture(sourceBlueprint)

      await expect(verifyDesignGate(designGateInput(state))).resolves.toMatchObject({ valid: true, status: 'approved' })
    },
  )

  it('represents awaiting and rejected states deterministically without claiming approval', async () => {
    const awaiting = workflowFixture(); awaiting.handoff.status = 'awaiting_user_approval'
    await expectWorkflowCode(verifyDesignGate(designGateInput(awaiting)), 'AWAITING_USER_APPROVAL')

    const rejected = workflowFixture(); rejected.handoff = legacyHandoff('rejected')
    await expectWorkflowCode(verifyDesignGate(designGateInput(rejected)), 'AWAITING_USER_APPROVAL')
  })

  it('blocks non-empty blocker lists with bounded workflow details', async () => {
    const state = workflowFixture()
    state.handoff.blockers = ['x'.repeat(1000)]
    await expect(verifyDesignGate(designGateInput(state))).rejects.toSatisfy((error: WorkflowGateError) => (
      error.code === 'HANDOFF_BLOCKED'
      && Array.isArray(error.details?.blockers)
      && String((error.details!.blockers as string[])[0]).length <= 256
    ))
  })

  it('distinguishes contradictory digests from a stale current approval', async () => {
    const contradiction = workflowFixture()
    contradiction.handoff.approval.blueprint_sha256 = '0'.repeat(64)
    await expectWorkflowCode(verifyDesignGate(designGateInput(contradiction)), 'DIGEST_MISMATCH', 'handoff.blueprintSha256')

    const stale = workflowFixture()
    stale.handoff.source.blueprint_revision = 'design-rev-000'
    stale.handoff.approval.blueprint_revision = 'design-rev-000'
    await expectWorkflowCode(verifyDesignGate(designGateInput(stale)), 'STALE_APPROVAL', 'blueprint.revision')
  })

  it('rejects a manifest whose embedded blueprint binding does not match current bytes', async () => {
    const state = workflowFixture()
    state.designManifest.blueprint.sha256 = '0'.repeat(64)
    const newManifestSha = sha256(JSON.stringify(state.designManifest))
    state.handoff.source.review_manifest_sha256 = newManifestSha
    state.handoff.approval.review_manifest_sha256 = newManifestSha
    state.document.areas[0].designBinding.reviewManifestSha256 = newManifestSha
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'DIGEST_MISMATCH', 'designReviewManifest.blueprint')
  })

  it('enforces exact current-task scope and current normalized design bindings', async () => {
    const wrongScope = workflowFixture()
    wrongScope.handoff.approval.scope = 'all_tasks'
    await expectWorkflowCode(verifyDesignGate(designGateInput(wrongScope)), 'APPROVAL_REQUIRED', 'approval.scope')

    const missingBinding = workflowFixture()
    delete missingBinding.document.areas[0].designBinding
    await expectWorkflowCode(verifyDesignGate(designGateInput(missingBinding)), 'APPROVAL_REQUIRED', 'designBinding')

    const staleBinding = workflowFixture()
    staleBinding.document.areas[0].designBinding.blueprintSha256 = '0'.repeat(64)
    await expectWorkflowCode(verifyDesignGate(designGateInput(staleBinding)), 'STALE_APPROVAL', 'designBinding')
  })

  it.each([
    ['exact copy', (state: any) => { state.document.areas[0].layers[0].text = 'UNAPPROVED' }],
    ['layer order', (state: any) => { state.document.areas[0].layers.reverse() }],
    ['layer type', (state: any) => {
      const layer = state.document.areas[0].layers[0]
      state.document.areas[0].layers[0] = {
        id: layer.id, type: 'shape', shape: 'rectangle', x: layer.x, y: layer.y, width: 0.5, height: 0.2,
        rotation: layer.rotation, opacity: layer.opacity, visible: layer.visible, locked: false,
        fill: '#111111', stroke: '#111111', strokeWidth: 0, cornerRadius: 0,
        craft: layer.craft, designMetrics: layer.designMetrics, processes: layer.processes,
      }
    }],
    ['physical layout', (state: any) => { state.document.areas[0].layers[0].designMetrics.boundsMm.x = 9 }],
    ['typography', (state: any) => { state.document.areas[0].layers[0].designMetrics.fontSizeMm = 9 }],
    ['process intent', (state: any) => { state.document.areas[0].layers[0].processes = [{ process: 'pad_print' }] }],
  ])('rejects unapproved %s changes in the current Label Spec composition', async (_label, mutate) => {
    const state = workflowFixture(); mutate(state)
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it('rejects unapproved editable composition changes in a current Project v3', async () => {
    const state = workflowFixture()
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    state.document.areas[0].layers[0].text = 'UNAPPROVED PROJECT COPY'
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it('matches design-review id ordering for equal-z Project layers regardless of stored array order', async () => {
    const state = workflowFixture()
    const project = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    project.areas[0].layers.forEach((layer: any) => { layer.zIndex = 0 })
    project.areas[0].layers.reverse()
    state.document = project

    await expect(verifyDesignGate(designGateInput(state))).resolves.toMatchObject({ valid: true, status: 'approved' })
  })

  it('rejects a Project order that only matches a reversed ambient locale instead of review code-unit order', async () => {
    const sourceBlueprint = blueprint()
    sourceBlueprint.areas[0].layers[0].id = 'I'
    sourceBlueprint.areas[0].layers[1].id = 'i'
    sourceBlueprint.areas[0].layers.forEach((layer) => { layer.zIndex = 0 })
    const state = workflowFixture(sourceBlueprint)
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    state.document.areas[0].layers.find((layer: any) => layer.id === 'I').zIndex = 1
    state.document.areas[0].layers.find((layer: any) => layer.id === 'i').zIndex = 0
    const original = String.prototype.localeCompare
    let outcome: unknown
    try {
      String.prototype.localeCompare = function (other: string): number {
        return String(this) < other ? 1 : String(this) > other ? -1 : 0
      }
      outcome = await verifyDesignGate(designGateInput(state)).catch((error: unknown) => error)
    } finally {
      String.prototype.localeCompare = original
    }

    expect(outcome).toMatchObject({
      name: 'WorkflowGateError', code: 'STALE_APPROVAL', details: { field: 'currentDocument.design' },
    })
  })

  it('rejects a Project z-order change defined by the design-review comparator', async () => {
    const state = workflowFixture()
    const project = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    const firstZ = project.areas[0].layers[0].zIndex
    project.areas[0].layers[0].zIndex = project.areas[0].layers[1].zIndex
    project.areas[0].layers[1].zIndex = firstZ
    state.document = project

    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it('binds every runtime shape input not superseded by physical metrics', async () => {
    const sourceBlueprint = blueprint()
    sourceBlueprint.areas[0].layers.push({
      id: 'frame', kind: 'shape', boundsMm: { x: 2, y: 2, width: 36, height: 56 },
      anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 2, processes: [],
      shape: 'rectangle', fill: 'transparent', stroke: '#111111',
    })
    const state = workflowFixture(sourceBlueprint)
    state.document.areas[0].layers[2].cornerRadius = 28

    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it('binds the compiled image asset and fit mode as actual editor render inputs', async () => {
    const sourceBlueprint = blueprint()
    sourceBlueprint.assets.push({
      id: 'mark', path: 'assets/mark.png', sha256: '9'.repeat(64), mimeType: 'image/png', width: 160, height: 40,
    })
    sourceBlueprint.areas[0].layers = [{
      id: 'mark', kind: 'image', boundsMm: { x: 4, y: 8, width: 32, height: 12 },
      anchor: 'center', rotation: 0, opacity: 1, visible: true, zIndex: 0, processes: [],
      assetId: 'mark', fit: 'contain',
    }]
    const state = workflowFixture(sourceBlueprint)
    state.document.areas[0].layers[0].fit = 'cover'

    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it('rejects forged raw Project text proxies even when physical metrics resolve to approved values', async () => {
    const state = workflowFixture()
    const project = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    project.areas[0].layers[0].x = 999
    project.areas[0].layers[0].y = 888
    project.areas[0].layers[0].fontSize = 777
    project.areas[0].layers[0].letterSpacing = 666
    project.areas[0].layers[0].lineHeight = 4
    state.document = project

    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it.each([
    ['x', (layer: any) => { layer.x += 11 }],
    ['y', (layer: any) => { layer.y += 13 }],
    ['width', (layer: any) => { layer.width += 17 }],
    ['fontSize', (layer: any) => { layer.fontSize += 19 }],
    ['letterSpacing', (layer: any) => { layer.letterSpacing += 23 }],
    ['lineHeight', (layer: any) => { layer.lineHeight += 0.25 }],
  ])('binds the raw Project text %s input even when physical metadata also resolves it', async (_field, mutate) => {
    const state = workflowFixture()
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    mutate(state.document.areas[0].layers[0])

    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it.each([
    ['x', (layer: any) => { delete layer.designMetrics.boundsMm }, (layer: any) => { layer.x += 1 }],
    ['width', (layer: any) => { delete layer.designMetrics.boundsMm }, (layer: any) => { layer.width += 1 }],
    ['fontSize', (layer: any) => { delete layer.designMetrics.fontSizeMm }, (layer: any) => { layer.fontSize += 1 }],
    ['letterSpacing', (layer: any) => { delete layer.designMetrics.letterSpacingEm }, (layer: any) => { layer.letterSpacing += 1 }],
    ['lineHeight', (layer: any) => { delete layer.designMetrics.lineHeight }, (layer: any) => { layer.lineHeight += 0.1 }],
  ])('binds Project %s after its corresponding physical override is absent', async (_field, removeOverride, mutate) => {
    const state = workflowFixture()
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    const layer = state.document.areas[0].layers[0]
    removeOverride(layer)
    await expect(verifyDesignGate(designGateInput(state))).resolves.toMatchObject({ valid: true })

    mutate(layer)
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it('binds Project shape pixels when optional physical stroke and radius overrides are absent', async () => {
    const sourceBlueprint = blueprint()
    sourceBlueprint.areas[0].layers.push({
      id: 'frame', kind: 'shape', boundsMm: { x: 2, y: 2, width: 36, height: 56 },
      anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 2, processes: [],
      shape: 'rectangle', fill: 'transparent', stroke: '#111111',
    })
    const state = workflowFixture(sourceBlueprint)
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    state.document.areas[0].layers[2].strokeWidth = 3

    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it.each([
    ['x', (layer: any) => { layer.x += 11 }],
    ['y', (layer: any) => { layer.y += 13 }],
    ['width', (layer: any) => { layer.width += 17 }],
    ['height', (layer: any) => { layer.height += 19 }],
    ['strokeWidth', (layer: any) => { layer.strokeWidth += 23 }],
    ['cornerRadius', (layer: any) => { layer.cornerRadius += 29 }],
  ])('binds the raw Project shape %s input even when physical metadata also resolves it', async (_field, mutate) => {
    const sourceBlueprint = blueprint()
    sourceBlueprint.areas[0].layers.push({
      id: 'frame', kind: 'shape', boundsMm: { x: 2, y: 2, width: 36, height: 56 },
      anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 2, processes: [],
      shape: 'rounded_rectangle', fill: 'transparent', stroke: '#111111', strokeWidthMm: 0.2, cornerRadiusMm: 1,
    })
    const state = workflowFixture(sourceBlueprint)
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    mutate(state.document.areas[0].layers[2])

    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it.each([
    ['x', (layer: any) => { layer.x += 11 }],
    ['y', (layer: any) => { layer.y += 13 }],
    ['width', (layer: any) => { layer.width += 17 }],
    ['height', (layer: any) => { layer.height += 19 }],
  ])('binds the raw Project image %s input even when physical metadata also resolves it', async (_field, mutate) => {
    const sourceBlueprint = blueprint()
    sourceBlueprint.assets.push({
      id: 'mark', path: 'assets/mark.png', sha256: '9'.repeat(64), mimeType: 'image/png', width: 160, height: 40,
    })
    sourceBlueprint.areas[0].layers = [{
      id: 'mark', kind: 'image', boundsMm: { x: 4, y: 8, width: 32, height: 12 },
      anchor: 'center', rotation: 0, opacity: 1, visible: true, zIndex: 0, processes: [],
      assetId: 'mark', fit: 'contain',
    }]
    const state = workflowFixture(sourceBlueprint)
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    mutate(state.document.areas[0].layers[0])

    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it('fingerprints bounded embedded font bytes instead of trusting an unchanged font name', async () => {
    const sourceBlueprint = blueprint()
    const approvedBytes = Buffer.from('approved-font-bytes')
    sourceBlueprint.assets.push({
      id: 'brand-font', path: 'assets/brand.woff2', sha256: sha256(approvedBytes.toString('binary')),
      mimeType: 'font/woff2',
    })
    sourceBlueprint.areas[0].layers[0].fontStack = undefined
    sourceBlueprint.areas[0].layers[0].fontAsset = 'brand-font'
    const state = workflowFixture(sourceBlueprint)
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    state.document.areas[0].fonts = [{
      name: 'assets/brand.woff2', dataUrl: `data:font/woff2;base64,${approvedBytes.toString('base64')}`,
    }]
    await expect(verifyDesignGate(designGateInput(state))).resolves.toMatchObject({ valid: true })

    state.document.areas[0].fonts[0].dataUrl = `data:font/woff2;base64,${Buffer.from('forged-font-bytes').toString('base64')}`
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'currentDocument.design')
  })

  it('normalizes legacy approved and assumed-fast-run handoffs to an awaiting state', async () => {
    const approved = workflowFixture(); approved.handoff = legacyHandoff('approved')
    await expectWorkflowCode(verifyDesignGate(designGateInput(approved)), 'APPROVAL_REQUIRED', 'handoff.version')

    const assumed = workflowFixture(); assumed.handoff = legacyHandoff('assumed_for_fast_run')
    await expectWorkflowCode(verifyDesignGate(designGateInput(assumed)), 'AWAITING_USER_APPROVAL', 'handoff.status')
  })

  it('accepts only current explicit continuous authorization and keeps all evidence checks', async () => {
    const current = workflowFixture()
    current.handoff.status = 'continuous_authorized'
    current.handoff.approval.mode = 'continuous_authorized'
    await expect(verifyDesignGate(designGateInput(current))).resolves.toMatchObject({ valid: true, status: 'continuous_authorized' })

    current.designManifest.blueprint.revision = 'design-rev-stale'
    await expectWorkflowCode(verifyDesignGate(designGateInput(current)), 'DIGEST_MISMATCH', 'designReviewManifest.blueprint')
  })

  it('allows legacy fast-run only with a current-task continuous authorization record and current evidence', async () => {
    const state = workflowFixture()
    state.handoff = legacyHandoff('assumed_for_fast_run')
    state.designApproval = {
      version: 1, gate: 'design', mode: 'continuous_authorized', scope: 'current_task',
      design_revision: 'design-rev-001', blueprint_sha256: state.blueprintSha256,
      review_manifest_sha256: state.designManifestSha256, recorded_at: '2026-08-27T10:01:00.000Z',
    }
    await expect(verifyDesignGate(designGateInput(state))).resolves.toMatchObject({ valid: true, status: 'continuous_authorized' })

    state.designApproval.review_manifest_sha256 = '0'.repeat(64)
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'approval.reviewManifestSha256')
  })

  it('does not treat an unknown handoff version as a legacy authorization carrier', async () => {
    const state = workflowFixture()
    state.handoff = { ...legacyHandoff('assumed_for_fast_run'), handoff_version: 999 }
    state.designApproval = {
      version: 1, gate: 'design', mode: 'continuous_authorized', scope: 'current_task',
      design_revision: 'design-rev-001', blueprint_sha256: state.blueprintSha256,
      review_manifest_sha256: state.designManifestSha256, recorded_at: '2026-08-27T10:01:00.000Z',
    }
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'APPROVAL_REQUIRED', 'handoff.version')
  })

  it('rejects malformed legacy v1 before applying a continuous authorization record', async () => {
    const state = workflowFixture()
    state.handoff = { handoff_version: 1, status: 'assumed_for_fast_run' }
    state.designApproval = {
      version: 1, gate: 'design', mode: 'continuous_authorized', scope: 'current_task',
      design_revision: 'design-rev-001', blueprint_sha256: state.blueprintSha256,
      review_manifest_sha256: state.designManifestSha256, recorded_at: '2026-08-27T10:01:00.000Z',
    }
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'APPROVAL_REQUIRED', 'handoff')
  })

  it('rejects validated legacy blockers before continuous authorization', async () => {
    const state = workflowFixture()
    state.handoff = legacyHandoff('assumed_for_fast_run')
    state.handoff.blockers = ['Supplier capability unresolved.']
    state.designApproval = {
      version: 1, gate: 'design', mode: 'continuous_authorized', scope: 'current_task',
      design_revision: 'design-rev-001', blueprint_sha256: state.blueprintSha256,
      review_manifest_sha256: state.designManifestSha256, recorded_at: '2026-08-27T10:01:00.000Z',
    }
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'HANDOFF_BLOCKED', 'handoff.blockers')
  })

  it.each([
    ['area id', (state: any) => { state.handoff.areas.push(structuredClone(state.handoff.areas[0])) }],
    ['blueprint area id', (state: any) => {
      const duplicate = structuredClone(state.handoff.areas[0]); duplicate.id = 'other'; state.handoff.areas.push(duplicate)
    }],
    ['asset id', (state: any) => {
      state.handoff.assets = [
        { id: 'logo', path: 'logo-a.png', sha256: '7'.repeat(64) },
        { id: 'logo', path: 'logo-b.png', sha256: '8'.repeat(64) },
      ]
    }],
  ])('semantically validates unique %s before representing an awaiting v2 state', async (_label, mutate) => {
    const state = workflowFixture(); state.handoff.status = 'awaiting_user_approval'; mutate(state)
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'APPROVAL_REQUIRED', 'handoff')
  })

  it('maps unrepresentable editable layers to the stable workflow error contract', () => {
    const value = blueprint()
    value.areas[0].layers = [{
      id: 'gradient', kind: 'gradient', boundsMm: { x: 0, y: 0, width: 40, height: 60 },
      anchor: 'center', rotation: 0, opacity: 1, visible: true, zIndex: 0, processes: [],
    } as any]
    expect(() => compileBlueprintToSpecAreas(value)).toThrowError(expect.objectContaining({
      name: 'BlueprintCompilerError', code: 'UNREPRESENTABLE_LAYER',
    }))
    try { compileBlueprintToSpecAreas(value) } catch (error) {
      expect(error).toBeInstanceOf(WorkflowGateError)
      expect(error).toBeInstanceOf(BlueprintCompilerError)
    }
  })
})

describe('production approval gate', () => {
  it('accepts exact current input, model, target, blueprint, design-review, and production-review bindings', async () => {
    const state = workflowFixture()
    await expect(verifyProductionGate(productionGateInput(state))).resolves.toMatchObject({
      valid: true, status: 'approved', inputRevision: revisionOf(state.document),
      modelFingerprint: state.modelFingerprint, areaTargetsSha256: areaTargetsSha256(state.document),
      productionReviewManifestSha256: state.productionManifestSha256,
    })
  })

  it('recomputes shared production manifest completeness instead of trusting an approval digest', async () => {
    const state = workflowFixture()
    state.productionManifest.artifacts = state.productionManifest.artifacts
      .filter((artifact: any) => artifact.viewKind !== 'model-front')
    state.productionApproval.review_manifest_sha256 = sha256(JSON.stringify(state.productionManifest))
    await expectWorkflowCode(
      verifyProductionGate(productionGateInput(state)),
      'DIGEST_MISMATCH',
      'productionReviewManifest',
    )
  })

  it('accepts a canonical Project v3 with the same exact production bindings', async () => {
    const state = workflowFixture()
    state.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    state.productionManifest = productionManifest(state)
    state.productionManifest.input.kind = 'label-project-v3'
    state.productionApproval.spec_revision = revisionOf(state.document)
    state.productionApproval.area_targets_sha256 = areaTargetsSha256(state.document)
    state.productionApproval.review_manifest_sha256 = sha256(JSON.stringify(state.productionManifest))

    await expect(verifyProductionGate(productionGateInput(state))).resolves.toMatchObject({
      valid: true, inputRevision: revisionOf(state.document), areaTargetsSha256: areaTargetsSha256(state.document),
    })
  })

  it.each([
    ['input revision', (state: any) => { state.productionManifest.input.revision = `sha256:${'0'.repeat(64)}` }, 'reviewManifest.input'],
    ['input digest', (state: any) => { state.productionManifest.input.sha256 = '0'.repeat(64) }, 'reviewManifest.input'],
    ['model fingerprint', (state: any) => { state.modelFingerprint = 'model-fingerprint-002' }, 'reviewManifest.model'],
    ['area target digest', (state: any) => { state.productionApproval.area_targets_sha256 = '0'.repeat(64) }, 'approval.areaTargetsSha256'],
    ['blueprint binding', (state: any) => { state.productionManifest.blueprint.sha256 = '0'.repeat(64) }, 'reviewManifest.blueprint'],
    ['design review binding', (state: any) => { state.productionManifest.designReviewManifest.sha256 = '0'.repeat(64) }, 'reviewManifest.designReviewManifest'],
    ['production review digest', (state: any) => { state.productionApproval.review_manifest_sha256 = '0'.repeat(64) }, 'approval.reviewManifestSha256'],
    ['production area binding', (state: any) => {
      state.productionManifest.areas[0].carrier = 'applied_label'
      state.productionManifest.artifacts
        .filter((artifact: any) => artifact.areaId === 'front')
        .forEach((artifact: any) => { artifact.carrier = 'applied_label' })
    }, 'reviewManifest.areas'],
  ])('fails closed for a stale %s', async (_label, mutate, field) => {
    const state = workflowFixture(); mutate(state)
    await expectWorkflowCode(verifyProductionGate(productionGateInput(state)), 'STALE_APPROVAL', field)
  })

  it('fails closed when the production manifest target digest is stale', async () => {
    const state = workflowFixture()
    state.productionManifest.areaTargetsSha256 = '0'.repeat(64)
    state.productionApproval.review_manifest_sha256 = sha256(JSON.stringify(state.productionManifest))
    await expectWorkflowCode(
      verifyProductionGate(productionGateInput(state)),
      'STALE_APPROVAL',
      'reviewManifest.areaTargetsSha256',
    )
  })

  it('recomputes mutable current input between QC and apply/export without caching', async () => {
    const state = workflowFixture()
    const input = productionGateInput(state)
    await expect(verifyProductionGate(input)).resolves.toMatchObject({ valid: true })

    state.document.areas[0].range.uStart = 0.25
    await expectWorkflowCode(verifyProductionGate(input), 'STALE_APPROVAL', 'reviewManifest.input')
  })

  it('rejects evidence that changes between the internal design and production checks', async () => {
    const first = workflowFixture()
    const second = workflowFixture()
    second.document.areas[0].range.uStart = 0.25
    second.productionManifest = productionManifest(second)
    second.productionApproval.spec_revision = revisionOf(second.document)
    second.productionApproval.area_targets_sha256 = areaTargetsSha256(second.document)
    second.productionApproval.review_manifest_sha256 = sha256(JSON.stringify(second.productionManifest))

    await expectWorkflowCode(verifyProductionGate({
      handoff: first.handoff,
      blueprint: alternatingSource(first.blueprint, second.blueprint),
      designReviewManifest: alternatingSource(first.designManifest, second.designManifest),
      currentDocument: alternatingSource(first.document, second.document),
      approvalRecord: second.productionApproval,
      productionReviewManifest: source(() => second.productionManifest),
      modelFingerprint: second.modelFingerprint,
    }), 'STALE_APPROVAL', 'designGate.evidence')
  })

  it('does not let production-only continuous authorization create design authorization', async () => {
    const state = workflowFixture()
    state.productionApproval.mode = 'continuous_authorized'
    await expectWorkflowCode(verifyProductionGate(productionGateInput(state)), 'APPROVAL_REQUIRED', 'approval.mode')
  })

  it('lets current-task continuous authorization remove only the production wait', async () => {
    const state = workflowFixture()
    state.handoff.status = 'continuous_authorized'; state.handoff.approval.mode = 'continuous_authorized'
    state.productionApproval.mode = 'continuous_authorized'
    await expect(verifyProductionGate(productionGateInput(state))).resolves.toMatchObject({
      valid: true, status: 'continuous_authorized', productionReviewManifestSha256: state.productionManifestSha256,
    })
  })

  it('derives order-independent area-target digests and rejects duplicate area identity', async () => {
    const state = workflowFixture()
    const second = structuredClone(state.document.areas[0])
    second.id = 'back'; second.name = 'Back'; second.blueprintAreaId = 'back'; second.target = { meshIndex: 1, nodeName: 'BackMesh' }
    const forward = { ...state.document, areas: [state.document.areas[0], second] }
    const reversed = { ...state.document, areas: [second, state.document.areas[0]] }
    await expect(computeAreaTargetsSha256(forward)).resolves.toBe(await computeAreaTargetsSha256(reversed))

    const duplicate = { ...state.document, areas: [state.document.areas[0], structuredClone(state.document.areas[0])] }
    await expectWorkflowCode(computeAreaTargetsSha256(duplicate), 'APPROVAL_REQUIRED', 'currentDocument.areas')
  })

  it.each([
    ['canvas', (area: any) => { area.canvas.width += 1 }],
    ['axis minimum', (area: any) => { area.axisMin = -2 }],
    ['axis maximum', (area: any) => { area.axisMax = 2 }],
  ])('binds Project v3 %s into the production area-target digest', async (_label, mutate) => {
    const state = workflowFixture()
    const project = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    const before = await computeAreaTargetsSha256(project)
    mutate(project.areas[0])
    await expect(computeAreaTargetsSha256(project)).resolves.not.toBe(before)
  })
})

function snapshot(): WorkflowRevisionSnapshot {
  const state = workflowFixture()
  return {
    blueprint: state.blueprint,
    designReviewManifest: state.designManifest,
    document: state.document,
    modelFingerprint: state.modelFingerprint,
    productionReviewManifest: state.productionManifest,
    productionAssets: [
      { id: 'surface-front', sha256: '6'.repeat(64) },
      { id: 'label-front', sha256: '5'.repeat(64) },
    ],
  }
}

function classification(current: WorkflowRevisionSnapshot, approved = snapshot()) {
  return classifyRevisionChange({ approved, current })
}

describe('revision classification', () => {
  it.each([
    ['copy', (value: WorkflowRevisionSnapshot) => { value.blueprint.areas[0].layers[0].text = 'CHANGED' }, 'design:copy'],
    ['hierarchy/order', (value: WorkflowRevisionSnapshot) => {
      const firstZ = value.blueprint.areas[0].layers[0].zIndex
      value.blueprint.areas[0].layers[0].zIndex = value.blueprint.areas[0].layers[1].zIndex
      value.blueprint.areas[0].layers[1].zIndex = firstZ
    }, 'design:hierarchy'],
    ['visibility', (value: WorkflowRevisionSnapshot) => { value.blueprint.areas[0].layers[0].visible = false }, 'design:hierarchy'],
    ['physical layout', (value: WorkflowRevisionSnapshot) => { value.blueprint.areas[0].layers[0].boundsMm!.x = 5 }, 'design:layout'],
    ['color', (value: WorkflowRevisionSnapshot) => { value.blueprint.areas[0].layers[0].color = '#ffffff' }, 'design:color'],
    ['typography', (value: WorkflowRevisionSnapshot) => { value.blueprint.areas[0].layers[0].fontSizeMm = 5 }, 'design:typography'],
    ['carrier', (value: WorkflowRevisionSnapshot) => {
      value.blueprint.areas[0].carrier = 'foil_or_ink_only'; value.blueprint.carrierDefaults.carrier = 'foil_or_ink_only'
    }, 'design:carrier'],
    ['process', (value: WorkflowRevisionSnapshot) => { value.blueprint.areas[0].layers[0].processes = [{ process: 'pad_print' }] }, 'design:process'],
    ['editable asset', (value: WorkflowRevisionSnapshot) => {
      value.blueprint.assets.push({
        id: 'approved-art', path: 'assets/approved-art.png', sha256: '8'.repeat(64), mimeType: 'image/png', width: 100, height: 100,
      })
    }, 'design:assets'],
  ])('classifies %s changes as design invalidation', (_label, mutate, reason) => {
    const current = snapshot(); mutate(current)
    expect(classification(current)).toMatchObject({ valid: false, invalidates: 'design', reasons: expect.arrayContaining([reason]) })
  })

  it('does not classify equal-z array storage order when runtime and review both tie-break by id', () => {
    const state = workflowFixture()
    const approved = snapshot()
    approved.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    ;(approved.document as any).areas[0].layers.forEach((layer: any) => { layer.zIndex = 0 })
    const current = structuredClone(approved)
    ;(current.document as any).areas[0].layers.reverse()

    expect(classification(current, approved)).toEqual({ valid: true, invalidates: 'none' })
  })

  it.each([
    ['side', (layer: any, area: any) => { area.side = 'wrap' }],
    ['stroke width', (layer: any) => { layer.strokeWidthMm = 0.8 }],
    ['corner radius', (layer: any) => { layer.cornerRadiusMm = 3 }],
    ['fill rule', (layer: any) => { layer.fillRule = 'evenodd' }],
  ])('classifies same-revision blueprint %s changes from canonical content', (_label, mutate) => {
    const approved = snapshot()
    approved.blueprint.areas[0].layers.push({
      id: 'frame', kind: 'shape', boundsMm: { x: 2, y: 2, width: 36, height: 56 },
      anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 2, processes: [],
      shape: 'path', pathData: 'M0 0H1V1H0Z', pathViewBox: [0, 0, 1, 1], fillRule: 'nonzero',
      fill: 'transparent', stroke: '#111111', strokeWidthMm: 0.2, cornerRadiusMm: 0,
    })
    const current = structuredClone(approved)
    mutate(current.blueprint.areas[0].layers[2], current.blueprint.areas[0])

    expect(classification(current, approved)).toMatchObject({
      valid: false, invalidates: 'design', reasons: expect.arrayContaining(['design:layout']),
    })
  })

  it.each([
    ['copy', (area: any) => { area.layers[0].text = 'CURRENT DOCUMENT CHANGED' }],
    ['physical layout', (area: any) => { area.layers[0].designMetrics.boundsMm.x = 7 }],
    ['process intent', (area: any) => { area.layers[0].processes = [{ process: 'pad_print' }] }],
  ])('classifies current-document %s changes as design invalidation', (_label, mutate) => {
    const current = snapshot(); mutate((current.document as any).areas[0])
    expect(classification(current)).toEqual({ valid: false, invalidates: 'design', reasons: ['design:document'] })
  })

  it('classifies forged raw Project proxies even when physical metadata resolves to approved values', () => {
    const state = workflowFixture()
    const approved = snapshot()
    approved.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    const current = structuredClone(approved)
    Object.assign((current.document as any).areas[0].layers[0], {
      x: 999, y: 888, width: 666, fontSize: 777, letterSpacing: 555, lineHeight: 4,
    })

    expect(classification(current, approved)).toEqual({
      valid: false, invalidates: 'design', reasons: ['design:document'],
    })
  })

  it.each([
    ['target selector', (value: WorkflowRevisionSnapshot) => { (value.document as any).areas[0].target.stableSelector = 'mesh:1/node:2' }, 'production:area-targets'],
    ['UV range', (value: WorkflowRevisionSnapshot) => { (value.document as any).areas[0].range.uStart = 0.2 }, 'production:area-targets'],
    ['remap orientation', (value: WorkflowRevisionSnapshot) => { (value.document as any).areas[0].remap.mirrorU = true }, 'production:area-targets'],
    ['scale-to-surface', (value: WorkflowRevisionSnapshot) => { (value.document as any).areas[0].placementPolicy = 'block' }, 'production:area-targets'],
    ['model fingerprint', (value: WorkflowRevisionSnapshot) => { value.modelFingerprint = 'model-fingerprint-002' }, 'production:model-fingerprint'],
    ['capture asset', (value: WorkflowRevisionSnapshot) => { value.productionAssets![0].sha256 = '7'.repeat(64) }, 'production:capture-assets'],
    ['review manifest', (value: WorkflowRevisionSnapshot) => { value.productionReviewManifest!.artifacts[0].sha256 = '7'.repeat(64) }, 'production:review-manifest'],
  ])('classifies %s changes as production invalidation', (_label, mutate, reason) => {
    const current = snapshot(); mutate(current)
    expect(classification(current)).toEqual({ valid: false, invalidates: 'production', reasons: [reason] })
  })

  it.each([
    ['mesh target', (area: any) => { area.meshIndex = 3 }],
    ['range', (area: any) => { area.range.uStart = 0.2 }],
    ['translation', (area: any) => { area.remap.origin[0] = 0.5 }],
    ['orientation', (area: any) => { area.remap.axis = [1, 0, 0] }],
    ['scale', (area: any) => { area.remap.radius = 1.25 }],
    ['axis minimum', (area: any) => { area.axisMin = -2 }],
    ['axis maximum', (area: any) => { area.axisMax = 2 }],
  ])('classifies Project v3 %s changes as production mapping invalidation', (_label, mutate) => {
    const approved = snapshot()
    const state = workflowFixture()
    approved.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    const current = structuredClone(approved); mutate((current.document as any).areas[0])
    expect(classification(current, approved)).toEqual({
      valid: false, invalidates: 'production', reasons: ['production:area-targets'],
    })
  })

  it('gives stale raw Project pixels design precedence when canvas mapping changes without rescaling them', () => {
    const approved = snapshot()
    const state = workflowFixture()
    approved.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    const current = structuredClone(approved)
    ;(current.document as any).areas[0].canvas.width += 1

    expect(classification(current, approved)).toEqual({
      valid: false, invalidates: 'design', reasons: ['design:document', 'production:area-targets'],
    })
  })

  it('gives a current Project design change precedence over a simultaneous axis mapping change', () => {
    const approved = snapshot()
    const state = workflowFixture()
    approved.document = projectDocument(state.blueprint, state.blueprintSha256, state.designManifestSha256)
    const current = structuredClone(approved)
    ;(current.document as any).areas[0].layers[0].text = 'UNAPPROVED'
    ;(current.document as any).areas[0].axisMax = 2
    expect(classification(current, approved)).toEqual({
      valid: false, invalidates: 'design', reasons: ['design:document', 'production:area-targets'],
    })
  })

  it('gives design invalidation precedence while returning sorted, deduplicated reasons', () => {
    const current = snapshot()
    current.blueprint.areas[0].layers[0].text = 'CHANGED'
    current.blueprint.areas[0].layers[1].text = 'ALSO CHANGED'
    ;(current.document as any).areas[0].range.uStart = 0.2
    current.modelFingerprint = 'model-fingerprint-002'

    expect(classification(current)).toEqual({
      valid: false, invalidates: 'design',
      reasons: ['design:copy', 'production:area-targets', 'production:model-fingerprint'],
    })
  })

  it('canonicalizes area-target and production-asset ordering', () => {
    const approved = snapshot()
    const second = structuredClone((approved.document as any).areas[0])
    second.id = 'back'; second.name = 'Back'; second.blueprintAreaId = 'back'; second.target = { nodeName: 'BackMesh', meshIndex: 1 }
    ;(approved.document as any).areas.push(second)
    const current = structuredClone(approved)
    ;(current.document as any).areas.reverse()
    current.productionAssets!.reverse()
    expect(classification(current, approved)).toEqual({ valid: true, invalidates: 'none' })
  })

  it('returns valid when no design or production facts changed', () => {
    expect(classification(snapshot())).toEqual({ valid: true, invalidates: 'none' })
  })

  it('fails an unrepresentable document closed without escaping the classifier union', () => {
    const current = snapshot()
    current.document = { version: 999, areas: [] }

    expect(classification(current)).toEqual({
      valid: false, invalidates: 'design', reasons: ['design:document', 'production:area-targets'],
    })
  })
})
