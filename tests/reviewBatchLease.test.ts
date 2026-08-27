import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Node plugin runtime is intentionally authored as directly executable ESM.
import { createSessionServer } from '../scripts/lib/session-server.mjs'

interface Lease {
  batchId: string
  leaseToken: string
  generation: number
  expiresAt: number
}

async function fixture(options: Record<string, unknown> = {}) {
  const editorRoot = await mkdtemp(path.join(tmpdir(), 'glb-label-review-lease-'))
  await writeFile(path.join(editorRoot, 'index.html'), '<main>editor</main>')
  const server = await createSessionServer({ editorRoot, ...options })
  const session = server.createSession()
  const base = `${server.origin}/session/${session.id}/artifact`
  const auth = `token=${session.token}`
  return { server, session, base, auth }
}

async function acquire(base: string, auth: string, batchId: string): Promise<Response> {
  return fetch(`${base}/stage/${batchId}/acquire?${auth}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'error',
  })
}

function leaseHeaders(lease: Lease): Record<string, string> {
  return { 'x-artifact-lease-token': lease.leaseToken, 'x-artifact-generation': String(lease.generation) }
}

async function stage(base: string, auth: string, lease: Lease, internalId: string, resultId: string, byte: number): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/stage/${lease.batchId}/${internalId}?${auth}`, {
    method: 'PUT',
    headers: {
      ...leaseHeaders(lease), 'content-type': 'image/png',
      'x-artifact-file-name': encodeURIComponent(`${resultId}.png`), 'x-artifact-result-id': resultId,
    },
    body: new Uint8Array([byte]), redirect: 'error',
  })
  expect(response.status).toBe(201)
  return response.json()
}

async function commit(base: string, auth: string, lease: Lease, artifacts: Array<{ id: string; resultId: string }>): Promise<Response> {
  return fetch(`${base}/stage/${lease.batchId}/commit?${auth}`, {
    method: 'POST', headers: { ...leaseHeaders(lease), 'content-type': 'application/json' },
    body: JSON.stringify({
      leaseToken: lease.leaseToken, generation: lease.generation,
      artifactIds: artifacts.map(({ id }) => id), resultIds: artifacts.map(({ resultId }) => resultId),
    }), redirect: 'error',
  })
}

async function finish(base: string, auth: string, lease: Lease, action: 'finalize' | 'abort'): Promise<Response> {
  const url = action === 'abort'
    ? `${base}/stage/${lease.batchId}?${auth}`
    : `${base}/stage/${lease.batchId}/finalize?${auth}`
  return fetch(url, {
    method: action === 'abort' ? 'DELETE' : 'POST',
    headers: { ...leaseHeaders(lease), 'content-type': 'application/json' },
    ...(action === 'finalize' ? { body: JSON.stringify({ leaseToken: lease.leaseToken, generation: lease.generation }) } : {}),
    redirect: 'error',
  })
}

async function begin(base: string, auth: string, batchId: string): Promise<Lease> {
  const response = await acquire(base, auth, batchId)
  expect(response.status).toBe(201)
  return response.json()
}

