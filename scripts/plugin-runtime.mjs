import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createBrowserSessionManager } from './lib/browser-session.mjs'
import { captureFreshEditorBuild } from './lib/build-fingerprint.mjs'
import { normalizeGlb } from './lib/codec.mjs'
import { publishAtomically, publishFileAtomically, resolveAllowedOutputPath, resolveAllowedPath } from './lib/files.mjs'
import { createSessionServer } from './lib/session-server.mjs'

export async function createPluginRuntime(options = {}) {
  const pluginRoot = path.resolve(options.pluginRoot ?? path.join(import.meta.dirname, '..'))
  const allowedRoots = options.allowedRoots?.length ? options.allowedRoots : [process.cwd()]
  const editorRoot = path.resolve(options.editorRoot ?? path.join(pluginRoot, 'dist'))
  const verifiedBuild = options.editorRoot === undefined
    ? await captureFreshEditorBuild(pluginRoot, editorRoot)
    : undefined
  const server = await createSessionServer({ editorRoot, editorSnapshot: verifiedBuild?.snapshot })
  const browser = await createBrowserSessionManager({
    server,
    headless: options.headless !== false,
    launchOptions: options.launchOptions,
    pageQuery: options.browserQuery,
    beforeOpen: verifiedBuild?.assertCurrent,
  })
  const sessions = new Map()
  const cleanups = new Set()
  let closed = false
  const fetcher = options.fetcher ?? fetch

  function runtimeError(message, code = 'BROWSER_NOT_READY') {
    const error = new Error(message)
    error.code = code
    return error
  }

  function exactKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const actual = Object.keys(value).sort()
    const keys = [...expected].sort()
    return actual.length === keys.length && actual.every((key, index) => key === keys[index])
  }

  function validateReviewConfirmation(sessionId, confirmation) {
    if (!exactKeys(confirmation, ['sessionId', 'batchId', 'leaseToken', 'generation', 'expiresAt', 'artifacts'])
      || confirmation.sessionId !== sessionId
      || typeof confirmation.batchId !== 'string' || !confirmation.batchId
      || typeof confirmation.leaseToken !== 'string' || !confirmation.leaseToken
      || !Number.isSafeInteger(confirmation.generation) || confirmation.generation < 1
      || !Number.isSafeInteger(confirmation.expiresAt) || confirmation.expiresAt < 1
      || !Array.isArray(confirmation.artifacts) || confirmation.artifacts.length === 0) {
      throw runtimeError('Invalid review evidence confirmation', 'INVALID_USAGE')
    }
    for (const artifact of confirmation.artifacts) {
      if (!exactKeys(artifact, ['id', 'resultId', 'sha256', 'byteLength', 'mimeType', 'width', 'height'])
        || typeof artifact.id !== 'string' || !artifact.id
        || typeof artifact.resultId !== 'string' || !artifact.resultId
        || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1
        || artifact.mimeType !== 'image/png'
        || !Number.isSafeInteger(artifact.width) || artifact.width < 1 || artifact.width > 4096
        || !Number.isSafeInteger(artifact.height) || artifact.height < 1 || artifact.height > 4096) {
        throw runtimeError('Invalid review evidence confirmation artifact', 'INVALID_USAGE')
      }
    }
    return confirmation
  }

  async function createSession({ glbPath, glbBytes, modelName } = {}) {
    const rawBytes = glbBytes ?? (glbPath ? await readFile(await resolveAllowedPath(allowedRoots, glbPath)) : undefined)
    const normalized = rawBytes ? await normalizeGlb(new Uint8Array(rawBytes)) : undefined
    const identity = server.createSession()
    const session = {
      ...identity,
      modelName: modelName ?? (glbPath ? path.basename(glbPath) : 'model.glb'),
      codec: normalized?.codec,
      inputBytes: normalized?.bytes,
      inputUrl: undefined,
    }
    if (normalized) {
      session.inputUrl = server.addAsset(session.id, {
        id: 'model', bytes: normalized.bytes, mimeType: 'model/gltf-binary', fileName: session.modelName,
      })
    }
    sessions.set(session.id, session)
    return session
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) {
      const error = new Error(`Unknown or expired session: ${sessionId}`)
      error.code = 'INVALID_USAGE'
      throw error
    }
    return session
  }

  return {
    origin: server.origin,
    allowedRoots,
    createSession,
    getSession,
    addAsset(sessionId, asset) {
      return server.addAsset(sessionId, asset)
    },
    callBridge(sessionOrId, method, input) {
      const session = typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId
      return browser.call(session, method, input)
    },
    openEditor(sessionOrId) {
      const session = typeof sessionOrId === 'string' ? getSession(sessionOrId) : sessionOrId
      return browser.open(session)
    },
    getArtifacts(sessionId) {
      return server.getArtifacts(sessionId)
    },
    browserErrors(sessionId) {
      return browser.errors(sessionId)
    },
    onSessionUnavailable(sessionId, listener) {
      getSession(sessionId)
      return browser.onUnavailable(sessionId, listener)
    },
    addCleanup(cleanup) {
      cleanups.add(cleanup)
      return () => cleanups.delete(cleanup)
    },
    async confirmReviewEvidence(sessionId, input) {
      const session = getSession(sessionId)
      const confirmation = validateReviewConfirmation(sessionId, input)
      const url = `${server.origin}/session/${encodeURIComponent(session.id)}/artifact/stage/${encodeURIComponent(confirmation.batchId)}/confirm?token=${encodeURIComponent(session.token)}`
      const body = JSON.stringify({
        leaseToken: confirmation.leaseToken,
        generation: confirmation.generation,
        expiresAt: confirmation.expiresAt,
        artifacts: confirmation.artifacts,
      })
      let lastError
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetcher(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-artifact-lease-token': confirmation.leaseToken,
              'x-artifact-generation': String(confirmation.generation),
            },
            body,
            redirect: 'error',
          })
          if (!response.ok || response.redirected || response.status !== 200 || response.url !== url
            || response.headers.get('content-type') !== 'application/json; charset=utf-8') {
            throw runtimeError(`Review evidence seal failed (${response.status})`)
          }
          const value = await response.json()
          if (!exactKeys(value, ['ok', 'batchId', 'generation', 'sealed', 'artifactIds', 'resultIds'])
            || value.ok !== true || value.batchId !== confirmation.batchId
            || value.generation !== confirmation.generation || value.sealed !== true
            || JSON.stringify(value.artifactIds) !== JSON.stringify(confirmation.artifacts.map((artifact) => artifact.id))
            || JSON.stringify(value.resultIds) !== JSON.stringify(confirmation.artifacts.map((artifact) => artifact.resultId))) {
            throw runtimeError('Invalid review evidence seal response')
          }
          return value
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    },
    async readReviewArtifact(sessionId, view, receipt) {
      const session = getSession(sessionId)
      if (!view || !receipt || view.id !== receipt.resultId || view.artifact?.id !== view.id
        || view.artifact?.mimeType !== receipt.mimeType || view.artifact?.byteLength !== receipt.byteLength
        || view.artifact?.sha256 !== receipt.sha256 || view.artifact?.width !== receipt.width
        || view.artifact?.height !== receipt.height) {
        throw runtimeError('Review view does not match its sealed receipt', 'INVALID_USAGE')
      }
      const expectedUrl = `${server.origin}/session/${encodeURIComponent(session.id)}/artifact/${encodeURIComponent(receipt.id)}?token=${encodeURIComponent(session.token)}`
      if (view.artifact.url !== expectedUrl) throw runtimeError('Review artifact locator does not match its sealed receipt', 'INVALID_USAGE')
      const response = await fetcher(expectedUrl, { method: 'GET', cache: 'no-store', redirect: 'error' })
      if (!response.ok || response.redirected || response.status !== 200 || response.url !== expectedUrl
        || response.headers.get('content-type') !== receipt.mimeType
        || response.headers.get('content-length') !== String(receipt.byteLength)
        || response.headers.get('x-artifact-id') !== receipt.id
        || response.headers.get('x-artifact-result-id') !== receipt.resultId
        || response.headers.get('x-artifact-sha256') !== receipt.sha256) {
        throw runtimeError(`Invalid sealed review artifact response: ${view.id}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (bytes.byteLength !== receipt.byteLength || digest !== receipt.sha256) {
        throw runtimeError(`Sealed review artifact bytes changed: ${view.id}`)
      }
      return {
        id: receipt.resultId,
        resultId: receipt.resultId,
        internalId: receipt.id,
        fileName: view.artifact.fileName,
        mimeType: receipt.mimeType,
        byteLength: receipt.byteLength,
        sha256: receipt.sha256,
        width: receipt.width,
        height: receipt.height,
        bytes,
      }
    },
    async publishArtifacts(sessionId, outputDir, artifacts, force = false, publicationOptions = {}) {
      getSession(sessionId)
      const output = await resolveAllowedOutputPath(allowedRoots, outputDir)
      await publishAtomically(output, artifacts, { ...publicationOptions, force, sessionId })
      return output
    },
    async publishArtifactFile(sessionId, outputPath, artifact, force = false) {
      getSession(sessionId)
      const output = await resolveAllowedOutputPath(allowedRoots, outputPath)
      await publishFileAtomically(output, artifact.bytes, { force, sessionId })
      return output
    },
    async disposeSession(sessionId) {
      sessions.delete(sessionId)
      server.disposeSession(sessionId)
      await browser.dispose(sessionId)
    },
    async close() {
      if (closed) return
      closed = true
      const pending = [...cleanups]
      cleanups.clear()
      await Promise.allSettled(pending.map((cleanup) => cleanup()))
      sessions.clear()
      await browser.close()
      await server.close()
    },
  }
}
