import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { chromium } from 'playwright'
import designReviewManifestSchema from '../../src/agent/design-review-manifest-v1.schema.json' with { type: 'json' }
import layoutBlueprintSchema from '../../src/agent/layout-blueprint-v1.schema.json' with { type: 'json' }
import { publishAtomically, sanitizeArtifactName, sha256Bytes } from './files.mjs'
import { isStrictRfc3339DateTime, validateManifestSemantics } from './design-manifest-core.mjs'
import { validatedSvgGeometry } from './svg-path-core.mjs'
import { resolveCustomCarrierBoundary } from './carrier-boundary-core.mjs'
import { resolvePortableLayerTransform, fallbackTextBaselineFromTop } from './layer-transform-core.mjs'
import { resolvePortableTextDirection } from './text-direction-core.mjs'
import { canonicalPortableFontStack, portableFontStackCss, validatePortableFontStack } from './font-stack-core.mjs'
import { portablePngDimensions } from './png-core.mjs'
import { resolvePortableTextLayoutMetric } from './text-layout-core.mjs'
import { orderedPortableLayers } from './layer-order-core.mjs'

const MAX_ASSET_BYTES = 16 * 1024 * 1024
const MAX_DECODED_IMAGE_PIXELS = 16 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 16_384
const MAX_CAPTURE_DIMENSION = 4_096
const MAX_CAPTURE_PIXELS = 16 * 1024 * 1024
const PACKAGE_HORIZONTAL_INSET = 56
const PACKAGE_TOP_INSET = 36
const PACKAGE_BOTTOM_INSET = 24

const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addFormat('date-time', { type: 'string', validate: isStrictRfc3339DateTime })
const validateBlueprintSchema = ajv.compile(layoutBlueprintSchema)
const validateManifestSchema = ajv.compile(designReviewManifestSchema)

export class DesignReviewError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'DesignReviewError'
    this.code = code
    if (details) this.details = details
  }
}

function schemaError(code, label, validator) {
  const issues = (validator.errors ?? []).map((issue) => ({
    path: issue.instancePath || '/', keyword: issue.keyword, message: issue.message ?? 'invalid value',
  }))
  return new DesignReviewError(code, `${label} schema validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`, { issues })
}

function assertUnique(values, label) {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function assertSafeColor(value, field) {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} is not a bounded CSS color`)
  }
  const safe = /^#[0-9a-f]{3,8}$/i.test(value)
    || /^[a-z]+$/i.test(value)
    || /^(?:rgb|rgba|hsl|hsla)\([0-9.,%+\-\s/deg]+\)$/i.test(value)
  if (!safe) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} contains unsafe CSS`)
}

