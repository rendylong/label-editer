# Label Design Approval, Carrier-Aware Mockups, and Fidelity Design

**Date:** 2026-08-26
**Status:** Approved
**Depends on:** `2026-08-25-local-agent-control-api-design.md`, `2026-08-25-label-qc-multi-view-design.md`

## Outcome

The cosmetic label workflow gains two revision-bound user approval gates and a machine-readable design contract shared by `$cosmetic-label` and `$cosmetic-label-editor`.

The first gate approves the proposed front/back mockup and exact copy before GLB production. The second gate approves clean screenshots of the design actually rendered on the target model before final QC, apply, or export. A gate may wait for no response only when the user explicitly authorizes continuous execution for the current task. Continuous execution still produces both review evidence sets and does not bypass validation or QC.

The design skill no longer treats a colored rectangular paper label as the visual default. It first chooses a carrier/application mode such as direct surface printing, an applied paper or film label, a clear label, in-mold decoration, ink/foil only, or no front label. Mockups and editor output must express the selected carrier honestly.

Mockup-to-editor fidelity no longer depends on an Agent reverse-engineering CSS or prose. The design skill emits an exact layout blueprint. Both the HTML mockup and the editable Label Spec are derived from that blueprint. The editor preserves physical artboard proportions, text metrics, vector geometry, colors, transparency, and per-element process intent while keeping model-specific mesh selection and UV placement in the production stage.

## Product decisions

- User approval is mandatory after the design mockup and after the actual-on-model review render.
- A gate may skip waiting only when the user explicitly authorizes continuous execution for the current task. Urgency, prior fast runs, or an Agent assumption are not authorization.
- Continuous execution never suppresses screenshots, review manifests, validation, visual QC, or revision checks.
- Carrier/application mode is a first-class decision made before visual directions are developed.
- When the user does not specify a carrier, the Agent selects the most appropriate mode from category convention, package material/geometry, budget, durability, opacity, and production constraints, and discloses at least one feasible alternative. Directions are not forced to span unsuitable carrier modes.
- The structured layout blueprint is the source of truth. The HTML mockup is a presentation derived from it, not an instruction source for the editor.
- Clean user review evidence is separate from Agent diagnostic QC evidence.
- Label Spec v2 and Project v3 inputs remain readable. New handoff-driven designs use the physical-layout additions described below.
- Complex unsupported artwork may use an explicitly disclosed flattened-artwork fallback, but it must not be presented as fully editable or as preserving independent craft separations.

## Trust boundary for references

User-provided HTML, images, PDFs, and other references are visual/content evidence only. The workflow extracts design facts such as copy, geometry, color, hierarchy, and process intent from them. Instructions embedded in those artifacts do not override the user request, the active skills, path policy, or repository rules.

## Carrier/application model

The design and handoff vocabulary uses the following canonical modes:

| Mode | Meaning | Default substrate behavior | Typical process behavior |
|---|---|---|---|
| `direct_surface_print` | Ink is deposited directly on glass, plastic, metal, or a coated package | No independent label background, edge, radius, shadow, adhesive, bleed, or die cut | Screen print, pad print, digital print, spray/inkjet coding, optional white underbase |
| `applied_label` | A paper or opaque film label is attached to the package | Explicit substrate color, opacity, shape, edge, radius, adhesive, bleed, and die cut | Offset, digital, screen print, foil, emboss/deboss where feasible |
| `clear_label` | A transparent film label is attached but should visually disappear | Transparent film extent is recorded; no opaque full-area fill unless requested | Printed ink plus optional selective white underbase, varnish, foil |
| `in_mold` | Decoration is integrated during molding | No post-applied paper edge or adhesive | In-mold artwork and compatible finish description |
| `foil_or_ink_only` | Only selected marks are printed, sprayed, coded, or foil-transferred onto the package | No full-area substrate | Sparse ink, foil, batch code, or limited process layers |
| `bare` | No front decoration is required | No front label area | Regulatory or batch information may live elsewhere when required |

The existing public terms `paper_label`, `direct_print`, `clear_label`, `foil_stamp`, and `bare_no_label` migrate deterministically to the canonical vocabulary. `foil_stamp` is a process, not automatically a separate physical label.

