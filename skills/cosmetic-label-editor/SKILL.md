---
name: cosmetic-label-editor
description: Produce, validate, preview, and export an approved cosmetic label design on packaging GLB files through the GLB Label Editor MCP tools. Use after cosmetic-label has completed the design and Editor Handoff, for front/back labels, full wraps, direct-print overlays, separate label meshes, neck bands, multilingual typography, craft/PBR effects, print checks, editable project delivery, PNG channels, labeled GLB export, or opening the visual editor for review.
---

# Cosmetic Label Editor

Use the plugin tools as a declarative workflow. Do not automate the editor with DOM selectors.

## Required upstream design

The end-to-end order is:

`cosmetic-label -> cosmetic-label-editor`

Before using production tools, read the approved **Editor Handoff** produced by `$cosmetic-label` together with its label spec sheet and mockup. If the request contains only a vague brief, use `$cosmetic-label` first. An equivalent user-supplied design is acceptable only when it includes the four dimensions (layout, typography, process, content), exact copy or marked placeholders, areas, layer hierarchy, and assets.

- Do not silently redesign the approved direction. Report any translation that changes layout, copy, type, color, process, or hierarchy.
- `approved` handoffs may proceed. `assumed_for_fast_run` handoffs may proceed only after surfacing the assumptions. A non-empty `blockers` list stops production.
- Mesh selectors, UV ranges, surface mode, and model geometry are intentionally not required upstream; resolve them from the inspected GLB here.

## Workflow

1. Confirm the Editor Handoff status, artifacts, exact copy, assets, and blockers. Return design-level omissions to `$cosmetic-label`; do not fill them by invention.
2. Call `inspect_model` before choosing a surface. Use its exact `stableSelector` when names are duplicated.
3. Translate the handoff into Label Spec v2. Keep layout, typography, process, and content hierarchy explicit. Use `replace` only for a separate label mesh; use `overlay` for bottle-body print, decals, and transparent surfaces.
4. Call `validate_label_spec` before publishing. Treat ambiguous targets, missing assets/fonts, invalid crafts, and schema errors as blockers. Report print-readiness findings as warnings unless the user requires a production gate.
5. Compare the validated preview against the upstream mockup and disclose material differences.
6. Prefer one `apply_label_spec` call for the complete transaction. Require a labeled GLB, editable project, normalized spec, print manifest, preview, per-area Color/Metalness/Roughness/Bump PNGs, and artifact manifest.
7. Use `open_label_editor` only for human review or takeover. The returned URL is local and tokenized.

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
