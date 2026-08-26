import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateVectorPath } from '../src/label/vectorPathValidation'
// @ts-expect-error Pure Node ESM module is consumed directly by the internal renderer.
import { buildDesignReviewManifest, renderBlueprintHtml, renderDesignReview } from '../scripts/lib/design-review.mjs'
// @ts-expect-error Pure Node ESM runner is consumed directly by tests.
import { runDesignReviewCli } from '../scripts/render-design-review.mjs'

const temporaryDirectories: string[] = []
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex')

function pngWithDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function jpegWithDimensions(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])
}

function webpWithDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(22, 4); bytes.write('WEBP', 8); bytes.write('VP8X', 12); bytes.writeUInt32LE(10, 16)
  bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3)
  return bytes
}

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
  return vi.fn(async ({ width, height, areas, pxPerMm }: any) => ({
    front: { bytes: pngWithDimensions(width, height), width, height }, back: { bytes: pngWithDimensions(width, height), width, height },
    areas: Object.fromEntries(areas.filter((area: any) => area.carrier !== 'bare').map((area: any) => [area.id, {
      bytes: pngWithDimensions(Math.round(area.artboard.widthMm * pxPerMm), Math.round(area.artboard.heightMm * pxPerMm)),
      width: Math.round(area.artboard.widthMm * pxPerMm), height: Math.round(area.artboard.heightMm * pxPerMm),
    }])),
    ...overrides,
  }))
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
    expect(result.html).toContain('d="M0 1 L0 0 L1 0 L1 1"')
    expect(result.html).toContain('vector-effect="non-scaling-stroke"')
    expect(result.html).toContain('left:20px;top:30px;width:160px;height:40px')
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

  it.each([
    ['top_left', '0px 0px'],
    ['top_center', '80px 0px'],
    ['center', '80px 20px'],
    ['baseline_left', '0px 0px'],
    ['baseline_center', '80px 0px'],
  ] as const)('keeps top-left blueprint bounds and rotates %s around its declared origin', (anchor, transformOrigin) => {
    const source = blueprint()
    source.areas[0].layers = [{ ...source.areas[0].layers[0], anchor, rotation: 30 }]

    const html = renderBlueprintHtml(source, { pxPerMm: 5, width: 640, height: 480, assets: new Map() })
    const layerMarkup = html.match(/<div class="art-layer"[^>]+>/)?.[0] ?? ''

    expect(layerMarkup).toContain('left:20px;top:30px;width:160px;height:40px')
    expect(layerMarkup).toContain(`transform-origin:${transformOrigin}`)
    expect(layerMarkup).toContain('transform:rotate(30deg)')
    expect(layerMarkup).not.toContain('translate')
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
    expect(html).toContain('white-space:nowrap')
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
    expect(back).toContain('d="M0 0H190V290H0Z"')
    expect(back).not.toContain('carrier-panel--opaque')
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
    expect(html).toContain('dir="auto"')
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
    ['image/jpeg', 'mark.jpg', jpegWithDimensions, 3, 2],
    ['image/webp', 'mark.webp', webpWithDimensions, 4, 3],
  ] as const)('accepts valid %s dimensions and rejects a declared mismatch', async (mimeType, fileName, makeBytes, width, height) => {
    const root = await temporaryDirectory()
    const source = blueprint()
    const bytes = makeBytes(width, height)
    Object.assign(source.assets[0], {
      path: `assets/${fileName}`, mimeType, width, height,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    const blueprintPath = await writeFixture(root, source)
    await writeFile(path.join(root, 'assets', fileName), bytes)

    await expect(renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'valid-image'), width: 640, height: 480, pxPerMm: 5, capture: fakeCapture(),
    })).resolves.toMatchObject({ outputDir: path.join(root, 'valid-image') })

    source.assets[0].width = width + 1
    await writeFile(blueprintPath, `${JSON.stringify(source, null, 2)}\n`)
    await expect(renderDesignReview({
      blueprintPath, outputDir: path.join(root, 'mismatch-image'), width: 640, height: 480, pxPerMm: 5, capture: fakeCapture(),
    })).rejects.toMatchObject({ code: 'INVALID_LAYOUT_BLUEPRINT' })
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
    ['unsafe derived vector coordinate', (value: any) => { value.areas[0].layers[1].pathData = 'M1000000000 0 l1000000000 0' }],
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
