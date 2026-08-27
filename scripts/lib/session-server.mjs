import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { sanitizeArtifactName, sha256Bytes } from './files.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
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
    if (length > maxBytes) throw new Error('Upload exceeds byte limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeStaticPath(root, pathname) {
  const relative = pathname === '/editor/' || pathname === '/editor'
    ? 'index.html'
    : pathname.replace(/^\/editor\//, '').replace(/^\//, '')
  const target = path.resolve(root, relative)
  const rel = path.relative(path.resolve(root), target)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
  return target
}

export async function createSessionServer({ editorRoot, maxUploadBytes = 128 * 1024 * 1024 } = {}) {
  if (!editorRoot) throw new Error('editorRoot is required')
  const sessions = new Map()

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
          if (request.method === 'PUT') {
            const id = parts[5]
            if (!id || !/^[A-Za-z0-9._-]{1,160}$/.test(id)) return json(response, 400, { ok: false, error: 'Invalid artifact id' })
            if (session.artifacts.has(id)) return json(response, 409, { ok: false, error: 'Artifact already exists' })
            const batch = session.stagedArtifacts.get(batchId) ?? new Map()
            if (batch.has(id)) return json(response, 409, { ok: false, error: 'Artifact already staged' })
            const resultId = String(request.headers['x-artifact-result-id'] ?? id)
            if (!/^[A-Za-z0-9._-]{1,160}$/.test(resultId)
              || [...batch.values()].some((artifact) => artifact.resultId === resultId)) {
              return json(response, 400, { ok: false, error: 'Invalid or duplicate artifact result id' })
            }
            const bytes = await readBody(request, maxUploadBytes)
            const encodedName = request.headers['x-artifact-file-name']
            const decodedName = typeof encodedName === 'string' ? decodeURIComponent(encodedName) : id
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
            session.stagedArtifacts.set(batchId, batch)
            const { bytes: _bytes, ...descriptor } = artifact
            json(response, 201, { ok: true, ...descriptor })
            return
          }
          if (request.method === 'POST' && parts[5] === 'commit') {
            const body = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8'))
            const artifactIds = Array.isArray(body?.artifactIds) ? body.artifactIds : null
            const resultIds = Array.isArray(body?.resultIds) ? body.resultIds : artifactIds
            const batch = session.stagedArtifacts.get(batchId)
            if (!batch || !artifactIds || artifactIds.length !== batch.size
              || !resultIds || resultIds.length !== batch.size
              || artifactIds.some((id, index) => typeof id !== 'string' || id !== [...batch.keys()][index])
              || resultIds.some((id, index) => typeof id !== 'string' || id !== [...batch.values()][index].resultId)) {
              return json(response, 409, { ok: false, error: 'Artifact batch is incomplete or mismatched' })
            }
            if (artifactIds.some((id) => session.artifacts.has(id))) {
              return json(response, 409, { ok: false, error: 'Artifact already exists' })
            }
            const committed = new Map(batch)
            const prior = new Map()
            for (const [id, artifact] of committed) {
              const previous = session.currentArtifactsByResultId.get(artifact.resultId)
              prior.set(artifact.resultId, previous)
              if (previous) {
                session.artifacts.delete(previous.id)
                if (previous.batchId) session.committedArtifactBatches.delete(previous.batchId)
              }
              session.artifacts.set(id, artifact)
              session.currentArtifactsByResultId.set(artifact.resultId, artifact)
            }
            session.committedArtifactBatches.set(batchId, { committed, prior })
            session.stagedArtifacts.delete(batchId)
            json(response, 201, { ok: true, batchId, artifactIds, resultIds })
            return
          }
          if (request.method === 'DELETE' && parts.length === 5) {
            session.stagedArtifacts.delete(batchId)
            const transaction = session.committedArtifactBatches.get(batchId)
            if (transaction) {
              for (const [id, artifact] of transaction.committed) {
                if (session.artifacts.get(id) === artifact) {
                  session.artifacts.delete(id)
                  const previous = transaction.prior.get(artifact.resultId)
                  if (previous) {
                    session.artifacts.set(previous.id, previous)
                    session.currentArtifactsByResultId.set(artifact.resultId, previous)
                  } else {
                    session.currentArtifactsByResultId.delete(artifact.resultId)
                  }
                }
              }
              session.committedArtifactBatches.delete(batchId)
            }
            json(response, 200, { ok: true, batchId, purged: true })
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
          json(response, 201, artifact)
          return
        }
        if (parts[2] === 'artifact' && request.method === 'GET') {
          const artifact = session.artifacts.get(parts[3])
          if (!artifact) return json(response, 404, { ok: false, error: 'Artifact not found' })
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
      const target = safeStaticPath(editorRoot, url.pathname)
      if (!target) return json(response, 403, { ok: false, error: 'Forbidden' })
      const file = await stat(target).then(() => target, () => null)
      const fallback = file ?? path.join(editorRoot, 'index.html')
      const info = await stat(fallback)
      response.writeHead(200, {
        'content-type': MIME[path.extname(fallback)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; img-src 'self' blob: data:; font-src 'self' data:",
        'x-content-type-options': 'nosniff',
      })
      if (request.method === 'HEAD') response.end()
      else createReadStream(fallback).pipe(response)
    } catch (error) {
      json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Session server did not bind a TCP port')
  const origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    createSession() {
      const session = {
        id: randomBytes(12).toString('base64url'),
        token: randomBytes(32).toString('base64url'),
        assets: new Map(),
        artifacts: new Map(),
        stagedArtifacts: new Map(),
        committedArtifactBatches: new Map(),
        currentArtifactsByResultId: new Map(),
      }
      sessions.set(session.id, session)
      return { id: session.id, token: session.token }
    },
    addAsset(sessionId, { id = randomBytes(10).toString('base64url'), bytes, mimeType = 'application/octet-stream', fileName = id }) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`Unknown session: ${sessionId}`)
      session.assets.set(id, { id, bytes: Buffer.from(bytes), mimeType, fileName: sanitizeArtifactName(fileName) })
      return `${origin}/session/${session.id}/asset/${encodeURIComponent(id)}?token=${session.token}`
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
      sessions.delete(sessionId)
    },
    async close() {
      sessions.clear()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