function validatePathData(pathData, viewBox, width, height, field) {
  try {
    return validatedSvgGeometry(pathData, viewBox, width, height)
  } catch (error) {
    throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} is not a supported bounded SVG path: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateBlueprintSemantics(blueprint, pxPerMm = 1, geometry = { layers: new Map(), boundaries: new Map() }) {
  assertUnique(blueprint.assets.map((asset) => asset.id), 'asset id')
  assertUnique(blueprint.areas.map((area) => area.id), 'area id')
  const front = blueprint.areas.filter((area) => area.side === 'front')
  const back = blueprint.areas.filter((area) => area.side === 'back')
  if (front.length !== 1 || back.length !== 1) {
    throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', 'Blueprint requires exactly one unambiguous front area and one back area')
  }
  const assetsById = new Map(blueprint.assets.map((asset) => [asset.id, asset]))
  const assetIds = new Set(assetsById.keys())
  const layerIds = []
  const layersById = new Map()
  for (const area of blueprint.areas) {
    assertSafeColor(area.artboard.background, `${area.id}.artboard.background`)
    if (area.carrier === 'bare' && area.layers.length > 0) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `bare area ${area.id} must have no decorative content`)
    if (area.carrier === 'applied_label' && (!area.substrate || area.substrate.kind !== 'opaque' || area.substrate.opacity <= 0 || !area.substrate.boundary)) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `applied_label area ${area.id} requires an opaque nonzero substrate boundary`)
    }
    if (area.carrier === 'clear_label' && (!area.substrate || area.substrate.kind !== 'transparent' || !area.substrate.boundary || area.substrate.opacity >= 1)) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `clear_label area ${area.id} requires a transparent film boundary`)
    }
    if (['direct_surface_print', 'in_mold', 'foil_or_ink_only', 'bare'].includes(area.carrier) && area.substrate) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${area.carrier} area ${area.id} forbids a substrate panel`)
    }
    if (area.substrate) {
      assertSafeColor(area.substrate.color, `${area.id}.substrate.color`)
      if (area.substrate.boundary?.shape === 'custom') {
        const resolved = resolveCustomCarrierBoundary(area.substrate.boundary.pathData)
        if (!resolved) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${area.id}.substrate.boundary.pathData must be closed with positive finite bounds`)
        geometry.boundaries.set(area.id, validatePathData(resolved.pathData, [resolved.pathBounds.x, resolved.pathBounds.y, resolved.pathBounds.width, resolved.pathBounds.height], area.artboard.widthMm * pxPerMm, area.artboard.heightMm * pxPerMm, `${area.id}.substrate.boundary.pathData`))
      }
    }
    for (const layer of area.layers) {
      layerIds.push(layer.id)
      layersById.set(layer.id, layer)
      if (layer.assetId && !assetIds.has(layer.assetId)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Unknown asset ${layer.assetId} on ${area.id}/${layer.id}`)
      if (layer.fontAsset && !assetIds.has(layer.fontAsset)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Unknown font asset ${layer.fontAsset} on ${area.id}/${layer.id}`)
      for (const process of layer.processes) {
        if (process.spotName === 'white_underbase') throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `white_underbase is reserved (${area.id}/${layer.id})`)
        if (area.carrier === 'clear_label' && process.process === 'white_underbase' && process.requiredMask !== 'white_underbase') {
          throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `clear_label white_underbase on ${area.id}/${layer.id} requires requiredMask white_underbase`)
        }
      }
      if (layer.kind === 'text') {
        const hasOneFontSource = Boolean(layer.fontAsset) !== Boolean(layer.fontStack)
        if (layer.text === undefined || !layer.language || !layer.writingDirection || !hasOneFontSource
          || layer.fontSizeMm === undefined || layer.fontWeight === undefined || layer.letterSpacingEm === undefined
          || layer.lineHeight === undefined || !layer.alignment || !layer.wrapPolicy || layer.maxLines === undefined || !layer.color) {
          throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Text layer ${area.id}/${layer.id} is missing required typography fields`)
        }
        if (layer.fontAsset && !['font/woff', 'font/woff2'].includes(assetsById.get(layer.fontAsset)?.mimeType)) {
          throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Text layer ${area.id}/${layer.id} fontAsset must reference WOFF or WOFF2`)
        }
        if (layer.fontStack && !validatePortableFontStack(layer.fontStack)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Text layer ${area.id}/${layer.id} fontStack is unsafe or unbounded`)
      }
      if (layer.kind === 'image' && !layer.assetId) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Image layer ${area.id}/${layer.id} requires assetId`)
      if (layer.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(assetsById.get(layer.assetId)?.mimeType)) {
        throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Image layer ${area.id}/${layer.id} assetId must reference a supported image`)
      }
      if (layer.kind === 'shape' && !layer.shape) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Shape layer ${area.id}/${layer.id} requires shape`)
      if (layer.kind === 'shape' && layer.shape === 'path' && (!layer.pathData || !layer.pathViewBox)) {
        throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Path layer ${area.id}/${layer.id} requires pathData and pathViewBox`)
      }
      if (layer.flattenedFallback && !layer.flattenedFallback.accepted) {
        throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Flattened fallback for ${area.id}/${layer.id} must be explicitly accepted`)
      }
      for (const [name, color] of [['color', layer.color], ['fill', layer.fill], ['stroke', layer.stroke]]) assertSafeColor(color, `${area.id}/${layer.id}.${name}`)
      if (layer.kind === 'shape' && layer.shape === 'path') {
        const bounds = layer.boundsMm ?? {
          width: layer.normalizedBounds.width * area.artboard.widthMm,
          height: layer.normalizedBounds.height * area.artboard.heightMm,
        }
        geometry.layers.set(layer.id, validatePathData(layer.pathData, layer.pathViewBox, bounds.width * pxPerMm, bounds.height * pxPerMm, `${area.id}/${layer.id}.pathData`))
      }
      if (layer.kind === 'shape' && !['rectangle', 'rounded_rectangle', 'ellipse', 'line', 'polygon', 'path'].includes(layer.shape)) {
        throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Unsupported shape ${layer.shape} on ${area.id}/${layer.id}`)
      }
    }
  }
  assertUnique(layerIds, 'layer id')
  for (const area of blueprint.areas) {
    for (const layer of area.layers) {
      const fallback = layer.flattenedFallback
      if (!fallback) continue
      for (const disclosedId of fallback.nonEditableLayerIds) {
        if (!layersById.has(disclosedId)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Flattened fallback references missing layer: ${disclosedId}`)
      }
      for (const disclosedId of fallback.nonEditableTextIds) {
        const disclosedLayer = layersById.get(disclosedId)
        if (!disclosedLayer) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Flattened fallback references missing text layer: ${disclosedId}`)
        if (disclosedLayer.kind !== 'text') throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Flattened fallback text reference is not text: ${disclosedId}`)
      }
    }
  }
}

function prepareLayoutBlueprint(blueprint, pxPerMm = 1) {
  if (!validateBlueprintSchema(blueprint)) throw schemaError('INVALID_LAYOUT_BLUEPRINT', 'Layout blueprint', validateBlueprintSchema)
  const validated = structuredClone(blueprint)
  for (const area of validated.areas) for (const layer of area.layers) {
    if (layer.kind === 'text' && layer.fontStack) layer.fontStack = canonicalPortableFontStack(layer.fontStack)
  }
  const geometry = { layers: new Map(), boundaries: new Map() }
  validateBlueprintSemantics(validated, pxPerMm, geometry)
  return { blueprint: validated, geometry }
}

export function validateLayoutBlueprint(blueprint, pxPerMm = 1) {
  return prepareLayoutBlueprint(blueprint, pxPerMm).blueprint
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function attr(value) {
  return escapeHtml(value)
}

function cssNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', 'Non-finite layout coordinate')
  return Number(number.toFixed(6)).toString()
}

function cssFontStack(fontStack) {
  return portableFontStackCss(fontStack ?? ['sans-serif'])
}

function layerBounds(layer, area, pxPerMm) {
  const bounds = layer.boundsMm ?? {
    x: layer.normalizedBounds.x * area.artboard.widthMm,
    y: layer.normalizedBounds.y * area.artboard.heightMm,
    width: layer.normalizedBounds.width * area.artboard.widthMm,
    height: layer.normalizedBounds.height * area.artboard.heightMm,
  }
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value * pxPerMm]))
}

