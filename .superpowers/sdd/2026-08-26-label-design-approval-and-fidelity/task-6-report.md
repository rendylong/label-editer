# Task 6 Report — Carrier-aware rendering and readiness

Date: 2026-08-27 CST
Branch: `codex/label-design-approval-fidelity`
Base commit: `0ff967b99a7978ef71e2ba59988a49d231dc7365`
Implementation commit: `935bcf4` (`feat: render canonical label carriers`)

## Outcome

Implemented a typed carrier surface resolver shared by clean `LabelCanvas` rendering and carrier-specific readiness. Canonical carrier projects no longer inherit the legacy paper panel by accident; `bare` suppresses substrate, decorative color geometry, global craft post-processing, and layer PBR contributions. Existing projects without `carrier` still use the unchanged `resolveLabelPaper()` values and the legacy single-rectangle path.

Readiness now distinguishes carrier applicability prompts from carrier invariant conflicts. Each applicability prompt carries `status: "unverified"`; none is a claim that ink, foil, adhesive, die cutting, registration, abrasion, curvature, film, or supplier feasibility has been physically validated.

## TDD evidence

### RED 1 — canonical carrier API and paper-only readiness split

Command:

```text
pnpm vitest run tests/carrierBehavior.test.ts tests/labelPaper.test.ts tests/exportReadiness.test.ts
```

Observed expected failure:

```text
Test Files  3 failed (3)
Tests       17 failed | 19 passed (36)
```

The failures named the missing `resolveCarrierSurface()` and `carrierReadinessChecks()` functions and showed that direct, clear, in-mold, foil/ink-only, and bare still received `missing-print-spec`.

### RED 2 — declared separations and bare validation isolation

Command:

```text
pnpm vitest run tests/carrierBehavior.test.ts
```

Observed expected failure:

```text
Test Files  1 failed (1)
Tests       3 failed | 15 passed (18)
```

The failures proved three missing behaviors: a declared hot-foil process spot name did not satisfy foil identity, a carrier-aware manifest dropped `printSpec.spotColors`, and invalid bare artwork leaked a foil readiness warning beyond its structured carrier conflict.

### RED 3 — exact legacy readiness compatibility

Command:

```text
pnpm vitest run tests/labelPaper.test.ts
```

Observed expected failure:

```text
Test Files  1 failed (1)
Tests       1 failed | 3 passed (4)
```

The failure showed that a no-carrier project without `printSpec` had gained `areaId` plus a foil warning instead of returning the original single `missing-print-spec` object.

## Carrier behavior/check matrix

| Carrier | Clean substrate/panel | Decoration | Unverified applicable checks | Invariant handling |
| --- | --- | --- | --- | --- |
| `direct_surface_print` | None; conflicting substrate is ignored by rendering | Declared layers over transparency | ink adhesion, opacity, curvature, registration, rub resistance; white underbase only when a layer declares it | `carrier-forbidden-substrate` names the area and `substrate` field |
| `applied_label` | Declared opaque substrate and rectangle/rounded/ellipse/custom boundary | Declared layers above substrate | bleed, die cut, edge adhesion | missing/wrong opaque substrate and missing boundary are structured issues |
| `clear_label` | No opaque clean-review panel; transparent film extent remains diagnostic metadata | Declared ink/process layers over transparency | film extent, registration, edge adhesion; selective white underbase only when declared | missing/non-transparent substrate is a structured issue |
| `in_mold` | None | Declared layers over transparency | in-mold process compatibility and registration | forbidden substrate is ignored and reported |
| `foil_or_ink_only` | None | Only declared decorative layers | registration and declared-process verification | forbidden substrate is ignored and reported |
| `bare` | None | Suppressed from color bake and PBR layer/global-craft bake | none | any serialized decoration becomes only `decoration-on-bare` |
| Legacy, enabled paper | Original single full-canvas paper rectangle with original color/opacity | Preserved | Original paper/print readiness | no migration or serialized-field removal |
| Legacy, disabled/missing paper | Transparent | Preserved | Original legacy readiness | no migration or serialized-field removal |

