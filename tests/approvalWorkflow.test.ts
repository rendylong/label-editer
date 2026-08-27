import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BlueprintCompilerError, compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
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

function designManifest(blueprintSha256: string): DesignReviewManifestV1 {
  return {
    version: 1, createdAt: '2026-08-27T10:00:00.000Z',
    blueprint: { revision: 'design-rev-001', sha256: blueprintSha256 },
    html: { sha256: '1'.repeat(64) }, references: [],
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
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

function labelDocument(blueprintSha256: string, designManifestSha256: string): any {
  return {
    version: 2,
    areas: [{
      id: 'front', name: 'Front', target: { stableSelector: 'mesh:0/node:1' }, surfaceMode: 'overlay', side: 'front',
      range: { uStart: 0.1, uWidth: 0.3, vStart: 0.2, vHeight: 0.5 },
      remap: { mode: 'cylindrical', wrap: 1, offset: 0, mirrorU: false },
      carrier: 'direct_surface_print', artboard: { widthMm: 40, heightMm: 60, background: 'transparent' },
      placementPolicy: 'fit', blueprintAreaId: 'front',
      designBinding: {
        blueprintRevision: 'design-rev-001', blueprintSha256, reviewManifestSha256: designManifestSha256,
      },
      layers: [],
    }],
  }
}

function projectDocument(blueprintSha256: string, designManifestSha256: string): any {
  return {
    version: 3, modelFileName: 'bottle.glb',
    areas: [{
      id: 'front', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', side: 'front',
      remap: {
        mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
        mirrorU: false, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
      range: { uStart: 0.1, uWidth: 0.3, vStart: 0.2, vHeight: 0.5 },
      canvas: { width: 1024, height: 1536, aspect: 2 / 3 },
      paper: { enabled: false, color: '#ffffff', opacity: 0 }, carrier: 'direct_surface_print',
      artboard: { widthMm: 40, heightMm: 60, background: 'transparent' }, placementPolicy: 'fit',
      blueprintAreaId: 'front', designBinding: {
        blueprintRevision: 'design-rev-001', blueprintSha256, reviewManifestSha256: designManifestSha256,
      },
      layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
    }],
  }
}

function handoff(blueprintSha256: string, designManifestSha256: string): EditorHandoffV2 {
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
      id: 'front', side: 'front', carrier: 'direct_surface_print', placement: 'Centered front.',
      physical_size_mm: { width: 40, height: 60 }, blueprint_area_id: 'front',
    }],
    assets: [], production_constraints: {}, assumptions: [], blockers: [],
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
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'label-front', path: 'label-front.png', sha256: '5'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1600, viewKind: 'flat-artwork', areaId: 'front', carrier: 'direct_surface_print',
    }, {
      id: 'surface-front', path: 'surface-front.png', sha256: '6'.repeat(64), mimeType: 'image/png',
      width: 1600, height: 1600, viewKind: 'surface-face', areaId: 'front', carrier: 'direct_surface_print',
    }],
  }
}

function workflowFixture() {
  const state: any = { blueprint: blueprint(), modelFingerprint: 'model-fingerprint-001' }
  state.blueprintSha256 = sha256(JSON.stringify(state.blueprint))
  state.designManifest = designManifest(state.blueprintSha256)
  state.designManifestSha256 = sha256(JSON.stringify(state.designManifest))
  state.document = labelDocument(state.blueprintSha256, state.designManifestSha256)
  state.handoff = handoff(state.blueprintSha256, state.designManifestSha256)
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

  it('represents awaiting and rejected states deterministically without claiming approval', async () => {
    const awaiting = workflowFixture(); awaiting.handoff.status = 'awaiting_user_approval'
    await expectWorkflowCode(verifyDesignGate(designGateInput(awaiting)), 'AWAITING_USER_APPROVAL')

    const rejected = workflowFixture(); rejected.handoff = { handoff_version: 1, status: 'rejected' }
    await expectWorkflowCode(verifyDesignGate(designGateInput(rejected)), 'AWAITING_USER_APPROVAL')
  })

  it('blocks non-empty blocker lists with bounded workflow details', async () => {
    const state = workflowFixture()
    state.handoff.blockers = ['x'.repeat(5000)]
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

  it('normalizes legacy approved and assumed-fast-run handoffs to an awaiting state', async () => {
    const approved = workflowFixture(); approved.handoff = { handoff_version: 1, status: 'approved' }
    await expectWorkflowCode(verifyDesignGate(designGateInput(approved)), 'APPROVAL_REQUIRED', 'handoff.version')

    const assumed = workflowFixture(); assumed.handoff = { handoff_version: 1, status: 'assumed_for_fast_run' }
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
    state.handoff = { handoff_version: 1, status: 'assumed_for_fast_run' }
    state.designApproval = {
      version: 1, gate: 'design', mode: 'continuous_authorized', scope: 'current_task',
      design_revision: 'design-rev-001', blueprint_sha256: state.blueprintSha256,
      review_manifest_sha256: state.designManifestSha256, recorded_at: '2026-08-27T10:01:00.000Z',
    }
    await expect(verifyDesignGate(designGateInput(state))).resolves.toMatchObject({ valid: true, status: 'continuous_authorized' })

    state.designApproval.review_manifest_sha256 = '0'.repeat(64)
    await expectWorkflowCode(verifyDesignGate(designGateInput(state)), 'STALE_APPROVAL', 'approval.reviewManifestSha256')
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

  it('accepts a canonical Project v3 with the same exact production bindings', async () => {
    const state = workflowFixture()
    state.document = projectDocument(state.blueprintSha256, state.designManifestSha256)
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
      state.productionManifest.artifacts.forEach((artifact: any) => { artifact.carrier = 'applied_label' })
    }, 'reviewManifest.areas'],
  ])('fails closed for a stale %s', async (_label, mutate, field) => {
    const state = workflowFixture(); mutate(state)
    await expectWorkflowCode(verifyProductionGate(productionGateInput(state)), 'STALE_APPROVAL', field)
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
    ['hierarchy/order', (value: WorkflowRevisionSnapshot) => { value.blueprint.areas[0].layers.reverse() }, 'design:hierarchy'],
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
})
