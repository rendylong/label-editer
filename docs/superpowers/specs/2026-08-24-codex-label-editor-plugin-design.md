# GLB Label Editor Codex Plugin Design

**Date:** 2026-08-24
**Status:** Proposed for user review
**Plugin id:** `glb-label-editor`

## 1. Outcome

Convert the current repository into an installable Codex plugin whose primary interface is Agent tools and a machine-readable CLI. The existing React/Konva/Three editor remains the single visual rendering runtime and becomes an internal, human-takeover workspace owned by the plugin.

The plugin must support a complete local workflow without requiring the user to manually operate the browser:

1. inspect a GLB;
2. select or detect label surfaces;
3. validate and apply a structured label specification;
4. render color and PBR channels in the browser runtime;
5. validate design and print readiness;
6. export PNGs, editable project JSON, print manifest, preview image, and labeled GLB;
7. return a stable JSON result to the calling Agent.

The browser may be opened for review or takeover, but headless Agent execution cannot depend on UI clicks or DOM selectors.

## 2. Current repository baseline

The current working tree already contains uncommitted product work and must be preserved. The plugin migration builds on these capabilities:

- GLB scene analysis, mesh candidate detection, cylindrical/planar remapping, and geometry-derived canvases;
- multiple areas, including independent front/back overlays on the same mesh;
- editable text, image, and native shape layers;
- text box sizing, wrapping, LTR/RTL direction, language metadata, and Arabic font coverage;
- paper/background controls and layer/global craft effects;
- Color, Metalness, Roughness, and Bump channel rendering;
- structured Label Spec v1 import;
- print dimensions, bleed, die-cut, minimum text height, spot colors, and print manifest checks;
- GLB reconstruction, cross-checking, and embedded editable project metadata.

At design time the current branch passes 44 test files / 401 tests and the production build. This is a baseline, not permission to overwrite the existing changes.

## 3. Why the browser remains the rendering runtime

A separate Node Canvas implementation would duplicate text shaping, font loading, Konva geometry, craft simulation, mask generation, and export behavior. The two renderers would inevitably drift.

Instead, the plugin uses a hybrid architecture:

- **Node/plugin runtime:** MCP transport, CLI parsing, filesystem access, session lifecycle, local HTTP server, input normalization, codec support, atomic artifact writes.
- **Browser runtime:** existing model/editor stores, Label Spec mapping, font/image readiness, Konva color bake, craft/PBR masks, Three preview, and cross-check rendering.
- **Shared pure modules:** schemas, GLB analysis, UV math, project serialization, layer mutations, print validation, and GLB reconstruction core.

Browser automation talks to a typed Agent Bridge. It does not click application controls.

## 4. Plugin structure

The repository root becomes the plugin root:

```text
glb-label-editor/
├── .codex-plugin/
│   └── plugin.json
├── .mcp.json
├── skills/
│   └── cosmetic-label-editor/
│       └── SKILL.md
├── scripts/
│   ├── mcp-server.mjs
│   ├── label-cli.mjs
│   └── plugin-runtime.mjs
├── src/
│   ├── agent/
│   │   ├── bridge.ts
│   │   ├── contracts.ts
│   │   ├── labelSpecSchema.ts
│   │   └── artifactExport.ts
│   └── ... existing application code
├── tests/
│   ├── agentBridge.test.ts
│   ├── cliProtocol.test.ts
│   ├── mcpProtocol.test.ts
│   └── pluginE2E.test.ts
└── package.json
```

The manifest points to `./skills/` and `./.mcp.json`. No `.app.json` is added merely to represent the web editor: the editor is a local plugin runtime, not an external connector. The MCP `open_label_editor` result provides the takeover URL.

No personal or team marketplace is modified as part of the repository conversion. Marketplace installation is a separate explicit delivery action.

## 5. Runtime architecture

### 5.1 Plugin runtime

The MCP server and CLI share one orchestration library. The library:

- creates an isolated session directory;
- resolves only explicit files inside allowed workspace roots;
- starts or reuses a token-protected localhost HTTP server;
- starts or reuses a plugin-owned Playwright browser;
- serves the built editor and tokenized input assets;
- invokes the browser Agent Bridge;
- receives exported artifacts from the browser;
- performs Node-side GLB codec normalization/reconstruction when required;
- atomically publishes the completed output directory.

Each session has an id, capability token, input fingerprint, status, warnings, and artifact manifest. Sessions are resumable during one MCP server lifetime and disposable after export.

### 5.2 Browser Agent Bridge

The editor registers `window.__GLB_LABEL_EDITOR_AGENT_V1__` only when all of the following are true:

- the page is served from loopback;
- the URL contains `agent=1`;
- the runtime handshake token matches the token issued by the local plugin server.

The bridge exposes typed methods:

```ts
interface LabelEditorAgentBridgeV1 {
  reset(): Promise<BridgeResult>
  loadModel(input: ModelLoadRequest): Promise<ModelInspection>
  applySpec(input: ApplySpecRequest): Promise<AppliedDesign>
  getProject(): Promise<SerializedProject>
  validateDesign(): Promise<DesignValidationReport>
  waitForReady(input?: ReadinessRequest): Promise<ReadinessReport>
  renderPreview(input?: PreviewRequest): Promise<ArtifactDescriptor>
  exportArtifacts(input: ExportRequest): Promise<ExportManifest>
}
```

