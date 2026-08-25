import Ajv2020 from 'ajv/dist/2020.js'
import { randomBytes } from 'node:crypto'
import { open, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { failure, success } from './envelope.mjs'
import { publishFileAtomically, resolveAllowedOutputPath, resolveAllowedPath, sanitizeArtifactName, sha256Bytes } from './files.mjs'
import { inspectProject, patchLabelSpec, revisionOf } from './project-control.mjs'
import { buildQcManifest, parseQcCameraConfig, qcArtifactRelativePath, validateQcManifest } from './qc-output.mjs'
import { startLivePreview } from './live-preview.mjs'

const schemaPath = path.resolve(import.meta.dirname, '../../src/agent/label-spec-v2.schema.json')

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
