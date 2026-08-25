# Label QC Multi-View Capture and Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic multi-view `label-cli qc` evidence command and make `cosmetic-label-editor` require evidence-backed inspection, repair, and recheck before delivery.

**Architecture:** A pure capture planner defines the required whole-model, per-area, craft, and custom views. `SceneController` resolves model/area geometry into deterministic camera poses and returns PNG plus camera metadata; the guarded browser bridge captures the batch once the current design is ready. The Node CLI publishes the images and a revision-bound manifest atomically, while the Skill owns the visual verdict and a maximum-three-repair loop.

**Tech Stack:** TypeScript 5.9, React 19, Three.js 0.185, Zustand, Node.js 22 ESM, Playwright 1.62, Vitest 3.2, AJV 8.

**Spec:** `docs/superpowers/specs/2026-08-25-label-qc-multi-view-design.md`

## Global Constraints

- Keep `label-cli preview` and all existing CLI envelopes backward compatible.
- Default QC output is 1440 by 1440; accept only integer dimensions from 1 through 4096.
- Required `qc-standard` views cannot be removed by custom camera configuration.
- Use stable area ids and mesh indices; node names are display metadata only.
- Capture color for every required view and only the relevant diagnostic PBR channels for each craft-bearing area.
- Publish the output directory atomically; never expose a partial evidence set.
- The manifest revision must equal the canonical `revisionOf(input)` value.
- The CLI creates evidence but never authors the visual pass/warning/fail verdict.
- The Skill permits at most three automatic repair rounds after the initial inspection.
- Rendered craft is visual simulation, not manufacturing certification.
- Preserve unrelated user changes already present in the worktree.
- Do not bump the package version, add a changelog, commit, push, or submit the plugin directory as part of this plan.

## File map

### New files

- `src/agent/qcCapturePlan.ts` — pure standard/custom view planning and craft-channel selection.
- `src/scene/qcCamera.ts` — pure geometry-to-camera fitting and area surface-frame math.
- `scripts/lib/qc-output.mjs` — QC filenames, manifest construction, and manifest validation.
- `tests/qcCapturePlan.test.ts` — preset, area, channel, and custom-camera planning tests.
- `tests/qcCamera.test.ts` — deterministic camera fit and transformed-normal tests.
- `tests/qcOutput.test.ts` — manifest and artifact path tests.
- `tests/agentBrowserRuntime.test.ts` — browser batch ordering, upload, and metadata tests.
- `skills/cosmetic-label-editor/references/quality-control.md` — complete mandatory QC rubric and report contract.

### Modified files

- `src/agent/contracts.ts` — structured-clone-safe QC bridge request/result types.
- `src/agent/previewCapture.ts` — registered viewport capture accepts explicit QC view requests.
- `src/scene/SceneController.ts` — model/area target resolution, temporary camera/channel state, deterministic capture.
- `src/scene/Viewport.tsx` — register the extended capture callback.
- `src/agent/bridge.ts` — expose `renderQcEvidence` through the guarded bridge.
- `src/agent/browserBridgeRuntime.ts` — plan and upload the QC batch.
- `scripts/label-cli.mjs` — parse and route the `qc` command and its options.
- `scripts/lib/operations.mjs` — run the one-shot QC browser session and atomically publish evidence.
- `tests/agentBridge.test.ts` — extended capture ownership and bridge method tests.
- `tests/cliProtocol.test.ts` — CLI validation/routing and JSON-envelope tests.
- `tests/pluginE2E.test.ts` — real browser QC artifact/manifest smoke test.
- `skills/cosmetic-label-editor/SKILL.md` — mandatory QC and repair loop routing.
- `tests/pluginSkillBundle.test.ts` — enforce Skill wording, reference, and three-round policy.
- `README.md` and `README.zh-CN.md` — document the user-facing QC command without changing the approved use-case-first introduction.

---

### Task 1: Define QC contracts and the pure capture plan

**Files:**
- Create: `src/agent/qcCapturePlan.ts`
- Modify: `src/agent/contracts.ts`
- Test: `tests/qcCapturePlan.test.ts`

**Interfaces:**
- Consumes: `LabelAreaConfig`, `CraftType`, and the current canonical area ids.
- Produces: `QcEvidenceRequest`, `QcViewRequest`, `QcViewResult`, `QcEvidenceResult`, `QcCameraMetadata`, `buildQcCapturePlan()`, and `craftChannelsForArea()`.

- [ ] **Step 1: Write failing tests for the six model views and two per-area views**

