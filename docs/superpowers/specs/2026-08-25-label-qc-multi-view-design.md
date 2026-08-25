# Label QC Multi-View Capture and Rework Design

**Date:** 2026-08-25
**Status:** Approved
**Depends on:** `2026-08-25-local-agent-control-api-design.md`

## Outcome

GLB Label Editor adds a deterministic `label-cli qc` workflow that captures a repeatable set of whole-model and per-label-area screenshots for Agent quality inspection. The CLI produces evidence and structural metadata; the Agent evaluates visual quality with a required rubric, repairs the Label Spec when a blocking defect is found, and captures fresh evidence again before confirming delivery.

The first version deliberately does not use OCR confidence, image-similarity scores, or a computer-vision pass/fail threshold. Those mechanisms are too brittle to be the delivery gate. Existing schema and print-readiness validation remain deterministic gates, while visual acceptance remains an evidence-backed Agent judgment.

## Product decisions

- Add a dedicated `qc` command rather than overloading the single-image `preview` command.
- Ship a stable `qc-standard` preset and support an optional JSON camera configuration for unusual products.
- Capture six whole-model directions, one face-on close-up per label area, and one oblique craft close-up per label area.
- Capture relevant PBR channel evidence only when the design uses those channels.
- Require a maximum of three automated repair-and-recheck rounds.
- Never confirm a failed or unverified design as complete.

## CLI contract

```text
label-cli qc <spec-or-project.json> \
  --glb <model.glb> \
  --output <directory> \
  [--preset qc-standard] \
  [--camera-config <cameras.json>] \
  [--width <pixels>] \
  [--height <pixels>] \
  [--force] \
  [--json]
```

The default dimensions are 1440 by 1440. Width and height are bounded to the same safe range as other preview rendering. `--output` is a directory and follows the existing path-root and conflict protections. The command refuses to replace an existing destination unless `--force` is present. Publication uses a staging directory followed by a same-parent rename so an interrupted run cannot expose a partial QC set.

JSON mode writes exactly one envelope to stdout. Progress is written to stderr. A successful envelope contains:

- the normalized input type and revision;
- the model fingerprint;
- the selected preset;
- the published manifest path;
- the complete public artifact descriptor list;
- validation warnings.

Existing `preview` behavior and output remain unchanged.

## Standard capture preset

`qc-standard` uses the editor's established world convention: Y is up and the viewer-facing front is +Z. All whole-model cameras look at the fitted model center and use the same projection, framing margin, background, lighting, exposure, and resolution.

| View id | Camera direction from model center | Purpose |
|---|---:|---|
| `model-front` | +Z | Primary front-label and hierarchy check |
| `model-back` | -Z | Back-label placement and legal-copy check |
| `model-left` | -X | Left seam, wrap, protrusion, and clipping check |
| `model-right` | +X | Right seam, wrap, protrusion, and clipping check |
| `model-front-right` | +X +Z at 45 degrees | Front depth, adhesion, material, and edge check |
| `model-back-left` | -X -Z at 45 degrees | Back depth, adhesion, material, and edge check |

For each label area, the renderer also captures:

- `area-<area-id>-face`: a close-up aligned to the label surface and framed around that area's labeled range;
- `area-<area-id>-craft`: a close-up offset horizontally and vertically from the face-on pose so highlights reveal gloss, metalness, roughness, emboss, and bump behavior.

Area framing is computed from the resolved mesh, the area's remap/range, and the corresponding labeled surface samples. It must not infer identity from a non-unique node name. If a usable surface frame cannot be computed, the command fails with a structured error naming the area instead of silently substituting an unrelated camera.

The renderer restores the prior camera and channel after every capture sequence. A failed image aborts publication of the full set.

## Optional custom cameras

`--camera-config` accepts a versioned JSON document:

```json
{
  "version": 1,
  "views": [
    {
      "id": "pump-top",
      "direction": [0.4, 1, 0.4],
      "target": "model",
      "framing": "fit-model",
      "channel": "color"
    }
  ]
}
```

View ids must be unique and filesystem-safe. Direction vectors must be finite and non-zero. `target` is either `model` or an existing area id; framing is `fit-model` or `fit-area`. Custom views are appended to the preset rather than replacing required standard evidence. This prevents a caller from accidentally omitting a blocking inspection angle.

## Craft and channel evidence