## Compatibility proof

- `resolveLabelPaper()` is unchanged.
- No-carrier projects resolve the exact same enabled/color/opacity values and still render through one `KRect`; disabled/missing paper remains transparent.
- The legacy no-`printSpec` path again returns exactly the original single `{ code, message }` object and does not run later foil checks.
- Legacy manifests with a real `printSpec` retain physical dimensions and the existing `color`, `metalness`, `roughness`, `bump`, print spot, and foil separations.
- Existing rendering, project schema, Label Spec v2, artifact export, capability, browser runtime, and plugin E2E tests all pass.

## Scope and implementation notes

- Changed only the planned production files: `src/label/paper.ts`, `src/label/LabelCanvas.tsx`, `src/label/printReadiness.ts`, and `src/label/exportReadiness.ts`.
- Added the planned `tests/carrierBehavior.test.ts` and extended the planned legacy/export readiness tests.
- No browser runtime source expansion was required: its existing public `validatePrintReadiness()` integration now receives carrier-aware issues and prompts automatically.
- `PrintManifest` physical fields are nullable only for explicit carrier projects lacking `printSpec`; this avoids fabricating paper dimensions or throwing for `bare`. Legacy missing-`printSpec` manifest behavior still throws as before.
- Carrier-aware separations are derived only from declared process masks/spot names, explicit print spot colors, and declared foil craft names. `bare` always emits an empty separation set.
- A custom applied-label boundary is passed to Konva as declared path data; no supplier/tooling feasibility is inferred from the preview.

## Verification

Focused GREEN:

```text
pnpm vitest run tests/carrierBehavior.test.ts tests/labelPaper.test.ts tests/exportReadiness.test.ts tests/renderingFidelity.test.ts tests/capabilityGaps.test.ts tests/agentBrowserRuntime.test.ts
Test Files  6 passed (6)
Tests       132 passed (132)
```

Additional affected integration suite:

```text
pnpm vitest run tests/capabilityGaps.test.ts tests/agentBrowserRuntime.test.ts tests/artifactExport.test.ts tests/labelSpecV2.test.ts tests/projectSchema.test.ts tests/labelImageReadiness.test.ts
Test Files  6 passed (6)
Tests       97 passed (97)
```

Full suite:

```text
pnpm test
Test Files  69 passed (69)
Tests       852 passed | 1 skipped (853)
```

Production build:

```text
pnpm build
PASS — TypeScript and Vite production build completed.
```

Vite printed its existing browser externalization, mixed static/dynamic import, and large-chunk warnings; there were no build errors.

Dedicated plugin browser E2E:

```text
pnpm test:plugin-e2e
Test Files  1 passed (1)
Tests       1 passed | 1 skipped (2)
```

Diff hygiene:

```text
git diff --check
PASS
```

## Self-review

- Confirmed direct/in-mold/foil/bare cannot render a substrate even when conflicting data remains serialized for diagnosis.
- Confirmed clear film diagnostics never leak an opaque rectangle into clean capture.
- Confirmed `bare` suppresses ordinary layers, global craft color post-processing, layer masks, and text-overflow production checks.
- Confirmed white underbase is driven only by declared per-layer process intent/required mask, not paper color or white geometry.
- Confirmed the browser path receives structured area/field conflicts and unverified carrier prompts without treating warnings as blocking certification.
- Confirmed no unrelated files or generated validator changes are present.

## Non-certified assumptions

The implementation only determines render semantics, declared separations, and validation prompts. It does not certify ink adhesion or opacity, rub/abrasion resistance, curvature limits, registration, foil behavior, adhesive/film edges, bleed, die cutting, in-mold compatibility, tooling, supplier capability, or press readiness. Those remain physical production and supplier-review tasks.

## Fix round 1

### Review findings and RED evidence

The first review found five carrier-fidelity defects: unconditional paper-like PBR masks, loss of legacy enabled-paper appearance after project migration, fabricated rectangle fallback for invalid custom boundaries, a manifest-only white-underbase declaration without raster output, and zero-opacity applied substrates being accepted.