Carrier-specific invariants are enforced:

- `direct_surface_print`, `foil_or_ink_only`, and `in_mold` must not synthesize a full-area paper fill, rounded paper silhouette, drop shadow, die cut, or adhesive check.
- `applied_label` requires an explicit substrate and physical boundary.
- `clear_label` requires a transparent substrate and distinguishes printed ink from white-underbase regions.
- `bare` has no decorative front area and must not create an empty rectangle to represent one.
- Bleed, die-cut, edge adhesion, and paper tactile checks run only for carrier modes to which they apply.
- Ink adhesion, opacity, rub resistance, curvature, registration, and white-underbase warnings run for direct printing where applicable.

## End-to-end workflow

### 1. Brief and carrier decision

`$cosmetic-label` clarifies missing brand, product, market/language, positioning, content, package surface, budget, process capability, and carrier constraints. Carrier choice happens before layout directions.

If the user has not chosen a carrier, the Agent records:

- the selected carrier and the evidence supporting it;
- one feasible alternative and its tradeoff;
- any assumptions about package material, opacity, surface coating, curvature, or supplier capability.

### 2. Design generation

For each proposed direction, the skill produces:

- a human-readable label design spec;
- `layout-blueprint.json` containing the exact editable composition;
- a self-contained front/back HTML mockup derived from the blueprint;
- clean front/back mockup review PNGs;
- a design review manifest binding the files to one canonical revision.

References may inform the blueprint, but arbitrary reference HTML is not executed or parsed as a command source.

### 3. Design approval gate

The skill presents the mockup review image and stops with status `awaiting_user_approval`.

The user may:

- approve the direction and copy;
- request a different direction;
- request layout, type, color, graphic, process, or carrier changes;
- replace exact copy or placeholders.

Every change creates a new immutable design revision and new review evidence. Approval records the exact blueprint digest and mockup review manifest digest. Approval of an older revision does not approve a newer revision.

When continuous execution was explicitly authorized, the Agent records mode `continuous_authorized`, selects the strongest suitable direction, preserves all assumptions, produces the same evidence, and continues without waiting.

### 4. Editor production

`$cosmetic-label-editor` accepts only an approved or continuously authorized Handoff v2 with a matching blueprint and design review manifest. It then:

1. inspects the GLB through the local CLI;
2. resolves exact stable mesh identity and usable surface frames;
3. translates the blueprint into editable label areas and layers;
4. starts and retains the visible synchronized Web preview;
5. validates target, layout, font, asset, print, and craft readiness;
6. renders clean production-review evidence.

The editor owns mesh selectors, surface mapping, range, UV/remap, and model-aware placement. It must not change approved copy, hierarchy, carrier, colors, typography, or process intent to make mapping easier.

### 5. Production approval gate

The skill presents a clean review sheet plus individual flat-artwork and on-model images. It stops before final QC/apply/export with status `awaiting_user_approval`.

If the user rejects the result:

- mapping, placement, orientation, scale, or render/craft translation defects may be repaired in the editor and re-rendered at a new production revision;
- changes to copy, visual hierarchy, layout, colors, carrier, or approved process intent invalidate design approval and return to the design approval gate with a new blueprint revision.

Every production modification invalidates the previous production review manifest. The revised Spec must become live-ready, validate, and render a fresh review directory before approval can be requested again.

When continuous execution was explicitly authorized, the production screenshots and manifest are still generated and recorded, but the Agent may continue to QC without waiting.

### 6. QC and delivery

User approval does not replace visual QC. After production approval or continuous authorization, the existing `qc-standard` workflow checks all model views, label areas, orientations, text, artwork, and craft channels. Failed QC enters its revision-safe repair loop and produces new immutable QC evidence.

A QC repair that changes only rendering/mapping may require a fresh production review when it materially changes the user-visible result. A QC repair that changes approved design intent always invalidates both approvals and returns upstream.

Only a current approval record, passing validation, passing visual QC, and successful output cross-check allow apply/export delivery to be described as complete.

## Explicit continuous authorization

Continuous authorization is scoped to the current task and selected design job. It is not inferred from:

