# GLB Label Editor Codex Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the existing GLB label editor repository into an installable Codex plugin that lets an Agent inspect a GLB, apply a declarative label design, render previews and PBR channels, and export a validated labeled GLB without clicking the UI.

**Architecture:** Keep the React/Konva/Three application as the only rendering runtime and add a guarded typed browser bridge. A shared Node orchestration layer drives that bridge through Playwright and is exposed through both a JSON CLI and a stdio MCP server; all writes are session-scoped and atomically published.

**Tech Stack:** TypeScript 5.9, React 19, Konva 10, Three.js 0.185, Zustand 5, Vite 7, Vitest 3, Node.js 22, Playwright 1.62, Ajv 8.20, MCP TypeScript SDK 1.30, glTF Transform 4.4.

**Spec:** `docs/superpowers/specs/2026-08-24-codex-label-editor-plugin-design.md`

## Global Constraints

- Preserve the current dirty working tree; stage only paths belonging to each task and never revert concurrent product work.
- The repository root and `.codex-plugin/plugin.json` name are both exactly `glb-label-editor`.
- The browser is the single label renderer; the Node runtime must call the typed bridge and must not click controls or query DOM selectors.
- Register `window.__GLB_LABEL_EDITOR_AGENT_V1__` only on loopback with `?agent=1` and a valid session capability token.
- `--json` writes exactly one JSON envelope to stdout; progress and diagnostics go to stderr.
- Exit codes are fixed: success `0`, usage `2`, path `3`, validation `4`, target `5`, browser `6`, rebuild `7`, codec `8`, conflict `9`.
- Label Spec v2 rejects unknown fields and ambiguous selectors; v1 remains a compatibility input and reports every inferred value as a warning.
- A failed apply/export publishes no partial output; an existing output requires `force: true` or `--force`.
- Standard GLB is supported. Draco input is normalized before browser loading; unsupported Meshopt, KTX2, and external `.gltf` resources return a structured blocker.
- Do not add `.app.json` or modify a personal/team marketplace in this repository conversion.
- The existing Vitest suite, production build, plugin skill validator, plugin manifest validator, and browser end-to-end path must pass before completion.

---

## File Structure

### Plugin metadata and user-facing entry points

- Create `.codex-plugin/plugin.json`: Codex plugin identity and pointers to skill/MCP configuration.
- Create `.mcp.json`: local stdio MCP server launch configuration.
- Create `skills/cosmetic-label-editor/SKILL.md`: Agent routing and workflow instructions.
- Modify `package.json`: plugin dependencies, CLI bin, runtime/build/verification scripts.
- Modify `README.md`: plugin-first installation, tools, CLI examples, supported scenarios, and developer workflow.

### Shared browser contracts and domain services

- Create `src/agent/contracts.ts`: bridge requests, results, artifact descriptors, error envelope, inspection, and validation types.
- Create `src/agent/label-spec-v2.schema.json`: canonical strict JSON Schema.
- Create `src/agent/labelSpecSchema.ts`: Ajv validation, normalization, asset resolution metadata, and v1 migration.
- Create `src/agent/targetResolver.ts`: stable target selection and ambiguity handling.
- Create `src/agent/transactionalApply.ts`: build and restore all candidate areas before one store commit.
- Create `src/agent/artifactExport.ts`: byte-producing project, print, PNG/PBR, preview, and GLB export functions.
- Create `src/agent/bridge.ts`: guarded `LabelEditorAgentBridgeV1` implementation.
- Modify `src/app/actions.ts`: call artifact services and retain browser download/toast adapters.
- Modify `src/app/App.tsx`: install/dispose the bridge and expose a hidden render host in Agent mode.
- Modify `src/app/labelSpec.ts`: route v1 compatibility through strict shared normalization while preserving UI import behavior.
- Modify `src/state/stores.ts`: add one atomic area replacement mutation.
- Modify `src/scene/Viewport.tsx`: expose a deterministic preview capture callback without altering human UI behavior.

### Node plugin runtime

- Create `scripts/lib/envelope.mjs`: stable success/error envelopes and exit-code mapping.
- Create `scripts/lib/files.mjs`: workspace-root/path checks, hashing, temporary publish directories, and atomic rename.
- Create `scripts/lib/session-server.mjs`: loopback token server for editor and binary assets.
- Create `scripts/lib/browser-session.mjs`: Playwright lifecycle and typed bridge calls.
- Create `scripts/lib/operations.mjs`: shared inspect/validate/apply/preview/export/open orchestration.
- Create `scripts/lib/codec.mjs`: GLB feature detection and Draco normalization.
- Create `scripts/plugin-runtime.mjs`: shared singleton runtime/session registry.
- Create `scripts/label-cli.mjs`: machine-readable command entry point.
- Create `scripts/mcp-server.mjs`: MCP stdio server and six coarse-grained tools.

### Verification

- Create `tests/labelSpecV2.test.ts`: strict schema and v1 migration coverage.
- Create `tests/agentTargetResolver.test.ts`: stable selector and ambiguity coverage.
- Create `tests/transactionalApply.test.ts`: all-or-nothing import coverage.
- Create `tests/artifactExport.test.ts`: byte-returning services and download adapter separation.
- Create `tests/agentBridge.test.ts`: token/loopback guard and bridge protocol coverage.
- Create `tests/cliProtocol.test.ts`: JSON stdout and exit-code coverage.
- Create `tests/mcpProtocol.test.ts`: MCP tool definitions and result envelope coverage.
- Create `tests/pluginSecurity.test.ts`: traversal, output conflict, token, and filename coverage.
- Create `tests/pluginE2E.test.ts`: real browser apply/export workflow.
- Create `tests/fixtures/specs/perfume-front-back-v2.json`: deterministic two-area text/shape scenario.
- Create `tests/fixtures/specs/arabic-front-v2.json`: RTL/font scenario.

