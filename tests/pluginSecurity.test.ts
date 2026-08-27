import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Node plugin runtime is intentionally authored as directly executable ESM.
import { publishFileAtomically, resolveAllowedPath, sanitizeArtifactName } from '../scripts/lib/files.mjs'
// @ts-expect-error Node plugin runtime is intentionally authored as directly executable ESM.
import { inspectCodec, normalizeGlb } from '../scripts/lib/codec.mjs'
// @ts-expect-error Node plugin runtime is intentionally authored as directly executable ESM.
import { createSessionServer } from '../scripts/lib/session-server.mjs'

function glbWithExtensions(extensionsUsed: string[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, extensionsUsed }))
  const paddedLength = Math.ceil(json.length / 4) * 4
  const out = new Uint8Array(12 + 8 + paddedLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, paddedLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(json, 20)
  out.fill(0x20, 20 + json.length)
  return out
}

describe('plugin runtime security', () => {
  it('rejects an existing path outside an explicit workspace root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-root-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'glb-label-outside-'))
    await mkdir(path.join(root, 'inside'))
    await writeFile(path.join(outside, 'secret.glb'), 'secret')
    await expect(resolveAllowedPath([await realpath(root)], path.join(outside, 'secret.glb'))).rejects.toThrow(/outside allowed root/i)
  })

  it('sanitizes artifact names without retaining traversal segments', () => {
    expect(sanitizeArtifactName('../../front label.png')).toBe('front-label.png')
    expect(sanitizeArtifactName('背标 / PBR.png')).toBe('背标-PBR.png')
  })

  it('publishes a single artifact without overwriting by default', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-file-'))
    const output = path.join(root, 'preview.png')
    await publishFileAtomically(output, new Uint8Array([1, 2, 3]), { sessionId: 'first' })
    await expect(publishFileAtomically(output, new Uint8Array([4]), { sessionId: 'second' })).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' })
    expect(await readFile(output)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('returns explicit blockers for unsupported GLB extensions', () => {
    expect(inspectCodec(glbWithExtensions(['EXT_meshopt_compression']))).toMatchObject({
      blocker: { code: 'UNSUPPORTED_CODEC', extension: 'EXT_meshopt_compression' },
    })
    expect(inspectCodec(glbWithExtensions(['KHR_texture_basisu']))).toMatchObject({
      blocker: { code: 'UNSUPPORTED_CODEC', extension: 'KHR_texture_basisu' },
    })
  })

  it('recognizes standard and Draco GLB inputs separately', () => {
    expect(inspectCodec(glbWithExtensions([]))).toMatchObject({ sourceCompressed: false, needsNormalization: false })
    expect(inspectCodec(glbWithExtensions(['KHR_draco_mesh_compression']))).toMatchObject({
      sourceCompressed: true, needsNormalization: true, blocker: undefined,
    })
  })

  it('normalizes a real Draco-compressed GLB before browser rendering', async () => {
    const [{ Document, NodeIO }, { KHRDracoMeshCompression }, { draco }, draco3d] = await Promise.all([
      import('@gltf-transform/core'),
      import('@gltf-transform/extensions'),
      import('@gltf-transform/functions'),
      // @ts-expect-error draco3dgltf does not publish TypeScript declarations.
      import('draco3dgltf'),
    ])
    const document = new Document()
    const buffer = document.createBuffer()
    const positions = document.createAccessor('positions')
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer)
    const indices = document.createAccessor('indices')
      .setType('SCALAR')
      .setArray(new Uint16Array([0, 1, 2]))
      .setBuffer(buffer)
    const primitive = document.createPrimitive().setAttribute('POSITION', positions).setIndices(indices)
    const mesh = document.createMesh('triangle').addPrimitive(primitive)
    document.createScene('scene').addChild(document.createNode('triangle').setMesh(mesh))
    await document.transform(draco())
    const io = new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
    })
    const compressed = await io.writeBinary(document)
    expect(inspectCodec(compressed)).toMatchObject({ sourceCompressed: true, needsNormalization: true })

    const normalized = await normalizeGlb(compressed)
    expect(normalized.codec).toMatchObject({ sourceCompressed: true, normalized: true, outputCompressed: false })
    expect(inspectCodec(normalized.bytes)).toMatchObject({ sourceCompressed: false, needsNormalization: false })
  })

  it('protects bootstrap and artifact routes with the session token', async () => {
    const editorRoot = await mkdtemp(path.join(tmpdir(), 'glb-label-editor-root-'))
    await writeFile(path.join(editorRoot, 'index.html'), '<main>editor</main>')
    const server = await createSessionServer({ editorRoot })
    try {
      const session = server.createSession()
      const rejected = await fetch(`${server.origin}/session/${session.id}/bootstrap?token=wrong`)
      expect(rejected.status).toBe(403)

      const accepted = await fetch(`${server.origin}/session/${session.id}/bootstrap?token=${session.token}`)
      expect(await accepted.json()).toMatchObject({ token: session.token })

      const uploaded = await fetch(`${server.origin}/session/${session.id}/artifact/preview?token=${session.token}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-artifact-file-name': encodeURIComponent('../preview.png') },
        body: new Uint8Array([1, 2, 3]),
      })
      expect(uploaded.status).toBe(201)
      expect(server.getArtifacts(session.id)).toMatchObject([{
        id: 'preview', fileName: 'preview.png', mimeType: 'image/png', byteLength: 3,
      }])

      const editor = await fetch(`${server.origin}/editor/`)
      const csp = editor.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("script-src 'self'")
      expect(csp).not.toContain('unsafe-eval')
      expect(csp).toContain("connect-src 'self' blob:")
    } finally {
      await server.close()
    }
  })

  it('keeps a review artifact batch unreadable until commit and purges the whole attempt', async () => {
    const editorRoot = await mkdtemp(path.join(tmpdir(), 'glb-label-editor-batch-'))
    await writeFile(path.join(editorRoot, 'index.html'), '<main>editor</main>')
    const server = await createSessionServer({ editorRoot })
    try {
      const session = server.createSession()
      const base = `${server.origin}/session/${session.id}/artifact`
      const auth = `token=${session.token}`
      const acquire = async () => {
        const response = await fetch(`${base}/stage/review-attempt/acquire?${auth}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
        expect(response.status).toBe(201)
        return response.json() as Promise<{ leaseToken: string; generation: number }>
      }
      let lease = await acquire()
      const leaseHeaders = () => ({
        'x-artifact-lease-token': lease.leaseToken,
        'x-artifact-generation': String(lease.generation),
      })
      for (const id of ['front', 'back']) {
        const staged = await fetch(`${base}/stage/review-attempt/${id}?${auth}`, {
          method: 'PUT',
          headers: { ...leaseHeaders(), 'content-type': 'image/png', 'x-artifact-file-name': encodeURIComponent(`${id}.png`) },
          body: new Uint8Array([1, 2, 3]),
        })
        expect(staged.status).toBe(201)
        expect(await staged.json()).toMatchObject({
          id, fileName: `${id}.png`, mimeType: 'image/png', byteLength: 3,
          url: `${base}/${id}?${auth}`,
        })
        expect((await fetch(`${base}/${id}?${auth}`)).status).toBe(404)
      }
      expect(server.getArtifacts(session.id)).toEqual([])

      const purged = await fetch(`${base}/stage/review-attempt?${auth}`, { method: 'DELETE', headers: leaseHeaders() })
      expect(purged.status).toBe(200)
      expect(server.getArtifacts(session.id)).toEqual([])

      lease = await acquire()
      for (const id of ['front', 'back']) {
        expect((await fetch(`${base}/stage/review-attempt/${id}?${auth}`, {
          method: 'PUT',
          headers: { ...leaseHeaders(), 'content-type': 'image/png', 'x-artifact-file-name': encodeURIComponent(`${id}.png`) },
          body: new Uint8Array([1, 2, 3]),
        })).status).toBe(201)
      }
      const committed = await fetch(`${base}/stage/review-attempt/commit?${auth}`, {
        method: 'POST', headers: { ...leaseHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ leaseToken: lease.leaseToken, generation: lease.generation, artifactIds: ['front', 'back'] }),
      })
      expect(committed.status).toBe(201)
      expect((await committed.json()).artifactIds).toEqual(['front', 'back'])
      expect((await fetch(`${base}/front?${auth}`)).status).toBe(409)
      expect((await fetch(`${base}/front?${auth}`, { headers: leaseHeaders() })).status).toBe(200)

      expect((await fetch(`${base}/stage/review-attempt?${auth}`, { method: 'DELETE', headers: leaseHeaders() })).status).toBe(200)
      expect((await fetch(`${base}/front?${auth}`)).status).toBe(404)
      expect(server.getArtifacts(session.id)).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('atomically replaces stable review results with versioned internal artifacts and rolls back a failed repeat', async () => {
    const editorRoot = await mkdtemp(path.join(tmpdir(), 'glb-label-editor-repeat-batch-'))
    await writeFile(path.join(editorRoot, 'index.html'), '<main>editor</main>')
    const server = await createSessionServer({ editorRoot })
    try {
      const session = server.createSession()
      const base = `${server.origin}/session/${session.id}/artifact`
      const auth = `token=${session.token}`
      const leases = new Map<string, { leaseToken: string; generation: number }>()
      const acquire = async (batch: string) => {
        const response = await fetch(`${base}/stage/${batch}/acquire?${auth}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
        expect(response.status).toBe(201)
        const lease = await response.json() as { leaseToken: string; generation: number }
        leases.set(batch, lease)
        return lease
      }
      const leaseHeaders = (batch: string) => {
        const lease = leases.get(batch)!
        return { 'x-artifact-lease-token': lease.leaseToken, 'x-artifact-generation': String(lease.generation) }
      }
      const stage = async (batch: string, internalId: string, resultId: string, byte: number) => {
        if (!leases.has(batch)) await acquire(batch)
        const response = await fetch(`${base}/stage/${batch}/${internalId}?${auth}`, {
          method: 'PUT',
          headers: {
            ...leaseHeaders(batch),
            'content-type': 'image/png',
            'x-artifact-file-name': encodeURIComponent(`${resultId}.png`),
            'x-artifact-result-id': resultId,
          },
          body: new Uint8Array([byte]),
        })
        expect(response.status).toBe(201)
        return response.json()
      }
      const commit = async (batch: string, artifactIds: string[], resultIds: string[]) => {
        const lease = leases.get(batch)!
        return fetch(`${base}/stage/${batch}/commit?${auth}`, {
          method: 'POST', headers: { ...leaseHeaders(batch), 'content-type': 'application/json' },
          body: JSON.stringify({ leaseToken: lease.leaseToken, generation: lease.generation, artifactIds, resultIds }),
        })
      }
      const finalize = async (batch: string) => {
        const lease = leases.get(batch)!
        return fetch(`${base}/stage/${batch}/finalize?${auth}`, {
          method: 'POST', headers: { ...leaseHeaders(batch), 'content-type': 'application/json' },
          body: JSON.stringify({ leaseToken: lease.leaseToken, generation: lease.generation }),
        })
      }
      const receipt = async (batch: string, artifacts: Array<{ id: string; resultId: string; sha256: string }>) => {
        const lease = leases.get(batch)!
        return fetch(`${base}/stage/${batch}/receipt?${auth}`, {
          method: 'POST', headers: { ...leaseHeaders(batch), 'content-type': 'application/json' },
          body: JSON.stringify({
            leaseToken: lease.leaseToken,
            generation: lease.generation,
            artifacts: artifacts.map(({ id, resultId, sha256 }) => ({ id, resultId, sha256 })),
          }),
        })
      }
      const abort = (batch: string) => fetch(`${base}/stage/${batch}?${auth}`, { method: 'DELETE', headers: leaseHeaders(batch) })

      const first = await stage('attempt-one', 'attempt-one--front', 'front', 1)
      expect(first).toMatchObject({ id: 'attempt-one--front', resultId: 'front' })
      expect((await commit('attempt-one', [first.id], ['front'])).status).toBe(201)
      expect((await fetch(first.url, { headers: leaseHeaders('attempt-one') })).status).toBe(200)
      expect((await receipt('attempt-one', [first])).status).toBe(200)
      expect((await finalize('attempt-one')).status).toBe(200)
      expect((await fetch(first.url)).status).toBe(200)

      const failed = await stage('attempt-two', 'attempt-two--front', 'front', 2)
      expect((await abort('attempt-two')).status).toBe(200)
      expect((await fetch(first.url)).status).toBe(200)
      expect((await fetch(failed.url)).status).toBe(404)

      const second = await stage('attempt-three', 'attempt-three--front', 'front', 3)
      expect((await commit('attempt-three', [second.id], ['front'])).status).toBe(201)
      expect((await fetch(second.url, { headers: leaseHeaders('attempt-three') })).status).toBe(200)
      expect((await receipt('attempt-three', [second])).status).toBe(200)
      expect((await finalize('attempt-three')).status).toBe(200)
      expect((await fetch(first.url)).status).toBe(404)
      const current = await fetch(second.url)
      expect(current.status).toBe(200)
      expect(current.headers.get('x-artifact-id')).toBe(second.id)
      expect(current.headers.get('x-artifact-result-id')).toBe('front')
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: second.id }])

      const fourth = await stage('attempt-four', 'attempt-four--front', 'front', 4)
      expect((await commit('attempt-four', [fourth.id], ['front'])).status).toBe(201)
      const rollback = await abort('attempt-four')
      expect(await rollback.json()).toMatchObject({ ok: true, batchId: 'attempt-four', aborted: true })
      expect((await fetch(second.url)).status).toBe(200)
      expect((await fetch(fourth.url)).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
