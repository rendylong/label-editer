import path from 'node:path'
import { sanitizeArtifactName } from './files.mjs'
import { inspectProject } from './project-control.mjs'
import { areaArtifactToken, deriveAreaArtifactTokens } from '../../src/agent/areaArtifactToken.mjs'

const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/
const HEX_PATTERN = /^[a-f0-9]{64}$/
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const CHANNELS = new Set(['color', 'metalness', 'roughness', 'bump'])
const DIAGNOSTIC_CHANNELS = ['metalness', 'roughness', 'bump']
const POSE_KINDS = new Set(['direction', 'area-face', 'area-craft'])
const FRAMINGS = new Set(['fit-model', 'fit-area'])
const UNSAFE_CONTENT = /(?:\b(?:https?|file):\/\/|\bbearer\s+)/i
const ASCII_PUBLICATION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const QC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const STANDARD_MODEL_VIEW_IDS = [
  'model-front', 'model-back', 'model-left', 'model-right',
  'model-front-right', 'model-back-left',
]
const STANDARD_AREA_VIEW_SUFFIXES = ['face', 'craft', 'metalness', 'roughness', 'bump']

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
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\')
    || value.includes('%') || value.split('/').some((segment) => segment === '..' || segment.normalize('NFKC') !== segment)) {
    throw invalid('Artifact filename must be a safe relative path')
  }
}

function assertSafeRelativePath(value) {
  assertSafeString(value, 'artifact path')
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value.includes('%')
    || value.split('/').some((segment) => !segment || segment === '..' || segment.normalize('NFKC') !== segment
      || !ASCII_PUBLICATION_SEGMENT.test(segment))) {
    throw invalid('Artifact path must be a safe relative path')
  }
}

function publicationPathKey(value) {
  assertSafeRelativePath(value)
  return value.normalize('NFKC').toLowerCase()
}

