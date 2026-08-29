import Ajv2020 from 'ajv/dist/2020.js'
import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { failure, success } from './envelope.mjs'
import { snapshotRegularDirectory } from './bounded-file-reader.mjs'
import { publishFileAtomically, resolveAllowedOutputPath, resolveAllowedPath, sanitizeArtifactName, sha256Bytes } from './files.mjs'
import { inspectProject, patchLabelSpec, revisionOf } from './project-control.mjs'
import { buildQcManifest, parseQcCameraConfig, qcArtifactRelativePath, validateQcManifest } from './qc-output.mjs'
import { buildReviewManifest, validateReviewDirectory, validateReviewManifest } from './review-output.mjs'
import { startLivePreview } from './live-preview.mjs'

const schemaPath = path.resolve(import.meta.dirname, '../../src/agent/label-spec-v2.schema.json')
const MAX_REVIEW_JSON_BYTES = 16 * 1024 * 1024
const MAX_REVIEW_HANDOFF_BYTES = 4 * 1024 * 1024
const MAX_REVIEW_MODEL_BYTES = 256 * 1024 * 1024
const MAX_REVIEW_EVIDENCE_TOTAL_BYTES = 128 * 1024 * 1024

async function readSchema() {
  return JSON.parse(await readFile(schemaPath, 'utf8'))
}

async function readJsonInput(allowedRoots, { inline, inputPath, parseErrorCode = 'INVALID_LABEL_SPEC' }) {
  if (inline !== undefined) return { value: structuredClone(inline), baseDir: process.cwd() }
  const resolved = await resolveAllowedPath(allowedRoots, inputPath)
  try {
    return { value: JSON.parse(await readFile(resolved, 'utf8')), baseDir: path.dirname(resolved), resolved }
  } catch (error) {
    if (error instanceof SyntaxError) {
      error.code = parseErrorCode
      error.message = `Invalid JSON in ${resolved}: ${error.message}`
    }
    throw error
  }
}

function schemaIssues(validate) {
  return (validate.errors ?? []).map((error) => ({
    path: error.keyword === 'additionalProperties'
      ? `${error.instancePath}/${error.params.additionalProperty}`
      : error.instancePath || '/',
    message: error.message ?? 'invalid value',
    keyword: error.keyword,
  }))
}

async function validateSpecValue(value) {
  if (value?.version === 1) {
    if (!Array.isArray(value.areas) || value.areas.length === 0) {
      return { valid: false, issues: [{ path: '/areas', message: 'must contain at least one area', keyword: 'minItems' }], warnings: [] }
    }
    return {
      valid: true,
      issues: [],
      warnings: ['Label Spec v1 uses inferred target, surfaceMode, range, remap, ids, and print readiness values'],
    }
  }
  const schema = await readSchema()
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
  const valid = validate(value)
  return { valid, issues: valid ? [] : schemaIssues(validate), warnings: [] }
}

function isLabelProjectValue(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.areas)) return false
  if (value.version === 3 || typeof value.modelFileName === 'string') return true
  return value.areas.some((area) => area && typeof area === 'object' && Array.isArray(area.layers)
    && area.layers.some((layer) => layer && typeof layer === 'object' && typeof layer.kind === 'string'))
}

async function assertOutputAvailable(runtime, outputPath, force) {
  const resolved = await resolveAllowedOutputPath(runtime.allowedRoots, outputPath)
  const outputInfo = await lstat(resolved).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (outputInfo?.isSymbolicLink()) {
    const error = new Error(`Output path final component must not be a symlink: ${resolved}`)
    error.code = 'PATH_NOT_ALLOWED'
    throw error
  }
  if (force) return resolved
  if (await stat(resolved).then(() => true, () => false)) {
    const error = new Error(`Output already exists: ${resolved}`)
    error.code = 'OUTPUT_CONFLICT'
    throw error
  }
  return resolved
}

function unwrapBridge(envelope) {
  if (envelope?.ok) return { data: envelope.data, warnings: envelope.warnings ?? [] }
  const error = new Error(envelope?.error?.message ?? 'Browser Agent Bridge operation failed')
  error.code = envelope?.error?.code ?? 'BROWSER_NOT_READY'
  error.path = envelope?.error?.path
  error.details = envelope?.error?.details
  error.suggestion = envelope?.error?.suggestion
  throw error
}

async function addSpecAssets(runtime, session, spec, baseDir, { live = false } = {}) {
  const urls = {}
  if (!spec?.assets || typeof spec.assets !== 'object') return urls
  for (const [key, descriptor] of Object.entries(spec.assets)) {
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.path !== 'string') continue
    try {
      const resolved = await resolveAllowedPath(runtime.allowedRoots, path.resolve(baseDir, descriptor.path))
      urls[key] = runtime.addAsset(session.id, {
        id: `asset-${sanitizeArtifactName(key)}`,
        bytes: await readFile(resolved),
        mimeType: descriptor.mimeType ?? 'application/octet-stream',
        fileName: path.basename(resolved),
      })
    } catch (error) {
      if (!live) throw error
      const failure = new Error(`Label Spec asset ${key} is unavailable: ${error instanceof Error ? error.message : String(error)}`)
      failure.code = 'INVALID_LABEL_SPEC'
      failure.liveRecoverable = true
      failure.cause = error
      throw failure
    }
  }
  return urls
}