function renderShape(layer, bounds, pxPerMm, preparedGeometry) {
  const strokeWidth = (layer.strokeWidthMm ?? 0) * pxPerMm
  const common = `fill="${attr(layer.fill ?? 'transparent')}" stroke="${attr(layer.stroke ?? 'transparent')}" stroke-width="${cssNumber(strokeWidth)}" vector-effect="non-scaling-stroke"`
  if (layer.shape === 'path') {
    const geometry = preparedGeometry ?? validatedSvgGeometry(layer.pathData, layer.pathViewBox, bounds.width, bounds.height)
    return `<svg class="shape-geometry" viewBox="${attr(geometry.viewBox.join(' '))}" preserveAspectRatio="none"><path d="${attr(geometry.pathData)}" fill-rule="${attr(layer.fillRule ?? 'nonzero')}" ${common}/></svg>`
  }
  if (layer.shape === 'ellipse') return `<svg class="shape-geometry" viewBox="0 0 100 100" preserveAspectRatio="none"><ellipse cx="50" cy="50" rx="49" ry="49" ${common}/></svg>`
  if (layer.shape === 'line') return `<svg class="shape-geometry" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M0 50L100 50" ${common}/></svg>`
  if (layer.shape === 'polygon') {
    const points = (layer.points ?? []).map((point) => `${cssNumber(point[0])},${cssNumber(point[1])}`).join(' ')
    return `<svg class="shape-geometry" viewBox="0 0 1 1" preserveAspectRatio="none"><polygon points="${attr(points)}" ${common}/></svg>`
  }
  const radius = layer.shape === 'rounded_rectangle' ? (layer.cornerRadiusMm ?? 0) * pxPerMm : 0
  return `<svg class="shape-geometry" viewBox="0 0 ${cssNumber(bounds.width)} ${cssNumber(bounds.height)}" preserveAspectRatio="none"><rect x="0" y="0" width="${cssNumber(bounds.width)}" height="${cssNumber(bounds.height)}" rx="${cssNumber(radius)}" ${common}/></svg>`
}

function renderLayer(layer, area, options) {
  if (!layer.visible || layer.opacity <= 0) return ''
  const bounds = layerBounds(layer, area, options.pxPerMm)
  const textMetric = layer.kind === 'text' ? options.textMetrics?.get(layer.id) : undefined
  const renderWidth = textMetric?.width ?? bounds.width
  const renderHeight = textMetric?.height ?? bounds.height
  const baselineFromTop = textMetric?.baselineFromTop ?? (layer.kind === 'text' ? fallbackTextBaselineFromTop(layer.fontSizeMm * options.pxPerMm, layer.lineHeight) : renderHeight / 2)
  const anchorX = bounds.x + (layer.anchor === 'top_center' || layer.anchor === 'center' || layer.anchor === 'baseline_center' ? bounds.width / 2 : 0)
  const anchorY = bounds.y + (layer.anchor === 'center' ? bounds.height / 2 : 0)
  const resolved = resolvePortableLayerTransform({ x: anchorX, y: anchorY, rotation: layer.rotation, width: renderWidth, height: renderHeight, anchor: layer.anchor, baselineFromTop })
  const transform = layer.rotation ? `rotate(${cssNumber(layer.rotation)}deg)` : ''
  const style = `left:${cssNumber(resolved.origin.x + resolved.box.x)}px;top:${cssNumber(resolved.origin.y + resolved.box.y)}px;width:${cssNumber(renderWidth)}px;height:${cssNumber(renderHeight)}px;opacity:${cssNumber(layer.opacity)};z-index:${layer.zIndex};transform-origin:${cssNumber(-resolved.box.x)}px ${cssNumber(-resolved.box.y)}px;${transform ? `transform:${transform};` : ''}`
  let content = ''
  if (layer.kind === 'text') {
    const fontFamily = layer.fontAsset ? `"review-font-${layer.fontAsset}"` : cssFontStack(layer.fontStack)
    const wrapping = layer.wrapPolicy === 'none'
      ? 'white-space:pre;overflow-wrap:normal;'
      : layer.wrapPolicy === 'character'
        ? 'white-space:pre-wrap;overflow-wrap:anywhere;'
        : 'white-space:pre-wrap;overflow-wrap:normal;'
    const textStyle = `font-family:${fontFamily};font-size:${cssNumber(layer.fontSizeMm * options.pxPerMm)}px;font-weight:${layer.fontWeight};letter-spacing:${cssNumber(layer.letterSpacingEm)}em;line-height:${cssNumber(layer.lineHeight)};text-align:${layer.alignment === 'justify' ? 'justify' : layer.alignment};color:${layer.color};max-height:${cssNumber(layer.lineHeight * layer.maxLines)}em;overflow:hidden;${wrapping}`
    content = `<div class="text-geometry" lang="${attr(layer.language)}" dir="${resolvePortableTextDirection(layer.writingDirection, layer.text)}" data-writing-direction="${attr(layer.writingDirection)}" data-wrap-policy="${attr(layer.wrapPolicy)}" data-max-lines="${attr(layer.maxLines)}"${layer.fontAsset ? ` data-font-family="review-font-${attr(layer.fontAsset)}"` : ''} style="${attr(textStyle)}">${escapeHtml(layer.text)}</div>`
  } else if (layer.kind === 'image') {
    const asset = options.assets.get(layer.assetId)
    const objectFit = layer.fit === 'stretch' ? 'fill' : (layer.fit ?? 'contain')
    content = asset ? `<img alt="" src="${attr(asset.dataUrl)}" style="object-fit:${objectFit}">` : ''
  } else content = renderShape(layer, bounds, options.pxPerMm, options.geometry.layers.get(layer.id))
  const resolvedMetric = textMetric ? ` data-resolved-text-width="${cssNumber(textMetric.width)}" data-resolved-text-height="${cssNumber(textMetric.height)}" data-resolved-baseline-from-top="${cssNumber(textMetric.baselineFromTop)}" data-resolved-line-count="${textMetric.lineCount}"` : ''
  return `<div class="art-layer" data-layer-id="${attr(layer.id)}" data-kind="${layer.kind}"${resolvedMetric} style="${attr(style)}">${content}</div>`
}