describe('review artifact lease transactions', () => {
  it('replaces the complete logical result set and only reclaims prior artifacts after finalize', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const first = await begin(base, auth, 'front-back')
      const front1 = await stage(base, auth, first, 'first-front', 'front', 1) as { id: string; resultId: string; url: string }
      const back1 = await stage(base, auth, first, 'first-back', 'back', 2) as { id: string; resultId: string; url: string }
      expect((await commit(base, auth, first, [front1, back1])).status).toBe(201)
      expect((await finish(base, auth, first, 'finalize')).status).toBe(200)

      const second = await begin(base, auth, 'front-only-abort')
      const front2 = await stage(base, auth, second, 'second-front', 'front', 3) as { id: string; resultId: string; url: string }
      expect((await commit(base, auth, second, [front2])).status).toBe(201)
      expect(server.getArtifacts(session.id).map((item: { id: string }) => item.id)).toEqual(['front'])
      expect((await fetch(back1.url)).status).toBe(404)
      expect((await finish(base, auth, second, 'abort')).status).toBe(200)
      expect(server.getArtifacts(session.id).map((item: { id: string }) => item.id).sort()).toEqual(['back', 'front'])
      expect((await fetch(front1.url)).status).toBe(200)
      expect((await fetch(back1.url)).status).toBe(200)

      const third = await begin(base, auth, 'front-only-final')
      const front3 = await stage(base, auth, third, 'third-front', 'front', 4) as { id: string; resultId: string; url: string }
      expect((await commit(base, auth, third, [front3])).status).toBe(201)
      expect((await finish(base, auth, third, 'finalize')).status).toBe(200)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'third-front' }])
      expect((await fetch(front1.url)).status).toBe(404)
      expect((await fetch(back1.url)).status).toBe(404)
    } finally { await server.close() }
  })

  it('serializes independent runtimes and rejects stale/replayed CAS operations without mutation', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const leaseB = await begin(base, auth, 'attempt-b')
      expect((await acquire(base, auth, 'attempt-c')).status).toBe(409)
      const b = await stage(base, auth, leaseB, 'b-front', 'front', 7) as { id: string; resultId: string }
      const stale = { ...leaseB, generation: leaseB.generation + 1 }
      expect((await commit(base, auth, stale, [b])).status).toBe(409)
      expect(server.getArtifacts(session.id)).toEqual([])
      expect((await finish(base, auth, leaseB, 'abort')).status).toBe(200)
      expect((await finish(base, auth, leaseB, 'abort')).status).toBe(409)

      const leaseC = await begin(base, auth, 'attempt-c')
      expect(leaseC.generation).toBeGreaterThan(leaseB.generation)
      const c = await stage(base, auth, leaseC, 'c-front', 'front', 8) as { id: string; resultId: string }
      expect((await commit(base, auth, leaseC, [c])).status).toBe(201)
      expect((await finish(base, auth, leaseB, 'abort')).status).toBe(409)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'c-front' }])
      expect((await finish(base, auth, leaseC, 'finalize')).status).toBe(200)
      expect((await finish(base, auth, leaseC, 'finalize')).status).toBe(409)
    } finally { await server.close() }
  })

  it('expires abandoned staging/committed leases within a bound and rolls committed state back exactly', async () => {
    let now = 1_000
    const { server, session, base, auth } = await fixture({ reviewLeaseMs: 50, now: () => now })
    try {
      const originalLease = await begin(base, auth, 'original')
      const original = await stage(base, auth, originalLease, 'original-front', 'front', 1) as { id: string; resultId: string; url: string }
      expect((await commit(base, auth, originalLease, [original])).status).toBe(201)
      expect((await finish(base, auth, originalLease, 'finalize')).status).toBe(200)

      const crashed = await begin(base, auth, 'crashed')
      const replacement = await stage(base, auth, crashed, 'replacement-front', 'front', 2) as { id: string; resultId: string; url: string }
      expect((await commit(base, auth, crashed, [replacement])).status).toBe(201)
      now += 51
      const recovered = await begin(base, auth, 'recovered')
      expect(recovered.generation).toBeGreaterThan(crashed.generation)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'original-front' }])
      expect((await fetch(original.url)).status).toBe(200)
      expect((await fetch(replacement.url)).status).toBe(404)
      expect((await finish(base, auth, recovered, 'abort')).status).toBe(200)
    } finally { await server.close() }
  })

  it('keeps session asset URLs immutable and version-addressed when a logical id is replaced', async () => {
    const { server, session } = await fixture({ maxSessionAssetBytes: 16 })
    try {
      const first = server.addAsset(session.id, { id: 'mark', bytes: new Uint8Array([1, 2]), mimeType: 'image/png' })
      const same = server.addAsset(session.id, { id: 'mark', bytes: new Uint8Array([1, 2]), mimeType: 'image/png' })
      const second = server.addAsset(session.id, { id: 'mark', bytes: new Uint8Array([3, 4]), mimeType: 'image/png' })
      expect(same).toBe(first)
      expect(second).not.toBe(first)
      expect(new Uint8Array(await (await fetch(first)).arrayBuffer())).toEqual(new Uint8Array([1, 2]))
      expect(new Uint8Array(await (await fetch(second)).arrayBuffer())).toEqual(new Uint8Array([3, 4]))
      expect(() => server.addAsset(session.id, { id: 'large', bytes: new Uint8Array(13), mimeType: 'image/png' })).toThrow(/asset byte limit/i)
    } finally { await server.close() }
  })

  it('bounds staged artifact count and aggregate bytes before accepting excess work', async () => {
    const { server, session, base, auth } = await fixture({ maxReviewBatchArtifacts: 1, maxReviewBatchBytes: 2 })
    try {
      const countLease = await begin(base, auth, 'count-bound')
      await stage(base, auth, countLease, 'only', 'only', 1)
      const excessCount = await fetch(`${base}/stage/${countLease.batchId}/extra?${auth}`, {
        method: 'PUT', headers: {
          ...leaseHeaders(countLease), 'content-type': 'image/png',
          'x-artifact-file-name': 'extra.png', 'x-artifact-result-id': 'extra',
        }, body: new Uint8Array([2]),
      })
      expect(excessCount.status).toBe(413)
      expect((await finish(base, auth, countLease, 'abort')).status).toBe(200)

      const byteLease = await begin(base, auth, 'byte-bound')
      const excessBytes = await fetch(`${base}/stage/${byteLease.batchId}/large?${auth}`, {
        method: 'PUT', headers: {
          ...leaseHeaders(byteLease), 'content-type': 'image/png',
          'content-length': '3', 'x-artifact-file-name': 'large.png', 'x-artifact-result-id': 'large',
        }, body: new Uint8Array([1, 2, 3]),
      })
      expect(excessBytes.status).toBe(413)
      expect(server.getArtifacts(session.id)).toEqual([])
      expect((await finish(base, auth, byteLease, 'abort')).status).toBe(200)
    } finally { await server.close() }
  })
})
