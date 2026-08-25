const errorExitCodes = new Map([
  ['INVALID_USAGE', 2],
  ['PATH_NOT_ALLOWED', 3],
  ['INVALID_LABEL_SPEC', 4],
  ['AMBIGUOUS_MODEL_TARGET', 5],
  ['MODEL_TARGET_NOT_FOUND', 5],
  ['BROWSER_NOT_READY', 6],
  ['REBUILD_FAILED', 7],
  ['UNSUPPORTED_CODEC', 8],
  ['OUTPUT_CONFLICT', 9],
  ['REVISION_CONFLICT', 10],
  ['INVALID_PATCH_OPERATION', 11],
])

export function success(operation, data, { sessionId, warnings = [] } = {}) {
  return { ok: true, operation, ...(sessionId ? { sessionId } : {}), data, warnings }
}

export function failure(operation, error, { sessionId, warnings = [] } = {}) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR'
  return {
    ok: false,
    operation,
    ...(sessionId ? { sessionId } : {}),
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(typeof error?.path === 'string' ? { path: error.path } : {}),
      ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
      ...(typeof error?.suggestion === 'string' ? { suggestion: error.suggestion } : {}),
    },
    warnings,
  }
}

export function exitCodeForEnvelope(envelope) {
  return envelope.ok ? 0 : errorExitCodes.get(envelope.error.code) ?? 1
}