function boundaryStyle(area, pxPerMm) {
  const boundary = area.substrate?.boundary
  if (!boundary) return ''
  if (boundary.shape === 'ellipse') return 'border-radius:50%;'
  if (boundary.shape === 'rounded_rectangle') return `border-radius:${cssNumber((boundary.radiusMm ?? 0) * pxPerMm)}px;`
  return ''
}

function renderArea(area, options) {
  const dimensions = options.capturePlan.areas.get(area.id)
  if (!dimensions) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Area ${area.id} is missing a capture dimension plan`)
  const { width, height, left, top } = dimensions
  const customBoundary = area.substrate?.boundary?.shape === 'custom'
  const opaqueSubstrate = area.substrate?.kind === 'opaque'
  const filmSubstrate = area.substrate?.kind === 'transparent'
  const substrate = customBoundary
    ? (() => { const geometry = options.geometry.boundaries.get(area.id); if (!geometry) return ''; return `<svg class="carrier-boundary-path"${filmSubstrate ? ' data-diagnostic-film="true"' : ''} viewBox="${attr(geometry.viewBox.join(' '))}" preserveAspectRatio="none"><path d="${attr(geometry.pathData)}" fill="${opaqueSubstrate ? attr(area.substrate.color ?? '#ffffff') : 'transparent'}" fill-opacity="${cssNumber(area.substrate.opacity)}"${filmSubstrate ? ' stroke="rgba(70,110,130,.35)"' : ''}/></svg>` })()
    : opaqueSubstrate
      ? `<div class="carrier-panel carrier-panel--opaque" style="background:${attr(area.substrate.color ?? '#ffffff')};opacity:${cssNumber(area.substrate.opacity)};${boundaryStyle(area, options.pxPerMm)}"></div>`
      : filmSubstrate
        ? `<div class="carrier-film-extent" style="opacity:${cssNumber(area.substrate.opacity)};${boundaryStyle(area, options.pxPerMm)}"></div>`
        : ''
  const layers = area.carrier === 'bare' ? '' : orderedPortableLayers(area.layers).map((layer) => renderLayer(layer, area, options)).join('')
  const selectiveUnderbase = area.carrier === 'clear_label' && area.layers.some((layer) => layer.processes.some((process) => process.process === 'white_underbase' || process.requiredMask === 'white_underbase'))
  return `<div class="area-artboard carrier-${attr(area.carrier)}" data-area-id="${attr(area.id)}" data-carrier="${attr(area.carrier)}" data-selective-underbase="${selectiveUnderbase}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px">${substrate}${layers}</div>`
}

function renderView(side, area, options, revision) {
  const selectiveUnderbase = area.carrier === 'clear_label' && area.layers.some((layer) => layer.processes.some((process) => process.process === 'white_underbase' || process.requiredMask === 'white_underbase'))
  const processNote = selectiveUnderbase ? ' · selective white underbase declared' : ''
  const { width, height } = options.capturePlan.review
  return `<section class="review-view" data-side="${side}" data-blueprint-revision="${attr(revision)}" style="width:${width}px;height:${height}px"><div class="diagnostic"><strong>${side.toUpperCase()}</strong> · ${escapeHtml(area.carrier)} · ${escapeHtml(area.placementIntent)}${processNote} · supplier/sample review required</div><div class="package-silhouette">${renderArea(area, options)}</div></section>`
}

export function renderBlueprintHtml(blueprint, options) {
  assertDimension(options.width, 'width'); assertDimension(options.height, 'height')
  if (typeof options.pxPerMm !== 'number' || !Number.isFinite(options.pxPerMm) || options.pxPerMm <= 0 || options.pxPerMm > 100) {
    throw new DesignReviewError('INVALID_USAGE', 'pxPerMm must be a positive number at most 100')
  }
  const prepared = prepareLayoutBlueprint(blueprint, options.pxPerMm)
  const validated = prepared.blueprint
  const capturePlan = resolveCapturePlan(validated, options.width, options.height, options.pxPerMm)
  if (!(options.assets instanceof Map)) throw new DesignReviewError('INVALID_USAGE', 'assets must be a resolved asset map')
  const front = validated.areas.find((area) => area.side === 'front')
  const back = validated.areas.find((area) => area.side === 'back')
  if (!front || !back) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', 'Front/back areas are required')
  const revision = escapeHtml(validated.revision)
  const fontFaces = validated.assets.flatMap((asset) => {
    const resolved = options.assets.get(asset.id)
    if (!resolved || (asset.mimeType !== 'font/woff' && asset.mimeType !== 'font/woff2')) return []
    const format = asset.mimeType === 'font/woff2' ? 'woff2' : 'woff'
    return [`@font-face{font-family:'review-font-${asset.id}';src:url('${resolved.dataUrl}') format('${format}')}`]
  }).join('')
  const renderOptions = { ...options, geometry: prepared.geometry, capturePlan }
  return `<!doctype html><html lang="en" data-blueprint-revision="${revision}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Label design review ${revision}</title><style>
${fontFaces}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e9e7e2;color:#171717;font-family:Arial,sans-serif}body{display:flex;flex-direction:column;align-items:flex-start}.review-view{position:relative;overflow:hidden;background:#f7f5f0}.diagnostic{position:absolute;z-index:1000;left:16px;top:14px;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.92);font-size:12px}.package-silhouette{position:absolute;inset:${PACKAGE_TOP_INSET}px ${PACKAGE_HORIZONTAL_INSET}px ${PACKAGE_BOTTOM_INSET}px;display:flex;align-items:center;justify-content:center;border-radius:22% 22% 16% 16%;background:linear-gradient(90deg,#d8d4cb,#f2efe8 42%,#cbc6bc);box-shadow:inset -16px 0 30px rgba(0,0,0,.08),0 18px 32px rgba(0,0,0,.12)}.area-artboard{position:absolute;overflow:hidden}.carrier-panel,.carrier-film-extent,.carrier-boundary-path{position:absolute;inset:0;width:100%;height:100%}.carrier-film-extent{border:1px solid rgba(70,110,130,.35);background:transparent}.art-layer{position:absolute}.art-layer img,.shape-geometry{display:block;width:100%;height:100%}.text-geometry{display:block;width:100%;height:auto;overflow:hidden}.text-geometry::after{content:'\\200b'}.capture-clean .diagnostic{display:none}.capture-clean .carrier-film-extent{display:none}.capture-clean .carrier-boundary-path[data-diagnostic-film="true"]{display:none}
</style></head><body>${renderView('front', front, renderOptions, validated.revision)}${renderView('back', back, renderOptions, validated.revision)}</body></html>`
}

function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || path.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.split(/[\\/]+/).includes('..')) {
    throw new DesignReviewError('PATH_NOT_ALLOWED', `${label} must be a safe relative local path`)
  }
  return value
}

function pngDimensions(bytes, policy) {
  return portablePngDimensions(bytes, policy)
}

function jpegDimensions(bytes) {
  const data = Buffer.from(bytes)
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined
  let offset = 2
  while (offset < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset += 1
    if (offset >= data.length) return undefined
    const marker = data[offset++]
    if (marker === 0xd9) return undefined
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > data.length) return undefined
    const length = data.readUInt16BE(offset)
    if (length < 2 || offset + length > data.length) return undefined
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return undefined
      const height = data.readUInt16BE(offset + 3); const width = data.readUInt16BE(offset + 5)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    offset += length
  }
  return undefined
}

function webpDimensions(bytes) {
  const data = Buffer.from(bytes)
  if (data.length < 20 || data.subarray(0, 4).toString('ascii') !== 'RIFF' || data.subarray(8, 12).toString('ascii') !== 'WEBP'
    || data.readUInt32LE(4) + 8 !== data.length) return undefined
  let offset = 12
  while (offset + 8 <= data.length) {
    const kind = data.subarray(offset, offset + 4).toString('ascii')
    const size = data.readUInt32LE(offset + 4); const start = offset + 8; const end = start + size
    if (end > data.length) return undefined
    if (kind === 'VP8X') {
      if (size !== 10) return undefined
      return { width: data.readUIntLE(start + 4, 3) + 1, height: data.readUIntLE(start + 7, 3) + 1 }
    }
    if (kind === 'VP8 ' && size >= 10 && data[start + 3] === 0x9d && data[start + 4] === 0x01 && data[start + 5] === 0x2a) {
      const width = data.readUInt16LE(start + 6) & 0x3fff; const height = data.readUInt16LE(start + 8) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    if (kind === 'VP8L' && size >= 5 && data[start] === 0x2f) {
      const packed = data.readUInt32LE(start + 1)
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
    }
    offset = end + (size % 2)
  }
  return undefined
}

function imageDimensions(bytes, mimeType) {
  const dimensions = mimeType === 'image/png'
    ? pngDimensions(bytes, { maxWidth: MAX_IMAGE_DIMENSION, maxHeight: MAX_IMAGE_DIMENSION, maxPixels: MAX_DECODED_IMAGE_PIXELS })
    : mimeType === 'image/jpeg'
      ? jpegDimensions(bytes)
      : mimeType === 'image/webp'
        ? webpDimensions(bytes)
        : undefined
  if (!dimensions || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width > MAX_DECODED_IMAGE_PIXELS / dimensions.height) return undefined
  return dimensions
}

function validFontContainer(bytes, mimeType) {
  const data = Buffer.from(bytes)
  if (mimeType === 'font/woff') {
    if (data.length < 44 || data.subarray(0, 4).toString('ascii') !== 'wOFF' || data.readUInt32BE(8) !== data.length
      || data.readUInt16BE(12) === 0 || data.readUInt16BE(14) !== 0) return false
    return 44 + data.readUInt16BE(12) * 20 <= data.length && data.readUInt32BE(16) > 0
  }
  if (mimeType === 'font/woff2') {
    if (data.length < 48 || data.subarray(0, 4).toString('ascii') !== 'wOF2' || data.readUInt32BE(8) !== data.length
      || data.readUInt16BE(12) === 0 || data.readUInt16BE(14) !== 0 || data.readUInt32BE(16) === 0) return false
    const compressedSize = data.readUInt32BE(20)
    return compressedSize > 0 && compressedSize <= data.length - 48
  }
  return false
}

function verifyMagic(bytes, mimeType, dimensions) {
  if (mimeType.startsWith('image/')) return Boolean(dimensions)
  if (mimeType === 'font/woff' || mimeType === 'font/woff2') return validFontContainer(bytes, mimeType)
  return false
}

async function resolveLocalFiles(blueprint, blueprintPath, referencePaths) {
  const root = await realpath(path.dirname(blueprintPath))
  const assets = new Map()
  for (const asset of blueprint.assets) {
    const relative = safeRelativePath(asset.path, `Asset ${asset.id}`)
    const absolute = await realpath(path.resolve(root, relative)).catch(() => { throw new DesignReviewError('PATH_NOT_ALLOWED', `Asset ${asset.id} does not exist`) })
    if (!isWithin(root, absolute)) throw new DesignReviewError('PATH_NOT_ALLOWED', `Asset ${asset.id} is outside the blueprint root`)
    const info = await stat(absolute)
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Asset ${asset.id} has an unsupported size`)
    const bytes = await readFile(absolute)
    const digest = sha256Bytes(bytes)
    if (digest !== asset.sha256) throw new DesignReviewError('DIGEST_MISMATCH', `Asset ${asset.id} digest mismatch`)
    const dimensions = imageDimensions(bytes, asset.mimeType)
    if (!verifyMagic(bytes, asset.mimeType, dimensions)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Asset ${asset.id} MIME/magic or decoded dimensions are unsafe`)
    if (dimensions && ((asset.width && asset.width !== dimensions.width) || (asset.height && asset.height !== dimensions.height))) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Asset ${asset.id} dimensions mismatch`)
    }
    assets.set(asset.id, { dataUrl: `data:${asset.mimeType};base64,${Buffer.from(bytes).toString('base64')}`, bytes, mimeType: asset.mimeType })
  }
  const references = []
  for (const input of referencePaths ?? []) {
    const absolute = await realpath(path.resolve(input)).catch(() => { throw new DesignReviewError('PATH_NOT_ALLOWED', `Reference does not exist: ${input}`) })
    if (!isWithin(root, absolute)) throw new DesignReviewError('PATH_NOT_ALLOWED', 'Reference is outside the blueprint root')
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const bytes = await readFile(absolute)
    references.push({ path: safeRelativePath(relative, 'Reference'), sha256: sha256Bytes(bytes), role: 'visual_evidence' })
  }
  return { assets, references }
}

