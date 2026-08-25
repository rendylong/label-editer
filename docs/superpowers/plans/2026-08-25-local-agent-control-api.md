# GLB Label Editor Local Agent Control API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task.

**Goal:** Replace MCP and Agent-driven UI automation with a pure-local, revision-safe CLI that automatically opens and continuously updates a read-only Web preview during design production.

**Architecture:** Label Spec v2 remains canonical. Pure-Node inspection/patching publishes validated atomic revisions; a foreground live controller watches the working spec and applies valid revisions through the existing tokenized browser bridge. The Web page is user-facing observation, never the Agent mutation channel.

**Spec:** `docs/superpowers/specs/2026-08-25-local-agent-control-api-design.md`

## Constraints

- Preserve existing one-shot headless render/export behavior.
- Force headful Chromium only for `live`.
- Remove MCP runtime, dependency, tests, installer wiring, and public claims.
- Keep existing CLI commands compatible.
- Do not touch user-owned input, bump versions, commit, push, or submit.

## Task 1: Pure project control

- Add deterministic canonical JSON and SHA-256 revisions.
- Validate and summarize Label Spec v2 / Label Project v3.
- Add transactional id-addressed area/layer patch operations.
- Reject stale revisions, duplicate ids, immutable identity/type changes, invalid indexes, partial transactions, and invalid final specs.
- Test in `tests/projectControl.test.ts`.

## Task 2: CLI protocol

- Add `project` and `patch` command parsing and envelopes.
- Keep them pure Node without creating the browser runtime.
- Publish patch results with temporary-file plus rename.
- Map `REVISION_CONFLICT` to exit 10 and `INVALID_PATCH_OPERATION` to exit 11.
- Test JSON parse failures and exactly-one-stdout-envelope behavior.

## Task 3: Live controller

- Add a testable watcher/controller with injected launch adapter.
- Validate before browser launch.
- Request `headless: false` and `agent-preview=1`.
- Detect atomic rename, debounce, ignore unchanged revisions, keep last-good state on recoverable invalid files, and fail on browser/page loss.
- Make shutdown idempotent.

## Task 4: Read-only Web preview

- Add bridge status contract and Zustand status state.
- Add dedicated preview shell with revision/error banner, area selection, view switching, viewport, and read-only summary.
- Make Konva label content non-listening in preview mode.
- Keep normal editor mode unchanged.

## Task 5: Skills-only installation

- Delete `.mcp.json`, MCP server, MCP test, and SDK dependency.
- Remove manifest MCP wiring.
- Generate an executable installed launcher containing the canonical runtime path.
- Forward signals for `live` and verify `schema --json` during installation.

## Task 6: Skill and documentation contract

- Pressure-test old instructions for exact edits and invalid-file recovery.
- Rewrite the editor skill around `inspect -> live -> project/patch -> validate/apply`.
- Explicitly forbid MCP, computer use, DOM automation, and Agent browser navigation.
- Reserve `open` for explicit human takeover.
- Describe skills-only public submission boundaries.

## Task 7: Verification

Run focused domain, CLI, live, bridge, UI, installer, skill, security, and E2E tests; TypeScript; build; full suite; package dry run; MCP residue scan; and `git diff --check`. Perform a bounded real headful live smoke test with a real GLB when available.
