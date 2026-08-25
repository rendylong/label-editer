# Plugins Directory submission package

This file collects the public listing copy and reviewer test cases for GLB Label Editor. It is a preparation artifact, not evidence that OpenAI has accepted or published the Plugin.

## Listing

- Name: GLB Label Editor
- Category: Design
- Developer name: Realibox
- Website: https://github.com/rendylong/label-editer
- Support: https://github.com/rendylong/label-editer/issues
- Privacy: https://github.com/rendylong/label-editer/blob/main/PRIVACY.md
- Terms: https://github.com/rendylong/label-editer/blob/main/TERMS.md
- Short description: Design first, then produce cosmetic labels on GLBs.
- Long description: Clarify and approve a cosmetic label system, inspect packaging GLBs, apply front, back, and wrap labels, keep a live browser preview open, validate print data, and export editable projects, PNG/PBR assets, print manifests, and labeled GLB files.

## Starter prompts

1. Design this cosmetic label with `$cosmetic-label`, then produce it on the GLB with `$cosmetic-label-editor`.
2. Normalize this approved packaging design into an Editor Handoff, apply front and back labels to the GLB, and export an editable project plus labeled GLB.
3. Inspect this bottle GLB, identify stable label surfaces, validate the supplied label specification, and keep the browser preview open while producing the final assets.

## Positive reviewer cases

### 1. Inspect a packaging model

- Prompt: Inspect `public/sample/面霜瓶.glb` and identify stable label targets without editing the model.
- Expected behavior: Use `inspect_model`; do not guess repeated node names.
- Expected result: Model dimensions, codec status, mesh candidates, and exact stable selectors.
- Fixture: `public/sample/面霜瓶.glb`.

### 2. Validate a front-and-back specification

- Prompt: Validate `tests/fixtures/specs/perfume-front-back-v2.json` against its referenced GLB and report blockers without writing output.
- Expected behavior: Use `validate_label_spec` after inspection.
- Expected result: Structured validity, warnings, target resolution, and print-readiness findings.
- Fixture: The specification and its matching reviewer GLB.

### 3. Produce front and back labels

- Prompt: Apply an approved two-area label specification, keep the local editor preview open, and export all standard artifacts.
- Expected behavior: Inspect, validate, open the visible editor, then call `apply_label_spec` with `open_editor: true`.
- Expected result: Labeled GLB, editable project, normalized specification, print manifest, preview, per-area PBR PNG channels, and artifact manifest.
- Fixture: Reviewer-owned GLB plus an approved Label Spec v2.

### 4. Render a review preview

- Prompt: Render a split 2D/3D preview from an approved label project without modifying the source files.
- Expected behavior: Use `render_label_preview` with the split view.
- Expected result: A PNG preview at the requested output path and no source-file mutation.
- Fixture: Reviewer-owned GLB and `.lbl` project.

### 5. Export an editable project

- Prompt: Export a saved label project and source GLB into a new empty output directory.
- Expected behavior: Use `export_label_assets`; do not overwrite an existing directory unless the user explicitly requests force.
- Expected result: Complete export bundle with consistent artifact manifest and GLB cross-check.
- Fixture: Reviewer-owned GLB and `.lbl` project.

## Negative reviewer cases

### 1. Missing upstream design handoff

- Scenario: The user asks the editor to invent and apply a new label without first using `$cosmetic-label`.
- Expected behavior: Stop production and route through the design skill to create a current Editor Handoff.
- Why: The editor must not silently invent or redesign label copy, hierarchy, typography, or process.

### 2. Unauthorized overwrite

- Scenario: The requested output directory already contains files and the user has not explicitly requested `force`.
- Expected behavior: Return an output-conflict error and preserve existing files.
- Why: Export is intentionally atomic and non-overwriting by default.

### 3. Unsupported or ambiguous input

- Scenario: The GLB uses an unsupported codec or the requested target cannot be resolved unambiguously.
- Expected behavior: Return a structured blocker and do not publish partial assets.
- Why: Guessing a mesh or silently dropping unsupported data could corrupt the deliverable.

## Submission blockers

The current MCP server uses local `stdio` transport and local filesystem paths. OpenAI's public With MCP submission requires a public production MCP URL. A compliant hosted design must also define secure model upload/download, private storage and deletion, authentication, reviewer fixtures, resource limits, and a remote equivalent for the loopback editor workflow. Do not attest that the current local server meets those requirements.