Bridge requests and responses must be structured-clone-safe. Large GLBs and PNGs are transferred through tokenized same-origin URLs rather than base64 values in `page.evaluate`.

The bridge delegates to application/domain functions, not toolbar download functions. Existing browser actions are refactored so byte-producing operations and user-triggered downloads are separate adapters.

### 5.3 Codec path

The plugin normalizes compressed input before the browser editing pipeline when the browser-side glTF Transform path cannot decode it. The first implementation supports standard GLB and Draco GLB. Normalization must preserve scene hierarchy, mesh/node names, materials, transforms, and animations.

The manifest records whether the source was normalized and whether the output remains compressed. Unsupported Meshopt, KTX2, or external `.gltf` dependencies return a structured blocker; they cannot silently fall back to an incomplete export.

## 6. Agent-facing MCP tools

The plugin exposes coarse-grained tools to minimize Agent round trips:

### `inspect_model`

Inputs: `glb_path`, optional selection hints.
Returns: model fingerprint, dimensions, part tree, stable mesh selectors, label candidates, detected mapping mode, geometry quality, codec information, and warnings.

### `validate_label_spec`

Inputs: inline spec or `spec_path`, optional `glb_path`.
Returns: schema errors, ambiguous target selectors, missing assets/fonts, unsupported crafts, print-readiness issues, and a normalized execution plan. No files are changed.

### `apply_label_spec`

Inputs: `glb_path`, inline spec or `spec_path`, `output_dir`, `force`, optional `open_editor`.
Runs the complete transaction and returns the export manifest.

### `render_label_preview`

Inputs: session/project reference, view (`2d`, `split`, `3d`), channel, dimensions.
Returns: preview artifact and design validation summary.

### `export_label_assets`

Inputs: session/project reference, requested artifact list, output directory, `force`.
Returns: published files, hashes, dimensions, GLB cross-check, and warnings.

### `open_label_editor`

Inputs: session/project reference.
Returns: the tokenized localhost URL for human review and takeover.

Low-level area/layer mutations remain available through the CLI and shared API, but are not separate MCP tools in v1. An Agent should normally regenerate and reapply a declarative spec.

## 7. CLI contract

The CLI and MCP tools use the same orchestration functions:

```text
label-cli schema [--json]
label-cli inspect <model.glb> [--json]
label-cli validate <spec.json> [--glb model.glb] [--json]
label-cli apply <spec.json> --glb model.glb --output <dir> [--force] [--open] [--json]
label-cli preview <project-or-spec> --glb model.glb --output <png> [--view 2d|split|3d]
label-cli export <project.lbl.json> --glb model.glb --output <dir> [--force] [--json]
label-cli open <project-or-spec> --glb model.glb
```

`apply` is the primary Agent command. Project-level and layer-level commands may be added behind the same schemas, but the initial delivery avoids a stateful shell that can leave a half-mutated project.

When `--json` is set, stdout contains one JSON result only. Progress and diagnostic logs go to stderr. Exit codes are stable:

- `0`: success;
- `2`: invalid CLI usage;
- `3`: inaccessible input or output path;
- `4`: schema or design validation failure;
- `5`: ambiguous/missing model target;
- `6`: browser render/readiness failure;
- `7`: GLB reconstruction or cross-check failure;
- `8`: unsupported codec or source feature;
- `9`: output conflict without `--force`.

## 8. Label Spec v2

The current Label Spec v1 remains accepted. A strict v2 becomes the canonical Agent contract and receives an exported JSON Schema.

V2 adds:

- model target selectors (`meshIndex`, exact node name, material, or inspected stable selector);
- explicit `surfaceMode`, `side`, remap mode, and normalized area range;
- text, image, and all supported shape layers;
- strict craft schemas and global crafts;
- paper, print specification, language, writing direction, and asset references;
- stable optional ids for deterministic regeneration;
- optional variables for SKU text/image substitution;
- explicit export requests.

Unknown fields, invalid shapes/crafts, missing required assets, and out-of-range values are errors. Defaults are applied only where the schema documents them. Ambiguous model selectors are errors.

V1 import remains compatible but returns warnings for every inferred/defaulted value. V1 cannot claim production readiness if required print data is absent.

## 9. Supported label scenarios

The contract covers:

- independent label mesh replacement;
- transparent bottle-body printing/decal overlays;
- cylindrical full-wrap labels;
- front, back, and side partial labels;
- neck bands and seal bands;
- planar square-bottle faces, cartons, tube faces, and jar lids;
- multiple areas on one or multiple meshes;
- paper labels and transparent/direct-print simulations;
- multilingual LTR/RTL content;
- text, raster image, and native vector-like shape composition;
- layer and global foil, UV, matte, emboss, deboss, and stroke simulation;
- editable project, digital preview, PBR GLB, and print manifest delivery.

