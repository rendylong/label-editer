# Editor Handoff v2 — cosmetic-label to cosmetic-label-editor

Create this contract for every immutable design revision. It binds approved design evidence while leaving target selection, UV/range mapping, and model geometry to `$cosmetic-label-editor`.

```yaml
handoff_version: 2
status: awaiting_user_approval | approved | continuous_authorized
source:
  design_spec: <path>
  mockup_html: <path>
  blueprint: <path>
  design_review_manifest: <path>
  blueprint_revision: <canonical revision>
  blueprint_sha256: <64 lowercase hex characters>
  review_manifest_sha256: <64 lowercase hex characters>
approval:
  mode: explicit_approval | continuous_authorized
  scope: current_task
  blueprint_revision: <same canonical revision>
  blueprint_sha256: <same blueprint SHA-256>
  review_manifest_sha256: <same design-review manifest SHA-256>
model:
  glb_path: <path if supplied>
  package_type: <bottle | jar | tube | compact | other>
areas:
  - id: <opaque design area id>
    side: <front | back | left | right | wrap | top | bottom | neck | custom>
    carrier: <direct_surface_print | applied_label | clear_label | in_mold | foil_or_ink_only | bare>
    placement: <human-readable physical intent>
    physical_size_mm: { width: <number or unknown>, height: <number or unknown> }
    blueprint_area_id: <matching layout-blueprint area id>
assets:
  - id: <opaque asset id>
    path: <allowed local path>
    sha256: <64 lowercase hex characters>
    mime_type: <optional MIME type>
production_constraints:
  budget: <optional constraint>
  durability: <optional constraint>
  process_capabilities: [<supported process>]
  notes: [<production note>]
assumptions: [<explicit assumption>]
blockers: [<unresolved production blocker>]
```

## Binding rules

- Preserve exact supplied copy. Use explicit `PLACEHOLDER` values for missing regulatory, ingredient, barcode, batch, expiry, origin, or other legal content.
- `source` paths and hashes, `approval` hashes, blueprint revision, area ids, carriers, physical sizes, and asset hashes must agree with the current immutable design evidence.
- `approved` requires an explicit approval of those exact hashes. `continuous_authorized` requires a pre-existing explicit record with `scope: current_task` bound to those exact hashes.
- `awaiting_user_approval`, a missing or mismatched digest, or any non-empty `blockers` list stops production.
- Do not include mesh, node, material, UV, range, or `stableSelector` guesses. Resolve them only from the inspected GLB in the editor stage.

## Legacy normalization

Legacy Handoff v1 `approved` is readable but must normalize to a fresh draft and fresh evidence before any new review work. Legacy `assumed_for_fast_run` is not continuous authorization and cannot remove either approval wait. Urgency, silence, prior approvals, or assumed consent never upgrade legacy state. Create Handoff v2 and obtain an exact current-task approval or continuous-authorization record.
