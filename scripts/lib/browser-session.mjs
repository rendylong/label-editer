import { chromium } from 'playwright'

export async function createBrowserSessionManager({ server, headless = true, launchOptions = {} }) {
  let browser
  const pages = new Map()

  async function ensureBrowser() {
    if (browser) return browser
    try {
      browser = await chromium.launch({ headless, ...launchOptions })
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
    const target = await ensureBrowser()
    const context = await target.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
    const url = `${server.origin}/editor/?agent=1&session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(session.token)}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => Boolean(window.__GLB_LABEL_EDITOR_AGENT_V1__), undefined, { timeout: 60_000 })
    const record = { context, page, url, errors }
    pages.set(session.id, record)
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
    async dispose(sessionId) {
      const record = pages.get(sessionId)
      if (!record) return
      pages.delete(sessionId)
      await record.context.close()
    },
    async close() {
      const records = [...pages.values()]
      pages.clear()
      await Promise.all(records.map((record) => record.context.close()))
      if (browser) await browser.close()
      browser = undefined
    },
  }
}
