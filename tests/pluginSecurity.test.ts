import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Node plugin runtime is intentionally authored as directly executable ESM.
import { resolveAllowedPath, sanitizeArtifactName } from '../scripts/lib/files.mjs'
// @ts-expect-error Node plugin runtime is intentionally authored as directly executable ESM.
import { inspectCodec } from '../scripts/lib/codec.mjs'
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
    } finally {
      await server.close()
    }
  })
})
