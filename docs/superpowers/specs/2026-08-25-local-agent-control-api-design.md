# GLB Label Editor Local Agent Control API Design

**Date:** 2026-08-25
**Status:** Approved and implemented
**Supersedes:** Agent-control, distribution, and live-preview sections of `2026-08-24-codex-label-editor-plugin-design.md`

## Outcome

GLB Label Editor is a skills-only, pure-local Codex plugin. The Agent controls it through `label-cli` and local JSON files. It does not expose or install an MCP server, and it does not use computer use, browser navigation, DOM selectors, or pointer automation to edit designs.

Label Spec v2 remains the canonical Agent-authored design. The existing React/Konva/Three application remains the single rendering runtime for model inspection, target resolution, texture/PBR bake, preview, export, and explicit human takeover.

## Runtime architecture

```text
Codex Agent
    |
    | local CLI + JSON files
    v
label-cli.mjs
    +-- project / patch (pure Node)
    +-- live (headful Playwright + file watcher)
    |      +-- automatically opened read-only Web preview
    |      +-- same-page revision updates
    +-- validate / preview / apply / export
           +-- plugin-owned browser renderer

Explicit user takeover only:
label-cli open -> tokenized editable 127.0.0.1 URL
```

The preview browser is plugin-owned Playwright Chromium launched with `headless: false`. Its existence does not make the browser the Agent control plane: the Agent continues to change only the working spec through the CLI.

## Plugin and installer boundary

- `.codex-plugin/plugin.json` contains `skills` and no `mcpServers` field.
- `.mcp.json`, the MCP server, its SDK dependency, and MCP protocol tests are removed.
- The installer copies the built runtime and Chromium locally, installs both skills, and generates `plugin/bin/label-cli.mjs` with the canonical absolute runtime entry.
- The launcher inherits stdio, forwards `SIGINT`/`SIGTERM`, and supports long-running `live`.
- Installation verification calls the installed launcher with `schema --json`.
- Public directory materials use the skills-only submission type and make no hosted-service or ChatGPT Web local-file claim.

## CLI contract

All JSON-mode commands write exactly one envelope to stdout. Progress and live revision events go to stderr.

```text
label-cli schema [--json]
label-cli inspect <model.glb> [--json]
label-cli project <spec-or-project.json> [--json]
label-cli patch <spec.json> --operations <operations.json> --output <spec.json> [--force] [--json]
label-cli validate <spec.json> [--glb <model.glb>] [--json]
label-cli live <working-spec.json> --glb <model.glb> [--json]
label-cli preview <spec-or-project.json> --glb <model.glb> --output <png> [--view 2d|split|3d] [--json]
label-cli apply <spec-or-project.json> --glb <model.glb> --output <dir> [--force] [--open] [--json]
label-cli export <project.lbl.json> --glb <model.glb> --output <dir> [--force] [--json]
label-cli open <spec-or-project.json> --glb <model.glb> [--json]
```

`project` validates and returns the full value, stable area/layer ids, and a deterministic `sha256:<hex>` revision. Object key order does not change the revision; array order does.

`patch` accepts Label Spec v2 only. Its operations document contains `version: 1`, required `baseRevision`, and an ordered `operations` array. Supported id-addressed operations are add/update/remove area, add/update/remove layer, and move layer. Area/layer identity and layer type are immutable within update operations.

A patch locks both its source and destination paths, re-reads the source revision under that lock, applies operations to an isolated clone, fully validates it, and publishes by same-directory temporary file plus rename only when every operation succeeds. The input/output may be identical only with explicit `--force`. `REVISION_CONFLICT` exits 10; `INVALID_PATCH_OPERATION` exits 11.

## Live preview contract

`live` is a long-running foreground process. It:

1. resolves and validates the GLB and initial working Label Spec;
2. creates a tokenized `127.0.0.1` session;
3. launches plugin-owned Chromium headful;
4. opens the editor with `agent-preview=1` automatically;
5. loads the model and applies the initial spec through the guarded bridge;
6. prints one success envelope with `sessionId`, `previewUrl`, revision, and `keepAlive: true`;
7. watches the exact working spec's parent directory so atomic rename writes are detected;
8. debounces, validates, and applies every new valid revision to the same page without refresh;
9. reports revision/error events on stderr;
10. retains the last valid preview when watched JSON is malformed or invalid;
11. treats page/browser loss as `BROWSER_NOT_READY` and stops production;
12. closes watcher, page, browser, and server on `SIGINT` or `SIGTERM`.

The Agent skill must start `live` before production revisions, keep its terminal session active, use `project` plus in-place `patch --force`, and wait for each revision event before continuing. It must not open or inspect the preview through browser control.

## Read-only Web shell

Agent preview mode renders a dedicated shell with:

- persistent “Agent 实时预览 · 只读” status, revision, and recoverable error;
- area selection;
- 2D, split, and 3D view switching;
- orbit/zoom and read-only inspection scrolling;
- no import, export, save, undo, redo, layer mutation, area mutation, or destructive controls;
- a non-listening 2D Konva label surface so displayed layers cannot be dragged or transformed.

Normal editable editor behavior is unchanged outside `agent-preview=1`.

## Security and compatibility

- Paths remain constrained to allowed roots.
- The editor binds only to loopback and uses per-session random tokens.
- CSP and asset upload protections remain active.
- One-shot rendering remains headless by default; only `live` forces headful mode.
- Existing `schema`, `inspect`, `validate`, `apply`, `preview`, `export`, and `open` commands remain compatible.
- `open` and `apply --open` are explicit human takeover features and are never added automatically by the skill.

## Non-goals

- hosted editor or public network API;
- public MCP endpoint;
- cloud storage or authentication;
- simultaneous human and Agent design mutation;
- Node-native duplicate renderer;
- press-ready PDF/AI proofing or manufacturing certification;
- version bump, changelog, commit, push, or directory submission.
