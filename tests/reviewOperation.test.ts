import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { createOperations } from '../scripts/lib/operations.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { publishAtomically } from '../scripts/lib/files.mjs'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { revisionOf } from '../scripts/lib/project-control.mjs'
import { pngBytes } from './pngTestUtils'

const temporaryDirectories: string[] = []
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

function project() {
  return {
    version: 3, modelFileName: 'bottle.glb',
    areas: [{
      id: 'front', name: 'Front', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', side: 'front',
      carrier: 'direct_surface_print',
      remap: { mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] } },
      range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 }, canvas: { width: 64, height: 48, aspect: 4 / 3 },
      paper: { enabled: false, color: '#ffffff', opacity: 0 }, layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
    }],
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'review-operation-'))
  temporaryDirectories.push(root)
  const inputPath = path.join(root, 'working.lbl.json')
  const glbPath = path.join(root, 'bottle.glb')
  const handoffPath = path.join(root, 'editor-handoff.json')
  const blueprintPath = path.join(root, 'layout-blueprint.json')
  const designManifestPath = path.join(root, 'design-review-manifest.json')
  const outputDir = path.join(root, 'review')
  const document = project()
  const blueprint = `${JSON.stringify({ version: 1, revision: 'design-v1' })}\n`
  const designManifest = `${JSON.stringify({ version: 1, blueprint: { revision: 'design-v1' } })}\n`
  const handoff = {
    handoff_version: 2, status: 'approved',
    source: { blueprint: 'layout-blueprint.json', design_review_manifest: 'design-review-manifest.json' },
  }
  await writeFile(inputPath, `${JSON.stringify(document)}\n`)
  await writeFile(glbPath, 'glb-original')
  await writeFile(handoffPath, `${JSON.stringify(handoff)}\n`)
  await writeFile(blueprintPath, blueprint)
  await writeFile(designManifestPath, designManifest)
  return { root, inputPath, glbPath, handoffPath, blueprintPath, designManifestPath, outputDir, document, blueprint, designManifest }
}

