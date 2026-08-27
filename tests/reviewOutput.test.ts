import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pngBytes } from './pngTestUtils'
// @ts-expect-error Pure Node ESM module is consumed directly by the CLI.
import { buildReviewManifest, reviewArtifactRelativePath, validateReviewDirectory, validateReviewManifest } from '../scripts/lib/review-output.mjs'

const temporaryDirectories: string[] = []
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function fixture(kind: 'label-spec-v2' | 'label-project-v3' = 'label-spec-v2'): any {
  const bytes = pngBytes(64, 48)
  const digest = sha256(bytes)
  const camera = {
    position: [0, 0, 3], direction: [0, 0, -1], target: [0, 0, 0], up: [0, 1, 0], fov: 45,
  }
  const views = [
    { id: 'label-front', kind: 'flat-artwork', areaId: 'front', carrier: 'direct_surface_print', artifact: { id: 'label-front' } },
    { id: 'surface-front', kind: 'surface-face', areaId: 'front', carrier: 'direct_surface_print', artifact: { id: 'surface-front' }, camera },
    { id: 'model-front', kind: 'model-front', artifact: { id: 'model-front' }, camera },
    { id: 'model-back', kind: 'model-back', artifact: { id: 'model-back' }, camera },
    { id: 'review-sheet', kind: 'review-sheet', artifact: { id: 'review-sheet' } },
  ]
  const artifacts = views.map((view, index) => ({
    id: view.id,
    internalId: `private-${index}`,
    resultId: view.id,
    fileName: `${view.id}.png`,
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    sha256: digest,
    width: 64,
    height: 48,
    bytes: new Uint8Array(bytes),
  }))
  const input = { kind, revision: `sha256:${'1'.repeat(64)}`, sha256: '1'.repeat(64) }
  const areas = [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }]
  const evidence = {
    inputKind: 'label-project-v3', inputRevision: `sha256:${'9'.repeat(64)}`, inputSha256: '9'.repeat(64),
    blueprintRevision: 'design-v1', blueprintSha256: '2'.repeat(64),
    designReviewManifestSha256: '3'.repeat(64), modelFingerprint: `sha256:${'4'.repeat(64)}`,
    areaTargetsSha256: '5'.repeat(64), views,
  }
  const manifest = buildReviewManifest({
    createdAt: '2026-08-27T12:34:56.000Z', input, areas, evidence, artifacts,
  })
  return { manifest, input, areas, evidence, artifacts, bytes }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('production review manifest', () => {
  it.each(['label-spec-v2', 'label-project-v3'] as const)('builds and independently validates a complete %s manifest', (kind) => {
    const value = fixture(kind)
    expect(validateReviewManifest(value.manifest, value)).toEqual(value.manifest)
    expect(value.manifest).toMatchObject({
      version: 1,
      input: { kind, revision: value.input.revision, sha256: value.input.sha256 },
      blueprint: { revision: 'design-v1', sha256: '2'.repeat(64) },
      designReviewManifest: { sha256: '3'.repeat(64) },
      model: { fingerprint: `sha256:${'4'.repeat(64)}` },
      areaTargetsSha256: '5'.repeat(64),
      artifacts: [
        { id: 'label-front', path: 'label-front.png', viewKind: 'flat-artwork', areaId: 'front' },
        { id: 'surface-front', path: 'surface-front.png', viewKind: 'surface-face', areaId: 'front' },
        { id: 'model-front', path: 'model-front.png', viewKind: 'model-front' },
        { id: 'model-back', path: 'model-back.png', viewKind: 'model-back' },
        { id: 'review-sheet', path: 'review-sheet.png', viewKind: 'review-sheet' },
      ],
    })
  })

  it('derives convenience names only for unique sides and collision-resistant names for opaque duplicate/custom ids', () => {
    const areas = [
      { id: '唯一正面', side: 'front', carrier: 'direct_surface_print' },
      { id: '唯一背面', side: 'back', carrier: 'direct_surface_print' },
      { id: 'Front', side: 'custom', carrier: 'clear_label' },
      { id: 'front', side: 'custom', carrier: 'clear_label' },
    ]
    expect(reviewArtifactRelativePath({ id: 'a', kind: 'flat-artwork', areaId: '唯一正面' }, areas)).toBe('label-front.png')
    expect(reviewArtifactRelativePath({ id: 'back', kind: 'flat-artwork', areaId: '唯一背面' }, areas)).toBe('label-back.png')
    const first = reviewArtifactRelativePath({ id: 'b', kind: 'flat-artwork', areaId: 'Front' }, areas)
    const second = reviewArtifactRelativePath({ id: 'c', kind: 'flat-artwork', areaId: 'front' }, areas)
    expect(first).toMatch(/^label-area-[a-f0-9]{16}\.png$/)
    expect(second).toMatch(/^label-area-[a-f0-9]{16}\.png$/)
    expect(first).not.toBe(second)
  })

  it.each([
    ['createdAt', (value: any) => { value.manifest.createdAt = '2026-08-27' }],
    ['input digest', (value: any) => { value.manifest.input.sha256 = '0'.repeat(64) }],
    ['blueprint revision', (value: any) => { value.manifest.blueprint.revision = 'other' }],
    ['design review digest', (value: any) => { value.manifest.designReviewManifest.sha256 = '0'.repeat(64) }],
    ['model fingerprint', (value: any) => { value.manifest.model.fingerprint = `sha256:${'0'.repeat(64)}` }],
    ['area target digest', (value: any) => { value.manifest.areaTargetsSha256 = '0'.repeat(64) }],
    ['duplicate area', (value: any) => { value.manifest.areas.push(structuredClone(value.manifest.areas[0])) }],
    ['wrong carrier', (value: any) => { value.manifest.areas[0].carrier = 'clear_label' }],
    ['missing artifact', (value: any) => { value.manifest.artifacts.pop() }],
    ['duplicate artifact id', (value: any) => { value.manifest.artifacts[1].id = value.manifest.artifacts[0].id }],
    ['case-fold path collision', (value: any) => { value.manifest.artifacts[1].path = 'LABEL-FRONT.PNG' }],
    ['unsafe path', (value: any) => { value.manifest.artifacts[0].path = '../label-front.png' }],
    ['reserved path', (value: any) => { value.manifest.artifacts[0].path = 'CON.png' }],
    ['wrong hash', (value: any) => { value.manifest.artifacts[0].sha256 = '0'.repeat(64) }],
    ['wrong dimensions', (value: any) => { value.manifest.artifacts[0].width = 1 }],
    ['wrong view', (value: any) => { value.manifest.artifacts[0].viewKind = 'model-front' }],
    ['wrong area', (value: any) => { value.manifest.artifacts[0].areaId = 'other' }],
    ['camera on flat artwork', (value: any) => { value.manifest.artifacts[0].camera = value.manifest.artifacts[1].camera }],
    ['missing surface camera', (value: any) => { delete value.manifest.artifacts[1].camera }],
  ])('rejects a %s mismatch', (_label, mutate) => {
    const value = fixture()
    mutate(value)
    expect(() => validateReviewManifest(value.manifest, value)).toThrow()
  })

  it('parses exact PNG bytes and rejects compressed dimension bombs before decode', () => {
    const value = fixture()
    value.artifacts[0].bytes = pngBytes(4097, 4097)
    value.artifacts[0].byteLength = value.artifacts[0].bytes.byteLength
    value.artifacts[0].sha256 = sha256(value.artifacts[0].bytes)
    value.manifest.artifacts[0].sha256 = value.artifacts[0].sha256
    value.manifest.artifacts[0].width = 4097
    value.manifest.artifacts[0].height = 4097
    expect(() => validateReviewManifest(value.manifest, value)).toThrow(/PNG|dimension|pixel/i)
  })

  it('reads back exactly the published manifest and planned PNG bytes with no extra files or symlinks', async () => {
    const value = fixture()
    const output = await mkdtemp(path.join(tmpdir(), 'review-output-'))
    temporaryDirectories.push(output)
    for (const artifact of value.manifest.artifacts) {
      const stored = value.artifacts.find((candidate: any) => candidate.id === artifact.id)!
      await writeFile(path.join(output, artifact.path), stored.bytes)
    }
    await writeFile(path.join(output, 'review-manifest.json'), `${JSON.stringify(value.manifest, null, 2)}\n`)

    expect(await validateReviewDirectory(output, value)).toEqual(value.manifest)
    expect((await readdir(output)).sort()).toEqual([
      'label-front.png', 'model-back.png', 'model-front.png', 'review-manifest.json',
      'review-sheet.png', 'surface-front.png',
    ])
    expect(JSON.parse(await readFile(path.join(output, 'review-manifest.json'), 'utf8'))).toEqual(value.manifest)

    await writeFile(path.join(output, 'unexpected.png'), value.bytes)
    await expect(validateReviewDirectory(output, value)).rejects.toThrow(/unexpected|exact/i)
  })

  it('rejects a symlink even when it has an exact planned filename', async () => {
    const value = fixture()
    const root = await mkdtemp(path.join(tmpdir(), 'review-output-symlink-'))
    temporaryDirectories.push(root)
    const output = path.join(root, 'output')
    const external = path.join(root, 'external.png')
    await writeFile(external, value.bytes)
    await mkdir(output)
    for (const artifact of value.manifest.artifacts) {
      const stored = value.artifacts.find((candidate: any) => candidate.id === artifact.id)!
      if (artifact.id === 'label-front') await symlink(external, path.join(output, artifact.path))
      else await writeFile(path.join(output, artifact.path), stored.bytes)
    }
    await writeFile(path.join(output, 'review-manifest.json'), `${JSON.stringify(value.manifest, null, 2)}\n`)
    await expect(validateReviewDirectory(output, value)).rejects.toThrow(/non-file|regular file|symlink/i)
  })
})
