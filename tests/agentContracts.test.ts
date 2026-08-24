import { describe, expect, it } from 'vitest'
import { agentFailure, agentSuccess, exitCodeForError } from '../src/agent/contracts'

describe('Agent protocol contracts', () => {
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
