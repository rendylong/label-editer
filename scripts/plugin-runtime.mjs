import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createBrowserSessionManager } from './lib/browser-session.mjs'
import { normalizeGlb } from './lib/codec.mjs'
import { publishAtomically, publishFileAtomically, resolveAllowedOutputPath, resolveAllowedPath } from './lib/files.mjs'
import { createSessionServer } from './lib/session-server.mjs'

export async function createPluginRuntime(options = {}) {
  const pluginRoot = path.resolve(options.pluginRoot ?? path.join(import.meta.dirname, '..'))
  const allowedRoots = options.allowedRoots?.length ? options.allowedRoots : [process.cwd()]
  const server = await createSessionServer({ editorRoot: options.editorRoot ?? path.join(pluginRoot, 'dist') })
  const browser = await createBrowserSessionManager({
    server,
    headless: options.headless !== false,
    launchOptions: options.launchOptions,
    pageQuery: options.browserQuery,
  })
  const sessions = new Map()
  const cleanups = new Set()
  let closed = false

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
    async publishArtifacts(sessionId, outputDir, artifacts, force = false) {
      getSession(sessionId)
      const output = await resolveAllowedOutputPath(allowedRoots, outputDir)
      await publishAtomically(output, artifacts, { force, sessionId })
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
