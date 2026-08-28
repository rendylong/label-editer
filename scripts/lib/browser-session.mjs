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
}) {
  let browser
  const pages = new Map()
  const unavailableListeners = new Map()

  function unavailableError(message) {
    const error = new Error(message)
    error.code = 'BROWSER_NOT_READY'
    return error
  }

  function notifyUnavailable(sessionId, error) {
    for (const listener of unavailableListeners.get(sessionId) ?? []) listener(error)
  }

  async function ensureBrowser() {
    if (browser) return browser
    try {
      browser = await chromium.launch({ headless, ...launchOptions })
      browser.on('disconnected', () => {
        for (const [sessionId, record] of pages) {
          if (record.closing || record.unavailable) continue
          record.unavailable = unavailableError('Playwright Chromium disconnected unexpectedly')
          notifyUnavailable(sessionId, record.unavailable)
        }
      })
      return browser
    } catch (cause) {
      const error = new Error(`Playwright Chromium could not start: ${cause instanceof Error ? cause.message : String(cause)}`)
      error.code = 'BROWSER_NOT_READY'
      error.suggestion = 'Run: pnpm exec playwright install chromium'
      throw error
    }
  }

  async function open(session) {
    const existing = pages.get(session.id)
    if (existing) return existing
    if (beforeOpen) await beforeOpen()
    const target = await ensureBrowser()
    const context = await target.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
    const url = editorSessionUrl(server.origin, session, pageQuery)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => Boolean(window.__GLB_LABEL_EDITOR_AGENT_V1__), undefined, { timeout: 60_000 })
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
      const record = pages.get(sessionId)
      if (!record) return
      record.closing = true
      pages.delete(sessionId)
      unavailableListeners.delete(sessionId)
      await record.context.close()
    },
    async close() {
      const records = [...pages.values()]
      for (const record of records) record.closing = true
      pages.clear()
      unavailableListeners.clear()
      await Promise.all(records.map((record) => record.context.close()))
      if (browser) await browser.close()
      browser = undefined
    },
  }
}
