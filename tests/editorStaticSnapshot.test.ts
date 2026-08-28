import { request, type ClientRequest, type IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Node plugin server is intentionally authored as directly executable ESM.
import { createSessionServer } from '../scripts/lib/session-server.mjs'
// @ts-expect-error Node build snapshot is intentionally authored as directly executable ESM.
import { snapshotEditorDist, takeEditorDistSnapshot } from '../scripts/lib/build-fingerprint.mjs'

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

function pausedRequest(origin: string, requestPath: string, method: 'GET' | 'HEAD' = 'GET'): Promise<{
  outgoing: ClientRequest
  incoming: IncomingMessage
  status: number
}> {
  const target = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: target.hostname,
      port: target.port,
      method,
      path: requestPath,
    }, (incoming) => {
      incoming.pause()
      resolve({ outgoing, incoming, status: incoming.statusCode ?? 0 })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

function abortPaused(entry: { outgoing: ClientRequest, incoming: IncomingMessage }) {
  entry.incoming.destroy()
  entry.outgoing.destroy()
}

async function eventually<T>(operation: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await operation()
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    value = await operation()
  }
  return value
}

describe('editor static byte snapshot', () => {
  it('consumes an opaque snapshot once and returns copies instead of mutable internal Map bytes', async () => {
    const root = await fixture()
    const captured = await snapshotEditorDist(root)
    const assets = takeEditorDistSnapshot(captured.snapshot)
    expect(Object.isFrozen(assets)).toBe(true)
    expect(() => takeEditorDistSnapshot(captured.snapshot)).toThrow(/already consumed/i)

    const first = assets.read('index.html')
    expect(first).toBeDefined()
    first?.fill(0)
    expect(assets.read('index.html')?.toString('utf8')).toBe('<main>verified</main>')
    expect(Reflect.set(assets, 'read', () => Buffer.from('tampered'))).toBe(false)

    const lease = assets.retain('index.html')
    expect(lease).toBeDefined()
    expect(Reflect.has(lease!, 'bytes')).toBe(false)
    assets.dispose()
    expect(() => assets.read('index.html')).toThrow(/disposed/i)
    let delivered: Buffer | undefined
    lease!.writeTo({ end(bytes: Buffer) { delivered = Buffer.from(bytes) } })
    expect(delivered?.toString('utf8')).toBe('<main>verified</main>')
    lease!.release()
    lease!.release()
  })

  it('serves every current dist extension with an explicit nosniff MIME, including SVG', async () => {
    const root = await fixture()
    const expected = new Map([
      ['asset.html', 'text/html; charset=utf-8'],
      ['asset.js', 'text/javascript; charset=utf-8'],
      ['asset.css', 'text/css; charset=utf-8'],
      ['asset.json', 'application/json; charset=utf-8'],
      ['asset.png', 'image/png'],
      ['asset.svg', 'image/svg+xml'],
      ['asset.wasm', 'application/wasm'],
      ['asset.glb', 'model/gltf-binary'],
      ['asset.woff2', 'font/woff2'],
      ['asset.woff', 'font/woff'],
      ['asset.ttf', 'font/ttf'],
      ['asset.md', 'text/markdown; charset=utf-8'],
      ['asset.txt', 'text/plain; charset=utf-8'],
    ])
    for (const fileName of expected.keys()) await writeFile(path.join(root, fileName), 'fixture')
    const server = await createSessionServer({ editorRoot: root })
    try {
      for (const [fileName, mime] of expected) {
        const response = await fetch(`${server.origin}/${fileName}`)
        expect(response.status, fileName).toBe(200)
        expect(response.headers.get('content-type'), fileName).toBe(mime)
        expect(response.headers.get('x-content-type-options'), fileName).toBe('nosniff')
      }

      const currentExtensions = new Set<string>()
      const visit = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name === 'build-fingerprint.json') continue
          const absolute = path.join(directory, entry.name)
          if (entry.isDirectory()) await visit(absolute)
          else currentExtensions.add(path.extname(entry.name))
        }
      }
      await visit(path.resolve('dist'))
      const recognizedExtensions = new Set([...expected.keys()].map((fileName) => path.extname(fileName)))
      expect([...currentExtensions].every((extension) => recognizedExtensions.has(extension))).toBe(true)
    } finally {
      await server.close()
    }
  })

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

  it('bounds paused static GETs by count and bytes while HEAD stays body-free and abort releases exactly once', async () => {
    const root = await fixture()
    const maxAssetBytes = 16_708_168
    await writeFile(path.join(root, 'assets', 'maximum.js'), Buffer.alloc(maxAssetBytes, 0x61))
    const server = await createSessionServer({
      editorRoot: root,
      maxStaticResponseConcurrency: 16,
      maxStaticResponseOutstandingBytes: maxAssetBytes * 2,
    })
    const paused: Array<Awaited<ReturnType<typeof pausedRequest>>> = []
    try {
      for (let index = 0; index < 2; index += 1) {
        const entry = await pausedRequest(server.origin, '/assets/maximum.js')
        expect(entry.status).toBe(200)
        paused.push(entry)
      }

      const rejected = await Promise.all(Array.from({ length: 16 }, () => (
        pausedRequest(server.origin, '/assets/maximum.js')
      )))
      expect(rejected.map((entry) => entry.status)).toEqual(Array(16).fill(503))
      for (const entry of rejected) entry.incoming.resume()

      for (let index = 0; index < 18; index += 1) {
        const head = await pausedRequest(server.origin, '/assets/maximum.js', 'HEAD')
        expect(head.status).toBe(200)
        head.incoming.resume()
      }

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const aborted = paused.shift()!
        abortPaused(aborted)
        abortPaused(aborted)
        const replacement = await eventually(
          async () => {
            const entry = await pausedRequest(server.origin, '/assets/maximum.js')
            if (entry.status !== 200) entry.incoming.resume()
            return entry
          },
          (entry) => entry.status === 200,
        )
        expect(replacement.status).toBe(200)
        paused.push(replacement)

        const noDoubleRelease = await pausedRequest(server.origin, '/assets/maximum.js')
        expect(noDoubleRelease.status).toBe(503)
        noDoubleRelease.incoming.resume()
      }
    } finally {
      for (const entry of paused) abortPaused(entry)
      await server.close()
    }
  }, 30_000)

  it('closes safely with paused static responses and rejects new traffic without retaining response leases', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'assets', 'maximum.js'), Buffer.alloc(16_708_168, 0x61))
    const server = await createSessionServer({
      editorRoot: root,
      maxStaticResponseConcurrency: 3,
      maxStaticResponseOutstandingBytes: 16_708_168 * 4,
    })
    const paused = await Promise.all(Array.from({ length: 4 }, () => (
      pausedRequest(server.origin, '/assets/maximum.js')
    )))
    expect(paused.map((entry) => entry.status)).toEqual([200, 200, 200, 503])

    await expect(Promise.race([
      server.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 2_000)),
    ])).resolves.toBe('closed')
    for (const entry of paused) abortPaused(entry)
    await expect(fetch(`${server.origin}/editor/`)).rejects.toThrow()
  }, 30_000)
})
