import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveLayerRenderTransform } from '../src/label/craft'
import { traceValidatedSvgPath } from '../src/label/svgPath'
import { validateVectorPath } from '../src/label/vectorPathValidation'
// @ts-expect-error Pure Node ESM module is consumed directly by the internal renderer.
import { buildDesignReviewManifest, captureDesignReview, renderBlueprintHtml, renderDesignReview, resolveCaptureDimensions } from '../scripts/lib/design-review.mjs'
// @ts-expect-error Pure Node ESM runner is consumed directly by tests.
import { runDesignReviewCli } from '../scripts/render-design-review.mjs'

const temporaryDirectories: string[] = []
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex')

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngWithDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes.writeUInt32BE(pngCrc32(bytes.subarray(12, 29)), 29)
  return bytes
}

const JPEG_1X1 = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64')
const WEBP_1X1 = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=', 'base64')

function headerValidButUndecodableWoff2(): Buffer {
  const bytes = Buffer.alloc(49)
  bytes.write('wOF2', 0); bytes.writeUInt32BE(49, 8); bytes.writeUInt16BE(1, 12)
  bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20)
  return bytes
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'design-review-'))
  temporaryDirectories.push(directory)
  return directory
}

function blueprint(): any {
  return {
    version: 1, revision: 'rev-001', carrierDefaults: { carrier: 'direct_surface_print' },
    assets: [{ id: 'mark', path: 'assets/mark.png', sha256: PNG_SHA256, mimeType: 'image/png', width: 1, height: 1 }],
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      artboard: { widthMm: 40, heightMm: 60, background: 'transparent' }, placementIntent: 'Centered front.',
      layers: [{
        id: 'front-copy', kind: 'text', boundsMm: { x: 4, y: 6, width: 32, height: 8 },
        anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 1,
        processes: [{ process: 'screen_print', spotName: 'BRAND_BLACK', requiredMask: 'color' }],
        text: 'BRAND <script>globalThis.copyExecuted=true</script> & "exact"', language: 'en', writingDirection: 'ltr',
        fontStack: ['Arial', 'sans-serif'], fontSizeMm: 4, fontWeight: 600, letterSpacingEm: 0.05,
        lineHeight: 1.1, alignment: 'center', wrapPolicy: 'none', maxLines: 1, color: '#111111',
      }, {
        id: 'front-path', kind: 'shape', boundsMm: { x: 3, y: 3, width: 34, height: 54 },
        anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 0,
        processes: [{ process: 'hot_stamp_foil', spotName: 'COPPER', requiredMask: 'metalness' }],
        shape: 'path', pathData: 'M0 1 L0 0 L1 0 L1 1', pathViewBox: [0, 0, 1, 1],
        fillRule: 'evenodd', fill: 'transparent', stroke: '#a5663b', strokeWidthMm: 0.25,
      }, {
        id: 'front-image', kind: 'image', boundsMm: { x: 16, y: 20, width: 8, height: 8 },
        anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 2,
        processes: [], assetId: 'mark', fit: 'contain',
      }],
    }, {
      id: 'back', side: 'back', carrier: 'applied_label',
      artboard: { widthMm: 38, heightMm: 58, background: 'transparent' }, placementIntent: 'Centered back.',
      substrate: { kind: 'opaque', color: '#f5f0e6', opacity: 1, boundary: { shape: 'rounded_rectangle', radiusMm: 2 }, material: 'paper' },
      layers: [{
        id: 'back-copy', kind: 'text', boundsMm: { x: 3, y: 4, width: 32, height: 14 },
        anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 0,
        processes: [{ process: 'offset_print', requiredMask: 'color' }],
        text: 'PLACEHOLDER ingredients & usage', language: 'en', writingDirection: 'ltr',
        fontStack: ['Arial', 'sans-serif'], fontSizeMm: 2.5, fontWeight: 400, letterSpacingEm: 0,
        lineHeight: 1.2, alignment: 'left', wrapPolicy: 'word', maxLines: 4, color: '#222222',
      }],
    }],
  }
}

async function writeFixture(root: string, value = blueprint()): Promise<string> {
  await mkdir(path.join(root, 'assets'), { recursive: true })
  await writeFile(path.join(root, 'assets/mark.png'), PNG)
  const blueprintPath = path.join(root, 'layout-blueprint.json')
  await writeFile(blueprintPath, `${JSON.stringify(value, null, 2)}\n`)
  return blueprintPath
}

function fakeCapture(overrides: Record<string, unknown> = {}) {
  return vi.fn(async ({ width, height, areas, pxPerMm, capturePlan }: any) => ({
    front: { bytes: pngWithDimensions(width, height), width, height }, back: { bytes: pngWithDimensions(width, height), width, height },
    areas: Object.fromEntries(areas.filter((area: any) => area.carrier !== 'bare').map((area: any) => {
      const dimensions = capturePlan?.areas.get(area.id)
        ?? resolveCaptureDimensions(area.artboard.widthMm * pxPerMm, area.artboard.heightMm * pxPerMm)
      return [area.id, { bytes: pngWithDimensions(dimensions.width, dimensions.height), ...dimensions }]
    })),
    ...overrides,
  }))
}

