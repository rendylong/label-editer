import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createAreaChannelArtifacts,
  createChannelArtifact,
  createPrintArtifact,
  createPrintArtifacts,
} from '../src/agent/artifactExport'
import { buildQcCapturePlan, qcAreaToken } from '../src/agent/qcCapturePlan'
import { buildReviewCapturePlan } from '../src/agent/reviewCapturePlan'
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
      const rawTokenAdversary = qcAreaToken('同名区域')
      const ids = [
        'same:token', 'same-token', '同名区域', rawTokenAdversary,
        'Area', 'area', 'é', 'e\u0301', '\uD800', '\uD801',
        'print-manifest-x', 'x-color',
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

  it('uses one cryptographic per-id token across single, filtered, reversed, QC, review, print, and channel commands', async () => {
    const opaqueId = '同名区域'
    const rawTokenAdversary = qcAreaToken(opaqueId)
    const ids = [
      opaqueId,
      rawTokenAdversary,
      'Area',
      'area',
      'é',
      'e\u0301',
      '\uD800',
      '\uD801',
      'print-manifest-x',
      'x-color',
    ]
    const targets = ids.map(area)
    const bakeMap = Object.fromEntries(ids.map((id) => [id, { color: canvas() }]))
    const target = targets[0]
    const token = qcAreaToken(opaqueId)

    // The slug is only descriptive; every opaque id, including a safe one,
    // is bound to the complete fixed SHA-256 digest encoded as 52 base32 chars.
    expect(qcAreaToken('front')).toBe('front-fwgwsmlxvrcisx6afqaj5q7wv4zokhvqa6b4c4aa24cr2ftcxe5a')
    expect(token).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,57}$/)

    const singleChannel = await createChannelArtifact(target, bakeMap[opaqueId], 'color')
    const singlePrint = createPrintArtifact(target, bakeMap[opaqueId])
    const batches = [
      targets,
      [...targets].reverse(),
      targets.filter((candidate) => candidate.id !== 'area'),
      [target],
    ]
    for (const batch of batches) {
      const channel = (await createAreaChannelArtifacts(batch, bakeMap))
        .find((artifact) => artifact.areaId === opaqueId)
      const print = createPrintArtifacts(batch, bakeMap)
        .find((artifact) => artifact.areaId === opaqueId)
      expect(channel?.id).toBe(singleChannel.id)
      expect(print?.id).toBe(singlePrint.id)
    }
    expect(singleChannel.id).toBe(`area-${token}-channel-color`)
    expect(singlePrint.id).toBe(`area-${token}-print-manifest`)

    const qc = buildQcCapturePlan({
      preset: 'qc-standard', width: 1, height: 1,
      areas: targets, customViews: [],
    })
    expect(qc.find((view) => view.areaId === opaqueId && view.pose.kind === 'area-face')?.id)
      .toBe(`area-${token}-face`)

    const review = buildReviewCapturePlan({
      width: 1,
      height: 1,
      areas: targets.map(({ id }, index) => ({
        id,
        side: 'custom' as const,
        carrier: index === targets.length - 1 ? 'bare' as const : 'direct_surface_print' as const,
      })),
    })
    expect(review.find((view) => view.areaId === opaqueId)).toMatchObject({ areaToken: token })

    const canonicalTokens = ids.map((id) => qcAreaToken(id))
    expect(new Set(canonicalTokens.map((value) => value.normalize('NFKC').toLowerCase())).size)
      .toBe(ids.length)
  })
})
