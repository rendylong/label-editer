// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapAgentBridgeFromPage, createAgentBridge, installAgentBridge } from '../src/agent/bridge'
import { captureAgentPreview, captureAgentQcView, captureAgentReviewView, registerAgentPreviewCapture } from '../src/agent/previewCapture'
import type { QcCameraMetadata, QcViewRequest, ReviewEvidenceRequest, ReviewViewRequest } from '../src/agent/contracts'

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

  it('exposes project import as a guarded bridge operation', async () => {
    const bridge = createAgentBridge({
      applyProject: async ({ project }) => ({ areaIds: ['front'], project: project as Record<string, unknown>, warnings: [] }),
    })
    await expect(bridge.applyProject({ project: { version: 3 } })).resolves.toMatchObject({
      ok: true,
      operation: 'apply_label_project',
      data: { areaIds: ['front'], project: { version: 3 } },
    })
  })

  it('exposes QC evidence as a guarded bridge operation', async () => {
    const bridge = createAgentBridge({
      renderQcEvidence: async () => ({
        preset: 'qc-standard', views: [], areas: [], validation: { ready: true, issues: [] },
      }),
    })
    await expect(bridge.renderQcEvidence({ width: 1440, height: 1440 })).resolves.toMatchObject({
      ok: true,
      operation: 'render_qc_evidence',
      data: { preset: 'qc-standard', views: [] },
    })
  })

  it('exposes production review evidence as a distinct guarded bridge operation', async () => {
    const received: ReviewEvidenceRequest[] = []
    const bridge = createAgentBridge({
      renderReviewEvidence: async (request) => {
        received.push(request ?? { designGate: { handoff: {}, blueprintJson: '', designReviewManifestJson: '', currentDocumentJson: '', designReviewArtifacts: [] } })
        return {
          inputKind: 'label-project-v3' as const, inputRevision: `sha256:${'1'.repeat(64)}`, inputSha256: '2'.repeat(64),
          blueprintRevision: 'design-v1', blueprintSha256: '3'.repeat(64), designReviewManifestSha256: '4'.repeat(64),
          modelFingerprint: '5'.repeat(64), areaTargetsSha256: '6'.repeat(64), views: [],
          resolvedProjectJson: '{"version":3,"modelFileName":"model.glb","areas":[]}',
          resolvedProjectAreaTargetsSha256: '7'.repeat(64),
          confirmation: {
            sessionId: 's1', batchId: 'review-1', leaseToken: 'l'.repeat(32), generation: 1,
            expiresAt: 1_800_000_000_000, artifacts: [],
          },
          validation: { ready: true, issues: [] }, fidelity: { pass: true, issues: [] },
        }
      },
    })
    const request: ReviewEvidenceRequest = {
      width: 1600, height: 1600,
      designGate: { handoff: {}, blueprintJson: '{}', designReviewManifestJson: '{}', currentDocumentJson: '{}', designReviewArtifacts: [] },
    }

    await expect(bridge.renderReviewEvidence(request)).resolves.toMatchObject({
      ok: true, operation: 'render_review_evidence', data: { blueprintRevision: 'design-v1' },
    })
    expect(received).toEqual([request])
  })

  it('exposes a UI-only live preview status operation', async () => {
    const received: unknown[] = []
    const bridge = createAgentBridge({
      setAgentPreviewStatus: async (status) => { received.push(status) },
    })
    const status = { revision: `sha256:${'a'.repeat(64)}`, state: 'ready' as const }

    await expect(bridge.setAgentPreviewStatus(status)).resolves.toMatchObject({
      ok: true,
      operation: 'set_agent_preview_status',
    })
    expect(received).toEqual([status])
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
    const oldDispose = registerAgentPreviewCapture({
      preview: async () => new Blob(['old']),
      qc: async () => { throw new Error('unused') },
      review: async () => { throw new Error('unused') },
    })
    const newDispose = registerAgentPreviewCapture({
      preview: async () => new Blob(['newest']),
      qc: async () => { throw new Error('unused') },
      review: async () => { throw new Error('unused') },
    })
    oldDispose()
    expect((await captureAgentPreview({ width: 800, height: 800 })).size).toBe(6)
    newDispose()
    await expect(captureAgentPreview({ width: 800, height: 800 })).rejects.toThrow(/not ready/i)
  })

  it('forwards the complete QC request to the newest viewport owner', async () => {
    const cameraMetadata: QcCameraMetadata = {
      position: [0, 0, 3], direction: [0, 0, 1], target: [0, 0, 0],
      up: [0, 1, 0], fov: 45,
    }
    const qcViewRequest: QcViewRequest = {
      id: 'model-front', target: { kind: 'model' }, framing: 'fit-model',
      pose: { kind: 'direction', direction: [0, 0, 1] }, channel: 'color',
      width: 1440, height: 1440, reason: 'Primary front-label check',
    }
    const received: unknown[] = []
    const dispose = registerAgentPreviewCapture({
      preview: async () => new Blob(['preview']),
      qc: async (request) => {
        received.push(request)
        return { blob: new Blob(['png']), camera: cameraMetadata }
      },
      review: async () => { throw new Error('unused') },
    })

    const result = await captureAgentQcView(qcViewRequest)

    expect(received).toEqual([qcViewRequest])
    expect(result.camera).toEqual(cameraMetadata)
    dispose()
    await expect(captureAgentQcView(qcViewRequest)).rejects.toMatchObject({
      code: 'BROWSER_NOT_READY', message: expect.stringMatching(/not ready/i),
    })
  })

  it('forwards exact review requests and previously captured sources to the newest viewport owner', async () => {
    const request: ReviewViewRequest = {
      id: 'surface-front', kind: 'surface-face', width: 1600, height: 1600,
      areaId: 'opaque.front', areaToken: 'opaque.front', side: 'front', carrier: 'direct_surface_print',
    }
    const received: unknown[] = []
    const dispose = registerAgentPreviewCapture({
      preview: async () => new Blob(['preview']),
      qc: async () => { throw new Error('unused') },
      review: async (view, context) => {
        received.push(view, context)
        return {
          id: view.id, kind: view.kind, blob: new Blob(['png'], { type: 'image/png' }),
          width: view.width, height: view.height,
          camera: { position: [0, 0, 3], direction: [0, 0, -1], target: [0, 0, 0], up: [0, 1, 0], fov: 45 },
        }
      },
    })
    const context = { blueprintRevision: 'design-v1', inputRevision: `sha256:${'1'.repeat(64)}`, sources: [] }

    const result = await captureAgentReviewView(request, context)

    expect(received).toEqual([request, context])
    expect(result).toMatchObject({ id: 'surface-front', kind: 'surface-face', width: 1600, height: 1600 })
    dispose()
    await expect(captureAgentReviewView(request, context)).rejects.toMatchObject({ code: 'BROWSER_NOT_READY' })
  })
})
