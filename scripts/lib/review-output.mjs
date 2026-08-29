import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import reviewManifestSchema from '../../src/agent/review-manifest-v1.schema.json' with { type: 'json' }
import {
  isStrictRfc3339DateTime,
  productionReviewIdentity,
  productionReviewPlan,
  validateManifestSemantics,
} from './design-manifest-core.mjs'
import { areaArtifactToken } from '../../src/agent/areaArtifactToken.mjs'
import { parsePortablePng } from './png-core.mjs'

const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_DIMENSION = 4_096
const MAX_PIXELS = 16 * 1024 * 1024
const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addFormat('date-time', { type: 'string', validate: isStrictRfc3339DateTime })
const validateSchema = ajv.compile(reviewManifestSchema)

export class ReviewOutputError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ReviewOutputError'
    this.code = code
    if (details) this.details = details
  }
}

function fail(message, details) {
  throw new ReviewOutputError('INVALID_REVIEW_OUTPUT', message, details)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertEqual(actual, expected, label) {
  if (!equalJson(actual, expected)) fail(`${label} does not match sealed review evidence`)
}

function normalizedCollisionKey(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('en-US')
}

function assertUnique(values, label, normalize = (value) => value) {
  const seen = new Set()
  for (const value of values) {
    const key = normalize(value)
    if (seen.has(key)) fail(`Duplicate ${label}: ${value}`)
    seen.add(key)
  }
}

function assertSafeArtifactPath(value) {
  const stem = typeof value === 'string' ? value.replace(/\.png$/i, '') : ''
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048
    || path.posix.basename(value) !== value || path.win32.basename(value) !== value
    || value === '.' || value === '..' || value.includes('%') || value.includes('\0')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(value)) {
    fail(`Unsafe review artifact path: ${String(value)}`)
  }
}

function sideIsUnique(area, areas) {
  return area.side !== 'custom' && areas.filter((candidate) => candidate.side === area.side).length === 1
}

export function reviewArtifactRelativePath(view, areas) {
  if (view.kind === 'model-front') return 'model-front.png'
  if (view.kind === 'model-back') return 'model-back.png'
  if (view.kind === 'review-sheet') return 'review-sheet.png'
  if (!['flat-artwork', 'surface-face'].includes(view.kind)) fail(`Unsupported review view kind: ${String(view.kind)}`)
  const area = areas.find((candidate) => candidate.id === view.areaId)
  if (!area) fail(`Review view references unknown area: ${String(view.areaId)}`)
  const prefix = view.kind === 'flat-artwork' ? 'label' : 'surface'
  if (sideIsUnique(area, areas)) return `${prefix}-${area.side}.png`
  return `${prefix}-${areaArtifactToken(area.id)}.png`
}

function artifactFromView(view, sealed, areas) {
  return {
    id: view.id,
    path: reviewArtifactRelativePath(view, areas),
    sha256: sealed.sha256,
    mimeType: sealed.mimeType,
    width: sealed.width,
    height: sealed.height,
    viewKind: view.kind,
    ...(view.camera ? { camera: structuredClone(view.camera) } : {}),
    ...(view.areaId !== undefined ? { areaId: view.areaId } : {}),
    ...(view.carrier !== undefined ? { carrier: view.carrier } : {}),
  }
}

export function buildReviewManifest({ createdAt, input, resolvedProject, areas, evidence, artifacts }) {
  const sealedByResult = new Map(artifacts.map((artifact) => [artifact.resultId ?? artifact.id, artifact]))
  const manifestArtifacts = evidence.views.map((view) => {
    const sealed = sealedByResult.get(view.id)
    if (!sealed) fail(`Missing sealed bytes for review view: ${view.id}`)
    return artifactFromView(view, sealed, areas)
  })
  return {
    version: 1,
    createdAt,
    input: structuredClone(input),
    resolvedProject: structuredClone(resolvedProject),
    blueprint: { revision: evidence.blueprintRevision, sha256: evidence.blueprintSha256 },
    designReviewManifest: { sha256: evidence.designReviewManifestSha256 },
    model: { fingerprint: evidence.modelFingerprint },
    areaTargetsSha256: evidence.areaTargetsSha256,
    areas: structuredClone(areas),
    artifacts: manifestArtifacts,
  }
}