---

### Task 1: Plugin dependencies and stable Agent contracts

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/agent/contracts.ts`
- Test: `tests/agentContracts.test.ts`

**Interfaces:**
- Consumes: existing `LabelAreaConfig`, `LabelProjectV3`, `GlbAnalysis`, and export result types.
- Produces: `AgentErrorCode`, `AgentEnvelope<T>`, `LabelEditorAgentBridgeV1`, `ModelInspection`, `ApplySpecRequest`, `ExportRequest`, and `ExportManifest` used by every later task.

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from 'vitest'
import { agentFailure, agentSuccess, exitCodeForError } from '../src/agent/contracts'

describe('Agent protocol contracts', () => {
  it('uses one stable envelope and exit-code mapping', () => {
    expect(agentSuccess('inspect_model', { meshes: 2 })).toEqual({
      ok: true, operation: 'inspect_model', data: { meshes: 2 }, warnings: [],
    })
    const failure = agentFailure('apply_label_spec', 'AMBIGUOUS_MODEL_TARGET', 'duplicate')
    expect(failure.error.code).toBe('AMBIGUOUS_MODEL_TARGET')
    expect(exitCodeForError(failure.error)).toBe(5)
  })
})
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `pnpm vitest run tests/agentContracts.test.ts`

Expected: FAIL because `src/agent/contracts.ts` does not exist.

- [ ] **Step 3: Add the runtime dependencies and CLI entry**

Run:

```bash
pnpm add @modelcontextprotocol/sdk@1.30.0 ajv@8.20.0 playwright@1.62.1
```

Add these `package.json` fields/scripts without removing current scripts:

```json
{
  "bin": { "label-cli": "./scripts/label-cli.mjs" },
  "scripts": {
    "plugin:verify": "pnpm test && pnpm build && pnpm test:plugin-e2e",
    "test:plugin-e2e": "vitest run tests/pluginE2E.test.ts --testTimeout=120000"
  }
}
```

- [ ] **Step 4: Implement the contracts and helpers**

Define the exact discriminated error codes and bridge surface:

```ts
export type AgentErrorCode =
  | 'INVALID_USAGE' | 'PATH_NOT_ALLOWED' | 'OUTPUT_CONFLICT'
  | 'INVALID_LABEL_SPEC' | 'AMBIGUOUS_MODEL_TARGET' | 'MODEL_TARGET_NOT_FOUND'
  | 'BROWSER_NOT_READY' | 'REBUILD_FAILED' | 'UNSUPPORTED_CODEC' | 'INTERNAL_ERROR'

export interface AgentError {
  code: AgentErrorCode
  message: string
  path?: string
  details?: Record<string, unknown>
  suggestion?: string
}

export type AgentEnvelope<T> =
  | { ok: true; operation: string; sessionId?: string; data: T; warnings: string[] }
  | { ok: false; operation: string; sessionId?: string; error: AgentError; warnings: string[] }

export function agentSuccess<T>(operation: string, data: T, warnings: string[] = []): AgentEnvelope<T> {
  return { ok: true, operation, data, warnings }
}

export function agentFailure(operation: string, code: AgentErrorCode, message: string): Extract<AgentEnvelope<never>, { ok: false }> {
  return { ok: false, operation, error: { code, message }, warnings: [] }
}

export function exitCodeForError(error: AgentError): number {
  if (error.code === 'INVALID_USAGE') return 2
  if (error.code === 'PATH_NOT_ALLOWED') return 3
  if (error.code === 'INVALID_LABEL_SPEC') return 4
  if (error.code === 'AMBIGUOUS_MODEL_TARGET' || error.code === 'MODEL_TARGET_NOT_FOUND') return 5
  if (error.code === 'BROWSER_NOT_READY') return 6
  if (error.code === 'REBUILD_FAILED') return 7
  if (error.code === 'UNSUPPORTED_CODEC') return 8
  if (error.code === 'OUTPUT_CONFLICT') return 9
  return 1
}
```

Also define bridge methods exactly as approved in the spec and keep every request/response structured-clone-safe.

- [ ] **Step 5: Run focused tests and type/build checks**

Run: `pnpm vitest run tests/agentContracts.test.ts && pnpm build`

Expected: PASS; Vite may retain the existing chunk-size and Node externalization warnings.

- [ ] **Step 6: Commit the task paths only**

```bash
git add package.json pnpm-lock.yaml src/agent/contracts.ts tests/agentContracts.test.ts
git diff --cached --check
git commit -m "feat: define label editor agent contracts"
```

---

### Task 2: Strict Label Spec v2 and v1 compatibility migration

**Files:**
- Create: `src/agent/label-spec-v2.schema.json`
- Create: `src/agent/labelSpecSchema.ts`
- Modify: `src/app/labelSpec.ts`
- Test: `tests/labelSpecV2.test.ts`
- Create: `tests/fixtures/specs/perfume-front-back-v2.json`
- Create: `tests/fixtures/specs/arabic-front-v2.json`

**Interfaces:**
- Consumes: `AgentError`, label layer/craft/print types, and current `applyStructuredLabelSpec` v1 behavior.
- Produces: `validateLabelSpec(raw, options): LabelSpecValidationResult`, `migrateLabelSpecV1(raw): LabelSpecV2`, and the JSON Schema returned by CLI `schema`.

- [ ] **Step 1: Write strict-validation and migration tests**

```ts
import { describe, expect, it } from 'vitest'
import { validateLabelSpec } from '../src/agent/labelSpecSchema'

