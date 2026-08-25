# Plugins Directory submission package

This file collects the public listing copy and reviewer cases for GLB Label Editor. It is a preparation artifact, not evidence that OpenAI has accepted or published the Plugin.

## Submission type and boundary

- Submission type: **skills-only**.
- The plugin manifest bundles two skills and no MCP server connection.
- The production runtime, GLB files, CLI, loopback editor, Playwright Chromium, and generated artifacts remain on the user's Codex machine.
- Do not claim that ChatGPT Web can access a user's local GLB, run this local CLI, or open the loopback editor.
- Do not describe a public or hosted design service. No publisher-operated upload API or remote content store is part of this package.

## Listing

- Name: GLB Label Editor
- Category: Design
- Developer name: Realibox
- Website: https://github.com/rendylong/label-editer
- Support: https://github.com/rendylong/label-editer/issues
- Privacy: https://github.com/rendylong/label-editer/blob/main/PRIVACY.md
- Terms: https://github.com/rendylong/label-editer/blob/main/TERMS.md
- Short description: Design first, then locally produce cosmetic labels on GLBs.
- Long description: Clarify and approve a cosmetic label system, then use a pure-local Codex CLI to inspect packaging GLBs, atomically apply front, back, and wrap labels, automatically keep a read-only Web preview synchronized, validate print data, and export editable projects, PNG/PBR assets, print manifests, and labeled GLB files.

## Starter prompts

1. Design this cosmetic label with `$cosmetic-label`, then produce it locally on the GLB with `$cosmetic-label-editor` while I watch the real-time preview.
2. Normalize this approved packaging design into an Editor Handoff, apply exact front and back label changes by stable layer id, and export an editable project plus labeled GLB.
3. Inspect this bottle GLB, identify stable label surfaces, validate the supplied specification, and automatically keep a read-only Web preview open during production.

## Positive reviewer cases

### 1. Inspect a packaging model

- Prompt: Inspect a local packaging GLB and identify stable label targets without editing the model.
- Expected behavior: Resolve the installed local launcher and run `label-cli inspect`; do not guess repeated node names.
- Expected result: Model dimensions, codec status, mesh candidates, and exact stable selectors in one JSON envelope.

### 2. Apply exact revision-safe edits

- Prompt: Change three exact fields on existing front/back layers without replacing unrelated design data.
- Expected behavior: Run `project`, use its SHA-256 revision as `baseRevision`, and apply one id-addressed `patch --force` transaction to the designated working spec.
- Expected result: A new revision, three applied operations, no unrelated change, and an atomically published valid Label Spec.

### 3. Produce with real-time Web preview

- Prompt: Produce an approved two-area label while keeping a visible local preview synchronized.
- Expected behavior: Start `live` in a dedicated terminal session. The command itself launches headful Chromium. The Agent does not navigate, click, or use computer use on the page.
- Expected result: One tokenized loopback preview stays open, valid patch revisions update without navigation, and the user can inspect area and view modes through a read-only shell.

### 4. Recover from an invalid watched file

- Prompt: Continue after an incomplete JSON write appears in the working spec.
- Expected behavior: Keep the last valid preview, report the watcher error, restore a fully validated value through an atomic revision-guarded write, and continue on the same live session.
- Expected result: No blank or partially applied design; a later valid revision clears the error.

### 5. Export complete artifacts

- Prompt: Validate and export the final working spec into a new empty output directory.
- Expected behavior: Run local `validate`, compare against the approved handoff, then run `apply` without `--open`.
- Expected result: Labeled GLB, editable project, normalized specification, print manifest, preview, per-area PBR PNG channels, and artifact manifest.

## Negative reviewer cases

### 1. Missing upstream design handoff

- Scenario: The user asks the editor to invent and apply a new label before `$cosmetic-label` produces the current Editor Handoff.
- Expected behavior: Route through the design skill; do not silently invent copy, hierarchy, typography, or process.

### 2. Stale revision

- Scenario: Another process changes the working spec after `project` but before `patch`.
- Expected behavior: Return `REVISION_CONFLICT`, re-read the current value, and require a newly based transaction. Do not overwrite blindly.

### 3. Unauthorized overwrite

- Scenario: A delivery directory exists and the user did not request `--force`.
- Expected behavior: Return `OUTPUT_CONFLICT` and preserve existing files. The only default in-place overwrite is the explicitly designated working spec through revision-guarded `patch --force`.

### 4. Preview/browser loss

- Scenario: Headful Chromium cannot start or the live preview page is lost during production.
- Expected behavior: Stop production, report `BROWSER_NOT_READY`, and restart from the last valid working spec. Do not silently continue with PNG-only or headless output.

### 5. Request to control the page

- Scenario: A workflow suggests using DOM selectors, browser navigation, or computer use to edit the preview.
- Expected behavior: Refuse that control path and continue only through the local CLI. Use `open` solely for explicit human takeover.

## Reviewer installation evidence

The one-command installer must prove:

1. plugin installed and enabled;
2. both skills copied into the plugin root;
3. no `.mcp.json` or MCP manifest entry exists;
4. `plugin/bin/label-cli.mjs schema --json` returns `ok: true`;
5. Playwright Chromium and the built editor runtime are present;
6. a new Codex session discovers the skills.
