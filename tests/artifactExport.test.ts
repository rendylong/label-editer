import { describe, expect, it } from 'vitest'
import { createPrintArtifact, createProjectArtifact } from '../src/agent/artifactExport'
import type { LabelAreaConfig } from '../src/label/types'

function area(): LabelAreaConfig {
  return {
    id: 'front', name: 'Front / Main', meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay',
    remap: { mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [-1, -1, -1], max: [1, 1, 1] } },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 512, height: 256, aspect: 2 },
    printSpec: { physicalWidthMm: 42, physicalHeightMm: 60, bleedMm: 2, cornerRadiusMm: 1, minTextHeightMm: 1.2, dieCutShape: 'rounded-rectangle', spotColors: [] },
    layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

describe('artifact byte services', () => {
  it('serializes an editable project without a browser download side effect', () => {
    const artifact = createProjectArtifact('bottle.glb', [area()])
    const project = JSON.parse(new TextDecoder().decode(artifact.bytes))
    expect(artifact).toMatchObject({
      id: 'project', fileName: 'project.lbl.json', mimeType: 'application/json',
    })
    expect(project).toMatchObject({ version: 3, modelFileName: 'bottle.glb' })
  })

  it('returns a sanitized print-manifest filename and physical dimensions', () => {
    const artifact = createPrintArtifact(area())
    const manifest = JSON.parse(new TextDecoder().decode(artifact.bytes))
    expect(artifact.fileName).toBe('Front-Main-print-manifest.json')
    expect(manifest.dimensionsMm).toEqual({ width: 42, height: 60, bleed: 2, cornerRadius: 1 })
  })
})