The regression-first command was:

```text
pnpm vitest run tests/carrierBehavior.test.ts tests/carrierMask.test.ts tests/carrierExport.test.ts tests/projectSchema.test.ts tests/exportOverlay.test.ts
Test Files  5 failed (5)
Tests       24 failed | 66 passed (90)
```

During final self-review, a sixth regression exposed that substrate-backed applied labels retained PBR but missed a declared white-underbase raster:

```text
pnpm vitest run tests/carrierMask.test.ts
Test Files  1 failed (1)
Tests       1 failed | 8 passed (9)
```

Both RED runs failed for the intended missing behavior before production changes were made.

### Implemented corrections

| Review defect | Correction and compatibility behavior |
| --- | --- |
| Carrier-free PBR | `renderCarrierMasks()` now emits no material/process canvas for ordinary direct, clear, in-mold, foil/ink-only, or bare artwork. Carrier-free craft masks are allocated only for declared contributors and begin with channel-neutral pixels. Applied and legacy substrate-backed labels retain the prior full mask set. Export, GLB rebuild, scene preview, PNG artifacts, and bake storage now treat PBR channels as optional; absent channels are neither encoded nor attached. |
| Legacy enabled paper | Parsing records runtime provenance only when an absent serialized carrier is migrated from enabled legacy paper. The resolver uses the exact legacy paper color/opacity path for that provenance, while explicitly authored applied-label data still requires canonical substrate and boundary. Serialization omits the migration-only carrier/marker so reparse preserves the fallback without weakening canonical invariants. |
| Physical boundary | Rectangle, rounded rectangle, ellipse, and bounded closed custom SVG boundaries resolve explicitly. Missing, malformed, open, or zero-area custom paths render no substrate and produce an area/field-specific `invalid-custom-boundary` issue. Clear film requires its own boundary; no custom path falls back to a rectangle. |
| White underbase | A declared per-layer white-underbase process now creates an optional selective raster channel for both carrier-free and substrate-backed designs. It propagates through `BakeResult`, PNG artifact export, artifact descriptors, and print manifests. `white-underbase.png` is emitted only when real channel pixels exist, and the manifest lists the separation only when the bake contains that channel. White color or paper never implies it. |
| Applied opacity zero | An explicit opaque applied substrate with opacity `0` renders no panel and produces `invalid-applied-substrate-opacity` on `substrate.opacity`. |

### Scope expansion

Review-authorized expansion was required beyond the original rendering/readiness files:

- shared bake/store contracts and scene preview now accept optional PBR channels plus the optional white-underbase production separation;
- area/GLB export omits absent material texture data and uses a non-metallic material factor when no metal-rough texture exists;
- artifact export and browser artifact descriptors identify the real `white_underbase` PNG channel;
- project parsing/serialization carries runtime-only legacy migration provenance;
- new `carrierMask` and `carrierExport` tests cover raster pixels, encoder calls, omitted exporter fields, and artifact identity.

The white-underbase channel is a production separation artifact only. It is deliberately not connected to the GLB shader, and this work does not claim that a GLB preview simulates white ink.

### Final verification

Latest focused carrier/mask/export/artifact run after the self-review correction:

```text
pnpm vitest run tests/carrierMask.test.ts tests/carrierExport.test.ts tests/carrierBehavior.test.ts tests/artifactExport.test.ts tests/exportOverlay.test.ts
Test Files  5 passed (5)
Tests       45 passed (45)
```

Protocol and plugin contract regression:

```text
pnpm vitest run tests/agentBridge.test.ts tests/cliProtocol.test.ts tests/qcOutput.test.ts tests/pluginSkillBundle.test.ts
Test Files  4 passed (4)
Tests       133 passed (133)
```

Latest full suite:

```text
pnpm test
Test Files  71 passed (71)
Tests       877 passed | 1 skipped (878)
```

Latest production build:

