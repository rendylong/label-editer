import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { chromium } from 'playwright'
import designReviewManifestSchema from '../../src/agent/design-review-manifest-v1.schema.json' with { type: 'json' }
import layoutBlueprintSchema from '../../src/agent/layout-blueprint-v1.schema.json' with { type: 'json' }
import { publishAtomically, sanitizeArtifactName, sha256Bytes } from './files.mjs'

const MAX_ASSET_BYTES = 16 * 1024 * 1024
const ALLOWED_PATH_COMMANDS = new Set('MmLlHhVvCcQqAaZz')
const PATH_PARAMETER_COUNTS = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, A: 7 }
const MAX_PATH_COMMANDS = 4096
const NUMBER_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const TOKEN_PATTERN = /[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function validDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText)
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addFormat('date-time', { type: 'string', validate: validDateTime })
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

function validatePathData(pathData, viewBox, field) {
  if (typeof pathData !== 'string' || pathData.length === 0 || pathData.length > 131072) {
    throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} must be a bounded SVG path`)
  }
  const tokens = pathData.match(TOKEN_PATTERN) ?? []
  const remainder = pathData.replace(TOKEN_PATTERN, '').replace(/[\s,]+/g, '')
  const malformedSeparator = /^\s*,/.test(pathData) || /,\s*,/.test(pathData) || /,\s*$/.test(pathData)
    || /[A-Za-z]\s*,/.test(pathData) || /,\s*[A-Za-z]/.test(pathData)
  if (remainder || malformedSeparator || tokens.length === 0 || !['M', 'm'].includes(tokens[0])) {
    throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} has invalid SVG path syntax`)
  }
  for (const token of tokens) {
    if (/^[A-Za-z]$/.test(token)) {
      if (!ALLOWED_PATH_COMMANDS.has(token)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} uses unsupported SVG command ${token}`)
    } else if (!NUMBER_TOKEN.test(token) || !Number.isFinite(Number(token)) || Math.abs(Number(token)) > 1e9) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} contains an unsafe coordinate`)
    }
  }
  let index = 0
  let activeCommand
  let emittedCommands = 0
  let currentX = 0
  let currentY = 0
  let subpathX = 0
  let subpathY = 0
  const fail = (message) => { throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} ${message}`) }
  const emit = () => {
    emittedCommands += 1
    if (emittedCommands > MAX_PATH_COMMANDS) fail(`emits more than ${MAX_PATH_COMMANDS} commands`)
  }
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index])) {
      activeCommand = tokens[index]
      index += 1
      if (!ALLOWED_PATH_COMMANDS.has(activeCommand)) fail(`uses unsupported SVG command ${activeCommand}`)
      if (activeCommand.toUpperCase() === 'Z') {
        if (emittedCommands === 0) fail('must begin with M or m')
        emit()
        currentX = subpathX
        currentY = subpathY
        activeCommand = undefined
        continue
      }
    }
    if (!activeCommand) fail('has parameters without a preceding command')
    if (emittedCommands === 0 && activeCommand.toUpperCase() !== 'M') fail('must begin with M or m')
    const upper = activeCommand.toUpperCase()
    const parameterCount = PATH_PARAMETER_COUNTS[upper]
    const relative = activeCommand === activeCommand.toLowerCase()
    let emittedForCommand = 0
    while (index < tokens.length && !/^[A-Za-z]$/.test(tokens[index])) {
      const values = tokens.slice(index, index + parameterCount)
      if (values.length !== parameterCount || values.some((value) => /^[A-Za-z]$/.test(value))) fail(`${activeCommand} has incomplete parameters`)
      index += parameterCount
      const numbers = values.map(Number)
      const x = (value) => relative ? currentX + value : value
      const y = (value) => relative ? currentY + value : value
      const safeDerived = (...derived) => {
        if (derived.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e9)) fail('contains an unsafe derived coordinate')
      }
      if (upper === 'M' || upper === 'L') {
        const endpointX = x(numbers[0]); const endpointY = y(numbers[1])
        safeDerived(endpointX, endpointY)
        currentX = endpointX; currentY = endpointY
        if (upper === 'M' && emittedForCommand === 0) { subpathX = currentX; subpathY = currentY }
      } else if (upper === 'H') { const endpointX = x(numbers[0]); safeDerived(endpointX); currentX = endpointX }
      else if (upper === 'V') { const endpointY = y(numbers[0]); safeDerived(endpointY); currentY = endpointY }
      else if (upper === 'C') {
        const derived = [x(numbers[0]), y(numbers[1]), x(numbers[2]), y(numbers[3]), x(numbers[4]), y(numbers[5])]
        safeDerived(...derived); currentX = derived[4]; currentY = derived[5]
      }
      else if (upper === 'Q') {
        const derived = [x(numbers[0]), y(numbers[1]), x(numbers[2]), y(numbers[3])]
        safeDerived(...derived); currentX = derived[2]; currentY = derived[3]
      }
      else if (upper === 'A') {
        if (!(numbers[0] > 0) || !(numbers[1] > 0)) fail('arc radii must be positive')
        if (!['0', '1'].includes(values[3]) || !['0', '1'].includes(values[4])) fail('arc flags must be 0 or 1')
        const endpointX = x(numbers[5]); const endpointY = y(numbers[6])
        safeDerived(endpointX, endpointY)
        if (endpointX === currentX && endpointY === currentY) fail('arc endpoints must differ')
        currentX = endpointX; currentY = endpointY
      }
      emit()
      emittedForCommand += 1
    }
    if (emittedForCommand === 0) fail(`${activeCommand} requires parameters`)
  }
  if (viewBox) {
    if (!Array.isArray(viewBox) || viewBox.length !== 4 || viewBox.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      || viewBox[2] <= 0 || viewBox[3] <= 0 || viewBox.some((value) => Math.abs(value) > 1e9)) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${field} has an unsafe viewBox`)
    }
  }
}