```ts
import { describe, expect, it } from 'vitest'
import { buildQcCapturePlan } from '../src/agent/qcCapturePlan'
import type { CraftType, LabelAreaConfig } from '../src/label/types'

function area(id: string, crafts: CraftType[] = []): LabelAreaConfig {
  return {
    id,
    meshIndex: id === 'front' ? 1 : 2,
    nodeName: `${id}-mesh`,
    surfaceMode: 'overlay',
    side: id === 'back' ? 'back' : 'front',
    layers: [{
      id: `${id}-layer`, kind: 'shape', shape: 'rectangle',
      width: 100, height: 100, fill: '#ffffff', stroke: '#000000',
      strokeWidth: 0, cornerRadius: 0, x: 0, y: 0, rotation: 0,
      opacity: 1, visible: true, locked: false, zIndex: 0,
      craft: crafts.map((type) => ({ type, params: {} })),
    }],
    globalCraft: { craft: [] },
  } as LabelAreaConfig
}

describe('QC capture plan', () => {
  it('keeps six model views and two color close-ups for every area', () => {
    const plan = buildQcCapturePlan({
      preset: 'qc-standard', width: 1440, height: 1440,
      areas: [area('front'), area('back')], customViews: [],
    })
    expect(plan.filter((view) => view.target.kind === 'model').map((view) => view.id)).toEqual([
      'model-front', 'model-back', 'model-left', 'model-right',
      'model-front-right', 'model-back-left',
    ])
    expect(plan.filter((view) => view.areaId === 'front' && view.channel === 'color').map((view) => view.id)).toEqual([
      'area-front-face', 'area-front-craft',
    ])
    expect(plan).toHaveLength(10)
  })
})
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `pnpm vitest run tests/qcCapturePlan.test.ts`

Expected: FAIL because `src/agent/qcCapturePlan.ts` does not exist.

- [ ] **Step 3: Add structured-clone-safe QC contracts**

Add these shapes to `src/agent/contracts.ts`:

```ts
export type QcChannel = 'color' | 'metalness' | 'roughness' | 'bump'
export type QcVector3 = [number, number, number]

export type QcTarget =
  | { kind: 'model' }
  | { kind: 'area'; areaId: string }

export type QcPose =
  | { kind: 'direction'; direction: QcVector3 }
  | { kind: 'area-face' }
  | { kind: 'area-craft' }

export interface QcCustomView {
  id: string
  direction: QcVector3
  target: 'model' | string
  framing: 'fit-model' | 'fit-area'
  channel: QcChannel
}

export interface QcEvidenceRequest {
  preset?: 'qc-standard'
  width?: number
  height?: number
  customViews?: QcCustomView[]
}

export interface QcViewRequest {
  id: string
  target: QcTarget
  framing: 'fit-model' | 'fit-area'
  pose: QcPose
  channel: QcChannel
  width: number
  height: number
  areaId?: string
  reason: string
}

export interface QcCameraMetadata {
  position: QcVector3
  direction: QcVector3
  target: QcVector3
  up: QcVector3
  fov: number
}

export interface QcViewResult {
  artifact: ArtifactDescriptor
  view: QcViewRequest
  camera: QcCameraMetadata
}

export interface QcAreaEvidence {
  areaId: string
  meshIndex: number
  nodeName: string
  side?: 'front' | 'back'
  surfaceMode: 'overlay' | 'replace'
  viewIds: string[]
}

export interface QcEvidenceResult {
  preset: 'qc-standard'
  views: QcViewResult[]
  areas: QcAreaEvidence[]
  validation: DesignValidationReport
}
```

Extend `LabelEditorAgentBridgeV1` with:

```ts
renderQcEvidence(input?: QcEvidenceRequest): Promise<BridgeResult<QcEvidenceResult>>
```

- [ ] **Step 4: Implement the standard planner and exact craft-to-channel map**

Create `src/agent/qcCapturePlan.ts` with these exported contracts:

```ts
const MODEL_VIEWS = [
  ['model-front', [0, 0, 1]],
  ['model-back', [0, 0, -1]],
  ['model-left', [-1, 0, 0]],
  ['model-right', [1, 0, 0]],
  ['model-front-right', [1, 0, 1]],
  ['model-back-left', [-1, 0, -1]],
] as const

const CRAFT_CHANNELS: Record<CraftType, QcChannel[]> = {
  foil: ['metalness', 'roughness'],
  emboss: ['bump'],
  deboss: ['bump'],
  matte: ['roughness', 'bump'],
  uv: ['roughness'],
  stroke: [],
}

export function craftChannelsForArea(area: LabelAreaConfig): QcChannel[]

export function buildQcCapturePlan(input: {
  preset: 'qc-standard'
  width: number
  height: number
  areas: LabelAreaConfig[]
  customViews: QcCustomView[]
}): QcViewRequest[]
```

The implementation must sanitize ids with `/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/`, reject duplicate ids, reject non-finite/zero direction vectors, require `fit-area` to target an existing area, append custom views after all mandatory views, and deduplicate craft channels in `metalness`, `roughness`, `bump` order.

- [ ] **Step 5: Add tests for craft channels and invalid custom cameras**

```ts
it('adds only channels required by each area craft', () => {
  const front = area('front', ['foil', 'emboss'])
  const plan = buildQcCapturePlan({
    preset: 'qc-standard', width: 1440, height: 1440,
    areas: [front], customViews: [],
  })
  expect(plan.filter((view) => view.areaId === 'front').map((view) => [view.id, view.channel])).toEqual([
    ['area-front-face', 'color'],
    ['area-front-craft', 'color'],
    ['area-front-metalness', 'metalness'],
    ['area-front-roughness', 'roughness'],
    ['area-front-bump', 'bump'],
  ])
})

