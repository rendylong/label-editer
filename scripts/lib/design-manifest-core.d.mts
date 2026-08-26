export function isStrictRfc3339DateTime(value: string): boolean
export function validateManifestSemantics(
  value: {
    areas: Array<{ id: string; carrier: string }>
    artifacts: Array<{ id: string; path: string; viewKind: string; areaId?: string; carrier?: string }>
  },
  kind: 'design' | 'production',
): void