- a previous conversation or prior project;
- words such as urgent, quick, ASAP, or automatic;
- an existing `assumed_for_fast_run` handoff;
- a user approving only one of the two review gates.

The record contains:

```yaml
mode: explicit_approval | continuous_authorized
scope: current_task
design_revision: <canonical revision>
review_manifest_sha256: <sha256>
recorded_at: <ISO-8601>
```

Continuous authorization removes wait states only. It does not relax artifact creation, disclosure, revision binding, validation, QC, maximum repair rounds, or delivery checks.

## Editor Handoff v2

Handoff v2 retains human-readable design intent while binding it to machine-readable source artifacts:

```yaml
handoff_version: 2
status: awaiting_user_approval | approved | continuous_authorized
source:
  design_spec: <path>
  mockup_html: <path>
  blueprint: <path>
  design_review_manifest: <path>
approval:
  mode: explicit_approval | continuous_authorized
  blueprint_revision: <revision>
  blueprint_sha256: <sha256>
  review_manifest_sha256: <sha256>
model:
  glb_path: <path if supplied>
  package_type: <bottle | jar | tube | compact | other>
areas:
  - id: <opaque design area id>
    side: <front | back | left | right | wrap | top | bottom | neck | custom>
    carrier: <canonical carrier mode>
    placement: <human-readable intent>
    physical_size_mm: { width: <number or unknown>, height: <number or unknown> }
    blueprint_area_id: <matching area id>
assets: []
production_constraints: {}
assumptions: []
blockers: []
```

Rules:

- A Handoff with `awaiting_user_approval`, a missing digest, a digest mismatch, or non-empty blockers cannot enter production.
- Mesh selectors, node names, UV coordinates, and surface ranges remain excluded from the design handoff.
- Legacy `approved` Handoff v1 remains readable, but the new skill always emits v2.
- Legacy `assumed_for_fast_run` does not silently migrate to continuous authorization; explicit current-task authorization is required.

## Layout blueprint contract

The blueprint is versioned JSON with a canonical revision and digest. Its minimum structure is:

```text
version
revision
carrierDefaults
assets
areas[]
  id
  side
  carrier
  artboard.widthMm
  artboard.heightMm
  artboard.background
  placementIntent
  substrate
  layers[]
```

Every layer records common values:

```text
id
kind
boundsMm or normalizedBounds
anchor
rotation
opacity
visible
zIndex
processes[]
```

Text layers additionally record:

```text
text
language
writingDirection
fontAsset or fontStack
fontSizeMm
fontWeight
letterSpacingEm
lineHeight
alignment
wrapPolicy
maxLines
```

Shape/vector layers record exact dimensions and either supported shape parameters or a normalized SVG path. This supports open paths, partial frames, bottom gaps, compound outlines, contour lines, and non-rectangular decoration without rasterizing the entire design.

Substrate/background is area metadata, not an ordinary rectangle that is always synthesized. This distinction prevents direct printing from acquiring an accidental paper panel.

## Physical artboard and rendering fidelity

The editor separates three coordinate systems:

1. the approved physical design artboard;
2. the target model surface frame and placement extent;
3. the resolution-dependent bake texture.

Typography and geometry are first resolved on the physical artboard. They are then mapped to the selected model surface without using bake pixel dimensions as design units. Bake resolution may change without changing apparent physical type size, relative spacing, or layout hierarchy.

Target placement has an explicit aspect-fit policy. The editor preserves the declared artboard aspect ratio and either adjusts the mapped surface extent, applies an approved crop, or reports a blocking mismatch. It must not silently stretch the design to fill a differently proportioned UV range.

The current Label Spec v2 pixel fields remain supported for existing files. New handoff-driven production uses physical or normalized design fields that serialize into the editable project and round-trip without loss.

Both the HTML mockup and editor flat-artwork render are generated from the same blueprint. Fidelity checks compare label-local output rather than requiring the complete GLB bottle, lighting, and CMF to pixel-match a concept bottle mockup.

The fidelity check verifies at least:

- layer count, ids, order, visibility, and carrier behavior;
- bounds, anchor, alignment, and rotation;
- text content and physical typography metrics;
- colors and transparency;
- vector path/shape geometry;
- process assignments and required craft masks;
- artboard and target aspect preservation.