it.each([
  [{ id: '../escape', direction: [1, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }],
  [{ id: 'zero', direction: [0, 0, 0], target: 'model', framing: 'fit-model', channel: 'color' }],
  [{ id: 'missing', direction: [1, 0, 0], target: 'absent', framing: 'fit-area', channel: 'color' }],
])('rejects an invalid custom view', (view) => {
  expect(() => buildQcCapturePlan({
    preset: 'qc-standard', width: 1440, height: 1440,
    areas: [area('front')], customViews: [view as never],
  })).toThrow()
})
```

- [ ] **Step 6: Run the focused tests and typecheck**

Run: `pnpm vitest run tests/qcCapturePlan.test.ts && pnpm exec tsc -b --pretty false`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Run: `git diff --check -- src/agent/contracts.ts src/agent/qcCapturePlan.ts tests/qcCapturePlan.test.ts`

Expected: no output. Do not commit under this plan's global constraints.

---

### Task 2: Add deterministic model and area camera math

**Files:**
- Create: `src/scene/qcCamera.ts`
- Test: `tests/qcCamera.test.ts`

**Interfaces:**
- Consumes: Three.js `Box3`, `BufferGeometry`, `Matrix4`, a capture aspect ratio, and the `QcPose`/`QcCameraMetadata` contracts.
- Produces: `surfaceFrameForGeometry()` and `cameraForFrame()` for `SceneController`.

- [ ] **Step 1: Write failing camera-fit tests**

```ts
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { cameraForFrame, surfaceFrameForGeometry } from '../src/scene/qcCamera'

it('fits a tall model with a deterministic front camera', () => {
  const frame = { center: new THREE.Vector3(0, 1, 0), size: new THREE.Vector3(1, 2, 1) }
  const result = cameraForFrame(frame, new THREE.Vector3(0, 0, 1), {
    fov: 45, aspect: 1, margin: 1.15,
  })
  expect(result.target.toArray()).toEqual([0, 1, 0])
  expect(result.position.z).toBeGreaterThan(2)
  expect(result.direction.clone().normalize().toArray()).toEqual([0, 0, 1])
})

it('transforms an area normal through its world matrix', () => {
  const geometry = new THREE.PlaneGeometry(2, 1)
  const matrix = new THREE.Matrix4().makeRotationY(Math.PI / 2)
  const frame = surfaceFrameForGeometry(geometry, matrix)
  expect(frame.normal.x).toBeCloseTo(1, 5)
  expect(frame.normal.z).toBeCloseTo(0, 5)
})
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `pnpm vitest run tests/qcCamera.test.ts`

Expected: FAIL because `src/scene/qcCamera.ts` does not exist.

- [ ] **Step 3: Implement surface-frame extraction**

Create these exact types and functions:

```ts
export interface QcTargetFrame {
  center: THREE.Vector3
  size: THREE.Vector3
  normal?: THREE.Vector3
}

export function surfaceFrameForGeometry(
  geometry: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
): Required<QcTargetFrame>
```

Compute the world-space bounding box from the position attribute. Average transformed vertex normals with a normal matrix; if the average is nearly zero, average triangle face normals from the index. Throw `INVALID_USAGE` when positions are missing, bounds are empty, or no stable normal can be computed. Normalize the final normal and keep matrix-handedness explicit so mirrored parents do not silently reverse the evidence pose.

- [ ] **Step 4: Implement deterministic perspective fitting and stable up vectors**

```ts
export function cameraForFrame(
  frame: QcTargetFrame,
  direction: THREE.Vector3,
  options: { fov: number; aspect: number; margin: number },
): {
  position: THREE.Vector3
  target: THREE.Vector3
  direction: THREE.Vector3
  up: THREE.Vector3
}
```

Normalize the direction, reject a zero vector, calculate vertical and horizontal fit distances from FOV/aspect, use the larger distance times `margin`, and choose Z-up only when the direction is within 0.98 dot-product of world Y. Use the frame's maximum dimension as the minimum safe distance.

- [ ] **Step 5: Add mirrored, oblique, non-square, and pole tests**

Test a negative-X scale matrix, `+X +Z` oblique direction, aspect `16 / 9`, and a near-vertical direction. Assert finite position/up values, positive distance, stable target, and `abs(direction.dot(up)) < 0.999`.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm vitest run tests/qcCamera.test.ts && pnpm exec tsc -b --pretty false`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Run: `git diff --check -- src/scene/qcCamera.ts tests/qcCamera.test.ts`

Expected: no output. Do not commit.

---

### Task 3: Capture a requested view without persisting scene state

**Files:**
- Modify: `src/agent/previewCapture.ts`
- Modify: `src/scene/SceneController.ts`
- Modify: `src/scene/Viewport.tsx`
- Test: `tests/agentBridge.test.ts`
- Test: `tests/qcCamera.test.ts`

**Interfaces:**
- Consumes: `QcViewRequest`, `cameraForFrame()`, `surfaceFrameForGeometry()`.
- Produces: `captureAgentQcView(request)` and `SceneController.captureQcPng(request)` returning PNG plus camera metadata.

- [ ] **Step 1: Write a failing capture-owner forwarding test**

```ts
it('forwards the complete QC request to the newest viewport owner', async () => {
  const cameraMetadata = {
    position: [0, 0, 3], direction: [0, 0, 1], target: [0, 0, 0],
    up: [0, 1, 0], fov: 45,
  } as const
  const qcViewRequest = {
    id: 'model-front', target: { kind: 'model' }, framing: 'fit-model',
    pose: { kind: 'direction', direction: [0, 0, 1] }, channel: 'color',
    width: 1440, height: 1440, reason: 'Primary front-label check',
  } as const
  const received: unknown[] = []
  const dispose = registerAgentPreviewCapture({
    preview: async () => new Blob(['preview']),
    qc: async (request) => {
      received.push(request)
      return { blob: new Blob(['png']), camera: cameraMetadata }
    },
  })
  const result = await captureAgentQcView(qcViewRequest)
  expect(received).toEqual([qcViewRequest])
  expect(result.camera).toEqual(cameraMetadata)
  dispose()
})
```

- [ ] **Step 2: Run the focused test and verify the new API is absent**

Run: `pnpm vitest run tests/agentBridge.test.ts`

Expected: FAIL because `captureAgentQcView` is not exported.

- [ ] **Step 3: Extend the registered capture boundary while preserving normal preview**

In `src/agent/previewCapture.ts`, define:

```ts
export interface AgentQcCaptureResult {
  blob: Blob
  camera: QcCameraMetadata
}

export interface AgentPreviewCaptureOwner {
  preview(request: Required<Pick<PreviewRequest, 'width' | 'height'>>): Promise<Blob>
  qc(request: QcViewRequest): Promise<AgentQcCaptureResult>
}

export function registerAgentPreviewCapture(owner: AgentPreviewCaptureOwner): () => void
export function captureAgentPreview(request: Required<Pick<PreviewRequest, 'width' | 'height'>>): Promise<Blob>
export function captureAgentQcView(request: QcViewRequest): Promise<AgentQcCaptureResult>
```

Keep the newest-owner token behavior. Both capture functions must reject with `3D preview is not ready` when no owner exists.

- [ ] **Step 4: Add `SceneController.captureQcPng()` with full state restoration**

Add a `private channelView` field and keep it synchronized in `setChannelView()`. Add:

```ts
async captureQcPng(request: QcViewRequest): Promise<{
  blob: Blob
  camera: QcCameraMetadata
}>
```

Implementation sequence:

1. Resolve `request.target.kind === 'model'` from `this.model` or resolve the exact area from `this.labelMeshes.get(areaId)`.
2. Update the target object's world matrix before reading geometry.
3. For `direction`, use the requested vector; for `area-face`, use the surface normal; for `area-craft`, normalize `normal + tangent * 0.35 + worldUp * 0.2` where tangent is a stable cross product.
4. Save camera position/quaternion/up/FOV/aspect, controls target, channel, renderer size, pixel ratio, and outline selection.
5. Hide QC-irrelevant outline/markers, set channel/camera/controls, render, and encode PNG.
6. Return the exact applied camera metadata.
7. Restore all saved state in `finally`, including after PNG encoding failure.

Refactor existing `capturePng(width, height)` to share the render-size/encoding helper and retain identical default-camera behavior.

- [ ] **Step 5: Register both normal and QC capture callbacks in `Viewport`**

Replace the current single callback with:

```ts
const unregisterPreview = registerAgentPreviewCapture({
  preview: ({ width, height }) => ctrl.capturePng(width, height),
  qc: (request) => ctrl.captureQcPng(request),
})
```

- [ ] **Step 6: Test missing areas and restoration on failure**

Use an injected PNG encoder or the existing testable helper to force an encoding rejection. Assert the camera snapshot, controls target, channel, renderer size, and outline selection equal their pre-capture values. Assert an unknown area rejects with an error containing its exact area id.

- [ ] **Step 7: Run focused scene and bridge tests**

Run: `pnpm vitest run tests/agentBridge.test.ts tests/qcCamera.test.ts tests/sceneTexture.test.ts tests/visibility.test.ts`

Expected: PASS.

- [ ] **Step 8: Run typecheck and review checkpoint**

Run: `pnpm exec tsc -b --pretty false && git diff --check -- src/agent/previewCapture.ts src/scene/SceneController.ts src/scene/Viewport.tsx tests/agentBridge.test.ts tests/qcCamera.test.ts`

Expected: PASS and no diff-check output. Do not commit.

---

### Task 4: Expose batch QC capture through the guarded browser bridge

**Files:**
- Modify: `src/agent/bridge.ts`
- Modify: `src/agent/browserBridgeRuntime.ts`
- Test: `tests/agentBridge.test.ts`
- Test: `tests/agentBrowserRuntime.test.ts`
- Test: `tests/qcCapturePlan.test.ts`

**Interfaces:**
- Consumes: `buildQcCapturePlan()`, `captureAgentQcView()`, current area state, and artifact upload.
- Produces: guarded `renderQcEvidence(input)` and uploaded `QcEvidenceResult`.

- [ ] **Step 1: Write a failing bridge-operation test**

```ts
it('exposes QC evidence as a guarded bridge operation', async () => {
  const bridge = createAgentBridge({
    renderQcEvidence: async () => ({
      preset: 'qc-standard', views: [], areas: [], validation: { ready: true, issues: [] },
    }),
  })
  await expect(bridge.renderQcEvidence({ width: 1440, height: 1440 })).resolves.toMatchObject({
    ok: true,
    operation: 'render_qc_evidence',
    data: { preset: 'qc-standard', views: [] },
  })
})
```

- [ ] **Step 2: Run the test and verify the bridge method is absent**

Run: `pnpm vitest run tests/agentBridge.test.ts`

Expected: FAIL because `renderQcEvidence` is not wired.

- [ ] **Step 3: Wire the handler and envelope operation**

Add to `AgentBridgeHandlers`, default handlers, and the returned bridge:

```ts
renderQcEvidence: (input?: QcEvidenceRequest) => Promise<QcEvidenceResult>

renderQcEvidence: (input) => invoke(
  'render_qc_evidence',
  () => handlers.renderQcEvidence(input),
),
```

- [ ] **Step 4: Implement sequential batch capture in the browser runtime**

In `createBrowserAgentBridge()`:

```ts
renderQcEvidence: async (input) => {
  await waitForBakes()
  const width = boundedDimension(input?.width ?? 1440)
  const height = boundedDimension(input?.height ?? 1440)
  const areas = useLabelStore.getState().areas
  const plan = buildQcCapturePlan({
    preset: input?.preset ?? 'qc-standard',
    width,
    height,
    areas,
    customViews: input?.customViews ?? [],
  })
  assertCraftChannelContributions(areas, useLabelStore.getState().bakeMap, plan)
  const views: QcViewResult[] = []
  for (const request of plan) {
    const captured = await captureAgentQcView(request)
    const artifact = await uploadArtifact(bootstrap, {
      id: `qc-${request.id}`,
      fileName: `${request.id}.png`,
      mimeType: 'image/png',
      bytes: await blobBytes(captured.blob),
      width,
      height,
      areaId: request.areaId,
      channel: request.channel,
    })
    views.push({ artifact, view: request, camera: captured.camera })
  }
  return { preset: 'qc-standard', views, areas: qcAreaEvidence(areas, views), validation: designValidation() }
}
```

Implement `boundedDimension()` to require an integer from 1 through 4096. Do not capture in parallel because camera and channel are shared mutable render state. Throw if validation contains an error, any planned area is missing, an expected artifact upload fails, or the final number of results differs from the plan.

Implement `assertCraftChannelContributions()` by scanning the exact required area canvas from `bakeMap`: metalness must contain a value other than 0, roughness a value other than 255, and bump a value other than 128. Scan the complete pixel buffer so a thin foil stroke is not missed. A required channel with no contribution throws `INVALID_LABEL_SPEC` with a `qc-empty-craft-channel` issue containing the area id and channel.

- [ ] **Step 5: Add a mocked capture test for order and metadata**

In `tests/agentBrowserRuntime.test.ts`, register a test owner that returns camera metadata and record request ids. Assert standard ids are captured in plan order, every uploaded filename is generated from its validated id, per-area results include mesh index/side/surface mode, and the returned `validation.ready` value is preserved. Add canvases with one changed pixel for foil/roughness/bump and assert they pass; restore the channel to its neutral baseline and assert `qc-empty-craft-channel` names the exact area and channel.

- [ ] **Step 6: Run bridge, planner, and browser-runtime tests**

Run: `pnpm vitest run tests/agentBridge.test.ts tests/qcCapturePlan.test.ts tests/agentBrowserRuntime.test.ts`

Expected: PASS.

- [ ] **Step 7: Run typecheck and review checkpoint**

Run: `pnpm exec tsc -b --pretty false && git diff --check -- src/agent/bridge.ts src/agent/browserBridgeRuntime.ts tests/agentBridge.test.ts tests/agentBrowserRuntime.test.ts`

Expected: PASS and no diff-check output. Do not commit.

---

### Task 5: Build and validate the revision-bound QC manifest

**Files:**
- Create: `scripts/lib/qc-output.mjs`
- Test: `tests/qcOutput.test.ts`

**Interfaces:**
- Consumes: `inspectProject(input)`, model inspection, browser `QcEvidenceResult`, and session artifacts containing PNG bytes/hashes.
- Produces: `parseQcCameraConfig()`, `qcArtifactRelativePath()`, `buildQcManifest()`, and `validateQcManifest()`.

- [ ] **Step 1: Write a failing manifest test**

```ts
it('binds relative PNG evidence to the canonical input revision', async () => {
  const spec = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, 'fixtures/specs/perfume-front-back-v2.json'),
    'utf8',
  ))
  const camera = {
    position: [0, 0, 3], direction: [0, 0, 1], target: [0, 0, 0],
    up: [0, 1, 0], fov: 45,
  }
  const request = {
    id: 'model-front', target: { kind: 'model' }, framing: 'fit-model',
    pose: { kind: 'direction', direction: [0, 0, 1] }, channel: 'color',
    width: 1440, height: 1440, reason: 'Primary front-label check',
  }
  const descriptor = {
    id: 'qc-model-front', fileName: 'model-front.png', mimeType: 'image/png',
    byteLength: 8, sha256: `sha256:${'a'.repeat(64)}`, width: 1440, height: 1440,
  }
  const manifest = buildQcManifest({
    createdAt: '2026-08-25T00:00:00.000Z',
    project: inspectProject(spec),
    inspection: {
      name: 'bottle.glb', fingerprint: `sha256:${'b'.repeat(64)}`,
      dimensions: { width: 1, height: 2, depth: 1 }, meshes: [], warnings: [],
    },
    evidence: {
      preset: 'qc-standard', views: [{ artifact: descriptor, view: request, camera }],
      areas: [], validation: { ready: true, issues: [] },
    },
    artifacts: [{ ...descriptor, bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }],
  })
  expect(manifest).toMatchObject({
    version: 1,
    preset: 'qc-standard',
    input: { kind: 'label-spec-v2', revision: revisionOf(spec) },
    artifacts: [{ id: 'qc-model-front', path: 'model/model-front.png' }],
  })
  expect(path.isAbsolute(manifest.artifacts[0].path)).toBe(false)
})
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `pnpm vitest run tests/qcOutput.test.ts`

