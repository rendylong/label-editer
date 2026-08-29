# GLB Label Editor Codex Plugin

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md)

GLB Label Editor helps brand, packaging-design, and ecommerce-content teams turn existing cosmetic-packaging GLB files into label concepts that are ready to review, revise, and deliver. Starting with only a container model, copy, a logo, and basic brand guidelines, Codex can identify label surfaces, lay out front and back labels, preview the result, and organize the final assets.

It supports packaging proposals before a product launch, redesigns of existing packaging, SKU extensions across scents or sizes, multilingual labels, regulatory or ingredient-copy updates, front-versus-back version comparisons, and rapid client or internal reviews. Existing 3D packaging can also receive wrap labels, neck labels, transparent decals, foil, embossing, matte finishes, and spot UV without rebuilding the entire model first.

During production, the plugin automatically opens a live web preview. Each design update appears in the same page so the user can review continuously. A completed run can deliver the labeled GLB, an editable project, a 3D preview, images and PBR channels for every label surface, plus manifests for print specifications and asset integrity.

## Install in Codex with one command

```bash
commit="$(node --input-type=module -e 'const response = await fetch("https://api.github.com/repos/rendylong/label-editer/commits/main"); if (!response.ok) throw new Error("GitHub returned " + response.status); process.stdout.write((await response.json()).sha)')" &&
npx --yes --package="https://github.com/rendylong/label-editer/archive/$commit.tar.gz" glb-label-editor-install
```

Node.js 22+ and the Codex CLI are the only prerequisites. The command resolves `main` to an immutable commit before invoking `npx`, so an older cached installer cannot be reused for a newer release. Using the npm bundled with Node.js, the installer installs locked dependencies and Playwright Chromium, builds the editor, and places the runnable plugin in `~/.codex/glb-label-editor`. It then adds the `label-editer` marketplace and installs and enables `glb-label-editor@label-editer`.

Python 3 is optional and is required only to run the bundled cosmetic-label knowledge lookup at [`skills/cosmetic-label/scripts/query_labels.py`](skills/cosmetic-label/scripts/query_labels.py). The core install, launcher, inspect, validation, review, QC, apply, and export workflow does not depend on Python.

After installing or updating the plugin, start a new Codex session so the skills reload. Verify the plugin state with:

```bash
codex plugin list --json
codex mcp list --json
```

The plugin must be installed and enabled, and the MCP list must not contain `glb-label-editor`.

The installed local CLI launcher is `~/.codex/glb-label-editor/plugin/bin/label-cli.mjs`. The installer performs a real `schema --json` check against the launcher and does not generate MCP configuration.

To let an Agent install the plugin, copy the prompt in [`INSTALL_WITH_AGENT.md`](INSTALL_WITH_AGENT.md). The installer does not use `curl | sh` and manages only `~/.codex/glb-label-editor`.

