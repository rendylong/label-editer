---
name: cosmetic-label-editor
description: Use when producing, validating, live-previewing, or exporting an approved cosmetic label design on a packaging GLB after cosmetic-label has completed the design and Editor Handoff, including front/back labels, full wraps, direct-print overlays, separate label meshes, neck bands, multilingual typography, craft/PBR effects, print checks, editable projects, PNG channels, labeled GLB export, or visual review.
---

# Cosmetic Label Editor

Control GLB Label Editor through its pure-local, machine-readable CLI. Label Spec v2 is the Agent-authored source of truth. The Web page is a user observation surface, not an Agent control surface.

## Mandatory upstream design gate

The end-to-end order is:

`cosmetic-label -> cosmetic-label-editor`

**REQUIRED SUB-SKILL:** Use `$cosmetic-label` before every label editing or generation task. It must clarify the current request, preserve or normalize any approved direction, and create the current **Editor Handoff** with its label spec sheet and mockup before GLB production begins.

- This gate also applies to approved supplied designs, existing editable projects, minor edits, urgent delivery, and requests to skip clarification. For an exact edit, upstream clarification should describe the delta without redesigning the rest.
- Do not silently change layout, copy, type, color, process, or hierarchy.
- `approved` handoffs may proceed. `assumed_for_fast_run` handoffs may proceed only after surfacing assumptions. A non-empty `blockers` list stops production.
- Resolve mesh selectors, UV ranges, surface mode, and model geometry from the inspected GLB in this skill.

## Resolve the local CLI

Resolve the launcher before production:

1. In an installed plugin, use the executable at `bin/label-cli.mjs` relative to the plugin root. From this skill directory that is `../../bin/label-cli.mjs`.
2. In a repository checkout, fall back to `scripts/label-cli.mjs` at the repository root.
3. Invoke it with Node.js and always add `--json` when the command supports it.
4. Treat `label-cli` in the commands below as the resolved absolute launcher path.

Do not use MCP. Do not use computer use. Do not use DOM selectors. Do not navigate or click the preview. Do not call a browser plugin to open it.

## Mandatory live Web preview

Every production run must keep one visible, synchronized Web preview open from the first valid working Label Spec through final validation and user review.

- Start `label-cli live <working-spec.json> --glb <model.glb> --json` as a foreground process in a dedicated terminal session that returns a reusable session handle; do not block the rest of the Agent workflow waiting for `live` to exit.
- `live` automatically opens plugin-owned Playwright Chromium in read-only Agent preview mode. The Agent does not open a URL or control that browser.
- Keep that terminal session running. Its first stdout value is the single JSON envelope; revision updates and recoverable errors arrive on stderr.
- Every successful `patch --force` of the same working spec updates the already-open page without navigation or refresh.
- An incomplete, malformed, or invalid watched file leaves the last valid preview visible. Read the error from stderr. Recover by rebuilding the last complete known value in a separate file, validating it, then using a revision-guarded empty `patch --force` transaction to atomically publish that valid file back to the watched path. Wait for `live` stderr to report the recovered revision.
- If Chromium cannot start, the initial design cannot apply, or the live page/browser is lost, treat it as a production blocker. Restart `live` from the last valid working spec and confirm its revision before continuing.
- Do not terminate the live session before final artifacts are produced and the requested review is complete. Close it with `SIGINT` or `SIGTERM` when the preview is no longer needed.

The visible read-only page permits the user to orbit and zoom the model, switch 2D/3D/split view, select an area, and scroll inspection details. It intentionally omits design mutation, import, export, save, undo, redo, and destructive controls.

## Revision-safe production workflow

1. Confirm the Editor Handoff status, exact copy, assets, assumptions, and blockers. Return design-level omissions upstream instead of inventing them.
2. Run `label-cli inspect <model.glb> --json`. Use the exact `stableSelector` where names are duplicated; never choose a target from a similar node name alone.
3. Translate the handoff into a valid Label Spec v2 working file. Use `replace` only for a separate label mesh; use `overlay` for bottle-body print, decals, and transparent surfaces. Keep assets as allowed local paths.
4. Run `label-cli validate <working-spec.json> --glb <model.glb> --json`. Fix schema, asset, target, font, and craft blockers before production. Report print-readiness findings as warnings unless the user requires a production gate.
5. Start the mandatory live command and verify from its success envelope that it contains `keepAlive: true`, `previewUrl`, and the revision of the working spec. The implementation renders “Agent 实时预览 · 只读” for the user; do not inspect the page through Agent browser control.
6. Before each change transaction, run `label-cli project <working-spec.json> --json`. Use its exact `revision` as `baseRevision` in an operations document.
7. Express the complete intended delta as stable, id-addressed operations. Use `add-area`, `update-area`, `remove-area`, `add-layer`, `update-layer`, `remove-layer`, or `move-layer`; never depend on array positions for identity.
8. Apply the transaction in place with `label-cli patch <working-spec.json> --operations <operations.json> --output <working-spec.json> --force --json`. This is the required `patch --force` path for the same working spec watched by `live`.
9. Confirm that the patch envelope's new revision appears in `live` stderr before starting another transaction. Page status is for the user, not an Agent inspection channel. If patch returns `REVISION_CONFLICT`, run `project` again, review the current value, rebuild the operations document with the new `baseRevision`, and retry. Never overwrite the conflict blindly.
10. When Agent visual reasoning is needed, run `label-cli preview <working-spec.json> --glb <model.glb> --output <preview.png> --view 3d --json` and inspect the generated PNG. This does not replace the user-facing live Web preview.
11. Re-run `validate`, compare the final design with the upstream mockup, disclose material translation differences, and complete the mandatory quality-control gate below.
12. Only after QC passes, publish with the requested `label-cli apply <working-spec.json> --glb <model.glb> --output <new-output-dir> --json` or export path. Require the labeled GLB, editable project, normalized spec, print manifest, preview, per-area Color/Metalness/Roughness/Bump PNGs, and artifact manifest.

