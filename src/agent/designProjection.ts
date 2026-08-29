import { compileBlueprintArea, compileBlueprintToSpecAreas } from './blueprintCompiler'
import type { LayoutBlueprintV1 } from './designContracts'
import { WorkflowGateError } from './workflowGateError'
import { sha256HexSync } from './syncSha256'
import { applyStructuredLabelSpec } from '../app/labelSpec'
import { resolvePhysicalLayer } from '../app/physicalLayout'
import { parseLabelProject } from '../app/projectSchema'
import { canonicalFontStack } from '../label/fontStack'
import { uploadedFontRecord } from '../label/fontRuntime'
import { normalizeShapeLayer } from '../label/shapeGeometry'
import { canonicalLayerOrder, compareOrdinalText } from '../label/layerOrder'
import type { CraftEffect, LabelAreaConfig, LabelLayer } from '../label/types'

type UnknownRecord = Record<string, unknown>
type Asset = LayoutBlueprintV1['assets'][number]

const CANONICAL_CANVAS_HEIGHT = 4096
const MAX_EMBEDDED_DATA_URL_LENGTH = 28 * 1024 * 1024

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function projectionError(message: string, details: Record<string, unknown> = {}): never {
  throw new WorkflowGateError('APPROVAL_REQUIRED', message, { field: 'currentDocument.design', ...details })
}

function cloneOrNull(value: unknown): unknown {
  return value === undefined ? null : structuredClone(value)
}

function decodeDataUrl(value: string, label: string): { bytes: Uint8Array; mimeType: string } {
  if (value.length > MAX_EMBEDDED_DATA_URL_LENGTH) {
    return projectionError(`${label} exceeds the bounded design-projection limit`, {
      maximumDataUrlLength: MAX_EMBEDDED_DATA_URL_LENGTH,
    })
  }
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(value)
  if (!match) return projectionError(`${label} is not a representable data URL`)
  try {
    if (match[2]) {
      const binary = globalThis.atob(match[3])
      return {
        bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
        mimeType: (match[1] || 'application/octet-stream').toLowerCase(),
      }
    }
    return {
      bytes: new TextEncoder().encode(decodeURIComponent(match[3])),
      mimeType: (match[1] || 'text/plain').toLowerCase(),
    }
  } catch {
    return projectionError(`${label} contains malformed encoded bytes`)
  }
}

function assetSignature(asset: Asset): UnknownRecord {
  return { sha256: asset.sha256, mimeType: asset.mimeType.toLowerCase() }
}

function dataUrlSignature(value: string, label: string): UnknownRecord {
  const decoded = decodeDataUrl(value, label)
  const sha256 = sha256HexSync(decoded.bytes)
  return { sha256, mimeType: decoded.mimeType }
}

function assetIdentity(value: string, label: string, blueprint?: LayoutBlueprintV1): UnknownRecord {
  const approved = blueprint?.assets.find((asset) => asset.path === value)
  if (approved) return assetSignature(approved)
  if (value.startsWith('data:')) return dataUrlSignature(value, label)
  return { path: value }
}

function fontIdentity(layer: Extract<LabelLayer, { kind: 'text' }>, area: LabelAreaConfig, blueprint?: LayoutBlueprintV1): UnknownRecord {
  if (layer.fontStack?.length) return { stack: canonicalFontStack(layer.fontStack) }
  const embedded = uploadedFontRecord(layer.fontFamily, area.fonts)
  if (embedded) return dataUrlSignature(embedded.dataUrl, `embedded font ${embedded.name}`)
  return assetIdentity(layer.fontFamily, `font ${layer.fontFamily}`, blueprint)
}

function normalizedCraft(effects: CraftEffect[], canvas: LabelAreaConfig['canvas']): CraftEffect[] {
  const scalar = Math.sqrt(canvas.width * canvas.height)
  return effects.map((effect) => ({
    ...structuredClone(effect),
    params: {
      ...structuredClone(effect.params),
      ...(effect.type === 'stroke' && typeof effect.params.strokeWidth === 'number'
        ? { strokeWidth: effect.params.strokeWidth / scalar }
        : {}),
    },
  }))
}

