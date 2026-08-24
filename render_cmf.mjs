import { chromium } from 'playwright'

const url = 'http://127.0.0.1:12400/?file=' + encodeURIComponent('/Users/apple/dsh/02_perfume_glass_with_cap.glb')
const out = process.argv[2] || '/tmp/cmf_render.png'
const waitMs = Number(process.argv[3] || 6000)

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
  ],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text()) })
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto(url, { waitUntil: 'load' })
// Give the loader + first render time; also wait for three.js canvas.
await page.waitForTimeout(waitMs)
// Check WebGL actually initialized
const info = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  if (!c) return { canvas: false }
  const gl = c.getContext('webgl2') || c.getContext('webgl')
  return { canvas: true, w: c.width, h: c.height, gl: !!gl }
})
console.log('[render info]', JSON.stringify(info))
await page.screenshot({ path: out, fullPage: false })
console.log('saved', out)
await browser.close()
