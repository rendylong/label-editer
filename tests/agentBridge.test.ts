// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapAgentBridgeFromPage, createAgentBridge, installAgentBridge } from '../src/agent/bridge'
import { captureAgentPreview, registerAgentPreviewCapture } from '../src/agent/previewCapture'

const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('browser Agent Bridge guard', () => {
  afterEach(() => delete window.__GLB_LABEL_EDITOR_AGENT_V1__)

  it.each([
    ['https://example.com/?agent=1&token=' + token, token],
    ['http://127.0.0.1:4178/?token=' + token, token],
    ['http://127.0.0.1:4178/?agent=1&token=wrong', token],
    ['http://127.0.0.1:4178/?agent=1&token=short', 'short'],
  ])('does not register for rejected context %s', (url, expectedToken) => {
    const dispose = installAgentBridge({
      location: new URL(url),
      expectedToken,
      bridge: {} as never,
    })
    expect(window.__GLB_LABEL_EDITOR_AGENT_V1__).toBeUndefined()
    dispose()
  })

  it('registers and disposes only for a valid loopback handshake', () => {
    const bridge = { reset: async () => ({ ok: true }) } as never
    const dispose = installAgentBridge({
      location: new URL(`http://127.0.0.1:4178/?agent=1&token=${token}`),
      expectedToken: token,
      bridge,
    })
    expect(window.__GLB_LABEL_EDITOR_AGENT_V1__).toBe(bridge)
    dispose()
    expect(window.__GLB_LABEL_EDITOR_AGENT_V1__).toBeUndefined()
  })

  it('wraps bridge operation failures in a structured envelope', async () => {
    const bridge = createAgentBridge({
      reset: async () => { throw new Error('reset exploded') },
    })

    await expect(bridge.reset()).resolves.toEqual({
      ok: false,
      operation: 'reset',
      error: { code: 'INTERNAL_ERROR', message: 'reset exploded' },
      warnings: [],
    })
  })

  it('trusts the token returned by the same-origin bootstrap response', async () => {
    const bridge = createAgentBridge({ reset: async () => undefined })
    const dispose = await bootstrapAgentBridgeFromPage({
      location: new URL(`http://localhost:4178/?agent=1&session=s1&token=${token}`),
      fetcher: async () => new Response(JSON.stringify({ token, artifactUploadBase: '/session/s1/artifact' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      createBridge: () => bridge,
    })
    expect(window.__GLB_LABEL_EDITOR_AGENT_V1__).toBe(bridge)
    dispose()
  })

  it('rejects a bootstrap response whose token differs from the query capability', async () => {
    await bootstrapAgentBridgeFromPage({
      location: new URL(`http://localhost:4178/?agent=1&session=s1&token=${token}`),
      fetcher: async () => new Response(JSON.stringify({ token: `${token}x` }), { status: 200 }),
      createBridge: () => createAgentBridge(),
    })
    expect(window.__GLB_LABEL_EDITOR_AGENT_V1__).toBeUndefined()
  })

  it('keeps the newest preview capture owner when an old viewport unmounts', async () => {
    const oldDispose = registerAgentPreviewCapture(async () => new Blob(['old']))
    const newDispose = registerAgentPreviewCapture(async () => new Blob(['newest']))
    oldDispose()
    expect((await captureAgentPreview({ width: 800, height: 800 })).size).toBe(6)
    newDispose()
    await expect(captureAgentPreview({ width: 800, height: 800 })).rejects.toThrow(/not ready/i)
  })
})