An optional perceptual image comparison may flag large differences between canonical mockup artwork and editor flat artwork, but it does not replace the structural checks or Agent review.

## Clean review CLI

Add a dedicated command instead of overloading `preview` or reusing diagnostic QC:

```text
label-cli review <spec-or-project.json> \
  --glb <model.glb> \
  --output <directory> \
  [--width <pixels>] \
  [--height <pixels>] \
  [--force] \
  [--json]
```

The command loads and applies the input once, waits for the exact ready revision, and captures all review artifacts in the same guarded browser session. Output publication is immutable and atomic like QC publication.

Required artifacts are:

- one flat color-artwork PNG per non-bare area;
- one face-on on-surface close-up per non-bare area;
- clean whole-model front and back PNGs when those views resolve usefully;
- a front/back review sheet composed from the available evidence;
- `review-manifest.json`.

Stable logical ids are used even when filenames require safe tokens. For a normal front/back product, the public convenience filenames are:

```text
label-front.png
label-back.png
model-front.png
model-back.png
review-sheet.png
review-manifest.json
```

Review images use a neutral background and deterministic lighting/cameras. They hide selection outlines, grid, transform controls, debug overlays, area markers, and diagnostic channels. Text and the label region must occupy enough pixels for user review.

`review-manifest.json` records:

```text
version
createdAt
input.kind
input.revision
input.sha256
blueprint.revision
blueprint.sha256
designReviewManifest.sha256
model.fingerprint
areas[]
artifacts[]
```

Each artifact contains a relative path, SHA-256, MIME type, dimensions, view kind, camera metadata when applicable, area id, and carrier. Missing, duplicate, unsafe, stale, or unreadable artifacts block approval.

The existing `preview` command remains a quick single-image Agent reasoning tool. `review` is the clean human design gate. `qc` is the complete diagnostic inspection gate.

## Approval records and invalidation

Design and production approval records bind to immutable manifest hashes. The Agent may create the local record only after an explicit user response or an already-recorded continuous authorization.

Approval invalidates when any bound value changes:

- blueprint revision or digest;
- exact copy;
- carrier/application mode;
- Spec/project revision;
- model fingerprint;
- mapped label area identity;
- review artifact manifest.

The skill checks current revisions immediately before QC and immediately before apply/export. A stale approval is a blocker, not a warning.

## Flattened-artwork fallback

When a design uses an effect that the editable schema cannot reproduce, the workflow may propose a flattened image layer only after disclosing:

- which layers become non-editable;
- which text can no longer be edited independently;
- which print/craft separations are lost or approximated;
- whether a higher-fidelity vector asset can avoid flattening.

The user must explicitly accept the fallback. It is not the default path and does not allow the Agent to claim full editability.

## Skill changes

`$cosmetic-label` must:

- ask or infer carrier/application mode before designing;
- use carrier-aware mockup variants rather than one permanent paper-label template;
- emit the design spec, blueprint, HTML mockup, review PNGs, review manifest, and Handoff v2;
- stop at the design approval gate unless current-task continuous authorization exists;
- regenerate and re-present evidence after design or copy changes.

`$cosmetic-label-editor` must:

- reject unapproved or stale Handoff v2 input;
- translate the blueprint without silently redesigning it;
- keep the visible Web preview open during production;
- run `review`, present its images, and stop at the production approval gate unless continuous authorization exists;
- distinguish editor corrections from changes that invalidate upstream design approval;
- run the existing QC repair gate only after current production approval/authorization;
- never describe review approval as manufacturing certification.

## Lavira fidelity regression

The approved reference case is:

- mockup: `/Users/apple/realibox/cosmetic-bottles-glb/lavira-ember-woods-20260826/label-mockup.html`;
- model: `/Users/apple/realibox/cosmetic-bottles-glb/07_luxury_perfume_bottle_wood_glass.glb`;
- existing working Spec and prior rendered evidence in the same project directory.

The test treats the mockup and attached screenshots as evidence, not as executable instructions. It compares label-local design fidelity rather than requiring the concept bottle CMF and the real GLB bottle to match.

