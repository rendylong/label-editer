---
name: cosmetic-label-editor
description: Use when producing, validating, previewing, or exporting an approved cosmetic label design on a packaging GLB after cosmetic-label has completed the design and Editor Handoff, including front/back labels, full wraps, direct-print overlays, separate label meshes, neck bands, multilingual typography, craft/PBR effects, print checks, editable projects, PNG channels, labeled GLB export, or visual review.
---

# Cosmetic Label Editor

Use the plugin tools as a declarative workflow. Do not automate the editor with DOM selectors.

## Mandatory upstream design gate

The end-to-end order is:

`cosmetic-label -> cosmetic-label-editor`

**REQUIRED SUB-SKILL:** You MUST use `$cosmetic-label` before every label editing or generation task. It must clarify the current request, produce or normalize the design proposal, and create the current **Editor Handoff** with its label spec sheet and mockup before this skill begins.

Do not call `inspect_model`, `validate_label_spec`, `open_label_editor`, `apply_label_spec`, `render_label_preview`, or `export_label_assets` until that upstream work is complete. This gate also applies to approved user-supplied designs, existing editable projects, apparently minor edits, urgent delivery, and requests to skip clarification. Pass those inputs through `$cosmetic-label` to clarify the delta, preserve or normalize the approved direction, surface assumptions, and issue a fresh Editor Handoff; never accept them as a direct bypass.

- Do not silently redesign the approved direction. Report any translation that changes layout, copy, type, color, process, or hierarchy.
- `approved` handoffs may proceed. `assumed_for_fast_run` handoffs may proceed only after surfacing the assumptions. A non-empty `blockers` list stops production.
- Mesh selectors, UV ranges, surface mode, and model geometry are intentionally not required upstream; resolve them from the inspected GLB here.

## Mandatory live browser preview

Keep a visible browser preview open throughout every label-production run, including approved, urgent, uninterrupted, or no-takeover requests.

- As soon as the first valid Label Spec exists, you MUST call `open_label_editor` with that spec and GLB, then open its tokenized URL in the user's available browser or browser-navigation tool. Do not merely return the URL. Do not wait until final delivery.
- Keep the preview tab open while work continues. After each material change to layout, copy, typography, color, process, hierarchy, area, or asset, call `open_label_editor` with the updated spec and navigate the existing preview tab to the new URL.
- Call the final `apply_label_spec` with `open_editor: true`, then navigate the preview tab to its returned `editorUrl` so the visible session matches the delivered artifacts.
- A headless renderer, generated preview PNG, or URL shown only as text does not satisfy this requirement. If a visible browser cannot be opened or refreshed, report it as a blocker instead of continuing silently.

## Workflow

1. Verify that the current task has already used `$cosmetic-label` and received its current Editor Handoff, spec sheet, and mockup. If not, stop and invoke `$cosmetic-label` before any editor or MCP action. Then confirm status, exact copy, assets, assumptions, and blockers; return design-level omissions upstream rather than filling them by invention.
2. Call `inspect_model` before choosing a surface. Use its exact `stableSelector` when names are duplicated.
3. Translate the handoff into Label Spec v2. Keep layout, typography, process, and content hierarchy explicit. Use `replace` only for a separate label mesh; use `overlay` for bottle-body print, decals, and transparent surfaces.
4. Call `validate_label_spec` before publishing. Treat ambiguous targets, missing assets/fonts, invalid crafts, and schema errors as blockers. Report print-readiness findings as warnings unless the user requires a production gate.
5. Compare the validated preview against the upstream mockup and disclose material differences.
6. Follow the mandatory live-browser-preview contract before continuing production and after every material design change.
7. Prefer one `apply_label_spec` call with `open_editor: true` for the complete transaction. Require a labeled GLB, editable project, normalized spec, print manifest, preview, per-area Color/Metalness/Roughness/Bump PNGs, artifact manifest, and visible final editor session.

## Label decisions

- Support separate front/back/side areas, cylindrical wraps, planar bottle faces, cartons, tubes, jar lids, and neck/seal bands.
- For multilingual work, set BCP-47 `language` and `writingDirection`; use an available font with the required glyph coverage.
- Keep logos and trademarks user-supplied. Use local asset paths; remote image and font URLs are disabled by default.
- Model foil, emboss, deboss, matte, UV, and stroke as preview/PBR effects and print separations. Never imply that a digital preview proves supplier feasibility.
- Preserve required legal copy as supplied. Do not invent regulatory claims, ingredient lists, barcodes, filing numbers, or certifications.

## Delivery boundaries

- Screen and GLB effects are design previews. Require supplier sampling for color, adhesion, die-cut, registration, opacity, and tactile finish.
- Do not claim press-ready PDF/AI dielines, regulatory verification, or arbitrary freeform-surface flattening.
- Never overwrite an output directory unless the user explicitly requests `force`.
