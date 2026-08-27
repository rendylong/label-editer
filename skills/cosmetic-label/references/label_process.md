# 贴标 Carrier、Process 与 Finish 规范

Carrier and process are separate fields. Choose the physical carrier first, then assign processes to specific layers. New output uses canonical carrier values only. `hot_stamp_foil` is a print/craft process, not a carrier.

## Canonical carrier

| Carrier | Physical meaning | Required behavior |
|---|---|---|
| `direct_surface_print` | ink/print/spray directly on glass, plastic, metal, or coated package | no independent substrate, adhesive, bleed, die cut, paper edge, radius, or shadow |
| `applied_label` | attached opaque paper or film | explicit opaque substrate, opacity, boundary, material, and adhesive assumptions |
| `clear_label` | attached transparent film | transparent film boundary; printed ink and selective white underbase remain distinct |
| `in_mold` | decoration integrated during molding | no post-applied paper edge or adhesive |
| `foil_or_ink_only` | sparse foil, ink, code, or selected marks | no synthesized full-area substrate |
| `bare` | no decorative front area | no empty rectangle and no decorative layers |

`direct_surface_print` never creates a paper panel. Do not add a full-area fill, paper silhouette, rounded panel, drop shadow, adhesive, bleed, or die-cut semantics to direct print. The same no-paper rule applies to `in_mold`, `foil_or_ink_only`, and `bare`; `clear_label` records only its transparent film extent.

Reject carrier/material contradictions. Paper or opaque film belongs to `applied_label`; transparent film belongs to `clear_label`. Foil on an applied label keeps carrier `applied_label` and adds a foil process. Sparse foil directly on a package may use `foil_or_ink_only`.

## Canonical process assignments

Assign zero or more of these processes to the exact affected layers:

- `screen_print`: durable single/few-color printing, commonly on curved surfaces.
- `pad_print`: selected small marks on shaped surfaces.
- `digital_print`: short-run or multi-color digital output.
- `offset_print`: multi-color/detail printing, commonly on an applied carrier.
- `white_underbase`: selective opacity support; use the reserved white-underbase mask.
- `varnish`: selective or overall compatible varnish intent.
- `hot_stamp_foil`: foil transfer on selected geometry; never changes carrier by itself.
- `emboss` / `deboss`: relief intent subject to carrier and supplier capability.
- `in_mold`: process intent for compatible integrated decoration.
- `batch_code`: batch/expiry coding.

Carrier is recorded once per area; process is recorded per layer. Do not place carrier values in `processes`, and do not place process names in `carrier`.

## Substrate, finish, and tactile intent

- `applied_label`: record opaque paper/film material, color, opacity, boundary, adhesive, bleed/die-cut assumptions, and finish.
- `clear_label`: record transparent film boundary, opacity, printed ink, selective `white_underbase`, varnish, and registration assumptions.
- `direct_surface_print`: record package material/coating, ink adhesion, opacity, rub resistance, curvature, registration, and supplier capability; never invent label-stock fields.
- `in_mold`: record molding-compatible material/process assumptions.
- `foil_or_ink_only`: record only selected marks and compatible package-surface assumptions.
- `bare`: record where required regulatory/batch content moves; do not draw a placeholder panel.

Finish values such as matte, gloss, soft touch, metallic, or uncoated are intent and require supplier confirmation. Tactile intent such as emboss/deboss is not proven by a screen render.

## Element-to-process matrix

| Element | Primary process | Optional process/caution |
|---|---|---|
| brand wordmark / emblem | `screen_print` | `hot_stamp_foil`, `emboss`, or `deboss` where carrier permits |
| product name | `screen_print` | `hot_stamp_foil` for selected geometry |
| benefit / ingredient copy | `screen_print` or `offset_print` | check minimum physical text height |
| divider / frame | `screen_print` | `hot_stamp_foil` or `varnish` |
| dense back copy | `offset_print` or `digital_print` | applied carrier often improves fine-detail feasibility |
| batch / expiry | `batch_code` | preserve exact supplied/PLACEHOLDER state |
| clear-film color | `screen_print` or `digital_print` | add selective `white_underbase` only where opacity is required |

Use `data-proc="hot_stamp_foil emboss"` in mockup elements only as a presentation of the corresponding layer `processes`; the canonical blueprint remains authoritative.

## Legacy read-only migration

Legacy values are read-only migration input:

- `direct_print` -> `direct_surface_print`
- `paper_label` -> `applied_label`
- `foil_stamp` -> `foil_or_ink_only`; also preserve process `hot_stamp_foil`
- `bare_no_label` -> `bare`

Never emit legacy carrier values in a new design spec, blueprint, mockup, manifest, or Handoff v2. Migration is one-way; after normalization, reason only with the canonical carrier and explicit processes.

## Manufacturing boundary

Digital evidence does not certify ink adhesion, rub resistance, opacity, trapping, registration, foil/plate tolerances, adhesive durability, die cutting, tactile finish, or regulatory readiness. Require supplier samples and appropriate production review.