export function validateReviewManifest(manifest, context) {
  if (!validateSchema(manifest)) {
    const issues = (validateSchema.errors ?? []).map((issue) => `${issue.instancePath || '/'} ${issue.message}`).join('; ')
    fail(`Review manifest schema validation failed: ${issues}`)
  }
  try {
    validateManifestSemantics(manifest, 'production')
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  assertEqual(manifest.input, context.input, 'Input binding')
  assertEqual({
    kind: context.evidence.inputKind,
    revision: context.evidence.inputRevision,
    sha256: context.evidence.inputSha256,
  }, context.input, 'Captured input binding')
  assertEqual(manifest.resolvedProject, context.resolvedProject, 'Resolved Project binding')
  if (!(context.resolvedProjectBytes instanceof Uint8Array)
    || context.resolvedProjectBytes.byteLength < 1
    || context.resolvedProjectBytes.byteLength > 16 * 1024 * 1024
    || sha256(context.resolvedProjectBytes) !== manifest.resolvedProject.sha256) {
    fail('Resolved Project bytes do not match the manifest binding')
  }
  assertEqual(manifest.blueprint, {
    revision: context.evidence.blueprintRevision,
    sha256: context.evidence.blueprintSha256,
  }, 'Blueprint binding')
  assertEqual(manifest.designReviewManifest, {
    sha256: context.evidence.designReviewManifestSha256,
  }, 'Design-review binding')
  assertEqual(manifest.model, { fingerprint: context.evidence.modelFingerprint }, 'Model binding')
  assertEqual(manifest.areaTargetsSha256, context.evidence.areaTargetsSha256, 'Area-target digest')
  assertEqual(manifest.areas, context.areas, 'Area bindings')
  assertUnique(manifest.areas.map((area) => area.id), 'area id', normalizedCollisionKey)
  assertUnique(manifest.artifacts.map((artifact) => artifact.id), 'artifact id', normalizedCollisionKey)
  assertUnique(manifest.artifacts.map((artifact) => artifact.path), 'artifact path', normalizedCollisionKey)
  for (const artifact of manifest.artifacts) assertSafeArtifactPath(artifact.path)

  const evidenceViews = context.evidence.views
  const planned = productionReviewPlan(context.areas).map(productionReviewIdentity).sort()
  const actualViews = evidenceViews.map(productionReviewIdentity).sort()
  if (!equalJson(actualViews, planned)) fail('Review evidence is not exactly complete for the current areas')
  assertUnique(evidenceViews.map((view) => view.id), 'review view id', normalizedCollisionKey)

  const viewsById = new Map(evidenceViews.map((view) => [view.id, view]))
  const sealedByResult = new Map(context.artifacts.map((artifact) => [artifact.resultId ?? artifact.id, artifact]))
  if (sealedByResult.size !== manifest.artifacts.length || context.artifacts.length !== manifest.artifacts.length) {
    fail('Sealed artifact set is not exactly complete')
  }
  for (const artifact of manifest.artifacts) {
    const view = viewsById.get(artifact.id)
    const sealed = sealedByResult.get(artifact.id)
    if (!view || !sealed) fail(`Missing review evidence for artifact: ${artifact.id}`)
    if (!(sealed.bytes instanceof Uint8Array) || sealed.bytes.byteLength !== sealed.byteLength
      || sealed.byteLength > MAX_PNG_BYTES || sha256(sealed.bytes) !== sealed.sha256) {
      fail(`Sealed artifact bytes do not match receipt: ${artifact.id}`)
    }
    parsePortablePng(sealed.bytes, {
      expectedWidth: artifact.width,
      expectedHeight: artifact.height,
      maxWidth: MAX_DIMENSION,
      maxHeight: MAX_DIMENSION,
      maxPixels: MAX_PIXELS,
    })
    assertEqual(artifact, artifactFromView(view, sealed, context.areas), `Artifact ${artifact.id}`)
  }
  return manifest
}

export async function validateReviewDirectory(outputDirectory, context) {
  const rootInfo = await lstat(outputDirectory)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('Review output root must be a direct regular directory, not a symlink')
  }
  const root = await realpath(outputDirectory)
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`Review output contains an unexpected non-file: ${entry.name}`)
  }
  const manifestPath = path.join(root, 'review-manifest.json')
  const manifestInfo = await lstat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) fail('Review manifest must be a regular file')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    fail(`Review manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const expectedFiles = ['review-manifest.json', manifest.resolvedProject.path, ...manifest.artifacts.map((artifact) => artifact.path)].sort()
  const actualFiles = entries.map((entry) => entry.name).sort()
  if (!equalJson(actualFiles, expectedFiles)) fail('Review directory does not contain the exact planned files')
  const resolvedProjectPath = path.join(root, manifest.resolvedProject.path)
  const resolvedProjectInfo = await lstat(resolvedProjectPath)
  if (!resolvedProjectInfo.isFile() || resolvedProjectInfo.isSymbolicLink()
    || resolvedProjectInfo.size < 1 || resolvedProjectInfo.size > 16 * 1024 * 1024
    || await realpath(resolvedProjectPath) !== resolvedProjectPath) {
    fail('Published resolved Project is not a bounded direct regular file')
  }
  const resolvedProjectBytes = new Uint8Array(await readFile(resolvedProjectPath))
  const sourceById = new Map(context.artifacts.map((artifact) => [artifact.resultId ?? artifact.id, artifact]))
  const artifacts = await Promise.all(manifest.artifacts.map(async (artifact) => {
    const source = sourceById.get(artifact.id)
    if (!source) fail(`Missing sealed descriptor for published artifact: ${artifact.id}`)
    const filePath = path.join(root, artifact.path)
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || await realpath(filePath) !== filePath) {
      fail(`Published artifact is not a direct regular file: ${artifact.path}`)
    }
    const bytes = new Uint8Array(await readFile(filePath))
    return { ...source, bytes, byteLength: bytes.byteLength, sha256: sha256(bytes) }
  }))
  return validateReviewManifest(manifest, { ...context, resolvedProjectBytes, artifacts })
}