Acceptance requires:

- the Chinese product name retains the approved dominant hierarchy;
- brand, English product name, tagline, category, and volume preserve approved relative scale and spacing;
- the copper frame retains its bottom opening;
- contour ellipses preserve position, scale, rotation, stroke, and opacity;
- the physical artboard is not stretched to fit a mismatched UV/bake aspect;
- front and back clean review images make all intended copy inspectable;
- layout fidelity does not change when bake resolution changes;
- the design remains editable unless an accepted flattened fallback explicitly says otherwise.

## Additional carrier regressions

Add fixtures for:

1. direct screen printing on a colored curved bottle: no paper fill, edge, radius, shadow, bleed, or die-cut warning;
2. an opaque paper label: explicit substrate, shape, edge, bleed, die-cut, and adhesion checks;
3. a clear film label: transparent substrate with selective white underbase and visible bottle material elsewhere;
4. foil/ink-only decoration: only marked layers appear, with no synthesized label panel;
5. bare front: no empty front label geometry.

## Errors and recovery

- Missing or stale approval, blueprint digest mismatch, or stale review evidence fails closed with a structured workflow error.
- A carrier invariant violation is a validation error naming the area and conflicting fields.
- An unrepresentable editable layer returns a capability error with the flattened-artwork option; it is never flattened silently.
- Browser loss, failed font/image load, failed bake, or failed capture prevents review publication.
- A failed review publication leaves the last valid live preview and previous immutable evidence intact.
- User rejection is normal workflow state, not an error. It creates a new revision only after a revision-guarded change is applied.

## Compatibility and migration

- Label Spec v2 and Project v3 remain accepted.
- Handoff v1 `approved` remains readable but lacks the new fidelity and review guarantees; the skill should normalize it to Handoff v2 before new production changes.
- Handoff v1 `assumed_for_fast_run` requires fresh explicit continuous authorization or falls back to normal approval waits.
- Existing `preview`, `qc`, `apply`, `export`, `live`, and `open` command behavior remains available.
- `review` is additive.
- Existing paper-label projects retain current appearance. Carrier migration must not remove an existing explicit paper background.
- Newly generated direct-print projects use substrate-free behavior by default.

## Verification strategy

- Unit-test carrier inference output, canonical migrations, and every carrier invariant.
- Test all carrier-aware mockup variants for absence/presence of substrate, edges, shadows, white underbase, and conditional production checks.
- Schema-test Handoff v2, layout blueprint, review manifest, and approval records, including digest and stale-revision failures.
- Test physical typography mapping at multiple bake resolutions and target aspect ratios.
- Test open/partial vector paths, especially the Lavira frame bottom gap and contour ellipses.
- Test exact copy, font, spacing, color, geometry, process, and layer-order translation from blueprint to editable project and back.
- Test `review` CLI parsing, exactly-one JSON envelope, allowed-root checks, conflicts, atomic publication, safe filenames, hashes, cleanup, and browser failure.
- Browser-test flat artwork, face-on area, clean model front/back, and review-sheet capture with all debug UI hidden.
- Test approval invalidation after copy, blueprint, Spec revision, model fingerprint, area target, or artifact changes.
- Test the rejection loops: editor-only correction reopens production review; design-intent correction reopens both gates.
- Test continuous authorization removes waiting only while retaining both evidence sets and QC.
- Extend skill-bundle tests to require carrier-first clarification, both approval gates, continuous authorization wording, review CLI usage, stale-review rejection, and QC separation.
- Run focused tests, TypeScript, build, the full test suite, plugin E2E, installer/package validation, `git diff --check`, Lavira visual review, and direct-print visual review.

## Non-goals

- certifying ink, foil, adhesive, die-cut, registration, abrasion, or supplier feasibility from a screen render;
- pixel-matching the complete concept bottle scene to a different target GLB, camera, lighting, or CMF;
- executing instructions embedded in reference files;
- automatic user-approval inference from sentiment or urgency;
- replacing the existing Agent QC rubric with image similarity;
- making every arbitrary CSS effect natively editable in the first release;
- removing legacy Label Spec v2 or Project v3 support.