async function loadSessionModel(runtime, session) {
  if (!session.inputUrl) throw new Error('Session has no GLB input')
  return unwrapBridge(await runtime.callBridge(session, 'loadModel', {
    name: session.modelName,
    url: session.inputUrl,
  }))
}

function artifactRelativePath(artifact) {
  if (artifact.id === 'labeled-glb') return 'labeled.glb'
  if (artifact.id === 'project') return 'project.lbl.json'
  if (artifact.id === 'normalized-spec') return 'label-spec.normalized.json'
  if (artifact.id === 'print-manifest') return 'print-manifest.json'
  if (artifact.id === 'preview-3d') return 'preview-3d.png'
  if (artifact.areaId && artifact.channel) return `areas/${sanitizeArtifactName(artifact.areaId)}/${sanitizeArtifactName(artifact.channel)}.png`
  return sanitizeArtifactName(artifact.fileName)
}

function publicArtifact(artifact, relativePath) {
  return {
    id: artifact.id,
    path: relativePath,
    mimeType: artifact.mimeType,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    width: artifact.width,
    height: artifact.height,
    areaId: artifact.areaId,
    channel: artifact.channel,
  }
}

function qcModelInspection(value) {
  const fingerprint = typeof value?.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
    ? `sha256:${value.fingerprint}`
    : value?.fingerprint
  return { ...value, fingerprint }
}

function exactQcArtifacts(evidence, received) {
  if (!Array.isArray(evidence?.views) || !Array.isArray(received)) {
    const error = new Error('QC evidence or stored artifacts are missing')
    error.code = 'INVALID_USAGE'
    throw error
  }
  const expectedIds = evidence.views.map((entry) => entry?.artifact?.id)
  if (expectedIds.some((id) => typeof id !== 'string' || !id) || new Set(expectedIds).size !== expectedIds.length) {
    const error = new Error('QC evidence contains missing or duplicate artifact ids')
    error.code = 'INVALID_USAGE'
    throw error
  }
  const storedById = new Map()
  for (const artifact of received) {
    if (!artifact || typeof artifact.id !== 'string' || storedById.has(artifact.id)) {
      const error = new Error('Stored QC artifacts contain a missing or duplicate id')
      error.code = 'INVALID_USAGE'
      throw error
    }
    storedById.set(artifact.id, artifact)
  }
  if (storedById.size !== expectedIds.length || [...storedById.keys()].some((id) => !expectedIds.includes(id))) {
    const error = new Error('Stored QC artifacts do not exactly match the captured evidence')
    error.code = 'INVALID_USAGE'
    throw error
  }
  return expectedIds.map((id) => {
    const artifact = storedById.get(id)
    if (!artifact) {
      const error = new Error(`Stored QC artifact is missing: ${id}`)
      error.code = 'INVALID_USAGE'
      throw error
    }
    return artifact
  })
}

function staleReviewError(message) {
  const error = new Error(message)
  error.code = 'STALE_APPROVAL'
  return error
}

function reviewUsageError(message) {
  const error = new Error(message)
  error.code = 'INVALID_USAGE'
  return error
}

function pathContains(parent, target) {
  const relative = path.relative(parent, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function decodeReviewJson(bytes, label) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text, value: JSON.parse(text) }
  } catch (error) {
    const invalid = reviewUsageError(`${label} must be valid UTF-8 JSON`)
    invalid.cause = error
    throw invalid
  }
}

async function resolveReviewSources(rootPolicy, inputPath, glbPath, outputDir, force) {
  const [input, model] = await Promise.all([
    resolveReviewRegularPath(rootPolicy, inputPath, 'Review input'),
    resolveReviewRegularPath(rootPolicy, glbPath, 'Review model'),
  ])
  let handoff
  try {
    handoff = await resolveReviewRegularPath(rootPolicy, path.join(path.dirname(input), 'editor-handoff.json'), 'editor-handoff.json')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const missing = new Error('Review requires adjacent approved editor-handoff.json evidence')
    missing.code = 'APPROVAL_REQUIRED'
    throw missing
  }
  const handoffEvidence = decodeReviewJson((await readStableReviewFile(handoff, 'Review handoff', MAX_REVIEW_HANDOFF_BYTES)).bytes, 'editor-handoff.json')
  const blueprintSource = handoffEvidence.value?.source?.blueprint
  const designManifestSource = handoffEvidence.value?.source?.design_review_manifest
  if (typeof blueprintSource !== 'string' || !blueprintSource
    || typeof designManifestSource !== 'string' || !designManifestSource) {
    throw reviewUsageError('editor-handoff.json requires source.blueprint and source.design_review_manifest')
  }
  let blueprint
  let designReviewManifest
  try {
    [blueprint, designReviewManifest] = await Promise.all([
      resolveReviewRegularPath(rootPolicy, path.resolve(path.dirname(handoff), blueprintSource), 'Review blueprint'),
      resolveReviewRegularPath(rootPolicy, path.resolve(path.dirname(handoff), designManifestSource), 'Review design manifest'),
    ])
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const missing = new Error('Review approved blueprint or design-review manifest is unavailable')
    missing.code = 'APPROVAL_REQUIRED'
    throw missing
  }
  const output = await resolveAllowedOutputPath(rootPolicy, outputDir)
  const outputInfo = await lstat(output).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (outputInfo?.isSymbolicLink()) {
    const error = new Error(`Review output final component must not be a symlink: ${output}`)
    error.code = 'PATH_NOT_ALLOWED'
    throw error
  }
  for (const protectedPath of [input, model, handoff, blueprint, designReviewManifest]) {
    if (pathContains(output, protectedPath)) {
      throw reviewUsageError(`Review output must not alias or contain a protected source: ${protectedPath}`)
    }
  }
  if (!force && await stat(output).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error))) {
    const error = new Error(`Output already exists: ${output}`)
    error.code = 'OUTPUT_CONFLICT'
    throw error
  }
  return { input, model, handoff, blueprint, designReviewManifest, output }
}