`project` and `patch` are pure Node operations. They do not start Playwright or a local HTTP server. `inspect`, model-aware `validate`, `preview`, `apply`, and `export` may use the plugin-owned browser renderer internally, but the Agent still controls them only through the CLI.

## Mandatory quality control

Read `references/quality-control.md` before production QC and use its complete evidence and `pass`/`warning`/`fail` rubric. QC is mandatory even when `validate` reports ready: deterministic validation does not replace visual inspection.

1. Keep the mandatory live preview running. After validation, capture round 0 with `label-cli qc working-label-spec.json --glb package.glb --output label-qc/round-0 --preset qc-standard --json`.
2. Run `label-cli project working-label-spec.json --json` again. Before inspecting images, compare the current project revision with `qc-manifest.json.input.revision`; a missing artifact, evidence gap, or stale manifest revision is a blocking `fail`.
3. Resolve each area's evidence through `manifest.areas[].artifactIds` and exact `manifest.artifacts[].id` matches; never reconstruct ids or paths from an area id. Inspect every model view, each resolved face and craft view, and every PBR channel declared by `requiredChannels`. Write evidence-backed `pass`, `warning`, or `fail` checks that reference artifact ids. Warnings remain visible in the final handoff.
4. Any blocking `fail`—including a visual defect, evidence gap, or stale/mismatched revision—enters the same gated repair/re-QC sequence. Use the current project revision as `baseRevision` and publish a revision-safe `patch --force` transaction to the same working Spec. Stale evidence may require recapture rather than a content mutation; use a revision-guarded empty patch when no content change is needed. It still cannot bypass the gated sequence.
5. Capture the exact revision returned by the patch. Wait for `live` stderr to report `ready` for that exact revision, run `validate` on the same Spec and model, then run `qc` into a new immutable output directory. Never overwrite an earlier QC round.
6. Run `project` again and recheck the equality gate: `qc-manifest.json.input.revision` must exactly equal the current `project` revision. Inspect every required image again, rewrite the complete rubric verdict, and compare it with the prior immutable round.
7. Repeat steps 4-6 for every blocking failure within a maximum of three repair rounds after required `round-0`: `round-1`, `round-2`, and `round-3`. Recheck every changed area plus every view affected by a target, mapping, material, craft, or shared-asset change as part of the full image inspection.
8. If round 3 still fails, or a safe repair cannot be inferred, stop changing the Spec and report the remaining blockers. Do not apply/export. Do not confirm delivery while any `fail`, evidence gap, or stale/mismatched revision remains.
9. After the gated sequence passes, run the requested apply/export. Require its artifact validation, output-manifest consistency, and GLB cross-check to pass before final confirmation; preserve all QC warnings in that confirmation.

## Explicit human takeover

Use `label-cli open <working-spec.json> --glb <model.glb> --json` only when the user explicitly asks to edit the design manually. This is an explicit human takeover into the editable editor and is separate from the read-only live preview. Do not add `--open` to `apply` automatically, and do not navigate the returned URL on the user's behalf.

## Label decisions

- Support separate front/back/side areas, cylindrical wraps, planar bottle faces, cartons, tubes, jar lids, and neck/seal bands.
- For multilingual work, set BCP-47 `language` and `writingDirection`; use an available font with the required glyph coverage.
- Keep logos and trademarks user-supplied. Use local asset paths; remote image and font URLs are disabled by default.
- Model foil, emboss, deboss, matte, UV, and stroke as preview/PBR effects and print separations. Never imply that a digital preview proves supplier feasibility.
- Preserve required legal copy as supplied. Do not invent regulatory claims, ingredient lists, barcodes, filing numbers, or certifications.

## Delivery boundaries

- Screen and GLB effects are design previews. Require supplier sampling for color, adhesion, die-cut, registration, opacity, and tactile finish.
- Do not claim press-ready PDF/AI dielines, regulatory verification, or arbitrary freeform-surface flattening.
- Never overwrite a delivery directory unless the user explicitly requests `--force`. In-place `patch --force` is allowed only for the designated working spec because it is revision-guarded and atomically published.