```text
pnpm build
PASS — TypeScript and Vite production build completed.
```

Vite emitted the existing browser externalization, mixed static/dynamic import, and large-chunk warnings; no build error occurred.

Latest dedicated plugin browser E2E:

```text
pnpm test:plugin-e2e
Test Files  1 passed (1)
Tests       1 passed | 1 skipped (2)
```

### Fix-round self-review and certification boundary

- Confirmed ordinary carrier-free designs do not create, encode, attach, preview, or publish paper-like material maps.
- Confirmed explicit craft/process regions produce only their declared optional channels over neutral pixels.
- Confirmed legacy enabled paper survives parse, render resolution, serialization, and reparse while explicit canonical applied-label data does not receive the fallback.
- Confirmed invalid custom applied/clear boundaries produce no fabricated rectangle and carry deterministic area/field issues.
- Confirmed declared white underbase produces selective raster pixels and an identifiable artifact, including on substrate-backed applied labels; no undeclared white geometry creates it.
- Confirmed zero-opacity applied substrate is both non-rendering and invalid.
- Confirmed QC-only four-channel contracts remain unchanged because white underbase is a production separation, not a newly claimed GLB shader/QC material channel.

All production checks remain unverified prompts. The implementation is not physical-production, supplier, press, adhesion, opacity, registration, abrasion, film, die-cut, foil, in-mold, white-ink, or tooling certification.

## Fix round 2

### Review findings and RED evidence

The second review identified five lifecycle/export defects: stale source PBR textures on replace export, migration provenance surviving semantic edits, white-underbase artifacts trusting an injected canvas without current renderable intent, one-sided metalness/roughness bakes being dropped from GLB export, and sub-unit custom paths being under-scaled by a one-pixel clamp.

All five findings were captured before implementation with:

```text
pnpm vitest run tests/exportOverlay.test.ts tests/projectSchema.test.ts tests/carrierMask.test.ts tests/carrierExport.test.ts tests/carrierBehavior.test.ts
Test Files  5 failed (5)
Tests       12 failed | 93 passed (105)
```

The failures independently showed the stale glTF material slots, omitted edited carrier fields, black-only/injected white channel publication, absent one-sided pack calls, and missing exact custom-boundary fit.

### Implemented corrections

| Finding | Correction |
| --- | --- |
| Replace-mode stale PBR | Texture application now explicitly clears absent metallic-roughness and normal slots before applying neutral factors. A real glTF material regression starts with old textures, proves color-only replace clears both, and proves a later channel-bearing replace reattaches new textures. Overlay still uses its independent material. |
| Legacy provenance lifecycle | Runtime provenance now contains the normalized migrated paper snapshot. It is valid only while carrier remains `applied_label`, substrate remains absent, paper remains enabled, and its color/opacity still match the snapshot. Carrier, paper, or substrate edits serialize the actual canonical state; untouched legacy still omits the synthetic carrier for exact roundtrip behavior. The runtime marker is always removed from serialized output. |
| White-underbase integrity | A shared renderability predicate requires a current per-layer white-underbase declaration, visible/non-zero-opacity renderable geometry, a successful mask draw, and a current bake canvas. The renderer discards a black-only channel; rebake therefore removes stale white output. Artifact and manifest paths use the same renderable-intent rules, so empty, hidden, zero-opacity, undeclared, or failed contributors publish neither PNG nor separation. |
| One-sided metal/rough export | Export preparation transiently creates only the missing neutral companion: black metalness for rough-only or white roughness for metal-only. The pair is packed for GLB, while artifact export still exposes only the originally declared channel. Applied/legacy full-channel bakes remain unchanged. |
| Sub-unit custom boundary | Custom boundary fitting now divides by the validated positive bounds directly, with no `Math.max(1, …)` clamp. A 0.5×0.5 path scales exactly to 400×600 as `scaleX=800`, `scaleY=1200`. |

### Scope notes