async function resolveReviewRegularPath(rootPolicy, inputPath, label) {
  const absolute = path.resolve(inputPath)
  const info = await lstat(absolute)
  if (info.isSymbolicLink() || !info.isFile()) {
    const error = new Error(`${label} must be a regular file and not a symlink`)
    error.code = 'PATH_NOT_ALLOWED'
    throw error
  }
  return resolveAllowedPath(rootPolicy, absolute)
}

function fileSnapshotIdentity(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  }
}

async function readStableReviewFile(filePath, label, maxBytes) {
  const beforePath = await lstat(filePath, { bigint: true })
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw reviewUsageError(`${label} must be a regular file`)
  if (beforePath.size < 1n || beforePath.size > BigInt(maxBytes)) {
    throw reviewUsageError(`${label} exceeds the bounded review input size`)
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const beforeHandle = await handle.stat({ bigint: true })
    if (JSON.stringify(fileSnapshotIdentity(beforeHandle)) !== JSON.stringify(fileSnapshotIdentity(beforePath))) {
      throw staleReviewError(`${label} changed before bounded readback`)
    }
    const bytes = new Uint8Array(await handle.readFile())
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ])
    const identity = fileSnapshotIdentity(beforePath)
    if (bytes.byteLength !== Number(beforePath.size)
      || JSON.stringify(fileSnapshotIdentity(afterHandle)) !== JSON.stringify(identity)
      || JSON.stringify(fileSnapshotIdentity(afterPath)) !== JSON.stringify(identity)) {
      throw staleReviewError(`${label} changed during bounded readback`)
    }
    return { bytes, sha256: sha256Bytes(bytes), identity }
  } finally {
    await handle.close()
  }
}

async function readReviewSnapshot(sources, { parse = false } = {}) {
  const names = ['input', 'model', 'handoff', 'blueprint', 'designReviewManifest']
  const snapshots = await Promise.all(names.map((name) => readStableReviewFile(
    sources[name],
    name === 'model' ? 'Review model' : `Review ${name}`,
    name === 'model' ? MAX_REVIEW_MODEL_BYTES : name === 'handoff' ? MAX_REVIEW_HANDOFF_BYTES : MAX_REVIEW_JSON_BYTES,
  )))
  const values = snapshots.map((snapshot) => snapshot.bytes)
  const hashes = Object.fromEntries(snapshots.map((snapshot, index) => [names[index], snapshot.sha256]))
  const identities = Object.fromEntries(snapshots.map((snapshot, index) => [names[index], snapshot.identity]))
  if (!parse) return { hashes, identities }
  const input = decodeReviewJson(new Uint8Array(values[0]), 'Review input')
  const handoff = decodeReviewJson(new Uint8Array(values[2]), 'editor-handoff.json')
  const blueprint = decodeReviewJson(new Uint8Array(values[3]), 'layout blueprint')
  const designReviewManifest = decodeReviewJson(new Uint8Array(values[4]), 'design review manifest')
  return {
    hashes,
    identities,
    modelBytes: new Uint8Array(values[1]),
    input,
    handoff,
    blueprint,
    designReviewManifest,
  }
}

function assertReviewSnapshot(expected, actual, boundary) {
  if (JSON.stringify(expected.hashes) !== JSON.stringify(actual.hashes)
    || JSON.stringify(expected.identities) !== JSON.stringify(actual.identities)) {
    throw staleReviewError(`Review production-gate source changed at ${boundary}`)
  }
}

function safeReviewArtifactPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value.includes('\0')
    || path.isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    const error = new Error('Design-review artifact paths must be bounded portable relative paths')
    error.code = 'PATH_NOT_ALLOWED'
    throw error
  }
  return value
}

async function readDesignArtifactSnapshot(sources, manifest, { includeBase64 = false } = {}) {
  const root = path.dirname(sources.designReviewManifest)
  if (path.basename(sources.designReviewManifest) !== 'design-review-manifest.json') {
    const error = new Error('Design-review evidence root must contain design-review-manifest.json')
    error.code = 'PATH_NOT_ALLOWED'
    throw error
  }
  const entries = await snapshotRegularDirectory(root, {
    label: 'Design-review evidence root', maxFiles: 513, maxDepth: 8,
    maxFileBytes: MAX_REVIEW_JSON_BYTES * 2, maxTotalBytes: MAX_REVIEW_EVIDENCE_TOTAL_BYTES,
    makeError: (code, message) => {
      const error = new Error(message)
      error.code = code
      return error
    },
  })
  return entries.map(({ path: relativePath, bytes }) => ({
    path: safeReviewArtifactPath(relativePath), sha256: sha256Bytes(bytes),
    ...(includeBase64 ? { base64: Buffer.from(bytes).toString('base64') } : {}),
  }))
}