Color images are always captured. When any area bake contains a non-empty craft contribution, the area gets extra face-on evidence for each relevant channel:

- metalness for foil or metallic contributions;
- roughness for gloss, matte, or spot-varnish contributions;
- bump for emboss, deboss, or texture-height contributions.

Channel views are diagnostic evidence, not a substitute for the oblique color/material render. The manifest records why each channel was included. A craft with no corresponding baked contribution is a validation failure rather than an omitted screenshot.

## Evidence manifest

The output directory contains PNG files and `qc-manifest.json`. The manifest is versioned and includes:

```text
version
createdAt
preset
input.kind
input.revision
input.sha256
model.fileName
model.fingerprint
model.dimensions
validation
areas[]
artifacts[]
```

Each area entry records stable area id, resolved mesh index, stable selector, node name for display only, declared side, surface mode, and the artifact ids that cover it.

Each artifact records id, relative file path, SHA-256, MIME type, dimensions, view kind, channel, camera position/direction/target/up/FOV, framing target, and optional area id. Paths in the manifest are always relative to the QC directory; the CLI response additionally exposes resolved published paths.

`input.revision` is the same canonical revision used by `project` and `patch`. An Agent must reject a QC set whose revision differs from the current working Spec. This is the stale-evidence guard.

## Agent QC rubric

The `cosmetic-label-editor` skill must treat visual QC as mandatory before final apply/export. It checks every label area and reports each item as `pass`, `warning`, or `fail`.

### 1. Target and labeled surface

- The label is attached to the intended package component and mesh.
- Front, back, and other declared sides are semantically correct.
- The target is not a cap, pump, neck ring, interior shell, or similarly shaped but incorrect part.
- The label follows the intended surface and does not float, intersect, or visibly z-fight.

### 2. Placement, coverage, and seams

- Size, margins, alignment, and visual balance match the design intent.
- Content stays inside the label area without clipping or unintended cropping.
- Wrapped labels join acceptably at side seams.
- Front and back areas do not overlap, exchange sides, or leak across their intended boundaries.

### 3. Orientation

- Text and artwork are upright and not mirrored.
- Reading direction matches the content language.
- Vertical copy follows its specified top-to-bottom or bottom-to-top direction.
- Orientation remains correct in both face-on and oblique views.

### 4. Text readiness

- All required text is present, readable, and unobscured.
- Glyphs load correctly with no missing-character boxes or corrupted shaping.
- No line, word, or glyph is clipped, unexpectedly wrapped, or outside its container.
- Contrast, hierarchy, spacing, and apparent physical size are adequate for the design intent.
- Required legal or product copy is compared with the supplied source, when available.

### 5. Artwork and brand assets

- Images, logos, marks, and barcodes load successfully.
- Aspect ratio is preserved unless distortion is explicitly intended.
- Cropping, pixelation, transparency, and edge quality are acceptable.
- Artwork is not accidentally reversed or substituted.

### 6. Craft and material rendering

- Foil, metallic, spot UV, gloss, matte, emboss, deboss, and texture effects occur on the intended layers and shapes only.
- Oblique color evidence shows the expected highlight or relief response.
- Diagnostic channels show a non-empty contribution in the intended region.
- Craft masks do not accidentally cover the whole label or disappear at their edges.
- The underlying package material and transparency remain intact outside the label.

The Agent must state that rendered craft is a visual simulation and does not certify press-ready separations, tolerances, inks, foils, plates, or supplier production settings.

### 7. Cross-view and output consistency

- A result that looks correct head-on does not fail from the side or rear.
- All areas are checked; passing the first area is insufficient.
- The 2D composition, 3D render, and channel output agree on placement and orientation.
- No unrelated geometry or material changes appear elsewhere on the model.
- When final export is requested, its existing artifact validation and GLB cross-check must also succeed before delivery is confirmed; that export check is separate from the visual QC verdict.

## Failure severity

`fail` is blocking and includes wrong target, wrong side, mirror/inversion, invisible or missing required text/artwork, clipping, severe overlap, missing craft, craft on the wrong region, broken asset/font, geometry intersection, material corruption, stale evidence, or incomplete area coverage.

`warning` is non-blocking only when the rendered result is visually coherent but a manufacturing or intent decision remains, such as borderline small copy, low contrast, seam sensitivity, or a supplier-dependent craft limitation. The warning must remain visible in the final handoff.

Every failed item records:

