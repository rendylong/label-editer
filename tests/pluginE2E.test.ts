import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
import type { ReviewEvidenceRequest } from '../src/agent/contracts'
import type { DesignReviewManifestV1, EditorHandoffV2, LayoutBlueprintV1 } from '../src/agent/designContracts'
import { applyStructuredLabelSpec } from '../src/app/labelSpec'
import { canonicalRasterHeight } from '../src/app/canvasLayout'
import { computeLabelSetup } from '../src/app/modelLoader'
import { serializeLabelProject } from '../src/app/projectSchema'
import { extractMeshAccessors, isMeshWorldMirrored, meshLocalFrontDirection, readGlb } from '../src/glb/analyze'
import { makeDefaultRemap } from '../src/glb/uvRemap'
// @ts-expect-error CLI is directly executable ESM.
import { runCli } from '../scripts/label-cli.mjs'
// @ts-expect-error Plugin runtime is directly executable ESM.
import { createPluginRuntime } from '../scripts/plugin-runtime.mjs'
// @ts-expect-error Operations are directly executable ESM.
import { createOperations } from '../scripts/lib/operations.mjs'
// @ts-expect-error Project control is directly executable ESM.
import { revisionOf } from '../scripts/lib/project-control.mjs'
// @ts-expect-error Design review is directly executable ESM.
import { renderDesignReview } from '../scripts/lib/design-review.mjs'

const defaultModel = '/Users/apple/realibox/cosmetic-bottles-glb/02_perfume_glass_with_cap.glb'
const modelPath = process.env.GLB_LABEL_E2E_MODEL ?? defaultModel
const runRealE2E = existsSync(modelPath)
const runLiveE2E = runRealE2E && process.env.GLB_LABEL_LIVE_E2E === '1'
const laviraModelPath = process.env.GLB_LABEL_TASK12_MODEL
  ?? '/Users/apple/realibox/cosmetic-bottles-glb/07_luxury_perfume_bottle_wood_glass.glb'
const laviraMockupPath = process.env.GLB_LABEL_TASK12_MOCKUP
  ?? '/Users/apple/realibox/cosmetic-bottles-glb/lavira-ember-woods-20260826/label-mockup.html'
const laviraBlueprintPath = path.resolve('tests/fixtures/blueprints/lavira-ember-woods-v1.json')
const carrierBlueprintPath = path.resolve('tests/fixtures/blueprints/carrier-regressions-v1.json')
const task12RequiredPaths = [laviraModelPath, laviraMockupPath, laviraBlueprintPath, carrierBlueprintPath]
const task12ExternalFilesPresent = task12RequiredPaths.every((filePath) => existsSync(filePath))
// The normal suite runs a small real-browser smoke whenever the documented files
// exist. The 4096 and review stress cases stay explicit to avoid suite contention.
const task12StressRequested = process.env.GLB_LABEL_TASK12_E2E === '1'
// The source UVs are Float32 and the surface aspect comes from the median UV→geometry
// Jacobian. One part per million is strict enough to catch a physical-layout mismatch
// without pretending repeated remaps can recover precision that is absent in the GLB.
const TASK12_ASPECT_TOLERANCE = 1e-6
const task12StressExecuted = new Set<string>()

function task12AspectMatches(expected: number, actual: number): boolean {
  return Math.abs(actual - expected) <= Math.abs(expected) * TASK12_ASPECT_TOLERANCE
}

function requireTask12ExternalFiles(): void {
  const missing = task12RequiredPaths.filter((filePath) => !existsSync(filePath))
  if (missing.length > 0) throw new Error(`Task 12 required external files are missing: ${missing.join(', ')}`)
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

type Task12Package = {
  root: string
  blueprint: LayoutBlueprintV1
  blueprintBytes: Buffer
  blueprintPath: string
  designReviewDir: string
  designManifestBytes: Buffer
  inputBytes: Buffer
  inputPath: string
  spec: ReturnType<typeof serializeLabelProject>
}

let task12GeometryPromise: Promise<{
  document: Awaited<ReturnType<typeof readGlb>>
  mesh: ReturnType<typeof extractMeshAccessors>
  mirrored: boolean
  frontDirection: [number, number, number]
}> | undefined

function task12Geometry() {
  task12GeometryPromise ??= (async () => {
    const document = await readGlb(await readFile(laviraModelPath))
    return {
      document,
      mesh: extractMeshAccessors(document, 1),
      mirrored: isMeshWorldMirrored(document, 1),
      frontDirection: meshLocalFrontDirection(document, 1),
    }
  })()
  return task12GeometryPromise
}

async function task12PackageRoot(): Promise<string> {
  const requested = process.env.GLB_LABEL_TASK12_EVIDENCE_DIR
  const parent = requested ? path.resolve(requested) : tmpdir()
  await mkdir(parent, { recursive: true })
  return mkdtemp(path.join(parent, 'task-12-browser-'))
}

async function task12Shells(blueprint: LayoutBlueprintV1) {
  const { mesh, mirrored, frontDirection } = await task12Geometry()
  return blueprint.areas.map((area) => {
    const back = area.side === 'back'
    const sourceRange = back
      ? { uStart: 0.35, uWidth: 0.3, vStart: 0.035, vHeight: 0.665, aspect: 0.9095857956574818 }
      : { uStart: 0.375, uWidth: 0.25, vStart: 0.1, vHeight: 0.56, aspect: 0.9001113230557523 }
    const artboardAspect = area.artboard.widthMm / area.artboard.heightMm
    const centerU = sourceRange.uStart + sourceRange.uWidth / 2
    const remap = makeDefaultRemap(mesh, mirrored, frontDirection)
    remap.mode = 'cylindrical'
    remap.wrap = 1
    remap.offset = back ? 0.25 : 0.75
    remap.mirrorU = false
    let uWidth = sourceRange.uWidth * artboardAspect / sourceRange.aspect
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const candidate = {
        uStart: centerU - uWidth / 2,
        uWidth,
        vStart: sourceRange.vStart,
        vHeight: sourceRange.vHeight,
      }
      const actualAspect = computeLabelSetup(mesh, remap, candidate, 'overlay').spec.aspect
      if (task12AspectMatches(artboardAspect, actualAspect)) break
      uWidth *= artboardAspect / actualAspect
    }
    const range = {
      uStart: centerU - uWidth / 2,
      uWidth,
      vStart: sourceRange.vStart,
      vHeight: sourceRange.vHeight,
    }
    const actualAspect = computeLabelSetup(mesh, remap, range, 'overlay').spec.aspect
    if (!task12AspectMatches(artboardAspect, actualAspect)) {
      throw new Error(`Task 12 UV aspect mismatch for ${area.id}: ${actualAspect} != ${artboardAspect}`)
    }
    return {
      blueprintAreaId: area.id,
      name: area.id,
      target: { stableSelector: 'mesh:1/node:6' },
      surfaceMode: 'overlay' as const,
      // Preserve the evidence placement center/height while narrowing the UV span to the exact physical artboard aspect.
      range,
      remap: { mode: 'cylindrical' as const, wrap: 1, offset: back ? 0.25 : 0.75, mirrorU: false },
    }
  })
}

async function task12ProjectAreas(
  blueprint: LayoutBlueprintV1,
  options: {
    bakeWidth?: number
    binding?: { blueprintRevision: string; blueprintSha256: string; reviewManifestSha256: string }
    shells?: Awaited<ReturnType<typeof task12Shells>>
  } = {},
) {
  const areas = compileBlueprintToSpecAreas(blueprint, options.shells ?? await task12Shells(blueprint))
  if (options.binding) for (const area of areas) area.designBinding = { ...options.binding }
  const { mesh, mirrored, frontDirection } = await task12Geometry()
  return areas.map((area) => {
    const artboard = area.artboard
    if (!artboard) throw new Error(`Compiled Task 12 area is missing its physical artboard: ${area.id}`)
    const remap = makeDefaultRemap(mesh, mirrored, frontDirection)
    const requestedRemap = area.remap as {
      mode?: 'auto' | 'cylindrical' | 'planar'
      wrap?: number
      offset?: number
      mirrorU?: boolean
    } | undefined
    if (requestedRemap?.mode && requestedRemap.mode !== 'auto') remap.mode = requestedRemap.mode
    if (requestedRemap?.wrap !== undefined) remap.wrap = requestedRemap.wrap
    if (requestedRemap?.offset !== undefined) remap.offset = requestedRemap.offset
    if (requestedRemap?.mirrorU !== undefined) remap.mirrorU = requestedRemap.mirrorU
    const setup = computeLabelSetup(mesh, remap, area.range, 'overlay')
    const physicalAspect = artboard.widthMm / artboard.heightMm
    if (!task12AspectMatches(physicalAspect, setup.spec.aspect)) {
      throw new Error(`Task 12 canvas aspect mismatch for ${area.id}: ${setup.spec.aspect} != ${physicalAspect}`)
    }
    const bakeWidth = options.bakeWidth
      ?? (artboard.widthMm === 50 && artboard.heightMm === 66 ? 513 : 512)
    const base = {
      id: area.id,
      name: area.name,
      meshIndex: 1,
      nodeName: 'Circle.002_Logo_0',
      surfaceMode: 'overlay' as const,
      side: area.side,
      remap,
      range: structuredClone(area.range),
      canvas: {
        width: bakeWidth,
        height: canonicalRasterHeight(bakeWidth, setup.spec.aspect),
        aspect: setup.spec.aspect,
      },
      axisMin: setup.axisMin,
      axisMax: setup.axisMax,
      layers: [],
      globalCraft: { craft: [] },
      fonts: [],
      referenceVisible: false,
      undoStack: [],
      redoStack: [],
    }
    return applyStructuredLabelSpec(base, { version: 2, areas: [area] }, area.id).areas[0]
  })
}

