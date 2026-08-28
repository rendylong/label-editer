import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Pure Node ESM browser lifecycle is consumed directly by the runtime.
import { createBrowserSessionManager } from '../scripts/lib/browser-session.mjs'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function eventTarget() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  return {
    on(name: string, listener: (...args: any[]) => void) {
      const current = listeners.get(name) ?? []
      current.push(listener)
      listeners.set(name, current)
    },
    emit(name: string, ...args: any[]) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  }
}

function fakeBrowser() {
  const browserEvents = eventTarget()
  const contexts: any[] = []
  const browser = {
    ...browserEvents,
    newContext: vi.fn(async () => {
      const contextEvents = eventTarget()
      const pageEvents = eventTarget()
      const page = {
        ...pageEvents,
        goto: vi.fn(async () => undefined),
        waitForFunction: vi.fn(async () => undefined),
        evaluate: vi.fn(async () => undefined),
        close: vi.fn(async () => pageEvents.emit('close')),
      }
      const context = {
        ...contextEvents,
        page,
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => {
          await page.close()
          contextEvents.emit('close')
        }),
      }
      contexts.push(context)
      return context
    }),
    close: vi.fn(async () => browserEvents.emit('disconnected')),
  }
  return { browser, contexts }
}

const managers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()))
})

describe('browser session lifecycle', () => {
  it('shares one first launch and one in-flight open per session', async () => {
    const launch = deferred<any>()
    const fake = fakeBrowser()
    const launchBrowser = vi.fn(() => launch.promise)
    const manager = await createBrowserSessionManager({
      server: { origin: 'http://127.0.0.1:4123' },
      launchBrowser,
    })
    managers.push(manager)

    const sessionA = { id: 'a', token: 'token-a' }
    const firstA = manager.open(sessionA)
    const secondA = manager.open(sessionA)
    const sessionB = manager.open({ id: 'b', token: 'token-b' })
    await Promise.resolve()

    expect(launchBrowser).toHaveBeenCalledTimes(1)
    launch.resolve(fake.browser)
    await expect(Promise.all([firstA, secondA, sessionB])).resolves.toEqual([
      expect.stringContaining('session=a'),
      expect.stringContaining('session=a'),
      expect.stringContaining('session=b'),
    ])
    expect(fake.browser.newContext).toHaveBeenCalledTimes(2)

    await manager.close()
    expect(fake.contexts).toHaveLength(2)
    expect(fake.contexts.every((context) => context.close.mock.calls.length === 1)).toBe(true)
    expect(fake.browser.close).toHaveBeenCalledTimes(1)
  })

  it('waits out a first-launch race, closes the created browser, and permits retry after launch failure', async () => {
    const firstLaunch = deferred<any>()
    const abandoned = fakeBrowser()
    const retry = fakeBrowser()
    const launchBrowser = vi.fn()
      .mockImplementationOnce(() => firstLaunch.promise)
      .mockRejectedValueOnce(new Error('missing executable'))
      .mockResolvedValueOnce(retry.browser)

    const racingManager = await createBrowserSessionManager({
      server: { origin: 'http://127.0.0.1:4123' },
      launchBrowser,
    })
    const opening = racingManager.open({ id: 'closing', token: 'token' })
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledTimes(1))
    const closing = racingManager.close()
    firstLaunch.resolve(abandoned.browser)
    await expect(opening).rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    await expect(closing).resolves.toBeUndefined()
    expect(abandoned.browser.close).toHaveBeenCalledTimes(1)

    const retryManager = await createBrowserSessionManager({
      server: { origin: 'http://127.0.0.1:4123' },
      launchBrowser,
    })
    managers.push(retryManager)
    await expect(retryManager.open({ id: 'first', token: 'token' }))
      .rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    await expect(retryManager.open({ id: 'second', token: 'token' }))
      .resolves.toContain('session=second')
    expect(launchBrowser).toHaveBeenCalledTimes(3)
  })

  it('settles real Chromium concurrent opens and close without leaving a usable session', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<script>globalThis.__GLB_LABEL_EDITOR_AGENT_V1__ = { ping: () => "pong" }</script>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Browser lifecycle server did not bind')
    const manager = await createBrowserSessionManager({ server: { origin: `http://127.0.0.1:${address.port}` } })
    let racingManager: Awaited<ReturnType<typeof createBrowserSessionManager>> | undefined
    try {
      const session = { id: 'real-a', token: 'token-a' }
      await expect(Promise.all([
        manager.open(session),
        manager.open(session),
        manager.open({ id: 'real-b', token: 'token-b' }),
      ])).resolves.toHaveLength(3)
      await Promise.all([manager.close(), manager.close()])
      await expect(manager.open({ id: 'after-close', token: 'token' }))
        .rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })

      const launchBrowser = vi.fn((options: Parameters<typeof chromium.launch>[0]) => chromium.launch(options))
      racingManager = await createBrowserSessionManager({
        server: { origin: `http://127.0.0.1:${address.port}` },
        launchBrowser,
      })
      const racingOpens = [
        racingManager.open({ id: 'race-a', token: 'token-a' }),
        racingManager.open({ id: 'race-b', token: 'token-b' }),
      ]
      await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledTimes(1))
      await expect(racingManager.close()).resolves.toBeUndefined()
      const settlements = await Promise.allSettled(racingOpens)
      expect(settlements.every(({ status }) => status === 'rejected')).toBe(true)
      await expect(racingManager.open({ id: 'race-after-close', token: 'token' }))
        .rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    } finally {
      if (racingManager) await racingManager.close()
      await manager.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }, 30_000)
})
