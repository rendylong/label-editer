# Task 5: Revision-bound QC manifest

## Delivered files

- `scripts/lib/qc-output.mjs`
- `tests/qcOutput.test.ts`

## RED

Command:

```sh
pnpm vitest run tests/qcOutput.test.ts
```

Result before implementation: failed during test collection because
`../scripts/lib/qc-output.mjs` did not exist.

## GREEN and focused verification

Commands:

```sh
pnpm vitest run tests/qcOutput.test.ts
pnpm vitest run tests/qcOutput.test.ts tests/projectControl.test.ts
pnpm exec tsc -b --pretty false
git diff --check -- scripts/lib/qc-output.mjs tests/qcOutput.test.ts
```

Results:

- The final focused run passed 34 tests across `qcOutput` and `projectControl`.
- The QC-output suite passed 12 tests, including path-collision coverage.
- TypeScript build completed with exit code 0.
- The requested diff check produced no output.

## Full suite

Command:

```sh
pnpm test
```

Result: exit code 0. Existing GLB fixture tests emitted non-failing warnings for optional `KHR_texture_transform` and `KHR_materials_clearcoat` extensions.

## Implementation notes

- The manifest binds `input.revision` to `revisionOf(project.value)` and stores its exact 64-hex suffix in `input.sha256`.
- Browser evidence and session artifacts join one-to-one by exact artifact id; duplicates, omissions, metadata mismatches, extra uploads, unsafe filenames, unsafe paths, and sanitized-path collisions are rejected.
- Stored PNG hashes are preserved as supplied (both the established bare 64-hex session format and the documented `sha256:` form); hashes are never derived from browser URLs.
- Every declared project area must have face-on and oblique color evidence, and artifact dimensions/channel/area metadata must match its capture request.
- Camera config parsing accepts only the exact `{ version: 1, views }` shape, returns `views`, caps custom views at 32, and reports malformed input with `INVALID_USAGE`.

## Concerns

- The manifest module is intentionally pure and has no publication side effects. Atomic directory writing and browser-to-session artifact retrieval remain Task 6 responsibilities.

## Fix round 1/5

### RED

Command:

```sh
pnpm vitest run tests/qcOutput.test.ts
```

Result before the fix: 12 of 28 tests failed, covering mutable project summaries, disconnected area artifact ids, area target/framing drift, encoded/Windows/Unicode paths, case-fold collisions, nested byte content in validation issues, and unsupported input kinds.

### GREEN

Commands:

```sh
pnpm vitest run tests/qcOutput.test.ts tests/projectControl.test.ts
pnpm exec tsc -b --pretty false
git diff --check -- scripts/lib/qc-output.mjs tests/qcOutput.test.ts
```

Results:

- 50 focused tests passed (28 QC-output and 22 project-control).
- TypeScript build completed with exit code 0.
- The diff check produced no output.

### Fixes

- The builder now derives kind, area summary, and revision only from a fresh `inspectProject(project.value)` result and rejects inconsistent supplied summaries.
- Manifest validation now requires exact bidirectional area/artifact membership, rejects dangling artifact area ids, and enforces area target plus `fit-area` framing.
- Publication paths reject encoded text, Windows absolute paths, non-NFKC segments, and normalized case-fold collisions.
- Validation snapshots now accept only the `DesignValidationReport` and `DesignValidationIssue` contract, rejecting raw bytes and unsupported issue fields.
- Manifest input kinds are restricted to Label Spec v2 and Label Project v3.
