import { restoreImportedAreaRuntime } from '../app/projectImportRuntime'
import type { LabelAreaConfig } from '../label/types'
import type { MeshAccessors, RemapOutput } from '../glb/uvRemap'
import { useLabelStore } from '../state/stores'

export interface RestoredAreaRuntime {
  meshAccessors: MeshAccessors
  remapOutput: RemapOutput
  remap: LabelAreaConfig['remap']
}

export interface PreparedAreaTransaction {
  areas: LabelAreaConfig[]
  activeAreaId: string
  activeRuntime: RestoredAreaRuntime
}

export interface PreparedAreaTransactionInput {
  glbBytes: Uint8Array
  areas: LabelAreaConfig[]
  restoreRuntime?: (glbBytes: Uint8Array, area: LabelAreaConfig) => Promise<RestoredAreaRuntime>
  commit?: (transaction: PreparedAreaTransaction) => void
}

export async function prepareAreaTransaction(
  input: Omit<PreparedAreaTransactionInput, 'commit'>,
): Promise<PreparedAreaTransaction> {
  if (input.areas.length === 0) throw new Error('Label Spec 没有可提交的贴标区域')
  const restoreRuntime = input.restoreRuntime ?? restoreImportedAreaRuntime
  const restoredAreas: LabelAreaConfig[] = []
  let activeRuntime: RestoredAreaRuntime | undefined
  for (const area of input.areas) {
    const runtime = await restoreRuntime(input.glbBytes, area)
    restoredAreas.push({ ...area, remap: runtime.remap, undoStack: [], redoStack: [] })
    activeRuntime = runtime
  }
  const activeArea = restoredAreas[restoredAreas.length - 1]
  if (!activeRuntime || !activeArea) throw new Error('Label Spec 运行时恢复失败')
  return { areas: restoredAreas, activeAreaId: activeArea.id, activeRuntime }
}

export function commitAreaTransaction(transaction: PreparedAreaTransaction): void {
  useLabelStore.getState().replaceAreasAtomically(
    transaction.areas,
    transaction.activeAreaId,
    transaction.activeRuntime,
  )
}

export async function applyPreparedAreaTransaction(input: PreparedAreaTransactionInput): Promise<PreparedAreaTransaction> {
  const transaction = await prepareAreaTransaction(input)
  ;(input.commit ?? commitAreaTransaction)(transaction)
  return transaction
}
