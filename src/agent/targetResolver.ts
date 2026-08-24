import type { AgentErrorCode, MeshInspection } from './contracts'
import type { LabelSpecTargetV2 } from './labelSpecSchema'

export class ModelTargetResolutionError extends Error {
  readonly code: Extract<AgentErrorCode, 'AMBIGUOUS_MODEL_TARGET' | 'MODEL_TARGET_NOT_FOUND'>
  readonly candidates: string[]

  constructor(
    code: Extract<AgentErrorCode, 'AMBIGUOUS_MODEL_TARGET' | 'MODEL_TARGET_NOT_FOUND'>,
    message: string,
    candidates: string[],
  ) {
    super(message)
    this.name = 'ModelTargetResolutionError'
    this.code = code
    this.candidates = candidates
  }
}

type MeshTargetRecord = Pick<
  MeshInspection,
  'stableSelector' | 'meshIndex' | 'nodeIndex' | 'nodeName' | 'materialNames' | 'mappingMode' | 'labelCandidate' | 'warnings'
>

function matchesField(mesh: MeshTargetRecord, key: keyof LabelSpecTargetV2, value: string | number): boolean {
  if (key === 'stableSelector') return mesh.stableSelector === value
  if (key === 'meshIndex') return mesh.meshIndex === value
  if (key === 'nodeName') return mesh.nodeName === value
  return mesh.materialNames.includes(String(value))
}

export function resolveTarget<T extends MeshTargetRecord>(target: LabelSpecTargetV2, meshes: T[]): T {
  const fields = (['stableSelector', 'meshIndex', 'nodeName', 'materialName'] as const)
    .filter((key) => target[key] !== undefined)
  if (fields.length === 0) {
    throw new ModelTargetResolutionError('MODEL_TARGET_NOT_FOUND', 'Model target has no selector', [])
  }

  const primary = fields[0]
  const primaryValue = target[primary]!
  const matches = meshes.filter((mesh) => matchesField(mesh, primary, primaryValue))
  if (matches.length === 0) {
    throw new ModelTargetResolutionError(
      'MODEL_TARGET_NOT_FOUND',
      `No model mesh matches ${primary}=${String(primaryValue)}`,
      [],
    )
  }
  if (matches.length > 1) {
    throw new ModelTargetResolutionError(
      'AMBIGUOUS_MODEL_TARGET',
      `${primary}=${String(primaryValue)} is ambiguous`,
      matches.map((mesh) => mesh.stableSelector),
    )
  }

  const resolved = matches[0]
  const conflicting = fields.slice(1).find((key) => !matchesField(resolved, key, target[key]!))
  if (conflicting) {
    throw new ModelTargetResolutionError(
      'MODEL_TARGET_NOT_FOUND',
      `Conflicting model target selectors: ${primary} resolves to ${resolved.stableSelector}, but ${conflicting} does not match`,
      [resolved.stableSelector],
    )
  }
  return resolved
}

export function resolveAreaTargets<T extends MeshTargetRecord>(
  areas: Array<{ id: string; target: LabelSpecTargetV2 }>,
  meshes: T[],
): Map<string, T> {
  return new Map(areas.map((area) => [area.id, resolveTarget(area.target, meshes)]))
}