- area id and layer id when applicable;
- check category;
- concise defect description;
- one or more evidence artifact ids;
- proposed Spec change;
- repair round number.

## Required repair and recheck loop

The skill follows this sequence:

1. Start and retain the live preview process for the working Spec.
2. Validate the current Spec and model.
3. Run `label-cli qc` into a round-specific directory.
4. Verify the manifest revision matches the current working revision.
5. Inspect every required image and produce the rubric results.
6. If any blocking issue exists, patch the Spec through the revision-safe patch command.
7. Wait for the live preview to report the new ready revision.
8. Validate again and create a new QC directory; never overwrite the previous round's evidence.
9. Compare the repaired area with prior evidence and recheck every area affected by the patch.
10. When no blocking visual issue remains, perform the requested apply/export and require its artifact validation and GLB cross-check to pass.
11. Confirm delivery only when both visual QC and the requested delivery pipeline succeed.

The Agent may perform at most three automated repair rounds after the initial inspection. If the third repair still fails, or a safe correction cannot be inferred, it stops changing the Spec, preserves the last valid preview and all evidence, and reports the remaining blocker. It must not apply/export or describe the design as completed.

Suggested directory layout:

```text
label-qc/
  round-0/
  round-1/
  round-2/
  round-3/
  qc-report.json
```

The Agent's report references artifact ids from each immutable round. The CLI does not author the visual verdict.

## Runtime architecture

The browser bridge extends preview capture with an explicit camera pose, framing target, channel, and artifact id. The CLI loads and applies the model/spec once, waits for fonts, images, and all area bakes once, then performs the capture sequence in the same guarded browser session.

Scene camera changes are programmatic render state, not editor interaction. The camera service:

- computes deterministic fit distances from bounding boxes/spheres;
- keeps a stable vertical orientation near pole views;
- updates controls and render matrices before capture;
- waits for one committed render frame;
- restores previous camera, controls target, projection, and channel in `finally`;
- emits no persistent mutation to the Label Project.

Per-area surface frames use stable mesh identity and transformed geometry. Mirrored world transforms and surface normals are handled explicitly so a face-on camera does not turn mirrored content into an apparent pass.

## Errors and recovery

New invalid camera configuration and capture-planning errors use `INVALID_USAGE`. Missing resolved targets use the existing model-target errors. Browser loss, renderer loss, or PNG encoding failure uses `BROWSER_NOT_READY` or `REBUILD_FAILED` as appropriate.

No destination is published unless validation, capture planning, every image upload, manifest hashing, and manifest validation succeed. Temporary data is cleaned up after a failed run. Source Spec, model, current live preview, and previously published QC rounds remain unchanged.

## Compatibility and security

- Existing CLI commands, bridge methods, Spec v2, and Project v3 remain compatible.
- The new bridge request fields are optional for a normal one-shot preview.
- All paths pass through the existing allowed-root policy.
- Artifact filenames are generated from validated ids and cannot traverse directories.
- The QC manifest contains no bearer token, browser URL, or temporary asset URL.
- The command is one-shot and headless by default; it does not replace the separately running live preview.

## Verification strategy

- Unit-test camera presets, stable fitting, mirrored transforms, pole handling, custom-camera validation, filenames, and manifest schema.
- Test per-area capture planning across multiple areas and duplicate node names with distinct stable mesh selectors.
- Test channel inclusion for color-only and craft-bearing designs.
- Test that camera/channel state is restored after success and failure.
- Test atomic output publication, conflict behavior, cleanup, exactly-one JSON envelope, and stale-revision metadata.
- Extend browser-bridge tests for explicit camera/channel capture requests.
- Extend CLI E2E tests to verify all required PNG signatures, artifact count, relative paths, hashes, and manifest revision.
- Add a real GLB browser smoke test that visually checks one front/back label fixture and retains the evidence set for review.
- Add skill-bundle tests that require all rubric categories, manifest revision checking, three-round repair cap, and the prohibition on confirming a failed design.
- Run focused tests, TypeScript, build, the full test suite, installer/package validation, and `git diff --check`.

## Non-goals

- automatic OCR acceptance or visual-quality scoring;
- manufacturing certification or press-ready proof approval;
- arbitrary animation/video turntables;
- modifying the editable UI's normal camera behavior;
- redesigning the label schema or craft model;
- version bump, changelog, commit, push, or plugin-directory submission.
