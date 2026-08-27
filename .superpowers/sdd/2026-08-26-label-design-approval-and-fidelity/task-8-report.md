# Task 8 report — approval binding and revision-safe workflow state

## Scope and commits

- Workspace: `/Users/apple/dsh/glb-label-editor/.worktrees/label-design-approval-fidelity`
- Mandatory Task 7 prerequisite: `c31ac32 fix: derive authoritative design capture plans`
- Task 8 implementation: committed together with this report as `feat: bind label approvals to revisions`; use the final handoff or `git log -1` for its immutable SHA because a commit cannot embed its own SHA.
- No push, merge, package-version change, changelog, or original-checkout edit was performed.

## RED evidence

1. Direct forged capture-plan regression:
   - Command: `pnpm vitest run tests/designReview.test.ts -t "rejects a forged direct-call capture plan before launching Chromium"`
   - Before the prerequisite fix: failed because the forged plan reached `chromium.launch()` and returned `BROWSER_NOT_READY` instead of the required pre-browser `INVALID_LAYOUT_BLUEPRINT`.
2. Initial Task 8 workflow suite:
   - Command: `pnpm vitest run tests/approvalWorkflow.test.ts tests/designContracts.test.ts`
   - Before implementation: all 38 new workflow cases failed because `verifyDesignGate`, `verifyProductionGate`, `classifyRevisionChange`, and `WorkflowGateError` were absent.
3. Bounded error details:
   - Direct `WorkflowGateError` regression failed with a 5,000-character detail and 100-entry array before boundary sanitization.
4. Canonical area targets:
   - The order-independent area-target test failed because `computeAreaTargetsSha256` was absent.
5. Intra-call mutation:
   - The alternating-source regression initially resolved as valid when the current document changed between the internal design and production checks; it now fails closed with `STALE_APPROVAL` at `designGate.evidence`.

## Implemented contract

- `verifyDesignGate()` reads fresh blueprint, design-manifest, and Spec/Project bytes; hashes exact bytes with SHA-256; validates their schemas and semantic bindings; requires current normalized design bindings; checks Handoff source, approval, areas, carriers, blockers, status, mode, and exact `current_task` scope.
- Legacy Handoff v1 `approved` normalizes to approval-required/awaiting. `assumed_for_fast_run` is awaiting unless a current design `continuous_authorized` record binds the fresh blueprint and review evidence.
- `verifyProductionGate()` reruns the design gate, rereads all mutable sources, rejects an intra-call state change, derives the canonical Spec/Project revision and stable area-target digest, and binds the current input, model fingerprint, blueprint, design review, production review, and manifest area facts.
- `computeAreaTargetsSha256()` canonicalizes object keys and area order while rejecting missing or duplicate area/blueprint-area identity.
- `classifyRevisionChange()` returns the exact `RevisionClassification` union. Design intent covers revision, copy, hierarchy/order/visibility, physical layout, color, typography/font assets, carrier/substrate, process intent, and editable assets. Production covers target/range/remap/orientation/scale inputs, model fingerprint, capture assets, and production review manifest. Design wins when both changed; reasons are sorted and deduplicated.
- `WorkflowGateError` exposes only the six stable codes and bounds nested structured details. `BlueprintCompilerError` now extends it with `UNREPRESENTABLE_LAYER`, retaining its prior compiler name and disclosure details.

## Changed files

- `scripts/lib/design-review.mjs` — ignore caller-supplied capture authority and derive the authoritative plan internally (prerequisite commit).
- `tests/designReview.test.ts` — direct forged-plan pre-browser regression (prerequisite commit).
- `src/agent/designContracts.ts` — workflow errors, fresh evidence readers, canonical digests, design/production gates, area-target helper, and revision classification.
- `src/agent/blueprintCompiler.ts` — map unrepresentable editable layers to the shared structured workflow error.
- `tests/approvalWorkflow.test.ts` — 44 workflow, mutation, legacy, continuous authorization, Spec/Project, production-binding, and classification cases.
- `tests/designContracts.test.ts` — direct structured-error detail boundary regression.

## GREEN and verification evidence

