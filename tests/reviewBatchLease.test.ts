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

async function readCommitted(url: string, lease: Lease): Promise<Response> {
  return fetch(url, { headers: leaseHeaders(lease), cache: 'no-store', redirect: 'error' })
}

async function acknowledgeReadback(
  base: string,
  auth: string,
  lease: Lease,
  artifacts: Array<{
    id: string
    resultId: string
    sha256: string
    byteLength?: number
    mimeType?: string
    width?: number
    height?: number
  }>,
): Promise<Response> {
  return fetch(`${base}/stage/${lease.batchId}/receipt?${auth}`, {
    method: 'POST',
    headers: { ...leaseHeaders(lease), 'content-type': 'application/json' },
    body: JSON.stringify({
      leaseToken: lease.leaseToken,
      generation: lease.generation,
      artifacts: artifacts.map(({ id, resultId, sha256, byteLength, mimeType, width, height }) => ({
        id,
        resultId,
        sha256,
        byteLength: byteLength ?? 1,
        mimeType: mimeType ?? 'image/png',
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      })),
    }),
    redirect: 'error',
  })
}

async function confirmReadback(
  base: string,
  auth: string,
  lease: Lease,
  expiresAt: number,
  artifacts: Array<{
    id: string
    resultId: string
    sha256: string
    byteLength?: number
    mimeType?: string
    width?: number
    height?: number
  }>,
): Promise<Response> {
  return fetch(`${base}/stage/${lease.batchId}/confirm?${auth}`, {
    method: 'POST',
    headers: { ...leaseHeaders(lease), 'content-type': 'application/json' },
    body: JSON.stringify({
      leaseToken: lease.leaseToken,
      generation: lease.generation,
      expiresAt,
      artifacts: artifacts.map(({ id, resultId, sha256, byteLength, mimeType, width, height }) => ({
        id,
        resultId,
        sha256,
        byteLength: byteLength ?? 1,
        mimeType: mimeType ?? 'image/png',
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      })),
    }),
    redirect: 'error',
  })
}

async function verifyAndConfirm(
  base: string,
  auth: string,
  lease: Lease,
  artifacts: Array<{ id: string; resultId: string; sha256: string; url: string }>,
): Promise<Response> {
  for (const artifact of artifacts) expect((await readCommitted(artifact.url, lease)).status).toBe(200)
  const receipt = await acknowledgeReadback(base, auth, lease, artifacts)
  expect(receipt.status).toBe(200)
  const receiptBody = await receipt.json() as { expiresAt: number }
  return confirmReadback(base, auth, lease, receiptBody.expiresAt, artifacts)
}

function gatedBody(bytes: Uint8Array): {
  body: ReadableStream<Uint8Array>
  started: Promise<void>
  release: () => void
} {
  let markStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let sent = false
  return {
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(bytes)
          markStarted()
          return
        }
        await gate
        controller.close()
      },
    }),
    started,
    release,
  }
}

