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