- Prerequisite design-review/browser and atomic publication: 2 files, 89 tests passed.
- Required focused/affected command:
  - `pnpm vitest run tests/approvalWorkflow.test.ts tests/designContracts.test.ts tests/blueprintCompiler.test.ts tests/fidelityCheck.test.ts tests/labelSpecV2.test.ts tests/projectSchema.test.ts tests/projectControl.test.ts tests/designReview.test.ts tests/atomicPublication.test.ts --testTimeout=180000`
  - 9 files, 321 tests passed, including real Chromium design-review fixtures.
- TypeScript: `pnpm exec tsc -b --pretty false` exited 0 with no diagnostics.
- Production build: `pnpm build` exited 0; 222 modules transformed and Vite completed.
- Full suite: `pnpm test` passed 76 files and 1,155 tests; 1 environment-controlled test was skipped.
- Explicit packaged plugin E2E: `pnpm test:plugin-e2e` passed the installed-like front/back apply/export flow; 1 passed and 1 environment-controlled headful test skipped.
- Repository hygiene is rerun after the commit; expected result is clean tracked status and no `git diff --check` output.

## Residual risks and ownership

- The production gate consumes the current model fingerprint returned by model inspection; it does not reread raw GLB bytes itself. Callers must recompute model inspection at both documented gate points.
- The gate binds and validates the immutable production manifest and its embedded artifact hashes. Reading every published PNG byte remains the production review publisher/output validator responsibility planned for Task 10.
- Vite retains existing browser-externalization, mixed dynamic/static GLTFLoader, and large-chunk warnings; the build exits successfully and Task 8 adds no new occurrence of those warnings.
- The optional headful live-preview plugin E2E remains skipped unless its environment flag is enabled; the default installed-like browser apply/export E2E passed.

## Fix round 1 — independent approval-gate findings

### RED reproductions

1. Current-document design forgery:
   - `pnpm vitest run tests/approvalWorkflow.test.ts -t "rejects unapproved"`
   - Six cases resolved `valid: true` before the fix: Label Spec copy, order, physical layout, typography, process intent, and Project v3 copy. A schema-valid layer-type mutation was also added to the same contract matrix.
2. Unvalidated legacy authorization:
   - `pnpm vitest run tests/approvalWorkflow.test.ts -t "unknown handoff version|malformed legacy|legacy blockers"`
   - `handoff_version: 999`, a two-field malformed v1, and a blocked v1 all resolved `continuous_authorized` before the fix.
3. Incomplete current-document and production projections:
   - `pnpm vitest run tests/approvalWorkflow.test.ts -t "current-document|Project v3 canvas changes|Project v3 axis|binds Project v3"`
   - Current-document design mutations returned `invalidates: none`; Project canvas/axis mutations retained the old target digest and returned `invalidates: none`.
4. Awaiting-state semantic bypass:
   - `pnpm vitest run tests/approvalWorkflow.test.ts -t "semantically validates unique"`
   - Duplicate v2 area ids, blueprint-area ids, and asset ids returned `AWAITING_USER_APPROVAL` before semantic validation.
   - `pnpm vitest run tests/designContracts.test.ts -t "awaiting, blocked"` also proved that the old validator rejected a valid awaiting state instead of representing it.

### Fix decisions

- Added one compiler-derived canonical design projection shared by `verifyDesignGate()` and `classifyRevisionChange()`. The approved side is produced through `compileBlueprintToSpecAreas()`; the current Spec/Project side normalizes the two editable formats to the same physical design facts. Copy, type/order/visibility, physical metrics, typography/font identity, color/vector data, process/craft intent, carrier, artboard, substrate, editable assets, and global craft now participate.
- Kept physical `designMetrics` as design authority for Project v3. Project pixel canvas, remap origin/axis/radius/wrap/offset/mirror/planar box, range, mesh identity, surface mode, placement policy, `axisMin`, and `axisMax` remain production mapping facts and are all bound in the canonical area-target projection.
- Split `WorkflowGateError` into a cycle-free shared module so the design gate can reuse the real blueprint compiler without a runtime import cycle. `BlueprintCompilerError` retains the same exported base-class identity and stable `UNREPRESENTABLE_LAYER` code.
- Made `validateEditorHandoff()` state-aware: schema, unique area/blueprint-area/asset ids, mode/status consistency, and source/approval digest consistency are semantic validity; awaiting and blocked values remain representable states. `verifyDesignGate()` reuses that validation, then rejects blockers before applying authorization and returns the normal wait-state error only after semantic validity is proven.
- Continuous authorization now considers only a fully validated `handoff_version: 1` document in a recognized legacy state. Legacy approved still requires v2 normalization; legacy assumed-fast-run still requires a current-task continuous record and fresh evidence; unknown versions and malformed v1 fail closed.
- Revision classification now includes current-document design projection as `design:document`. Its production projection includes all Label Spec/Project mapping fields, including Project canvas and axis bounds. Reasons remain sorted/deduplicated and design still wins.