async function prepareTask12Package(
  root: string,
  name: string,
  blueprintBytes: Buffer,
): Promise<Task12Package> {
  const packageRoot = path.join(root, name)
  await mkdir(packageRoot, { recursive: true })
  const blueprintPath = path.join(packageRoot, 'layout-blueprint.json')
  await writeFile(blueprintPath, blueprintBytes)
  const blueprint = JSON.parse(blueprintBytes.toString('utf8')) as LayoutBlueprintV1
  const designReviewDir = path.join(packageRoot, 'design-review')
  await renderDesignReview({
    blueprintPath,
    outputDir: designReviewDir,
    width: 960,
    height: 720,
    pxPerMm: 5,
    createdAt: '2026-08-28T00:00:00.000Z',
  })
  const designManifestPath = path.join(designReviewDir, 'design-review-manifest.json')
  const designManifestBytes = await readFile(designManifestPath)
  const blueprintSha256 = hash(blueprintBytes)
  const designManifestSha256 = hash(designManifestBytes)
  const projectAreas = await task12ProjectAreas(blueprint, {
    binding: {
      blueprintRevision: blueprint.revision,
      blueprintSha256,
      reviewManifestSha256: designManifestSha256,
    },
  })
  const spec = serializeLabelProject(path.basename(laviraModelPath), projectAreas)
  const inputBytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`)
  const inputPath = path.join(packageRoot, 'working.json')
  const handoff: EditorHandoffV2 = {
    handoff_version: 2,
    status: 'approved',
    source: {
      design_spec: 'task-12-evidence.md',
      mockup_html: 'design-review/mockup.html',
      blueprint: 'layout-blueprint.json',
      design_review_manifest: 'design-review/design-review-manifest.json',
      blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha256,
      review_manifest_sha256: designManifestSha256,
    },
    approval: {
      mode: 'explicit_approval',
      scope: 'current_task',
      blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha256,
      review_manifest_sha256: designManifestSha256,
    },
    model: { package_type: 'bottle' },
    areas: blueprint.areas.map((area) => ({
      id: area.id,
      side: area.side,
      carrier: area.carrier,
      placement: area.placementIntent,
      physical_size_mm: { width: area.artboard.widthMm, height: area.artboard.heightMm },
      blueprint_area_id: area.id,
    })),
    assets: [],
    production_constraints: {},
    assumptions: [],
    blockers: [],
  }
  await Promise.all([
    writeFile(inputPath, inputBytes),
    writeFile(path.join(packageRoot, 'editor-handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`),
  ])
  return {
    root: packageRoot,
    blueprint,
    blueprintBytes,
    blueprintPath,
    designReviewDir,
    designManifestBytes,
    inputBytes,
    inputPath,
    spec,
  }
}

async function runTask12Review(fixture: Task12Package) {
  const outputDir = path.join(fixture.root, 'production-review')
  const stdout: string[] = []
  const stderr: string[] = []
  const runtime = await createPluginRuntime({
    allowedRoots: [process.cwd(), path.dirname(laviraModelPath), fixture.root],
  })
  const resilientRuntime = {
    ...runtime,
    async callBridge(session: unknown, method: string, input: unknown) {
      let lastError: unknown
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          return await runtime.callBridge(session, method, input)
        } catch (error) {
          lastError = error
          if (!(error instanceof Error) || !error.message.includes('Agent Bridge is unavailable')) throw error
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      throw lastError
    },
  }
  let code = -1
  try {
    code = await runCli([
      'review', fixture.inputPath,
      '--glb', laviraModelPath,
      '--output', outputDir,
      '--width', '640',
      '--height', '640',
      '--json',
    ], {
      operations: createOperations(resilientRuntime, { progress: (value: string) => stderr.push(value) }),
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    })
  } finally {
    await runtime.close()
  }
  expect(code, [...stderr, ...stdout].join('\n')).toBe(0)
  expect(stdout).toHaveLength(1)
  expect(stdout[0]).not.toMatch(/leaseToken|token=/)
  return {
    outputDir,
    envelope: JSON.parse(stdout[0]),
    manifestBytes: await readFile(path.join(outputDir, 'review-manifest.json')),
  }
}

async function browserPngStats(filePaths: string[]): Promise<Array<{
  width: number
  height: number
  transparent: number
  opaque: number
  visible: number
  charcoal: number
  copper: number
  light: number
  black: number
  white: number
  neutral128: number
  notNeutral128: number
  colorBuckets: number
  corners: number[][]
  center: number[]
  regions: Record<'topFrame' | 'leftFrame' | 'bottomCenter' | 'upperArtwork', {
    pixels: number; visible: number; charcoal: number; copper: number; light: number
  }>
}>> {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const result = []
    for (const filePath of filePaths) {
      const png = (await readFile(filePath)).toString('base64')
      result.push(await page.evaluate(async (base64) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let transparent = 0
        let opaque = 0
        let visible = 0
        let charcoal = 0
        let copper = 0
        let light = 0
        let black = 0
        let white = 0
        let neutral128 = 0
        let notNeutral128 = 0
        const buckets = new Set<number>()
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const [red, green, blue, alpha] = pixels.slice(offset, offset + 4)
          if (alpha === 0) transparent += 1
          if (alpha === 255) opaque += 1
          if (alpha > 0) {
            visible += 1
            if (red < 55 && green < 55 && blue < 55) charcoal += 1
            if (red >= 90 && red > green * 1.15 && green > blue * 1.05) copper += 1
            if (red > 135 && green > 125 && blue > 105) light += 1
            if (red < 10 && green < 10 && blue < 10) black += 1
            if (red > 245 && green > 245 && blue > 245) white += 1
            if (Math.abs(red - 128) <= 2 && Math.abs(green - 128) <= 2 && Math.abs(blue - 128) <= 2) neutral128 += 1
            if (Math.abs(red - 128) > 5 || Math.abs(green - 128) > 5 || Math.abs(blue - 128) > 5) notNeutral128 += 1
          }
          buckets.add((pixels[offset] >> 5) << 12 | (pixels[offset + 1] >> 5) << 8
            | (pixels[offset + 2] >> 5) << 4 | (pixels[offset + 3] >> 6))
        }
        const at = (x: number, y: number) => {
          const offset = (y * canvas.width + x) * 4
          return Array.from(pixels.slice(offset, offset + 4))
        }
        const region = (x0: number, y0: number, x1: number, y1: number) => {
          const startX = Math.floor(canvas.width * x0)
          const startY = Math.floor(canvas.height * y0)
          const endX = Math.ceil(canvas.width * x1)
          const endY = Math.ceil(canvas.height * y1)
          const result = { pixels: 0, visible: 0, charcoal: 0, copper: 0, light: 0 }
          for (let y = startY; y < endY; y += 1) for (let x = startX; x < endX; x += 1) {
            const offset = (y * canvas.width + x) * 4
            const red = pixels[offset]
            const green = pixels[offset + 1]
            const blue = pixels[offset + 2]
            const alpha = pixels[offset + 3]
            result.pixels += 1
            if (alpha > 0) {
              result.visible += 1
              if (red < 55 && green < 55 && blue < 55) result.charcoal += 1
              if (red >= 90 && red > green * 1.15 && green > blue * 1.05) result.copper += 1
              if (red > 135 && green > 125 && blue > 105) result.light += 1
            }
          }
          return result
        }
        return {
          width: canvas.width,
          height: canvas.height,
          transparent,
          opaque,
          visible,
          charcoal,
          copper,
          light,
          black,
          white,
          neutral128,
          notNeutral128,
          colorBuckets: buckets.size,
          corners: [
            at(0, 0), at(canvas.width - 1, 0),
            at(0, canvas.height - 1), at(canvas.width - 1, canvas.height - 1),
          ],
          center: at(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)),
          regions: {
            topFrame: region(0.1, 0.025, 0.9, 0.065),
            leftFrame: region(0.035, 0.2, 0.075, 0.85),
            bottomCenter: region(0.1, 0.93, 0.9, 0.98),
            upperArtwork: region(0.08, 0.08, 0.92, 0.62),
          },
        }
      }, png))
    }
    return result
  } finally {
    await browser.close()
  }
}

