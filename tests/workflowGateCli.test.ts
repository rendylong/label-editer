import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
import { computeAreaTargetsSha256, type LayoutBlueprintV1 } from '../src/agent/designContracts'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import { serializeLabelProject } from '../src/app/projectSchema'
// @ts-expect-error executable Node ESM CLI
import { runCli } from '../scripts/label-cli.mjs'
// @ts-expect-error canonical CLI revision helper
import { revisionOf } from '../scripts/lib/project-control.mjs'
import { pngBytes } from './pngTestUtils'

const roots: string[] = []
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const camera = { position: [0, 0, 3], direction: [0, 0, -1], target: [0, 0, 0], up: [0, 1, 0], fov: 45 }

async function writeJson(filePath: string, value: unknown): Promise<string> {
  const text = JSON.stringify(value)
  await writeFile(filePath, text)
  return text
}

async function gateFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'workflow-gate-cli-'))
  roots.push(root)
  const evidence = path.join(root, 'evidence')
  const designRoot = path.join(evidence, 'design-review')
  const productionRoot = path.join(evidence, 'production-review')
  await mkdir(path.join(designRoot, 'areas'), { recursive: true })
  await mkdir(productionRoot, { recursive: true })
  const blueprint: LayoutBlueprintV1 = {
    version: 1, revision: 'gate-design-v1', carrierDefaults: { carrier: 'direct_surface_print' }, assets: [],
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      artboard: { widthMm: 40, heightMm: 60, background: 'transparent' },
      placementIntent: 'Centered front.', placementPolicy: 'fit',
      layers: [{
        id: 'mark', kind: 'shape', boundsMm: { x: 4, y: 4, width: 32, height: 52 }, anchor: 'top_left',
        rotation: 0, opacity: 1, visible: true, zIndex: 0, processes: [{ process: 'screen_print' }],
        shape: 'rectangle', fill: '#111111', stroke: '#111111', strokeWidthMm: 0, cornerRadiusMm: 0,
      }],
    }],
  }
  const blueprintText = await writeJson(path.join(evidence, 'layout-blueprint.json'), blueprint)
  const blueprintSha = sha256(blueprintText)
  const html = '<!doctype html><html><body><section style="width:1600px;height:1200px"></section></body></html>'
  const designFiles = new Map<string, string | Uint8Array>([
    ['mockup.html', html], ['mockup-front.png', pngBytes(1600, 1200)],
    ['mockup-back.png', pngBytes(1600, 1200)], ['areas/front.png', pngBytes(800, 1200)],
  ])
  for (const [relative, bytes] of designFiles) await writeFile(path.join(designRoot, ...relative.split('/')), bytes)
  const designManifest = {
    version: 1, createdAt: '2026-08-29T00:00:00.000Z',
    blueprint: { revision: blueprint.revision, sha256: blueprintSha }, html: { sha256: sha256(html) }, references: [],
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [
      { id: 'mockup-html', path: 'mockup.html', sha256: sha256(html), mimeType: 'text/html', width: 1600, height: 1200, viewKind: 'mockup-html' },
      { id: 'mockup-front', path: 'mockup-front.png', sha256: sha256(designFiles.get('mockup-front.png')!), mimeType: 'image/png', width: 1600, height: 1200, viewKind: 'mockup-front' },
      { id: 'mockup-back', path: 'mockup-back.png', sha256: sha256(designFiles.get('mockup-back.png')!), mimeType: 'image/png', width: 1600, height: 1200, viewKind: 'mockup-back' },
      { id: 'mockup-area-front', path: 'areas/front.png', sha256: sha256(designFiles.get('areas/front.png')!), mimeType: 'image/png', width: 800, height: 1200, viewKind: 'mockup-area', areaId: 'front', carrier: 'direct_surface_print' },
    ],
  }
  const designManifestText = await writeJson(path.join(designRoot, 'design-review-manifest.json'), designManifest)
  const designManifestSha = sha256(designManifestText)
  const [compiled] = compileBlueprintToSpecAreas(blueprint, [{
    blueprintAreaId: 'front', name: 'Front', target: { stableSelector: 'mesh:0/node:0' }, surfaceMode: 'overlay',
    range: { uStart: 0.1, uWidth: 0.3, vStart: 0.2, vHeight: 0.5 },
    remap: { mode: 'cylindrical', wrap: 1, offset: 0, mirrorU: false },
  }])
  compiled.designBinding = { blueprintRevision: blueprint.revision, blueprintSha256: blueprintSha, reviewManifestSha256: designManifestSha }
  const document = { version: 2, areas: [compiled] }
  const documentText = await writeJson(path.join(evidence, 'working.json'), document)
  const shell: any = {
    id: 'front', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', side: 'front',
    remap: { mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, mirrorU: false, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] } },
    range: structuredClone(compiled.range), canvas: { width: 800, height: 1200, aspect: 2 / 3 },
    paper: { enabled: false, color: '#ffffff', opacity: 0 }, layers: [], globalCraft: { craft: [] }, fonts: [],
    referenceVisible: false, undoStack: [], redoStack: [],
  }
  const resolvedProject = serializeLabelProject('model.glb', applyStructuredLabelSpec(shell, { version: 2, areas: [compiled] }).areas)
  const resolvedProjectText = await writeJson(path.join(productionRoot, 'resolved-project.lbl.json'), resolvedProject)
  const handoff = {
    handoff_version: 2, status: 'approved',
    source: {
      design_spec: 'design.md', mockup_html: 'design-review/mockup.html', blueprint: 'layout-blueprint.json',
      design_review_manifest: 'design-review/design-review-manifest.json', blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha, review_manifest_sha256: designManifestSha,
    },
    approval: {
      mode: 'explicit_approval', scope: 'current_task', blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha, review_manifest_sha256: designManifestSha,
    },
    model: { package_type: 'bottle' },
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print', placement: 'Centered front.', physical_size_mm: { width: 40, height: 60 }, blueprint_area_id: 'front' }],
    assets: [], production_constraints: {}, assumptions: [], blockers: [],
  }
  await writeJson(path.join(evidence, 'editor-handoff.json'), handoff)
  const model = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4])
  await writeFile(path.join(evidence, 'model.glb'), model)
  const productionFiles = new Map<string, Uint8Array>([
    ['label-front.png', pngBytes(1600, 1600)], ['surface-front.png', pngBytes(1600, 1600)],
    ['model-front.png', pngBytes(1600, 1600)], ['model-back.png', pngBytes(1600, 1600)],
    ['review-sheet.png', pngBytes(1600, 1600)],
  ])
  for (const [relative, bytes] of productionFiles) await writeFile(path.join(productionRoot, relative), bytes)
  const areaTargetsSha256 = await computeAreaTargetsSha256(document)
  const productionManifest = {
    version: 1, createdAt: '2026-08-29T00:01:00.000Z',
    input: { kind: 'label-spec-v2', revision: revisionOf(document), sha256: sha256(documentText) },
    resolvedProject: {
      path: 'resolved-project.lbl.json', revision: revisionOf(resolvedProject), sha256: sha256(resolvedProjectText),
      areaTargetsSha256: await computeAreaTargetsSha256(resolvedProject),
    },
    blueprint: { revision: blueprint.revision, sha256: blueprintSha }, designReviewManifest: { sha256: designManifestSha },
    model: { fingerprint: sha256(model) }, areaTargetsSha256,
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [
      { id: 'label-front', path: 'label-front.png', sha256: sha256(productionFiles.get('label-front.png')!), mimeType: 'image/png', width: 1600, height: 1600, viewKind: 'flat-artwork', areaId: 'front', carrier: 'direct_surface_print' },
      { id: 'surface-front', path: 'surface-front.png', sha256: sha256(productionFiles.get('surface-front.png')!), mimeType: 'image/png', width: 1600, height: 1600, viewKind: 'surface-face', areaId: 'front', carrier: 'direct_surface_print', camera },
      { id: 'model-front', path: 'model-front.png', sha256: sha256(productionFiles.get('model-front.png')!), mimeType: 'image/png', width: 1600, height: 1600, viewKind: 'model-front', camera },
      { id: 'model-back', path: 'model-back.png', sha256: sha256(productionFiles.get('model-back.png')!), mimeType: 'image/png', width: 1600, height: 1600, viewKind: 'model-back', camera: { ...camera, position: [0, 0, -3], direction: [0, 0, 1] } },
      { id: 'review-sheet', path: 'review-sheet.png', sha256: sha256(productionFiles.get('review-sheet.png')!), mimeType: 'image/png', width: 1600, height: 1600, viewKind: 'review-sheet' },
    ],
  }
  const productionManifestText = await writeJson(path.join(productionRoot, 'review-manifest.json'), productionManifest)
  const approval = {
    version: 1, gate: 'production', mode: 'explicit_approval', scope: 'current_task', design_revision: blueprint.revision,
    blueprint_sha256: blueprintSha, review_manifest_sha256: sha256(productionManifestText), spec_revision: revisionOf(document),
    model_fingerprint: sha256(model), area_targets_sha256: areaTargetsSha256, recorded_at: '2026-08-29T00:02:00.000Z',
  }
  await writeJson(path.join(evidence, 'production-approval.json'), approval)
  const designRequest = {
    version: 1, gate: 'design', evidenceRoot: 'evidence', currentDocument: 'working.json', handoff: 'editor-handoff.json',
    blueprint: 'layout-blueprint.json', designReviewManifest: 'design-review/design-review-manifest.json', designReviewEvidenceRoot: 'design-review',
  }
  const productionRequest = {
    ...designRequest, gate: 'production', productionReviewManifest: 'production-review/review-manifest.json',
    productionReviewEvidenceRoot: 'production-review', productionApprovalRecord: 'production-approval.json', model: 'model.glb',
  }
  const designRequestPath = path.join(root, 'design-gate.json')
  const productionRequestPath = path.join(root, 'production-gate.json')
  await writeJson(designRequestPath, designRequest)
  await writeJson(productionRequestPath, productionRequest)
  return { root, evidence, designRequestPath, productionRequestPath, document, documentText, productionFiles }
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('installed workflow gate CLI contract', () => {
  it('accepts exact Spec v2 evidence and fails stale input or missing approved bytes', async () => {
    const fixture = await gateFixture()
    const output: string[] = []
    expect(await runCli(['gate', 'design', fixture.designRequestPath, '--json'], { stdout: (value: string) => output.push(value), stderr: () => undefined })).toBe(0)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: true, operation: 'gate_design', data: { valid: true, documentKind: 'label-spec-v2' } })
    expect(await runCli(['gate', 'production', fixture.productionRequestPath, '--json'], { stdout: (value: string) => output.push(value), stderr: () => undefined })).toBe(0)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: true, operation: 'gate_production', data: { valid: true } })

    fixture.document.areas[0].target.stableSelector = 'mesh:0/node:mutated'
    await writeJson(path.join(fixture.evidence, 'working.json'), fixture.document)
    expect(await runCli(['gate', 'production', fixture.productionRequestPath, '--json'], { stdout: (value: string) => output.push(value), stderr: () => undefined })).not.toBe(0)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: false, error: { code: 'STALE_APPROVAL' } })

    await writeFile(path.join(fixture.evidence, 'working.json'), fixture.documentText)
    await rm(path.join(fixture.evidence, 'production-review', 'label-front.png'))
    expect(await runCli(['gate', 'production', fixture.productionRequestPath, '--json'], { stdout: (value: string) => output.push(value), stderr: () => undefined })).not.toBe(0)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: false })

    await writeFile(path.join(fixture.evidence, 'production-review', 'label-front.png'), fixture.productionFiles.get('label-front.png')!)
    await rm(path.join(fixture.evidence, 'production-review', 'surface-front.png'))
    await symlink('label-front.png', path.join(fixture.evidence, 'production-review', 'surface-front.png'))
    expect(await runCli(['gate', 'production', fixture.productionRequestPath, '--json'], { stdout: (value: string) => output.push(value), stderr: () => undefined })).not.toBe(0)
    expect(JSON.parse(output.pop()!)).toMatchObject({ ok: false, error: { code: 'PATH_NOT_ALLOWED' } })
  })

})