### GREEN verification

- Focused gate/contracts/compiler: 3 files, 110 tests passed.
- Affected contracts/fidelity/project/design-review/atomic publication: 9 files, 349 tests passed, including real Chromium captures.
- TypeScript: `pnpm exec tsc -b --pretty false` exited 0 with no diagnostics.
- Production build: `pnpm build` exited 0; Vite transformed 222 modules. Existing browser-externalization, mixed GLTFLoader import, and large-chunk warnings remain unchanged.
- Full suite: 76 files passed; 1,183 tests passed and 1 environment-gated headful test skipped.
- Explicit packaged plugin E2E: installed-like front/back apply/export passed; 1 passed and 1 environment-gated headful test skipped.

### Fix-round residuals

- The canonical Project design projection intentionally treats physical design metadata, not canvas-derived pixel coordinates, as the approval authority. The physical-layout resolver owns translation from that metadata to a current production canvas, while the production target digest binds the canvas and mapping inputs.
- The original Task 8 residuals for caller-supplied model inspection, Task 10 PNG-byte validation, and the optional headful preview environment remain unchanged.

## Fix round 2 — resolved editor render-input authority

### RED reproductions

- Command: `pnpm vitest run tests/approvalWorkflow.test.ts tests/blueprintCompiler.test.ts tests/labelSpecV2.test.ts tests/projectSchema.test.ts tests/craft.test.ts`
- Before implementation: 5 files ran, 35 tests failed and 213 passed.
- Exact bypasses reproduced:
  - a Project/Spec shape `cornerRadius` change passed the design gate when no physical radius overrode it;
  - a compiled blueprint image dropped `fit`, while Label Spec/Project schemas rejected the field and contain/cover masks rendered as stretch;
  - a legacy blueprint with omitted image `fit` rendered as contain in design review but was not compilable with the same default;
  - changing referenced embedded font bytes under the same area font name remained approved;
  - `left`, `right`, `wrap`, `top`, `bottom`, `neck`, and `custom` were lost during blueprint compilation/Spec/Project apply;
  - same-revision blueprint changes to side, `strokeWidthMm`, `cornerRadiusMm`, and `fillRule` returned `invalidates: none`.

### Semantic decisions and implementation

- Replaced metadata-only comparison with one canonical resolved render-input projection. Label Spec is applied through `applyStructuredLabelSpec()` on a deterministic 4096px-high artboard-proportional canvas; Project v3 is parsed through `parseLabelProject()` on its current production canvas. Both sides then reuse `resolvePhysicalLayer()` and `normalizeShapeLayer()` before comparison. The approved blueprint is compiled through the real compiler and resolved against the same Spec canvas or current Project shell.
- The projection covers resolved position/frame, typography, shape geometry/path/fill rule/stroke/radius, opacity/rotation/visibility/anchor/order, text behavior, image source/fit/aspect, processes/craft, carrier/artboard/substrate/global craft, side, and referenced font assets. Raw proxy pixels are ignored only when the same physical resolver actually overwrites them; removing an individual physical override makes its runtime value approval-bearing.
- Referenced Project embedded font data URLs are decoded within a 28 MiB data-URL bound and represented only by SHA-256 plus MIME metadata. The projection never copies font payloads. A browser-safe synchronous SHA-256 helper keeps the existing synchronous revision-classifier API and is cross-checked by the gate regression against Node SHA-256 evidence.
- Added `ImageLayer.fit` plus Label Spec/Project schema support for `contain`, `cover`, and `stretch`. The compiler persists fit and approved intrinsic image dimensions; one shared fit-box function drives preview color and every image mask, and image-cache identity includes the intrinsic frame inputs. Legacy Spec/Project documents with no fit retain the former stretch behavior, while a legacy blueprint omission inherits design review's contain default. Unknown fit or missing approved intrinsic dimensions fails as `UNREPRESENTABLE_LAYER` rather than silently changing design-review/editor output.
- Expanded Spec/Project/runtime side identity to the full `LabelSide` vocabulary. Only `back` retains the legacy automatic half-wrap offset; every other side remains distinct and uses the explicit production remap instead of inventing an orientation.
- Completed classifier layout content with area side plus `fillRule`, `strokeWidthMm`, and `cornerRadiusMm`; all other blueprint fields remain assigned to their deterministic design categories. Same revision text no longer masks changed content.