function assertOpaqueAreaId(value, label = 'QC area id') {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${label} must be a non-empty string`)
  return value
}

export function qcAreaToken(areaId) {
  assertOpaqueAreaId(areaId)
  return areaArtifactToken(areaId)
}

function deriveQcAreaTokens(areaIds) {
  try {
    return deriveAreaArtifactTokens(areaIds)
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'Invalid QC area token batch')
  }
}

function standardAreaViewId(areaToken, suffix) {
  return `area-${areaToken}-${suffix}`
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
  if (areaId !== undefined) assertOpaqueAreaId(areaId, `${label} area id`)
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
  if (typeof view.id !== 'string' || !QC_ID_PATTERN.test(view.id)) throw invalid('Invalid QC view id')
  assertSafeString(view.reason, `QC view ${view.id} reason`)
  if (!FRAMINGS.has(view.framing) || !CHANNELS.has(view.channel) || !POSE_KINDS.has(view.pose.kind)) {
    throw invalid(`Invalid QC view: ${view.id}`)
  }
  if (!Number.isInteger(view.width) || view.width < 1 || !Number.isInteger(view.height) || view.height < 1) {
    throw invalid(`Invalid QC view dimensions: ${view.id}`)
  }
  const isModel = view.target.kind === 'model' && Object.keys(view.target).length === 1
  const isArea = view.target.kind === 'area' && Object.keys(view.target).length === 2 && typeof view.target.areaId === 'string'
  if (!isModel && !isArea) throw invalid(`Invalid QC view target: ${view.id}`)
  if (isArea) assertOpaqueAreaId(view.target.areaId, `QC view ${view.id} area id`)
  if (view.areaId !== undefined) assertOpaqueAreaId(view.areaId, `QC view ${view.id} area id`)
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
    reason: view.reason,
    ...(view.areaId === undefined ? {} : { areaId: view.areaId }),
  }
}

function assertNoUnsafeContent(value, label = 'manifest', opaqueStrings = new Set()) {
  if (typeof value === 'string') {
    if (opaqueStrings.has(value)) return
    assertSafeString(value, label)
  } else if (Array.isArray(value)) {
    value.forEach((entry) => assertNoUnsafeContent(entry, label, opaqueStrings))
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      assertSafeString(key, 'manifest key')
      assertNoUnsafeContent(entry, `${label}.${key}`, opaqueStrings)
    })
  }
}

function diagnosticChannels(value, label) {
  if (!Array.isArray(value) || value.some((channel) => !DIAGNOSTIC_CHANNELS.includes(channel))) {
    throw invalid(`Invalid ${label}`)
  }
  if (new Set(value).size !== value.length
    || value.some((channel, index) => DIAGNOSTIC_CHANNELS.indexOf(channel) <= DIAGNOSTIC_CHANNELS.indexOf(value[index - 1]))) {
    throw invalid(`${label} must be unique and in canonical order`)
  }
  return [...value]
}

function assertRequiredAreaViews(areaId, areaViews, requiredChannels) {
  const count = (kind, channel) => areaViews.filter((entry) => {
    const view = entry.view ?? entry
    return view.kind === kind && entry.channel === channel
  }).length
  if (count('area-face', 'color') !== 1 || count('area-craft', 'color') !== 1) {
    throw invalid(`QC area is missing or duplicates face/craft color evidence: ${areaId}`)
  }
  for (const channel of DIAGNOSTIC_CHANNELS) {
    const expected = requiredChannels.includes(channel) ? 1 : 0
    if (count('area-face', channel) !== expected) {
      throw invalid(`QC area ${areaId} has invalid required ${channel} evidence`)
    }
  }
}

function validationSnapshot(value) {
  assertExactKeys(value, ['ready', 'issues'], 'QC validation result')
  if (typeof value.ready !== 'boolean' || !Array.isArray(value.issues)) throw invalid('Invalid QC validation result')
  const issues = value.issues.map((issue) => {
    if (!isRecord(issue)) throw invalid('Invalid QC validation issue')
    const allowed = ['severity', 'code', 'message', 'path', 'areaId', 'layerId']
    if (Object.keys(issue).some((key) => !allowed.includes(key))) throw invalid('QC validation issue has unsupported fields')
    if (issue.severity !== 'error' && issue.severity !== 'warning') throw invalid('Invalid QC validation issue severity')
    assertSafeString(issue.code, 'QC validation issue code')
    assertSafeString(issue.message, 'QC validation issue message')
    for (const key of ['path', 'areaId', 'layerId']) {
      if (issue[key] !== undefined) assertSafeString(issue[key], `QC validation issue ${key}`)
    }
    return {
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      ...(issue.path === undefined ? {} : { path: issue.path }),
      ...(issue.areaId === undefined ? {} : { areaId: issue.areaId }),
      ...(issue.layerId === undefined ? {} : { layerId: issue.layerId }),
    }
  })
  return { ready: value.ready, issues }
}

function canonicalProject(project) {
  if (!isRecord(project) || !isRecord(project.value)) throw invalid('QC project inspection is missing its source value')
  let canonical
  try {
    canonical = inspectProject(project.value)
  } catch (error) {
    throw invalid(`Invalid QC project source: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const key of ['kind', 'revision', 'areaCount', 'areas']) {
    if (JSON.stringify(project[key]) !== JSON.stringify(canonical[key])) {
      throw invalid(`QC project ${key} does not match its canonical source`)
    }
  }
  return canonical
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

export function qcArtifactRelativePath(view, areaTokens) {
  const request = view?.view
  if (!isRecord(request)) throw invalid('QC artifact view is missing')
  assertSafeString(request.id, 'QC view id')
  if (request.areaId !== undefined) assertOpaqueAreaId(request.areaId)
  const file = `${sanitizeArtifactName(request.id)}.png`
  const areaToken = request.areaId === undefined
    ? undefined
    : (areaTokens?.get(request.areaId) ?? qcAreaToken(request.areaId))
  const relativePath = request.areaId
    ? `areas/${areaToken}/${file}`
    : `model/${file}`
  assertSafeRelativePath(relativePath)
  return relativePath
}

