import path from 'node:path'
import { sanitizeArtifactName } from './files.mjs'
import { revisionOf } from './project-control.mjs'

const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/
const HEX_PATTERN = /^[a-f0-9]{64}$/
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const CHANNELS = new Set(['color', 'metalness', 'roughness', 'bump'])
const POSE_KINDS = new Set(['direction', 'area-face', 'area-craft'])
const FRAMINGS = new Set(['fit-model', 'fit-area'])
const UNSAFE_CONTENT = /(?:\b(?:https?|file):\/\/|\bbearer\s+)/i

export class QcOutputError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'QcOutputError'
    this.code = code
    if (details) this.details = details
  }
}

function invalid(message, details) {
  return new QcOutputError('INVALID_USAGE', message, details)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw invalid(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid(`${label} has unexpected or missing fields`)
  }
}

function assertSafeString(value, label) {
  if (typeof value !== 'string' || !value || UNSAFE_CONTENT.test(value)) throw invalid(`Unsafe ${label}`)
  return value
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw invalid(`Invalid ${label} SHA-256`)
  return value
}

function assertArtifactDigest(value, label) {
  if (typeof value !== 'string' || (!DIGEST_PATTERN.test(value) && !HEX_PATTERN.test(value))) {
    throw invalid(`Invalid ${label} SHA-256`)
  }
  return value
}

function assertFinitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw invalid(`Invalid ${label}`)
  return value
}

function assertVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => !Number.isFinite(part))) {
    throw invalid(`Invalid ${label}`)
  }
  return [...value]
}

function assertPngBytes(value, byteLength) {
  if (!(value instanceof Uint8Array) || value.byteLength !== byteLength) throw invalid('Stored artifact bytes do not match its descriptor')
  if (value.byteLength < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, index) => value[index] !== byte)) {
    throw invalid('Stored artifact is not a PNG')
  }
}

function assertSafeFileName(value) {
  assertSafeString(value, 'artifact filename')
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) {
    throw invalid('Artifact filename must be a safe relative path')
  }
}

function assertSafeRelativePath(value) {
  assertSafeString(value, 'artifact path')
  if (path.posix.isAbsolute(value) || value.includes('\\') || value.split('/').some((segment) => !segment || segment === '..')) {
    throw invalid('Artifact path must be a safe relative path')
  }
}

function assertUnique(items, key, label) {
  const ids = new Set()
  for (const item of items) {
    const id = item?.[key]
    if (typeof id !== 'string' || !id) throw invalid(`${label} is missing ${key}`)
    if (ids.has(id)) throw invalid(`Duplicate ${label} ${key}: ${id}`)
    ids.add(id)
  }
  return ids
}

function artifactMetadata(artifact, label) {
  if (!isRecord(artifact)) throw invalid(`${label} must be an artifact descriptor`)
  const { id, fileName, mimeType, byteLength, sha256, width, height, areaId, channel } = artifact
  assertSafeString(id, `${label} id`)
  assertSafeFileName(fileName)
  if (mimeType !== 'image/png') throw invalid(`${label} must be a PNG`)
  if (!Number.isInteger(byteLength) || byteLength < PNG_SIGNATURE.length) throw invalid(`Invalid ${label} byte length`)
  assertArtifactDigest(sha256, label)
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw invalid(`Invalid ${label} dimensions`)
  }
  if (areaId !== undefined) assertSafeString(areaId, `${label} area id`)
  if (!CHANNELS.has(channel)) throw invalid(`Invalid ${label} channel`)
  return { id, fileName, mimeType, byteLength, sha256, width, height, ...(areaId === undefined ? {} : { areaId }), channel }
}

function matchingArtifact(left, right) {
  return left.id === right.id
    && left.fileName === right.fileName
    && left.mimeType === right.mimeType
    && left.byteLength === right.byteLength
    && left.sha256 === right.sha256
    && left.width === right.width
    && left.height === right.height
    && left.areaId === right.areaId
    && left.channel === right.channel
}