describe('Label Spec v2', () => {
  it('accepts front/back areas and preserves explicit target selectors', () => {
    const result = validateLabelSpec({
      version: 2,
      areas: [{
        id: 'front', name: '正标', target: { meshIndex: 0 }, surfaceMode: 'overlay', side: 'front',
        range: { uStart: 0.35, uWidth: 0.3, vStart: 0.2, vHeight: 0.6 },
        layers: [{ id: 'brand', type: 'text', text: 'REALIBOX', x: 0.5, y: 0.5, width: 0.7 }],
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects unknown fields and invalid craft parameters', () => {
    const result = validateLabelSpec({ version: 2, surprise: true, areas: [] })
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.path === '/surprise')).toBe(true)
  })

  it('migrates v1 and reports inferred fields', () => {
    const result = validateLabelSpec({ version: 1, areas: [{ side: 'front', layers: [] }] })
    expect(result.ok).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('surfaceMode'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run tests/labelSpecV2.test.ts`

Expected: FAIL because the strict validator is missing.

- [ ] **Step 3: Add the strict JSON Schema**

Use draft 2020-12, top-level `additionalProperties: false`, `version: { const: 2 }`, and exact `$defs` for:

```json
{
  "$defs": {
    "target": {
      "type": "object",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {
        "stableSelector": { "type": "string", "minLength": 1 },
        "meshIndex": { "type": "integer", "minimum": 0 },
        "nodeName": { "type": "string", "minLength": 1 },
        "materialName": { "type": "string", "minLength": 1 }
      }
    },
    "range": {
      "type": "object",
      "additionalProperties": false,
      "required": ["uStart", "uWidth", "vStart", "vHeight"],
      "properties": {
        "uStart": { "type": "number", "minimum": 0, "maximum": 1 },
        "uWidth": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
        "vStart": { "type": "number", "minimum": 0, "maximum": 1 },
        "vHeight": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
      }
    }
  }
}
```

Complete the schema for text, image, every `ShapeKind`, paper, print, remap, language/direction, variables, export requests, and the six current crafts. `image.asset` must be a local asset key, never an unrestricted URL.

- [ ] **Step 4: Implement Ajv validation and deterministic v1 migration**

Compile the schema once and return JSON-pointer issue paths:

```ts
const ajv = new Ajv({ allErrors: true, strict: true })
const validateV2 = ajv.compile(labelSpecV2Schema)

export function validateLabelSpec(raw: unknown): LabelSpecValidationResult {
  const migrated = isV1(raw) ? migrateLabelSpecV1(raw) : { spec: raw, warnings: [] }
  if (!validateV2(migrated.spec)) {
    return {
      ok: false,
      issues: (validateV2.errors ?? []).map((error) => ({
        path: error.instancePath || '/',
        message: error.message ?? 'invalid value',
      })),
      warnings: migrated.warnings,
    }
  }
  return { ok: true, spec: structuredClone(migrated.spec), issues: [], warnings: migrated.warnings }
}
```

V1 migration must emit a warning for target, surface mode, range, mapping mode, print data, ids, and every default it supplies. Route `applyStructuredLabelSpec` through this validator but preserve its current v1 call signature for the UI.

- [ ] **Step 5: Add deterministic scenario fixtures**

The perfume fixture targets `meshIndex: 0`, creates `front` and `back` areas, contains text and shape layers, and requests `preview-3d`, `color`, `metalness`, `roughness`, `bump`, and `glb`. The Arabic fixture uses `language: "ar"`, `writingDirection: "rtl"`, and `fontFamily: "noto-sans-arabic"`.

- [ ] **Step 6: Run schema tests and existing structured-import coverage**

Run: `pnpm vitest run tests/labelSpecV2.test.ts tests/capabilityGaps.test.ts`

Expected: PASS with no Ajv strict-mode warnings.

- [ ] **Step 7: Commit the task paths only**

```bash
git add src/agent/label-spec-v2.schema.json src/agent/labelSpecSchema.ts src/app/labelSpec.ts tests/labelSpecV2.test.ts tests/fixtures/specs
git diff --cached --check
git commit -m "feat: add strict label spec v2"
```

---

### Task 3: Stable model inspection and target resolution

**Files:**
- Create: `src/agent/modelInspection.ts`
- Create: `src/agent/targetResolver.ts`
- Modify: `src/glb/analyze.ts`
- Test: `tests/agentTargetResolver.test.ts`

**Interfaces:**
- Consumes: `readGlb`, `buildPartTree`, geometry accessors, and v2 `target` objects.
- Produces: `inspectModel(bytes, name): Promise<ModelInspection>` and `resolveAreaTargets(spec, inspection): TargetResolutionResult`.

- [ ] **Step 1: Write resolution tests**

```ts
import { describe, expect, it } from 'vitest'
import { resolveTarget } from '../src/agent/targetResolver'

const meshes = [
  { stableSelector: 'mesh:0/node:2', meshIndex: 0, nodeName: 'Bottle', materialNames: ['Glass'] },
  { stableSelector: 'mesh:1/node:4', meshIndex: 1, nodeName: 'Bottle', materialNames: ['Label'] },
]

describe('Agent target resolution', () => {
  it('prefers the inspected stable selector', () => {
    expect(resolveTarget({ stableSelector: 'mesh:1/node:4' }, meshes).meshIndex).toBe(1)
  })
  it('rejects duplicate node names', () => {
    expect(() => resolveTarget({ nodeName: 'Bottle' }, meshes)).toThrow(/ambiguous/i)
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run tests/agentTargetResolver.test.ts`

Expected: FAIL because target resolution does not exist.

- [ ] **Step 3: Implement stable inspection records**

Generate selectors from immutable glTF indices, not display labels:

```ts
export function stableMeshSelector(meshIndex: number, nodeIndex: number): string {
  return `mesh:${meshIndex}/node:${nodeIndex}`
}
```

`inspectModel` returns SHA-256 fingerprint, model dimensions, codec/features, part tree, stable mesh records, label candidates, mapping suggestion (`planar` or `cylindrical`), geometry quality, and warnings. Extend `buildPartTree` only to expose stable source indices already present in the document; do not change human display names.

- [ ] **Step 4: Implement exact target precedence and ambiguity errors**

Resolution order is `stableSelector`, `meshIndex`, exact `nodeName`, exact `materialName`. A selector must resolve to exactly one mesh. Return `MODEL_TARGET_NOT_FOUND` for zero matches and `AMBIGUOUS_MODEL_TARGET` with candidate selectors for multiple matches.

- [ ] **Step 5: Run focused and GLB analysis tests**

Run: `pnpm vitest run tests/agentTargetResolver.test.ts tests/glb.test.ts tests/labelCandidate.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the task paths only**

```bash
git add src/agent/modelInspection.ts src/agent/targetResolver.ts src/glb/analyze.ts tests/agentTargetResolver.test.ts
git diff --cached --check
git commit -m "feat: inspect and resolve label targets"
```

---

### Task 4: Transactional label application

**Files:**
- Create: `src/agent/transactionalApply.ts`
- Modify: `src/state/stores.ts`
- Modify: `src/app/actions.ts`
- Test: `tests/transactionalApply.test.ts`

**Interfaces:**
- Consumes: normalized `LabelSpecV2`, resolved targets, `restoreImportedAreaRuntime`, and label store state.
- Produces: `prepareLabelSpecTransaction(...)`, `commitLabelSpecTransaction(...)`, and store mutation `replaceAreasAtomically(nextAreas, activeRuntime)`.

- [ ] **Step 1: Write a failing all-or-nothing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLabelSpecTransaction } from '../src/agent/transactionalApply'
import { useLabelStore } from '../src/state/stores'

describe('transactional Label Spec apply', () => {
  beforeEach(() => useLabelStore.getState().clearAll())

  it('does not alter existing areas when the second runtime restore fails', async () => {
    useLabelStore.getState().addArea(existingArea)
    const before = useLabelStore.getState().areas
    await expect(applyLabelSpecTransaction(input, {
      restoreRuntime: vi.fn().mockResolvedValueOnce(frontRuntime).mockRejectedValueOnce(new Error('bad back')),
    })).rejects.toThrow('bad back')
    expect(useLabelStore.getState().areas).toBe(before)
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run tests/transactionalApply.test.ts`

Expected: FAIL because transactional apply is missing.

- [ ] **Step 3: Add one atomic store mutation**

Add this mutation to `LabelState` and its Zustand implementation:

```ts
replaceAreasAtomically: (
  areas: LabelAreaConfig[],
  activeAreaId: string,
  runtime: { remapOutput: RemapOutput; meshAccessors: MeshAccessors },
) => void
```

The implementation performs one `set(...)`, clears stale bakes and selection, activates the requested area, and increments `activations` once.

- [ ] **Step 4: Prepare every area before committing**

```ts
export async function prepareLabelSpecTransaction(input: ApplyTransactionInput): Promise<PreparedTransaction> {
  const validation = validateLabelSpec(input.rawSpec)
  if (!validation.ok) throw invalidSpecError(validation.issues)
  const targets = resolveAreaTargets(validation.spec, input.inspection)
  const areas = await buildAreasWithoutStoreMutation(validation.spec, targets, input.glbBytes)
  const runtimes = []
  for (const area of areas) runtimes.push(await input.restoreRuntime(input.glbBytes, area))
  return { areas: areas.map((area, index) => ({ ...area, remap: runtimes[index].remap })), runtimes, warnings: validation.warnings }
}
```

Only `commitLabelSpecTransaction` calls `replaceAreasAtomically`. Update `importStructuredLabelSpec` to use the same transaction after reading the file.

- [ ] **Step 5: Run transaction and area lifecycle tests**

Run: `pnpm vitest run tests/transactionalApply.test.ts tests/areaOverlayLifecycle.test.ts tests/modelLoader.test.ts`

Expected: PASS and existing front/back behavior remains unchanged.

- [ ] **Step 6: Commit the task paths only**

```bash
git add src/agent/transactionalApply.ts src/state/stores.ts src/app/actions.ts tests/transactionalApply.test.ts
git diff --cached --check
git commit -m "fix: apply label specs transactionally"
```

---

### Task 5: Byte-producing artifact services

**Files:**
- Create: `src/agent/artifactExport.ts`
- Modify: `src/app/actions.ts`
- Modify: `src/app/areaExporter.ts`
- Modify: `src/glb/rebuild.ts`
- Test: `tests/artifactExport.test.ts`

**Interfaces:**
- Consumes: current bake ownership/readiness checks, `prepareAllAreas`, `exportGlb`, project serialization, and print manifests.
- Produces: `createChannelArtifacts`, `createProjectArtifact`, `createPrintArtifacts`, `createGlbArtifact`, and `createExportBundle` returning bytes/descriptors without downloads.

- [ ] **Step 1: Write failing service/adapter separation tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createProjectArtifact } from '../src/agent/artifactExport'

describe('artifact export services', () => {
  it('returns bytes without touching the browser download adapter', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const artifact = createProjectArtifact('model.glb', [area])
    expect(artifact.mimeType).toBe('application/json')
    expect(JSON.parse(new TextDecoder().decode(artifact.bytes)).version).toBe(3)
    expect(click).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run tests/artifactExport.test.ts --environment jsdom`

Expected: FAIL because `artifactExport.ts` does not exist.

- [ ] **Step 3: Extract immutable export preparation from UI actions**

Move snapshot capture, font waiting, bake freezing, model ownership checks, and area preparation into exported service functions. Keep the identity checks intact; do not weaken current protection against edits during export.

Use this artifact shape:

```ts
export interface BrowserArtifact {
  id: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
  width?: number
  height?: number
  areaId?: string
  channel?: 'color' | 'metalness' | 'roughness' | 'bump' | 'preview'
}
```

- [ ] **Step 4: Implement the complete export bundle**

`createExportBundle` returns project JSON, normalized spec JSON, per-area raw Color/Metalness/Roughness/Bump PNGs, print manifests, preview PNG when requested, and labeled GLB with cross-check metadata. Preserve packed metal/rough and normal-map generation for GLB reconstruction while also returning separate raw channels.

- [ ] **Step 5: Reduce toolbar actions to adapters**

`exportPng`, `exportGlbFile`, `exportProject`, and `exportPrintManifest` call the new service, then use `downloadBytes` and `flashToast`. No service function calls `downloadBytes`, `document.createElement('a')`, or `flashToast`.

- [ ] **Step 6: Run export regression tests**

Run:

```bash
pnpm vitest run tests/artifactExport.test.ts tests/exportReadiness.test.ts tests/export-roundtrip.test.ts tests/rebuildCrossCheckIdentity.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the task paths only**

```bash
git add src/agent/artifactExport.ts src/app/actions.ts src/app/areaExporter.ts src/glb/rebuild.ts tests/artifactExport.test.ts
git diff --cached --check
git commit -m "refactor: expose label artifact services"
```

---

### Task 6: Guarded browser Agent Bridge and deterministic preview

**Files:**
- Create: `src/agent/bridge.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/scene/Viewport.tsx`
- Test: `tests/agentBridge.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 contracts, model inspection/loading, transactional apply, export services, font/image readiness, and Viewport render capture.
- Produces: guarded `installAgentBridge()`, bridge lifecycle, and preview capture registration.

- [ ] **Step 1: Write guard and protocol tests**

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { installAgentBridge } from '../src/agent/bridge'

describe('browser Agent Bridge', () => {
  afterEach(() => delete (window as Window & { __GLB_LABEL_EDITOR_AGENT_V1__?: unknown }).__GLB_LABEL_EDITOR_AGENT_V1__)

  it('does not register without loopback agent mode and token', () => {
    installAgentBridge({ location: new URL('https://example.com/?agent=1&token=x'), expectedToken: 'x' })
    expect('__GLB_LABEL_EDITOR_AGENT_V1__' in window).toBe(false)
  })

  it('registers on loopback only when tokens match', () => {
    const dispose = installAgentBridge({ location: new URL('http://127.0.0.1:4178/?agent=1&token=x'), expectedToken: 'x' })
    expect(window.__GLB_LABEL_EDITOR_AGENT_V1__).toBeDefined()
    dispose()
    expect(window.__GLB_LABEL_EDITOR_AGENT_V1__).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run tests/agentBridge.test.ts --environment jsdom`

Expected: FAIL because the bridge is missing.

- [ ] **Step 3: Implement the three-part bridge guard**

```ts
function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

export function canInstallAgentBridge(url: URL, expectedToken: string): boolean {
  return isLoopback(url.hostname)
    && url.searchParams.get('agent') === '1'
    && expectedToken.length >= 32
    && url.searchParams.get('token') === expectedToken
}
```

The expected token comes from a session bootstrap endpoint fetched from the same origin; never accept the query token as both presented and expected value.

- [ ] **Step 4: Implement every bridge method**

`reset`, `loadModel`, `applySpec`, `getProject`, `validateDesign`, `waitForReady`, `renderPreview`, and `exportArtifacts` call domain services directly. Requests refer to tokenized same-origin asset URLs. Responses contain artifact descriptors/URLs rather than GLB or PNG base64.

- [ ] **Step 5: Add deterministic preview registration**

`Viewport` registers `capturePreview({ width, height, view }) => Promise<Blob>` after the renderer is ready, renders one frame at the requested dimensions, restores the canvas size, and unregisters on unmount. `App` renders the same viewport in Agent mode even when the human UI is in 2D.

- [ ] **Step 6: Install and dispose the bridge from App**

Use one `useEffect` in `App`; normal human URLs do not fetch a session token and do not expose the global.

- [ ] **Step 7: Run bridge, viewport, and readiness tests**

Run:

```bash
pnpm vitest run tests/agentBridge.test.ts tests/viewportLoadContinuation.test.ts tests/exportReadiness.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the task paths only**

```bash
git add src/agent/bridge.ts src/app/App.tsx src/scene/Viewport.tsx tests/agentBridge.test.ts
git diff --cached --check
git commit -m "feat: expose guarded label editor bridge"
```

---

### Task 7: Secure local session server, browser lifecycle, and codec preflight

**Files:**
- Create: `scripts/lib/envelope.mjs`
- Create: `scripts/lib/files.mjs`
- Create: `scripts/lib/session-server.mjs`
- Create: `scripts/lib/browser-session.mjs`
- Create: `scripts/lib/codec.mjs`
- Create: `scripts/plugin-runtime.mjs`
- Test: `tests/pluginSecurity.test.ts`

**Interfaces:**
- Consumes: built Vite editor, Agent envelopes, Playwright Chromium, workspace roots, and bridge methods.
- Produces: `createPluginRuntime(options)`, `runtime.createSession`, `runtime.callBridge`, `runtime.publishArtifacts`, and `inspectCodec`/`normalizeGlb`.

- [ ] **Step 1: Write path, token, conflict, and codec tests**

```ts
import { describe, expect, it } from 'vitest'
import { resolveAllowedPath, sanitizeArtifactName } from '../scripts/lib/files.mjs'
import { inspectCodec } from '../scripts/lib/codec.mjs'

describe('plugin runtime security', () => {
  it('rejects traversal outside explicit roots', () => {
    expect(() => resolveAllowedPath('/workspace', '../secret')).toThrow(/outside allowed root/i)
  })
  it('sanitizes artifact names', () => {
    expect(sanitizeArtifactName('../../front label.png')).toBe('front-label.png')
  })
  it('reports unsupported meshopt explicitly', async () => {
    expect((await inspectCodec(meshoptFixture)).blocker?.code).toBe('UNSUPPORTED_CODEC')
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run tests/pluginSecurity.test.ts`

Expected: FAIL because runtime modules do not exist.

- [ ] **Step 3: Implement filesystem and envelope helpers**

`resolveAllowedPath` compares `realpath` values against explicit roots. Publishing uses a sibling `.<name>.<session>.tmp` directory, writes all files with `wx`, verifies hashes, then renames it to the final path. If final output exists and force is false, return `OUTPUT_CONFLICT`; with force, rename the existing directory to a session backup, publish, then remove the backup only after success.

- [ ] **Step 4: Implement the loopback token server**

Bind to `127.0.0.1` on an OS-assigned port. Routes are:

```text
GET /session/<id>/bootstrap?token=<token>
GET /session/<id>/asset/<asset-id>?token=<token>
PUT /session/<id>/artifact/<artifact-id>?token=<token>
GET /editor/*
```

Validate session id, random 32-byte token with `timingSafeEqual`, asset ownership, method, byte limit, and MIME allowlist on every session route. Set `Cache-Control: no-store` and `Content-Security-Policy: default-src 'self' blob: data:`.

- [ ] **Step 5: Implement Playwright session lifecycle**

Launch plugin-owned Chromium headless by default, create one isolated context per session, open `/editor/?agent=1&session=<id>&token=<token>`, wait for the bridge global, and call methods with `page.evaluate`. Close page/context on dispose and close the browser/server when the runtime shuts down.

- [ ] **Step 6: Implement codec inspection and Draco normalization**

Read the GLB JSON chunk before browser launch. Standard GLB passes unchanged. If `KHR_draco_mesh_compression` is present, use glTF Transform NodeIO with Draco dependencies to write a temporary uncompressed GLB while preserving hierarchy, names, materials, transforms, and animations. If `EXT_meshopt_compression`, KTX2/Basis, or external glTF resources are present, return `UNSUPPORTED_CODEC` with the exact extension. Record `sourceCompressed`, `normalized`, and `outputCompressed` in session metadata.

- [ ] **Step 7: Assemble the reusable plugin runtime**

```js
export async function createPluginRuntime(options = {}) {
  const server = await createSessionServer(options)
  const browser = await createBrowserSessionManager({ server })
  return {
    createSession: (input) => server.createSession(input),
    callBridge: (session, method, input) => browser.call(session, method, input),
    publishArtifacts: (session, output, artifacts, force) => publishAtomically(output, artifacts, force),
    close: async () => { await browser.close(); await server.close() },
  }
}
```

- [ ] **Step 8: Run runtime security tests and build**

Run: `pnpm vitest run tests/pluginSecurity.test.ts && pnpm build`

Expected: PASS.

- [ ] **Step 9: Commit the task paths only**

```bash
git add scripts/lib/envelope.mjs scripts/lib/files.mjs scripts/lib/session-server.mjs scripts/lib/browser-session.mjs scripts/lib/codec.mjs scripts/plugin-runtime.mjs tests/pluginSecurity.test.ts
git diff --cached --check
git commit -m "feat: add secure label plugin runtime"
```

---

### Task 8: Shared operations and JSON CLI

**Files:**
- Create: `scripts/lib/operations.mjs`
- Create: `scripts/label-cli.mjs`
- Test: `tests/cliProtocol.test.ts`

**Interfaces:**
- Consumes: `createPluginRuntime`, Label Spec schema, bridge operations, and atomic publisher.
- Produces: `createOperations(runtime)`, executable `label-cli`, commands `schema`, `inspect`, `validate`, `apply`, `preview`, `export`, and `open`.

- [ ] **Step 1: Write CLI protocol tests with an injected fake runtime**

```ts
import { describe, expect, it } from 'vitest'
import { runCli } from '../scripts/label-cli.mjs'

describe('label-cli protocol', () => {
  it('writes exactly one JSON result to stdout', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runCli(['inspect', 'model.glb', '--json'], {
      operations: { inspect: async () => ({ ok: true, operation: 'inspect_model', data: { meshes: [] }, warnings: [] }) },
      stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value),
    })
    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(() => JSON.parse(stdout[0])).not.toThrow()
  })

  it('maps validation failures to exit code 4', async () => {
    const code = await runCli(['validate', 'bad.json', '--json'], validationFailureDeps)
    expect(code).toBe(4)
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run tests/cliProtocol.test.ts`

Expected: FAIL because the CLI module is missing.

- [ ] **Step 3: Implement shared operations**

`inspect` creates a session, loads the model through the bridge, and returns `ModelInspection`. `validate` parses inline/path spec, validates schema/assets/targets, and makes no writes. `apply` performs the 13-stage transaction from the design spec, requests all default artifacts, independently reparses the GLB, verifies hashes, then publishes. `preview`, `export`, and `open` reuse or create a session from a project/spec reference.

- [ ] **Step 4: Implement strict CLI parsing**

Support exactly:

```text
label-cli schema [--json]
label-cli inspect <model.glb> [--json]
label-cli validate <spec.json> [--glb model.glb] [--json]
label-cli apply <spec.json> --glb model.glb --output <dir> [--force] [--open] [--json]
label-cli preview <project-or-spec> --glb model.glb --output <png> [--view 2d|split|3d]
label-cli export <project.lbl.json> --glb model.glb --output <dir> [--force] [--json]
label-cli open <project-or-spec> --glb model.glb
```

Unknown commands/options are `INVALID_USAGE`. In JSON mode call stdout once with `JSON.stringify(envelope)`; all phase logs use stderr. Install `SIGINT`, `SIGTERM`, and `beforeExit` cleanup without writing a second envelope.

- [ ] **Step 5: Run CLI protocol and security tests**

Run: `pnpm vitest run tests/cliProtocol.test.ts tests/pluginSecurity.test.ts`

Expected: PASS.

- [ ] **Step 6: Smoke-test the executable schema command**

Run: `node scripts/label-cli.mjs schema --json > /tmp/glb-label-schema-result.json && node -e "const x=require('/tmp/glb-label-schema-result.json'); if(!x.ok) process.exit(1)"`

Expected: exit `0`, one valid JSON envelope.

- [ ] **Step 7: Commit the task paths only**

```bash
git add scripts/lib/operations.mjs scripts/label-cli.mjs tests/cliProtocol.test.ts
git diff --cached --check
git commit -m "feat: add agent label CLI"
```

---

### Task 9: MCP server and Codex plugin packaging

**Files:**
- Create: `scripts/mcp-server.mjs`
- Create: `.mcp.json`
- Create: `.codex-plugin/plugin.json`
- Create: `skills/cosmetic-label-editor/SKILL.md`
- Test: `tests/mcpProtocol.test.ts`

**Interfaces:**
- Consumes: Task 8 operations and MCP SDK stdio transport.
- Produces: six MCP tools and an installable/valid Codex plugin root.

- [ ] **Step 1: Write MCP tool registration tests**

```ts
import { describe, expect, it } from 'vitest'
import { createLabelMcpServer } from '../scripts/mcp-server.mjs'

describe('label editor MCP surface', () => {
  it('registers only the six coarse tools', () => {
    const server = createLabelMcpServer({ operations: fakeOperations })
    expect(server.registeredToolNames()).toEqual([
      'inspect_model', 'validate_label_spec', 'apply_label_spec',
      'render_label_preview', 'export_label_assets', 'open_label_editor',
    ])
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run tests/mcpProtocol.test.ts`

Expected: FAIL because the MCP server module is missing.

- [ ] **Step 3: Implement the MCP stdio server**

Use `McpServer` and `StdioServerTransport`. Each tool has a strict SDK input schema, invokes one shared operation, and returns both readable text and `structuredContent` containing the same Agent envelope. Internal stacks go only to stderr. Close runtime on transport shutdown.

- [ ] **Step 4: Add the MCP launch configuration**

Create `.mcp.json`:

```json
{
  "mcpServers": {
    "glb-label-editor": {
      "command": "node",
      "args": ["./scripts/mcp-server.mjs"],
      "cwd": "."
    }
  }
}
```

- [ ] **Step 5: Add the Codex plugin manifest**

Create `.codex-plugin/plugin.json` with validated required values:

```json
{
  "name": "glb-label-editor",
  "version": "0.2.0",
  "description": "Agent-driven GLB cosmetic label design, preview, print validation, and export",
  "author": { "name": "Realibox" },
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "GLB Label Editor",
    "shortDescription": "Design and export cosmetic labels on GLB packaging",
    "longDescription": "Inspect packaging GLBs, apply structured front/back/wrap label designs, preview craft effects, validate print data, and export PNG/PBR assets plus labeled GLB files.",
    "developerName": "Realibox",
    "category": "Design",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Inspect this GLB and recommend label surfaces.",
      "Apply this label spec and export a labeled GLB.",
      "Open the label editor so I can review the result."
    ],
    "brandColor": "#356AE6"
  }
}
```

- [ ] **Step 6: Write the plugin skill**

The skill frontmatter name is `cosmetic-label-editor`. It routes GLB label/design/export requests to the MCP tools, uses `inspect_model` before inventing selectors, prefers one-shot `apply_label_spec`, treats validation and print issues as explicit warnings/blockers, never claims press-ready PDF/AI output, and uses `open_label_editor` only for human review/takeover.

- [ ] **Step 7: Run MCP and plugin validators**

Run:

```bash
pnpm vitest run tests/mcpProtocol.test.ts
python3 /Users/apple/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/cosmetic-label-editor
python3 /Users/apple/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Expected: all three commands PASS. `plugin.json` contains `mcpServers` because `.mcp.json` exists and contains no `apps` field because `.app.json` does not exist.

- [ ] **Step 8: Commit the task paths only**

```bash
git add scripts/mcp-server.mjs .mcp.json .codex-plugin/plugin.json skills/cosmetic-label-editor/SKILL.md tests/mcpProtocol.test.ts
git diff --cached --check
git commit -m "feat: package label editor as Codex plugin"
```

---

### Task 10: Real browser end-to-end delivery and documentation

**Files:**
- Create: `tests/pluginE2E.test.ts`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: complete CLI/MCP/plugin/runtime stack and real cosmetic GLBs supplied in local test environment.
- Produces: verified one-command delivery, install/use documentation, and final regression evidence.

- [ ] **Step 1: Write the failing browser end-to-end test**

```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/label-cli.mjs'

describe('GLB label plugin E2E', () => {
  it('applies front/back design and publishes a complete verified output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-e2e-'))
    const output = path.join(root, 'result')
    const code = await runCli([
      'apply', 'tests/fixtures/specs/perfume-front-back-v2.json',
      '--glb', process.env.GLB_LABEL_E2E_MODEL!, '--output', output, '--json',
    ], realCliDependencies())
    expect(code).toBe(0)
    for (const file of ['labeled.glb', 'project.lbl.json', 'label-spec.normalized.json', 'print-manifest.json', 'preview-3d.png', 'manifest.json']) {
      expect((await stat(path.join(output, file))).size).toBeGreaterThan(0)
    }
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'))
    expect(manifest.glbCrossCheck.loaded).toBe(true)
    expect(manifest.glbCrossCheck.uvSampleOk).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test against the required perfume GLB and verify the first failing phase**

Run:

```bash
GLB_LABEL_E2E_MODEL=/Users/apple/realibox/cosmetic-bottles-glb/02_perfume_glass_with_cap.glb pnpm test:plugin-e2e
```

Expected before final fixes: FAIL at the first incomplete runtime/artifact phase, not by clicking or querying a DOM element.

- [ ] **Step 3: Complete the end-to-end artifact manifest assertions**

The test additionally verifies:

- every per-area Color/Metalness/Roughness/Bump file exists and matches its SHA-256;
- the input GLB hash is unchanged;
- project metadata is embedded and reparses;
- the published directory did not exist until the operation succeeded;
- a second run returns exit code `9` without `--force`;
- `--force` succeeds atomically;
- an invalid spec leaves no output directory;
- browser console/page errors are empty;
- `open` returns a loopback takeover URL for the same session.

- [ ] **Step 4: Add a Draco case or explicit blocker fixture**

If a local Draco GLB is available, assert normalization and successful output. Otherwise commit a minimal GLB JSON-chunk fixture declaring `KHR_draco_mesh_compression` and assert the codec path reports a tested blocker until the decoder dependency is configured; do not silently mark the case successful.

- [ ] **Step 5: Rewrite README as plugin-first documentation**

Document:

```text
pnpm install
pnpm exec playwright install chromium
pnpm build
node scripts/label-cli.mjs inspect model.glb --json
node scripts/label-cli.mjs apply spec.json --glb model.glb --output result --json
```

List all six MCP tools, CLI commands, Label Spec v2/schema discovery, output tree, exit codes, supported label/craft scenarios, security defaults, human takeover URL, codec limits, and standalone `pnpm dev` as a developer workflow. Remove the old statement that the repository is not a DSH/Codex plugin.

- [ ] **Step 6: Run the full verification matrix**

Run:

```bash
pnpm test
pnpm build
GLB_LABEL_E2E_MODEL=/Users/apple/realibox/cosmetic-bottles-glb/02_perfume_glass_with_cap.glb pnpm test:plugin-e2e
python3 /Users/apple/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/cosmetic-label-editor
python3 /Users/apple/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
git diff --check
```

Expected: all tests/build/validators PASS; only previously documented Vite chunk/externalization warnings may remain.

- [ ] **Step 7: Inspect the final scoped diff and commit**

```bash
git status --short
git diff -- README.md package.json tests/pluginE2E.test.ts
git add README.md package.json tests/pluginE2E.test.ts
git diff --cached --check
git commit -m "docs: complete Codex label plugin delivery"
```

- [ ] **Step 8: Record delivery evidence without pushing**

Run:

```bash
git log --oneline -12
git status --short
```

Expected: task commits are present; unrelated pre-existing working-tree paths remain unstaged. Do not push unless the user separately asks for delivery to a remote.

---

## Self-Review Results

- Spec coverage: plugin root, strict v2/v1 migration, model inspection/selectors, transactional import, byte artifacts, guarded bridge, local runtime, codec path, CLI, six MCP tools, plugin skill, atomic publishing, security, browser E2E, and documentation all map to Tasks 1–10.
- Type consistency: `AgentEnvelope<T>`, `LabelEditorAgentBridgeV1`, `ModelInspection`, `PreparedTransaction`, `BrowserArtifact`, `createPluginRuntime`, and `createOperations` are introduced before their consumers and retain the same names throughout.
- Dirty-tree safety: each task stages explicit paths, checks the staged diff, and never stages the entire repository.
- Delivery boundary: the plan creates no `.app.json`, marketplace file, remote push, or press-ready PDF/AI claim.
