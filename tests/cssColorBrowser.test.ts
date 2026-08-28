import { createServer as createHttpServer } from 'node:http'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { describe, expect, it } from 'vitest'

describe('browser-authoritative CSS transparency', () => {
  it('classifies the production color corpus exactly like Chromium pixels', async () => {
    const vite = await createViteServer({
      root: process.cwd(),
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true },
    })
    const server = createHttpServer((request, response) => {
      if (request.url === '/__css-color-test') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><title>CSS color test</title><script type="module">
          import { isTransparentCssColor } from '/src/label/cssColor.ts'
          globalThis.testCssTransparency = isTransparentCssColor
        </script>`)
        return
      }
      vite.middlewares(request, response, () => {
        response.writeHead(404)
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('CSS color test server did not bind')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${address.port}/__css-color-test`)
      await page.waitForFunction(() => typeof (globalThis as typeof globalThis & {
        testCssTransparency?: unknown
      }).testCssTransparency === 'function')
      const corpus = [
        'transparent',
        'rgb(10 20 30 / 0)',
        'hsl(120deg 40% 50% / 0)',
        'color(display-p3 1 0 0 / 0)',
        'lch(50% 20 30deg / 0)',
        'rgb(none none none / none)',
        'color(display-p3 1 0 0 / 0.01)',
        'rgb(garbage / 0)',
        'rgb(10 20 / 0)',
        'hsl(120deg nope 50% / 0)',
        'color(display-p3 1 0 / 0)',
      ]
      const results = await page.evaluate(async (values) => {
        const isTransparentCssColor = (globalThis as typeof globalThis & {
          testCssTransparency: (value: string) => boolean
        }).testCssTransparency
        const renderedTransparent = (value: string): boolean => {
          if (!CSS.supports('color', value)) return false
          const canvas = document.createElement('canvas')
          canvas.width = 1
          canvas.height = 1
          const context = canvas.getContext('2d', { willReadFrequently: true })!
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = value
          context.fillRect(0, 0, 1, 1)
          return context.getImageData(0, 0, 1, 1).data[3] === 0
        }
        return values.map((value) => ({
          value,
          actual: isTransparentCssColor(value),
          rendered: renderedTransparent(value),
        }))
      }, corpus)

      expect(results.map(({ actual }) => actual)).toEqual([
        true, true, true, true, true, true, false, false, false, false, false,
      ])
      expect(results.every(({ actual, rendered }) => actual === rendered)).toBe(true)
    } finally {
      await browser.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await vite.close()
    }
  }, 30_000)
})