Expected: FAIL because `scripts/lib/qc-output.mjs` does not exist.

- [ ] **Step 3: Implement generated paths and manifest construction**

Export:

```js
export function qcArtifactRelativePath(view) {
  const file = `${sanitizeArtifactName(view.view.id)}.png`
  return view.view.areaId
    ? `areas/${sanitizeArtifactName(view.view.areaId)}/${file}`
    : `model/${file}`
}

export function buildQcManifest({ createdAt, project, inspection, evidence, artifacts })
export function validateQcManifest(value)
export function parseQcCameraConfig(value)
```

The manifest must include every field from the approved spec. Set `input.sha256` to the 64-character hex portion of `project.revision`. Join bridge results to stored bytes by exact artifact id; reject missing, duplicate, or unexpected ids. Use stored SHA-256 values, never recompute from a URL. Reject absolute paths, `..` segments, backslashes, bearer tokens, and URLs. Validate that every area has face and craft color evidence and that every view dimension matches its PNG artifact descriptor.

`parseQcCameraConfig(value)` requires exactly `{ version: 1, views: [...] }` and returns the views array. It rejects missing/extra top-level fields, a non-array `views`, or more than 32 custom views with an `INVALID_USAGE` error. Per-view ids, directions, targets, framing, channels, and duplicate ids remain validated by the shared browser capture planner.