### Scope expansion

- Added `src/agent/syncSha256.ts` and replaced `src/agent/designProjection.ts` internals.
- Extended the Label Spec and Project JSON schemas/types, regenerated `labelSpecV2Validator.ts`, and updated Spec/Project application boundaries.
- Extended runtime image rendering in `src/label/craft.ts` and `src/label/LabelCanvas.tsx`, plus the QC side evidence type.
- Added exact regressions across approval workflow, blueprint compiler, schema/apply/project round-trip, and image mask rendering tests.

### GREEN verification

- Focused TDD suite: 5 files, 266 tests passed.
- Affected gate/compiler/schema/fidelity/design-review/browser-runtime suite: 10 files, 473 tests passed, including 75 real-Chromium design-review tests and 20 browser Agent runtime tests.
- TypeScript: `pnpm exec tsc -b --pretty false` exited 0 with no diagnostics.
- Full suite: `pnpm test -- --reporter=dot --testTimeout=10000` passed all 76 files; 1,239 tests passed and 1 environment-gated test skipped. Two immediately preceding default-5-second runs each timed out in a different Chromium case under full-suite concurrency; the first isolated retry passed in 575 ms, and the complete 75-test browser suite passed in the affected run without changing its assertions.
- Production build: `pnpm build` exited 0; Vite transformed 222 modules. Existing browser-externalization, mixed GLTFLoader import, and large-chunk warnings remain non-failing.
- Explicit packaged plugin E2E: real front/back apply/export passed in 151 seconds; 1 passed and 1 environment-gated test skipped.
- `git diff --check` and tracked-clean status are rerun immediately before and after the fix commit.

### Residual risks

- The 28 MiB encoded-font bound covers the existing 20 MiB uploaded-font limit, but SHA-256 is synchronous to preserve the classifier API; a maximum-size font adds bounded gate latency.
- Full side identity is lossless, but non-front/back physical orientation is deliberately not inferred. Its UV/remap/canvas placement remains a separately bound production fact.
- Path-referenced Spec assets are matched to the SHA-bound blueprint asset declaration; embedded Project image/font bytes are hashed directly. Re-reading arbitrary external asset paths remains the asset loader/design-review publisher responsibility.
- The earlier Task 8 residuals for caller-supplied model inspection and Task 10 published PNG-byte validation remain unchanged.

## Fix round 3 — first-load runtime authority and exact layer identity

### RED reproductions

1. Raw Project render inputs hidden by physical resolution:
   - `pnpm vitest run tests/approvalWorkflow.test.ts --reporter=dot`
   - Before implementation: 18 tests failed and 95 passed. Forged Project text `x=999`, `y=888`, `fontSize=777`, `letterSpacing=666`, and `lineHeight=4` remained approved; individual text, image, and shape proxy changes under physical metadata also remained approved, and the classifier returned `invalidates: none`.
2. Uploaded-font runtime identity collisions:
   - `pnpm vitest run tests/projectSchema.test.ts --reporter=dot`
   - Before implementation: 2 tests failed and 78 passed. `Brand Font` versus `brand-font`, and `assets/brand font.woff2` versus `assets/brand-font.woff2`, both parsed despite resolving to the same uploaded id and CSS family.
3. Compiler/runtime order drift from design review:
   - `pnpm vitest run tests/blueprintCompiler.test.ts tests/approvalWorkflow.test.ts --reporter=dot`
   - Before implementation: 5 tests failed and 136 passed. Compilation followed source-array order instead of `(zIndex,id)`; equal-z Project arrays were order-sensitive in the gate/classifier; and the existing multi-layer compiler fixture disagreed with review's id tie-break.