async function inspectChromiumAreaStack(
  html: string,
  points: Array<{ name: string; x: number; y: number }>,
): Promise<Record<string, { pixel: number[]; stack: string[] }>> {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const area = page.locator('[data-area-id="front"]')
    const screenshot = await area.screenshot({ type: 'png', animations: 'disabled' })
    const pixels = await page.evaluate(async ({ png, samplePoints }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${png}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Canvas context is unavailable')
      context.drawImage(image, 0, 0)
      return Object.fromEntries(samplePoints.map(({ name, x, y }) => [
        name,
        [...context.getImageData(x, y, 1, 1).data],
      ]))
    }, { png: screenshot.toString('base64'), samplePoints: points })
    const stacks = await area.evaluate((element, samplePoints) => {
      const bounds = element.getBoundingClientRect()
      return Object.fromEntries(samplePoints.map(({ name, x, y }) => {
        const seen = new Set<Element>()
        const stack = document.elementsFromPoint(bounds.left + x, bounds.top + y).flatMap((candidate) => {
          const owner = candidate.closest('.art-layer,.carrier-panel,.carrier-film-extent,.carrier-boundary-path')
          if (!owner || seen.has(owner)) return []
          seen.add(owner)
          if (owner.classList.contains('art-layer')) return [`layer:${owner.getAttribute('data-layer-id')}`]
          if (owner.classList.contains('carrier-panel')) return ['carrier:opaque']
          if (owner.classList.contains('carrier-film-extent')) return ['carrier:film']
          return ['carrier:boundary']
        })
        return [name, stack]
      }))
    }, points)
    return Object.fromEntries(points.map(({ name }) => [name, { pixel: pixels[name], stack: stacks[name] }]))
  } finally {
    await browser.close()
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('blueprint-derived design review', () => {
  it('publishes immutable HTML, front/back PNGs, area evidence, and a contract-valid manifest', async () => {
    const root = await temporaryDirectory()
    const blueprintPath = await writeFixture(root)
    const outputDir = path.join(root, 'review')
    const rawBlueprint = await readFile(blueprintPath)
    const result = await renderDesignReview({ blueprintPath, outputDir, width: 640, height: 480, pxPerMm: 5, createdAt: '2026-08-27T00:00:00.000Z', capture: fakeCapture() })

    expect(result.artifacts.map((artifact: any) => artifact.path)).toEqual(expect.arrayContaining([
      'mockup.html', 'mockup-front.png', 'mockup-back.png', 'design-review-manifest.json', 'areas/front.png', 'areas/back.png',
    ]))
    expect(result.manifest.blueprint).toEqual({ revision: 'rev-001', sha256: createHash('sha256').update(rawBlueprint).digest('hex') })
    expect(result.manifest.artifacts.every((artifact: any) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
    expect(result.manifest.artifacts.find((artifact: any) => artifact.path === 'mockup-front.png')).toMatchObject({ width: 640, height: 480, mimeType: 'image/png', viewKind: 'mockup-front' })
    expect(await readdir(outputDir)).toEqual(expect.arrayContaining(['areas', 'design-review-manifest.json', 'mockup-back.png', 'mockup-front.png', 'mockup.html']))
  })

  it('escapes copy and attributes, inlines verified assets, and keeps vector paths inert and editable', async () => {
    const root = await temporaryDirectory()
    const blueprintPath = await writeFixture(root)
    const result = await renderDesignReview({ blueprintPath, outputDir: path.join(root, 'review'), width: 640, height: 480, pxPerMm: 5, capture: fakeCapture() })

    expect(result.html).toContain('BRAND &lt;script&gt;globalThis.copyExecuted=true&lt;/script&gt; &amp; &quot;exact&quot;')
    expect(result.html).not.toContain('<script>')
    expect(result.html).not.toMatch(/\son[a-z]+=/i)
    expect(result.html).toContain(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(result.html).not.toContain('assets/mark.png')
    expect(result.html).toContain('d="M -85 135 L -85 -135 L 85 -135 L 85 135"')
    expect(result.html).toContain('vector-effect="non-scaling-stroke"')
    expect(result.html).toContain('left:20px;top:30px;width:160px;height:40px')
  })

  it('renders equal-z I/i layers in code-unit order without consulting localeCompare', () => {
    const source = blueprint()
    const base = source.areas[0].layers[0]
    source.areas[0].layers = [
      { ...structuredClone(base), id: 'i', text: 'LOWERCASE', zIndex: 0 },
      { ...structuredClone(base), id: 'I', text: 'UPPERCASE', zIndex: 0 },
    ]
    const original = String.prototype.localeCompare
    let html = ''
    try {
      String.prototype.localeCompare = function (other: string): number {
        return String(this) < other ? 1 : String(this) > other ? -1 : 0
      }
      html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    } finally {
      String.prototype.localeCompare = original
    }

    expect(html.indexOf('data-layer-id="I"')).toBeLessThan(html.indexOf('data-layer-id="i"'))
  })

  it('keeps a negative-z artwork layer above an opaque carrier in real Chromium without leaking raw z CSS', async () => {
    const source = blueprint()
    const base = structuredClone(source.areas[0].layers[1])
    source.areas[0].carrier = 'applied_label'
    source.areas[0].substrate = { kind: 'opaque', color: '#ffffff', opacity: 1, boundary: { shape: 'rectangle' } }
    source.areas[0].layers = [{
      ...base, id: 'negative-red', zIndex: -32768, boundsMm: { x: 0, y: 0, width: 40, height: 60 },
      shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidthMm: 0, processes: [],
      pathData: undefined, pathViewBox: undefined, fillRule: undefined,
    }]

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    const layerTag = html.match(/<div class="art-layer" data-layer-id="negative-red"[^>]+>/)?.[0] ?? ''
    const result = await inspectChromiumAreaStack(html, [{ name: 'center', x: 100, y: 150 }])

    expect(html).not.toContain('<script')
    expect(result.center.pixel).toEqual([255, 0, 0, 255])
    expect(result.center.stack.slice(0, 2)).toEqual(['layer:negative-red', 'carrier:opaque'])
    expect(layerTag).not.toContain('z-index:')
  })

  it('matches canonical mixed negative/positive editor order above the carrier in real Chromium', async () => {
    const source = blueprint()
    const base = structuredClone(source.areas[0].layers[1])
    source.areas[0].carrier = 'applied_label'
    source.areas[0].substrate = { kind: 'opaque', color: '#ffffff', opacity: 1, boundary: { shape: 'rectangle' } }
    source.areas[0].layers = [{
      ...base, id: 'positive-blue', zIndex: 32767, boundsMm: { x: 20, y: 0, width: 20, height: 60 },
      shape: 'rectangle', fill: '#0000ff', stroke: 'transparent', strokeWidthMm: 0, processes: [],
      pathData: undefined, pathViewBox: undefined, fillRule: undefined,
    }, {
      ...base, id: 'negative-red', zIndex: -32768, boundsMm: { x: 0, y: 0, width: 40, height: 60 },
      shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidthMm: 0, processes: [],
      pathData: undefined, pathViewBox: undefined, fillRule: undefined,
    }]

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    const layerTags = [...html.matchAll(/<div class="art-layer"[^>]+>/g)].map((match) => match[0])
    const result = await inspectChromiumAreaStack(html, [
      { name: 'negativeOnly', x: 50, y: 150 },
      { name: 'overlap', x: 150, y: 150 },
    ])

    expect(html).not.toContain('<script')
    expect(result.negativeOnly).toEqual({ pixel: [255, 0, 0, 255], stack: ['layer:negative-red', 'carrier:opaque'] })
    expect(result.overlap).toEqual({
      pixel: [0, 0, 255, 255],
      stack: ['layer:positive-blue', 'layer:negative-red', 'carrier:opaque'],
    })
    expect(layerTags.every((tag) => !tag.includes('z-index:'))).toBe(true)
  })

  it.each([
    'Arial" onmouseover="globalThis.injected=true',
    'Arial; background:url(https://evil.example/font)',
    'Arial; color:red',
    'Arial</style><script>globalThis.injected=true</script>',
  ])('rejects an unsafe projected font family before emitting inline CSS: %s', (fontFamily) => {
    const source = blueprint()
    source.areas[0].layers[0].fontStack = [fontFamily]

    expect(() => renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() }))
      .toThrow(/fontStack|font family|unsafe/i)
  })

  it('quotes normal approved font families but leaves CSS generic fallbacks unquoted', () => {
    const source = blueprint()
    source.areas[0].layers[0].fontStack = ['Noto Sans CJK SC', 'system-ui', 'sans-serif']

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })

    expect(html).toContain('font-family:&quot;Noto Sans CJK SC&quot;,system-ui,sans-serif')
    expect(html).not.toContain('&#39;system-ui&#39;')
    expect(html).not.toContain('&#39;sans-serif&#39;')
  })

  it.each([
    ['top_left', 20, 30, '0px 0px', undefined],
    ['top_center', 20, 30, '80px 0px', undefined],
    ['center', 20, 30, '80px 20px', undefined],
    ['baseline_left', 20, 13, '0px 17px', 17],
    ['baseline_center', 20, 13, '80px 17px', 17],
  ] as const)('matches the editor transform for rotated %s anchors', (anchor, left, top, transformOrigin, baselineFromTop) => {
    const source = blueprint()
    source.areas[0].layers = [{ ...source.areas[0].layers[0], anchor, rotation: 30 }]

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    const layerMarkup = html.match(/<div class="art-layer"[^>]+>/)?.[0] ?? ''
    const anchorX = anchor === 'top_center' || anchor === 'baseline_center' || anchor === 'center' ? 100 : 20
    const anchorY = anchor === 'center' ? 50 : 30
    const editor = resolveLayerRenderTransform({
      x: anchorX, y: anchorY, rotation: 30, width: 160, height: 40, anchor,
      ...(baselineFromTop === undefined ? {} : { baselineFromTop }),
    })

    expect(editor.box).toMatchObject({ x: left - anchorX, y: top - anchorY, width: 160, height: 40 })
    expect(layerMarkup).toContain(`left:${left}px;top:${top}px;width:160px;height:40px`)
    expect(layerMarkup).toContain(`transform-origin:${transformOrigin}`)
    expect(layerMarkup).toContain('transform:rotate(30deg)')
    expect(layerMarkup).not.toContain('translate')
  })

  it.each([
    ['baseline_left', 1, -45],
    ['baseline_center', 1, 90],
    ['baseline_left', 8, 135],
    ['baseline_center', 8, -180],
  ] as const)('keeps %s on the compiler baseline across %s mm type and %s degree rotation', (anchor, fontSizeMm, rotation) => {
    const source = blueprint()
    source.areas[0].layers = [{ ...source.areas[0].layers[0], anchor, fontSizeMm, rotation }]
    const baselineFromTop = ((fontSizeMm * 5 * 1.1) - fontSizeMm * 5) / 2 + fontSizeMm * 5 * 0.8
    const anchorX = anchor === 'baseline_center' ? 100 : 20
    const editor = resolveLayerRenderTransform({ x: anchorX, y: 30, rotation, width: 160, height: 40, anchor, baselineFromTop })

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    const layerMarkup = html.match(/<div class="art-layer"[^>]+>/)?.[0] ?? ''
    const css = (value: number) => Number(value.toFixed(6)).toString()

    expect(layerMarkup).toContain(`left:${css(editor.origin.x + editor.box.x)}px;top:${css(editor.origin.y + editor.box.y)}px`)
    expect(layerMarkup).toContain(`transform-origin:${css(-editor.box.x)}px ${css(-editor.box.y)}px`)
    expect(layerMarkup).toContain(`transform:rotate(${rotation}deg)`)
  })

  it('persists browser-resolved Arial and exact-WOFF2 text boxes for single-line center and wrapped baseline rotation', async () => {
    const root = await temporaryDirectory()
    const source = blueprint()
    Object.assign(source.areas[0].layers[0], { anchor: 'center', rotation: 27, fontStack: ['Arial', 'sans-serif'] })
    const woff2 = await readFile(path.resolve('public/fonts/inter/400-normal.woff2'))
    source.assets.push({ id: 'exact-inter', path: 'assets/exact-inter.woff2', sha256: createHash('sha256').update(woff2).digest('hex'), mimeType: 'font/woff2' })
    Object.assign(source.areas[1].layers[0], {
      anchor: 'baseline_center', rotation: -33, boundsMm: { x: 11, y: 12, width: 16, height: 14 },
      text: 'wrapped exact font text across several approved lines', wrapPolicy: 'word', maxLines: 2,
      fontStack: undefined, fontAsset: 'exact-inter',
    })
    const blueprintPath = await writeFixture(root, source)
    await writeFile(path.join(root, 'assets/exact-inter.woff2'), woff2)

    const result = await renderDesignReview({ blueprintPath, outputDir: path.join(root, 'resolved-text'), width: 640, height: 480, pxPerMm: 5 })
    expect(result.html).not.toContain('<script')

    for (const expected of [
      { id: 'front-copy', anchor: 'center', anchorX: 100, anchorY: 50, rotation: 27, width: 160, lines: 1, lineHeight: 22 },
      { id: 'back-copy', anchor: 'baseline_center', anchorX: 95, anchorY: 60, rotation: -33, width: 80, lines: 2, lineHeight: 15 },
    ] as const) {
      const tag = result.html.match(new RegExp(`<div class="art-layer" data-layer-id="${expected.id}"[^>]+>`))?.[0] ?? ''
      const metric = (name: string) => Number(tag.match(new RegExp(`data-resolved-${name}="([^"]+)"`))?.[1])
      const styleNumber = (name: string) => Number(tag.match(new RegExp(`${name}:([-0-9.]+)px`))?.[1])
      const width = metric('text-width'); const height = metric('text-height'); const baselineFromTop = metric('baseline-from-top')
      const resolved = resolveLayerRenderTransform({
        x: expected.anchorX, y: expected.anchorY, rotation: expected.rotation, width, height,
        anchor: expected.anchor, baselineFromTop,
      })

      expect(width).toBeCloseTo(expected.width, 4)
      expect(height).toBeCloseTo(expected.lines * expected.lineHeight, 4)
      expect(metric('line-count')).toBe(expected.lines)
      expect(baselineFromTop).toBeGreaterThan(0)
      expect(styleNumber('left')).toBeCloseTo(resolved.origin.x + resolved.box.x, 4)
      expect(styleNumber('top')).toBeCloseTo(resolved.origin.y + resolved.box.y, 4)
      const origin = tag.match(/transform-origin:([-0-9.]+)px ([-0-9.]+)px/)
      expect(Number(origin?.[1])).toBeCloseTo(-resolved.box.x, 4)
      expect(Number(origin?.[2])).toBeCloseTo(-resolved.box.y, 4)
    }
  })

  it('preserves every hard newline through browser preflight and the final script-free HTML for every wrap policy', async () => {
    const root = await temporaryDirectory()
    const source = blueprint()
    const base = source.areas[0].layers[0]
    source.areas[0].layers = [
      { ...base, id: 'none-hard-break', text: 'A\nB', wrapPolicy: 'none', maxLines: 4, anchor: 'baseline_center', rotation: 31 },
      { ...base, id: 'none-blank-trailing', text: 'A\n\nB\n', wrapPolicy: 'none', maxLines: 3, anchor: 'center', rotation: -17 },
      { ...base, id: 'word-hard-break', text: 'LEFT\nRIGHT', wrapPolicy: 'word', maxLines: 4 },
      { ...base, id: 'character-hard-break', text: 'ABC\nمرحبا', writingDirection: 'auto', wrapPolicy: 'character', maxLines: 4 },
    ]
    const blueprintPath = await writeFixture(root, source)

    const result = await renderDesignReview({ blueprintPath, outputDir: path.join(root, 'hard-breaks'), width: 640, height: 480, pxPerMm: 5 })

    expect(result.html).not.toContain('<script')
    expect(result.html).toContain('white-space:pre;overflow-wrap:normal')
    expect(result.html).not.toContain('white-space:nowrap')
    for (const [id, lineCount] of [
      ['none-hard-break', 2], ['none-blank-trailing', 3], ['word-hard-break', 2], ['character-hard-break', 2],
    ] as const) {
      const tag = result.html.match(new RegExp(`<div class="art-layer" data-layer-id="${id}"[^>]+>`))?.[0] ?? ''
      expect(tag).toContain(`data-resolved-line-count="${lineCount}"`)
      const height = Number(tag.match(/data-resolved-text-height="([^"]+)"/)?.[1])
      expect(height).toBeCloseTo(lineCount * 22, 4)
    }
    expect(result.html).toContain('A\n\nB\n</div>')
    expect(result.html).toContain('ABC\nمرحبا')

    for (const id of ['none-hard-break', 'none-blank-trailing'] as const) {
      const tag = result.html.match(new RegExp(`<div class="art-layer" data-layer-id="${id}"[^>]+>`))?.[0] ?? ''
      const layer = source.areas[0].layers.find((candidate: any) => candidate.id === id)
      const metric = (name: string) => Number(tag.match(new RegExp(`data-resolved-${name}="([^"]+)"`))?.[1])
      const bounds = layer.boundsMm
      const anchorX = (bounds.x + bounds.width / 2) * 5
      const anchorY = (bounds.y + (layer.anchor === 'center' ? bounds.height / 2 : 0)) * 5
      const resolved = resolveLayerRenderTransform({
        x: anchorX, y: anchorY, rotation: layer.rotation,
        width: metric('text-width'), height: metric('text-height'), anchor: layer.anchor,
        baselineFromTop: metric('baseline-from-top'),
      })
      expect(Number(tag.match(/left:([-0-9.]+)px/)?.[1])).toBeCloseTo(resolved.origin.x + resolved.box.x, 4)
      expect(Number(tag.match(/top:([-0-9.]+)px/)?.[1])).toBeCloseTo(resolved.origin.y + resolved.box.y, 4)
    }
  })

  it('applies the authoritative blueprint schema even on direct HTML rendering', () => {
    const source = blueprint()
    source.areas[0].layers[0].onclick = 'globalThis.executed=true'

    expect(() => renderBlueprintHtml(source, {
      pxPerMm: 5, width: 640, height: 480, assets: new Map(),
    })).toThrow(/schema validation/i)
  })

  it('records references as visual evidence without inserting or executing their content', async () => {
    const root = await temporaryDirectory()
    const blueprintPath = await writeFixture(root)
    const referencePath = path.join(root, 'malicious-reference.html')
    await writeFile(referencePath, '<script>globalThis.referenceInstructionExecuted=true</script><style>*{display:none}</style>')
    const result = await renderDesignReview({ blueprintPath, referencePaths: [referencePath], outputDir: path.join(root, 'review'), width: 640, height: 480, pxPerMm: 5, capture: fakeCapture() })

    expect(result.manifest.references).toEqual([{ path: 'malicious-reference.html', sha256: createHash('sha256').update(await readFile(referencePath)).digest('hex'), role: 'visual_evidence' }])
    expect(result.html).not.toContain('referenceInstructionExecuted')
    expect(result.html).not.toContain('*{display:none}')
  })

  it('captures the self-contained revision in one isolated Chromium context at exact dimensions', async () => {
    const root = await temporaryDirectory()
    const blueprintPath = await writeFixture(root)

    const result = await renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'browser-review'),
      width: 640, height: 480, pxPerMm: 5,
    })

    expect(result.manifest.artifacts.find((artifact: any) => artifact.viewKind === 'mockup-front')).toMatchObject({
      width: 640, height: 480,
    })
    expect(result.manifest.blueprint.revision).toBe('rev-001')
  })

  it.each([
    ['front device-scale mismatch', (capture: any) => ({ ...capture, front: { bytes: pngWithDimensions(1280, 960), width: 640, height: 480 } })],
    ['area header mismatch', (capture: any) => ({ ...capture, areas: { ...capture.areas, front: { bytes: pngWithDimensions(400, 600), width: 200, height: 300 } } })],
  ] as const)('rejects %s from PNG header bytes before publication', async (_label, mutate) => {
    const root = await temporaryDirectory()
    const blueprintPath = await writeFixture(root)
    const base = await fakeCapture()({ width: 640, height: 480, areas: blueprint().areas, pxPerMm: 5 })

    await expect(renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'dimension-mismatch'), width: 640, height: 480, pxPerMm: 5,
      capture: vi.fn(async () => mutate(base)),
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    await expect(readdir(root)).resolves.not.toContain('dimension-mismatch')
  })

  it('uses an explicitly declared font asset and preserves the declared no-wrap policy', () => {
    const source = blueprint()
    source.assets.push({ id: 'brand-font', path: 'assets/brand.woff2', sha256: 'a'.repeat(64), mimeType: 'font/woff2' })
    delete source.areas[0].layers[0].fontStack
    source.areas[0].layers[0].fontAsset = 'brand-font'
    const assets = new Map([['brand-font', { dataUrl: 'data:font/woff2;base64,d09GMg==', mimeType: 'font/woff2' }]])

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets })

    expect(html).toContain("@font-face{font-family:'review-font-brand-font';src:url('data:font/woff2;base64,d09GMg==') format('woff2')}")
    expect(html).toContain("font-family:'review-font-brand-font'")
    expect(html).toContain('white-space:pre')
    expect(html).not.toContain('white-space:nowrap')
  })

  it.each([
    [['   '], 'space-only'], [['\t'], 'tab-only'], [['\u00a0'], 'NBSP-only'], [['Arial', '   '], 'mixed valid and blank'],
  ] as const)('rejects a %s blueprint font stack before HTML generation', (fontStack, _label) => {
    const source = blueprint()
    source.areas[0].layers[0].fontStack = fontStack

    expect(() => renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() }))
      .toThrow(/fontStack|schema/i)
  })

  it('rejects a 16384-square compressed PNG header before Chromium capture', async () => {
    const root = await temporaryDirectory()
    const source = blueprint()
    const bomb = pngWithDimensions(16_384, 16_384)
    Object.assign(source.assets[0], {
      width: 16_384, height: 16_384,
      sha256: createHash('sha256').update(bomb).digest('hex'),
    })
    const blueprintPath = await writeFixture(root, source)
    await writeFile(path.join(root, 'assets/mark.png'), bomb)
    const capture = fakeCapture()

    await expect(renderDesignReview({ blueprintPath, outputDir: path.join(root, 'png-bomb'), width: 640, height: 480, pxPerMm: 5, capture }))
      .rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('caps requested and physical-area capture dimensions before browser allocation', async () => {
    const stdout: string[] = []
    const render = vi.fn(async () => ({ outputDir: '/tmp/review', artifacts: [], manifest: { version: 1 } }))
    const code = await runDesignReviewCli(['layout-blueprint.json', '--output', 'review', '--width', '4097', '--height', '1', '--json'], {
      renderDesignReview: render, stdout: (value: string) => stdout.push(value), stderr: () => undefined,
    })
    expect(code).not.toBe(0)
    expect(render).not.toHaveBeenCalled()

    const root = await temporaryDirectory()
    const source = blueprint()
    source.areas[0].artboard = { ...source.areas[0].artboard, widthMm: 5_000, heightMm: 5_000 }
    const blueprintPath = await writeFixture(root, source)
    const capture = fakeCapture()
    await expect(renderDesignReview({ blueprintPath, outputDir: path.join(root, 'oversized-area'), width: 640, height: 480, pxPerMm: 1, capture }))
      .rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
    expect(capture).not.toHaveBeenCalled()
  })

  it.each([
    ['front', 0],
    ['back', 1],
  ] as const)('rejects a fractional %s area that Chromium would rasterize beyond 4096 before browser launch', async (_side, areaIndex) => {
    const root = await temporaryDirectory()
    const source = blueprint()
    source.areas[areaIndex].artboard = { ...source.areas[areaIndex].artboard, widthMm: 1, heightMm: 4096.49 }
    const blueprintPath = await writeFixture(root, source)
    const capture = fakeCapture()

    await expect(renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'fractional-overflow'), width: 640, height: 480, pxPerMm: 1, capture,
    })).rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('rejects a forged direct-call capture plan before launching Chromium', async () => {
    const source = blueprint()
    source.areas[0].artboard = { ...source.areas[0].artboard, widthMm: 1, heightMm: 4096.49 }
    const forgedPlan = {
      review: { width: 1, height: 1 },
      areas: new Map(source.areas.map((area: any) => [area.id, { width: 1, height: 1, left: 0, top: 0 }])),
    }
    const launch = vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('Chromium must not launch'))

    try {
      await expect(captureDesignReview({
        html: '<html></html>', blueprint: source, width: 1, height: 1, pxPerMm: 1, capturePlan: forgedPlan,
      })).rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
      expect(launch).not.toHaveBeenCalled()
    } finally {
      launch.mockRestore()
    }
  })

  it('canonicalizes boundary and near-boundary physical areas to one exact integer capture plan', async () => {
    const root = await temporaryDirectory()
    const source = blueprint()
    source.areas[0].artboard = { ...source.areas[0].artboard, widthMm: 1, heightMm: 4096 }
    source.areas[1].artboard = { ...source.areas[1].artboard, widthMm: 1, heightMm: 4095.01 }
    const blueprintPath = await writeFixture(root, source)
    const capture = vi.fn(async ({ width, height, html }: any) => ({
      front: { bytes: pngWithDimensions(width, height), width, height },
      back: { bytes: pngWithDimensions(width, height), width, height },
      areas: {
        front: { bytes: pngWithDimensions(1, 4096), width: 1, height: 4096 },
        back: { bytes: pngWithDimensions(1, 4096), width: 1, height: 4096 },
      },
      resolvedHtml: html,
    }))

    const result = await renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'fractional-boundary'), width: 640, height: 480, pxPerMm: 1, capture,
    })

    expect(capture).toHaveBeenCalledOnce()
    const emittedHtml = capture.mock.calls[0][0].html
    expect(emittedHtml).toMatch(/data-area-id="front"[^>]+style="[^"]*width:1px;height:4096px"/)
    expect(emittedHtml).toMatch(/data-area-id="back"[^>]+style="[^"]*width:1px;height:4096px"/)
    expect(result.manifest.artifacts.filter((artifact: any) => artifact.viewKind === 'mockup-area').map((artifact: any) => ({
      areaId: artifact.areaId, width: artifact.width, height: artifact.height,
    }))).toEqual([
      { areaId: 'front', width: 1, height: 4096 },
      { areaId: 'back', width: 1, height: 4096 },
    ])
  })

  it('captures fractional physical areas at the same canonical CSS, PNG, and manifest dimensions in Chromium', async () => {
    const root = await temporaryDirectory()
    const source = blueprint()
    source.areas[0].artboard = { ...source.areas[0].artboard, widthMm: 40.1, heightMm: 60.1 }
    source.areas[1].artboard = { ...source.areas[1].artboard, widthMm: 38.1, heightMm: 58.1 }
    const blueprintPath = await writeFixture(root, source)

    const result = await renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'fractional-browser'), width: 640, height: 480, pxPerMm: 1,
    })

    expect(result.html).toMatch(/data-area-id="front"[^>]+style="[^"]*width:41px;height:61px"/)
    expect(result.html).toMatch(/data-area-id="back"[^>]+style="[^"]*width:39px;height:59px"/)
    expect(result.manifest.artifacts.filter((artifact: any) => artifact.viewKind === 'mockup-area').map((artifact: any) => ({
      areaId: artifact.areaId, width: artifact.width, height: artifact.height,
    }))).toEqual([
      { areaId: 'front', width: 41, height: 61 },
      { areaId: 'back', width: 39, height: 59 },
    ])
  })

  it('maps the declared stretch image fit to the browser-supported fill behavior', () => {
    const source = blueprint()
    source.areas[0].layers[2].fit = 'stretch'
    const assets = new Map([['mark', { dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, mimeType: 'image/png' }]])

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets })

    expect(html).toContain('object-fit:fill')
    expect(html).not.toContain('object-fit:stretch')
  })

  it('rejects font and image assets whose declared role does not match their MIME', async () => {
    const root = await temporaryDirectory()
    const source = blueprint()
    source.areas[0].layers[0].fontStack = undefined
    source.areas[0].layers[0].fontAsset = 'mark'
    const blueprintPath = await writeFixture(root, source)
    const capture = fakeCapture()

    await expect(renderDesignReview({ blueprintPath, outputDir: path.join(root, 'bad-role'), width: 640, height: 480, pxPerMm: 5, capture }))
      .rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
    expect(capture).not.toHaveBeenCalled()

    source.areas[0].layers[0].fontStack = ['Arial']
    delete source.areas[0].layers[0].fontAsset
    const fontBytes = Buffer.from('wOF2font-placeholder')
    source.assets.push({ id: 'font-as-image', path: 'assets/font.woff2', sha256: createHash('sha256').update(fontBytes).digest('hex'), mimeType: 'font/woff2' })
    source.areas[0].layers[2].assetId = 'font-as-image'
    await writeFile(path.join(root, 'assets/font.woff2'), fontBytes)
    await writeFile(blueprintPath, `${JSON.stringify(source, null, 2)}\n`)

    await expect(renderDesignReview({ blueprintPath, outputDir: path.join(root, 'bad-image-role'), width: 640, height: 480, pxPerMm: 5, capture }))
      .rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
  })

  it('fails closed when a declared font asset cannot be loaded by Chromium', async () => {
    const root = await temporaryDirectory()
    const source = blueprint()
    const brokenFont = headerValidButUndecodableWoff2()
    source.assets.push({
      id: 'broken-font', path: 'assets/broken.woff2',
      sha256: createHash('sha256').update(brokenFont).digest('hex'), mimeType: 'font/woff2',
    })
    delete source.areas[0].layers[0].fontStack
    source.areas[0].layers[0].fontAsset = 'broken-font'
    const blueprintPath = await writeFixture(root, source)
    await writeFile(path.join(root, 'assets/broken.woff2'), brokenFont)

    await expect(renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'broken-font-review'),
      width: 640, height: 480, pxPerMm: 5,
    })).rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    await expect(readdir(root)).resolves.not.toContain('broken-font-review')
  })

  it('renders a declared custom substrate boundary as vector geometry instead of a paper rectangle', () => {
    const source = blueprint()
    source.areas[1].substrate.boundary = { shape: 'custom', pathData: 'M0 0H190V290H0Z' }

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    const back = html.slice(html.indexOf('data-side="back"'))

    expect(back).toContain('class="carrier-boundary-path"')
    expect(back).toContain('d="M -95 -145 L 95 -145 L 95 145 L -95 145 Z"')
    expect(back).not.toContain('carrier-panel--opaque')
  })

  it.each(['applied_label', 'clear_label'] as const)('rejects open and zero-area custom %s boundaries while accepting a closed curve', (carrier) => {
    const source = blueprint()
    source.areas[1].carrier = carrier
    source.areas[1].substrate = carrier === 'applied_label'
      ? { kind: 'opaque', color: '#ffffff', opacity: 1, boundary: { shape: 'custom', pathData: 'M0 0H190V290H0' } }
      : { kind: 'transparent', opacity: 0.08, boundary: { shape: 'custom', pathData: 'M0 0H190V290H0' } }
    expect(() => renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })).toThrow(/custom|boundary|closed/i)

    source.areas[1].substrate.boundary.pathData = 'M0 0H190Z'
    expect(() => renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })).toThrow(/custom|boundary|area|bounds/i)

    source.areas[1].substrate.boundary.pathData = 'M0 145C0 65 190 65 190 145C190 225 0 225 0 145Z'
    expect(renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })).toContain('carrier-boundary-path')
  })

  it('renders the exact shared mapped arc geometry at the requested 36x62 mm, 5 px/mm size', () => {
    const source = blueprint()
    const layer = source.areas[0].layers[1]
    Object.assign(layer, {
      boundsMm: { x: 3, y: 3, width: 36, height: 62 },
      pathData: 'M0 31A18 31 0 0 1 36 31', pathViewBox: [0, 0, 36, 62],
    })
    const operations: string[] = []
    traceValidatedSvgPath({
      moveTo: (x, y) => operations.push(`M ${x} ${y}`),
      lineTo: (x, y) => operations.push(`L ${x} ${y}`),
      bezierCurveTo: (...values) => operations.push(`C ${values.join(' ')}`),
      closePath: () => operations.push('Z'),
    }, layer.pathData, layer.pathViewBox, 180, 310)

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    const pathMarkup = html.match(/<svg class="shape-geometry"[^>]*><path[^>]+>/)?.[0] ?? ''

    expect(pathMarkup).toContain('viewBox="-90 -155 180 310"')
    expect(pathMarkup).toContain(`d="${operations.join(' ')}"`)
    expect(pathMarkup).not.toContain('A18 31')
  })

  it('uses the shared mapped SVG route and rejects overflow at the actual physical render size', () => {
    const source = blueprint()
    const layer = source.areas[0].layers[1]
    layer.pathData = 'M0 0 L1000000000 0'
    layer.pathViewBox = [0, 0, 1e-10, 1]
    const issue = validateVectorPath(layer.pathData, layer.pathViewBox, 170, 270)

    expect(issue?.field).toBe('pathData')
    expect(() => renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() }))
      .toThrow(/SVG path|mapped|safe/i)
  })

  it('records selective clear-film underbase intent only as diagnostic metadata', () => {
    const source = blueprint()
    source.areas[0].carrier = 'clear_label'
    source.areas[0].substrate = { kind: 'transparent', opacity: 0.08, boundary: { shape: 'rectangle' } }
    source.areas[0].layers[0].processes = [{ process: 'white_underbase', requiredMask: 'white_underbase' }]

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })

    expect(html).toContain('data-selective-underbase="true"')
    expect(html).toContain('selective white underbase declared')
    expect(html).toContain('.capture-clean .carrier-film-extent{display:none}')
    expect(html).not.toContain('background:#fff')
  })

  it('emits language, bidi direction, wrap policy, and deterministic max-line clipping without changing copy', () => {
    const source = blueprint()
    Object.assign(source.areas[0].layers[0], {
      text: 'مرحبا بالعالم\nسطر ثان\nسطر مخفي', language: 'ar', writingDirection: 'auto',
      wrapPolicy: 'character', maxLines: 2,
    })

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })

    expect(html).toContain('lang="ar"')
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('data-writing-direction="auto"')
    expect(html).toContain('data-wrap-policy="character"')
    expect(html).toContain('data-max-lines="2"')
    expect(html).toContain('max-height:2.2em')
    expect(html).toContain('مرحبا بالعالم\nسطر ثان\nسطر مخفي')
  })

  it.each([
    [{ kind: 'transparent', opacity: 0.2, boundary: { shape: 'rectangle' }, material: 'clear film' }],
    [{ kind: 'opaque', color: '#ffffff', opacity: 0, boundary: { shape: 'rectangle' } }],
  ])('rejects an applied label without an explicit nonzero opaque substrate: %j', (substrate) => {
    const source = blueprint()
    source.areas[1].substrate = substrate

    expect(() => renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() }))
      .toThrow(/applied_label.*opaque|opacity/i)
  })

  it('publishes safe manifest paths that exactly match sanitized area files', async () => {
    const root = await temporaryDirectory()
    const source = blueprint()
    source.areas[0].id = 'front:primary'
    source.areas[1].id = 'back:primary'
    const blueprintPath = await writeFixture(root, source)
    const outputDir = path.join(root, 'safe-review')

    const result = await renderDesignReview({ blueprintPath, outputDir, width: 640, height: 480, pxPerMm: 5, capture: fakeCapture() })
    const paths = result.manifest.artifacts.filter((artifact: any) => artifact.viewKind === 'mockup-area').map((artifact: any) => artifact.path)

    expect(paths).toEqual(['areas/front-primary.png', 'areas/back-primary.png'])
    await expect(readFile(path.join(outputDir, paths[0]))).resolves.toEqual(pngWithDimensions(200, 300))
    await expect(readFile(path.join(outputDir, paths[1]))).resolves.toEqual(pngWithDimensions(190, 290))
  })

  it.each([
    ['image/jpeg', 'mark.jpg', JPEG_1X1],
    ['image/webp', 'mark.webp', WEBP_1X1],
  ] as const)('browser-decodes valid %s dimensions and rejects a declared mismatch', async (mimeType, fileName, bytes) => {
    const root = await temporaryDirectory()
    const source = blueprint()
    Object.assign(source.assets[0], {
      path: `assets/${fileName}`, mimeType, width: 1, height: 1,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    const blueprintPath = await writeFixture(root, source)
    await writeFile(path.join(root, 'assets', fileName), bytes)

    await expect(renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'valid-image'), width: 640, height: 480, pxPerMm: 5,
    })).resolves.toMatchObject({ outputDir: path.join(root, 'valid-image') })

    source.assets[0].width = 2
    await writeFile(blueprintPath, `${JSON.stringify(source, null, 2)}\n`)
    await expect(renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'mismatch-image'), width: 640, height: 480, pxPerMm: 5, capture: fakeCapture(),
    })).rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
  })

  it.each([
    ['truncated raw VP8', Buffer.from('UklGRhAAAABXRUJQVlA4IAoAAAAwAQCd', 'base64')],
    ['zero-width raw VP8', (() => { const bytes = Buffer.from(WEBP_1X1); bytes.writeUInt16LE(0, 26); return bytes })()],
  ])('rejects %s WebP before browser capture', async (_label, bytes) => {
    const root = await temporaryDirectory()
    const source = blueprint()
    Object.assign(source.assets[0], {
      path: 'assets/mark.webp', mimeType: 'image/webp', width: 1, height: 1,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    const blueprintPath = await writeFixture(root, source)
    await writeFile(path.join(root, 'assets/mark.webp'), bytes)
    const capture = fakeCapture()

    await expect(renderDesignReview({ blueprintPath, outputDir: path.join(root, 'bad-webp'), width: 640, height: 480, pxPerMm: 5, capture }))
      .rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
    expect(capture).not.toHaveBeenCalled()
  })

  it.each([
    ['direct_surface_print', undefined, false], ['in_mold', undefined, false], ['foil_or_ink_only', undefined, false],
    ['clear_label', { kind: 'transparent', opacity: 0.08, boundary: { shape: 'rectangle' } }, false],
    ['applied_label', { kind: 'opaque', color: '#ffffff', opacity: 1, boundary: { shape: 'rectangle' } }, true],
    ['bare', undefined, false],
  ] as const)('renders %s without inventing a permanent paper panel', (carrier, substrate, hasOpaquePanel) => {
    const source = blueprint()
    source.areas[0].carrier = carrier
    source.areas[0].substrate = substrate
    if (carrier === 'bare') source.areas[0].layers = []
    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    const front = html.slice(html.indexOf('data-side="front"'), html.indexOf('data-side="back"'))

    expect(front.includes('carrier-panel--opaque')).toBe(hasOpaquePanel)
    if (carrier === 'clear_label') expect(front).toContain('carrier-film-extent')
    if (carrier === 'bare') expect(front).not.toContain('data-layer-id=')
  })

  it.each([
    ['remote asset URL', (value: any) => { value.assets[0].path = 'https://evil.example/mark.png' }],
    ['asset digest mismatch', (value: any) => { value.assets[0].sha256 = '0'.repeat(64) }],
    ['ambiguous front selection', (value: any) => { value.areas.push({ ...structuredClone(value.areas[0]), id: 'front-2' }) }],
    ['decorative bare content', (value: any) => { value.areas[0].carrier = 'bare' }],
    ['ambiguous text font source', (value: any) => { value.areas[0].layers[0].fontAsset = 'mark' }],
    ['unaccepted flattened fallback', (value: any) => { value.areas[0].layers[0].flattenedFallback = { accepted: false, nonEditableLayerIds: ['front-copy'], nonEditableTextIds: ['front-copy'], lostSeparations: [], vectorAlternative: 'Provide vectors.' } }],
    ['opaque clear-label substrate', (value: any) => { value.areas[1].carrier = 'clear_label'; value.areas[1].substrate.kind = 'transparent'; value.areas[1].substrate.opacity = 1 }],
    ['white underbase without canonical mask', (value: any) => { value.areas[1].carrier = 'clear_label'; value.areas[1].substrate = { kind: 'transparent', opacity: 0.2, boundary: { shape: 'rectangle' } }; value.areas[1].layers[0].processes = [{ process: 'white_underbase', requiredMask: 'color' }] }],
    ['unsafe vector path', (value: any) => { value.areas[0].layers[1].pathData = 'M0 0 R1 1' }],
    ['incomplete vector path', (value: any) => { value.areas[0].layers[1].pathData = 'M0 0 L' }],
    ['coincident arc endpoint', (value: any) => { value.areas[0].layers[1].pathData = 'M0 0 A1 1 0 0 1 0 0' }],
    ['unsafe derived vector coordinate', (value: any) => { value.areas[0].layers[1].pathData = 'M100000000000 0 l100000000000 0' }],
  ] as const)('rejects %s before browser capture or publication', async (_label, mutate) => {
    const root = await temporaryDirectory()
    const value = blueprint(); mutate(value)
    const blueprintPath = await writeFixture(root, value)
    const capture = fakeCapture()
    await expect(renderDesignReview({ blueprintPath, outputDir: path.join(root, 'review'), width: 640, height: 480, pxPerMm: 5, capture }))
      .rejects.toMatchObject({ code: expect.stringMatching(/INVALID_LAYOUT_BLUEPRINT|PATH_NOT_ALLOWED|DIGEST_MISMATCH/) })
    expect(capture).not.toHaveBeenCalled()
    await expect(readdir(root)).resolves.not.toContain('review')
  })

  it('keeps the last complete review after browser failure and replaces it atomically only with force', async () => {
    const root = await temporaryDirectory()
    const blueprintPath = await writeFixture(root)
    const outputDir = path.join(root, 'review')
    await renderDesignReview({ blueprintPath, outputDir, width: 640, height: 480, pxPerMm: 5, capture: fakeCapture() })
    const previous = await readFile(path.join(outputDir, 'design-review-manifest.json'), 'utf8')
    const browserFailure = vi.fn(async () => { const error = Object.assign(new Error('browser disconnected'), { code: 'BROWSER_NOT_READY' }); throw error })
    await expect(renderDesignReview({ blueprintPath, outputDir, width: 800, height: 600, pxPerMm: 5, force: true, capture: browserFailure })).rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
    expect(await readFile(path.join(outputDir, 'design-review-manifest.json'), 'utf8')).toBe(previous)
    await expect(renderDesignReview({ blueprintPath, outputDir, width: 800, height: 600, pxPerMm: 5, capture: fakeCapture() })).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
    const replacement = await renderDesignReview({ blueprintPath, outputDir, width: 800, height: 600, pxPerMm: 5, force: true, capture: fakeCapture() })
    expect(replacement.manifest.artifacts.find((artifact: any) => artifact.path === 'mockup-front.png')).toMatchObject({ width: 800, height: 600 })
  })

  it('returns OUTPUT_CONFLICT before starting a non-forced browser capture', async () => {
    const root = await temporaryDirectory()
    const blueprintPath = await writeFixture(root)
    const outputDir = path.join(root, 'review')
    await renderDesignReview({ blueprintPath, outputDir, width: 640, height: 480, pxPerMm: 5, capture: fakeCapture() })
    const capture = vi.fn(async () => { throw new Error('capture must not start') })

    await expect(renderDesignReview({ blueprintPath, outputDir, width: 640, height: 480, pxPerMm: 5, capture }))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('builds a manifest without recursive self-hashing', () => {
    const manifest = buildDesignReviewManifest({
      blueprint: blueprint(), blueprintSha256: 'a'.repeat(64), htmlSha256: 'b'.repeat(64), createdAt: '2026-08-27T00:00:00.000Z', references: [],
      artifacts: [
        { id: 'mockup-html', path: 'mockup.html', sha256: 'b'.repeat(64), mimeType: 'text/html', width: 640, height: 480, viewKind: 'mockup-html' },
        { id: 'mockup-front', path: 'mockup-front.png', sha256: 'c'.repeat(64), mimeType: 'image/png', width: 640, height: 480, viewKind: 'mockup-front' },
        { id: 'mockup-back', path: 'mockup-back.png', sha256: 'd'.repeat(64), mimeType: 'image/png', width: 640, height: 480, viewKind: 'mockup-back' },
        { id: 'mockup-area-front', path: 'areas/front.png', sha256: 'e'.repeat(64), mimeType: 'image/png', width: 200, height: 300, viewKind: 'mockup-area', areaId: 'front', carrier: 'direct_surface_print' },
        { id: 'mockup-area-back', path: 'areas/back.png', sha256: 'f'.repeat(64), mimeType: 'image/png', width: 190, height: 290, viewKind: 'mockup-area', areaId: 'back', carrier: 'applied_label' },
      ],
    })
    expect(manifest.artifacts).not.toContainEqual(expect.objectContaining({ path: 'design-review-manifest.json' }))
    expect(manifest.blueprint).toEqual({ revision: 'rev-001', sha256: 'a'.repeat(64) })
  })

  it('rejects invalid RFC3339 offsets and duplicate artifact identity through shared manifest semantics', () => {
    const artifacts = [
      { id: 'mockup-html', path: 'mockup.html', sha256: 'b'.repeat(64), mimeType: 'text/html', width: 640, height: 480, viewKind: 'mockup-html' },
      { id: 'mockup-front', path: 'mockup-front.png', sha256: 'c'.repeat(64), mimeType: 'image/png', width: 640, height: 480, viewKind: 'mockup-front' },
      { id: 'mockup-back', path: 'mockup-back.png', sha256: 'd'.repeat(64), mimeType: 'image/png', width: 640, height: 480, viewKind: 'mockup-back' },
      { id: 'mockup-area-front', path: 'areas/front.png', sha256: 'e'.repeat(64), mimeType: 'image/png', width: 200, height: 300, viewKind: 'mockup-area', areaId: 'front', carrier: 'direct_surface_print' },
      { id: 'mockup-area-back', path: 'areas/back.png', sha256: 'f'.repeat(64), mimeType: 'image/png', width: 190, height: 290, viewKind: 'mockup-area', areaId: 'back', carrier: 'applied_label' },
    ]
    const input = { blueprint: blueprint(), blueprintSha256: 'a'.repeat(64), htmlSha256: 'b'.repeat(64), references: [] }

    expect(() => buildDesignReviewManifest({ ...input, createdAt: '2026-08-27T00:00:00+99:99', artifacts }))
      .toThrow(/date-time|createdAt|RFC3339/i)
    expect(() => buildDesignReviewManifest({
      ...input, createdAt: '2026-08-27T00:00:00+08:00', artifacts: [...artifacts, { ...artifacts[1], id: 'duplicate-front' }],
    })).toThrow(/artifact path|duplicate/i)
  })

  it('runs the CLI with one JSON envelope and structured nonzero errors', async () => {
    const stdout: string[] = []; const stderr: string[] = []
    const code = await runDesignReviewCli(['layout-blueprint.json', '--output', 'review', '--width', '640', '--height', '480', '--px-per-mm', '5', '--json'], {
      renderDesignReview: async () => ({ outputDir: '/tmp/review', artifacts: [{ path: 'mockup.html' }], manifest: { version: 1 } }),
      stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value),
    })
    expect(code).toBe(0); expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0])).toMatchObject({ ok: true, operation: 'render_design_review' }); expect(stderr).toEqual([])

    const errorStdout: string[] = []
    const errorCode = await runDesignReviewCli(['layout-blueprint.json', '--unknown'], { stdout: (value: string) => errorStdout.push(value), stderr: () => undefined })
    expect(errorCode).not.toBe(0); expect(errorStdout).toHaveLength(1); expect(JSON.parse(errorStdout[0])).toMatchObject({ ok: false, error: { code: 'INVALID_USAGE' } })
  })
})
