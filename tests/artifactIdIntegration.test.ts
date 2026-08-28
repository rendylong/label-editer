import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAreaChannelArtifacts, createPrintArtifacts } from '../src/agent/artifactExport'
import type { LabelAreaConfig } from '../src/label/types'
// @ts-expect-error Node plugin server is intentionally authored as directly executable ESM.
import { createSessionServer } from '../scripts/lib/session-server.mjs'

function area(id: string): LabelAreaConfig {
  return {
    id,
    name: id,
    meshIndex: 0,
    nodeName: 'Bottle',
    surfaceMode: 'overlay',
    remap: {
      mode: 'planar', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 16, height: 16, aspect: 1 },
    carrier: 'direct_surface_print',
    layers: [],
    globalCraft: { craft: [] },
    fonts: [],
    referenceVisible: false,
    undoStack: [],
    redoStack: [],
  }
}

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

function canvas(): HTMLCanvasElement {
  return {
    width: 1,
    height: 1,
    toBlob(callback: BlobCallback) {
      callback(new Blob([ONE_PIXEL_PNG], { type: 'image/png' }))
    },
  } as HTMLCanvasElement
}

describe('area-derived artifact ids against the real session server', () => {
  it('uploads every real multi-area print and channel artifact uniquely with opaque ASCII ids', async () => {
    const editorRoot = await mkdtemp(path.join(tmpdir(), 'glb-label-artifact-id-'))
    await writeFile(path.join(editorRoot, 'index.html'), '<main>editor</main>')
    const server = await createSessionServer({ editorRoot })
    try {
      const session = server.createSession()
      const ids = [
        'same:token', 'same-token', '同名区域', 'area-a60c59e5db5f5219',
        'Area', 'area', 'é', 'e\u0301', 'print-manifest-x', 'x-color',
      ]
      const areas = ids.map(area)
      const bakeMap = Object.fromEntries(ids.map((id) => [id, { color: canvas() }]))
      const artifacts = [
        ...await createAreaChannelArtifacts(areas, bakeMap),
        ...createPrintArtifacts(areas, bakeMap),
      ]
      for (const artifact of artifacts) {
        const response = await fetch(
          `${server.origin}/session/${session.id}/artifact/${encodeURIComponent(artifact.id)}?token=${session.token}`,
          {
            method: 'PUT',
            headers: {
              'content-type': artifact.mimeType,
              'x-artifact-file-name': encodeURIComponent(artifact.fileName),
            },
            body: artifact.bytes as BodyInit,
            redirect: 'error',
          },
        )
        expect(response.status, artifact.id).toBe(201)
      }
      const uploadedIds = server.getArtifacts(session.id).map((artifact: { id: string }) => artifact.id)
      expect(new Set(uploadedIds).size).toBe(artifacts.length)
      expect(uploadedIds.every((id: string) => /^[A-Za-z0-9._-]{1,160}$/.test(id))).toBe(true)
    } finally {
      await server.close()
    }
  })
})