### Semantic decisions and implementation

- The canonical document projection now retains every original parsed/applied runtime layer input and adds a separate `resolvedPhysical` projection for the fields physical metadata can authoritatively derive. Project v3 and `.lbl` first-load values therefore cannot hide behind a later `resolvePhysicalLayer()` result. Text position/box/font size/spacing/line height, image position/frame, and shape position/frame/stroke/radius are covered individually; all previously projected render inputs remain bound.
- Raw pixel coordinates are normalized against the current canvas because that is what the scaled runtime displays. Consequently, changing a Project canvas without rescaling stored pixels is both a design-document and production-target change, with design invalidation taking precedence. A consistently rescaled document retains the same normalized design.
- Added one lightweight `uploadedFontIdentity()` helper that owns NFKD normalization, uploaded ids, and CSS-family names. Project import/serialization validation and runtime lookup/registration now consume that same identity. Each area rejects a collision in either id or CSS family before any order-dependent font lookup or `FontFace` registration.
- Added one exact `compareLayerZOrder()` implementation matching design review's `(zIndex,id)` comparator. Blueprint compilation sorts before emitting a Label Spec; LabelCanvas, canonical approval projection, fidelity comparison, white-underbase intent, layer mutations, and both layer-list UIs reuse it. The classifier canonicalizes hierarchy order with the same comparator while still detecting actual z-order changes.

### Scope expansion

- Added `src/label/uploadedFontIdentity.ts` and `src/label/layerOrder.ts` as shared, browser-safe identity primitives.
- Updated the design projection, blueprint compiler, Project parser, font runtime, canvas renderer, fidelity/white-underbase paths, layer mutations, and layer-list presentation.
- Replaced the former stale-proxy-is-valid regression and added exact gate/classifier tests for raw text, image, and shape inputs; font collision tests; and reversed-z/equal-z compiler, gate, and classifier tests.

### GREEN verification

- Focused Task 8 TDD suite: 5 files, 290 tests passed.
- Affected approval/compiler/project/font/fidelity/rendering/design-review/browser suite: 12 files, 567 tests passed, including the complete 75-test real-Chromium design-review suite and browser Agent runtime coverage.
- TypeScript: `pnpm exec tsc -b --pretty false` exited 0 with no diagnostics.
- Full suite: `pnpm test -- --reporter=dot --testTimeout=10000` passed all 76 files; 1,263 tests passed and 1 environment-gated test skipped.
- Production build: `pnpm build` exited 0; Vite transformed 224 modules. Existing browser-externalization, mixed GLTFLoader import, and large-chunk warnings remain non-failing.
- Explicit packaged plugin E2E: the installed-like front/back apply/export flow passed in 88.4 seconds; 1 passed and 1 environment-gated headful test skipped.
- `git diff --check` and tracked-clean status are rerun immediately before and after the fix commit.

### Residual risks

- The stricter gate deliberately rejects raw editable proxy drift even when physical metadata would later resolve to the same value; this is required because Project/embedded `.lbl` first load renders those stored values directly.
- The full-suite command retains the 10-second Chromium allowance documented in Fix round 2; all browser assertions are unchanged and the dedicated affected/browser and packaged-plugin runs passed.
- The optional headful live-preview E2E, caller-supplied model inspection, and Task 10 published PNG-byte validation remain outside this fix round.

## Fix round 4 — one canonical layer order and encodable equal-z controls

### RED reproductions

- Canonical order/mask/editor/gate/review matrix:
  - `pnpm vitest run tests/layerOrder.test.ts tests/carrierMask.test.ts tests/selection.test.ts tests/blueprintCompiler.test.ts tests/designReview.test.ts tests/approvalWorkflow.test.ts tests/fidelityCheck.test.ts --reporter=dot --testTimeout=180000`
  - Before implementation: 7 files ran, 14 tests failed and 283 passed.
  - Direct `renderMasks()`, substrate-backed masks, carrier-free process masks, and both white-underbase paths painted same-z `I`/`i` layers in storage order; the approval gate, compiler, immutable review, and fidelity check changed behavior when ambient `localeCompare` was reversed; all-equal and mixed-tie move/drag requests were no-ops or produced the wrong visual order.
