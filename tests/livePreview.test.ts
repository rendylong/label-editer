import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Pure Node ESM controller is consumed directly by the CLI.
import { startLivePreview } from '../scripts/lib/live-preview.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { revisionOf } from '../scripts/lib/project-control.mjs'
// @ts-expect-error Pure Node ESM URL builder is consumed directly by the runtime.
import { editorSessionUrl } from '../scripts/lib/browser-session.mjs'
// @ts-expect-error Pure Node ESM operations are consumed directly by the CLI.
import { createOperations } from '../scripts/lib/operations.mjs'

const temporaryDirectories: string[] = []

async function setup(): Promise<{ directory: string; specPath: string; spec: Record<string, any> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glb-label-live-'))
  temporaryDirectories.push(directory)
  const spec = JSON.parse(await readFile(path.resolve(import.meta.dirname, 'fixtures/specs/perfume-front-back-v2.json'), 'utf8'))
  const specPath = path.join(directory, 'working-spec.json')
  await writeFile(specPath, JSON.stringify(spec))
  return { directory, specPath, spec }
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.next`
  await writeFile(temporary, typeof value === 'string' ? value : JSON.stringify(value))
  await rename(temporary, filePath)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('live preview controller', () => {
  it('preserves the tokenized Agent bridge URL while adding preview mode', () => {
    const url = new URL(editorSessionUrl('http://127.0.0.1:4123', { id: 's 1', token: 'secret+token' }, { 'agent-preview': '1' }))
    expect(url.pathname).toBe('/editor/')
    expect(url.searchParams.get('agent')).toBe('1')
    expect(url.searchParams.get('session')).toBe('s 1')
    expect(url.searchParams.get('token')).toBe('secret+token')
    expect(url.searchParams.get('agent-preview')).toBe('1')
  })
  it('validates before launch and requests one headful read-only preview', async () => {
    const { specPath, spec } = await setup()
    const applySpec = vi.fn(async () => undefined)
    const setStatus = vi.fn(async () => undefined)
    const closeAdapter = vi.fn(async () => undefined)
    const launch = vi.fn(async () => ({
      sessionId: 'session-1',
      previewUrl: 'http://127.0.0.1:1234/editor/?agent-preview=1',
      applySpec,
      setStatus,
      close: closeAdapter,
    }))

    const controller = await startLivePreview({ specPath, glbPath: '/model.glb', launch, debounceMs: 10 })

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      headless: false,
      query: { 'agent-preview': '1' },
      glbPath: '/model.glb',
      initialSpec: spec,
    }))
    expect(applySpec).toHaveBeenCalledTimes(1)
    expect(applySpec).toHaveBeenCalledWith(spec)
    expect(setStatus).toHaveBeenLastCalledWith({ revision: revisionOf(spec), state: 'ready' })
    expect(controller).toMatchObject({
      sessionId: 'session-1',
      revision: revisionOf(spec),
      keepAlive: true,
    })

    await controller.close()
    expect(closeAdapter).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid initial spec without launching a browser', async () => {
    const { specPath } = await setup()
    await writeFile(specPath, JSON.stringify({ version: 2, areas: [] }))
    const launch = vi.fn()

    await expect(startLivePreview({ specPath, glbPath: '/model.glb', launch })).rejects.toMatchObject({ code: 'INVALID_LABEL_SPEC' })
    expect(launch).not.toHaveBeenCalled()
  })

  it('applies each valid new revision once and ignores an unchanged atomic write', async () => {
    const { specPath, spec } = await setup()
    const applySpec = vi.fn(async () => undefined)
    const setStatus = vi.fn(async () => undefined)
    const onEvent = vi.fn()
    const controller = await startLivePreview({
      specPath,
      glbPath: '/model.glb',
      debounceMs: 15,
      onEvent,
      launch: async () => ({
        sessionId: 'session-2', previewUrl: 'http://127.0.0.1/', applySpec, setStatus,
        close: async () => undefined,
      }),
    })

    await atomicWrite(specPath, spec)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(applySpec).toHaveBeenCalledTimes(1)

    const changed = structuredClone(spec)
    changed.areas[0].layers[0].text = 'LIVE REVISION'
    await atomicWrite(specPath, changed)
    await vi.waitFor(() => expect(applySpec).toHaveBeenCalledTimes(2), { timeout: 1_000 })
    expect(setStatus).toHaveBeenLastCalledWith({ revision: revisionOf(changed), state: 'ready' })
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'revision', revision: revisionOf(changed) }))

    await controller.close()
  })

  it('keeps the last good preview on invalid input and recovers on a later valid revision', async () => {
    const { specPath, spec } = await setup()
    const applySpec = vi.fn(async () => undefined)
    const setStatus = vi.fn(async () => undefined)
    const controller = await startLivePreview({
      specPath,
      glbPath: '/model.glb',
      debounceMs: 15,
      launch: async () => ({
        sessionId: 'session-3', previewUrl: 'http://127.0.0.1/', applySpec, setStatus,
        close: async () => undefined,
      }),
    })

    await atomicWrite(specPath, '{')
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({
      revision: revisionOf(spec), state: 'error', message: expect.any(String),
    })), { timeout: 1_000 })
    expect(applySpec).toHaveBeenCalledTimes(1)

    const recovered = structuredClone(spec)
    recovered.areas[1].layers[0].text = 'RECOVERED'
    await atomicWrite(specPath, recovered)
    await vi.waitFor(() => expect(applySpec).toHaveBeenCalledTimes(2), { timeout: 1_000 })
    expect(setStatus).toHaveBeenLastCalledWith({ revision: revisionOf(recovered), state: 'ready' })

    await controller.close()
  })

  it('clears a recoverable error when the exact last-good revision is restored', async () => {
    const { specPath, spec } = await setup()
    const applySpec = vi.fn(async () => undefined)
    const setStatus = vi.fn(async () => undefined)
    const onEvent = vi.fn()
    const controller = await startLivePreview({
      specPath,
      glbPath: '/model.glb',
      debounceMs: 15,
      onEvent,
      launch: async () => ({
        sessionId: 'session-recover-same', previewUrl: 'http://127.0.0.1/', applySpec, setStatus,
        close: async () => undefined,
      }),
    })

    await atomicWrite(specPath, '{')
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' })), { timeout: 1_000 })
    await atomicWrite(specPath, spec)
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith({ revision: revisionOf(spec), state: 'ready' }), { timeout: 1_000 })

    expect(applySpec).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'revision', revision: revisionOf(spec), recovered: true }))
    await controller.close()
  })

  it('fails immediately when the preview page or browser becomes unavailable', async () => {
    const { specPath } = await setup()
    const closeAdapter = vi.fn(async () => undefined)
    const onFatal = vi.fn()
    let unavailable: ((error: Error) => void) | undefined
    const controller = await startLivePreview({
      specPath,
      glbPath: '/model.glb',
      debounceMs: 15,
      onFatal,
      launch: async () => ({
        sessionId: 'session-loss', previewUrl: 'http://127.0.0.1/',
        applySpec: async () => undefined,
        setStatus: async () => undefined,
        onUnavailable: (listener: (error: Error) => void) => {
          unavailable = listener
          return () => { unavailable = undefined }
        },
        close: closeAdapter,
      }),
    })

    const loss = Object.assign(new Error('page closed'), { code: 'BROWSER_NOT_READY' })
    unavailable?.(loss)
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(loss), { timeout: 1_000 })
    expect(closeAdapter).toHaveBeenCalledTimes(1)
    await controller.close()
  })

  it('keeps live open when a revised asset is missing and recovers on the next valid spec', async () => {
    const { directory, specPath, spec } = await setup()
    const glbPath = path.join(directory, 'model.glb')
    await writeFile(glbPath, new Uint8Array())
    const progress: string[] = []
    const bridgeCalls: string[] = []
    const cleanups: Array<() => Promise<void>> = []
    const disposed: string[] = []
    const runtime = {
      allowedRoots: [directory],
      createSession: async () => ({ id: 'asset-session', inputUrl: '/model.glb', modelName: 'model.glb' }),
      callBridge: async (_session: unknown, method: string) => {
        bridgeCalls.push(method)
        return { ok: true, operation: method, data: method === 'applySpec' ? { areaIds: ['front', 'back'] } : {} }
      },
      openEditor: async () => 'http://127.0.0.1/editor/?agent-preview=1',
      addAsset: () => '/asset',
      addCleanup: (cleanup: () => Promise<void>) => { cleanups.push(cleanup) },
      onSessionUnavailable: () => () => undefined,
      disposeSession: async (id: string) => { disposed.push(id) },
    }
    const result = await createOperations(runtime, { progress: (message: string) => progress.push(message) }).live({ specPath, glbPath })
    expect(result.ok).toBe(true)

    const missingAsset = structuredClone(spec)
    missingAsset.areas[0].name = 'Missing asset revision'
    missingAsset.assets = { logo: { path: 'does-not-exist.png', mimeType: 'image/png' } }
    await atomicWrite(specPath, missingAsset)
    await vi.waitFor(() => expect(progress.some((message) => message.includes('live error: Label Spec asset logo is unavailable'))).toBe(true), { timeout: 1_000 })
    expect(disposed).toEqual([])

    const recovered = structuredClone(spec)
    recovered.areas[0].name = 'Recovered after asset error'
    await atomicWrite(specPath, recovered)
    await vi.waitFor(() => expect(progress).toContain(`live revision ${revisionOf(recovered)}`), { timeout: 1_000 })
    expect(bridgeCalls.filter((method) => method === 'applySpec')).toHaveLength(2)

    await cleanups[0]()
    expect(disposed).toEqual(['asset-session'])
  })

  it('treats a later bridge apply failure as fatal and disposes the session', async () => {
    const { specPath, spec } = await setup()
    const closeAdapter = vi.fn(async () => undefined)
    const onFatal = vi.fn()
    let calls = 0
    const controller = await startLivePreview({
      specPath,
      glbPath: '/model.glb',
      debounceMs: 15,
      onFatal,
      launch: async () => ({
        sessionId: 'session-4',
        previewUrl: 'http://127.0.0.1/',
        applySpec: async () => {
          calls += 1
          if (calls > 1) throw new Error('page closed')
        },
        setStatus: async () => undefined,
        close: closeAdapter,
      }),
    })
    const changed = structuredClone(spec)
    changed.areas[0].name = 'Trigger failure'
    await atomicWrite(specPath, changed)

    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'BROWSER_NOT_READY' })), { timeout: 1_000 })
    expect(closeAdapter).toHaveBeenCalledTimes(1)
    await controller.close()
    expect(closeAdapter).toHaveBeenCalledTimes(1)
  })
})