function harness(input: Awaited<ReturnType<typeof fixture>>, options: {
  mutationBoundary?: 'capture' | 'seal' | 'readback' | 'stage' | 'pre-rename'
  mutatePath?: string
  sealError?: boolean
  sessionSetupAba?: boolean
} = {}) {
  const bytes = pngBytes(64, 48)
  const digest = sha256(bytes)
  const camera = { position: [0, 0, 3], direction: [0, 0, -1], target: [0, 0, 0], up: [0, 1, 0], fov: 45 }
  const plans = [
    { id: 'label-front', kind: 'flat-artwork', areaId: 'front', carrier: 'direct_surface_print' },
    { id: 'surface-front', kind: 'surface-face', areaId: 'front', carrier: 'direct_surface_print', camera },
    { id: 'model-front', kind: 'model-front', camera },
    { id: 'model-back', kind: 'model-back', camera },
    { id: 'review-sheet', kind: 'review-sheet' },
  ]
  const receipts = plans.map((view, index) => ({
    id: `private-${index}`, resultId: view.id, sha256: digest, byteLength: bytes.byteLength,
    mimeType: 'image/png', width: 64, height: 48,
  }))
  const views = plans.map((view, index) => ({
    ...view,
    artifact: {
      id: view.id, url: `http://local/private-${index}`, fileName: `${view.id}.png`,
      sha256: digest, byteLength: bytes.byteLength, mimeType: 'image/png', width: 64, height: 48,
    },
  }))
  const mutations: string[] = []
  const mutate = async (boundary: string) => {
    if (options.mutationBoundary !== boundary) return
    mutations.push(boundary)
    await writeFile(options.mutatePath ?? input.inputPath, `${boundary}-mutated`)
  }
  let reads = 0
  let sessions = 0
  const sessionInputs: any[] = []
  const calls: string[] = []
  const runtime = {
    allowedRoots: [input.root],
    async createSession(sessionInput: any) {
      sessions += 1
      sessionInputs.push(sessionInput)
      if (options.sessionSetupAba) {
        await writeFile(input.glbPath, 'glb-mutated')
        await writeFile(input.glbPath, 'glb-original')
      }
      return { id: 'review-session', modelName: 'bottle.glb', inputUrl: 'http://local/model' }
    },
    async callBridge(_session: unknown, method: string) {
      calls.push(method)
      if (method === 'loadModel') return { ok: true, data: { name: 'bottle.glb', fingerprint: `sha256:${'4'.repeat(64)}`, meshes: [], warnings: [] }, warnings: [] }
      if (method === 'applyProject') return { ok: true, data: { areaIds: ['front'] }, warnings: [] }
      if (method === 'waitForReady') return { ok: true, data: { ready: true }, warnings: [] }
      if (method === 'renderReviewEvidence') {
        await mutate('capture')
        return { ok: true, data: {
          inputKind: 'label-project-v3', inputRevision: revisionOf(input.document), inputSha256: sha256(JSON.stringify(input.document)),
          blueprintRevision: 'design-v1', blueprintSha256: sha256(input.blueprint),
          designReviewManifestSha256: sha256(input.designManifest), modelFingerprint: `sha256:${'4'.repeat(64)}`,
          areaTargetsSha256: '5'.repeat(64), views,
          confirmation: { sessionId: 'review-session', batchId: 'batch-1', leaseToken: 'secret-token', generation: 1, expiresAt: Date.now() + 60_000, artifacts: receipts },
          validation: { ready: true, issues: [] }, fidelity: { pass: true, issues: [] },
        }, warnings: [] }
      }
      throw new Error(`Unexpected bridge method: ${method}`)
    },
    browserErrors: () => [],
    async confirmReviewEvidence() {
      await mutate('seal')
      if (options.sealError) { const error: any = new Error('expired provisional batch'); error.code = 'BROWSER_NOT_READY'; throw error }
      return { ok: true }
    },
    async readReviewArtifact(_sessionId: string, view: any, receipt: any) {
      if (reads++ === 0) await mutate('readback')
      return { ...receipt, id: receipt.resultId, internalId: receipt.id, fileName: view.artifact.fileName, bytes: new Uint8Array(bytes) }
    },
    async publishArtifacts(sessionId: string, outputDir: string, artifacts: any[], force: boolean, publicationOptions: any) {
      await mutate('stage')
      const beforeCommit = publicationOptions.beforeCommit
      await publishAtomically(outputDir, artifacts, {
        ...publicationOptions, force, sessionId,
        beforeCommit: async (directory: string) => { await mutate('pre-rename'); await beforeCommit(directory) },
      })
      return outputDir
    },
    addAsset() { throw new Error('No local assets') },
  }
  return { runtime, calls, mutations, sessionInputs, get sessions() { return sessions } }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('label review operation', () => {
  it('seals, independently reads, validates, and atomically publishes exact bytes without bearer secrets', async () => {
    const input = await fixture()
    const test = harness(input)
    const result = await createOperations(test.runtime).review({
      inputPath: input.inputPath, glbPath: input.glbPath, outputDir: input.outputDir, width: 64, height: 48,
    })

    expect(result.ok).toBe(true)
    expect(test.sessionInputs).toHaveLength(1)
    expect(test.sessionInputs[0]).not.toHaveProperty('glbPath')
    expect(test.sessionInputs[0]).toMatchObject({ modelName: 'bottle.glb' })
    expect(Buffer.from(test.sessionInputs[0].glbBytes).toString('utf8')).toBe('glb-original')
    expect(test.calls).toEqual(['loadModel', 'applyProject', 'waitForReady', 'renderReviewEvidence'])
    expect(await readdir(input.outputDir)).toEqual(expect.arrayContaining([
      'label-front.png', 'surface-front.png', 'model-front.png', 'model-back.png', 'review-sheet.png', 'review-manifest.json',
    ]))
    const manifestText = await readFile(path.join(input.outputDir, 'review-manifest.json'), 'utf8')
    expect(manifestText).not.toContain('secret-token')
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(JSON.parse(manifestText)).toMatchObject({
      input: { kind: 'label-project-v3', revision: revisionOf(input.document), sha256: sha256(`${JSON.stringify(input.document)}\n`) },
      model: { fingerprint: `sha256:${'4'.repeat(64)}` }, areaTargetsSha256: '5'.repeat(64),
    })
  })

  it('detects an A-to-B-to-A model mutation during session setup while rendering only the initial bytes', async () => {
    const input = await fixture()
    const test = harness(input, { sessionSetupAba: true })
    const result = await createOperations(test.runtime).review({
      inputPath: input.inputPath, glbPath: input.glbPath, outputDir: input.outputDir,
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'STALE_APPROVAL' } })
    expect(Buffer.from(test.sessionInputs[0].glbBytes).toString('utf8')).toBe('glb-original')
    expect(test.sessionInputs[0]).not.toHaveProperty('glbPath')
    await expect(readdir(input.outputDir)).rejects.toThrow()
  })

  it('rejects an existing output before opening a browser session', async () => {
    const input = await fixture()
    await publishAtomically(input.outputDir, [{ fileName: 'old.txt', bytes: new TextEncoder().encode('old') }])
    const test = harness(input)
    const result = await createOperations(test.runtime).review({ inputPath: input.inputPath, glbPath: input.glbPath, outputDir: input.outputDir })
    expect(result).toMatchObject({ ok: false, error: { code: 'OUTPUT_CONFLICT' } })
    expect(test.sessions).toBe(0)
    expect(await readFile(path.join(input.outputDir, 'old.txt'), 'utf8')).toBe('old')
  })

  it('replaces a prior complete output only after the forced review validates', async () => {
    const input = await fixture()
    await publishAtomically(input.outputDir, [{ fileName: 'old.txt', bytes: new TextEncoder().encode('old') }])
    const test = harness(input)
    const result = await createOperations(test.runtime).review({
      inputPath: input.inputPath, glbPath: input.glbPath, outputDir: input.outputDir,
      width: 64, height: 48, force: true,
    })
    expect(result.ok).toBe(true)
    await expect(readFile(path.join(input.outputDir, 'old.txt'))).rejects.toThrow()
    expect(await readdir(input.outputDir)).toContain('review-manifest.json')
  })

  it('fails closed with APPROVAL_REQUIRED when adjacent Handoff v2 evidence is absent', async () => {
    const input = await fixture()
    await rm(input.handoffPath)
    const test = harness(input)
    const result = await createOperations(test.runtime).review({
      inputPath: input.inputPath, glbPath: input.glbPath, outputDir: input.outputDir,
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'APPROVAL_REQUIRED' } })
    expect(test.sessions).toBe(0)
  })

  it.each(['input', 'protected ancestor'] as const)('rejects unsafe %s output aliasing before a browser session', async (kind) => {
    const input = await fixture()
    const test = harness(input)
    const outputDir = kind === 'input' ? input.inputPath : input.root
    const result = await createOperations(test.runtime).review({
      inputPath: input.inputPath, glbPath: input.glbPath, outputDir, force: true,
    })
    expect(result).toMatchObject({
      ok: false,
      error: { code: kind === 'input' ? 'INVALID_USAGE' : 'PATH_NOT_ALLOWED' },
    })
    expect(test.sessions).toBe(0)
  })

  it('fails closed on an expired/provisional seal and publishes nothing', async () => {
    const input = await fixture()
    const test = harness(input, { sealError: true })
    const result = await createOperations(test.runtime).review({ inputPath: input.inputPath, glbPath: input.glbPath, outputDir: input.outputDir })
    expect(result).toMatchObject({ ok: false, error: { code: 'BROWSER_NOT_READY' } })
    await expect(readdir(input.outputDir)).rejects.toThrow()
  })

  it.each([
    ['capture', 'input'], ['seal', 'blueprint'], ['readback', 'model'], ['stage', 'design manifest'], ['pre-rename', 'input'],
  ] as const)('detects %s-boundary mutation of %s and preserves a forced prior output', async (boundary, source) => {
    const input = await fixture()
    const mutatePath = source === 'input' ? input.inputPath
      : source === 'blueprint' ? input.blueprintPath
        : source === 'model' ? input.glbPath : input.designManifestPath
    await publishAtomically(input.outputDir, [{ fileName: 'old.txt', bytes: new TextEncoder().encode('old') }])
    const test = harness(input, { mutationBoundary: boundary, mutatePath })
    const result = await createOperations(test.runtime).review({
      inputPath: input.inputPath, glbPath: input.glbPath, outputDir: input.outputDir, force: true,
    })
    expect(result.ok).toBe(false)
    expect(await readFile(path.join(input.outputDir, 'old.txt'), 'utf8')).toBe('old')
    expect(await readdir(input.root)).not.toContain(expect.stringMatching(/^\.review\./))
  })
})