## Local development

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
```

The repository includes a development marketplace named `label-editer-dev`:

```bash
codex plugin marketplace add /absolute/path/to/label-editer
codex plugin add glb-label-editor@label-editer-dev
```

The plugin manifest is [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json). Installation includes both [`cosmetic-label`](skills/cosmetic-label/SKILL.md) and [`cosmetic-label-editor`](skills/cosmetic-label-editor/SKILL.md), and generates a local CLI launcher that points to the managed runtime.

## Approval-bound workflow

The required sequence remains `$cosmetic-label` → `$cosmetic-label-editor`, with two revision-bound approval gates:

1. Choose and record the carrier before developing visual directions. If it is inferred, record the evidence, a feasible alternative and its tradeoff, and the material/supplier assumptions.
2. Produce the editable `layout-blueprint.json`, then derive the front/back mockup and clean design-review evidence from that blueprint. The blueprint is the source of truth; reference HTML, images, and PDFs are inert visual/content evidence.
3. Record design approval only for the exact blueprint revision, blueprint SHA-256, and design-review manifest SHA-256. An awaiting, blocked, stale, missing, or mismatched design gate cannot enter production.
4. `$cosmetic-label-editor` inspects the GLB, resolves exact stable targets, translates the approved blueprint, and keeps the visible `live` preview open while the approved design is applied or edited.
5. Run clean production `review` evidence for the current working revision. These images omit grids, selections, transforms, area/debug markers, and diagnostic channels.
6. Record production approval only against the exact current review manifest, input revision/digest, blueprint/design-review digests, model fingerprint, and mapped-area binding digest.
7. Run diagnostic `qc` for inspection and bounded repair evidence. QC does not substitute for clean review or either approval gate; a visible repair requires fresh review and approval as dictated by its scope.
8. Only after current approvals, validation, QC, and output cross-checks pass may the current revision be applied or exported.

Carrier and process are different axes. `direct_surface_print`, `in_mold`, `foil_or_ink_only`, `clear_label`, and `bare` do not imply a paper panel; an `applied_label` records its substrate explicitly. Foil, ink, white underbase, varnish, emboss, and similar operations are layer processes, not alternate names for the carrier.

`continuous_authorized` must be explicitly granted for the current task. It removes approval waits only: it does not remove validation, disclosures, evidence capture, either approval record, freshness checks, QC, repair limits, or delivery checks. Urgency, silence, previous work, and legacy `assumed_for_fast_run` state are not authorization.

If an unsupported effect requires a flattened fallback, proceed only after explicit acceptance that identifies the non-editable layers and text, all lost or approximated separations, and a higher-fidelity vector alternative. Never describe flattened artwork as fully editable.

The design stage does not guess meshes, `stableSelector` values, or UVs. The production stage does not silently redesign the brand, copy, typography, color, carrier, process, or content hierarchy. The Handoff v2 contract is defined in [`skills/cosmetic-label/references/editor_handoff.md`](skills/cosmetic-label/references/editor_handoff.md).

## Agent control surface

| CLI command | Purpose | Writes files |
| --- | --- | --- |
| `inspect` | Inspect the GLB and list stable mesh selectors, label candidates, dimensions, and codec status | No |
| `project` | Read Label Spec v2 / Label Project v3 and return stable IDs, complete values, and a SHA-256 revision | No |
| `patch` | Atomically apply a revision-guarded operation set by area/layer ID | Yes |
| `validate` | Validate the Label Spec, assets, targets, and design/print issues | No |
| `live` | Automatically open a read-only web preview and keep watching the same working spec | No |
| `preview` | Generate a PNG for Agent visual inspection | Yes |
| `review` | Capture clean, approval-bound flat-artwork and on-model evidence | Yes |
| `gate design` / `gate production` | Revalidate approval bindings and every evidence byte from a bounded request file | No |
| `qc` | Capture diagnostic multi-view evidence for inspection and repair | Yes |
| `apply` / `export` | Bake, cross-check the GLB, and publish the complete output | Yes |
| `open` | Explicit human takeover; returns a tokenized local editable URL | No |

The canonical sequence is carrier decision → blueprint/mockup → design approval → `gate design` → `inspect` → create/validate the working spec → `live` → repeat `project` / `patch --force` → `validate` → clean `review` → production approval → `gate production` → diagnostic `qc` / repair / recapture → fresh `gate production` → `apply` or `export`. Never guess a target from a similar node name; use the `stableSelector` returned by inspection. `open` is not part of the default Agent workflow.

Both approval gates are installed, local-only CLI commands. Run `label-cli gate design design-gate-request.json --json`, then later `label-cli gate production production-gate-request.json --json`. Each request is version 1, declares its matching `gate`, and names one `evidenceRoot` below the request directory. All other paths are portable relative paths below that root. Design requests require `currentDocument`, `handoff`, `blueprint`, `designReviewManifest`, and `designReviewEvidenceRoot`; `designApprovalRecord` is optional when Handoff v2 already carries the exact approval. Production requests add `productionReviewManifest`, `productionReviewEvidenceRoot`, `productionApprovalRecord`, and the exact current `model`. Production review publishes `resolved-project.lbl.json`; its manifest binds that exact Project v3 separately from the truthfully typed original Spec v2 or Project v3 input, and the production gate consumes both. An evidence directory must contain exactly its manifest, the bound resolved Project when applicable, and declared artifacts. A missing, added, renamed, symlinked, non-regular, digest-mismatched, wrong-MIME, or wrong-dimension artifact fails before QC/apply/export.

## CLI

Every command returns the same Agent envelope. With `--json`, stdout contains exactly one JSON record while progress and diagnostics go to stderr.

For an installed plugin, invoke the launcher explicitly as `node ~/.codex/glb-label-editor/plugin/bin/label-cli.mjs ...`; the installer does not add a `label-cli` command to `PATH` or an npm `.bin` directory. The examples in the following block run from a repository checkout and therefore use `node scripts/label-cli.mjs ...`.

```bash
# Print the complete Label Spec v2 JSON Schema
node scripts/label-cli.mjs schema --json