function manifestCamera(camera) {
  if (!isRecord(camera)) throw invalid('QC camera metadata must be an object')
  assertExactKeys(camera, ['position', 'direction', 'target', 'up', 'fov'], 'QC camera metadata')
  return {
    position: assertVector(camera.position, 'camera position'),
    direction: assertVector(camera.direction, 'camera direction'),
    target: assertVector(camera.target, 'camera target'),
    up: assertVector(camera.up, 'camera up'),
    fov: assertFinitePositive(camera.fov, 'camera FOV'),
  }
}

function manifestView(view) {
  if (!isRecord(view) || !isRecord(view.target) || !isRecord(view.pose)) throw invalid('QC view must be an object')
  assertSafeString(view.id, 'QC view id')
  if (!FRAMINGS.has(view.framing) || !CHANNELS.has(view.channel) || !POSE_KINDS.has(view.pose.kind)) {
    throw invalid(`Invalid QC view: ${view.id}`)
  }
  if (!Number.isInteger(view.width) || view.width < 1 || !Number.isInteger(view.height) || view.height < 1) {
    throw invalid(`Invalid QC view dimensions: ${view.id}`)
  }
  const isModel = view.target.kind === 'model' && Object.keys(view.target).length === 1
  const isArea = view.target.kind === 'area' && Object.keys(view.target).length === 2 && typeof view.target.areaId === 'string'
  if (!isModel && !isArea) throw invalid(`Invalid QC view target: ${view.id}`)
  if (isArea) assertSafeString(view.target.areaId, `QC view ${view.id} area id`)
  if (view.areaId !== undefined) assertSafeString(view.areaId, `QC view ${view.id} area id`)
  if ((isArea ? view.target.areaId : undefined) !== view.areaId) throw invalid(`QC view target does not match area: ${view.id}`)
  if ((isModel && view.framing !== 'fit-model') || (isArea && view.framing !== 'fit-area')) throw invalid(`QC view framing does not match target: ${view.id}`)
  if (view.pose.kind === 'direction') assertVector(view.pose.direction, `QC view ${view.id} direction`)
  if (view.pose.kind !== 'direction' && Object.keys(view.pose).length !== 1) throw invalid(`Invalid QC view pose: ${view.id}`)
  return {
    id: view.id,
    kind: view.pose.kind,
    framing: view.framing,
    target: isModel ? 'model' : view.target.areaId,
    channel: view.channel,
    width: view.width,
    height: view.height,
    ...(view.areaId === undefined ? {} : { areaId: view.areaId }),
  }
}

function assertNoUnsafeContent(value, label = 'manifest') {
  if (typeof value === 'string') {
    assertSafeString(value, label)
  } else if (Array.isArray(value)) {
    value.forEach((entry) => assertNoUnsafeContent(entry, label))
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      assertSafeString(key, 'manifest key')
      assertNoUnsafeContent(entry, `${label}.${key}`)
    })
  }
}

function validationSnapshot(value) {
  if (!isRecord(value) || typeof value.ready !== 'boolean' || !Array.isArray(value.issues)) throw invalid('Invalid QC validation result')
  const snapshot = structuredClone(value)
  assertNoUnsafeContent(snapshot, 'validation')
  return snapshot
}

function projectRevision(project) {
  if (!isRecord(project) || !isRecord(project.value)) throw invalid('QC project inspection is missing its source value')
  assertSafeString(project.kind, 'project kind')
  assertDigest(project.revision, 'project revision')
  if (revisionOf(project.value) !== project.revision) throw invalid('QC project revision is not canonical')
  return project.revision
}

function modelSnapshot(inspection) {
  if (!isRecord(inspection) || !Array.isArray(inspection.meshes) || !isRecord(inspection.dimensions)) throw invalid('Invalid model inspection')
  assertSafeString(inspection.name, 'model filename')
  assertDigest(inspection.fingerprint, 'model fingerprint')
  const dimensions = {
    width: assertFinitePositive(inspection.dimensions.width, 'model width'),
    height: assertFinitePositive(inspection.dimensions.height, 'model height'),
    depth: assertFinitePositive(inspection.dimensions.depth, 'model depth'),
  }
  const meshes = new Map()
  for (const mesh of inspection.meshes) {
    if (!isRecord(mesh) || !Number.isInteger(mesh.meshIndex) || mesh.meshIndex < 0) throw invalid('Invalid model mesh inspection')
    assertSafeString(mesh.stableSelector, 'mesh stable selector')
    assertSafeString(mesh.nodeName, 'mesh node name')
    if (meshes.has(mesh.meshIndex)) throw invalid(`Duplicate model mesh index: ${mesh.meshIndex}`)
    meshes.set(mesh.meshIndex, mesh)
  }
  return { fileName: inspection.name, fingerprint: inspection.fingerprint, dimensions, meshes }
}

