import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { register } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { failure, success } from './envelope.mjs'
import { assertNoSymlinkPath, readBoundedRegularFile, snapshotRegularDirectory } from './bounded-file-reader.mjs'

register(pathToFileURL(path.join(import.meta.dirname, 'typescript-loader.mjs')), import.meta.url)

const MAX_REQUEST_BYTES = 256 * 1024
const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_MODEL_BYTES = 256 * 1024 * 1024
const allowedKeys = new Set([
  'version', 'gate', 'evidenceRoot', 'currentDocument', 'handoff', 'blueprint', 'designReviewManifest',
  'designReviewEvidenceRoot', 'designApprovalRecord', 'productionReviewManifest',
  'productionReviewEvidenceRoot', 'productionApprovalRecord', 'model',
])

function gateError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details) error.details = details
  return error
}

function json(bytes, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (cause) {
    throw gateError('INVALID_USAGE', `${label} must be valid UTF-8 JSON`, { cause: cause instanceof Error ? cause.message : String(cause) })
  }
}

function requirePath(request, key) {
  const value = request[key]
  if (typeof value !== 'string' || !value) throw gateError('INVALID_USAGE', `Gate request requires ${key}`)
  return value
}

async function boundedFile(root, relativePath, label, maxBytes = MAX_JSON_BYTES) {
  const absolute = await assertNoSymlinkPath(root, relativePath, {
    label, makeError: (code, message) => gateError(code, message),
  })
  return readBoundedRegularFile(absolute, {
    label, maxBytes, code: 'INVALID_USAGE', makeError: (code, message) => gateError(code, message),
  })
}

async function artifactReader(root, relativePath, label) {
  const absolute = path.resolve(root, relativePath)
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw gateError('PATH_NOT_ALLOWED', `${label} is outside evidenceRoot`)
  }
  const info = await lstat(absolute).catch(() => undefined)
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw gateError('PATH_NOT_ALLOWED', `${label} must be a real directory`)
  const entries = await snapshotRegularDirectory(absolute, {
    label, maxFiles: 513, maxDepth: 8, maxFileBytes: MAX_JSON_BYTES,
    maxTotalBytes: 128 * 1024 * 1024, makeError: (code, message) => gateError(code, message),
  })
  const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]))
  return {
    list: () => [...byPath.keys()],
    read: (artifactPath) => {
      const bytes = byPath.get(artifactPath)
      if (!bytes) throw gateError('DIGEST_MISMATCH', `Missing evidence artifact: ${artifactPath}`)
      return bytes
    },
  }
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

export async function runWorkflowGate(kind, requestPath, options = {}) {
  try {
    const requestAbsolute = path.resolve(requestPath)
    const requestInfo = await lstat(requestAbsolute).catch(() => undefined)
    if (!requestInfo || requestInfo.isSymbolicLink() || !requestInfo.isFile()) throw gateError('PATH_NOT_ALLOWED', 'Gate request must be a regular file and not a symlink')
    if (Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0) {
      const allowed = options.allowedRoots.some((root) => {
        const relative = path.relative(path.resolve(root), requestAbsolute)
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      })
      if (!allowed) throw gateError('PATH_NOT_ALLOWED', 'Gate request is outside allowed roots')
    }
    const requestBytes = (await readBoundedRegularFile(requestAbsolute, {
      label: 'Gate request', maxBytes: MAX_REQUEST_BYTES, code: 'INVALID_USAGE',
      makeError: (code, message) => gateError(code, message),
    })).bytes
    const request = json(requestBytes, 'Gate request')
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || request.version !== 1 || request.gate !== kind
      || Object.keys(request).some((key) => !allowedKeys.has(key))) {
      throw gateError('INVALID_USAGE', `Gate request must be an exact ${kind} v1 request`)
    }
    const requestRoot = path.dirname(requestAbsolute)
    const evidenceRootRelative = requirePath(request, 'evidenceRoot')
    const evidenceRoot = path.resolve(requestRoot, evidenceRootRelative)
    const rootRelative = path.relative(requestRoot, evidenceRoot)
    if (rootRelative === '..' || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) {
      throw gateError('PATH_NOT_ALLOWED', 'evidenceRoot must stay below the request directory')
    }
    const rootInfo = await lstat(evidenceRoot).catch(() => undefined)
    if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw gateError('PATH_NOT_ALLOWED', 'evidenceRoot must be a real directory')
    const currentDocument = await boundedFile(evidenceRoot, requirePath(request, 'currentDocument'), 'Current document')
    const handoff = await boundedFile(evidenceRoot, requirePath(request, 'handoff'), 'Editor handoff')
    const blueprint = await boundedFile(evidenceRoot, requirePath(request, 'blueprint'), 'Layout blueprint')
    const designReviewManifest = await boundedFile(evidenceRoot, requirePath(request, 'designReviewManifest'), 'Design-review manifest')
    const designReviewArtifacts = await artifactReader(evidenceRoot, requirePath(request, 'designReviewEvidenceRoot'), 'Design-review evidence root')
    const designApprovalRecord = request.designApprovalRecord === undefined
      ? undefined
      : json((await boundedFile(evidenceRoot, requirePath(request, 'designApprovalRecord'), 'Design approval record')).bytes, 'Design approval record')
    const contracts = await import('../../src/agent/designContracts.ts')
    const shared = {
      handoff: json(handoff.bytes, 'Editor handoff'),
      blueprint: { read: () => blueprint.bytes },
      designReviewManifest: { read: () => designReviewManifest.bytes },
      designReviewArtifacts,
      currentDocument: { read: () => currentDocument.bytes },
    }
    if (kind === 'design') {
      const result = await contracts.verifyDesignGate({
        ...shared, ...(designApprovalRecord === undefined ? {} : { approvalRecord: designApprovalRecord }),
      })
      return success('gate_design', result)
    }
    const productionReviewManifest = await boundedFile(evidenceRoot, requirePath(request, 'productionReviewManifest'), 'Production review manifest')
    const productionReviewArtifacts = await artifactReader(evidenceRoot, requirePath(request, 'productionReviewEvidenceRoot'), 'Production-review evidence root')
    const productionApprovalRecord = json(
      (await boundedFile(evidenceRoot, requirePath(request, 'productionApprovalRecord'), 'Production approval record')).bytes,
      'Production approval record',
    )
    const model = await boundedFile(evidenceRoot, requirePath(request, 'model'), 'Current GLB model', MAX_MODEL_BYTES)
    const result = await contracts.verifyProductionGate({
      ...shared,
      approvalRecord: productionApprovalRecord,
      ...(designApprovalRecord === undefined ? {} : { designApprovalRecord }),
      productionReviewManifest: { read: () => productionReviewManifest.bytes },
      productionReviewArtifacts,
      modelFingerprint: sha256(model.bytes),
    })
    return success('gate_production', result)
  } catch (error) {
    return failure(`gate_${kind}`, error)
  }
}