describe('review artifact lease transactions', () => {
  it('replaces the complete logical result set and only reclaims prior artifacts after receipt-bound confirm', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const first = await begin(base, auth, 'front-back')
      const front1 = await stage(base, auth, first, 'first-front', 'front', 1) as { id: string; resultId: string; sha256: string; url: string }
      const back1 = await stage(base, auth, first, 'first-back', 'back', 2) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, first, [front1, back1])).status).toBe(201)
      expect((await verifyAndConfirm(base, auth, first, [front1, back1])).status).toBe(200)

      const second = await begin(base, auth, 'front-only-abort')
      const front2 = await stage(base, auth, second, 'second-front', 'front', 3) as { id: string; resultId: string; url: string }
      expect((await commit(base, auth, second, [front2])).status).toBe(201)
      expect(server.getArtifacts(session.id).map((item: { id: string }) => item.id)).toEqual(['front'])
      expect((await fetch(back1.url)).status).toBe(404)
      expect((await finish(base, auth, second, 'finalize')).status).toBe(409)
      expect((await finish(base, auth, second, 'abort')).status).toBe(200)
      expect(server.getArtifacts(session.id).map((item: { id: string }) => item.id).sort()).toEqual(['back', 'front'])
      expect((await fetch(front1.url)).status).toBe(200)
      expect((await fetch(back1.url)).status).toBe(200)

      const third = await begin(base, auth, 'front-only-final')
      const front3 = await stage(base, auth, third, 'third-front', 'front', 4) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, third, [front3])).status).toBe(201)
      expect((await verifyAndConfirm(base, auth, third, [front3])).status).toBe(200)
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
      const firstAbort = await finish(base, auth, leaseB, 'abort')
      expect(firstAbort.status).toBe(200)
      const firstAbortPayload = await firstAbort.json()
      const replayedAbort = await finish(base, auth, leaseB, 'abort')
      expect(replayedAbort.status).toBe(200)
      expect(await replayedAbort.json()).toEqual(firstAbortPayload)

      const leaseC = await begin(base, auth, 'attempt-c')
      expect(leaseC.generation).toBeGreaterThan(leaseB.generation)
      const c = await stage(base, auth, leaseC, 'c-front', 'front', 8) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, leaseC, [c])).status).toBe(201)
      const oldAbortReplay = await finish(base, auth, leaseB, 'abort')
      expect(oldAbortReplay.status).toBe(200)
      expect(await oldAbortReplay.json()).toEqual(firstAbortPayload)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'c-front' }])
      expect((await readCommitted(c.url, leaseC)).status).toBe(200)
      const receipt = await acknowledgeReadback(base, auth, leaseC, [c])
      expect(receipt.status).toBe(200)
      const receiptBody = await receipt.json() as { expiresAt: number }
      const firstConfirm = await confirmReadback(base, auth, leaseC, receiptBody.expiresAt, [c])
      expect(firstConfirm.status).toBe(200)
      const replayedConfirm = await confirmReadback(base, auth, leaseC, receiptBody.expiresAt, [c])
      expect(replayedConfirm.status).toBe(200)
      expect(await replayedConfirm.json()).toEqual(await firstConfirm.json())
    } finally { await server.close() }
  })

  it('expires an abandoned committed lease on its own without a triggering request', async () => {
    const { server, session, base, auth } = await fixture({ reviewLeaseMs: 100 })
    try {
      const originalLease = await begin(base, auth, 'timer-original')
      const original = await stage(base, auth, originalLease, 'timer-original-front', 'front', 1) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, originalLease, [original])).status).toBe(201)
      expect((await verifyAndConfirm(base, auth, originalLease, [original])).status).toBe(200)

      const abandoned = await begin(base, auth, 'timer-abandoned')
      const replacement = await stage(base, auth, abandoned, 'timer-replacement-front', 'front', 2) as { id: string; resultId: string }
      expect((await commit(base, auth, abandoned, [replacement])).status).toBe(201)

      await new Promise((resolve) => setTimeout(resolve, 220))
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'timer-original-front' }])
    } finally { await server.close() }
  })

  it('does not renew a lease for an invalid phase operation', async () => {
    const { server, base, auth } = await fixture({ reviewLeaseMs: 120 })
    try {
      const lease = await begin(base, auth, 'invalid-phase')
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect((await finish(base, auth, lease, 'finalize')).status).toBe(409)
      await new Promise((resolve) => setTimeout(resolve, 70))
      expect((await acquire(base, auth, 'after-invalid-phase')).status).toBe(201)
    } finally { await server.close() }
  })

  it('expires at the exact monotonic deadline and invalid endpoints or stale replays never renew it', async () => {
    let now = 1_000
    const { server, base, auth } = await fixture({ reviewLeaseMs: 50, now: () => now })
    try {
      const first = await begin(base, auth, 'deadline-first')
      now = 1_040
      expect((await fetch(`${base}/stage/${first.batchId}/not-an-endpoint?${auth}`, {
        method: 'POST', headers: leaseHeaders(first),
      })).status).toBe(404)
      now = 1_050
      const second = await begin(base, auth, 'deadline-second')

      expect((await finish(base, auth, second, 'abort')).status).toBe(200)
      const third = await begin(base, auth, 'deadline-third')
      now = 1_090
      // A bounded settlement replay is idempotent even after a newer lease, but
      // it must not renew or otherwise mutate that newer transaction.
      expect((await finish(base, auth, second, 'abort')).status).toBe(200)
      now = 1_100
      expect((await acquire(base, auth, 'deadline-fourth')).status).toBe(201)
      expect(third.generation).toBeGreaterThan(first.generation)
    } finally { await server.close() }
  })

  it('blocks the legacy artifact mutation route while a review lease owns the session', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const lease = await begin(base, auth, 'legacy-lock')
      const response = await fetch(`${base}/legacy-preview?${auth}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-artifact-file-name': 'legacy-preview.png' },
        body: new Uint8Array([9]),
      })
      expect(response.status).toBe(409)
      expect(server.getArtifacts(session.id)).toEqual([])
      expect((await finish(base, auth, lease, 'abort')).status).toBe(200)
    } finally { await server.close() }
  })

  it('reauthorizes a legacy artifact mutation after its awaited request body', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      let releaseBody!: () => void
      const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve })
      let firstChunk!: () => void
      const firstChunkSent = new Promise<void>((resolve) => { firstChunk = resolve })
      let pullCount = 0
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (pullCount++ === 0) {
            controller.enqueue(new Uint8Array([1]))
            firstChunk()
            return
          }
          await bodyGate
          controller.close()
        },
      })
      const legacy = fetch(`${base}/slow-legacy?${auth}`, {
        method: 'PUT', headers: { 'content-type': 'image/png' }, body,
        // Node fetch requires this for a streaming request body.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      await firstChunkSent
      await new Promise((resolve) => setTimeout(resolve, 20))
      const lease = await begin(base, auth, 'during-legacy-body')
      releaseBody()

      expect((await legacy).status).toBe(409)
      expect(server.getArtifacts(session.id)).toEqual([])
      expect((await finish(base, auth, lease, 'abort')).status).toBe(200)
    } finally { await server.close() }
  })

  it('serializes acquire after body reads so concurrent requests create exactly one lease', async () => {
    const { server, base, auth } = await fixture()
    try {
      const firstBody = gatedBody(new TextEncoder().encode('{}'))
      const secondBody = gatedBody(new TextEncoder().encode('{}'))
      const request = (batchId: string, body: ReadableStream<Uint8Array>) => fetch(`${base}/stage/${batchId}/acquire?${auth}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      const first = request('concurrent-acquire-a', firstBody.body)
      const second = request('concurrent-acquire-b', secondBody.body)
      await Promise.all([firstBody.started, secondBody.started])
      firstBody.release()
      secondBody.release()

      const responses = await Promise.all([first, second])
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
      const winner = responses.find((response) => response.status === 201)!
      const lease = await winner.json() as Lease
      expect((await finish(base, auth, lease, 'abort')).status).toBe(200)
    } finally { await server.close() }
  })

  it('serializes stage acceptance after body reads so count and aggregate bytes cannot overrun', async () => {
    const run = async (options: { maxReviewBatchArtifacts: number; maxReviewBatchBytes: number }, expectedError: RegExp) => {
      const { server, base, auth } = await fixture(options)
      try {
        const lease = await begin(base, auth, `concurrent-stage-${options.maxReviewBatchArtifacts}-${options.maxReviewBatchBytes}`)
        const firstBody = gatedBody(new Uint8Array([1]))
        const secondBody = gatedBody(new Uint8Array([2]))
        const request = (id: string, body: ReadableStream<Uint8Array>) => fetch(`${base}/stage/${lease.batchId}/${id}?${auth}`, {
          method: 'PUT',
          headers: {
            ...leaseHeaders(lease), 'content-type': 'image/png',
            'x-artifact-file-name': `${id}.png`, 'x-artifact-result-id': id,
          },
          body,
          redirect: 'error',
          duplex: 'half',
        } as RequestInit & { duplex: 'half' })
        const first = request('one', firstBody.body)
        const second = request('two', secondBody.body)
        await Promise.all([firstBody.started, secondBody.started])
        firstBody.release()
        secondBody.release()
        const responses = await Promise.all([first, second])
        expect(responses.map((response) => response.status).sort()).toEqual([201, 413])
        const rejected = responses.find((response) => response.status === 413)!
        expect((await rejected.json()).error).toMatch(expectedError)
        expect((await finish(base, auth, lease, 'abort')).status).toBe(200)
      } finally { await server.close() }
    }

    await run({ maxReviewBatchArtifacts: 1, maxReviewBatchBytes: 2 }, /count/i)
    await run({ maxReviewBatchArtifacts: 2, maxReviewBatchBytes: 1 }, /bytes/i)
  })

  it('does not treat a GET or cancelled response body as post-download verification', async () => {
    let now = 1_000
    const { server, session, base, auth } = await fixture({ reviewLeaseMs: 100, now: () => now })
    try {
      const originalLease = await begin(base, auth, 'cancel-original')
      const original = await stage(base, auth, originalLease, 'cancel-original-front', 'front', 1) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, originalLease, [original])).status).toBe(201)
      expect((await verifyAndConfirm(base, auth, originalLease, [original])).status).toBe(200)

      const candidateLease = await begin(base, auth, 'cancel-candidate')
      const candidate = await stage(base, auth, candidateLease, 'cancel-candidate-front', 'front', 2) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, candidateLease, [candidate])).status).toBe(201)
      const response = await readCommitted(candidate.url, candidateLease)
      expect(response.status).toBe(200)
      await response.body?.cancel()

      now = 1_100
      const recovered = await begin(base, auth, 'cancel-recovered')
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'cancel-original-front' }])
      expect((await finish(base, auth, recovered, 'abort')).status).toBe(200)
    } finally { await server.close() }
  })

  it('keeps ordinary GET read-only for a prepared candidate with or without lease headers', async () => {
    const { server, session, base, auth } = await fixture({ reviewLeaseMs: 100 })
    try {
      const originalLease = await begin(base, auth, 'verified-original')
      const original = await stage(base, auth, originalLease, 'verified-original-front', 'front', 1) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, originalLease, [original])).status).toBe(201)
      expect((await verifyAndConfirm(base, auth, originalLease, [original])).status).toBe(200)

      const candidateLease = await begin(base, auth, 'verified-candidate')
      const candidate = await stage(base, auth, candidateLease, 'verified-candidate-front', 'front', 2) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, candidateLease, [candidate])).status).toBe(201)
      expect((await readCommitted(candidate.url, candidateLease)).status).toBe(200)
      expect((await acknowledgeReadback(base, auth, candidateLease, [candidate])).status).toBe(200)

      // A failed final live barrier can still restore the prior complete set.
      expect((await finish(base, auth, candidateLease, 'abort')).status).toBe(200)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'verified-original-front' }])

      const preparedLease = await begin(base, auth, 'verified-prepared')
      const prepared = await stage(base, auth, preparedLease, 'verified-prepared-front', 'front', 3) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, preparedLease, [prepared])).status).toBe(201)
      expect((await readCommitted(prepared.url, preparedLease)).status).toBe(200)
      expect((await acknowledgeReadback(base, auth, preparedLease, [prepared])).status).toBe(200)

      expect((await readCommitted(prepared.url, preparedLease)).status).toBe(200)
      expect((await fetch(prepared.url)).status).toBe(200)
      expect((await finish(base, auth, preparedLease, 'abort')).status).toBe(200)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'verified-original-front' }])
    } finally { await server.close() }
  })

  it('does not renew a prepared lease when GET authenticates its readback headers', async () => {
    const { server, base, auth } = await fixture({ reviewLeaseMs: 120 })
    try {
      const lease = await begin(base, auth, 'get-does-not-renew')
      const artifact = await stage(base, auth, lease, 'candidate-front', 'front', 3) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, lease, [artifact])).status).toBe(201)
      expect((await readCommitted(artifact.url, lease)).status).toBe(200)
      expect((await acknowledgeReadback(base, auth, lease, [artifact])).status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect((await readCommitted(artifact.url, lease)).status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 70))
      expect((await acquire(base, auth, 'after-read-only-get')).status).toBe(201)
    } finally { await server.close() }
  })

  it('rejects legacy finalize without sealing a receipt-confirmed candidate', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const lease = await begin(base, auth, 'lost-success-ack')
      const artifact = await stage(base, auth, lease, 'lost-success-front', 'front', 4) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, lease, [artifact])).status).toBe(201)
      expect((await readCommitted(artifact.url, lease)).status).toBe(200)
      expect((await acknowledgeReadback(base, auth, lease, [artifact])).status).toBe(200)

      expect((await finish(base, auth, lease, 'finalize')).status).toBe(409)
      expect((await finish(base, auth, lease, 'abort')).status).toBe(200)
      expect(server.getArtifacts(session.id)).toEqual([])
      expect((await fetch(artifact.url)).status).toBe(404)
    } finally { await server.close() }
  })

  it('explicitly seals the exact receipt-bound batch and replays confirmation after response loss', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const lease = await begin(base, auth, 'task10-explicit-seal')
      const artifact = await stage(base, auth, lease, 'private-front', 'front', 7) as {
        id: string
        resultId: string
        sha256: string
        byteLength: number
        mimeType: string
        url: string
      }
      expect((await commit(base, auth, lease, [artifact])).status).toBe(201)
      expect((await readCommitted(artifact.url, lease)).status).toBe(200)
      const receipt = await acknowledgeReadback(base, auth, lease, [artifact])
      expect(receipt.status).toBe(200)
      const receiptBody = await receipt.json() as { expiresAt: number }

      const confirmed = await confirmReadback(base, auth, lease, receiptBody.expiresAt, [artifact])
      expect(confirmed.status).toBe(200)
      await confirmed.body?.cancel()

      const replay = await confirmReadback(base, auth, lease, receiptBody.expiresAt, [artifact])
      expect(replay.status).toBe(200)
      expect(await replay.json()).toEqual({
        ok: true,
        batchId: lease.batchId,
        generation: lease.generation,
        sealed: true,
        artifactIds: ['private-front'],
        resultIds: ['front'],
      })
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'private-front' }])
      expect((await fetch(artifact.url)).status).toBe(200)
    } finally { await server.close() }
  })

  it('replays an old exact confirmation without consulting or mutating a newer same-batch generation', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const firstLease = await begin(base, auth, 'same-batch')
      const first = await stage(base, auth, firstLease, 'first-private-front', 'front', 1) as {
        id: string; resultId: string; sha256: string; byteLength: number; mimeType: string; url: string
      }
      expect((await commit(base, auth, firstLease, [first])).status).toBe(201)
      expect((await readCommitted(first.url, firstLease)).status).toBe(200)
      const firstReceipt = await acknowledgeReadback(base, auth, firstLease, [first])
      const firstReceiptBody = await firstReceipt.json() as { expiresAt: number }
      const firstConfirmation = await confirmReadback(base, auth, firstLease, firstReceiptBody.expiresAt, [first])
      const firstPayload = await firstConfirmation.json()
      expect(firstConfirmation.status).toBe(200)

      const secondLease = await begin(base, auth, 'same-batch')
      const second = await stage(base, auth, secondLease, 'second-private-front', 'front', 2) as {
        id: string; resultId: string; sha256: string; byteLength: number; mimeType: string; url: string
      }
      expect((await commit(base, auth, secondLease, [second])).status).toBe(201)
      expect((await readCommitted(second.url, secondLease)).status).toBe(200)
      expect((await acknowledgeReadback(base, auth, secondLease, [second])).status).toBe(200)

      const exactReplay = await confirmReadback(base, auth, firstLease, firstReceiptBody.expiresAt, [first])
      expect(exactReplay.status).toBe(200)
      expect(await exactReplay.json()).toEqual(firstPayload)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'second-private-front' }])

      expect((await confirmReadback(base, auth, firstLease, firstReceiptBody.expiresAt, [{
        ...first, sha256: '0'.repeat(64),
      }])).status).toBe(409)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'second-private-front' }])
      expect((await finish(base, auth, secondLease, 'abort')).status).toBe(200)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'first-private-front' }])
    } finally { await server.close() }
  })

  it('rejects a mismatched explicit seal without replacing the prior complete set', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const originalLease = await begin(base, auth, 'seal-prior')
      const original = await stage(base, auth, originalLease, 'prior-front', 'front', 1) as {
        id: string
        resultId: string
        sha256: string
        url: string
      }
      expect((await commit(base, auth, originalLease, [original])).status).toBe(201)
      expect((await verifyAndConfirm(base, auth, originalLease, [original])).status).toBe(200)

      const candidateLease = await begin(base, auth, 'seal-candidate')
      const candidate = await stage(base, auth, candidateLease, 'candidate-front', 'front', 2) as {
        id: string
        resultId: string
        sha256: string
        url: string
      }
      expect((await commit(base, auth, candidateLease, [candidate])).status).toBe(201)
      expect((await readCommitted(candidate.url, candidateLease)).status).toBe(200)
      const receipt = await acknowledgeReadback(base, auth, candidateLease, [candidate])
      const receiptBody = await receipt.json() as { expiresAt: number }

      expect((await confirmReadback(base, auth, candidateLease, receiptBody.expiresAt, [{
        ...candidate,
        sha256: '0'.repeat(64),
      }])).status).toBe(409)
      expect((await finish(base, auth, candidateLease, 'abort')).status).toBe(200)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'prior-front' }])
      expect((await fetch(original.url)).status).toBe(200)
      expect((await fetch(candidate.url)).status).toBe(404)
    } finally { await server.close() }
  })

  it('rejects legacy writes that collide with current review internal or result ids without corrupting the index', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const lease = await begin(base, auth, 'legacy-collision-review')
      const artifact = await stage(base, auth, lease, 'private-review-front', 'front', 5) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, lease, [artifact])).status).toBe(201)
      expect((await verifyAndConfirm(base, auth, lease, [artifact])).status).toBe(200)

      for (const id of ['private-review-front', 'front']) {
        const collision = await fetch(`${base}/${id}?${auth}`, {
          method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([9]),
        })
        expect(collision.status).toBe(409)
      }
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'private-review-front', sha256: artifact.sha256 }])

      const legacy = await fetch(`${base}/legacy-preview?${auth}`, {
        method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([9]),
      })
      expect(legacy.status).toBe(201)
      expect(server.getArtifacts(session.id).map((item: { id: string }) => item.id).sort()).toEqual(['front', 'legacy-preview'])
    } finally { await server.close() }
  })

  it('rejects a review logical result id that aliases a legacy artifact without changing either set', async () => {
    const { server, session, base, auth } = await fixture()
    try {
      const legacy = await fetch(`${base}/front?${auth}`, {
        method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([9]),
      })
      expect(legacy.status).toBe(201)

      const lease = await begin(base, auth, 'review-result-aliases-legacy')
      const collision = await fetch(`${base}/stage/${lease.batchId}/private-review-front?${auth}`, {
        method: 'PUT',
        headers: {
          ...leaseHeaders(lease),
          'content-type': 'image/png',
          'x-artifact-file-name': 'front.png',
          'x-artifact-result-id': 'front',
        },
        body: new Uint8Array([7]),
      })
      expect(collision.status).toBe(409)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'front' }])
      expect((await finish(base, auth, lease, 'abort')).status).toBe(200)
      expect(server.getArtifacts(session.id)).toMatchObject([{ id: 'front', internalId: 'front' }])
    } finally { await server.close() }
  })

  it('expires abandoned staging/committed leases within a bound and rolls committed state back exactly', async () => {
    let now = 1_000
    const { server, session, base, auth } = await fixture({ reviewLeaseMs: 50, now: () => now })
    try {
      const originalLease = await begin(base, auth, 'original')
      const original = await stage(base, auth, originalLease, 'original-front', 'front', 1) as { id: string; resultId: string; sha256: string; url: string }
      expect((await commit(base, auth, originalLease, [original])).status).toBe(201)
      expect((await verifyAndConfirm(base, auth, originalLease, [original])).status).toBe(200)

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