export function qcArtifactRelativePath(view) {
  const request = view?.view
  if (!isRecord(request)) throw invalid('QC artifact view is missing')
  assertSafeString(request.id, 'QC view id')
  if (request.areaId !== undefined) assertSafeString(request.areaId, 'QC area id')
  const file = `${sanitizeArtifactName(request.id)}.png`
  const relativePath = request.areaId
    ? `areas/${sanitizeArtifactName(request.areaId)}/${file}`
    : `model/${file}`
  assertSafeRelativePath(relativePath)
  return relativePath
}

export function parseQcCameraConfig(value) {
  assertExactKeys(value, ['version', 'views'], 'QC camera config')
  if (value.version !== 1 || !Array.isArray(value.views) || value.views.length > 32) {
    throw invalid('QC camera config must have version 1 and at most 32 views')
  }
  return value.views
}

export function buildQcManifest({ createdAt, project, inspection, evidence, artifacts }) {
  assertSafeString(createdAt, 'QC manifest timestamp')
  if (Number.isNaN(Date.parse(createdAt))) throw invalid('Invalid QC manifest timestamp')
  const revision = projectRevision(project)
  const model = modelSnapshot(inspection)
  if (!isRecord(evidence) || evidence.preset !== 'qc-standard' || !Array.isArray(evidence.views) || !Array.isArray(evidence.areas)) {
    throw invalid('Invalid QC evidence result')
  }
  if (!Array.isArray(artifacts)) throw invalid('QC session artifacts must be an array')
  assertUnique(evidence.views.map((entry) => entry?.artifact), 'id', 'QC evidence artifact')
  assertUnique(evidence.views.map((entry) => entry?.view), 'id', 'QC evidence view')
  assertUnique(artifacts, 'id', 'stored QC artifact')

  const storedById = new Map()
  for (const stored of artifacts) {
    const metadata = artifactMetadata(stored, 'stored QC artifact')
    assertPngBytes(stored.bytes, metadata.byteLength)
    storedById.set(metadata.id, metadata)
  }

  const manifestArtifacts = evidence.views.map((entry) => {
    if (!isRecord(entry)) throw invalid('Invalid QC evidence view')
    const descriptor = artifactMetadata(entry.artifact, 'QC evidence artifact')
    const stored = storedById.get(descriptor.id)
    if (!stored) throw invalid(`Missing stored QC artifact: ${descriptor.id}`)
    if (!matchingArtifact(descriptor, stored)) throw invalid(`Stored QC artifact differs from browser evidence: ${descriptor.id}`)
    const capturedView = manifestView(entry.view)
    if (descriptor.width !== capturedView.width || descriptor.height !== capturedView.height || descriptor.channel !== capturedView.channel || descriptor.areaId !== capturedView.areaId) {
      throw invalid(`QC artifact metadata does not match capture view: ${descriptor.id}`)
    }
    return {
      id: descriptor.id,
      path: qcArtifactRelativePath(entry),
      sha256: descriptor.sha256,
      mimeType: descriptor.mimeType,
      byteLength: descriptor.byteLength,
      width: descriptor.width,
      height: descriptor.height,
      view: { kind: capturedView.kind, framing: capturedView.framing, target: capturedView.target },
      channel: descriptor.channel,
      camera: manifestCamera(entry.camera),
      ...(descriptor.areaId === undefined ? {} : { areaId: descriptor.areaId }),
    }
  })
  assertUnique(manifestArtifacts.map((artifact) => ({ id: artifact.path })), 'id', 'QC artifact path')
  if (storedById.size !== manifestArtifacts.length) throw invalid('Unexpected stored QC artifact')

  const projectAreas = Array.isArray(project.areas) ? project.areas : []
  assertUnique(projectAreas, 'id', 'project area')
  assertUnique(evidence.areas, 'areaId', 'QC evidence area')
  if (projectAreas.length !== evidence.areas.length) throw invalid('QC evidence does not cover every project area')
  const artifactByViewId = new Map(evidence.views.map((entry) => [entry.view.id, entry.artifact.id]))
  const manifestAreas = evidence.areas.map((area) => {
    if (!isRecord(area)) throw invalid('Invalid QC evidence area')
    const projectArea = projectAreas.find((candidate) => candidate.id === area.areaId)
    if (!projectArea) throw invalid(`QC evidence references an unexpected area: ${area.areaId}`)
    if (!Number.isInteger(area.meshIndex) || !model.meshes.has(area.meshIndex)) throw invalid(`QC area mesh is not resolved: ${area.areaId}`)
    assertSafeString(area.nodeName, 'QC area node name')
    if (area.side !== 'front' && area.side !== 'back') throw invalid(`Invalid QC area side: ${area.areaId}`)
    if (area.surfaceMode !== 'overlay' && area.surfaceMode !== 'replace') throw invalid(`Invalid QC area surface mode: ${area.areaId}`)
    if (!Array.isArray(area.viewIds)) throw invalid(`Invalid QC area view ids: ${area.areaId}`)
    assertUnique(area.viewIds.map((id) => ({ id })), 'id', 'QC area view')
    const areaViews = evidence.views.filter((entry) => entry.view.areaId === area.areaId)
    if (areaViews.length !== area.viewIds.length || areaViews.some((entry) => !area.viewIds.includes(entry.view.id))) {
      throw invalid(`QC area view ids do not match captured evidence: ${area.areaId}`)
    }
    const hasFace = areaViews.some((entry) => entry.view.pose.kind === 'area-face' && entry.view.channel === 'color')
    const hasCraft = areaViews.some((entry) => entry.view.pose.kind === 'area-craft' && entry.view.channel === 'color')
    if (!hasFace || !hasCraft) throw invalid(`QC area is missing face or craft color evidence: ${area.areaId}`)
    const mesh = model.meshes.get(area.meshIndex)
    return {
      id: area.areaId,
      meshIndex: area.meshIndex,
      stableSelector: mesh.stableSelector,
      nodeName: area.nodeName,
      side: area.side,
      surfaceMode: area.surfaceMode,
      artifactIds: area.viewIds.map((id) => artifactByViewId.get(id)),
    }
  })

  const digest = revision.slice('sha256:'.length)
  const manifest = {
    version: 1,
    createdAt,
    preset: evidence.preset,
    input: { kind: project.kind, revision, sha256: digest },
    model: { fileName: model.fileName, fingerprint: model.fingerprint, dimensions: model.dimensions },
    validation: validationSnapshot(evidence.validation),
    areas: manifestAreas,
    artifacts: manifestArtifacts,
  }
  return validateQcManifest(manifest)
}

