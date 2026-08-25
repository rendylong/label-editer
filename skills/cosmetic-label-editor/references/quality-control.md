# Cosmetic Label Quality Control

Use this rubric for every production QC run. `label-cli qc` produces evidence; the Agent authors the verdict. Deterministic validation remains a prerequisite, but it cannot decide visual acceptance.

## Evidence integrity and revision

Before scoring visual quality:

1. Run `label-cli project <working-spec.json> --json` and record its current `revision`.
2. Enforce the equality gate: `qc-manifest.json.input.revision` must exactly equal the current `project` revision.
3. Require the complete `qc-standard` evidence set and verify that every required artifact id resolves to the manifest's relative PNG path. A missing file, missing hash, duplicate id, unsafe path, unreadable image, incomplete area, or stale revision is a blocking `fail`; do not infer a verdict from partial evidence.
4. Require these model artifacts: `qc-model-front`, `qc-model-back`, `qc-model-left`, `qc-model-right`, `qc-model-front-right`, and `qc-model-back-left`.
5. For every label area `<area-id>`, require `qc-area-<area-id>-face` and `qc-area-<area-id>-craft`, plus every PBR artifact included by the manifest: `qc-area-<area-id>-metalness`, `qc-area-<area-id>-roughness`, and/or `qc-area-<area-id>-bump`.
6. Confirm the manifest covers every label area in the current project. Passing one area is insufficient.

Every check cites one or more evidence artifact ids from the same immutable QC round. Compare the 2D composition, 3D render, and channel output for the same current revision; none of those views substitutes for another.

## Verdict contract

Use exactly `pass | warning | fail`:

- `pass`: evidence is complete, current, and visually satisfies the check.
- `warning`: the rendered result is visually coherent, but a non-blocking manufacturing or intent risk remains, such as borderline-small copy, low contrast, seam sensitivity, or a supplier-dependent craft limitation. Preserve the warning in the final handoff.
- `fail`: delivery is blocked. This includes an evidence gap or stale revision, wrong target or side, mirror/inversion, invisible or missing required text/artwork, clipping, severe overlap, missing or misplaced craft, broken assets/fonts, geometry intersection, material corruption, or incomplete area coverage.

For each relevant area and layer, record a check rather than writing only an overall verdict. A report has this shape:

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

Every failed check includes its category, area id and layer id when applicable, a concise defect description, one or more evidence ids, a proposed Spec change, and the repair round. A warning uses the same evidence discipline but does not invent a repair when supplier confirmation is the actual next step.

## Target and labeled surface

- Confirm each label is attached to the intended package component and stable mesh, not a cap, pump, neck ring, interior shell, or similarly shaped wrong part.
- Confirm every declared front, back, side, wrap, neck, or seal area appears on the semantically correct surface.
- Inspect face-on and oblique evidence for floating, intersection, visible z-fighting, or failure to follow the intended surface.
- Treat a wrong target, wrong side, or visible surface attachment defect as `fail`.

## Placement, coverage, and seams

- Compare size, margins, alignment, and balance with the approved design intent.
- Check every label area for clipping, unintended cropping, leakage outside its mapped range, and front/back overlap or side exchange.
- Use left, right, front-right, and back-left model views to inspect wrap seams and boundary continuity; a face view alone cannot pass seam coverage.
- Inspect occlusion and deformation around shoulders, corners, curvature changes, pumps, caps, and neighboring geometry.
- Mark severe overlap, cropping, leakage, seam discontinuity, occlusion, or deformation as `fail`; supplier-sensitive seam tolerance may be `warning` only when the visible result remains coherent.

## Orientation

- Confirm text and artwork are upright and not mirrored in both face-on and oblique views.
- Confirm reading direction matches the content language and the Spec's `writingDirection`.
- Confirm vertical copy follows its specified top-to-bottom or bottom-to-top direction.
- Compare 2D placement with 3D evidence so a mirrored UV or world transform cannot appear to pass from only one view.
- Any unintended mirror, inversion, or reading-direction error is `fail`.

## Text readiness

- Confirm all required text is present, visible, readable, unobscured, and compared with the supplied source when available.
- Check for missing-character boxes, corrupt shaping, unintended wrapping, clipped lines/words/glyphs, and text outside its container.
- Evaluate contrast, hierarchy, spacing, and apparent physical size across face-on and whole-model views.
- Missing or unreadable required copy and broken glyph/font rendering are `fail`. Borderline size or contrast may be `warning` only when the text remains visually readable and the risk is explicitly handed off.

## Artwork and brand assets

- Confirm each image, logo, mark, and barcode is loaded and is the approved asset.
- Check aspect ratio, intended crop, resolution, transparency, edge quality, substitution, and accidental reversal.
- Treat missing, broken, substituted, severely pixelated, unintentionally distorted, or reversed required artwork as `fail`.
- Do not claim barcode scanability from a screenshot; record supplier or physical verification needs as a visible warning.

## Craft and material rendering

- Inspect `qc-area-<area-id>-craft` for the intended foil, metallic, spot UV, gloss, matte, emboss, deboss, or texture highlight/relief response.
- Inspect every included metalness, roughness, and bump artifact. The contribution must be non-empty, restricted to the intended layer/shape, and consistent with the oblique color evidence.
- Check that masks neither disappear nor cover the whole label accidentally and that the package material/transparency remains intact outside the label.
- Missing craft, craft on the wrong region, an empty required channel, or material corruption is `fail`.

Rendered craft is a visual simulation and does not certify press-ready separations, tolerances, inks, foils, plates, or supplier production settings.

## Cross-view and output consistency

- Compare all six model views with every area face/craft view. A head-on pass cannot hide side/rear seam failure, occlusion, floating geometry, or surface deformation.
- Check every label area and every view affected by target, mapping, material, or layer changes.
- Confirm the 2D composition, 3D render, and channel output agree on placement, orientation, visibility, crop, and craft location.
- Confirm no unrelated geometry or material changes appear elsewhere on the model.
- Keep QC status separate from final output validation. When apply/export is requested, require its artifact validation, manifest consistency, and GLB cross-check to succeed after visual QC passes.
- Do not confirm delivery while a `fail`, evidence gap, stale revision, output-manifest mismatch, or failed GLB cross-check remains. Preserve all `warning` checks in the final handoff.

## Repair and recheck evidence

Round 0 is mandatory. Any blocking `fail`—a visual defect, evidence gap, stale/mismatched revision, or incomplete required image set—uses this same ordered sequence:

1. Run `project`, take its current revision as `baseRevision`, and publish a revision-safe `patch --force` transaction to the same working Spec.
2. Capture the exact revision returned by the patch and wait until the live preview reports `ready` for that exact revision.
3. Run `validate` on that Spec/model, then run `qc` into the next immutable round directory. Never overwrite an earlier round.
4. Run `project` again and require `qc-manifest.json.input.revision` to exactly equal the current project revision.
5. Inspect every required image again, rewrite the complete rubric verdict, and compare the result with the prior round.

Stale evidence may require recapture rather than a content mutation. Use a revision-guarded empty patch when no content delta is needed; stale evidence still cannot bypass the gated sequence.

Repeat the complete sequence for every blocking failure, with only rounds 1, 2, and 3 allowed after round 0. Recheck every changed area and every view affected by a target, mapping, material, craft, or shared asset change as part of the full image inspection. If round 3 still fails, preserve the live preview and all evidence, stop changing the Spec, and report the remaining blockers without apply/export or delivery confirmation.