- [ ] **Step 4: Add negative tests for stale/incomplete/unsafe evidence**

Test duplicate artifact ids, a missing area-face image, a `../escape.png` path, a mismatched revision, and an unexpected uploaded artifact. Each must throw before any publication API is called.

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run tests/qcOutput.test.ts tests/projectControl.test.ts`

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Run: `git diff --check -- scripts/lib/qc-output.mjs tests/qcOutput.test.ts`

Expected: no output. Do not commit.

---

### Task 6: Add the `label-cli qc` command and atomic directory publication

**Files:**
- Modify: `scripts/label-cli.mjs`
- Modify: `scripts/lib/operations.mjs`
- Test: `tests/cliProtocol.test.ts`
- Test: `tests/pluginE2E.test.ts`

**Interfaces:**
- Consumes: bridge `renderQcEvidence`, `inspectProject()`, `buildQcManifest()`, and `runtime.publishArtifacts()`.
- Produces: `label-cli qc ...` and the `render_label_qc` success/failure envelope.

- [ ] **Step 1: Write failing CLI routing and validation tests**

```ts
it('routes qc dimensions, preset, camera config, force, and output', async () => {
  const calls: unknown[] = []
  const code = await runCli([
    'qc', 'spec.json', '--glb', 'model.glb', '--output', 'qc-dir',
    '--preset', 'qc-standard', '--camera-config', 'cameras.json',
    '--width', '1600', '--height', '1200', '--force', '--json',
  ], {
    operations: { qc: async (input) => {
      calls.push(input)
      return { ok: true, operation: 'render_label_qc', data: {}, warnings: [] }
    } },
    stdout: () => undefined, stderr: () => undefined,
  })
  expect(code).toBe(0)
  expect(calls).toEqual([{
    inputPath: 'spec.json', glbPath: 'model.glb', outputDir: 'qc-dir',
    preset: 'qc-standard', cameraConfigPath: 'cameras.json',
    width: 1600, height: 1200, force: true,
  }])
})
```

Add table tests rejecting missing `--glb`, missing `--output`, unsupported preset, non-integer dimensions, 0, 4097, and `--camera-config` on a non-QC command.

- [ ] **Step 2: Run the CLI protocol test and verify `qc` is unknown**

Run: `pnpm vitest run tests/cliProtocol.test.ts`

Expected: FAIL with `Unknown command: qc`.

- [ ] **Step 3: Parse and route QC options**

Add `preset`, `camera-config`, `width`, and `height` to `valueOptions`; add `qc` to the command list. Parse dimensions before invoking operations:

```js
function parseDimension(value, name) {
  if (value === undefined) return 1440
  if (!/^\d+$/.test(value)) throw usageError(`--${name} must be an integer from 1 to 4096`)
  const number = Number(value)
  if (number < 1 || number > 4096) throw usageError(`--${name} must be an integer from 1 to 4096`)
  return number
}
```

Only `qc-standard` is accepted. The `qc` operation receives the exact object asserted in Step 1.

- [ ] **Step 4: Implement `operations.qc()` without routing through `apply()`**

Add:

```js
async qc({
  inputPath, glbPath, outputDir, preset = 'qc-standard',
  cameraConfigPath, width = 1440, height = 1440, force = false,
})
```

Required sequence:

1. Resolve/read the input and run `inspectProject()` to obtain kind/revision/full validation.
2. Resolve/read `cameraConfigPath`, call `parseQcCameraConfig()`, and map malformed or invalid camera JSON to `INVALID_USAGE`.
3. Check output availability before creating the browser session.
4. Create one browser session and load the model once.
5. Apply Spec with local assets or apply Project using the existing guarded bridge path.
6. Call `waitForReady({ timeoutMs: 60_000 })`.
7. Call `renderQcEvidence({ preset, width, height, customViews })` with the exact array returned by `parseQcCameraConfig()`, or an empty array when the option is absent.
8. Fail on browser console/page errors.
9. Select only the QC artifact ids returned by the bridge; reject extra or missing ids.
10. Build and validate `qc-manifest.json` using `revisionOf(input.value)`.
11. Append the manifest artifact and call `runtime.publishArtifacts(session.id, outputDir, artifacts, force)` once.
12. Return `success('render_label_qc', { outputDir, manifestPath, revision, modelFingerprint, preset, artifacts, validation })`.

Do not export a labeled GLB, Project, normalized Spec, or print manifest from this command. The QC run is an evidence-only, one-shot headless session.

- [ ] **Step 5: Test conflict, malformed camera config, and failed batch cleanup**

In `tests/cliProtocol.test.ts`, inject a fake runtime/operation boundary and assert exactly one stdout envelope. In an operations-level test, assert an existing output without `--force` returns `OUTPUT_CONFLICT`, a malformed camera file returns `INVALID_USAGE`, a bridge capture error leaves no output directory, and `--force` replaces only the exact resolved directory through `publishArtifacts()`.

- [ ] **Step 6: Extend the real browser E2E test**

After the existing preview smoke test, run:

```ts
const qcOutput = path.join(root, 'label-qc', 'round-0')
const qcCode = await runCli([
  'qc', workingSpec, '--glb', modelPath,
  '--output', qcOutput, '--preset', 'qc-standard', '--json',
], dependencies)
expect(qcCode).toBe(0)
const manifest = JSON.parse(await readFile(path.join(qcOutput, 'qc-manifest.json'), 'utf8'))
expect(manifest.input.revision).toBe(revisionOf(spec))
expect(manifest.artifacts.filter((item) => item.channel === 'color').length).toBeGreaterThanOrEqual(10)
for (const artifact of manifest.artifacts) {
  const png = await readFile(path.join(qcOutput, artifact.path))
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
}
```

Also assert no staging directory remains and each manifest hash matches the published bytes.

- [ ] **Step 7: Run CLI and E2E tests**

Run: `pnpm vitest run tests/cliProtocol.test.ts tests/qcOutput.test.ts && pnpm test:plugin-e2e`

Expected: PASS. The E2E test may skip its live headful-only case, but the one-shot headless QC case must run.

- [ ] **Step 8: Run typecheck and review checkpoint**

Run: `pnpm exec tsc -b --pretty false && git diff --check -- scripts/label-cli.mjs scripts/lib/operations.mjs tests/cliProtocol.test.ts tests/pluginE2E.test.ts`

Expected: PASS and no diff-check output. Do not commit.

---

### Task 7: Make evidence-backed QC mandatory in `cosmetic-label-editor`

**Files:**
- Create: `skills/cosmetic-label-editor/references/quality-control.md`
- Modify: `skills/cosmetic-label-editor/SKILL.md`
- Modify: `tests/pluginSkillBundle.test.ts`

**Interfaces:**
- Consumes: installed `bin/label-cli.mjs`, `project`, `patch --force`, live revision events, and QC manifest/artifacts.
- Produces: a mandatory rubric, structured failure evidence, and bounded repair/recheck workflow.

- [ ] **Step 1: Write failing Skill contract tests**

```ts
it('requires revision-bound multi-view QC and bounded repair', async () => {
  const skill = await readFile(path.join(repoRoot, 'skills/cosmetic-label-editor/SKILL.md'), 'utf8')
  const rubric = await readFile(
    path.join(repoRoot, 'skills/cosmetic-label-editor/references/quality-control.md'),
    'utf8',
  )
  expect(skill).toContain('## Mandatory quality control')
  expect(skill).toContain('label-cli qc')
  expect(skill).toContain('qc-manifest.json')
  expect(skill).toContain('manifest revision')
  expect(skill).toContain('maximum of three repair rounds')
  expect(skill).toContain('Do not confirm delivery')
  for (const heading of [
    'Target and labeled surface', 'Placement, coverage, and seams',
    'Orientation', 'Text readiness', 'Artwork and brand assets',
    'Craft and material rendering', 'Cross-view and output consistency',
  ]) expect(rubric).toContain(`## ${heading}`)
})
```

- [ ] **Step 2: Run the Skill test and verify the reference is absent**

Run: `pnpm vitest run tests/pluginSkillBundle.test.ts`

Expected: FAIL because the QC reference and mandatory section do not exist.

- [ ] **Step 3: Write the complete QC reference**

Create `quality-control.md` with the seven approved rubric headings and this report schema:

```json
{
  "version": 1,
  "inputRevision": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "round": 0,
  "status": "pass | warning | fail",
  "checks": [
    {
      "status": "pass | warning | fail",
      "category": "orientation",
      "areaId": "front",
      "layerId": "brand",
      "evidence": ["qc-area-front-face"],
      "message": "Brand text is mirrored in the face-on view.",
      "proposedChange": "Toggle the area's mirrorU mapping."
    }
  ]
}
```

Define blocking failures, warning-only manufacturing risks, required artifact ids, all-area coverage, 2D/3D/channel comparison, and the visual-simulation disclaimer exactly as the approved spec requires.

- [ ] **Step 4: Add a mandatory QC section and repair loop to the Skill**

The Skill must instruct the Agent to:

1. Read `references/quality-control.md` before production QC.
2. Keep live preview running.
3. Validate and run `label-cli qc working-label-spec.json --glb package.glb --output label-qc/round-0 --preset qc-standard --json`.
4. Compare `qc-manifest.json.input.revision` with the current `project` revision before inspecting images.
5. Inspect every model view, area-face view, area-craft view, and included PBR channel.
6. Write pass/warning/fail checks referencing artifact ids.
7. On failure, patch the same working Spec with `baseRevision`, wait for the ready revision, then capture into the next immutable round directory.
8. Allow a maximum of three repair rounds after round 0.
9. Recheck all changed areas plus every view affected by a mapping/target/material change.
10. Stop and report remaining blockers after round 3; do not apply/export or confirm delivery.
11. After a pass, run requested apply/export and require its validation and GLB cross-check before final confirmation.

Make QC mandatory even when `validate` reports ready; deterministic validation does not replace visual inspection.

- [ ] **Step 5: Add negative wording tests**

Assert the Skill does not say that schema validation alone proves quality, that warnings are silently ignored, or that the Agent may overwrite earlier QC rounds. Keep existing no-old-tool and live-preview tests passing.

- [ ] **Step 6: Run Skill tests and package-path check**

Run: `pnpm vitest run tests/pluginSkillBundle.test.ts tests/pluginInstaller.test.ts`

Expected: PASS and installer recursion includes the new reference file.

- [ ] **Step 7: Review checkpoint**

Run: `git diff --check -- skills/cosmetic-label-editor/SKILL.md skills/cosmetic-label-editor/references/quality-control.md tests/pluginSkillBundle.test.ts`

Expected: no output. Do not commit.

---

### Task 8: Document the QC command and verify the complete delivery

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Verify: all files from Tasks 1–7

**Interfaces:**
- Consumes: final command syntax, output layout, and Skill workflow.
- Produces: user-facing command documentation and release-quality validation evidence.

- [ ] **Step 1: Update both README command sections without rewriting their introductions**

Add the command:

```bash
label-cli qc working-label-spec.json \
  --glb package.glb \
  --output label-qc/round-0 \
  --preset qc-standard \
  --json
