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