function assertDimension(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CAPTURE_DIMENSION) throw new DesignReviewError('INVALID_USAGE', `${label} must be an integer from 1 to ${MAX_CAPTURE_DIMENSION}`)
}

function capturePixelExtent(value, label, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DesignReviewError(code, `${label} dimensions must be positive finite pixel extents`)
  }
  // Match cssNumber() precision, then cover every device pixel touched by the CSS extent.
  const cssExtent = Number(value.toFixed(6))
  if (!(cssExtent > 0)) throw new DesignReviewError(code, `${label} dimensions are not representable in review CSS pixels`)
  return Math.ceil(cssExtent)
}

export function resolveCaptureDimensions(width, height, { label = 'Capture', code = 'INVALID_LAYOUT_BLUEPRINT' } = {}) {
  const resolved = {
    width: capturePixelExtent(width, label, code),
    height: capturePixelExtent(height, label, code),
  }
  if (resolved.width > MAX_CAPTURE_DIMENSION || resolved.height > MAX_CAPTURE_DIMENSION
    || resolved.width > MAX_CAPTURE_PIXELS / resolved.height) {
    throw new DesignReviewError(code, `${label} dimensions exceed the ${MAX_CAPTURE_DIMENSION}px / ${MAX_CAPTURE_PIXELS}-pixel capture limit`)
  }
  return resolved
}