function commonLayerProjection(layer: LabelLayer, area: LabelAreaConfig): UnknownRecord {
  return {
    id: layer.id,
    kind: layer.kind,
    x: layer.x / area.canvas.width,
    y: layer.y / area.canvas.height,
    rotation: layer.rotation,
    opacity: layer.opacity,
    visible: layer.visible,
    anchor: layer.designMetrics?.anchor ?? 'top_left',
    craft: normalizedCraft(layer.craft, area.canvas),
    processes: cloneOrNull(layer.processes ?? []),
  }
}

/**
 * Physical metadata is approval authority, but Project v3 stores and renders
 * the raw editable layer on first load. Keep the resolver result as a second,
 * explicit projection instead of replacing those actual runtime inputs.
 */
function resolvedPhysicalProjection(rawLayer: LabelLayer, area: LabelAreaConfig): UnknownRecord {
  const layer = resolvePhysicalLayer(area, structuredClone(rawLayer))
  const common = {
    x: layer.x / area.canvas.width,
    y: layer.y / area.canvas.height,
    anchor: layer.designMetrics?.anchor ?? 'top_left',
  }
  if (layer.kind === 'text') {
    return {
      ...common,
      width: (layer.width ?? 0) / area.canvas.width,
      fontSize: layer.fontSize / area.canvas.height,
      letterSpacing: layer.letterSpacing / area.canvas.height,
      lineHeight: layer.lineHeight,
    }
  }
  if (layer.kind === 'image') {
    return {
      ...common,
      width: layer.width / area.canvas.width,
      height: layer.height / area.canvas.height,
    }
  }
  const shape = normalizeShapeLayer(layer)
  const scalar = Math.sqrt(area.canvas.width * area.canvas.height)
  return {
    ...common,
    width: shape.width / area.canvas.width,
    height: shape.height / area.canvas.height,
    strokeWidth: shape.strokeWidth / scalar,
    cornerRadius: shape.cornerRadius / scalar,
  }
}

function normalizedGeometry(layer: Extract<LabelLayer, { kind: 'shape' }>, area: LabelAreaConfig): UnknownRecord {
  const normalized = normalizeShapeLayer(layer).geometry!
  const scalar = Math.sqrt(area.canvas.width * area.canvas.height)
  return {
    sides: normalized.sides,
    points: normalized.points,
    innerRatio: normalized.innerRatio,
    amplitude: (normalized.amplitude ?? 0) / area.canvas.height,
    frequency: normalized.frequency,
    arrowStart: normalized.arrowStart,
    arrowEnd: normalized.arrowEnd,
    parallel: normalized.parallel,
    dash: (normalized.dash ?? []).map((value) => value / scalar),
    inset: (normalized.inset ?? 0) / scalar,
    rows: normalized.rows,
    columns: normalized.columns,
    gap: (normalized.gap ?? 0) / scalar,
  }
}