The plugin does not claim to generate press-ready PDF/AI dielines, verify regulatory copy, replace supplier proofing, or solve arbitrary high-distortion freeform surface flattening.

## 10. Transaction and artifact contract

`apply_label_spec` performs:

1. resolve and fingerprint inputs;
2. parse/validate the spec;
3. inspect and normalize the GLB;
4. resolve all targets without mutation;
5. create an isolated browser session;
6. load fonts and image assets;
7. apply all areas atomically;
8. wait for every area bake and validate owner/readiness keys;
9. run design and print checks;
10. render requested previews/channels;
11. reconstruct and independently reparse the GLB;
12. write artifacts to a temporary publish directory;
13. atomically rename the directory into place.

Default output:

```text
result/
├── labeled.glb
├── project.lbl.json
├── label-spec.normalized.json
├── print-manifest.json
├── preview-3d.png
├── areas/
│   └── <area-id>/
│       ├── color.png
│       ├── metalness.png
│       ├── roughness.png
│       └── bump.png
└── manifest.json
```

The manifest contains SHA-256 hashes, MIME types, pixel dimensions, physical print dimensions, input fingerprint, plugin/app versions, normalized codec status, validation issues, warnings, and GLB cross-check results.

No target is overwritten without `force: true` / `--force`. A failed run leaves no published partial output.

## 11. Error model

All MCP and JSON CLI responses use one envelope:

```json
{
  "ok": false,
  "operation": "apply_label_spec",
  "sessionId": "...",
  "error": {
    "code": "AMBIGUOUS_MODEL_TARGET",
    "message": "Node name matches more than one mesh",
    "path": "areas[0].target.nodeName",
    "details": { "candidates": [] },
    "suggestion": "Use the stable selector returned by inspect_model"
  },
  "warnings": []
}
```

Errors distinguish user-correctable validation issues, unsupported capabilities, transient browser failures, and internal faults. Internal stack traces are written only to diagnostic logs.

## 12. Security and lifecycle

- The runtime listens on loopback only and uses a random capability token per session.
- The Agent Bridge rejects non-loopback and missing/invalid tokens.
- Browser requests may fetch only session-scoped tokenized resources.
- Filesystem operations are limited to explicit allowed workspace roots.
- Input paths are resolved before use; output conflicts require force.
- Remote image/font URLs are disabled by default. Specs use local assets unless an explicit network policy permits a host.
- Every Playwright page/context is closed on session disposal; temporary files are removed after publish or failure.
- Artifact filenames are sanitized and cannot traverse directories.

## 13. Migration of existing application code

The migration preserves current UI behavior while introducing stable boundaries:

1. Extract browser-independent orchestration from Zustand-bound `modelLoader.ts` and `actions.ts`.
2. Split artifact creation from toolbar download adapters.
3. Replace permissive Label Spec mapping with strict v2 validation plus a v1 compatibility mapper.
4. Make structured import transactional: restore every area runtime before committing the new area set.
5. Register the guarded Agent Bridge in the application entrypoint.
6. Add plugin runtime/MCP/CLI files and manifests.
7. Update README so plugin installation and Agent invocation are primary; standalone Vite commands remain developer workflows.

Existing uncommitted product changes are not reverted or rewritten merely to simplify the plugin migration.

## 14. Verification gates

### Pure and protocol tests

- JSON Schema accepts every documented scenario and rejects unknown/invalid fields.
- V1 migration reports inferred defaults.
- model selectors reject ambiguity.
- structured import is all-or-nothing.
- CLI stdout remains one JSON object and exit codes are stable.
- MCP tool schemas and result envelopes remain stable.
- path traversal, overwrite, and token checks fail safely.

### Browser integration

- load the built-in real GLB and apply front/back Label Spec without UI clicks;
- load local fonts/images, including RTL Arabic text;
- wait for all area bakes;
- render Color and PBR channels with exact dimensions;
- open the human editor on the same session;
- produce a 3D preview with no console/page errors.

### End-to-end delivery

- one CLI `apply` command creates the complete output tree;
- exported GLB reparses independently, contains all area overlays/materials, and retains editable project metadata;
- original input bytes remain unchanged;
- artifacts match manifest hashes;
- a deliberately invalid spec publishes nothing;
- a second run refuses to overwrite unless `--force` is supplied;
- standard and Draco inputs both complete or return an explicit tested codec blocker until codec support is enabled.

### Repository/plugin gates

- existing full Vitest suite;
- production Vite build;
- plugin bridge/MCP/CLI tests;
- browser end-to-end workflow;
- `quick_validate.py` for the plugin skill;
- `validate_plugin.py` for the repository plugin root.

## 15. Delivery sequence

1. Define schemas and pure service boundaries.
2. Refactor artifact production away from browser downloads.
3. Implement guarded browser Agent Bridge.
4. Implement shared local plugin runtime and CLI.
5. Implement MCP tools and plugin skill.
6. Add codec normalization and transactional publish.
7. Add plugin manifests and documentation.
8. Run protocol, browser, export, plugin, and full regression gates.

Implementation starts only after this document is reviewed and approved.