export function parseQcCameraConfig(value, { areaIds = [] } = {}) {
  assertExactKeys(value, ['version', 'views'], 'QC camera config')
  if (value.version !== 1 || !Array.isArray(value.views) || value.views.length > 32) {
    throw invalid('QC camera config must have version 1 and at most 32 views')
  }
  if (!Array.isArray(areaIds)) throw invalid('QC camera area ids must be an array')
  const knownAreaIds = new Set()
  for (const areaId of areaIds) {
    if (typeof areaId !== 'string' || areaId.length === 0 || knownAreaIds.has(areaId)) {
      throw invalid(`Invalid or duplicate QC area id: ${String(areaId)}`)
    }
    knownAreaIds.add(areaId)
  }
  const areaTokens = deriveQcAreaTokens([...knownAreaIds])
  const ids = new Set(STANDARD_MODEL_VIEW_IDS)
  for (const areaId of knownAreaIds) {
    for (const suffix of STANDARD_AREA_VIEW_SUFFIXES) ids.add(standardAreaViewId(areaTokens.get(areaId), suffix))
  }
  return value.views.map((view, index) => {
    const label = `QC custom view ${index}`
    assertExactKeys(view, ['id', 'direction', 'target', 'framing', 'channel'], label)
    if (typeof view.id !== 'string' || !QC_ID_PATTERN.test(view.id)) throw invalid(`Invalid ${label} id`)
    if (ids.has(view.id)) throw invalid(`Duplicate or reserved QC view id: ${view.id}`)
    ids.add(view.id)
    const direction = assertVector(view.direction, `${label} direction`)
    if (direction.every((part) => part === 0)) throw invalid(`Invalid ${label} direction: zero vector`)
    if (typeof view.target !== 'string' || view.target.length === 0) throw invalid(`Invalid ${label} target`)
    if (view.framing === 'fit-model') {
      if (view.target !== 'model') throw invalid(`${label} framing does not match target`)
    } else if (view.framing === 'fit-area') {
      if (!knownAreaIds.has(view.target)) throw invalid(`${label} targets missing area: ${view.target}`)
    } else {
      throw invalid(`${label} framing does not match target`)
    }
    if (!CHANNELS.has(view.channel)) throw invalid(`Invalid ${label} channel`)
    return {
      id: view.id,
      direction,
      target: view.target,
      framing: view.framing,
      channel: view.channel,
    }
  })
}