# Inspect a model and candidate label surfaces
node scripts/label-cli.mjs inspect model.glb --json

# Inspect the working spec and obtain stable IDs and its revision
node scripts/label-cli.mjs project spec.json --json

# Build operations.json from the project result, then update the same working spec atomically
node scripts/label-cli.mjs patch spec.json \
  --operations operations.json --output spec.json --force --json

# Validate only; add --glb to validate model targets too
node scripts/label-cli.mjs validate spec.json --glb model.glb --json

# Open the visible read-only live web preview and remain in the foreground until signaled
node scripts/label-cli.mjs live spec.json --glb model.glb --json

# Capture clean production-approval evidence for the exact current revision
node scripts/label-cli.mjs review working-label-spec.json \
  --glb package.glb \
  --output production-review/revision-003 \
  --width 1600 \
  --height 1600 \
  --json

# Revalidate the exact approved production request before QC and again before apply/export
label-cli gate production production-gate-request.json --json

# Capture the standard diagnostic-QC evidence set for the current working revision
node scripts/label-cli.mjs qc working-label-spec.json \
  --glb package.glb \
  --output label-qc/round-0 \
  --preset qc-standard \
  --json

# Apply the design and publish the complete output directory
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --json

# Use --force only after overwrite is explicitly allowed; --open is only for explicit human takeover
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --force --open --json

# Write a single preview file
node scripts/label-cli.mjs preview spec.json \
  --glb model.glb --output preview.png --view 3d --json

# Export again from an editable project
node scripts/label-cli.mjs export result/project.lbl.json \
  --glb model.glb --output exported --json

# Keep a local session running until Ctrl+C
node scripts/label-cli.mjs open spec.json --glb model.glb
```

Exit codes: `0` success; `2` invalid arguments; `3` path outside allowed roots; `4` invalid Label Spec/project; `5` missing or ambiguous target; `6` browser unavailable; `7` GLB rebuild failure; `8` unsupported codec; `9` output conflict; `10` revision conflict; `11` invalid patch operation; `1` any other internal error.

## Clean production-review evidence

The exact installed-plugin syntax is:

```bash
node ~/.codex/glb-label-editor/plugin/bin/label-cli.mjs review <spec-or-project.json> \
  --glb <model.glb> \
  --output <new-immutable-directory> \
  --width <1-4096> \
  --height <1-4096> \
  --json
