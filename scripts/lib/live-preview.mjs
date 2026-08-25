import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectProject } from './project-control.mjs'

function browserFailure(error) {
  const failure = new Error(`Live preview browser is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  failure.code = 'BROWSER_NOT_READY'
  failure.cause = error
  return failure
}

async function readSpec(specPath) {
  let value
  try {
    value = JSON.parse(await readFile(specPath, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      error.code = 'INVALID_LABEL_SPEC'
      error.message = `Invalid JSON in ${specPath}: ${error.message}`
    }
    throw error
  }
  const inspection = inspectProject(value)
  if (inspection.kind !== 'label-spec-v2') {
    const error = new Error('Live preview requires a Label Spec v2 working file')
    error.code = 'INVALID_LABEL_SPEC'
    throw error
  }
  return { value: inspection.value, revision: inspection.revision }
}

function isRecoverableApplyError(error) {
  return [
    'INVALID_LABEL_SPEC',
    'AMBIGUOUS_MODEL_TARGET',
    'MODEL_TARGET_NOT_FOUND',
  ].includes(error?.code) || error?.liveRecoverable === true
}

export async function startLivePreview({
  specPath,
  glbPath,
  launch,
  debounceMs = 80,
  onEvent = () => undefined,
  onFatal = () => undefined,
}) {
  if (typeof launch !== 'function') {
    const error = new Error('A live preview launcher is required')
    error.code = 'INVALID_USAGE'
    throw error
  }

  const resolvedSpecPath = path.resolve(specPath)
  const initial = await readSpec(resolvedSpecPath)
  let adapter
  try {
    adapter = await launch({
      headless: false,
      query: { 'agent-preview': '1' },
      glbPath,
      specPath: resolvedSpecPath,
      initialSpec: initial.value,
      initialRevision: initial.revision,
    })
    await adapter.applySpec(initial.value)
    await adapter.setStatus({ revision: initial.revision, state: 'ready' })
  } catch (error) {
    await adapter?.close?.().catch(() => undefined)
    if (error?.code) throw error
    throw browserFailure(error)
  }

  let appliedRevision = initial.revision
  let recoverableError = false
  let closed = false
  let fatal = false
  let adapterClosed = false
  let unsubscribeUnavailable
  let timer
  let queue = Promise.resolve()

  const closeAdapter = async () => {
    if (adapterClosed) return
    adapterClosed = true
    unsubscribeUnavailable?.()
    unsubscribeUnavailable = undefined
    await adapter.close?.()
  }

  const close = async () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    watcher.close()
    await queue.catch(() => undefined)
    await closeAdapter()
  }

  const failFatally = async (error) => {
    if (fatal || closed) return
    fatal = true
    const failure = error?.code === 'BROWSER_NOT_READY' ? error : browserFailure(error)
    onEvent({ type: 'fatal', error: failure.message, revision: appliedRevision })
    closed = true
    if (timer) clearTimeout(timer)
    watcher.close()
    await closeAdapter().catch(() => undefined)
    await onFatal(failure)
  }

  const reportRecoverable = async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await adapter.setStatus({ revision: appliedRevision, state: 'error', message })
      recoverableError = true
      onEvent({ type: 'error', error: message, revision: appliedRevision })
    } catch (statusError) {
      await failFatally(statusError)
    }
  }

  const applyLatest = async () => {
    if (closed || fatal) return
    let next
    try {
      next = await readSpec(resolvedSpecPath)
    } catch (error) {
      await reportRecoverable(error)
      return
    }
    if (next.revision === appliedRevision) {
      if (!recoverableError) return
      try {
        await adapter.setStatus({ revision: appliedRevision, state: 'ready' })
        recoverableError = false
        onEvent({ type: 'revision', revision: appliedRevision, recovered: true })
      } catch (error) {
        await failFatally(error)
      }
      return
    }
    try {
      await adapter.applySpec(next.value)
      appliedRevision = next.revision
      await adapter.setStatus({ revision: appliedRevision, state: 'ready' })
      recoverableError = false
      onEvent({ type: 'revision', revision: appliedRevision })
    } catch (error) {
      if (isRecoverableApplyError(error)) await reportRecoverable(error)
      else await failFatally(error)
    }
  }

  const watchedName = path.basename(resolvedSpecPath)
  const watcher = watch(path.dirname(resolvedSpecPath), { persistent: true }, (_eventType, fileName) => {
    if (closed || fatal || fileName === null || String(fileName) !== watchedName) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      queue = queue.then(applyLatest, applyLatest)
    }, debounceMs)
  })
  watcher.on('error', (error) => { void failFatally(error) })
  unsubscribeUnavailable = adapter.onUnavailable?.((error) => { void failFatally(error) })

  return {
    sessionId: adapter.sessionId,
    previewUrl: adapter.previewUrl,
    get revision() { return appliedRevision },
    keepAlive: true,
    close,
  }
}