export function buildQcManifest({ createdAt, project, inspection, evidence, artifacts }) {
  assertSafeString(createdAt, 'QC manifest timestamp')
  if (Number.isNaN(Date.parse(createdAt))) throw invalid('Invalid QC manifest timestamp')
  const canonicalProjectSummary = canonicalProject(project)
  const revision = canonicalProjectSummary.revision
  const model = modelSnapshot(inspection)
  if (!isRecord(evidence) || evidence.preset !== 'qc-standard' || !Array.isArray(evidence.views) || !Array.isArray(evidence.areas)) {
    throw invalid('Invalid QC evidence result')
  }
  if (!Array.isArray(artifacts)) throw invalid('QC session artifacts must be an array')
  const areaTokens = deriveQcAreaTokens(evidence.areas.map((area, index) => {
    if (!isRecord(area)) throw invalid(`Invalid QC evidence area ${index}`)
    return assertOpaqueAreaId(area.areaId, `QC evidence area ${index} id`)
  }))
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
    if (descriptor.id !== `qc-${capturedView.id}`) throw invalid(`QC artifact id does not match capture view: ${descriptor.id}`)
    if (descriptor.width !== capturedView.width || descriptor.height !== capturedView.height || descriptor.channel !== capturedView.channel || descriptor.areaId !== capturedView.areaId) {
      throw invalid(`QC artifact metadata does not match capture view: ${descriptor.id}`)
    }
    return {
      id: descriptor.id,
      path: qcArtifactRelativePath(entry, areaTokens),
      sha256: descriptor.sha256,
      mimeType: descriptor.mimeType,
      byteLength: descriptor.byteLength,
      width: descriptor.width,
      height: descriptor.height,
      viewId: capturedView.id,
      view: { kind: capturedView.kind, framing: capturedView.framing, target: capturedView.target },
      channel: descriptor.channel,
      reason: capturedView.reason,
      camera: manifestCamera(entry.camera),
      ...(descriptor.areaId === undefined ? {} : { areaId: descriptor.areaId }),
    }
  })
  assertUnique(manifestArtifacts.map((artifact) => ({ id: publicationPathKey(artifact.path) })), 'id', 'QC artifact path')
  if (storedById.size !== manifestArtifacts.length) throw invalid('Unexpected stored QC artifact')

  const projectAreas = canonicalProjectSummary.areas
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
    if (area.side !== undefined && area.side !== 'front' && area.side !== 'back') throw invalid(`Invalid QC area side: ${area.areaId}`)
    if (area.surfaceMode !== 'overlay' && area.surfaceMode !== 'replace') throw invalid(`Invalid QC area surface mode: ${area.areaId}`)
    const requiredChannels = diagnosticChannels(area.requiredChannels, `QC area required channels: ${area.areaId}`)
    if (!Array.isArray(area.viewIds)) throw invalid(`Invalid QC area view ids: ${area.areaId}`)
    assertUnique(area.viewIds.map((id) => ({ id })), 'id', 'QC area view')
    const areaViews = evidence.views.filter((entry) => entry.view.areaId === area.areaId)
    if (areaViews.length !== area.viewIds.length || areaViews.some((entry) => !area.viewIds.includes(entry.view.id))) {
      throw invalid(`QC area view ids do not match captured evidence: ${area.areaId}`)
    }
    assertRequiredAreaViews(area.areaId, areaViews.map((entry) => ({
      view: { kind: entry.view.pose.kind }, channel: entry.view.channel,
    })), requiredChannels)
    const mesh = model.meshes.get(area.meshIndex)
    return {
      id: area.areaId,
      meshIndex: area.meshIndex,
      stableSelector: mesh.stableSelector,
      nodeName: area.nodeName,
      ...(area.side === undefined ? {} : { side: area.side }),
      surfaceMode: area.surfaceMode,
      requiredChannels,
      artifactIds: area.viewIds.map((id) => artifactByViewId.get(id)),
    }
  })

  const digest = revision.slice('sha256:'.length)
  const manifest = {
    version: 1,
    createdAt,
    preset: evidence.preset,
    input: { kind: canonicalProjectSummary.kind, revision, sha256: digest },
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
  if (value.input.kind !== 'label-spec-v2' && value.input.kind !== 'label-project-v3') throw invalid('Unsupported QC manifest input kind')
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
  const areaIds = new Set(value.areas.map((area) => area.id))
  const areaTokens = deriveQcAreaTokens([...areaIds])
  assertUnique(value.artifacts, 'id', 'QC manifest artifact')
  assertUnique(value.artifacts, 'viewId', 'QC manifest artifact')
  assertUnique(value.artifacts.map((artifact) => ({ id: publicationPathKey(artifact.path) })), 'id', 'QC manifest artifact path')
  const artifactIds = new Set(value.artifacts.map((artifact) => artifact.id))
  for (const artifact of value.artifacts) {
    assertExactKeys(artifact, ['id', 'path', 'sha256', 'mimeType', 'byteLength', 'width', 'height', 'viewId', 'view', 'channel', 'reason', 'camera', ...(artifact.areaId === undefined ? [] : ['areaId'])], 'QC manifest artifact')
    assertSafeString(artifact.id, 'QC manifest artifact id')
    if (typeof artifact.viewId !== 'string' || !QC_ID_PATTERN.test(artifact.viewId)
      || artifact.id !== `qc-${artifact.viewId}`) throw invalid(`Invalid QC manifest artifact view id: ${artifact.id}`)
    assertSafeString(artifact.reason, `QC manifest artifact reason: ${artifact.id}`)
    assertSafeRelativePath(artifact.path)
    assertArtifactDigest(artifact.sha256, 'QC manifest artifact')
    if (artifact.mimeType !== 'image/png' || !Number.isInteger(artifact.byteLength) || artifact.byteLength < PNG_SIGNATURE.length
      || !Number.isInteger(artifact.width) || artifact.width < 1 || !Number.isInteger(artifact.height) || artifact.height < 1
      || !CHANNELS.has(artifact.channel)) throw invalid(`Invalid QC manifest artifact: ${artifact.id}`)
    assertExactKeys(artifact.view, ['kind', 'framing', 'target'], 'QC manifest artifact view')
    if (!POSE_KINDS.has(artifact.view.kind) || !FRAMINGS.has(artifact.view.framing)) throw invalid(`Invalid QC manifest artifact view: ${artifact.id}`)
    if (artifact.view.target === 'model') assertSafeString(artifact.view.target, 'QC manifest artifact target')
    else assertOpaqueAreaId(artifact.view.target, 'QC manifest artifact target')
    if (artifact.areaId !== undefined) {
      assertOpaqueAreaId(artifact.areaId, 'QC manifest artifact area id')
      const areaToken = areaTokens.get(artifact.areaId)
      if (areaToken === undefined) throw invalid(`QC manifest artifact references missing area: ${artifact.id}`)
      if (!artifact.path.startsWith(`areas/${areaToken}/`)) throw invalid(`QC manifest artifact path does not match area token: ${artifact.id}`)
    }
    if (artifact.areaId === undefined && (artifact.view.target !== 'model' || artifact.view.framing !== 'fit-model')) {
      throw invalid(`QC manifest model artifact target or framing is invalid: ${artifact.id}`)
    }
    manifestCamera(artifact.camera)
  }
  for (const viewId of STANDARD_MODEL_VIEW_IDS) {
    const artifact = value.artifacts.find((candidate) => candidate.viewId === viewId)
    if (!artifact || artifact.areaId !== undefined || artifact.channel !== 'color'
      || artifact.view.kind !== 'direction' || artifact.view.target !== 'model'
      || artifact.view.framing !== 'fit-model') {
      throw invalid(`QC manifest is missing or has invalid required model view: ${viewId}`)
    }
  }
  for (const area of value.areas) {
    assertExactKeys(area, ['id', 'meshIndex', 'stableSelector', 'nodeName', ...(area.side === undefined ? [] : ['side']), 'surfaceMode', 'requiredChannels', 'artifactIds'], 'QC manifest area')
    assertOpaqueAreaId(area.id, 'QC manifest area id')
    if (!Number.isInteger(area.meshIndex) || area.meshIndex < 0) throw invalid(`Invalid QC manifest area mesh: ${area.id}`)
    assertSafeString(area.stableSelector, 'QC manifest area selector')
    assertSafeString(area.nodeName, 'QC manifest area node name')
    if ((area.side !== undefined && area.side !== 'front' && area.side !== 'back')
      || (area.surfaceMode !== 'overlay' && area.surfaceMode !== 'replace') || !Array.isArray(area.artifactIds)) {
      throw invalid(`Invalid QC manifest area: ${area.id}`)
    }
    const requiredChannels = diagnosticChannels(area.requiredChannels, `QC manifest area required channels: ${area.id}`)
    assertUnique(area.artifactIds.map((id) => ({ id })), 'id', 'QC manifest area artifact')
    if (area.artifactIds.some((id) => !artifactIds.has(id))) throw invalid(`QC manifest area references missing artifact: ${area.id}`)
    const areaArtifacts = value.artifacts.filter((artifact) => artifact.areaId === area.id)
    const areaArtifactIds = new Set(areaArtifacts.map((artifact) => artifact.id))
    if (area.artifactIds.length !== areaArtifactIds.size || area.artifactIds.some((id) => !areaArtifactIds.has(id))) {
      throw invalid(`QC manifest area artifact ids are disconnected: ${area.id}`)
    }
    if (areaArtifacts.some((artifact) => artifact.view.target !== area.id || artifact.view.framing !== 'fit-area')) {
      throw invalid(`QC manifest area artifact target or framing is invalid: ${area.id}`)
    }
    assertRequiredAreaViews(area.id, areaArtifacts, requiredChannels)
  }
  assertNoUnsafeContent(value, 'manifest', areaIds)
  return value
}