function validateBlueprintSemantics(blueprint) {
  assertUnique(blueprint.assets.map((asset) => asset.id), 'asset id')
  assertUnique(blueprint.areas.map((area) => area.id), 'area id')
  const front = blueprint.areas.filter((area) => area.side === 'front')
  const back = blueprint.areas.filter((area) => area.side === 'back')
  if (front.length !== 1 || back.length !== 1) {
    throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', 'Blueprint requires exactly one unambiguous front area and one back area')
  }
  const assetIds = new Set(blueprint.assets.map((asset) => asset.id))
  const layerIds = []
  const layersById = new Map()
  for (const area of blueprint.areas) {
    assertSafeColor(area.artboard.background, `${area.id}.artboard.background`)
    if (area.carrier === 'bare' && area.layers.length > 0) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `bare area ${area.id} must have no decorative content`)
    if (area.carrier === 'applied_label' && (!area.substrate || !area.substrate.boundary)) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `applied_label area ${area.id} requires a substrate boundary`)
    }
    if (area.carrier === 'clear_label' && (!area.substrate || area.substrate.kind !== 'transparent' || !area.substrate.boundary || area.substrate.opacity >= 1)) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `clear_label area ${area.id} requires a transparent film boundary`)
    }
    if (['direct_surface_print', 'in_mold', 'foil_or_ink_only', 'bare'].includes(area.carrier) && area.substrate) {
      throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `${area.carrier} area ${area.id} forbids a substrate panel`)
    }
    if (area.substrate) {
      assertSafeColor(area.substrate.color, `${area.id}.substrate.color`)
      if (area.substrate.boundary?.shape === 'custom') validatePathData(area.substrate.boundary.pathData, undefined, `${area.id}.substrate.boundary.pathData`)
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
      }
      if (layer.kind === 'image' && !layer.assetId) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Image layer ${area.id}/${layer.id} requires assetId`)
      if (layer.kind === 'shape' && !layer.shape) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Shape layer ${area.id}/${layer.id} requires shape`)
      if (layer.kind === 'shape' && layer.shape === 'path' && (!layer.pathData || !layer.pathViewBox)) {
        throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Path layer ${area.id}/${layer.id} requires pathData and pathViewBox`)
      }
      if (layer.flattenedFallback && !layer.flattenedFallback.accepted) {
        throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Flattened fallback for ${area.id}/${layer.id} must be explicitly accepted`)
      }
      for (const [name, color] of [['color', layer.color], ['fill', layer.fill], ['stroke', layer.stroke]]) assertSafeColor(color, `${area.id}/${layer.id}.${name}`)
      if (layer.kind === 'shape' && layer.shape === 'path') validatePathData(layer.pathData, layer.pathViewBox, `${area.id}/${layer.id}.pathData`)
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

