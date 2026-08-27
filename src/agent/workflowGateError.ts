export type WorkflowGateErrorCode =
  | 'AWAITING_USER_APPROVAL'
  | 'APPROVAL_REQUIRED'
  | 'HANDOFF_BLOCKED'
  | 'DIGEST_MISMATCH'
  | 'STALE_APPROVAL'
  | 'UNREPRESENTABLE_LAYER'

function boundedWorkflowDetail(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.slice(0, 256)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (depth >= 4) return '[bounded]'
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => boundedWorkflowDetail(entry, depth + 1))
  if (!value || typeof value !== 'object') return '[unsupported]'
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32).map(([key, nested]) => [
    key.slice(0, 64), boundedWorkflowDetail(nested, depth + 1),
  ]))
}

function boundedWorkflowDetails(details: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return boundedWorkflowDetail(details) as Readonly<Record<string, unknown>>
}

export class WorkflowGateError extends Error {
  readonly code: WorkflowGateErrorCode
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: WorkflowGateErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'WorkflowGateError'
    this.code = code
    this.details = details ? boundedWorkflowDetails(details) : undefined
  }
}