export function validateQcManifest(value) {
  assertExactKeys(value, ['version', 'createdAt', 'preset', 'input', 'model', 'validation', 'areas', 'artifacts'], 'QC manifest')
  if (value.version !== 1 || value.preset !== 'qc-standard') throw invalid('Unsupported QC manifest version or preset')
  assertSafeString(value.createdAt, 'QC manifest timestamp')
  if (Number.isNaN(Date.parse(value.createdAt))) throw invalid('Invalid QC manifest timestamp')
  assertExactKeys(value.input, ['kind', 'revision', 'sha256'], 'QC manifest input')
  assertSafeString(value.input.kind, 'QC manifest input kind')
  assertDigest(value.input.revision, 'QC manifest input revision')
  if (typeof value.input.sha256 !== 'string' || !HEX_PATTERN.test(value.input.sha256)
    || value.input.revision !== `sha256:${value.input.sha256}`) throw invalid('QC manifest input revision is stale or malformed')
  assertExactKeys(value.model, ['fileName', 'fingerprint', 'dimensions'], 'QC manifest model')
  assertSafeString(value.model.fileName, 'QC manifest model filename')
  assertDigest(value.model.fingerprint, 'QC manifest model fingerprint')
  assertExactKeys(value.model.dimensions, ['width', 'height', 'depth'], 'QC manifest model dimensions')
  for (const dimension of ['width', 'height', 'depth']) assertFinitePositive(value.model.dimensions[dimension], `QC manifest model ${dimension}`)
  validationSnapshot(value.validation)
  if (!Array.isArray(value.areas) || !Array.isArray(value.artifacts)) throw invalid('QC manifest areas and artifacts must be arrays')
  assertUnique(value.areas, 'id', 'QC manifest area')
  assertUnique(value.artifacts, 'id', 'QC manifest artifact')
  assertUnique(value.artifacts.map((artifact) => ({ id: artifact.path })), 'id', 'QC manifest artifact path')
  const artifactIds = new Set(value.artifacts.map((artifact) => artifact.id))
  for (const artifact of value.artifacts) {
    assertExactKeys(artifact, ['id', 'path', 'sha256', 'mimeType', 'byteLength', 'width', 'height', 'view', 'channel', 'camera', ...(artifact.areaId === undefined ? [] : ['areaId'])], 'QC manifest artifact')
    assertSafeString(artifact.id, 'QC manifest artifact id')
    assertSafeRelativePath(artifact.path)
    assertArtifactDigest(artifact.sha256, 'QC manifest artifact')
    if (artifact.mimeType !== 'image/png' || !Number.isInteger(artifact.byteLength) || artifact.byteLength < PNG_SIGNATURE.length
      || !Number.isInteger(artifact.width) || artifact.width < 1 || !Number.isInteger(artifact.height) || artifact.height < 1
      || !CHANNELS.has(artifact.channel)) throw invalid(`Invalid QC manifest artifact: ${artifact.id}`)
    assertExactKeys(artifact.view, ['kind', 'framing', 'target'], 'QC manifest artifact view')
    if (!POSE_KINDS.has(artifact.view.kind) || !FRAMINGS.has(artifact.view.framing)) throw invalid(`Invalid QC manifest artifact view: ${artifact.id}`)
    assertSafeString(artifact.view.target, 'QC manifest artifact target')
    if (artifact.areaId !== undefined) assertSafeString(artifact.areaId, 'QC manifest artifact area id')
    manifestCamera(artifact.camera)
  }
  for (const area of value.areas) {
    assertExactKeys(area, ['id', 'meshIndex', 'stableSelector', 'nodeName', 'side', 'surfaceMode', 'artifactIds'], 'QC manifest area')
    assertSafeString(area.id, 'QC manifest area id')
    if (!Number.isInteger(area.meshIndex) || area.meshIndex < 0) throw invalid(`Invalid QC manifest area mesh: ${area.id}`)
    assertSafeString(area.stableSelector, 'QC manifest area selector')
    assertSafeString(area.nodeName, 'QC manifest area node name')
    if ((area.side !== 'front' && area.side !== 'back') || (area.surfaceMode !== 'overlay' && area.surfaceMode !== 'replace') || !Array.isArray(area.artifactIds)) {
      throw invalid(`Invalid QC manifest area: ${area.id}`)
    }
    assertUnique(area.artifactIds.map((id) => ({ id })), 'id', 'QC manifest area artifact')
    if (area.artifactIds.some((id) => !artifactIds.has(id))) throw invalid(`QC manifest area references missing artifact: ${area.id}`)
    const areaArtifacts = value.artifacts.filter((artifact) => artifact.areaId === area.id)
    const hasFace = areaArtifacts.some((artifact) => artifact.view.kind === 'area-face' && artifact.channel === 'color')
    const hasCraft = areaArtifacts.some((artifact) => artifact.view.kind === 'area-craft' && artifact.channel === 'color')
    if (!hasFace || !hasCraft) throw invalid(`QC manifest area is missing face or craft color evidence: ${area.id}`)
  }
  assertNoUnsafeContent(value)
  return value
}