function layerProjection(rawLayer: LabelLayer, area: LabelAreaConfig, blueprint?: LayoutBlueprintV1): UnknownRecord {
  const layer = structuredClone(rawLayer)
  const common = commonLayerProjection(layer, area)
  const resolvedPhysical = resolvedPhysicalProjection(rawLayer, area)
  if (layer.kind === 'text') {
    return {
      ...common,
      text: layer.text,
      font: fontIdentity(layer, area, blueprint),
      fontWeight: layer.fontWeight,
      fontSize: layer.fontSize / area.canvas.height,
      letterSpacing: layer.letterSpacing / area.canvas.height,
      lineHeight: layer.lineHeight,
      width: (layer.width ?? 0) / area.canvas.width,
      color: layer.color,
      align: layer.align,
      italic: layer.italic,
      direction: layer.direction ?? 'horizontal',
      writingDirection: layer.writingDirection ?? 'auto',
      language: layer.language ?? null,
      wrapPolicy: layer.designMetrics?.wrapPolicy ?? 'word',
      maxLines: layer.designMetrics?.maxLines ?? null,
      resolvedPhysical,
    }
  }
  if (layer.kind === 'image') {
    const fit = layer.fit ?? 'stretch'
    const sourceWidth = layer.naturalWidth > 0 ? layer.naturalWidth : Math.max(1, layer.width)
    const sourceHeight = layer.naturalHeight > 0 ? layer.naturalHeight : Math.max(1, layer.height)
    return {
      ...common,
      asset: assetIdentity(layer.src, `image ${area.id}/${layer.id}`, blueprint),
      fit,
      sourceAspect: fit === 'stretch' ? null : sourceWidth / sourceHeight,
      width: layer.width / area.canvas.width,
      height: layer.height / area.canvas.height,
      resolvedPhysical,
    }
  }
  const shape = normalizeShapeLayer(layer)
  const scalar = Math.sqrt(area.canvas.width * area.canvas.height)
  return {
    ...common,
    shape: shape.shape,
    geometry: normalizedGeometry(shape, area),
    width: shape.width / area.canvas.width,
    height: shape.height / area.canvas.height,
    fill: shape.fill,
    stroke: shape.stroke,
    strokeWidth: shape.strokeWidth / scalar,
    cornerRadius: shape.cornerRadius / scalar,
    pathData: shape.pathData ?? null,
    pathViewBox: cloneOrNull(shape.pathViewBox),
    fillRule: shape.fillRule ?? 'nonzero',
    resolvedPhysical,
  }
}

function assertUniqueRenderIdentity(area: LabelAreaConfig): void {
  const layerIds = new Set<string>()
  for (const layer of area.layers) {
    if (layerIds.has(layer.id)) projectionError(`Area ${area.id} has duplicate layer id ${layer.id}`)
    layerIds.add(layer.id)
  }
  const fontNames = new Set<string>()
  for (const font of area.fonts) {
    if (fontNames.has(font.name)) projectionError(`Area ${area.id} has duplicate embedded font ${font.name}`)
    fontNames.add(font.name)
  }
}

function areaProjection(area: LabelAreaConfig, blueprint?: LayoutBlueprintV1): UnknownRecord {
  assertUniqueRenderIdentity(area)
  const ordered = canonicalLayerOrder(area.layers)
  const layers = ordered.map((layer) => layerProjection(layer, area, blueprint))
  const fontAssets = layers.flatMap((layer) => layer.kind === 'text' ? [layer.font] : [])
    .filter((value, index, values) => values.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(value)) === index)
    .sort((left, right) => compareOrdinalText(JSON.stringify(left), JSON.stringify(right)))
  return {
    id: area.blueprintAreaId ?? area.id,
    side: area.side ?? null,
    carrier: area.carrier ?? null,
    artboard: cloneOrNull(area.artboard),
    substrate: cloneOrNull(area.substrate),
    carrierSurface: area.carrier === undefined ? cloneOrNull(area.paper) : null,
    globalCraft: normalizedCraft(area.globalCraft.craft, area.canvas),
    fontAssets,
    layers,
  }
}

function canonicalCanvas(area: UnknownRecord): LabelAreaConfig['canvas'] {
  const artboard = isRecord(area.artboard) ? area.artboard : undefined
  const widthMm = typeof artboard?.widthMm === 'number' && artboard.widthMm > 0 ? artboard.widthMm : 1
  const heightMm = typeof artboard?.heightMm === 'number' && artboard.heightMm > 0 ? artboard.heightMm : 1
  const aspect = widthMm / heightMm
  return { width: CANONICAL_CANVAS_HEIGHT * aspect, height: CANONICAL_CANVAS_HEIGHT, aspect }
}

function specBase(area: UnknownRecord): LabelAreaConfig {
  const canvas = canonicalCanvas(area)
  return {
    id: String(area.id),
    name: typeof area.name === 'string' ? area.name : String(area.id),
    meshIndex: 0,
    nodeName: String(area.id),
    surfaceMode: area.surfaceMode === 'replace' ? 'replace' : 'overlay',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [-1, -1, -1], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas,
    paper: { enabled: false, color: '#ffffff', opacity: 0 },
    layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
    undoStack: [], redoStack: [],
  }
}

