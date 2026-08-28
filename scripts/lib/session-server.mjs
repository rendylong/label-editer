import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { snapshotEditorDist, takeEditorDistSnapshot } from './build-fingerprint.mjs'
import { sanitizeArtifactName, sha256Bytes } from './files.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function validToken(expected, presented) {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(request, maxBytes) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > maxBytes) {
      const error = new Error('Upload exceeds byte limit')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeStaticKey(pathname) {
  if (typeof pathname !== 'string' || Buffer.byteLength(pathname) > 4096) return null
  const encoded = pathname === '/editor/' || pathname === '/editor'
    ? 'index.html'
    : pathname.replace(/^\/editor\//, '').replace(/^\//, '')
  let relative
  try {
    relative = decodeURIComponent(encoded)
  } catch {
    return null
  }
  if (!relative || relative.includes('\\') || relative.includes('\0') || Buffer.byteLength(relative) > 2048) {
    return relative === '' ? 'index.html' : null
  }
  const segments = relative.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

export async function createSessionServer({
  editorRoot,
  editorSnapshot,
  maxEditorAssetBytes,
  maxEditorSnapshotBytes,
  maxEditorAssetCount,
  maxEditorAssetPathBytes,
  maxEditorTreeDepth,
  maxEditorTreeEntries,
  maxUploadBytes = 128 * 1024 * 1024,
  maxReviewBatchBytes = 128 * 1024 * 1024,
  maxReviewBatchArtifacts = 131,
  maxSessionAssetBytes = 256 * 1024 * 1024,
  reviewLeaseMs = 120_000,
  now = () => performance.now(),
} = {}) {
  if (!editorRoot) throw new Error('editorRoot is required')
  if (!Number.isSafeInteger(maxReviewBatchBytes) || maxReviewBatchBytes < 1
    || !Number.isSafeInteger(maxReviewBatchArtifacts) || maxReviewBatchArtifacts < 1
    || !Number.isSafeInteger(maxSessionAssetBytes) || maxSessionAssetBytes < 1
    || !Number.isSafeInteger(reviewLeaseMs) || reviewLeaseMs < 1
    || typeof now !== 'function') throw new Error('Invalid session resource limits')
  const assetLimitOptions = {
    maxEditorAssetBytes,
    maxEditorSnapshotBytes,
    maxEditorAssetCount,
    maxEditorAssetPathBytes,
    maxEditorTreeDepth,
    maxEditorTreeEntries,
  }
  const captured = editorSnapshot ?? (await snapshotEditorDist(editorRoot, assetLimitOptions)).snapshot
  const staticAssets = takeEditorDistSnapshot(captured)
  const sessions = new Map()

  // Request bodies are asynchronous, so every state-dependent predicate and its
  // mutation must run in one per-session critical section after the body is read.
  function serializeSessionMutation(session, mutation) {
    const operation = session.mutationTail.then(mutation, mutation)
    session.mutationTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  function clearReviewLeaseTimer(lease) {
    if (lease.timer !== undefined) clearTimeout(lease.timer)
    delete lease.timer
  }

  function settlementKey(batchId, generation) {
    return `${batchId}\0${generation}`
  }

  function rememberReviewSettlement(session, lease, action, payload, confirmationSha256) {
    const key = settlementKey(lease.batchId, lease.generation)
    session.reviewSettlements.delete(key)
    session.reviewSettlements.set(key, {
      leaseToken: lease.leaseToken,
      action,
      payload,
      ...(confirmationSha256 ? { confirmationSha256 } : {}),
    })
    while (session.reviewSettlements.size > 32) {
      session.reviewSettlements.delete(session.reviewSettlements.keys().next().value)
    }
  }

  function rollbackReviewLease(session, lease, { remember = true } = {}) {
    clearReviewLeaseTimer(lease)
    if (lease.phase === 'committed' || lease.phase === 'prepared') {
      for (const artifact of lease.committed.values()) session.artifacts.delete(artifact.id)
      session.currentArtifactsByResultId.clear()
      for (const [resultId, artifact] of lease.prior) {
        session.artifacts.set(artifact.id, artifact)
        session.currentArtifactsByResultId.set(resultId, artifact)
      }
    }
    if (session.reviewLease === lease) session.reviewLease = null
    const payload = { ok: true, batchId: lease.batchId, generation: lease.generation, aborted: true }
    if (remember) rememberReviewSettlement(session, lease, 'abort', payload)
    return payload
  }

  function sealReviewLease(session, lease, { remember = true, action = 'confirm', payload, confirmationSha256 } = {}) {
    clearReviewLeaseTimer(lease)
    if (session.reviewLease === lease) session.reviewLease = null
    const settlement = payload ?? { ok: true, batchId: lease.batchId, generation: lease.generation, finalized: true }
    if (remember) rememberReviewSettlement(session, lease, action, settlement, confirmationSha256)
    return settlement
  }

  function finishExpiredReviewLease(session, lease) {
    if (session.reviewLease !== lease) return
    // A prepared receipt proves that the client read and hashed the candidate,
    // not that the caller crossed its final synchronous freshness barrier. Until
    // an explicit receipt-bound confirmation seals it, expiry must restore the
    // prior committed set.
    rollbackReviewLease(session, lease)
  }

  function scheduleReviewLeaseTimer(session, lease) {
    clearReviewLeaseTimer(lease)
    const check = () => {
      if (session.reviewLease !== lease) return
      const remaining = lease.deadline - now()
      if (remaining > 0) {
        lease.timer = setTimeout(check, Math.max(1, Math.ceil(remaining)))
        return
      }
      finishExpiredReviewLease(session, lease)
    }
    lease.timer = setTimeout(check, Math.max(1, Math.ceil(lease.deadline - now())))
  }

  function renewReviewLease(session, lease) {
    lease.deadline = now() + reviewLeaseMs
    lease.expiresAt = Date.now() + reviewLeaseMs
    scheduleReviewLeaseTimer(session, lease)
  }

  function expireReviewLeaseAtBoundary(session) {
    const lease = session.reviewLease
    if (lease && now() >= lease.deadline) finishExpiredReviewLease(session, lease)
  }

  function requestLease(session, batchId, request, body, phases, { renew = true } = {}) {
    expireReviewLeaseAtBoundary(session)
    const lease = session.reviewLease
    const token = body?.leaseToken ?? request.headers['x-artifact-lease-token']
    const generation = body?.generation ?? Number(request.headers['x-artifact-generation'])
    if (!lease || lease.batchId !== batchId || !validToken(lease.leaseToken, token)
      || generation !== lease.generation) return null
    if (phases && !phases.includes(lease.phase)) return null
    if (renew) renewReviewLease(session, lease)
    return lease
  }

  function replayReviewSettlement(session, batchId, request, body, action, confirmationSha256) {
    const token = body?.leaseToken ?? request.headers['x-artifact-lease-token']
    const generation = body?.generation ?? Number(request.headers['x-artifact-generation'])
    if (!Number.isSafeInteger(generation) || generation < 1) return null
    const settled = session.reviewSettlements.get(settlementKey(batchId, generation))
    if (!settled || settled.action !== action || !validToken(settled.leaseToken, token)
      || (action === 'confirm' && settled.confirmationSha256 !== confirmationSha256)) return null
    return settled.payload
  }

  function receiptArtifact(artifact) {
    return {
      id: artifact.id,
      resultId: artifact.resultId,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      mimeType: artifact.mimeType,
      ...(artifact.width === undefined ? {} : { width: artifact.width }),
      ...(artifact.height === undefined ? {} : { height: artifact.height }),
    }
  }

  function matchingReceipt(candidate, artifact) {
    const expected = receiptArtifact(artifact)
    return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Object.keys(candidate).length === Object.keys(expected).length
      && Object.keys(candidate).every((key) => Object.hasOwn(expected, key))
      && Object.entries(expected).every(([key, value]) => candidate[key] === value)
  }

  function confirmationIdentity(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 4
      || !Object.hasOwn(body, 'leaseToken') || !Object.hasOwn(body, 'generation')
      || !Object.hasOwn(body, 'expiresAt') || !Object.hasOwn(body, 'artifacts')
      || !Array.isArray(body.artifacts)
      || typeof body.leaseToken !== 'string'
      || !Number.isSafeInteger(body.generation) || body.generation < 1
      || !Number.isSafeInteger(body.expiresAt) || body.expiresAt < 1
      || body.artifacts.length > maxReviewBatchArtifacts) return null
    return sha256Bytes(Buffer.from(JSON.stringify({
      generation: body.generation,
      expiresAt: body.expiresAt,
      artifacts: body.artifacts,
    })))
  }

  function confirmationMatchesExpected(body, expected) {
    return body.artifacts.length === expected.length
      && body.artifacts.every((candidate, index) => matchingReceipt(candidate, expected[index]))
  }

  function namespaceIsolated(session) {
    for (const [resultId, artifact] of session.currentArtifactsByResultId) {
      if (artifact.resultId !== resultId || session.artifacts.get(artifact.id) !== artifact) return false
      const alias = session.artifacts.get(resultId)
      if (alias && alias !== artifact) return false
    }
    return true
  }

  function stagedNamespaceAvailable(session, batch, id, resultId) {
    if (!namespaceIsolated(session)) return false
    if (session.artifacts.has(id) || session.currentArtifactsByResultId.has(id)) return false
    const resultAlias = session.artifacts.get(resultId)
    if (resultAlias && session.currentArtifactsByResultId.get(resultId) !== resultAlias) return false
    for (const artifact of batch.values()) {
      if (artifact.id === id || artifact.resultId === resultId
        || artifact.id === resultId || artifact.resultId === id) return false
    }
    return true
  }

  function stagedBatchNamespaceAvailable(session, committed) {
    if (!namespaceIsolated(session)) return false
    const staged = new Map()
    for (const [id, artifact] of committed) {
      if (!stagedNamespaceAvailable(session, staged, id, artifact.resultId)) return false
      staged.set(id, artifact)
    }
    return true
  }

  function committedNamespaceIsolated(session, committed) {
    if (!namespaceIsolated(session)) return false
    const ids = new Set()
    const resultIds = new Set()
    for (const [id, artifact] of committed) {
      if (ids.has(id) || resultIds.has(artifact.resultId) || ids.has(artifact.resultId) || resultIds.has(id)
        || session.artifacts.get(id) !== artifact
        || session.currentArtifactsByResultId.get(artifact.resultId) !== artifact) return false
      ids.add(id)
      resultIds.add(artifact.resultId)
    }
    return true
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] === 'session') {
        const session = sessions.get(parts[1])
        if (!session || !validToken(session.token, url.searchParams.get('token'))) {
          json(response, 403, { ok: false, error: 'Forbidden' })
          return
        }
        expireReviewLeaseAtBoundary(session)
        response.setHeader('cache-control', 'no-store')
        if (parts[2] === 'bootstrap' && request.method === 'GET') {
          json(response, 200, {
            token: session.token,
            artifactUploadBase: `/session/${session.id}/artifact`,
          })
          return
        }
        if (parts[2] === 'asset' && request.method === 'GET') {
          const asset = session.assets.get(parts[3])
          if (!asset) return json(response, 404, { ok: false, error: 'Asset not found' })
          response.writeHead(200, {
            'content-type': asset.mimeType,
            'content-length': asset.bytes.byteLength,
            'cache-control': 'no-store',
          })
          response.end(asset.bytes)
          return
        }
        if (parts[2] === 'artifact' && parts[3] === 'stage') {
          const batchId = parts[4]
          if (!batchId || !/^[A-Za-z0-9._-]{1,160}$/.test(batchId)) {
            return json(response, 400, { ok: false, error: 'Invalid artifact batch id' })
          }
          if (request.method === 'POST' && parts[5] === 'acquire') {
            const body = JSON.parse((await readBody(request, 1024)).toString('utf8') || '{}')
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
              return json(response, 400, { ok: false, error: 'Invalid lease request' })
            }
            const outcome = await serializeSessionMutation(session, () => {
              expireReviewLeaseAtBoundary(session)
              if (session.reviewLease || !namespaceIsolated(session)) {
                return { status: 409, payload: { ok: false, error: 'Review artifact lease is busy' } }
              }
              const lease = {
                batchId,
                leaseToken: randomBytes(32).toString('base64url'),
                generation: ++session.reviewGeneration,
                deadline: now() + reviewLeaseMs,
                expiresAt: Date.now() + reviewLeaseMs,
                phase: 'staging',
                staged: new Map(),
                stagedBytes: 0,
              }
              session.reviewLease = lease
              scheduleReviewLeaseTimer(session, lease)
              return { status: 201, payload: {
                ok: true, batchId, leaseToken: lease.leaseToken,
                generation: lease.generation, expiresAt: lease.expiresAt,
              } }
            })
            json(response, outcome.status, outcome.payload)
            return
          }
          if (request.method === 'PUT') {
            const id = parts[5]
            if (!id || !/^[A-Za-z0-9._-]{1,160}$/.test(id)) return json(response, 400, { ok: false, error: 'Invalid artifact id' })
            const resultId = String(request.headers['x-artifact-result-id'] ?? id)
            if (!/^[A-Za-z0-9._-]{1,160}$/.test(resultId)) {
              return json(response, 400, { ok: false, error: 'Invalid artifact result id' })
            }
            const bytes = await readBody(request, Math.min(maxUploadBytes, maxReviewBatchBytes))
            const encodedName = request.headers['x-artifact-file-name']
            const decodedName = typeof encodedName === 'string' ? decodeURIComponent(encodedName) : id
            const outcome = await serializeSessionMutation(session, () => {
              const lease = requestLease(session, batchId, request, undefined, ['staging'])
              if (!lease) return { status: 409, payload: { ok: false, error: 'Invalid or stale review artifact lease' } }
              const batch = lease.staged
              if (!stagedNamespaceAvailable(session, batch, id, resultId)) {
                return { status: 409, payload: { ok: false, error: 'Artifact id or result id conflicts with the session namespace' } }
              }
              if (batch.size >= maxReviewBatchArtifacts) {
                return { status: 413, payload: { ok: false, error: 'Review artifact count exceeds limit' } }
              }
              if (bytes.byteLength > maxReviewBatchBytes - lease.stagedBytes) {
                return { status: 413, payload: { ok: false, error: 'Review artifact bytes exceed limit' } }
              }
              const artifact = {
                id,
                resultId,
                batchId,
                fileName: sanitizeArtifactName(decodedName),
                mimeType: String(request.headers['content-type'] ?? 'application/octet-stream').split(';')[0],
                bytes,
                byteLength: bytes.byteLength,
                sha256: sha256Bytes(bytes),
                width: Number(request.headers['x-artifact-width']) || undefined,
                height: Number(request.headers['x-artifact-height']) || undefined,
                areaId: typeof request.headers['x-artifact-area-id'] === 'string'
                  ? decodeURIComponent(request.headers['x-artifact-area-id'])
                  : undefined,
                channel: typeof request.headers['x-artifact-channel'] === 'string'
                  ? request.headers['x-artifact-channel']
                  : undefined,
                url: `${origin}/session/${session.id}/artifact/${encodeURIComponent(id)}?token=${session.token}`,
              }
              batch.set(id, artifact)
              lease.stagedBytes += bytes.byteLength
              const { bytes: _bytes, ...descriptor } = artifact
              return { status: 201, payload: { ok: true, ...descriptor, generation: lease.generation } }
            })
            json(response, outcome.status, outcome.payload)
            return
          }
          if (request.method === 'POST' && parts[5] === 'commit') {
            const body = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8'))
            const outcome = await serializeSessionMutation(session, () => {
              const lease = requestLease(session, batchId, request, body, ['staging'])
              const artifactIds = Array.isArray(body?.artifactIds) ? body.artifactIds : null
              const resultIds = Array.isArray(body?.resultIds) ? body.resultIds : artifactIds
              const batch = lease?.staged
              if (!lease || !batch || !artifactIds || artifactIds.length !== batch.size
                || !resultIds || resultIds.length !== batch.size
                || artifactIds.some((id, index) => typeof id !== 'string' || id !== [...batch.keys()][index])
                || resultIds.some((id, index) => typeof id !== 'string' || id !== [...batch.values()][index].resultId)) {
                return { status: 409, payload: { ok: false, error: 'Artifact batch is incomplete or mismatched' } }
              }
              if (artifactIds.some((id) => session.artifacts.has(id))) {
                return { status: 409, payload: { ok: false, error: 'Artifact already exists' } }
              }
              const committed = new Map(batch)
              if (!stagedBatchNamespaceAvailable(session, committed)) {
                return { status: 409, payload: { ok: false, error: 'Artifact namespace changed before commit' } }
              }
              const prior = new Map(session.currentArtifactsByResultId)
              for (const previous of prior.values()) session.artifacts.delete(previous.id)
              session.currentArtifactsByResultId.clear()
              for (const [id, artifact] of committed) {
                session.artifacts.set(id, artifact)
                session.currentArtifactsByResultId.set(artifact.resultId, artifact)
              }
              Object.assign(lease, { phase: 'committed', committed, prior })
              delete lease.staged
              delete lease.stagedBytes
              return { status: 201, payload: {
                ok: true, batchId, artifactIds, resultIds, generation: lease.generation,
              } }
            })
            json(response, outcome.status, outcome.payload)
            return
          }
          if (request.method === 'POST' && parts[5] === 'receipt') {
            const body = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8'))
            const outcome = await serializeSessionMutation(session, () => {
              const lease = requestLease(session, batchId, request, body, ['committed', 'prepared'])
              const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : null
              const committed = lease?.committed
              const expected = committed ? [...committed.values()] : []
              if (!lease || !committed || !artifacts || artifacts.length !== expected.length
                || artifacts.some((candidate, index) => {
                  const artifact = expected[index]
                  return !candidate || typeof candidate !== 'object' || Array.isArray(candidate)
                    || !matchingReceipt(candidate, artifact)
                })) {
                return { status: 409, payload: { ok: false, error: 'Artifact readback receipt is incomplete or mismatched' } }
              }
              lease.phase = 'prepared'
              return { status: 200, payload: {
                ok: true,
                batchId,
                generation: lease.generation,
                receipt: true,
                artifactIds: expected.map((artifact) => artifact.id),
                expiresAt: lease.expiresAt,
              } }
            })
            json(response, outcome.status, outcome.payload)
            return
          }
          if (request.method === 'POST' && parts[5] === 'confirm') {
            const body = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8'))
            const outcome = await serializeSessionMutation(session, () => {
              const identity = confirmationIdentity(body)
              const cached = Number.isSafeInteger(body?.generation)
                ? session.reviewSettlements.get(settlementKey(batchId, body.generation))
                : undefined
              if (cached) {
                const replay = identity
                  ? replayReviewSettlement(session, batchId, request, body, 'confirm', identity)
                  : null
                return replay
                  ? { status: 200, payload: replay }
                  : { status: 409, payload: { ok: false, error: 'Invalid or stale review artifact confirmation' } }
              }
              const active = session.reviewLease
              if (!active || active.batchId !== batchId || active.generation !== body?.generation) {
                return { status: 409, payload: { ok: false, error: 'Invalid or stale review artifact confirmation' } }
              }
              const expected = active.committed ? [...active.committed.values()] : []
              const lease = requestLease(session, batchId, request, body, ['prepared'], { renew: false })
              if (!lease) {
                return { status: 409, payload: { ok: false, error: 'Invalid or stale review artifact confirmation' } }
              }
              if (!identity || !confirmationMatchesExpected(body, expected) || body.expiresAt !== lease.expiresAt
                || !committedNamespaceIsolated(session, lease.committed)) {
                return { status: 409, payload: { ok: false, error: 'Review artifact confirmation is incomplete or mismatched' } }
              }
              const payload = {
                ok: true,
                batchId,
                generation: lease.generation,
                sealed: true,
                artifactIds: [...lease.committed.values()].map((artifact) => artifact.id),
                resultIds: [...lease.committed.values()].map((artifact) => artifact.resultId),
              }
              return { status: 200, payload: sealReviewLease(session, lease, {
                action: 'confirm', payload, confirmationSha256: identity,
              }) }
            })
            json(response, outcome.status, outcome.payload)
            return
          }
          if (request.method === 'POST' && parts[5] === 'finalize') {
            await readBody(request, 4096)
            json(response, 409, { ok: false, error: 'Receipt-bound review artifact confirmation is required' })
            return
          }
          if (request.method === 'DELETE' && parts.length === 5) {
            const outcome = await serializeSessionMutation(session, () => {
              const lease = requestLease(session, batchId, request, undefined, ['staging', 'committed', 'prepared'])
              if (!lease) {
                const replay = replayReviewSettlement(session, batchId, request, undefined, 'abort')
                return replay
                  ? { status: 200, payload: replay }
                  : { status: 409, payload: { ok: false, error: 'Invalid or stale review artifact lease' } }
              }
              return { status: 200, payload: rollbackReviewLease(session, lease) }
            })
            json(response, outcome.status, outcome.payload)
            return
          }
          json(response, 404, { ok: false, error: 'Artifact batch route not found' })
          return
        }
        if (parts[2] === 'artifact' && request.method === 'PUT') {
          const id = parts[3]
          if (!id || !/^[A-Za-z0-9._-]{1,160}$/.test(id)) return json(response, 400, { ok: false, error: 'Invalid artifact id' })
          const bytes = await readBody(request, maxUploadBytes)
          const encodedName = request.headers['x-artifact-file-name']
          const decodedName = typeof encodedName === 'string' ? decodeURIComponent(encodedName) : id
          const outcome = await serializeSessionMutation(session, () => {
            expireReviewLeaseAtBoundary(session)
            if (session.reviewLease) {
              return { status: 409, payload: { ok: false, error: 'Review artifact lease is busy' } }
            }
            if (session.artifacts.has(id) || session.currentArtifactsByResultId.has(id)) {
              return { status: 409, payload: { ok: false, error: 'Artifact id conflicts with review evidence' } }
            }
            const artifact = {
              id,
              fileName: sanitizeArtifactName(decodedName),
              mimeType: String(request.headers['content-type'] ?? 'application/octet-stream').split(';')[0],
              bytes,
              byteLength: bytes.byteLength,
              sha256: sha256Bytes(bytes),
              width: Number(request.headers['x-artifact-width']) || undefined,
              height: Number(request.headers['x-artifact-height']) || undefined,
              areaId: typeof request.headers['x-artifact-area-id'] === 'string'
                ? decodeURIComponent(request.headers['x-artifact-area-id'])
                : undefined,
              channel: typeof request.headers['x-artifact-channel'] === 'string'
                ? request.headers['x-artifact-channel']
                : undefined,
              url: `${origin}/session/${session.id}/artifact/${encodeURIComponent(id)}?token=${session.token}`,
            }
            session.artifacts.set(id, artifact)
            return { status: 201, payload: artifact }
          })
          json(response, outcome.status, outcome.payload)
          return
        }
        if (parts[2] === 'artifact' && request.method === 'GET') {
          const artifact = session.artifacts.get(parts[3])
          if (!artifact) return json(response, 404, { ok: false, error: 'Artifact not found' })
          if (artifact.batchId && session.reviewLease?.batchId === artifact.batchId
            && (session.reviewLease.phase === 'committed' || session.reviewLease.phase === 'prepared')) {
            const hasLeaseClaim = request.headers['x-artifact-lease-token'] !== undefined
              || request.headers['x-artifact-generation'] !== undefined
            if (hasLeaseClaim) {
              const lease = requestLease(session, artifact.batchId, request, undefined, ['committed', 'prepared'], { renew: false })
              if (!lease) return json(response, 409, { ok: false, error: 'Committed artifact readback requires its active lease' })
            } else if (session.reviewLease.phase === 'committed') {
              return json(response, 409, { ok: false, error: 'Committed artifact readback requires its active lease' })
            }
          }
          response.writeHead(200, {
            'content-type': artifact.mimeType,
            'content-length': artifact.byteLength,
            'cache-control': 'no-store',
            'x-artifact-id': artifact.id,
            'x-artifact-result-id': artifact.resultId ?? artifact.id,
            'x-artifact-sha256': artifact.sha256,
          })
          response.end(artifact.bytes)
          return
        }
        json(response, 404, { ok: false, error: 'Session route not found' })
        return
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        json(response, 405, { ok: false, error: 'Method not allowed' })
        return
      }
      const key = safeStaticKey(url.pathname)
      if (!key) return json(response, 403, { ok: false, error: 'Forbidden' })
      const assetKey = staticAssets.has(key) ? key : 'index.html'
      const bytes = staticAssets.read(assetKey)
      if (!bytes) return json(response, 404, { ok: false, error: 'Editor asset not found' })
      response.writeHead(200, {
        'content-type': MIME[path.extname(assetKey)] ?? 'application/octet-stream',
        'content-length': bytes.byteLength,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; img-src 'self' blob: data:; font-src 'self' data:",
        'x-content-type-options': 'nosniff',
      })
      if (request.method === 'HEAD') response.end()
      else response.end(bytes)
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
      json(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  let address
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    address = server.address()
    if (!address || typeof address === 'string') throw new Error('Session server did not bind a TCP port')
  } catch (error) {
    staticAssets.dispose()
    throw error
  }
  const origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    createSession() {
      const session = {
        id: randomBytes(12).toString('base64url'),
        token: randomBytes(32).toString('base64url'),
        assets: new Map(),
        assetBytes: 0,
        artifacts: new Map(),
        currentArtifactsByResultId: new Map(),
        reviewLease: null,
        reviewGeneration: 0,
        reviewSettlements: new Map(),
        mutationTail: Promise.resolve(),
      }
      sessions.set(session.id, session)
      return { id: session.id, token: session.token }
    },
    addAsset(sessionId, { id = randomBytes(10).toString('base64url'), bytes, mimeType = 'application/octet-stream', fileName = id }) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`Unknown session: ${sessionId}`)
      const byteLength = bytes?.byteLength
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxSessionAssetBytes) throw new Error('Session asset byte limit exceeded')
      const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const contentIdentity = sha256Bytes(Buffer.concat([Buffer.from(`${mimeType}\0`), content]))
      const versionId = `asset-${contentIdentity}`
      if (!session.assets.has(versionId)) {
        if (byteLength > maxSessionAssetBytes - session.assetBytes) throw new Error('Session asset byte limit exceeded')
        session.assets.set(versionId, {
          id: versionId, logicalId: id, bytes: Buffer.from(content), mimeType,
          fileName: sanitizeArtifactName(fileName), sha256: sha256Bytes(content),
        })
        session.assetBytes += byteLength
      }
      return `${origin}/session/${session.id}/asset/${encodeURIComponent(versionId)}?token=${session.token}`
    },
    getArtifacts(sessionId) {
      const session = sessions.get(sessionId)
      return session ? [...session.artifacts.values()].map((artifact) => ({
        ...artifact,
        internalId: artifact.id,
        id: artifact.resultId ?? artifact.id,
      })) : []
    },
    disposeSession(sessionId) {
      const session = sessions.get(sessionId)
      if (session?.reviewLease) clearReviewLeaseTimer(session.reviewLease)
      sessions.delete(sessionId)
    },
    async close() {
      for (const session of sessions.values()) {
        if (session.reviewLease) clearReviewLeaseTimer(session.reviewLease)
      }
      sessions.clear()
      try {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      } finally {
        staticAssets.dispose()
      }
    },
  }
}