- Import-boundary identity matrix:
  - `pnpm vitest run tests/projectSchema.test.ts tests/labelSpecV2.test.ts -t "duplicate layer ids" --reporter=verbose`
  - Before implementation: both new duplicate-id cases failed because direct Project v3 and Label Spec v2 imports accepted ambiguous layer identities.

### Semantic decisions and implementation

- Added a small browser/Node shared order core with one exact bottom-to-top comparator: finite numeric `zIndex`, then locale-independent UTF-16/code-unit ordinal `id`. Its canonicalizer returns a new array and rejects empty ids, non-finite z values, and duplicate ids. TypeScript runtime wrappers and the immutable Node review renderer import the same implementation; production order code no longer calls ambient `localeCompare`.
- Routed blueprint compilation, design projection/contracts, approval comparison, fidelity comparison, Konva preview, PBR/craft masks, carrier masks, substrate and carrier-free white underbase, print separations/readiness, font-readiness identity, and both editor layer lists through the shared canonical order. Direct mask calls and both `renderCarrierMasks()` branches now canonicalize non-mutating inputs before every contribution/draw loop.
- Move and drag/drop now operate on canonical visual order and encode the requested order into finite z values. Existing distinct z slots are reused when that preserves locked layers; otherwise each unlocked segment is assigned representable finite values between unchanged locked barriers and the candidate is accepted only when canonical re-sort proves the exact requested identity order. Store history and selection behavior remain unchanged.
- Project v3 parsing and Label Spec v2 semantic validation now fail closed on duplicate layer ids, matching the already-strict blueprint and handoff boundaries.

### Scope expansion

- Added `scripts/lib/layer-order-core.mjs`, its TypeScript declaration, and `tests/layerOrder.test.ts`.
- Updated the compiler/projection/contracts/fidelity/review, canvas/craft/underbase/readiness, layer mutations/UI, and Project/Label Spec import boundaries.
- Added exact reversed-storage overlapping-pixel regressions with different UV tones, `I`/`i` locale-simulation vectors, non-finite/duplicate contract cases, canonical separation/callback order, and all-equal/mixed-tie move, drag, lock, history, undo/redo, and selection cases.

### GREEN verification

- Focused ordering/mask/interaction suite: 3 files, 63 tests passed.
- Affected gate/compiler/contracts/review/fidelity/import/rendering/editor/publication suite: 20 files, 712 tests passed.
- Duplicate Project/Label Spec import boundary suite: 2 tests passed.
- TypeScript: `pnpm exec tsc -b --pretty false` exited 0 with no diagnostics.
- Full suite: `pnpm test -- --reporter=dot --testTimeout=180000` passed all 77 files; 1,282 tests passed and 1 environment-gated test skipped.
- Production build: `pnpm build` exited 0; Vite transformed 225 modules. Existing browser-externalization, mixed GLTFLoader import, and large-chunk warnings remain non-failing.
- Packaged plugin E2E: `pnpm test:plugin-e2e` passed the installed-like front/back apply/export flow; 1 passed and 1 environment-gated headful test skipped.
- Real CLI/Chromium fixture: the 1600 × 1200 front/back review completed with no warnings; area crops were 210 × 340 and 200 × 320. The repeated no-`--force` invocation returned one structured `OUTPUT_CONFLICT` and exit code 9.
- `git diff --check` exited cleanly before the fix commit.

### Residual risks

- If a requested unlocked ordering has no representable finite Float64 rank between fixed locked barriers, the mutation fails closed and leaves the document unchanged. Ordinary equal-z and mixed-tie segments, including locked tie barriers, are covered by exact regressions.
- The optional headful live-preview E2E remains environment-gated. The installed-like browser E2E and realistic CLI Chromium render passed.
- Caller-supplied model inspection and Task 10 published PNG-byte validation remain outside this fix round; their prior ownership is unchanged.

## Fix round 5 — isolated canonical HTML artwork stacking

### RED reproduction