```

Explain that the directory contains six whole-model views, two close-ups per area, relevant craft-channel images, and `qc-manifest.json`; the Agent compares the manifest revision with the current working revision, then repairs and recaptures if any blocking check fails. Keep the README preface focused on usage scenarios and do not reintroduce technical-positioning language the user previously removed.

- [ ] **Step 2: Run focused domain and protocol suites**

Run:

```bash
pnpm vitest run \
  tests/qcCapturePlan.test.ts \
  tests/qcCamera.test.ts \
  tests/qcOutput.test.ts \
  tests/agentBridge.test.ts \
  tests/cliProtocol.test.ts \
  tests/pluginSkillBundle.test.ts \
  tests/pluginSecurity.test.ts \
  tests/pluginInstaller.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run TypeScript and production build**

Run: `pnpm exec tsc -b --pretty false && pnpm build`

Expected: PASS with a successful Vite production build.

- [ ] **Step 4: Run the complete test suite and plugin E2E**

Run: `pnpm test && pnpm test:plugin-e2e`

Expected: all non-environment-gated tests pass; report any skipped headful case separately instead of calling it passed.

- [ ] **Step 5: Package and installer verification**

Run:

```bash
pnpm pack --dry-run
```

Expected: the dry-run package lists `src/agent/qcCapturePlan.ts`, `src/scene/qcCamera.ts`, `scripts/lib/qc-output.mjs`, and `skills/cosmetic-label-editor/references/quality-control.md`. Installer behavior is covered by the non-mutating `tests/pluginInstaller.test.ts` run in Steps 2 and 4; do not invoke the installer against the active Codex installation.

- [ ] **Step 6: Retain and inspect real QC evidence**

Run:

```bash
qc_tmp_dir="$(mktemp -d)"
node scripts/label-cli.mjs qc \
  input/lavira-mens-cleanser-2026-08-25/label-spec-v2.json \
  --glb input/lavira-mens-cleanser-2026-08-25/17_pump_bottle_nurhadimli.glb \
  --output "$qc_tmp_dir/round-0" \
  --preset qc-standard \
  --json
```

Open the six standard images and both close-ups for every manifest area with the local image viewer. Confirm the images are distinct, upright, and correctly framed; record the absolute manifest/image paths in the verification notes. Any visual defect blocks completion: correct it, regenerate the evidence directory, and rerun the affected focused tests.

- [ ] **Step 7: Final diff and scope audit**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only planned files plus pre-existing unrelated user changes are present. Do not stage, commit, or push.