function resolveCapturePlan(blueprint, width, height, pxPerMm) {
  assertDimension(width, 'width'); assertDimension(height, 'height')
  const review = resolveCaptureDimensions(width, height, { label: 'Requested front/back capture', code: 'INVALID_USAGE' })
  const packageWidth = Math.max(0, review.width - (2 * PACKAGE_HORIZONTAL_INSET))
  const packageHeight = Math.max(0, review.height - PACKAGE_TOP_INSET - PACKAGE_BOTTOM_INSET)
  const areas = new Map()
  for (const area of blueprint.areas) {
    const dimensions = resolveCaptureDimensions(area.artboard.widthMm * pxPerMm, area.artboard.heightMm * pxPerMm, {
      label: `Area ${area.id} capture`, code: 'INVALID_LAYOUT_BLUEPRINT',
    })
    areas.set(area.id, {
      ...dimensions,
      left: Math.round((packageWidth - dimensions.width) / 2),
      top: Math.round((packageHeight - dimensions.height) / 2),
    })
  }
  return { review, areas }
}

function assertCapture(entry, width, height, label) {
  const dimensions = entry && (entry.bytes instanceof Uint8Array || Buffer.isBuffer(entry.bytes))
    ? pngDimensions(entry.bytes, { expectedWidth: width, expectedHeight: height, maxWidth: width, maxHeight: height, maxPixels: width * height })
    : undefined
  if (!entry || !dimensions || entry.width !== width || entry.height !== height || dimensions.width !== width || dimensions.height !== height) {
    throw new DesignReviewError('BROWSER_NOT_READY', `${label} capture returned wrong dimensions or invalid PNG bytes`)
  }
}