function assertDesignArtifactSnapshot(expected, actual, boundary) {
  const project = (values) => values.map(({ path: valuePath, sha256, identity }) => ({ path: valuePath, sha256, identity }))
  if (JSON.stringify(project(expected)) !== JSON.stringify(project(actual))) {
    throw staleReviewError(`Review design artifacts changed at ${boundary}`)
  }
}

function reviewAreas(document) {
  const areas = document.areas.map((area) => {
    if (typeof area.id !== 'string' || !area.id || typeof area.side !== 'string' || typeof area.carrier !== 'string') {
      throw reviewUsageError(`Review area requires normalized id, side, and carrier: ${String(area?.id)}`)
    }
    return { id: area.id, side: area.side, carrier: area.carrier }
  })
  return areas
}

function patchLockPath(targetPath) {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.patch.lock`)
}

async function acquirePatchLock(targetPath) {
  const lockPath = patchLockPath(targetPath)
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, targetPath })}\n`)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (handle) await rm(lockPath, { force: true }).catch(() => undefined)
    if (error?.code === 'EEXIST') {
      const conflict = new Error(`Another patch transaction is active for ${targetPath}`)
      conflict.code = 'REVISION_CONFLICT'
      conflict.suggestion = `Wait for the active transaction or remove the stale lock after verifying no writer is running: ${lockPath}`
      throw conflict
    }
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      await handle.close()
    } finally {
      await rm(lockPath, { force: true })
    }
  }
}

async function acquirePatchLocks(paths) {
  const targets = [...new Set(paths.map((target) => path.resolve(target)))].sort()
  const releases = []
  try {
    for (const target of targets) releases.push(await acquirePatchLock(target))
  } catch (error) {
    await Promise.allSettled(releases.reverse().map((release) => release()))
    throw error
  }
  return async () => {
    const results = await Promise.allSettled(releases.reverse().map((release) => release()))
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
  }
}