export function validateLayoutBlueprint(blueprint) {
  if (!validateBlueprintSchema(blueprint)) throw schemaError('INVALID_LAYOUT_BLUEPRINT', 'Layout blueprint', validateBlueprintSchema)
  validateBlueprintSemantics(blueprint)
  return structuredClone(blueprint)
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
  return (fontStack ?? ['sans-serif']).map((font) => `'${String(font).replace(/[\\']/g, '')}'`).join(',')
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

function anchorTransform(anchor) {
  if (anchor === 'top_center') return 'translateX(-50%)'
  if (anchor === 'center') return 'translate(-50%,-50%)'
  if (anchor === 'baseline_left') return 'translateY(-100%)'
  if (anchor === 'baseline_center') return 'translate(-50%,-100%)'
  return ''
}

function renderShape(layer, bounds, pxPerMm) {
  const strokeWidth = (layer.strokeWidthMm ?? 0) * pxPerMm
  const common = `fill="${attr(layer.fill ?? 'transparent')}" stroke="${attr(layer.stroke ?? 'transparent')}" stroke-width="${cssNumber(strokeWidth)}" vector-effect="non-scaling-stroke"`
  if (layer.shape === 'path') {
    return `<svg class="shape-geometry" viewBox="${attr(layer.pathViewBox.join(' '))}" preserveAspectRatio="none"><path d="${attr(layer.pathData)}" fill-rule="${attr(layer.fillRule ?? 'nonzero')}" ${common}/></svg>`
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
  const transforms = [anchorTransform(layer.anchor), layer.rotation ? `rotate(${cssNumber(layer.rotation)}deg)` : ''].filter(Boolean).join(' ')
  const style = `left:${cssNumber(bounds.x)}px;top:${cssNumber(bounds.y)}px;width:${cssNumber(bounds.width)}px;height:${cssNumber(bounds.height)}px;opacity:${cssNumber(layer.opacity)};z-index:${layer.zIndex};${transforms ? `transform:${transforms};` : ''}`
  let content = ''
  if (layer.kind === 'text') {
    const fontFamily = layer.fontAsset ? `'review-font-${layer.fontAsset}'` : cssFontStack(layer.fontStack)
    const wrapping = layer.wrapPolicy === 'none'
      ? 'white-space:nowrap;overflow-wrap:normal;'
      : layer.wrapPolicy === 'character'
        ? 'white-space:pre-wrap;overflow-wrap:anywhere;'
        : 'white-space:pre-wrap;overflow-wrap:normal;'
    const textStyle = `font-family:${fontFamily};font-size:${cssNumber(layer.fontSizeMm * options.pxPerMm)}px;font-weight:${attr(layer.fontWeight)};letter-spacing:${cssNumber(layer.letterSpacingEm)}em;line-height:${cssNumber(layer.lineHeight)};text-align:${layer.alignment === 'justify' ? 'justify' : layer.alignment};color:${attr(layer.color)};direction:${layer.writingDirection === 'rtl' ? 'rtl' : 'ltr'};${wrapping}`
    content = `<div class="text-geometry"${layer.fontAsset ? ` data-font-family="review-font-${attr(layer.fontAsset)}"` : ''} style="${textStyle}">${escapeHtml(layer.text)}</div>`
  } else if (layer.kind === 'image') {
    const asset = options.assets.get(layer.assetId)
    const objectFit = layer.fit === 'stretch' ? 'fill' : (layer.fit ?? 'contain')
    content = asset ? `<img alt="" src="${attr(asset.dataUrl)}" style="object-fit:${objectFit}">` : ''
  } else content = renderShape(layer, bounds, options.pxPerMm)
  return `<div class="art-layer" data-layer-id="${attr(layer.id)}" data-kind="${layer.kind}" style="${style}">${content}</div>`
}

function boundaryStyle(area, pxPerMm) {
  const boundary = area.substrate?.boundary
  if (!boundary) return ''
  if (boundary.shape === 'ellipse') return 'border-radius:50%;'
  if (boundary.shape === 'rounded_rectangle') return `border-radius:${cssNumber((boundary.radiusMm ?? 0) * pxPerMm)}px;`
  return ''
}

function renderArea(area, options) {
  const width = area.artboard.widthMm * options.pxPerMm
  const height = area.artboard.heightMm * options.pxPerMm
  const customBoundary = area.substrate?.boundary?.shape === 'custom'
  const opaqueSubstrate = area.substrate?.kind === 'opaque'
  const filmSubstrate = area.substrate?.kind === 'transparent'
  const substrate = customBoundary
    ? `<svg class="carrier-boundary-path" viewBox="0 0 ${cssNumber(width)} ${cssNumber(height)}" preserveAspectRatio="none"><path d="${attr(area.substrate.boundary.pathData)}" fill="${opaqueSubstrate ? attr(area.substrate.color ?? '#ffffff') : 'transparent'}" fill-opacity="${cssNumber(area.substrate.opacity)}"${filmSubstrate ? ' stroke="rgba(70,110,130,.35)"' : ''}/></svg>`
    : opaqueSubstrate
      ? `<div class="carrier-panel carrier-panel--opaque" style="background:${attr(area.substrate.color ?? '#ffffff')};opacity:${cssNumber(area.substrate.opacity)};${boundaryStyle(area, options.pxPerMm)}"></div>`
      : filmSubstrate
        ? `<div class="carrier-film-extent" style="opacity:${cssNumber(area.substrate.opacity)};${boundaryStyle(area, options.pxPerMm)}"></div>`
        : ''
  const layers = area.carrier === 'bare' ? '' : area.layers.slice().sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id)).map((layer) => renderLayer(layer, area, options)).join('')
  const selectiveUnderbase = area.carrier === 'clear_label' && area.layers.some((layer) => layer.processes.some((process) => process.process === 'white_underbase' || process.requiredMask === 'white_underbase'))
  return `<div class="area-artboard carrier-${attr(area.carrier)}" data-area-id="${attr(area.id)}" data-carrier="${attr(area.carrier)}" data-selective-underbase="${selectiveUnderbase}" style="width:${cssNumber(width)}px;height:${cssNumber(height)}px">${substrate}${layers}</div>`
}