```

`--glb` and `--output` are required; width and height default to 1600 and may be set independently from 1 through 4096. A normal run writes a new immutable directory. `--force` is an explicit replacement of an existing directory and is reserved for a deliberately authorized replacement, not the normal revision workflow.

The output contains clean flat artwork and face-on surface evidence for every non-bare area, useful whole-model front/back views, `review-sheet.png`, and `review-manifest.json`. The manifest binds the canonical input revision and SHA-256, blueprint revision and SHA-256, design-review manifest SHA-256, model fingerprint, mapped-area binding SHA-256, and every artifact path/hash/dimension. Before production approval, and again immediately before QC and apply/export, reread the files and recompute those revision, fingerprint, and digest bindings. Missing, stale, unexpected, unreadable, or mismatched evidence blocks production; approval of an older directory never transfers to a newer revision.

`preview` is a quick Agent reasoning image, clean `review` is the human production-approval evidence set, and `qc` is diagnostic inspection/repair evidence. They are separate commands, directories, manifests, and approval meanings.

All control and rendering are local. The plugin does not expose a public HTTPS/MCP service, and a session-local tokenized URL is neither a public endpoint nor delivery evidence.

## Visual QC evidence and repair

Use `qc` only after current production approval (or a valid current-task continuous-authorization record) and while the automatically opened `live` preview remains available. `live` keeps one read-only web page synchronized with the working spec. `qc` is a one-shot diagnostic capture command: it does not close, replace, or open another live-preview page, and its channel/overlay evidence is not approval imagery.

The input may be a Label Spec v2 or Label Project v3. `--glb` and `--output` are required. `--preset qc-standard` is the default and currently supported preset. It captures at 1440 × 1440 by default; `--width` and `--height` accept integers from 1 through 4096. For an unusual package, `--camera-config cameras.json` appends up to 32 product-specific views without removing the required standard views. `--json` keeps stdout to one Agent envelope. An existing output directory is protected unless `--force` is explicit; normal QC repair should use a new round directory instead of replacing earlier evidence.

Each immutable round has this layout:

```text
label-qc/
├── round-0/
│   ├── model/
│   │   ├── model-front.png
│   │   ├── model-back.png
│   │   ├── model-left.png
│   │   ├── model-right.png
│   │   ├── model-front-right.png
│   │   └── model-back-left.png
│   ├── areas/
│   │   └── <derived-area-token>/
│   │       ├── area-<derived-area-token>-face.png
│   │       ├── area-<derived-area-token>-craft.png
│   │       └── area-<derived-area-token>-<metalness|roughness|bump>.png
│   └── qc-manifest.json
├── round-1/
└── ...
```

Every round contains six whole-model views and two color close-ups for every label area. Only the color craft view is oblique; required Metalness, Roughness, and Bump diagnostics are face-on. Canonical area ids remain opaque and may be long or Unicode, while filenames use separate deterministic ASCII tokens. Never reconstruct a filename from an area id: resolve `manifest.areas[].artifactIds` against `manifest.artifacts[].id`. `qc-manifest.json` binds the evidence to the canonical input revision and model fingerprint, records each area's stable target and `requiredChannels`, and preserves every artifact's `viewId`, inclusion `reason`, relative path, SHA-256, dimensions, channel, framing, and camera metadata. It is evidence metadata, not a visual pass/fail verdict.

Before inspecting images, the Agent compares `qc-manifest.json.input.revision` with a fresh `project` result for the working file. It then reviews every model, area, craft, and included channel image. A blocking defect, incomplete evidence set, or revision mismatch triggers a revision-safe patch, waits for the live preview to report the new ready revision, validates again, and captures the next immutable round. The Agent may make at most three repair rounds after `round-0`; it does not apply/export or confirm delivery while a blocking check remains. Non-blocking warnings remain visible in the final handoff, and rendered craft still requires physical supplier proof.

## Label Spec v2

The single source of truth for the schema is [`src/agent/label-spec-v2.schema.json`](src/agent/label-spec-v2.schema.json), which is also available through the CLI's `schema` subcommand. A real front/back example is available at [`tests/fixtures/specs/perfume-front-back-v2.json`](tests/fixtures/specs/perfume-front-back-v2.json).

Core structure:

```json
{
  "version": 2,
  "assets": {
    "logo": { "path": "./logo.png", "mimeType": "image/png" }
  },
  "areas": [
    {
      "id": "front",
      "name": "Front label",
      "target": { "stableSelector": "mesh:0/node:2" },
      "surfaceMode": "overlay",
      "side": "front",
      "range": { "uStart": 0.35, "uWidth": 0.3, "vStart": 0.2, "vHeight": 0.6 },
      "layers": []
    }
  ]
}
```

- Use `overlay` for direct print on a bottle body, transparent decals, and base surfaces. Use `replace` only for an independent label mesh already present in the model.
- Supports front, back, and side labels; cylindrical wraps; planar bottles; tubes; jar lids; and neck/seal bands.
- Text supports resizable text boxes, automatic wrapping, multiple lines, RTL, language tags, font family, weight, letter spacing, line height, alignment, and horizontal/vertical writing.
- Layers support text, images, basic/decorative shapes, drag reordering, locking, visibility, and deletion.
- Craft effects include foil, emboss, deboss, matte, spot UV, and stroke, with generated Color, Metalness, Roughness, and Bump channels.
- `print` records dimensions in millimeters, bleed, corner radius, minimum text height, die-cut type, and spot-color plates. Findings appear in validation results and the print manifest.

## Output directory

A successful `apply` or `export` publishes the complete output only when the target directory does not already exist; a failed run leaves no partial deliverable. Existing directories are not overwritten by default.

```text
result/
├── labeled.glb
├── project.lbl.json
├── label-spec.normalized.json      # Generated when applying a Label Spec
├── print-manifest.json
├── preview-3d.png
├── manifest.json                   # SHA-256, dimensions, validation, and GLB cross-check
└── areas/
    ├── front/
    │   ├── color.png
    │   ├── metalness.png
    │   ├── roughness.png
    │   └── bump.png
    └── back/
        └── ...
