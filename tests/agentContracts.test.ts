import { describe, expect, it } from 'vitest'
import { agentFailure, agentSuccess, exitCodeForError } from '../src/agent/contracts'
import type { ReviewEvidenceRequest, ReviewEvidenceResult } from '../src/agent/contracts'

describe('Agent protocol contracts', () => {
  it('keeps review gate requests and results structured-clone-safe', () => {
    const request: ReviewEvidenceRequest = {
      width: 1600,
      height: 1600,
      designGate: {
        handoff: { handoff_version: 2, status: 'approved' },
        blueprintJson: '{"version":1}',
        designReviewManifestJson: '{"version":1}',
        approvalRecord: { version: 1, gate: 'design' },
      },
    }
    const result: ReviewEvidenceResult = {
      inputKind: 'label-project-v3', inputRevision: `sha256:${'1'.repeat(64)}`, inputSha256: '2'.repeat(64),
      blueprintRevision: 'design-v1', blueprintSha256: '3'.repeat(64),
      designReviewManifestSha256: '4'.repeat(64), modelFingerprint: '5'.repeat(64),
      areaTargetsSha256: '6'.repeat(64), views: [],
      confirmation: {
        sessionId: 's1', batchId: 'review-1', leaseToken: 'l'.repeat(32), generation: 1,
        expiresAt: 1_800_000_000_000, artifacts: [],
      },
      validation: { ready: true, issues: [] }, fidelity: { pass: true, issues: [] },
    }

    expect(structuredClone(request)).toEqual(request)
    expect(structuredClone(result)).toEqual(result)
  })

  it('returns one stable success envelope', () => {
    expect(agentSuccess('inspect_model', { meshes: 2 })).toEqual({
      ok: true,
      operation: 'inspect_model',
      data: { meshes: 2 },
      warnings: [],
    })
  })

  it.each([
    ['INVALID_USAGE', 2],
    ['PATH_NOT_ALLOWED', 3],
    ['INVALID_LABEL_SPEC', 4],
    ['AMBIGUOUS_MODEL_TARGET', 5],
    ['MODEL_TARGET_NOT_FOUND', 5],
    ['BROWSER_NOT_READY', 6],
    ['REBUILD_FAILED', 7],
    ['UNSUPPORTED_CODEC', 8],
    ['OUTPUT_CONFLICT', 9],
    ['INTERNAL_ERROR', 1],
  ] as const)('maps %s to exit code %i', (code, exitCode) => {
    const failure = agentFailure('apply_label_spec', code, 'failure')
    expect(failure).toEqual({
      ok: false,
      operation: 'apply_label_spec',
      error: { code, message: 'failure' },
      warnings: [],
    })
    expect(exitCodeForError(failure.error)).toBe(exitCode)
  })
})