- Added `src/label/whiteUnderbase.ts` to centralize current renderable white-separation intent across mask, manifest, and artifact paths.
- Evolved the runtime-only legacy provenance type from a boolean to a normalized paper snapshot; no serialized schema field was added.
- Neutral companion canvases exist only within GLB preparation and are never inserted into `BakeResult` or artifact lists.
- Missing optional material textures remain backward compatible; applied/legacy defaults still provide the original complete PBR set.

### Final verification

Focused GREEN:

```text
pnpm vitest run tests/exportOverlay.test.ts tests/projectSchema.test.ts tests/carrierMask.test.ts tests/carrierExport.test.ts tests/carrierBehavior.test.ts
Test Files  5 passed (5)
Tests       105 passed (105)
```

Affected integration suite:

```text
pnpm vitest run tests/exportOverlay.test.ts tests/export-roundtrip.test.ts tests/rebuildWorkerProtocol.test.ts tests/sceneTexture.test.ts tests/carrierBehavior.test.ts tests/carrierMask.test.ts tests/carrierExport.test.ts tests/projectSchema.test.ts tests/labelPaper.test.ts tests/renderingFidelity.test.ts tests/labelImageReadiness.test.ts tests/bakeLifecycle.test.ts tests/artifactExport.test.ts tests/agentContracts.test.ts tests/agentBrowserRuntime.test.ts tests/exportReadiness.test.ts tests/capabilityGaps.test.ts
Test Files  17 passed (17)
Tests       261 passed (261)
```

Full suite:

```text
pnpm test
Test Files  71 passed (71)
Tests       891 passed | 1 skipped (892)
```

Production build:

```text
pnpm build
PASS — TypeScript and Vite production build completed.
```

Vite emitted the existing browser externalization, mixed static/dynamic import, and large-chunk warnings; no build error occurred.

Dedicated plugin browser E2E:

```text
pnpm test:plugin-e2e
Test Files  1 passed (1)
Tests       1 passed | 1 skipped (2)
```

### Fix-round self-review and certification boundary

- Confirmed replace export explicitly removes source PBR maps when optional channels are absent and reattaches later supplied maps without affecting overlay ownership.
- Confirmed untouched legacy paper preserves its exact compatibility path, while direct/paper/substrate edits retire provenance and serialize current fields; the runtime marker never leaks.
- Confirmed white-underbase canvas allocation, rebake removal, artifact publication, and manifest separation are gated by current visible renderable declarations plus a successful current draw.
- Confirmed metal-only and rough-only inputs produce transient neutral paired packing without fabricating an artifact or persistent bake channel.
- Confirmed all positive finite custom-path bounds, including sub-unit extents, fit the full intended artboard.

All carrier/readiness results remain unverified production prompts. This fix does not certify physical ink opacity, white-ink performance, adhesion, registration, abrasion, film, foil, die cutting, in-mold compatibility, tooling, supplier capability, press readiness, or any GLB shader simulation of white ink.

## Fix round 3

### Review findings and RED evidence

The third review found three remaining white-underbase lifecycle gaps: callback success was treated as pixel content, same-id image layers could reuse the previous source bitmap during synchronous export, and a malformed path draw could escape before the new bake replaced a stale white channel.

Primary RED command:

```text
pnpm vitest run tests/carrierMask.test.ts tests/carrierExport.test.ts tests/labelImageReadiness.test.ts tests/bakeLifecycle.test.ts
Test Files  3 failed | 1 passed (4)
Tests       6 failed | 29 passed (35)
```

This proved black-only/off-artboard/transparent draws were retained, a structurally declared area could publish an arbitrary injected canvas, the old opaque image remained available after `src` changed, and a path draw exception escaped instead of completing the rebake.

An additional preview-path RED isolated the unsupported SVG helper failure:

```text
pnpm vitest run tests/carrierMask.test.ts
Test Files  1 failed (1)
Tests       1 failed | 19 passed (20)
```

### Implemented corrections

