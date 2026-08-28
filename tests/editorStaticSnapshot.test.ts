import { request } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Node plugin server is intentionally authored as directly executable ESM.
import { createSessionServer } from '../scripts/lib/session-server.mjs'

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'glb-label-static-snapshot-'))
  await mkdir(path.join(root, 'assets'))
  await writeFile(path.join(root, 'index.html'), '<main>verified</main>')
  await writeFile(path.join(root, 'assets', 'app.js'), 'verified-app')
  return root
}

function rawStatus(origin: string, requestPath: string): Promise<number> {
  const target = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: requestPath,
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

describe('editor static byte snapshot', () => {
  it('serves immutable regular-file bytes without reopening renamed, deleted, added, or symlinked paths', async () => {
    const root = await fixture()
    const server = await createSessionServer({ editorRoot: root })
    try {
      const asset = path.join(root, 'assets', 'app.js')
      await rm(asset)
      await symlink(path.join(root, 'index.html'), asset)
      await writeFile(path.join(root, 'added.js'), 'unverified')

      await expect(fetch(`${server.origin}/assets/app.js`).then((response) => response.text()))
        .resolves.toBe('verified-app')
      await expect(fetch(`${server.origin}/added.js`).then((response) => response.text()))
        .resolves.toBe('<main>verified</main>')
    } finally {
      await server.close()
    }
    await expect(fetch(`${server.origin}/editor/`)).rejects.toThrow()
  })

  it('rejects per-file, aggregate, count, symlink, and unsafe-route inputs at the snapshot boundary', async () => {
    const perFileRoot = await fixture()
    await expect(createSessionServer({ editorRoot: perFileRoot, maxEditorAssetBytes: 8 }))
      .rejects.toThrow(/editor asset byte limit/i)

    const aggregateRoot = await fixture()
    await expect(createSessionServer({
      editorRoot: aggregateRoot,
      maxEditorAssetBytes: 24,
      maxEditorSnapshotBytes: 24,
    }))
      .rejects.toThrow(/editor snapshot byte limit/i)

    const countRoot = await fixture()
    await expect(createSessionServer({ editorRoot: countRoot, maxEditorAssetCount: 1 }))
      .rejects.toThrow(/editor asset count limit/i)

    const symlinkRoot = await fixture()
    await rm(path.join(symlinkRoot, 'assets', 'app.js'))
    await symlink(path.join(symlinkRoot, 'index.html'), path.join(symlinkRoot, 'assets', 'app.js'))
    await expect(createSessionServer({ editorRoot: symlinkRoot }))
      .rejects.toThrow(/symbolic link/i)

    const routeRoot = await fixture()
    const server = await createSessionServer({ editorRoot: routeRoot })
    try {
      await expect(rawStatus(server.origin, '/editor/%2e%2e%2fsecret')).resolves.toBe(403)
      await expect(rawStatus(server.origin, '/editor/%5c..%5csecret')).resolves.toBe(403)
      await expect(rawStatus(server.origin, '/editor/%00secret')).resolves.toBe(403)
    } finally {
      await server.close()
    }
  })
})
