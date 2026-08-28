import { chromium } from 'playwright'

export function editorSessionUrl(serverOrigin, session, pageQuery = {}) {
  const url = new URL('/editor/', serverOrigin)
  url.searchParams.set('agent', '1')
  url.searchParams.set('session', session.id)
  url.searchParams.set('token', session.token)
  for (const [key, value] of Object.entries(pageQuery)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export async function createBrowserSessionManager({
  server,
  headless = true,
  launchOptions = {},
  pageQuery = {},
  beforeOpen,
  launchBrowser = (options) => chromium.launch(options),
}) {
  let browser
  let launchPromise
  let closePromise
  let closing = false
  const pages = new Map()
  const openings = new Map()
  const contexts = new Set()
  const browsers = new Set()
  const disposedSessions = new Set()
  const unavailableListeners = new Map()

  function unavailableError(message) {
    const error = new Error(message)
    error.code = 'BROWSER_NOT_READY'
    return error
  }

  function notifyUnavailable(sessionId, error) {
    for (const listener of unavailableListeners.get(sessionId) ?? []) listener(error)
  }

  function assertAvailable(sessionId) {
    if (closing) throw unavailableError('Playwright Chromium manager is closed')
    if (disposedSessions.has(sessionId)) throw unavailableError('Live preview session is disposed')
  }

  async function closeContext(context) {
    contexts.delete(context)
    try {
      await context.close()
    } catch {
      // A browser disconnect can close a context before lifecycle cleanup reaches it.
    }
  }

  async function closeBrowser(target) {
    browsers.delete(target)
    if (browser === target) browser = undefined
    try {
      await target.close()
    } catch {
      // Closing an already-disconnected Playwright browser is an idempotent cleanup.
    }
  }

  async function ensureBrowser() {
    if (closing) throw unavailableError('Playwright Chromium manager is closed')
    if (browser) return browser
    if (!launchPromise) {
      const pending = (async () => {
        let launched
        try {
          launched = await launchBrowser({ headless, ...launchOptions })
          browsers.add(launched)
          launched.on('disconnected', () => {
            browsers.delete(launched)
            if (browser === launched) browser = undefined
            for (const [sessionId, record] of pages) {
              if (record.closing || record.unavailable) continue
              record.unavailable = unavailableError('Playwright Chromium disconnected unexpectedly')
              notifyUnavailable(sessionId, record.unavailable)
            }
          })
          if (closing) {
            await closeBrowser(launched)
            launched = undefined
            throw unavailableError('Playwright Chromium manager is closed')
          }
          browser = launched
          return launched
        } catch (cause) {
          if (launched) await closeBrowser(launched)
          if (cause?.code === 'BROWSER_NOT_READY') throw cause
          const error = new Error(`Playwright Chromium could not start: ${cause instanceof Error ? cause.message : String(cause)}`)
          error.code = 'BROWSER_NOT_READY'
          error.suggestion = 'Run: pnpm exec playwright install chromium'
          throw error
        }
      })()
      launchPromise = pending
      pending.finally(() => {
        if (launchPromise === pending) launchPromise = undefined
      }).catch(() => undefined)
    }
    return launchPromise
  }

  function open(session) {
    try {
      assertAvailable(session.id)
    } catch (error) {
      return Promise.reject(error)
    }
    const existing = pages.get(session.id)
    if (existing) return Promise.resolve(existing)
    const pending = openings.get(session.id)
    if (pending) return pending

    const operation = Promise.resolve().then(async () => {
      assertAvailable(session.id)
      if (beforeOpen) await beforeOpen()
      assertAvailable(session.id)
      const target = await ensureBrowser()
      assertAvailable(session.id)
      let context
      let page
      try {
        context = await target.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
        contexts.add(context)
        assertAvailable(session.id)
        page = await context.newPage()
        assertAvailable(session.id)
        const errors = []
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(`console: ${message.text()}`)
        })
        page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
        const url = editorSessionUrl(server.origin, session, pageQuery)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        assertAvailable(session.id)
        await page.waitForFunction(() => Boolean(window.__GLB_LABEL_EDITOR_AGENT_V1__), undefined, { timeout: 60_000 })
        assertAvailable(session.id)
        const record = { context, page, url, errors, closing: false, unavailable: undefined }
        pages.set(session.id, record)
        const reportClosure = (message) => {
          if (record.closing || record.unavailable) return
          record.unavailable = unavailableError(message)
          notifyUnavailable(session.id, record.unavailable)
        }
        page.on('close', () => reportClosure('Live preview page closed unexpectedly'))
        context.on('close', () => reportClosure('Live preview browser context closed unexpectedly'))
        return record
      } catch (error) {
        if (context) await closeContext(context)
        throw error
      }
    })
    openings.set(session.id, operation)
    operation.finally(() => {
      if (openings.get(session.id) === operation) openings.delete(session.id)
    }).catch(() => undefined)
    return operation
  }

  return {
    async call(session, method, input) {
      const record = await open(session)
      return record.page.evaluate(async ({ methodName, argument }) => {
        const bridge = window.__GLB_LABEL_EDITOR_AGENT_V1__
        if (!bridge) throw new Error('Agent Bridge is unavailable')
        const action = bridge[methodName]
        if (typeof action !== 'function') throw new Error(`Unknown Agent Bridge method: ${String(methodName)}`)
        return action.call(bridge, argument)
      }, { methodName: method, argument: input })
    },
    async open(session) {
      return (await open(session)).url
    },
    errors(sessionId) {
      return [...(pages.get(sessionId)?.errors ?? [])]
    },
    onUnavailable(sessionId, listener) {
      const listeners = unavailableListeners.get(sessionId) ?? new Set()
      listeners.add(listener)
      unavailableListeners.set(sessionId, listeners)
      const existing = pages.get(sessionId)?.unavailable
      if (existing) queueMicrotask(() => listeners.has(listener) && listener(existing))
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) unavailableListeners.delete(sessionId)
      }
    },
    async dispose(sessionId) {
      disposedSessions.add(sessionId)
      const pending = openings.get(sessionId)
      if (pending) await pending.catch(() => undefined)
      const record = pages.get(sessionId)
      pages.delete(sessionId)
      unavailableListeners.delete(sessionId)
      if (!record) return
      record.closing = true
      await closeContext(record.context)
    },
    async close() {
      if (closePromise) return closePromise
      closing = true
      closePromise = (async () => {
        const pending = [...openings.values()]
        if (launchPromise) pending.push(launchPromise)
        for (const operation of pending) await operation.catch(() => undefined)

        for (const record of pages.values()) record.closing = true
        pages.clear()
        unavailableListeners.clear()
        for (const context of [...contexts]) await closeContext(context)
        for (const target of [...browsers]) await closeBrowser(target)
        contexts.clear()
        browsers.clear()
        browser = undefined
      })()
      return closePromise
    },
  }
}