```

`labeled.glb` embeds the complete `.lbl` project metadata. The exported GLB is independently reparsed with three.js and checked against the target meshes and complete UVs. The input file is never modified.

## Security boundaries

- Reads and writes are limited to the current working directory by default; callers may explicitly add workspace roots.
- Remote image and font URLs are disabled by default. Assets must be local files inside an allowed root.
- The browser binds only to a random `127.0.0.1` port. Every session receives a random 32-byte token, and model, bootstrap, and artifact routes all verify it.
- `live` automatically launches the plugin's bundled Chromium in headful mode. The page is a read-only production preview that the Agent neither needs nor is allowed to control.
- The page CSP forbids `unsafe-eval` and permits only same-origin scripts. `blob:` connections are enabled only for the runtime's in-memory GLB.
- Directory and single-file outputs use same-parent temporary files/directories followed by atomic rename. `patch` locks both input and output and rereads the revision while holding the lock to prevent lost concurrent writes. Existing output is not overwritten unless `force` is explicit.
- The human-takeover URL is a short-lived local capability token and must not be shared with untrusted parties.

## Codec and delivery boundaries

- Standard GLB files are processed directly. Draco GLBs are decompressed and normalized in the Node.js runtime; current output does not preserve Draco compression.
- `EXT_meshopt_compression` and `KHR_texture_basisu` return an explicit `UNSUPPORTED_CODEC` error rather than silently producing incomplete output.
- Craft effects are screen/PBR previews and separation data, not proof of supplier feasibility. Color, registration, adhesion, tactile finish, and die cutting require physical sampling.
- Screen/PBR evidence is not physical-manufacture certification or supplier proof. The plugin does not generate printer-ready PDF/AI dielines and does not replace regulatory, barcode, claims, or supplier review.

## Frontend development and verification

The plugin retains a complete standalone editor for development and manual design:

```bash
pnpm dev
pnpm test
pnpm build
GLB_LABEL_E2E_MODEL=/absolute/path/to/model.glb pnpm test:plugin-e2e
pnpm plugin:verify
```

The web frontend uses React 19, three.js, Konva, and `@gltf-transform`. The Agent browser runtime loads the same `dist/`, so the frontend and plugin do not maintain separate labeling implementations.