async function browserHtmlFacts(html: string, areaId: string) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    return await page.evaluate((id) => {
      const area = document.querySelector(`[data-area-id="${CSS.escape(id)}"]`)
      if (!(area instanceof HTMLElement)) throw new Error(`Missing area ${id}`)
      const style = getComputedStyle(area)
      const textFacts = Object.fromEntries([...area.querySelectorAll<HTMLElement>('[data-kind="text"]')].map((layer) => {
        const text = layer.querySelector<HTMLElement>('.text-geometry')
        const box = layer.getBoundingClientRect()
        return [layer.dataset.layerId!, {
          width: box.width,
          height: box.height,
          fontSize: text ? Number.parseFloat(getComputedStyle(text).fontSize) : 0,
          text: text?.textContent ?? '',
        }]
      }))
      document.body.classList.add('capture-clean')
      return {
        carrier: area.getAttribute('data-carrier'),
        panelCount: area.querySelectorAll('.carrier-panel,.carrier-film-extent,.carrier-boundary-path').length,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        diagnosticDisplay: getComputedStyle(document.querySelector('.diagnostic')!).display,
        textFacts,
      }
    }, areaId)
  } finally {
    await browser.close()
  }
}

function bridgeData<T>(result: { ok?: boolean; data?: T; error?: { code?: string; message?: string } }, stage: string): T {
  if (result.ok !== true || result.data === undefined) {
    throw new Error(`${stage} failed: ${result.error?.code ?? 'UNKNOWN'} ${result.error?.message ?? ''}`)
  }
  return result.data
}

async function task12NativeChannelExport(
  runtime: Awaited<ReturnType<typeof createPluginRuntime>>,
  project: ReturnType<typeof serializeLabelProject>,
  outputRoot: string,
) {
  const session = await runtime.createSession({ glbPath: laviraModelPath })
  const call = async (method: string, input: unknown) => {
    let lastError: unknown
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await runtime.callBridge(session, method, input)
      } catch (error) {
        lastError = error
        if (!(error instanceof Error) || !error.message.includes('Agent Bridge is unavailable')) throw error
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    throw lastError
  }
  try {
    bridgeData(await call('loadModel', { name: session.modelName, url: session.inputUrl }), 'load model')
    const applied = bridgeData<{ project: ReturnType<typeof serializeLabelProject> }>(
      await call('applyProject', { project }),
      'apply native project',
    )
    const exported = bridgeData<{ artifacts: Array<{
      id: string; areaId?: string; channel?: string; width?: number; height?: number; sha256: string
    }> }>(
      await call('exportArtifacts', { artifacts: ['channels'] }),
      'export native channels',
    )
    expect(exported.artifacts.length).toBeGreaterThan(0)
    expect(exported.artifacts.every((artifact) => artifact.areaId && artifact.channel)).toBe(true)
    const uploaded = runtime.getArtifacts(session.id)
    const files = new Map<string, string>()
    for (const descriptor of exported.artifacts) {
      const artifact = uploaded.find((candidate: { id: string }) => candidate.id === descriptor.id)
      if (!artifact) throw new Error(`Missing native channel bytes: ${descriptor.id}`)
      const filePath = path.join(outputRoot, descriptor.id, `${descriptor.channel}.png`)
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, artifact.bytes)
      expect(hash(artifact.bytes)).toBe(descriptor.sha256)
      expect(Buffer.from(artifact.bytes).readUInt32BE(16)).toBe(descriptor.width)
      expect(Buffer.from(artifact.bytes).readUInt32BE(20)).toBe(descriptor.height)
      files.set(`${descriptor.areaId}:${descriptor.channel}`, filePath)
    }
    return { project: applied.project, artifacts: exported.artifacts, files }
  } finally {
    await runtime.disposeSession(session.id)
  }
}

function glbJson(bytes: Uint8Array): Record<string, any> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim())
}

function reviewEvidenceFixture(): { spec: Record<string, unknown>; request: ReviewEvidenceRequest } {
  const widthMm = 58.76605666054
  const heightMm = 30
  const blueprint: LayoutBlueprintV1 = {
    version: 1,
    revision: 'task9-browser-review-v1',
    carrierDefaults: { carrier: 'direct_surface_print' },
    assets: [],
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      artboard: { widthMm, heightMm, background: 'transparent' },
      placementIntent: 'Centered direct print on the front face.', placementPolicy: 'block',
      layers: [{
        id: 'browser-mark', kind: 'shape', boundsMm: { x: 16, y: 4, width: 26, height: 22 },
        anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 0,
        processes: [{ process: 'screen_print' }], shape: 'ellipse',
        fill: '#b88a44', stroke: '#3b2411', strokeWidthMm: 0.5, cornerRadiusMm: 0,
      }],
    }],
  }
  const blueprintJson = JSON.stringify(blueprint)
  const blueprintSha = hash(new TextEncoder().encode(blueprintJson))
  const manifest: DesignReviewManifestV1 = {
    version: 1, createdAt: '2026-08-27T10:00:00.000Z',
    blueprint: { revision: blueprint.revision, sha256: blueprintSha },
    html: { sha256: '1'.repeat(64) }, references: [],
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'mockup-front', path: 'mockup-front.png', sha256: '2'.repeat(64),
      mimeType: 'image/png', width: 1600, height: 1200, viewKind: 'mockup-front',
    }, {
      id: 'mockup-back', path: 'mockup-back.png', sha256: '3'.repeat(64),
      mimeType: 'image/png', width: 1600, height: 1200, viewKind: 'mockup-back',
    }, {
      id: 'mockup-area-front', path: 'areas/front.png', sha256: '4'.repeat(64),
      mimeType: 'image/png', width: 1200, height: 1200, viewKind: 'mockup-area',
      areaId: 'front', carrier: 'direct_surface_print',
    }],
  }
  const designReviewManifestJson = JSON.stringify(manifest)
  const manifestSha = hash(new TextEncoder().encode(designReviewManifestJson))
  const handoff: EditorHandoffV2 = {
    handoff_version: 2, status: 'approved',
    source: {
      design_spec: 'design.md', mockup_html: 'mockup.html', blueprint: 'layout-blueprint.json',
      design_review_manifest: 'design-review-manifest.json', blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha, review_manifest_sha256: manifestSha,
    },
    approval: {
      mode: 'explicit_approval', scope: 'current_task', blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha, review_manifest_sha256: manifestSha,
    },
    model: { package_type: 'bottle' },
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      placement: 'Centered direct print on the front face.',
      physical_size_mm: { width: widthMm, height: heightMm }, blueprint_area_id: 'front',
    }],
    assets: [], production_constraints: {}, assumptions: [], blockers: [],
  }
  const areas = compileBlueprintToSpecAreas(blueprint, [{
    blueprintAreaId: 'front', name: 'Front',
    target: { nodeName: 'Cube.001_Material.001_0' }, surfaceMode: 'overlay',
    range: { uStart: 0.35, uWidth: 0.3, vStart: 0.2, vHeight: 0.6 },
  }])
  areas[0].designBinding = {
    blueprintRevision: blueprint.revision,
    blueprintSha256: blueprintSha,
    reviewManifestSha256: manifestSha,
  }
  return {
    spec: { version: 2, areas },
    request: {
      width: 640, height: 640,
      designGate: { handoff, blueprintJson, designReviewManifestJson },
    },
  }
}