- Command: `pnpm vitest run tests/designReview.test.ts -t "negative-z|mixed negative/positive" --reporter=verbose --testTimeout=180000`
- Before the production change, both real-Chromium regressions failed. An opaque applied-label carrier painted over a full-area layer at `zIndex: -32768`: the sampled center pixel was `[255,255,255,255]` instead of red, and Chromium reported `carrier:opaque` above `layer:negative-red`.
- The mixed boundary case likewise painted its negative layer below the carrier, while a `zIndex: 32767` layer remained above it. The emitted `.art-layer` tags also exposed the raw positive and negative `z-index` values despite their already-canonical DOM order.
- The production mutation caught by these tests is restoring raw per-layer CSS z-index or failing to keep the canonical artwork group above the carrier substrate/boundary.

### Change and stacking contract

- `renderLayer()` no longer projects the blueprint's raw z value into CSS. The value remains approval-bearing input and drives the shared `(zIndex,id)` canonical sort, but it is not allowed to cross the design-review renderer's carrier/package stacking groups.
- `renderArea()` places the canonically sorted layers inside one `.artwork-stack` emitted after the carrier substrate or boundary. The stack fills the area and establishes an isolated stacking context; its positioned children use canonical DOM paint order.
- The resulting group order is package decoration, then area substrate/boundary, then every artwork layer from canonical bottom to top. Equal, minimum negative, mixed negative/positive, and maximum positive blueprint ranks therefore match Konva/mask order without allowing negative CSS stacking to hide artwork behind its carrier.
- Added two real Chromium tests that decode an actual area screenshot back to RGBA pixels and independently inspect `document.elementsFromPoint()` order. They also prove the final HTML is script-free and that no `.art-layer` tag leaks a raw `z-index` declaration.

### GREEN verification

- Complete design-review suite: 1 file, 78 tests passed, including the two new Chromium pixel/order cases.
- Affected approval/compiler/import/fidelity/carrier/mask/editor/browser/publication matrix: 14 files, 520 tests passed.
- Full suite: 77 files passed; 1,284 tests passed and 1 environment-gated headful test skipped.
- Production build: `pnpm build` passed; TypeScript completed and Vite transformed 225 modules. Only the existing Node externalization, mixed GLTFLoader import, and bundle-size warnings remain non-failing.
- Packaged plugin E2E: the installed-like front/back apply/export and atomic publication flow passed in 101.38 seconds; 1 passed and 1 environment-gated headful test skipped.
- Real CLI/Chromium fixture passed at 1600 x 1200 with 210 x 340 and 200 x 320 area captures. HTML SHA-256 is `97494a48d496f283eb147d6c7b7bab4e6a1c796bde384e2ce2fb9739bd933b57`; front is `4f14635a7ad08998d393247ecc2f2f53de0f9b88b61d28e21c65d23d5a982cdc`; back is `e06f241bdd125fc793772d34e6fbaf0781297611a9cebddfb7e7942dc46939d0`; front area is `2d2baf3c8b9e3725d0ae89910069e6ab868d08cc9a1f05f15edf38b462f608a5`; back area is `553846db90dc70bc8e2efdf16d5bb4307a6b96a945fd333f0651cc1626f79a04`; manifest is `1f96ac98da338efd06551bae73973eb60c2caf1d3eb3f7009a13da333e0077b4`.
- The front/back PNGs were visually inspected: layout and exact placeholder copy remain visible, direct print has no invented paper panel, clear film has no opaque panel or diagnostic boundary, and diagnostic UI is absent. The generated HTML scan found no script tag, event attribute, external/file URL, host path, press-ready wording, or production-certification claim; its artwork tags contain no z-index declaration. Re-running without force returned one structured `OUTPUT_CONFLICT` envelope and exit code 9.
- `git diff --check` passed before the report update; it is rerun immediately before commit.

### Final-round residuals

- The review renderer intentionally represents artwork rank through validated canonical DOM order rather than CSS z values. Future carrier or package decoration must remain outside and before `.artwork-stack`; a regression in either pixel output or hit-test order is covered by the new browser tests.
- The optional headful live-preview E2E remains environment-gated. The installed-like browser E2E and realistic CLI Chromium render both passed.
- Caller-supplied model inspection and Task 10 published PNG-byte validation remain outside this fix round under their previously documented owners. No load-bearing residual is known for the round-4 HTML stacking finding.