| Finding | Correction |
| --- | --- |
| Pixel truth and artifact trust | The renderer now scans the completed white-underbase raster in bounded chunks of at most 256K pixels. Only a canvas containing at least one non-black, non-transparent pixel is added to a module-private runtime `WeakSet`. Null/unreadable/tainted data fails closed. Artifact and manifest paths require both current renderable process intent and the renderer-issued canvas brand; arbitrary injected canvases are ignored. |
| Image source identity | Cached image bits now carry their exact `src`. Stale entries are removed immediately when image-layer dependencies change, and both preview and synchronous mask bake compare the cached identity with the current store layer before drawing. An opaque-to-transparent same-id source change is blocked before the new load settles; the transparent source remains separation-free after load, and a later current opaque source produces a new proven channel. |
| Malformed/unsupported path | Mask callback errors are isolated and fail closed. Any failed or partially drawn white channel is discarded after pixel verification, allowing `setBake` to advance and replace prior output. Shared shape partitioning also catches unsupported path tracing for preview/mask helpers and returns non-rendering partitions rather than aborting the render. Existing schema/readiness validation remains authoritative where it already recognizes invalid geometry. |

### Pixel and lifecycle proof

- Black-only callback, fully transparent image simulation, and off-artboard draw all return no white-underbase channel.
- A real selective white pixel survives and receives renderer proof.
- `getImageData` failure/taint returns no channel and no brand.
- A visible structural declaration paired with an injected unproven canvas produces neither artifact nor manifest separation.
- A valid white path bake followed by a partially drawn throwing malformed path completes at a newer bake version, clears the old white channel, omits its separation, and rejects direct artifact creation.
- A source identity change followed by export-triggered synchronous bake cannot reuse the previous opaque bitmap.

### Final verification

Focused GREEN:

```text
pnpm vitest run tests/carrierMask.test.ts tests/carrierExport.test.ts tests/labelImageReadiness.test.ts tests/bakeLifecycle.test.ts
Test Files  4 passed (4)
Tests       37 passed (37)
```

Affected integration suite:

```text
pnpm vitest run tests/carrierMask.test.ts tests/carrierExport.test.ts tests/carrierBehavior.test.ts tests/artifactExport.test.ts tests/labelImageReadiness.test.ts tests/bakeLifecycle.test.ts tests/renderingFidelity.test.ts tests/craft.test.ts tests/shapeGeometry.test.ts tests/svgPath.test.ts tests/exportReadiness.test.ts tests/agentBrowserRuntime.test.ts tests/projectSchema.test.ts tests/exportOverlay.test.ts tests/sceneTexture.test.ts tests/rebuildWorkerProtocol.test.ts tests/capabilityGaps.test.ts
Test Files  17 passed (17)
Tests       325 passed (325)
```

Full suite:

```text
pnpm test
Test Files  71 passed (71)
Tests       900 passed | 1 skipped (901)
```

Production build:

```text
pnpm build
PASS — TypeScript and Vite production build completed.
```

Vite emitted the existing browser externalization, mixed static/dynamic import, and large-chunk warnings; no build error occurred.

Dedicated plugin browser E2E:

```text
pnpm test:plugin-e2e
Test Files  1 passed (1)
Tests       1 passed | 1 skipped (2)
```

### Fix-round self-review and certification boundary

- Confirmed proof originates only from the production renderer after completed-raster inspection; current intent and proof are both required downstream.
- Confirmed exact pixel inspection is chunk-bounded for 4096-class canvases and fails closed on unreadable data.
- Confirmed stale image state is guarded by `src` identity even if a synchronous export callback runs with an older React closure but reads the new store layer.
- Confirmed malformed path rendering cannot preserve a prior white channel or publish a partially drawn separation.
- Confirmed prior round replace-PBR, provenance, one-sided packing, boundary, and optional-channel compatibility behavior remains covered by full-suite and plugin E2E tests.

All readiness and separation results remain digital, unverified production evidence. This fix does not certify physical white-ink coverage/opacity, adhesion, registration, abrasion, film, foil, die cutting, in-mold compatibility, tooling, supplier capability, press readiness, or GLB shader simulation of white ink.