describe('GLB label plugin E2E', () => {
  it.runIf(task12ExternalFilesPresent)('runs a bounded Task12 external smoke through real Konva, Chromium PNG decode, and server upload', async () => {
    const evidenceRoot = await task12PackageRoot()
    const [mockupBytes, laviraBlueprint, carrierBlueprintBytes] = await Promise.all([
      readFile(laviraMockupPath),
      readFile(laviraBlueprintPath, 'utf8').then((value) => JSON.parse(value) as LayoutBlueprintV1),
      readFile(carrierBlueprintPath),
    ])
    expect(hash(mockupBytes)).toBe('bde3f32fab1a653f81264189b094c23620eb534cfa255fd6ac7e39543f6eb10f')
    expect(carrierBlueprintBytes.byteLength).toBeGreaterThan(1_000)
    const laviraShells = await task12Shells(laviraBlueprint)
    const laviraAreas = await task12ProjectAreas(laviraBlueprint, { bakeWidth: 128, shells: laviraShells })
    const project = serializeLabelProject(path.basename(laviraModelPath), [
      laviraAreas.find((area) => area.id === 'lavira.front:approved')!,
    ])
    const runtime = await createPluginRuntime({
      allowedRoots: [process.cwd(), path.dirname(laviraModelPath), evidenceRoot],
    })
    try {
      const result = await task12NativeChannelExport(runtime, project, path.join(evidenceRoot, 'bounded-smoke'))
      expect(result.artifacts).toHaveLength(4)
      expect(result.artifacts.every((artifact) => /^[A-Za-z0-9._-]{1,160}$/.test(artifact.id))).toBe(true)

      const frontColor = result.files.get('lavira.front:approved:color')!
      const [frontStats] = await browserPngStats([frontColor])
      expect(frontStats).toMatchObject({ width: 128, height: 165 })
      expect(frontStats.charcoal).toBeGreaterThan(frontStats.width * frontStats.height * 0.6)
      expect(frontStats.copper).toBeGreaterThan(10)
      expect(frontStats.light).toBeGreaterThan(10)
      expect(frontStats.regions.bottomCenter.copper).toBeLessThan(frontStats.regions.topFrame.copper)
    } finally {
      await runtime.close()
    }
  }, 180_000)

  it.runIf(task12StressRequested)('Task12 stress case 1 renders native Lavira 1024/4096 bakes and every carrier channel through real Konva in Chromium', async () => {
    requireTask12ExternalFiles()
    const evidenceRoot = await task12PackageRoot()
    const [laviraBlueprint, carrierBlueprint] = await Promise.all([
      readFile(laviraBlueprintPath, 'utf8').then((value) => JSON.parse(value) as LayoutBlueprintV1),
      readFile(carrierBlueprintPath, 'utf8').then((value) => JSON.parse(value) as LayoutBlueprintV1),
    ])
    const [laviraShells, carrierShells] = await Promise.all([
      task12Shells(laviraBlueprint), task12Shells(carrierBlueprint),
    ])
    const [lavira1024Areas, lavira4096Areas, carrierAreas] = await Promise.all([
      task12ProjectAreas(laviraBlueprint, { bakeWidth: 1024, shells: laviraShells }),
      task12ProjectAreas(laviraBlueprint, { bakeWidth: 4096, shells: laviraShells }),
      task12ProjectAreas(carrierBlueprint, { bakeWidth: 256, shells: carrierShells }),
    ])
    const lavira1024 = serializeLabelProject(path.basename(laviraModelPath), lavira1024Areas)
    const lavira4096 = serializeLabelProject(
      path.basename(laviraModelPath),
      lavira4096Areas.filter((area) => area.id === 'lavira.front:approved'),
    )
    const carriers = serializeLabelProject(path.basename(laviraModelPath), carrierAreas)
    expect(lavira1024.areas.map((area) => area.canvas)).toEqual([
      { width: 1024, height: 1323, aspect: expect.closeTo(48 / 62, 6) },
      { width: 1024, height: 1352, aspect: expect.closeTo(50 / 66, 6) },
    ])
    expect(lavira4096.areas[0].canvas).toEqual({
      width: 4096, height: 5291, aspect: expect.closeTo(48 / 62, 6),
    })
    for (const project of [lavira1024, lavira4096]) {
      const copy = project.areas.flatMap((area) => area.layers)
        .filter((layer) => layer.kind === 'text')
        .map((layer) => layer.kind === 'text' ? layer.text : '')
      expect(copy).toEqual(expect.arrayContaining(['LAVIRA', '余烬森林', 'EMBER WOODS']))
      expect(copy).not.toContain('烬木之息')
    }

    const runtime = await createPluginRuntime({
      allowedRoots: [process.cwd(), path.dirname(laviraModelPath), evidenceRoot],
    })
    try {
      const carrierResult = await task12NativeChannelExport(
        runtime, carriers, path.join(evidenceRoot, 'native-carriers-256'),
      )
      expect(carrierResult.artifacts.some((artifact) => artifact.areaId === 'carrier.bare:front')).toBe(false)
      expect(new Set(carrierResult.artifacts.map((artifact) => artifact.areaId))).toEqual(new Set([
        'carrier.direct:curved', 'carrier.applied:paper',
        'carrier.clear:selective-white', 'carrier.foil:marks-only',
      ]))

      const lavira1024Result = await task12NativeChannelExport(
        runtime, lavira1024, path.join(evidenceRoot, 'native-lavira-1024'),
      )
      const lavira4096Result = await task12NativeChannelExport(
        runtime, lavira4096, path.join(evidenceRoot, 'native-lavira-4096'),
      )
      expect(lavira1024Result.artifacts.filter((artifact) => artifact.channel === 'color'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ areaId: 'lavira.front:approved', width: 1024, height: 1323 }),
          expect.objectContaining({ areaId: 'lavira.back:approved', width: 1024, height: 1352 }),
        ]))
      expect(lavira4096Result.artifacts.filter((artifact) => artifact.channel === 'color')).toEqual([
        expect.objectContaining({ areaId: 'lavira.front:approved', width: 4096, height: 5291 }),
      ])

      const carrierKeys = [
        'carrier.direct:curved:color',
        'carrier.applied:paper:color',
        'carrier.applied:paper:metalness',
        'carrier.applied:paper:roughness',
        'carrier.applied:paper:bump',
        'carrier.clear:selective-white:color',
        'carrier.clear:selective-white:white_underbase',
        'carrier.foil:marks-only:color',
        'carrier.foil:marks-only:metalness',
        'carrier.foil:marks-only:roughness',
        'carrier.foil:marks-only:bump',
      ]
      expect([...carrierResult.files.keys()].sort()).toEqual([...carrierKeys].sort())
      const carrierStats = await browserPngStats(carrierKeys.map((key) => carrierResult.files.get(key)!))
      const byCarrierKey = new Map(carrierKeys.map((key, index) => [key, carrierStats[index]]))
      const carrierPixels = 256 * 256
      const directColor = byCarrierKey.get('carrier.direct:curved:color')!
      expect(directColor.transparent).toBeGreaterThan(carrierPixels / 2)
      expect(directColor.copper).toBeGreaterThan(100)
      expect(directColor.light).toBeGreaterThan(100)
      const appliedColor = byCarrierKey.get('carrier.applied:paper:color')!
      expect(appliedColor.opaque).toBeGreaterThan(carrierPixels * 0.95)
      expect(appliedColor.transparent).toBeGreaterThan(0)
      expect(appliedColor.light).toBeGreaterThan(carrierPixels / 2)
      expect(appliedColor.charcoal).toBeGreaterThan(100)
      const appliedMetal = byCarrierKey.get('carrier.applied:paper:metalness')!
      const appliedRough = byCarrierKey.get('carrier.applied:paper:roughness')!
      const appliedBump = byCarrierKey.get('carrier.applied:paper:bump')!
      expect(appliedMetal.black).toBe(carrierPixels)
      expect(appliedMetal.center).toEqual([0, 0, 0, 255])
      expect(appliedRough.white).toBe(carrierPixels)
      expect(appliedRough.center).toEqual([255, 255, 255, 255])
      expect(appliedBump.neutral128).toBe(carrierPixels)
      expect(appliedBump.center).toEqual([128, 128, 128, 255])
      const clearColor = byCarrierKey.get('carrier.clear:selective-white:color')!
      const clearWhite = byCarrierKey.get('carrier.clear:selective-white:white_underbase')!
      expect(clearColor.transparent).toBeGreaterThan(carrierPixels / 2)
      expect(clearColor.copper).toBeGreaterThan(1_000)
      expect(clearWhite.black).toBeGreaterThan(carrierPixels / 2)
      expect(clearWhite.white).toBeGreaterThan(1_000)
      const foilColor = byCarrierKey.get('carrier.foil:marks-only:color')!
      const foilMetal = byCarrierKey.get('carrier.foil:marks-only:metalness')!
      const foilRough = byCarrierKey.get('carrier.foil:marks-only:roughness')!
      const foilBump = byCarrierKey.get('carrier.foil:marks-only:bump')!
      expect(foilColor.transparent).toBeGreaterThan(carrierPixels / 2)
      expect(foilColor.copper).toBeGreaterThan(100)
      expect(foilMetal.black).toBeGreaterThan(carrierPixels / 2)
      expect(foilMetal.white).toBeGreaterThan(100)
      expect(foilRough.white).toBeGreaterThan(carrierPixels / 2)
      expect(foilRough.charcoal).toBeGreaterThan(100)
      expect(foilBump.neutral128).toBeGreaterThan(carrierPixels / 2)
      expect(foilBump.notNeutral128).toBeGreaterThan(100)

      const laviraKeys = [
        'lavira.front:approved:color', 'lavira.front:approved:metalness',
        'lavira.front:approved:roughness', 'lavira.front:approved:bump',
        'lavira.back:approved:color', 'lavira.back:approved:metalness',
        'lavira.back:approved:roughness', 'lavira.back:approved:bump',
      ]
      expect([...lavira1024Result.files.keys()].sort()).toEqual([...laviraKeys].sort())
      const front4096Keys = laviraKeys.filter((key) => key.startsWith('lavira.front:'))
      expect([...lavira4096Result.files.keys()].sort()).toEqual([...front4096Keys].sort())
      const [front1024Stats, front4096Stats, back1024Stats] = await browserPngStats([
        lavira1024Result.files.get('lavira.front:approved:color')!,
        lavira4096Result.files.get('lavira.front:approved:color')!,
        lavira1024Result.files.get('lavira.back:approved:color')!,
      ])
      for (const stats of [front1024Stats, front4096Stats]) {
        expect(stats.opaque).toBeGreaterThan(stats.width * stats.height * 0.98)
        expect(stats.transparent).toBeGreaterThan(0)
        expect(stats.charcoal).toBeGreaterThan(stats.width * stats.height * 0.65)
        expect(stats.copper).toBeGreaterThan(1_000)
        expect(stats.light).toBeGreaterThan(1_000)
        expect(stats.regions.topFrame.copper).toBeGreaterThan(0)
        expect(stats.regions.leftFrame.copper).toBeGreaterThan(0)
        expect(stats.regions.bottomCenter.copper).toBeLessThan(stats.regions.topFrame.copper / 10)
        expect(stats.regions.upperArtwork.light).toBeGreaterThan(100)
      }
      const normalized = (value: number, stats: { width: number; height: number }) => value / (stats.width * stats.height)
      expect(Math.abs(normalized(front1024Stats.copper, front1024Stats)
        - normalized(front4096Stats.copper, front4096Stats))).toBeLessThan(0.003)
      expect(Math.abs(normalized(front1024Stats.light, front1024Stats)
        - normalized(front4096Stats.light, front4096Stats))).toBeLessThan(0.003)
      expect(back1024Stats.opaque).toBeGreaterThan(back1024Stats.width * back1024Stats.height * 0.98)
      expect(back1024Stats.transparent).toBeGreaterThan(0)
      expect(back1024Stats.charcoal).toBeGreaterThan(back1024Stats.width * back1024Stats.height * 0.8)
      expect(back1024Stats.copper).toBeGreaterThan(1_000)
      expect(back1024Stats.copper).toBeLessThan(back1024Stats.width * back1024Stats.height * 0.08)
      expect(back1024Stats.center.slice(0, 3).every((channel) => channel < 55)).toBe(true)

      for (const [result, areaId] of [
        [lavira1024Result, 'lavira.front:approved'],
        [lavira1024Result, 'lavira.back:approved'],
        [lavira4096Result, 'lavira.front:approved'],
      ] as const) {
        const [metal, rough, bump] = await browserPngStats([
          result.files.get(`${areaId}:metalness`)!,
          result.files.get(`${areaId}:roughness`)!,
          result.files.get(`${areaId}:bump`)!,
        ])
        expect(metal.black).toBeGreaterThan(0)
        expect(metal.white).toBeGreaterThan(0)
        expect(rough.light).toBeGreaterThan(0)
        expect(rough.colorBuckets).toBeGreaterThan(1)
        expect(bump.neutral128).toBeGreaterThan(0)
        if (areaId === 'lavira.back:approved') {
          expect(bump.neutral128).toBe(bump.width * bump.height)
          expect(bump.notNeutral128).toBe(0)
        } else {
          expect(bump.notNeutral128).toBeGreaterThan(0)
        }
      }

      const parityReviewDir = path.join(evidenceRoot, 'native-parity-design-review')
      await renderDesignReview({
        blueprintPath: laviraBlueprintPath,
        outputDir: parityReviewDir,
        width: 960,
        height: 720,
        pxPerMm: 5,
        createdAt: '2026-08-28T00:00:00.000Z',
      })
      const [reviewBackStats] = await browserPngStats([
        path.join(parityReviewDir, 'areas/lavira.back-approved.png'),
      ])
      expect(reviewBackStats.center.slice(0, 3).every((channel) => channel < 55)).toBe(true)
      expect(reviewBackStats.copper).toBeGreaterThan(100)
      expect(reviewBackStats.copper).toBeLessThan(reviewBackStats.width * reviewBackStats.height * 0.08)
      expect(Math.abs(normalized(back1024Stats.copper, back1024Stats)
        - normalized(reviewBackStats.copper, reviewBackStats))).toBeLessThan(0.03)
      task12StressExecuted.add('native-1024-4096-carriers')
    } finally {
      await runtime.close()
    }
  }, 600_000)

  it.runIf(task12StressRequested)('Task12 stress case 2 renders approved Lavira and direct-print fixtures through real design and production browsers', async () => {
    requireTask12ExternalFiles()
    const evidenceRoot = await task12PackageRoot()
    const laviraBytes = await readFile(laviraBlueprintPath)
    const carrierSource = JSON.parse(await readFile(carrierBlueprintPath, 'utf8')) as LayoutBlueprintV1
    const directBlueprint: LayoutBlueprintV1 = {
      ...carrierSource,
      revision: 'carrier-direct-print-browser-20260828.v1',
      areas: carrierSource.areas.filter((area) => [
        'carrier.direct:curved', 'carrier.applied:paper',
      ].includes(area.id)),
    }
    const directBytes = Buffer.from(`${JSON.stringify(directBlueprint, null, 2)}\n`)
    const [mockupEvidenceBytes, modelBytes] = await Promise.all([
      readFile(laviraMockupPath),
      readFile(laviraModelPath),
    ])
    expect(hash(mockupEvidenceBytes)).toBe('bde3f32fab1a653f81264189b094c23620eb534cfa255fd6ac7e39543f6eb10f')
    expect(hash(modelBytes)).toBe('5ba164ee005374050e40baafefeec21be5fb632643d594e8723304098bf413f7')

    const lavira = await prepareTask12Package(evidenceRoot, 'lavira', laviraBytes)
    const direct = await prepareTask12Package(evidenceRoot, 'direct-print', directBytes)
    const laviraHtml = await readFile(path.join(lavira.designReviewDir, 'mockup.html'), 'utf8')
    const directHtml = await readFile(path.join(direct.designReviewDir, 'mockup.html'), 'utf8')
    expect(laviraHtml).toContain('余烬森林')
    expect(laviraHtml).toContain('EMBER WOODS')
    expect(laviraHtml).toContain('木质低语，余烬未熄。')
    expect(laviraHtml).toContain('WOODS IN WHISPER. EMBERS REMAIN.')
    expect(laviraHtml).toContain('PLACEHOLDER')
    expect(laviraHtml).not.toContain('烬木之息')
    expect(laviraHtml).not.toMatch(/<script|leaseToken|token=/i)
    expect(directHtml).not.toMatch(/<script|leaseToken|token=/i)

    const frontFacts = await browserHtmlFacts(laviraHtml, 'lavira.front:approved')
    const backFacts = await browserHtmlFacts(laviraHtml, 'lavira.back:approved')
    const directFacts = await browserHtmlFacts(directHtml, 'carrier.direct:curved')
    expect(frontFacts).toMatchObject({ carrier: 'applied_label', panelCount: 1, diagnosticDisplay: 'none' })
    expect(backFacts).toMatchObject({ carrier: 'applied_label', panelCount: 1, diagnosticDisplay: 'none' })
    expect(frontFacts.textFacts['front.product.zh']).toMatchObject({ text: '余烬森林', fontSize: 34 })
    expect(frontFacts.textFacts['front.product.zh'].width).toBeGreaterThan(100)
    expect(frontFacts.textFacts['front.product.zh'].fontSize)
      .toBeGreaterThan(frontFacts.textFacts['front.product.en'].fontSize)
    expect(backFacts.textFacts['back.regulatory:PLACEHOLDER'].text).toContain('PLACEHOLDER')
    expect(backFacts.textFacts['back.regulatory:PLACEHOLDER'].height).toBeGreaterThan(20)
    expect(directFacts).toMatchObject({
      carrier: 'direct_surface_print',
      panelCount: 0,
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderRadius: '0px',
      boxShadow: 'none',
      diagnosticDisplay: 'none',
    })
    for (const fixture of [lavira, direct]) {
      const designManifest = JSON.parse(fixture.designManifestBytes.toString('utf8'))
      expect(designManifest.blueprint).toEqual({
        revision: fixture.blueprint.revision,
        sha256: hash(fixture.blueprintBytes),
      })
      expect(designManifest.references).toEqual([])
      expect(designManifest.artifacts.some((artifact: { carrier?: string }) => artifact.carrier === 'bare')).toBe(false)
      for (const artifact of designManifest.artifacts) {
        const bytes = await readFile(path.join(fixture.designReviewDir, artifact.path))
        expect(hash(bytes), artifact.path).toBe(artifact.sha256)
        if (artifact.mimeType === 'image/png') {
          expect(bytes.subarray(0, 8), artifact.path)
            .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          expect(bytes.readUInt32BE(16), artifact.path).toBe(artifact.width)
          expect(bytes.readUInt32BE(20), artifact.path).toBe(artifact.height)
        }
      }
    }
    expect(lavira.blueprint.carrierDefaults.evidence).toContain(
      'visual_evidence:lavira-ember-woods-20260826/label-mockup.html',
    )
    const laviraDesignManifest = JSON.parse(lavira.designManifestBytes.toString('utf8'))
    expect(laviraDesignManifest.artifacts.find((artifact: { areaId?: string }) => artifact.areaId === 'lavira.front:approved'))
      .toMatchObject({ width: 240, height: 310, carrier: 'applied_label' })
    expect(laviraDesignManifest.artifacts.find((artifact: { areaId?: string }) => artifact.areaId === 'lavira.back:approved'))
      .toMatchObject({ width: 250, height: 330, carrier: 'applied_label' })
    const directDesignManifest = JSON.parse(direct.designManifestBytes.toString('utf8'))
    expect(directDesignManifest.artifacts.find((artifact: { areaId?: string }) => artifact.areaId === 'carrier.direct:curved'))
      .toMatchObject({ width: 200, height: 200, carrier: 'direct_surface_print' })

    const laviraReview = await runTask12Review(lavira)
    const directReview = await runTask12Review(direct)
    for (const [fixture, review] of [[lavira, laviraReview], [direct, directReview]] as const) {
      const manifest = JSON.parse(review.manifestBytes.toString('utf8'))
      expect(review.envelope).toMatchObject({
        ok: true,
        operation: 'render_label_review',
        data: {
          outputDir: path.join(await realpath(fixture.root), 'production-review'),
          revision: revisionOf(fixture.spec),
          modelFingerprint: hash(modelBytes),
        },
      })
      expect(manifest).toMatchObject({
        version: 1,
        input: {
          kind: 'label-project-v3',
          revision: revisionOf(fixture.spec),
          sha256: hash(fixture.inputBytes),
        },
        blueprint: { revision: fixture.blueprint.revision, sha256: hash(fixture.blueprintBytes) },
        designReviewManifest: { sha256: hash(fixture.designManifestBytes) },
        model: { fingerprint: hash(modelBytes) },
        areaTargetsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        areas: fixture.blueprint.areas.map(({ id, side, carrier }) => ({ id, side, carrier })),
      })
      expect(manifest.artifacts).toHaveLength(7)
      expect(manifest.artifacts.map((artifact: { viewKind: string }) => artifact.viewKind)).toEqual([
        'flat-artwork', 'surface-face', 'flat-artwork', 'surface-face',
        'model-front', 'model-back', 'review-sheet',
      ])
      expect(manifest.artifacts.every((artifact: { width: number; height: number }) => (
        artifact.width === 640 && artifact.height === 640
      ))).toBe(true)
      expect(manifest.artifacts.every((artifact: { path: string }) => (
        /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(artifact.path) && !artifact.path.includes(':')
      ))).toBe(true)
      expect(review.manifestBytes.toString('utf8')).not.toMatch(/leaseToken|token=/)
      const expectedFiles = ['review-manifest.json', ...manifest.artifacts.map((artifact: { path: string }) => artifact.path)].sort()
      expect((await readdir(review.outputDir)).sort()).toEqual(expectedFiles)
      for (const artifact of manifest.artifacts) {
        const bytes = await readFile(path.join(review.outputDir, artifact.path))
        expect(bytes.byteLength, artifact.path).toBeGreaterThan(1_000)
        expect(bytes.subarray(0, 8), artifact.path)
          .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        expect(bytes.readUInt32BE(16), artifact.path).toBe(artifact.width)
        expect(bytes.readUInt32BE(20), artifact.path).toBe(artifact.height)
        expect(hash(bytes), artifact.path).toBe(artifact.sha256)
      }
    }

    const laviraPngs = [
      'label-front.png', 'surface-front.png', 'label-back.png', 'surface-back.png',
      'model-front.png', 'model-back.png', 'review-sheet.png',
    ].map((name) => path.join(laviraReview.outputDir, name))
    const laviraStats = await browserPngStats(laviraPngs)
    expect(laviraStats.every((stats) => stats.width === 640 && stats.height === 640)).toBe(true)
    expect(laviraStats.every((stats) => stats.opaque > 0 && stats.colorBuckets > 4)).toBe(true)
    const [laviraDesignBackStats] = await browserPngStats([
      path.join(lavira.designReviewDir, 'areas/lavira.back-approved.png'),
    ])
    const laviraProductionBackStats = laviraStats[2]
    for (const stats of [laviraDesignBackStats, laviraProductionBackStats]) {
      expect(stats.center.slice(0, 3).every((channel) => channel < 55)).toBe(true)
      expect(stats.copper).toBeGreaterThan(100)
      expect(stats.copper).toBeLessThan(stats.width * stats.height * 0.08)
      expect(stats.charcoal).toBeGreaterThan(stats.width * stats.height * 0.55)
    }
    const [directAreaStats, directFlatStats, directSurfaceStats] = await browserPngStats([
      path.join(direct.designReviewDir, 'areas/carrier.direct-curved.png'),
      path.join(directReview.outputDir, 'label-front.png'),
      path.join(directReview.outputDir, 'surface-front.png'),
    ])
    expect(directAreaStats).toMatchObject({ width: 200, height: 200 })
    expect(directAreaStats.colorBuckets).toBeGreaterThan(4)
    expect(new Set(directAreaStats.corners.map((rgba) => JSON.stringify(rgba))).size).toBeGreaterThan(1)
    expect(directFlatStats.colorBuckets).toBeGreaterThan(4)
    expect(directSurfaceStats.colorBuckets).toBeGreaterThan(8)
    expect(directSurfaceStats.center).not.toEqual(directSurfaceStats.corners[0])
    const previousManifest = Buffer.from(laviraReview.manifestBytes)
    const conflictStdout: string[] = []
    const conflictCode = await runCli([
      'review', lavira.inputPath,
      '--glb', laviraModelPath,
      '--output', laviraReview.outputDir,
      '--json',
    ], {
      runtimeOptions: { allowedRoots: [process.cwd(), path.dirname(laviraModelPath), lavira.root] },
      stdout: (value: string) => conflictStdout.push(value),
      stderr: () => undefined,
    })
    expect(conflictCode).toBe(9)
    expect(JSON.parse(conflictStdout[0])).toMatchObject({ ok: false, error: { code: 'OUTPUT_CONFLICT' } })
    expect(await readFile(path.join(laviraReview.outputDir, 'review-manifest.json'))).toEqual(previousManifest)
    task12StressExecuted.add('design-production-review')
  }, 300_000)

  it.runIf(task12StressRequested)('Task12 stress proof records both required stress cases', () => {
    requireTask12ExternalFiles()
    expect([...task12StressExecuted]).toEqual([
      'native-1024-4096-carriers',
      'design-production-review',
    ])
  })

  it.runIf(runRealE2E)('captures a gate-bound clean review through the packaged browser bridge', async () => {
    const requestedEvidenceDir = process.env.GLB_LABEL_TASK9_EVIDENCE_DIR
    const evidenceDir = requestedEvidenceDir
      ? path.resolve(requestedEvidenceDir)
      : await mkdtemp(path.join(tmpdir(), 'glb-label-task9-review-'))
    await mkdir(evidenceDir, { recursive: true })
    let droppedSealResponse = false
    const runtime = await createPluginRuntime({
      allowedRoots: [process.cwd(), path.dirname(modelPath), evidenceDir],
      fetcher: async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(input, init)
        if (!droppedSealResponse && String(input).includes('/confirm?')) {
          droppedSealResponse = true
          await response.arrayBuffer()
          throw new Error('injected lost seal response')
        }
        return response
      },
    })
    try {
      const session = await runtime.createSession({ glbPath: modelPath })
      const loaded = await runtime.callBridge(session, 'loadModel', {
        name: session.modelName, url: session.inputUrl,
      })
      expect(loaded).toMatchObject({ ok: true, operation: 'load_model' })
      const fixture = reviewEvidenceFixture()
      const applied = await runtime.callBridge(session, 'applySpec', { spec: fixture.spec, assetUrls: {} })
      expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true, operation: 'apply_label_spec' })
      expect(await runtime.callBridge(session, 'waitForReady', { timeoutMs: 60_000 }))
        .toMatchObject({ ok: true, operation: 'wait_for_ready' })

      const rendered = await runtime.callBridge(session, 'renderReviewEvidence', fixture.request)
      expect(rendered, JSON.stringify(rendered)).toMatchObject({
        ok: true, operation: 'render_review_evidence',
        data: {
          inputKind: 'label-project-v3', blueprintRevision: 'task9-browser-review-v1',
          validation: { ready: true }, fidelity: { pass: true },
          views: [
            { id: 'label-front' }, { id: 'surface-front' },
            { id: 'model-front' }, { id: 'model-back' }, { id: 'review-sheet' },
          ],
        },
      })
      if (!rendered.ok) throw new Error(rendered.error.message)
      await expect(runtime.confirmReviewEvidence(session.id, rendered.data.confirmation)).resolves.toMatchObject({
        ok: true, sealed: true, resultIds: rendered.data.views.map((entry: { id: string }) => entry.id),
      })
      expect(droppedSealResponse).toBe(true)
      const stored = runtime.getArtifacts(session.id)
      expect(stored.map((artifact: { id: string }) => artifact.id)).toEqual(
        rendered.data.views.map((entry: { artifact: { id: string } }) => entry.artifact.id),
      )
      const receipts = new Map(rendered.data.confirmation.artifacts.map((artifact: { resultId: string }) => [artifact.resultId, artifact]))
      for (const view of rendered.data.views) {
        const artifact = await runtime.readReviewArtifact(session.id, view, receipts.get(view.id))
        const bytes = Buffer.from(artifact.bytes)
        expect(bytes.subarray(0, 8), artifact.id)
          .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        expect(hash(bytes), artifact.id).toBe(artifact.sha256)
        await writeFile(path.join(evidenceDir, `${artifact.id}.png`), bytes)
      }
      await writeFile(path.join(evidenceDir, 'review-evidence.json'), `${JSON.stringify({
        ...rendered.data,
        confirmation: { ...rendered.data.confirmation, leaseToken: '[redacted]' },
      }, null, 2)}\n`)
      expect(runtime.browserErrors(session.id)).toEqual([])
    } finally {
      await runtime.close()
    }
  }, 180_000)

  it.runIf(runRealE2E)('publishes a realistic 1600 square review through the additive CLI and returns conflict exit 9', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-task10-review-'))
    const fixture = reviewEvidenceFixture()
    const inputPath = path.join(root, 'working.json')
    const outputDir = path.join(root, 'review-rev-001')
    const resolvedOutputDir = path.join(await realpath(root), 'review-rev-001')
    const inputBytes = `${JSON.stringify(fixture.spec)}\n`
    await writeFile(inputPath, inputBytes)
    await writeFile(path.join(root, 'editor-handoff.json'), `${JSON.stringify(fixture.request.designGate.handoff)}\n`)
    await writeFile(path.join(root, 'layout-blueprint.json'), fixture.request.designGate.blueprintJson)
    await writeFile(path.join(root, 'design-review-manifest.json'), fixture.request.designGate.designReviewManifestJson)
    const runtimeOptions = { allowedRoots: [process.cwd(), path.dirname(modelPath), root] }
    const stdout: string[] = []
    const stderr: string[] = []

    const code = await runCli([
      'review', inputPath, '--glb', modelPath, '--output', outputDir,
      '--width', '1600', '--height', '1600', '--json',
    ], {
      runtimeOptions,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    })
    expect(code, [...stderr, ...stdout].join('\n')).toBe(0)
    expect(stdout).toHaveLength(1)
    const envelope = JSON.parse(stdout[0])
    expect(envelope).toMatchObject({
      ok: true, operation: 'render_label_review',
      data: { outputDir: resolvedOutputDir, manifestPath: path.join(resolvedOutputDir, 'review-manifest.json') },
    })
    expect(stdout[0]).not.toMatch(/leaseToken|token=/)

    const manifestBytes = await readFile(path.join(outputDir, 'review-manifest.json'))
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    expect(manifest).toMatchObject({
      version: 1,
      input: { kind: 'label-spec-v2', revision: revisionOf(fixture.spec), sha256: hash(new TextEncoder().encode(inputBytes)) },
      blueprint: { revision: 'task9-browser-review-v1' },
      artifacts: [
        { id: 'label-front', path: 'label-front.png', width: 1600, height: 1600 },
        { id: 'surface-front', path: 'surface-front.png', width: 1600, height: 1600 },
        { id: 'model-front', path: 'model-front.png', width: 1600, height: 1600 },
        { id: 'model-back', path: 'model-back.png', width: 1600, height: 1600 },
        { id: 'review-sheet', path: 'review-sheet.png', width: 1600, height: 1600 },
      ],
    })
    expect((await readdir(outputDir)).sort()).toEqual([
      'label-front.png', 'model-back.png', 'model-front.png', 'review-manifest.json',
      'review-sheet.png', 'surface-front.png',
    ])
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(path.join(outputDir, artifact.path))
      expect(bytes.subarray(0, 8), artifact.path).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(bytes.readUInt32BE(16), artifact.path).toBe(artifact.width)
      expect(bytes.readUInt32BE(20), artifact.path).toBe(artifact.height)
      expect(hash(bytes), artifact.path).toBe(artifact.sha256)
    }

    const conflictStdout: string[] = []
    const conflictCode = await runCli([
      'review', inputPath, '--glb', modelPath, '--output', outputDir, '--json',
    ], {
      runtimeOptions,
      stdout: (value: string) => conflictStdout.push(value),
      stderr: () => undefined,
    })
    expect(conflictCode).toBe(9)
    expect(JSON.parse(conflictStdout[0])).toMatchObject({ ok: false, error: { code: 'OUTPUT_CONFLICT' } })
  }, 180_000)

  it.runIf(runRealE2E)('applies a front/back design and atomically publishes verified artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-e2e-'))
    const output = path.join(root, 'result')
    const workingSpec = path.join(root, 'working-spec.json')
    const patchDocument = path.join(root, 'copy-patch.json')
    const stdout: string[] = []
    const inputHash = hash(await readFile(modelPath))
    const originalSpec = JSON.parse(await readFile('tests/fixtures/specs/perfume-front-back-v2.json', 'utf8'))
    await writeFile(workingSpec, JSON.stringify(originalSpec, null, 2))
    const projectStdout: string[] = []
    expect(await runCli(['project', workingSpec, '--json'], {
      runtimeOptions: { allowedRoots: [root] },
      stdout: (value: string) => projectStdout.push(value),
      stderr: () => undefined,
    })).toBe(0)
    const inspected = JSON.parse(projectStdout[0])
    expect(inspected.data.revision).toBe(revisionOf(originalSpec))
    await writeFile(patchDocument, JSON.stringify({
      version: 1,
      baseRevision: inspected.data.revision,
      operations: [{ op: 'update-layer', areaId: 'front', layerId: 'brand', changes: { text: 'LOCAL AGENT API' } }],
    }))
    const patchStdout: string[] = []
    expect(await runCli([
      'patch', workingSpec, '--operations', patchDocument, '--output', workingSpec, '--force', '--json',
    ], {
      runtimeOptions: { allowedRoots: [root] },
      stdout: (value: string) => patchStdout.push(value),
      stderr: () => undefined,
    })).toBe(0)
    expect(JSON.parse(patchStdout[0])).toMatchObject({
      ok: true,
      operation: 'patch_label_spec',
      data: { appliedOperationCount: 1 },
    })
    expect(JSON.parse(await readFile(workingSpec, 'utf8')).areas[0].layers[0].text).toBe('LOCAL AGENT API')
    const argv = [
      'apply', workingSpec,
      '--glb', modelPath, '--output', output, '--json',
    ]
    const dependencies = {
      runtimeOptions: { allowedRoots: [process.cwd(), path.dirname(modelPath), root] },
      stdout: (value: string) => stdout.push(value),
      stderr: () => undefined,
    }

    expect(existsSync(output)).toBe(false)
    const code = await runCli(argv, dependencies)
    expect(code, stdout[0]).toBe(0)
    expect(stdout).toHaveLength(1)
    for (const file of [
      'labeled.glb', 'project.lbl.json', 'label-spec.normalized.json',
      'print-manifest.json', 'preview-3d.png', 'manifest.json',
      'areas/front/color.png', 'areas/front/metalness.png', 'areas/front/roughness.png', 'areas/front/bump.png',
      'areas/back/color.png', 'areas/back/metalness.png', 'areas/back/roughness.png', 'areas/back/bump.png',
    ]) {
      expect((await stat(path.join(output, file))).size, file).toBeGreaterThan(0)
    }
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'))
    expect(manifest.glbCrossCheck).toMatchObject({ loaded: true, uvSampleOk: true })
    for (const artifact of manifest.artifacts) {
      expect(hash(await readFile(path.join(output, artifact.path))), artifact.path).toBe(artifact.sha256)
    }
    expect(hash(await readFile(modelPath))).toBe(inputHash)
    const embedded = glbJson(await readFile(path.join(output, 'labeled.glb')))
      .extras?.glbLabelEditorProject
    expect(embedded).toMatchObject({ version: 3, areas: [{ id: 'front' }, { id: 'back' }] })
    const normalized = JSON.parse(await readFile(path.join(output, 'label-spec.normalized.json'), 'utf8'))
    expect(normalized.areas[0].layers[0].text).toBe('LOCAL AGENT API')

    const conflictOutput: string[] = []
    const conflictCode = await runCli(argv, { ...dependencies, stdout: (value: string) => conflictOutput.push(value) })
    expect(conflictCode).toBe(9)
    expect(JSON.parse(conflictOutput[0]).error.code).toBe('OUTPUT_CONFLICT')

    const forcedOutput: string[] = []
    const forceCode = await runCli([...argv.slice(0, -1), '--force', '--json'], {
      ...dependencies,
      stdout: (value: string) => forcedOutput.push(value),
    })
    expect(forceCode, forcedOutput[0]).toBe(0)

    const invalidSpec = path.join(root, 'invalid.json')
    const invalidOutput = path.join(root, 'invalid-result')
    await writeFile(invalidSpec, JSON.stringify({ version: 2, areas: [] }))
    const invalidCode = await runCli([
      'apply', invalidSpec, '--glb', modelPath, '--output', invalidOutput, '--json',
    ], dependencies)
    expect(invalidCode).toBe(4)
    expect(existsSync(invalidOutput)).toBe(false)

    const projectOutput = path.join(root, 'project-export')
    const exportStdout: string[] = []
    const projectCode = await runCli([
      'export', path.join(output, 'project.lbl.json'), '--glb', modelPath,
      '--output', projectOutput, '--json',
    ], { ...dependencies, stdout: (value: string) => exportStdout.push(value) })
    expect(projectCode, exportStdout[0]).toBe(0)
    expect((await stat(path.join(projectOutput, 'labeled.glb'))).size).toBeGreaterThan(0)

    const previewOutput = path.join(root, 'agent-preview.png')
    const previewStdout: string[] = []
    const previewCode = await runCli([
      'preview', workingSpec, '--glb', modelPath,
      '--output', previewOutput, '--view', '3d', '--json',
    ], { ...dependencies, stdout: (value: string) => previewStdout.push(value) })
    expect(previewCode, previewStdout[0]).toBe(0)
    expect((await readFile(previewOutput)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect((await readdir(root)).some((name) => name.endsWith('.artifacts'))).toBe(false)

    const qcOutput = path.join(root, 'label-qc', 'round-0')
    await mkdir(path.dirname(qcOutput))
    const qcStdout: string[] = []
    const qcCode = await runCli([
      'qc', workingSpec, '--glb', modelPath,
      '--output', qcOutput, '--preset', 'qc-standard', '--json',
    ], { ...dependencies, stdout: (value: string) => qcStdout.push(value) })
    expect(qcCode, qcStdout[0]).toBe(0)
    expect(qcStdout).toHaveLength(1)
    const publishedQcOutput = path.join(await realpath(root), 'label-qc', 'round-0')
    expect(JSON.parse(qcStdout[0])).toMatchObject({
      ok: true,
      operation: 'render_label_qc',
      data: { outputDir: publishedQcOutput, manifestPath: path.join(publishedQcOutput, 'qc-manifest.json') },
    })
    const currentSpec = JSON.parse(await readFile(workingSpec, 'utf8'))
    const qcManifest = JSON.parse(await readFile(path.join(qcOutput, 'qc-manifest.json'), 'utf8'))
    expect(qcManifest.input.revision).toBe(revisionOf(currentSpec))
    expect(qcManifest.artifacts.filter((item: { channel: string }) => item.channel === 'color').length).toBeGreaterThanOrEqual(10)
    expect(qcManifest.artifacts.filter((item: { areaId?: string }) => item.areaId === undefined).map((item: { viewId: string }) => item.viewId)).toEqual([
      'model-front', 'model-back', 'model-left', 'model-right',
      'model-front-right', 'model-back-left',
    ])
    expect(qcManifest.artifacts.filter((item: { channel: string }) => item.channel !== 'color')
      .every((item: { view: { kind: string }; reason: string }) => item.view.kind === 'area-face' && item.reason.length > 0)).toBe(true)
    expect(qcManifest.artifacts.filter((item: { channel: string; view: { kind: string } }) => item.channel === 'color' && item.view.kind === 'area-craft')).toHaveLength(2)
    for (const area of qcManifest.areas) {
      expect(area.artifactIds).toEqual(qcManifest.artifacts
        .filter((artifact: { areaId?: string }) => artifact.areaId === area.id)
        .map((artifact: { id: string }) => artifact.id))
    }
    for (const artifact of qcManifest.artifacts) {
      const png = await readFile(path.join(qcOutput, artifact.path))
      expect(png.subarray(0, 8), artifact.path).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(hash(png), artifact.path).toBe(artifact.sha256)
    }
    expect((await readdir(path.dirname(qcOutput))).some((name) => name.startsWith('.round-0.'))).toBe(false)
    for (const forbidden of ['labeled.glb', 'project.lbl.json', 'label-spec.normalized.json', 'print-manifest.json', 'preview-3d.png', 'manifest.json']) {
      expect(existsSync(path.join(qcOutput, forbidden)), forbidden).toBe(false)
    }

    const runtime = await createPluginRuntime(dependencies.runtimeOptions)
    try {
      const opened = await createOperations(runtime).open({
        inputPath: workingSpec,
        glbPath: modelPath,
      })
      expect(opened.ok).toBe(true)
      if (!opened.ok) throw new Error(opened.error.message)
      const editorUrl = new URL(opened.data.url)
      expect(editorUrl.hostname).toBe('127.0.0.1')
      expect(editorUrl.searchParams.get('session')).toBe(opened.sessionId)
      expect(runtime.browserErrors(opened.sessionId)).toEqual([])
      expect((await fetch(editorUrl)).status).toBe(200)
    } finally {
      await runtime.close()
    }
  }, 180_000)

  it.runIf(runLiveE2E)('automatically opens one headful read-only preview and applies an in-place patch revision', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-live-e2e-'))
    const workingSpec = path.join(root, 'working-spec.json')
    const operationsPath = path.join(root, 'operations.json')
    const spec = JSON.parse(await readFile('tests/fixtures/specs/perfume-front-back-v2.json', 'utf8'))
    await writeFile(workingSpec, JSON.stringify(spec, null, 2))
    const progress: string[] = []
    const runtime = await createPluginRuntime({
      allowedRoots: [process.cwd(), path.dirname(modelPath), root],
      headless: false,
      browserQuery: { 'agent-preview': '1' },
    })
    try {
      const operations = createOperations(runtime, { progress: (message: string) => progress.push(message) })
      const live = await operations.live({ specPath: workingSpec, glbPath: modelPath })
      expect(live.ok).toBe(true)
      if (!live.ok) throw new Error(live.error.message)
      const previewUrl = new URL(live.data.previewUrl)
      expect(previewUrl.searchParams.get('agent-preview')).toBe('1')
      expect(previewUrl.searchParams.get('token')).toBeTruthy()
      expect(live.data.keepAlive).toBe(true)

      await writeFile(operationsPath, JSON.stringify({
        version: 1,
        baseRevision: live.data.revision,
        operations: [{ op: 'update-layer', areaId: 'front', layerId: 'brand', changes: { text: 'LIVE LOCAL API' } }],
      }))
      const patched = await createOperations(undefined, { allowedRoots: [root] }).patch({
        inputPath: workingSpec,
        operationsPath,
        outputPath: workingSpec,
        force: true,
      })
      expect(patched.ok).toBe(true)
      if (!patched.ok) throw new Error(patched.error.message)

      const deadline = Date.now() + 20_000
      while (!progress.some((message) => message.includes(patched.data.revision)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(progress).toContain(`live revision ${patched.data.revision}`)
      expect(runtime.browserErrors(live.sessionId)).toEqual([])
    } finally {
      await runtime.close()
    }
  }, 60_000)
})