function specAreas(document: UnknownRecord): LabelAreaConfig[] {
  if (!Array.isArray(document.areas)) return projectionError('Label Spec areas are unavailable')
  return document.areas.map((rawArea) => {
    if (!isRecord(rawArea)) return projectionError('Label Spec area is not representable')
    const mapped = applyStructuredLabelSpec(specBase(rawArea), { version: 2, areas: [rawArea] }, 'projection').areas[0]
    return {
      ...mapped,
      id: String(rawArea.id),
      globalCraft: { craft: Array.isArray(rawArea.globalCraft) ? structuredClone(rawArea.globalCraft) as CraftEffect[] : [] },
    }
  })
}

function projectAreas(document: UnknownRecord): LabelAreaConfig[] {
  try {
    return parseLabelProject(document).areas.map((area) => ({ ...area, undoStack: [], redoStack: [] }))
  } catch (error) {
    return projectionError('Project render inputs are not representable', {
      reason: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256),
    })
  }
}

function stableAreas(areas: LabelAreaConfig[], blueprint?: LayoutBlueprintV1): UnknownRecord[] {
  return areas.map((area) => areaProjection(area, blueprint))
    .sort((left, right) => compareOrdinalText(String(left.id), String(right.id)))
}

export function canonicalDocumentDesignProjection(document: unknown, blueprint?: LayoutBlueprintV1): UnknownRecord {
  if (!isRecord(document)) return projectionError('Current Spec/Project must be a JSON object')
  const areas = document.version === 2
    ? specAreas(document)
    : document.version === 3 ? projectAreas(document) : projectionError('Current Spec/Project version is not representable')
  return { areas: stableAreas(areas, blueprint) }
}

function expectedProjectAreas(blueprint: LayoutBlueprintV1, currentDocument: UnknownRecord): LabelAreaConfig[] {
  const current = projectAreas(currentDocument)
  return blueprint.areas.map((area) => {
    const shell = current.find((candidate) => (candidate.blueprintAreaId ?? candidate.id) === area.id)
    if (!shell) return projectionError(`Approved blueprint area ${area.id} has no current Project shell`)
    const compiled = compileBlueprintArea(blueprint, area, {
      blueprintAreaId: area.id,
      name: shell.name,
      target: {
        meshIndex: shell.meshIndex,
        ...(shell.stableSelector === undefined ? {} : { stableSelector: shell.stableSelector }),
        nodeName: shell.nodeName,
      },
      surfaceMode: shell.surfaceMode,
      range: shell.range,
    })
    const base: LabelAreaConfig = {
      ...structuredClone(shell),
      side: undefined,
      carrier: undefined,
      artboard: undefined,
      substrate: undefined,
      placementPolicy: undefined,
      blueprintAreaId: undefined,
      designBinding: undefined,
      paper: { enabled: false, color: '#ffffff', opacity: 0 },
      layers: [], globalCraft: { craft: [] }, fonts: [], undoStack: [], redoStack: [],
    }
    const mapped = applyStructuredLabelSpec(base, { version: 2, areas: [compiled] }, 'approved-projection').areas[0]
    return {
      ...mapped,
      id: shell.id,
      meshIndex: shell.meshIndex,
      ...(shell.nodeIndex === undefined ? {} : {
        nodeIndex: shell.nodeIndex,
        stableSelector: shell.stableSelector,
      }),
      nodeName: shell.nodeName,
    }
  })
}

export function canonicalApprovedBlueprintDesignProjection(
  blueprint: LayoutBlueprintV1,
  currentDocument?: unknown,
): UnknownRecord {
  if (isRecord(currentDocument) && currentDocument.version === 3) {
    return { areas: stableAreas(expectedProjectAreas(blueprint, currentDocument), blueprint) }
  }
  const compiled = compileBlueprintToSpecAreas(blueprint)
  return canonicalDocumentDesignProjection({ version: 2, areas: compiled }, blueprint)
}
