# Executable approval gates

Use the installed local CLI. These commands do not require a hosted service, MCP, or browser:

```bash
label-cli gate design design-gate-request.json --json
label-cli gate production production-gate-request.json --json
```

Every named path is relative to `evidenceRoot`; `evidenceRoot` itself is relative to the request file and must remain below its directory. Symlinks, non-regular files, traversal, unstable reads, and over-budget inputs fail closed.

Design request:

```json
{
  "version": 1,
  "gate": "design",
  "evidenceRoot": "evidence",
  "currentDocument": "working.json",
  "handoff": "editor-handoff.json",
  "blueprint": "layout-blueprint.json",
  "designReviewManifest": "design-review/design-review-manifest.json",
  "designReviewEvidenceRoot": "design-review"
}
```

Add `"designApprovalRecord": "design-approval.json"` only when a separate current ApprovalRecord v1 is required. `currentDocument` may be the exact Label Spec v2 reviewed by the browser or an exact Label Project v3; do not relabel one kind as the other.

Production request:

```json
{
  "version": 1,
  "gate": "production",
  "evidenceRoot": "evidence",
  "currentDocument": "working.json",
  "handoff": "editor-handoff.json",
  "blueprint": "layout-blueprint.json",
  "designReviewManifest": "design-review/design-review-manifest.json",
  "designReviewEvidenceRoot": "design-review",
  "productionReviewManifest": "production-review/review-manifest.json",
  "productionReviewEvidenceRoot": "production-review",
  "productionApprovalRecord": "production-approval.json",
  "model": "package.glb"
}
```

The production review directory also contains `resolved-project.lbl.json`. `review-manifest.json` separately binds its exact revision, SHA-256, and canonical area-target digest; the production gate reads that exact Project v3 and checks it against the original reviewed Spec v2 or Project v3 instead of relabeling the input kind.

Each evidence root must contain exactly its manifest, the bound resolved Project when applicable, and the artifact paths declared by that manifest. The command freshly verifies manifest bytes, the exact portable file set, regular-file/no-symlink status, per-file and aggregate budgets, SHA-256, MIME, and dimensions. Run production gate once after production approval before QC, again after any recapture or repair, and immediately before apply/export. Never continue after a nonzero exit or `ok: false` envelope.