export function createOperations(runtime, { progress = () => undefined, allowedRoots, onFatal = () => undefined } = {}) {
  const rootPolicy = runtime?.allowedRoots ?? (allowedRoots?.length ? allowedRoots : [process.cwd()])
  return {
    async schema() {
      try {
        return success('schema', { schema: await readSchema() })
      } catch (error) {
        return failure('schema', error)
      }
    },

    async inspect({ glbPath }) {
      let session
      try {
        progress('Inspecting GLB')
        session = await runtime.createSession({ glbPath })
        const inspection = await loadSessionModel(runtime, session)
        return success('inspect_model', {
          ...inspection.data,
          codec: session.codec,
        }, { sessionId: session.id, warnings: inspection.warnings })
      } catch (error) {
        return failure('inspect_model', error, { sessionId: session?.id })
      }
    },

    async project({ inputPath }) {
      try {
        const input = await readJsonInput(rootPolicy, { inputPath })
        return success('inspect_label_project', inspectProject(input.value))
      } catch (error) {
        return failure('inspect_label_project', error)
      }
    },

    async patch({ inputPath, operationsPath, outputPath, force = false }) {
      let releaseLock
      try {
        const [resolvedInput, operationsInput, resolvedOutput] = await Promise.all([
          resolveAllowedPath(rootPolicy, inputPath),
          readJsonInput(rootPolicy, { inputPath: operationsPath, parseErrorCode: 'INVALID_PATCH_OPERATION' }),
          resolveAllowedOutputPath(rootPolicy, outputPath),
        ])
        releaseLock = await acquirePatchLocks([resolvedInput, resolvedOutput])
        const input = await readJsonInput(rootPolicy, { inputPath: resolvedInput })
        const patched = patchLabelSpec(input.value, operationsInput.value)
        const bytes = new TextEncoder().encode(`${JSON.stringify(patched.value, null, 2)}\n`)
        await publishFileAtomically(resolvedOutput, bytes, { force })
        return success('patch_label_spec', { ...patched, outputPath: resolvedOutput })
      } catch (error) {
        return failure('patch_label_spec', error)
      } finally {
        await releaseLock?.().catch((error) => progress(`patch cleanup warning: ${error instanceof Error ? error.message : String(error)}`))
      }
    },

    async live({ specPath, glbPath }) {
      let controller
      try {
        if (!runtime) {
          const error = new Error('Live preview requires the browser runtime')
          error.code = 'BROWSER_NOT_READY'
          throw error
        }
        const [resolvedSpecPath, resolvedGlbPath] = await Promise.all([
          resolveAllowedPath(rootPolicy, specPath),
          resolveAllowedPath(rootPolicy, glbPath),
        ])
        const specBaseDir = path.dirname(resolvedSpecPath)
        controller = await startLivePreview({
          specPath: resolvedSpecPath,
          glbPath: resolvedGlbPath,
          onEvent: (event) => {
            if (event.type === 'revision') progress(`live revision ${event.revision}`)
            else progress(`live ${event.type}: ${event.error}`)
          },
          onFatal,
          launch: async () => {
            const session = await runtime.createSession({ glbPath: resolvedGlbPath })
            await loadSessionModel(runtime, session)
            return {
              sessionId: session.id,
              previewUrl: await runtime.openEditor(session),
              applySpec: async (spec) => {
                const assetUrls = await addSpecAssets(runtime, session, spec, specBaseDir, { live: true })
                unwrapBridge(await runtime.callBridge(session, 'applySpec', { spec, assetUrls }))
              },
              setStatus: async (status) => {
                unwrapBridge(await runtime.callBridge(session, 'setAgentPreviewStatus', status))
              },
              onUnavailable: (listener) => runtime.onSessionUnavailable(session.id, listener),
              close: () => runtime.disposeSession(session.id),
            }
          },
        })
        runtime.addCleanup(controller.close)
        return success('live_preview', {
          sessionId: controller.sessionId,
          previewUrl: controller.previewUrl,
          revision: controller.revision,
          keepAlive: true,
        }, { sessionId: controller.sessionId })
      } catch (error) {
        await controller?.close().catch(() => undefined)
        return failure('live_preview', error, { sessionId: controller?.sessionId })
      }
    },

    async validate({ specPath, spec, glbPath }) {
      let session
      try {
        const input = await readJsonInput(rootPolicy, { inline: spec, inputPath: specPath })
        const validation = await validateSpecValue(input.value)
        if (!validation.valid) {
          const error = new Error('Label Spec schema validation failed')
          error.code = 'INVALID_LABEL_SPEC'
          error.details = { issues: validation.issues }
          throw error
        }
        const warnings = [...validation.warnings]
        let inspection
        if (glbPath) {
          session = await runtime.createSession({ glbPath })
          inspection = await loadSessionModel(runtime, session)
          const assetUrls = await addSpecAssets(runtime, session, input.value, input.baseDir)
          const applied = unwrapBridge(await runtime.callBridge(session, 'applySpec', { spec: input.value, assetUrls }))
          const design = unwrapBridge(await runtime.callBridge(session, 'validateDesign'))
          warnings.push(...inspection.warnings, ...applied.warnings, ...design.warnings)
          return success('validate_label_spec', {
            schemaIssues: [],
            design: design.data,
            executionPlan: { areaIds: applied.data.areaIds, model: inspection.data.name },
          }, { sessionId: session.id, warnings })
        }
        return success('validate_label_spec', { schemaIssues: [], executionPlan: null }, { warnings })
      } catch (error) {
        return failure('validate_label_spec', error, { sessionId: session?.id })
      }
    },

    async apply({ specPath, spec, glbPath, outputDir, force = false, openEditor = false }) {
      let session
      try {
        progress('Validating Label Spec')
        const input = await readJsonInput(rootPolicy, { inline: spec, inputPath: specPath })
        const isProject = isLabelProjectValue(input.value)
        const validation = isProject
          ? { valid: true, issues: [], warnings: [] }
          : await validateSpecValue(input.value)
        if (!validation.valid) {
          const validationError = new Error('Label Spec schema validation failed')
          validationError.code = 'INVALID_LABEL_SPEC'
          validationError.details = { issues: validation.issues }
          throw validationError
        }
        await assertOutputAvailable(runtime, outputDir, force)
        session = await runtime.createSession({ glbPath })
        progress('Loading model in browser renderer')
        const inspection = await loadSessionModel(runtime, session)
        progress('Applying label design')
        const applied = isProject
          ? unwrapBridge(await runtime.callBridge(session, 'applyProject', { project: input.value }))
          : unwrapBridge(await runtime.callBridge(session, 'applySpec', {
              spec: input.value,
              assetUrls: await addSpecAssets(runtime, session, input.value, input.baseDir),
            }))
        unwrapBridge(await runtime.callBridge(session, 'waitForReady', { timeoutMs: 60_000 }))
        progress('Rendering preview and export channels')
        const exported = unwrapBridge(await runtime.callBridge(session, 'exportArtifacts', {}))
        unwrapBridge(await runtime.callBridge(session, 'renderPreview', { view: '3d', width: 1200, height: 1200 }))
        const browserErrors = runtime.browserErrors(session.id)
        if (browserErrors.length > 0) {
          const error = new Error(`Browser reported errors: ${browserErrors.join('; ')}`)
          error.code = 'BROWSER_NOT_READY'
          throw error
        }
        const received = runtime.getArtifacts(session.id)
        const publishArtifacts = received.map((artifact) => ({
          ...artifact,
          relativePath: artifactRelativePath(artifact),
        }))
        const manifestArtifacts = publishArtifacts.map((artifact) => publicArtifact(artifact, artifact.relativePath))
        const manifestValue = {
          version: 1,
          sessionId: session.id,
          input: { modelName: session.modelName, codec: session.codec },
          validation: exported.data.validation,
          glbCrossCheck: exported.data.glbCrossCheck,
          artifacts: manifestArtifacts,
          warnings: [...validation.warnings, ...inspection.warnings, ...applied.warnings, ...exported.warnings],
        }
        const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestValue, null, 2))
        publishArtifacts.push({
          id: 'manifest', fileName: 'manifest.json', relativePath: 'manifest.json',
          mimeType: 'application/json', bytes: manifestBytes, byteLength: manifestBytes.byteLength,
          sha256: sha256Bytes(manifestBytes),
        })
        const publishedOutput = await runtime.publishArtifacts(session.id, outputDir, publishArtifacts, force)
        return success('apply_label_spec', {
          outputDir: publishedOutput,
          artifacts: [...manifestArtifacts, publicArtifact(publishArtifacts.at(-1), 'manifest.json')],
          validation: exported.data.validation,
          glbCrossCheck: exported.data.glbCrossCheck,
          editorUrl: openEditor ? await runtime.openEditor(session) : undefined,
        }, {
          sessionId: session.id,
          warnings: manifestValue.warnings,
        })
      } catch (error) {
        return failure('apply_label_spec', error, { sessionId: session?.id })
      }
    },

    async qc({
      inputPath,
      glbPath,
      outputDir,
      preset = 'qc-standard',
      cameraConfigPath,
      width = 1440,
      height = 1440,
      force = false,
    }) {
      let session
      try {
        progress('Inspecting label input for QC')
        const input = await readJsonInput(rootPolicy, { inputPath })
        const project = inspectProject(input.value)
        const revision = revisionOf(input.value)
        const customViews = cameraConfigPath
          ? parseQcCameraConfig((await readJsonInput(rootPolicy, {
              inputPath: cameraConfigPath,
              parseErrorCode: 'INVALID_USAGE',
            })).value, { areaIds: project.areas.map((area) => area.id) })
          : []
        const resolvedOutput = await assertOutputAvailable(runtime, outputDir, force)

        session = await runtime.createSession({ glbPath })
        progress('Loading model in browser renderer')
        const inspected = await loadSessionModel(runtime, session)
        const inspection = qcModelInspection(inspected.data)
        progress('Applying label design for QC')
        const applied = isLabelProjectValue(input.value)
          ? unwrapBridge(await runtime.callBridge(session, 'applyProject', { project: input.value }))
          : unwrapBridge(await runtime.callBridge(session, 'applySpec', {
              spec: input.value,
              assetUrls: await addSpecAssets(runtime, session, input.value, input.baseDir),
            }))
        unwrapBridge(await runtime.callBridge(session, 'waitForReady', { timeoutMs: 60_000 }))
        progress('Capturing QC evidence')
        const evidence = unwrapBridge(await runtime.callBridge(session, 'renderQcEvidence', {
          preset,
          width,
          height,
          customViews,
        }))
        const browserErrors = runtime.browserErrors(session.id)
        if (browserErrors.length > 0) {
          const error = new Error(`Browser reported errors: ${browserErrors.join('; ')}`)
          error.code = 'BROWSER_NOT_READY'
          throw error
        }

        const storedArtifacts = exactQcArtifacts(evidence.data, runtime.getArtifacts(session.id))
        const manifest = validateQcManifest(buildQcManifest({
          createdAt: new Date().toISOString(),
          project,
          inspection,
          evidence: evidence.data,
          artifacts: storedArtifacts,
        }))
        if (manifest.input.revision !== revision) {
          const error = new Error('QC manifest revision does not match the current input')
          error.code = 'INVALID_USAGE'
          throw error
        }
        const relativePaths = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact.path]))
        const publishArtifacts = evidence.data.views.map((entry, index) => ({
          ...storedArtifacts[index],
          relativePath: relativePaths.get(entry.artifact.id) ?? qcArtifactRelativePath(entry),
        }))
        const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
        const manifestArtifact = {
          id: 'qc-manifest',
          fileName: 'qc-manifest.json',
          relativePath: 'qc-manifest.json',
          mimeType: 'application/json',
          bytes: manifestBytes,
          byteLength: manifestBytes.byteLength,
          sha256: sha256Bytes(manifestBytes),
        }
        publishArtifacts.push(manifestArtifact)
        const publishedOutput = await runtime.publishArtifacts(
          session.id,
          resolvedOutput,
          publishArtifacts,
          force,
        )
        const manifestPath = path.join(publishedOutput, 'qc-manifest.json')
        return success('render_label_qc', {
          outputDir: publishedOutput,
          manifestPath,
          revision,
          modelFingerprint: inspection.fingerprint,
          preset,
          artifacts: [
            ...manifest.artifacts.map((artifact) => ({
              ...artifact,
              path: path.join(publishedOutput, artifact.path),
            })),
            publicArtifact(manifestArtifact, manifestPath),
          ],
          validation: evidence.data.validation,
        }, {
          sessionId: session.id,
          warnings: [...inspected.warnings, ...applied.warnings, ...evidence.warnings],
        })
      } catch (error) {
        return failure('render_label_qc', error, { sessionId: session?.id })
      }
    },

    async review({
      inputPath,
      glbPath,
      outputDir,
      width = 1600,
      height = 1600,
      force = false,
    }) {
      let session
      try {
        if (!Number.isInteger(width) || width < 1 || width > 4096
          || !Number.isInteger(height) || height < 1 || height > 4096) {
          throw reviewUsageError('Review dimensions must be integers from 1 to 4096')
        }
        progress('Resolving approved review evidence')
        const sources = await resolveReviewSources(rootPolicy, inputPath, glbPath, outputDir, force)
        const initial = await readReviewSnapshot(sources, { parse: true })
        const initialDesignArtifacts = await readDesignArtifactSnapshot(sources, initial.designReviewManifest.value, { includeBase64: true })
        const project = inspectProject(initial.input.value)
        const areas = reviewAreas(initial.input.value)
        const inputBinding = {
          kind: project.kind,
          revision: project.revision,
          sha256: initial.hashes.input,
        }
        const designGate = {
          handoff: initial.handoff.value,
          blueprintJson: initial.blueprint.text,
          designReviewManifestJson: initial.designReviewManifest.text,
          currentDocumentJson: initial.input.text,
          designReviewArtifacts: initialDesignArtifacts.map(({ path: artifactPath, base64 }) => ({ path: artifactPath, base64 })),
        }

        session = await runtime.createSession({
          glbBytes: initial.modelBytes,
          modelName: path.basename(sources.model),
        })
        progress('Loading model in browser renderer')
        const inspected = await loadSessionModel(runtime, session)
        const modelFingerprint = inspected.data.fingerprint
        if (typeof modelFingerprint !== 'string' || !modelFingerprint) {
          throw reviewUsageError('Browser model inspection did not return a fingerprint')
        }
        progress('Applying label design for clean review')
        const applied = isLabelProjectValue(initial.input.value)
          ? unwrapBridge(await runtime.callBridge(session, 'applyProject', { project: initial.input.value }))
          : unwrapBridge(await runtime.callBridge(session, 'applySpec', {
              spec: initial.input.value,
              assetUrls: await addSpecAssets(runtime, session, initial.input.value, path.dirname(sources.input)),
            }))
        unwrapBridge(await runtime.callBridge(session, 'waitForReady', { timeoutMs: 60_000 }))
        progress('Capturing clean production-review evidence')
        const rendered = unwrapBridge(await runtime.callBridge(session, 'renderReviewEvidence', {
          width,
          height,
          designGate,
        }))
        const evidence = rendered.data
        if (evidence.blueprintRevision !== initial.blueprint.value?.revision
          || evidence.blueprintSha256 !== initial.hashes.blueprint
          || evidence.designReviewManifestSha256 !== initial.hashes.designReviewManifest
          || evidence.modelFingerprint !== modelFingerprint
          || evidence.validation?.ready !== true || evidence.fidelity?.pass !== true) {
          throw staleReviewError('Captured review evidence does not bind the current approved production gate')
        }
        if (typeof evidence.resolvedProjectJson !== 'string'
          || evidence.resolvedProjectJson.length < 1
          || evidence.resolvedProjectJson.length > MAX_REVIEW_JSON_BYTES) {
          throw staleReviewError('Captured review evidence is missing the bounded resolved Project')
        }
        const resolvedProjectBytes = new TextEncoder().encode(evidence.resolvedProjectJson)
        if (resolvedProjectBytes.byteLength > MAX_REVIEW_JSON_BYTES) {
          throw staleReviewError('Captured resolved Project exceeds the bounded review size')
        }
        const resolvedProject = decodeReviewJson(resolvedProjectBytes, 'Resolved review Project').value
        const resolvedInspection = inspectProject(resolvedProject)
        if (resolvedInspection.kind !== 'label-project-v3'
          || JSON.stringify(applied.data.project) !== evidence.resolvedProjectJson
          || !/^[a-f0-9]{64}$/.test(evidence.resolvedProjectAreaTargetsSha256 ?? '')) {
          throw staleReviewError('Captured resolved Project does not match the exact applied Project')
        }
        const resolvedProjectBinding = {
          path: 'resolved-project.lbl.json',
          revision: revisionOf(resolvedProject),
          sha256: sha256Bytes(resolvedProjectBytes),
          areaTargetsSha256: evidence.resolvedProjectAreaTargetsSha256,
        }
        if (runtime.browserErrors(session.id).length > 0) {
          const error = new Error(`Browser reported errors: ${runtime.browserErrors(session.id).join('; ')}`)
          error.code = 'BROWSER_NOT_READY'
          throw error
        }

        progress('Sealing provisional review evidence')
        await runtime.confirmReviewEvidence(session.id, evidence.confirmation)
        const receipts = new Map(evidence.confirmation.artifacts.map((artifact) => [artifact.resultId, artifact]))
        if (receipts.size !== evidence.views.length || evidence.confirmation.artifacts.length !== evidence.views.length) {
          throw reviewUsageError('Review confirmation does not exactly match the captured views')
        }
        progress('Reading exact sealed review bytes')
        const artifacts = []
        for (const view of evidence.views) {
          const receipt = receipts.get(view.id)
          if (!receipt) throw reviewUsageError(`Review confirmation is missing view: ${view.id}`)
          artifacts.push(await runtime.readReviewArtifact(session.id, view, receipt))
        }
        if (runtime.browserErrors(session.id).length > 0) {
          const error = new Error(`Browser reported errors: ${runtime.browserErrors(session.id).join('; ')}`)
          error.code = 'BROWSER_NOT_READY'
          throw error
        }

        assertReviewSnapshot(initial, await readReviewSnapshot(sources), 'before-staging')
        assertDesignArtifactSnapshot(initialDesignArtifacts, await readDesignArtifactSnapshot(sources, initial.designReviewManifest.value), 'before-staging')
        const manifest = validateReviewManifest(buildReviewManifest({
          createdAt: new Date().toISOString(),
          input: inputBinding,
          resolvedProject: resolvedProjectBinding,
          areas,
          evidence,
          artifacts,
        }), { input: inputBinding, resolvedProject: resolvedProjectBinding, resolvedProjectBytes, areas, evidence, artifacts })
        const paths = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact.path]))
        const publicationArtifacts = artifacts.map((artifact) => ({
          ...artifact,
          relativePath: paths.get(artifact.id),
        }))
        publicationArtifacts.push({
          id: 'resolved-project',
          fileName: resolvedProjectBinding.path,
          relativePath: resolvedProjectBinding.path,
          mimeType: 'application/json',
          byteLength: resolvedProjectBytes.byteLength,
          sha256: resolvedProjectBinding.sha256,
          bytes: resolvedProjectBytes,
        })
        const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
        publicationArtifacts.push({
          id: 'review-manifest',
          fileName: 'review-manifest.json',
          relativePath: 'review-manifest.json',
          mimeType: 'application/json',
          byteLength: manifestBytes.byteLength,
          sha256: sha256Bytes(manifestBytes),
          bytes: manifestBytes,
        })
        const validationContext = { input: inputBinding, resolvedProject: resolvedProjectBinding, resolvedProjectBytes, areas, evidence, artifacts }
        const publishedOutput = await runtime.publishArtifacts(
          session.id,
          sources.output,
          publicationArtifacts,
          force,
          {
            rejectConcurrent: true,
            validateStaged: (directory) => validateReviewDirectory(directory, validationContext),
            beforeCommit: async (directory) => {
              assertReviewSnapshot(initial, await readReviewSnapshot(sources), 'before-final-rename')
              assertDesignArtifactSnapshot(initialDesignArtifacts, await readDesignArtifactSnapshot(sources, initial.designReviewManifest.value), 'before-final-rename')
              await validateReviewDirectory(directory, validationContext)
            },
            validatePublished: (directory) => validateReviewDirectory(directory, validationContext),
          },
        )
        const manifestPath = path.join(publishedOutput, 'review-manifest.json')
        return success('render_label_review', {
          outputDir: publishedOutput,
          manifestPath,
          revision: inputBinding.revision,
          modelFingerprint,
          artifacts: manifest.artifacts.map((artifact) => ({
            ...artifact,
            path: path.join(publishedOutput, artifact.path),
          })),
          validation: evidence.validation,
          fidelity: evidence.fidelity,
        }, {
          sessionId: session.id,
          warnings: [...inspected.warnings, ...applied.warnings, ...rendered.warnings],
        })
      } catch (error) {
        return failure('render_label_review', error, { sessionId: session?.id })
      }
    },

    async preview({ inputPath, glbPath, outputPath, view = '3d' }) {
      const staging = path.join(
        path.dirname(outputPath),
        `.${sanitizeArtifactName(path.basename(outputPath))}.${randomBytes(8).toString('hex')}.artifacts`,
      )
      try {
        await assertOutputAvailable(runtime, outputPath, false)
        const result = await this.apply({ specPath: inputPath, glbPath, outputDir: staging, force: false })
        if (!result.ok) return result
        const artifact = runtime.getArtifacts(result.sessionId).find((candidate) => candidate.id === 'preview-3d')
        if (!artifact) throw new Error('Rendered preview artifact is missing')
        const published = await runtime.publishArtifactFile(result.sessionId, outputPath, artifact, false)
        return success('render_label_preview', {
          preview: { ...publicArtifact(artifact, published), path: published },
          view,
        }, { sessionId: result.sessionId, warnings: result.warnings })
      } catch (error) {
        return failure('render_label_preview', error)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    },

    async export({ projectPath, glbPath, outputDir, force = false }) {
      return this.apply({ specPath: projectPath, glbPath, outputDir, force })
    },

    async open({ inputPath, glbPath }) {
      let session
      try {
        const input = await readJsonInput(rootPolicy, { inputPath })
        session = await runtime.createSession({ glbPath })
        await loadSessionModel(runtime, session)
        if (isLabelProjectValue(input.value)) {
          unwrapBridge(await runtime.callBridge(session, 'applyProject', { project: input.value }))
        } else {
          const validation = await validateSpecValue(input.value)
          if (!validation.valid) {
            const validationError = new Error('Label Spec schema validation failed')
            validationError.code = 'INVALID_LABEL_SPEC'
            validationError.details = { issues: validation.issues }
            throw validationError
          }
          const assetUrls = await addSpecAssets(runtime, session, input.value, input.baseDir)
          unwrapBridge(await runtime.callBridge(session, 'applySpec', { spec: input.value, assetUrls }))
        }
        const url = await runtime.openEditor(session)
        return success('open_label_editor', { url, keepAlive: true }, { sessionId: session.id })
      } catch (error) {
        return failure('open_label_editor', error, { sessionId: session?.id })
      }
    },
  }
}