export async function captureDesignReview({ html, blueprint, width, height, pxPerMm, resolveHtml, capturePlan }) {
  let browser
  try {
    const plan = resolveCapturePlan(blueprint, width, height, pxPerMm)
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: plan.review, deviceScaleFactor: 1, serviceWorkers: 'block' })
    const externalRequests = []
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.startsWith('data:') || url.startsWith('about:')) await route.continue()
      else { externalRequests.push(url); await route.abort('blockedbyclient') }
    })
    const page = await context.newPage()
    const errors = []
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
    const waitForReady = async () => {
      await page.waitForFunction((revision) => document.documentElement.dataset.blueprintRevision === revision, blueprint.revision, { timeout: 30_000 })
      await page.evaluate(async () => {
        await document.fonts.ready
        await Promise.all([...document.images].map(async (image) => {
          if (!image.complete || image.naturalWidth === 0) await image.decode()
          if (image.naturalWidth === 0) throw new Error('Image decode produced zero dimensions')
        }))
        for (const text of document.querySelectorAll('[data-font-family]')) {
          const family = text.getAttribute('data-font-family')
          const matchingFaces = [...document.fonts].filter((face) => face.family.replace(/^['"]|['"]$/g, '') === family)
          if (!family || matchingFaces.length === 0 || matchingFaces.some((face) => face.status !== 'loaded')
            || !document.fonts.check(`12px "${family}"`)) throw new Error(`Declared font failed to load: ${family ?? 'unknown'}`)
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
    }
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitForReady()
    const rawTextMetrics = await page.evaluate(() => [...document.querySelectorAll('.art-layer[data-kind="text"]')].map((layer) => {
      const text = layer.querySelector('.text-geometry')
      if (!(text instanceof HTMLElement)) throw new Error('Text geometry is missing')
      const style = getComputedStyle(text)
      const fontSize = Number.parseFloat(style.fontSize); const lineHeight = Number.parseFloat(style.lineHeight)
      const canvas = document.createElement('canvas'); const context = canvas.getContext('2d')
      if (!context || !(fontSize > 0) || !(lineHeight > 0)) throw new Error('Text metrics are unavailable')
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const reference = context.measureText('Mg')
      return {
        id: layer.getAttribute('data-layer-id'), width: Number.parseFloat(getComputedStyle(layer).width),
        fontSize, lineHeight: lineHeight / fontSize, lineCount: Math.max(1, Math.round(text.scrollHeight / lineHeight)),
        maxLines: Number(text.getAttribute('data-max-lines')),
        ascent: reference.actualBoundingBoxAscent, descent: reference.actualBoundingBoxDescent,
      }
    }))
    const textMetrics = new Map(rawTextMetrics.map((metric) => [metric.id, resolvePortableTextLayoutMetric(metric)]))
    const resolvedHtml = typeof resolveHtml === 'function' ? resolveHtml(textMetrics) : html
    if (resolvedHtml !== html) {
      await page.setContent(resolvedHtml, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitForReady()
    }
    await page.evaluate(() => { document.body.classList.add('capture-clean') })
    if (externalRequests.length > 0) throw new DesignReviewError('BROWSER_NOT_READY', `External network request blocked: ${externalRequests[0]}`)
    const capture = { areas: {} }
    for (const side of ['front', 'back']) {
      const expected = plan.review
      const locator = page.locator(`[data-side="${side}"]`)
      const box = await locator.boundingBox()
      if (!box || box.width !== expected.width || box.height !== expected.height) throw new DesignReviewError('BROWSER_NOT_READY', `${side} panel dimensions changed`)
      capture[side] = { bytes: await locator.screenshot({ type: 'png', animations: 'disabled' }), ...expected }
    }
    for (const area of blueprint.areas.filter((candidate) => candidate.carrier !== 'bare')) {
      const expected = plan.areas.get(area.id)
      if (!expected) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Area ${area.id} is missing a capture dimension plan`)
      const locator = page.locator(`[data-area-id="${area.id}"]`)
      const box = await locator.boundingBox()
      if (!box || box.width !== expected.width || box.height !== expected.height) throw new DesignReviewError('BROWSER_NOT_READY', `Area ${area.id} dimensions changed`)
      capture.areas[area.id] = {
        bytes: await locator.screenshot({ type: 'png', animations: 'disabled' }),
        width: expected.width, height: expected.height,
      }
    }
    if (errors.length > 0) throw new DesignReviewError('BROWSER_NOT_READY', `Browser rendering failed: ${errors.join('; ')}`)
    await context.close()
    return { ...capture, resolvedHtml }
  } catch (error) {
    if (error?.code) throw error
    throw new DesignReviewError('BROWSER_NOT_READY', `Playwright design review capture failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await browser?.close().catch(() => undefined)
  }
}

export function buildDesignReviewManifest({ blueprint, blueprintSha256, htmlSha256, createdAt, references, artifacts }) {
  const manifest = {
    version: 1,
    createdAt,
    blueprint: { revision: blueprint.revision, sha256: blueprintSha256 },
    html: { sha256: htmlSha256 },
    references: structuredClone(references),
    areas: blueprint.areas.map((area) => ({ id: area.id, side: area.side, carrier: area.carrier })),
    artifacts: structuredClone(artifacts),
  }
  if (!validateManifestSchema(manifest)) throw schemaError('INVALID_DESIGN_REVIEW_MANIFEST', 'Design review manifest', validateManifestSchema)
  try { validateManifestSemantics(manifest, 'design') } catch (error) {
    throw new DesignReviewError('INVALID_DESIGN_REVIEW_MANIFEST', error instanceof Error ? error.message : String(error))
  }
  return manifest
}

export async function renderDesignReview({
  blueprintPath, referencePaths = [], outputDir, width = 1600, height = 1200, pxPerMm = 5,
  force = false, createdAt = new Date().toISOString(), capture = captureDesignReview,
}) {
  assertDimension(width, 'width'); assertDimension(height, 'height')
  if (typeof pxPerMm !== 'number' || !Number.isFinite(pxPerMm) || pxPerMm <= 0 || pxPerMm > 100) throw new DesignReviewError('INVALID_USAGE', 'pxPerMm must be a positive number at most 100')
  if (typeof outputDir !== 'string' || outputDir.length === 0) throw new DesignReviewError('INVALID_USAGE', 'outputDir is required')
  const resolvedBlueprintPath = await realpath(path.resolve(blueprintPath)).catch(() => { throw new DesignReviewError('PATH_NOT_ALLOWED', `Blueprint does not exist: ${blueprintPath}`) })
  const blueprintBytes = await readFile(resolvedBlueprintPath)
  let parsed
  try { parsed = JSON.parse(blueprintBytes.toString('utf8')) } catch (error) { throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Blueprint JSON is invalid: ${error.message}`) }
  const blueprint = validateLayoutBlueprint(parsed, pxPerMm)
  const capturePlan = resolveCapturePlan(blueprint, width, height, pxPerMm)
  const resolvedOutputDir = path.resolve(outputDir)
  if (!force && await stat(resolvedOutputDir).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false
    throw error
  })) {
    throw new DesignReviewError('OUTPUT_CONFLICT', `Output already exists: ${resolvedOutputDir}`)
  }
  const { assets, references } = await resolveLocalFiles(blueprint, resolvedBlueprintPath, referencePaths)
  const provisionalHtml = renderBlueprintHtml(blueprint, { width, height, pxPerMm, assets })
  const captureResult = await capture({
    html: provisionalHtml, blueprint, areas: blueprint.areas, width, height, pxPerMm, capturePlan,
    resolveHtml: (textMetrics) => renderBlueprintHtml(blueprint, { width, height, pxPerMm, assets, textMetrics }),
  })
  const html = capture === captureDesignReview && typeof captureResult.resolvedHtml === 'string' ? captureResult.resolvedHtml : provisionalHtml
  const htmlBytes = Buffer.from(html)
  assertCapture(captureResult.front, capturePlan.review.width, capturePlan.review.height, 'front')
  assertCapture(captureResult.back, capturePlan.review.width, capturePlan.review.height, 'back')

  const publication = []
  const manifestArtifacts = []
  const addArtifact = (id, relativePath, bytes, mimeType, artifactWidth, artifactHeight, viewKind, area) => {
    publication.push({ relativePath, fileName: relativePath, bytes })
    manifestArtifacts.push({
      id, path: relativePath, sha256: sha256Bytes(bytes), mimeType, width: artifactWidth, height: artifactHeight, viewKind,
      ...(area ? { areaId: area.id, carrier: area.carrier } : {}),
    })
  }
  addArtifact('mockup-html', 'mockup.html', htmlBytes, 'text/html', capturePlan.review.width, capturePlan.review.height, 'mockup-html')
  addArtifact('mockup-front', 'mockup-front.png', captureResult.front.bytes, 'image/png', capturePlan.review.width, capturePlan.review.height, 'mockup-front')
  addArtifact('mockup-back', 'mockup-back.png', captureResult.back.bytes, 'image/png', capturePlan.review.width, capturePlan.review.height, 'mockup-back')
  for (const area of blueprint.areas.filter((candidate) => candidate.carrier !== 'bare')) {
    const areaCapture = captureResult.areas?.[area.id]
    const dimensions = capturePlan.areas.get(area.id)
    if (!dimensions) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Area ${area.id} is missing a capture dimension plan`)
    assertCapture(areaCapture, dimensions.width, dimensions.height, `area ${area.id}`)
    const areaToken = sanitizeArtifactName(area.id)
    addArtifact(`mockup-area-${area.id}`, `areas/${areaToken}.png`, areaCapture.bytes, 'image/png', dimensions.width, dimensions.height, 'mockup-area', area)
  }
  const manifest = buildDesignReviewManifest({
    blueprint, blueprintSha256: sha256Bytes(blueprintBytes), htmlSha256: sha256Bytes(htmlBytes), createdAt, references, artifacts: manifestArtifacts,
  })
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  publication.push({ relativePath: 'design-review-manifest.json', fileName: 'design-review-manifest.json', bytes: manifestBytes })
  await mkdir(path.dirname(resolvedOutputDir), { recursive: true })
  await publishAtomically(resolvedOutputDir, publication, { force, sessionId: `design-review-${blueprint.revision}` })
  return {
    outputDir: resolvedOutputDir, html, manifest,
    artifacts: [
      ...manifestArtifacts,
      { id: 'design-review-manifest', path: 'design-review-manifest.json', sha256: sha256Bytes(manifestBytes), mimeType: 'application/json' },
    ],
  }
}