function renderView(side, area, options, revision) {
  const selectiveUnderbase = area.carrier === 'clear_label' && area.layers.some((layer) => layer.processes.some((process) => process.process === 'white_underbase' || process.requiredMask === 'white_underbase'))
  const processNote = selectiveUnderbase ? ' · selective white underbase declared' : ''
  return `<section class="review-view" data-side="${side}" data-blueprint-revision="${attr(revision)}" style="width:${options.width}px;height:${options.height}px"><div class="diagnostic"><strong>${side.toUpperCase()}</strong> · ${escapeHtml(area.carrier)} · ${escapeHtml(area.placementIntent)}${processNote} · supplier/sample review required</div><div class="package-silhouette">${renderArea(area, options)}</div></section>`
}

export function renderBlueprintHtml(blueprint, options) {
  const validated = validateLayoutBlueprint(blueprint)
  assertDimension(options.width, 'width'); assertDimension(options.height, 'height')
  if (typeof options.pxPerMm !== 'number' || !Number.isFinite(options.pxPerMm) || options.pxPerMm <= 0 || options.pxPerMm > 100) {
    throw new DesignReviewError('INVALID_USAGE', 'pxPerMm must be a positive number at most 100')
  }
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
  return `<!doctype html><html lang="en" data-blueprint-revision="${revision}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Label design review ${revision}</title><style>
${fontFaces}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e9e7e2;color:#171717;font-family:Arial,sans-serif}body{display:flex;flex-direction:column;align-items:flex-start}.review-view{position:relative;overflow:hidden;background:#f7f5f0}.diagnostic{position:absolute;z-index:1000;left:16px;top:14px;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.92);font-size:12px}.package-silhouette{position:absolute;inset:36px 56px 24px;display:flex;align-items:center;justify-content:center;border-radius:22% 22% 16% 16%;background:linear-gradient(90deg,#d8d4cb,#f2efe8 42%,#cbc6bc);box-shadow:inset -16px 0 30px rgba(0,0,0,.08),0 18px 32px rgba(0,0,0,.12)}.area-artboard{position:relative;overflow:hidden}.carrier-panel,.carrier-film-extent,.carrier-boundary-path{position:absolute;inset:0;width:100%;height:100%}.carrier-film-extent{border:1px solid rgba(70,110,130,.35);background:transparent}.art-layer{position:absolute;transform-origin:center}.art-layer img,.shape-geometry,.text-geometry{display:block;width:100%;height:100%}.text-geometry{overflow:hidden}.capture-clean .diagnostic{display:none}.capture-clean .carrier-film-extent{border-color:rgba(70,110,130,.18)}
</style></head><body>${renderView('front', front, options, validated.revision)}${renderView('back', back, options, validated.revision)}</body></html>`
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

function pngDimensions(bytes) {
  if (bytes.length < 24 || !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return undefined
  return { width: Buffer.from(bytes).readUInt32BE(16), height: Buffer.from(bytes).readUInt32BE(20) }
}

function verifyMagic(bytes, mimeType) {
  if (mimeType === 'image/png') return Boolean(pngDimensions(bytes))
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
  if (mimeType === 'image/webp') return Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP'
  if (mimeType === 'font/woff') return Buffer.from(bytes.subarray(0, 4)).toString() === 'wOFF'
  if (mimeType === 'font/woff2') return Buffer.from(bytes.subarray(0, 4)).toString() === 'wOF2'
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
    if (!verifyMagic(bytes, asset.mimeType)) throw new DesignReviewError('INVALID_LAYOUT_BLUEPRINT', `Asset ${asset.id} MIME/magic mismatch`)
    const dimensions = asset.mimeType === 'image/png' ? pngDimensions(bytes) : undefined
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
  if (!Number.isInteger(value) || value < 1 || value > 4096) throw new DesignReviewError('INVALID_USAGE', `${label} must be an integer from 1 to 4096`)
}

function assertCapture(entry, width, height, label) {
  if (!entry || !(entry.bytes instanceof Uint8Array || Buffer.isBuffer(entry.bytes)) || entry.width !== width || entry.height !== height || !pngDimensions(entry.bytes)) {
    throw new DesignReviewError('BROWSER_NOT_READY', `${label} capture returned wrong dimensions or invalid PNG bytes`)
  }
}

export async function captureDesignReview({ html, blueprint, width, height, pxPerMm }) {
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block' })
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
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction((revision) => document.documentElement.dataset.blueprintRevision === revision, blueprint.revision, { timeout: 30_000 })
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map(async (image) => {
        if (!image.complete || image.naturalWidth === 0) await image.decode()
        if (image.naturalWidth === 0) throw new Error('Image decode produced zero dimensions')
      }))
      for (const text of document.querySelectorAll('[data-font-family]')) {
        const family = text.getAttribute('data-font-family')
        if (!family || !document.fonts.check(`12px "${family}"`)) throw new Error(`Declared font failed to load: ${family ?? 'unknown'}`)
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      document.body.classList.add('capture-clean')
    })
    if (externalRequests.length > 0) throw new DesignReviewError('BROWSER_NOT_READY', `External network request blocked: ${externalRequests[0]}`)
    const capture = { areas: {} }
    for (const side of ['front', 'back']) {
      const locator = page.locator(`[data-side="${side}"]`)
      const box = await locator.boundingBox()
      if (!box || Math.round(box.width) !== width || Math.round(box.height) !== height) throw new DesignReviewError('BROWSER_NOT_READY', `${side} panel dimensions changed`)
      capture[side] = { bytes: await locator.screenshot({ type: 'png', animations: 'disabled' }), width, height }
    }
    for (const area of blueprint.areas.filter((candidate) => candidate.carrier !== 'bare')) {
      const expectedWidth = Math.round(area.artboard.widthMm * pxPerMm)
      const expectedHeight = Math.round(area.artboard.heightMm * pxPerMm)
      const locator = page.locator(`[data-area-id="${area.id}"]`)
      const box = await locator.boundingBox()
      if (!box || Math.round(box.width) !== expectedWidth || Math.round(box.height) !== expectedHeight) throw new DesignReviewError('BROWSER_NOT_READY', `Area ${area.id} dimensions changed`)
      capture.areas[area.id] = { bytes: await locator.screenshot({ type: 'png', animations: 'disabled' }), width: expectedWidth, height: expectedHeight }
    }
    if (errors.length > 0) throw new DesignReviewError('BROWSER_NOT_READY', `Browser rendering failed: ${errors.join('; ')}`)
    await context.close()
    return capture
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
  const evidenceAreas = new Set(manifest.artifacts.filter((artifact) => artifact.viewKind === 'mockup-area').map((artifact) => artifact.areaId))
  for (const area of manifest.areas) {
    if (area.carrier !== 'bare' && !evidenceAreas.has(area.id)) throw new DesignReviewError('INVALID_DESIGN_REVIEW_MANIFEST', `Area ${area.id} is missing mockup-area evidence`)
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
  const blueprint = validateLayoutBlueprint(parsed)
  const resolvedOutputDir = path.resolve(outputDir)
  if (!force && await stat(resolvedOutputDir).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false
    throw error
  })) {
    throw new DesignReviewError('OUTPUT_CONFLICT', `Output already exists: ${resolvedOutputDir}`)
  }
  const { assets, references } = await resolveLocalFiles(blueprint, resolvedBlueprintPath, referencePaths)
  const html = renderBlueprintHtml(blueprint, { width, height, pxPerMm, assets })
  const htmlBytes = Buffer.from(html)
  const captureResult = await capture({ html, blueprint, areas: blueprint.areas, width, height, pxPerMm })
  assertCapture(captureResult.front, width, height, 'front')
  assertCapture(captureResult.back, width, height, 'back')

  const publication = []
  const manifestArtifacts = []
  const addArtifact = (id, relativePath, bytes, mimeType, artifactWidth, artifactHeight, viewKind, area) => {
    publication.push({ relativePath, fileName: relativePath, bytes })
    manifestArtifacts.push({
      id, path: relativePath, sha256: sha256Bytes(bytes), mimeType, width: artifactWidth, height: artifactHeight, viewKind,
      ...(area ? { areaId: area.id, carrier: area.carrier } : {}),
    })
  }
  addArtifact('mockup-html', 'mockup.html', htmlBytes, 'text/html', width, height, 'mockup-html')
  addArtifact('mockup-front', 'mockup-front.png', captureResult.front.bytes, 'image/png', width, height, 'mockup-front')
  addArtifact('mockup-back', 'mockup-back.png', captureResult.back.bytes, 'image/png', width, height, 'mockup-back')
  for (const area of blueprint.areas.filter((candidate) => candidate.carrier !== 'bare')) {
    const areaCapture = captureResult.areas?.[area.id]
    const areaWidth = Math.round(area.artboard.widthMm * pxPerMm)
    const areaHeight = Math.round(area.artboard.heightMm * pxPerMm)
    assertCapture(areaCapture, areaWidth, areaHeight, `area ${area.id}`)
    const areaToken = sanitizeArtifactName(area.id)
    addArtifact(`mockup-area-${area.id}`, `areas/${areaToken}.png`, areaCapture.bytes, 'image/png', areaWidth, areaHeight, 'mockup-area', area)
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
