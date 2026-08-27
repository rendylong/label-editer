/**
 * 工艺效果：烘焙/贴图绘制与 PBR mask 生成。
 * mask 语义：metalness（白=金属）、roughness（黑=光滑）、bump（0.5=平面）。
 */

import type { CraftEffect, CraftType, ImageLayer, LabelAreaConfig, LabelLayer, ShapeLayer, TextLayer } from './types'
import { FOIL_COLORS } from './types'
import { normalizeShapeLayer, shapeCommands, traceShapeCommands, type ShapeCommand, type ShapeDrawingContext } from './shapeGeometry'
import { resolveCarrierSurface } from './paper'
import { resolvePortableLayerTransform } from '../../scripts/lib/layer-transform-core.mjs'
import { resolvePortableTextLayoutMetric } from '../../scripts/lib/text-layout-core.mjs'
import {
  canRenderMaskLayer,
  isRenderableWhiteUnderbaseLayer,
  readWhiteUnderbaseRasterSignature,
  snapshotWhiteUnderbaseRaster,
  whiteUnderbaseIntentKey,
} from './whiteUnderbase'

export type CraftScope = 'layer' | 'global'
export type MaskChannel = 'metalness' | 'roughness' | 'bump'
export type MaskDrawMode = 'fill' | 'stroke'

const LAYER_CRAFT_TYPES: CraftType[] = ['foil', 'emboss', 'deboss', 'matte', 'uv', 'stroke']
const GLOBAL_CRAFT_TYPES: CraftType[] = ['matte', 'uv']

type LayerAnchor = NonNullable<LabelLayer['designMetrics']>['anchor']

export interface LayerRenderTransformInput {
  x: number
  y: number
  rotation: number
  width: number
  height: number
  anchor?: LayerAnchor
  baselineFromTop?: number
}

export interface LayerRenderTransform {
  origin: { x: number; y: number }
  rotation: number
  box: { x: number; y: number; width: number; height: number }
  worldBounds: { x: number; y: number; width: number; height: number }
}

/** Resolve local content offsets while keeping the declared anchor as the rotation origin. */
export function resolveLayerRenderTransform(input: LayerRenderTransformInput): LayerRenderTransform {
  return resolvePortableLayerTransform(input) as LayerRenderTransform
}

/** 全局工艺只允许整面材质属性；字形工艺必须绑定具体图层。 */
export function craftTypesForScope(scope: CraftScope): CraftType[] {
  return scope === 'global' ? [...GLOBAL_CRAFT_TYPES] : [...LAYER_CRAFT_TYPES]
}

function customFoilStops(color: string): string[] {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match) return FOIL_COLORS.rose.stops
  const value = Number.parseInt(match[1], 16)
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  const tone = (factor: number): string => `#${channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel * factor))).toString(16).padStart(2, '0')).join('')}`
  return [tone(0.72), tone(1.38), tone(0.92), tone(1.2), tone(0.62)]
}

export function foilGradientStops(key: string, customColor?: string): string[] {
  return key === 'custom' ? customFoilStops(customColor ?? '#b56f52') : FOIL_COLORS[key]?.stops ?? FOIL_COLORS.gold.stops
}

export function foilKonvaGradient(craft: CraftEffect | undefined, width: number, height: number): {
  start: { x: number; y: number }
  end: { x: number; y: number }
  colorStops: Array<number | string>
} | null {
  if (!craft || craft.type !== 'foil') return null
  const angle = ((craft.params.gradientAngle ?? 60) * Math.PI) / 180
  const span = Math.max(width, height, 1)
  const dx = Math.cos(angle) * span * 0.5
  const dy = Math.sin(angle) * span * 0.5
  const colors = foilGradientStops(craft.params.foilColor ?? 'gold', craft.params.foilCustomColor)
  const pairs = colors.map((color, index) => ({ offset: index / Math.max(colors.length - 1, 1), color }))
  const highlight = clamp01(craft.params.highlight ?? 0.4)
  if (highlight > 0) pairs.push({ offset: 0.38, color: `rgba(255,255,255,${(0.15 + highlight * 0.55).toFixed(3)})` })
  pairs.sort((a, b) => a.offset - b.offset)
  const colorStops: Array<number | string> = []
  pairs.forEach(({ offset, color }) => colorStops.push(offset, color))
  return { start: { x: width / 2 - dx, y: height / 2 - dy }, end: { x: width / 2 + dx, y: height / 2 + dy }, colorStops }
}

export function foilFillProps(craft: CraftEffect | undefined, width: number, height: number): {
  fillPriority: 'color' | 'linear-gradient'
  fillLinearGradientStartPoint?: { x: number; y: number }
  fillLinearGradientEndPoint?: { x: number; y: number }
  fillLinearGradientColorStops: Array<number | string>
} {
  const gradient = foilKonvaGradient(craft, width, height)
  return gradient
    ? {
        fillPriority: 'linear-gradient',
        fillLinearGradientStartPoint: gradient.start,
        fillLinearGradientEndPoint: gradient.end,
        fillLinearGradientColorStops: gradient.colorStops,
      }
    : { fillPriority: 'color', fillLinearGradientColorStops: [] }
}

export function textLineAnchorX(align: TextLayer['align'], width: number): number {
  return align === 'left' ? -width / 2 : align === 'right' ? width / 2 : 0
}

/** 矩形以图层中心为锚点，2D 预览、变换和导出共享同一盒模型。 */
export function rectangleRenderProps(layer: Pick<ShapeLayer, 'width' | 'height' | 'fill' | 'stroke' | 'strokeWidth' | 'cornerRadius' | 'designMetrics'>): {
  x: number
  y: number
  width: number
  height: number
  fill: string
  stroke: string
  strokeWidth: number
  cornerRadius: number
} {
  const transform = resolveLayerRenderTransform({
    x: 0,
    y: 0,
    rotation: 0,
    width: layer.width,
    height: layer.height,
    anchor: layer.designMetrics?.anchor,
  })
  return {
    x: transform.box.x,
    y: transform.box.y,
    width: layer.width,
    height: layer.height,
    fill: layer.fill,
    stroke: layer.stroke,
    strokeWidth: layer.strokeWidth,
    cornerRadius: layer.cornerRadius,
  }
}

interface ShapeCommandPartitions {
  closed: ShapeCommand[]
  open: ShapeCommand[]
}

interface ShapeCommandPoint { x: number; y: number }

function shapeCommandEndpoint(command: Exclude<ShapeCommand, { type: 'close' }>): ShapeCommandPoint {
  if (command.type === 'arc') {
    return {
      x: command.x + command.radius * Math.cos(command.endAngle),
      y: command.y + command.radius * Math.sin(command.endAngle),
    }
  }
  return { x: command.x, y: command.y }
}

/** Keep closed contours together for fill-rule evaluation and open contours isolated from fill. */
function partitionShapeCommands(commands: readonly ShapeCommand[]): ShapeCommandPartitions {
  const partitions: ShapeCommandPartitions = { closed: [], open: [] }
  let current: ShapeCommand[] = []
  let currentPoint: ShapeCommandPoint | undefined
  let subpathStart: ShapeCommandPoint | undefined

  const hasDrawableCommand = (): boolean => current.some((command) => command.type !== 'moveTo' && command.type !== 'close')
  const flushOpen = (): void => {
    if (hasDrawableCommand()) partitions.open.push(...current)
    current = []
  }

  for (const command of commands) {
    if (command.type === 'moveTo') {
      flushOpen()
      current.push(command)
      currentPoint = shapeCommandEndpoint(command)
      subpathStart = currentPoint
      continue
    }
    if (command.type === 'close') {
      if (current.length > 0) {
        current.push(command)
        if (hasDrawableCommand()) partitions.closed.push(...current)
        current = []
      }
      currentPoint = subpathStart
      continue
    }

    // SVG keeps the current subpath start after Z. A following drawable command
    // therefore begins an open continuation there even without another M.
    if (current.length === 0) {
      if (!currentPoint) throw new Error('Shape drawing command requires an initial moveTo')
      current.push({ type: 'moveTo', x: currentPoint.x, y: currentPoint.y })
      subpathStart = currentPoint
    }
    current.push(command)
    currentPoint = shapeCommandEndpoint(command)
  }
  flushOpen()
  return partitions
}

function shapeCommandPartitions(layer: ShapeLayer): ShapeCommandPartitions {
  try {
    return partitionShapeCommands(shapeCommands(layer))
  } catch {
    return { closed: [], open: [] }
  }
}

export function shapeUsesOpenStroke(layer: ShapeLayer): boolean {
  return shapeCommandPartitions(layer).open.length > 0
}

export interface GenericShapePaintProps {
  fill: string
  stroke: string
  fillPriority: 'color' | 'linear-gradient'
  fillLinearGradientStartPoint?: { x: number; y: number }
  fillLinearGradientEndPoint?: { x: number; y: number }
  fillLinearGradientColorStops: Array<number | string>
  strokeLinearGradientStartPoint?: { x: number; y: number }
  strokeLinearGradientEndPoint?: { x: number; y: number }
  strokeLinearGradientColorStops?: Array<number | string>
}

/** Craft stroke is a presentation override shared by text, image and shape layers. */
export function craftStrokePaint(layer: {
  craft: CraftEffect[]
  stroke?: string
  strokeWidth?: number
}): { stroke?: string; strokeWidth: number } {
  const effect = layer.craft.find((candidate) => candidate.type === 'stroke')
  return {
    stroke: effect?.params.strokeColor ?? layer.stroke,
    strokeWidth: effect?.params.strokeWidth ?? layer.strokeWidth ?? 0,
  }
}

/**
 * Map shared foil colors onto the centered coordinates traced by generic shapes.
 * Open paths route foil to Konva's stroke gradient; closed paths route it to fill.
 */
export function genericShapePaintProps(layer: ShapeLayer, foil: CraftEffect | undefined): GenericShapePaintProps {
  const normalized = normalizeShapeLayer(layer)
  const base = {
    fill: layer.fill,
    stroke: layer.stroke,
    fillPriority: 'color' as const,
    fillLinearGradientColorStops: [],
  }
  const gradient = foilKonvaGradient(foil, normalized.width, normalized.height)
  if (!gradient) return base
  const partitions = shapeCommandPartitions(normalized)

  const start = {
    x: gradient.start.x - normalized.width / 2,
    y: gradient.start.y - normalized.height / 2,
  }
  const end = {
    x: gradient.end.x - normalized.width / 2,
    y: gradient.end.y - normalized.height / 2,
  }
  if (partitions.open.length > 0 && partitions.closed.length === 0) {
    return {
      ...base,
      strokeLinearGradientStartPoint: start,
      strokeLinearGradientEndPoint: end,
      strokeLinearGradientColorStops: gradient.colorStops,
    }
  }
  const fillPaint = {
    ...base,
    fillPriority: 'linear-gradient' as const,
    fillLinearGradientStartPoint: start,
    fillLinearGradientEndPoint: end,
    fillLinearGradientColorStops: gradient.colorStops,
  }
  return partitions.open.length === 0 ? fillPaint : {
    ...fillPaint,
    strokeLinearGradientStartPoint: start,
    strokeLinearGradientEndPoint: end,
    strokeLinearGradientColorStops: gradient.colorStops,
  }
}

/** Minimal Konva scene-context contract, kept generic so path behavior stays unit-testable. */
export interface ShapePreviewContext<ShapeNode> extends ShapeDrawingContext {
  beginPath(): void
  fillStrokeShape(shape: ShapeNode): void
  strokeShape(shape: ShapeNode): void
}

/** Replay the shared path for the visible preview without fill-closing open decorations. */
export function drawShapePreview<ShapeNode>(context: ShapePreviewContext<ShapeNode>, layer: ShapeLayer, shape: ShapeNode): void {
  const partitions = shapeCommandPartitions(layer)
  if (partitions.closed.length > 0) {
    context.beginPath()
    traceShapeCommands(context, partitions.closed)
    context.fillStrokeShape(shape)
  }
  if (partitions.open.length > 0) {
    context.beginPath()
    traceShapeCommands(context, partitions.open)
    context.strokeShape(shape)
  }
}

/** Draw the shared path into a PBR craft mask at the layer transform. */
export function drawShapeMask(
  ctx: CanvasRenderingContext2D,
  layer: ShapeLayer,
  gray: number,
  mode: MaskDrawMode,
): void {
  const normalized = normalizeShapeLayer(layer)
  const transform = resolveLayerRenderTransform({
    x: normalized.x,
    y: normalized.y,
    rotation: normalized.rotation,
    width: normalized.width,
    height: normalized.height,
    anchor: normalized.designMetrics?.anchor,
  })
  ctx.save()
  ctx.translate(transform.origin.x, transform.origin.y)
  ctx.rotate((transform.rotation * Math.PI) / 180)
  ctx.translate(transform.box.x + normalized.width / 2, transform.box.y + normalized.height / 2)
  ctx.globalAlpha *= normalized.opacity
  ctx.fillStyle = `rgb(${gray},${gray},${gray})`
  ctx.strokeStyle = ctx.fillStyle
  ctx.lineWidth = Math.max(1, normalized.strokeWidth)
  ctx.setLineDash(normalized.geometry?.dash ?? [])
  if (mode === 'stroke') {
    ctx.beginPath()
    traceShapeCommands(ctx, shapeCommands(normalized))
    ctx.stroke()
  } else {
    const partitions = shapeCommandPartitions(normalized)
    if (partitions.closed.length > 0) {
      ctx.beginPath()
      traceShapeCommands(ctx, partitions.closed)
      ctx.fill(normalized.fillRule ?? 'nonzero')
    }
    if (partitions.open.length > 0) {
      ctx.beginPath()
      traceShapeCommands(ctx, partitions.open)
      ctx.stroke()
    }
  }
  ctx.restore()
}

const CJK_CHARACTER = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u

export interface TextMeasureMetrics {
  width: number
  actualBoundingBoxAscent?: number
  actualBoundingBoxDescent?: number
}

export type TextMeasureResult = number | TextMeasureMetrics
export type TextMeasureLine = (line: string) => TextMeasureResult

function measuredWidth(result: TextMeasureResult): number {
  return typeof result === 'number' ? result : result.width
}

function splitLongToken(token: string, maximumWidth: number, measureLine: (line: string) => number): string[] {
  const pieces: string[] = []
  let current = ''
  for (const character of Array.from(token)) {
    const candidate = current + character
    if (current && measureLine(candidate) > maximumWidth) {
      pieces.push(current)
      current = character
    } else {
      current = candidate
    }
  }
  if (current || pieces.length === 0) pieces.push(current)
  return pieces
}

function wrapTextCharacters(paragraph: string, maximumWidth: number, measureLine: (line: string) => number): string[] {
  if (paragraph === '') return ['']
  const lines: string[] = []
  let current = ''
  for (const character of Array.from(paragraph)) {
    const candidate = current + character
    if (current && measureLine(candidate) > maximumWidth) {
      lines.push(current)
      current = character
    } else {
      current = candidate
    }
  }
  lines.push(current)
  return lines
}

function wrapTextWords(paragraph: string, maximumWidth: number, measureLine: (line: string) => number): string[] {
  if (paragraph === '') return ['']
  const tokens = paragraph.match(/\s+|[\u3400-\u9fff\uf900-\ufaff]|[^\s\u3400-\u9fff\uf900-\ufaff]+/gu) ?? []
  const lines: string[] = []
  let current = ''
  for (const token of tokens) {
    const candidate = current + token
    if (!current || measureLine(candidate) <= maximumWidth) {
      current = candidate
      continue
    }
    lines.push(current.trimEnd())
    current = /^\s+$/u.test(token) ? '' : token
  }
  if (current || lines.length === 0) lines.push(current.trimEnd())
  return lines
}

export interface TextLayerLayout {
  width: number
  height: number
  rotation: number
  /** Lines that are actually rendered after maxLines clipping. */
  lines: string[]
  totalLineCount: number
  hiddenLineCount: number
  overflow: boolean
  /** Alphabetic baseline of the first rendered line, measured from the local box top. */
  baselineFromTop: number
}

function wrapTextParagraph(paragraph: string, maximumWidth: number, measureLine: (line: string) => number): string[] {
  if (paragraph === '') return ['']
  const tokens: string[] = []
  let word = ''
  const flushWord = (): void => {
    if (!word) return
    tokens.push(word)
    word = ''
  }
  for (const character of Array.from(paragraph)) {
    if (/\s/u.test(character) || CJK_CHARACTER.test(character)) {
      flushWord()
      tokens.push(character)
    } else {
      word += character
    }
  }
  flushWord()

  const lines: string[] = []
  let current = ''
  const pushCurrent = (): void => {
    lines.push(current.trimEnd())
    current = ''
  }
  for (const token of tokens) {
    if (/^\s+$/u.test(token) && current === '') continue
    const candidate = current + token
    if (measureLine(candidate) <= maximumWidth) {
      current = candidate
      continue
    }
    if (current) pushCurrent()
    if (/^\s+$/u.test(token)) continue
    if (measureLine(token) <= maximumWidth) {
      current = token
      continue
    }
    const pieces = splitLongToken(token, maximumWidth, measureLine)
    lines.push(...pieces.slice(0, -1))
    current = pieces.at(-1) ?? ''
  }
  if (current || lines.length === 0) pushCurrent()
  return lines
}

/** 2D 可见文字、烘焙颜色与 PBR 遮罩共用的确定性盒模型。 */
export function measureTextLayerLayout(
  layer: TextLayer,
  measureLine: TextMeasureLine,
): TextLayerLayout {
  const lineWidth = (line: string): number => measuredWidth(measureLine(line))
  const explicitWidth = typeof layer.width === 'number' && Number.isFinite(layer.width) && layer.width > 0
    ? layer.width
    : null
  const wrapPolicy = layer.designMetrics?.wrapPolicy
  const allLines = explicitWidth === null || wrapPolicy === 'none'
    ? layer.text.split('\n')
    : layer.text.split('\n').flatMap((paragraph) => (
        wrapPolicy === 'word'
          ? wrapTextWords(paragraph, explicitWidth, lineWidth)
          : wrapPolicy === 'character'
            ? wrapTextCharacters(paragraph, explicitWidth, lineWidth)
            : wrapTextParagraph(paragraph, explicitWidth, lineWidth)
      ))
  const maximumLines = layer.designMetrics?.maxLines
  const renderedLineCount = typeof maximumLines === 'number' && Number.isInteger(maximumLines) && maximumLines > 0
    ? Math.min(maximumLines, allLines.length)
    : allLines.length
  const lines = allLines.slice(0, renderedLineCount)
  const hiddenLineCount = allLines.length - lines.length
  const horizontalOverflow = explicitWidth !== null && allLines.some((line) => lineWidth(line) > explicitWidth)
  const width = explicitWidth ?? Math.max(1, ...lines.map(lineWidth))
  const referenceMetrics = measureLine('Mg')
  const ascent = typeof referenceMetrics === 'number'
    ? layer.fontSize * 0.8
    : referenceMetrics.actualBoundingBoxAscent ?? layer.fontSize * 0.8
  const descent = typeof referenceMetrics === 'number'
    ? layer.fontSize * 0.2
    : referenceMetrics.actualBoundingBoxDescent ?? layer.fontSize * 0.2
  const metric = resolvePortableTextLayoutMetric({
    width, fontSize: layer.fontSize, lineHeight: layer.lineHeight || 1.2, lineCount: allLines.length,
    maxLines: maximumLines, ascent, descent,
  })
  return {
    width: metric.width,
    height: metric.height,
    rotation: layer.rotation + (layer.direction === 'vertical' ? 90 : 0),
    lines,
    totalLineCount: allLines.length,
    hiddenLineCount,
    overflow: hiddenLineCount > 0 || horizontalOverflow,
    baselineFromTop: metric.baselineFromTop,
  }
}

export interface MaskContribution {
  channel: MaskChannel
  tone: number
  mode: MaskDrawMode
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** 将用户参数转换为 PBR 通道强度，作为预览与导出的单一规则。 */
export function layerMaskContributions(layer: LabelLayer): MaskContribution[] {
  const out: MaskContribution[] = []
  const foil = layer.craft.find((effect) => effect.type === 'foil')
  if (foil) out.push({ channel: 'metalness', tone: 255, mode: 'fill' })
  const uv = layer.craft.find((effect) => effect.type === 'uv')
  const matte = layer.craft.find((effect) => effect.type === 'matte')
  if (uv) out.push({ channel: 'roughness', tone: Math.round(8 + 96 * (1 - clamp01(uv.params.gloss ?? 0.5))), mode: 'fill' })
  else if (foil) out.push({ channel: 'roughness', tone: 42, mode: 'fill' })
  else if (matte) out.push({ channel: 'roughness', tone: Math.round(217 + 38 * clamp01(matte.params.intensity ?? 0.3)), mode: 'fill' })
  const emboss = layer.craft.find((effect) => effect.type === 'emboss')
  const deboss = layer.craft.find((effect) => effect.type === 'deboss')
  if (emboss) out.push({ channel: 'bump', tone: Math.round(128 + 127 * clamp01((emboss.params.depth ?? 0.08) / 0.4)), mode: 'fill' })
  else if (deboss) out.push({ channel: 'bump', tone: Math.round(128 - 127 * clamp01((deboss.params.depth ?? 0.08) / 0.4)), mode: 'fill' })
  return out
}

/** Deterministic micro-surface tones used by matte masks; no frame-to-frame shimmer. */
export function matteSurfaceTones(pixel: number, intensity: number, density: number): { roughness: number; bump: number } {
  const strength = clamp01(intensity)
  const gate = (((pixel * 1664525 + 1013904223) >>> 0) & 0xffff) / 0xffff
  const roughBase = 217 + 38 * strength
  if (gate > clamp01(density)) return { roughness: Math.round(roughBase), bump: 128 }
  const roughSample = (((pixel * 1103515245 + 12345) >>> 0) & 0xffff) / 0xffff
  const bumpSample = (((pixel * 214013 + 2531011) >>> 0) & 0xffff) / 0xffff
  return {
    roughness: Math.max(210, Math.min(255, Math.round(roughBase + (roughSample - 0.5) * 18 * strength))),
    bump: Math.max(116, Math.min(140, Math.round(128 + (bumpSample - 0.5) * 24 * strength))),
  }
}

function applyLayerMatteSurface(
  width: number,
  height: number,
  drawLayer: (ctx: CanvasRenderingContext2D, layer: LabelLayer, gray: number, mode: MaskDrawMode) => void,
  layer: LabelLayer,
  effect: CraftEffect,
  roughness: CanvasRenderingContext2D,
  bump: CanvasRenderingContext2D,
): void {
  const mask = document.createElement('canvas')
  mask.width = width
  mask.height = height
  const maskContext = mask.getContext('2d')!
  maskContext.clearRect(0, 0, width, height)
  drawLayer(maskContext, layer, 255, 'fill')
  const coverage = maskContext.getImageData(0, 0, width, height).data
  const roughImage = roughness.getImageData(0, 0, width, height)
  const bumpImage = bump.getImageData(0, 0, width, height)
  const intensity = effect.params.intensity ?? 0.3
  const density = effect.params.noise ?? 0.5
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4
    if (coverage[offset + 3] === 0 && coverage[offset] === 0) continue
    const tones = matteSurfaceTones(pixel, intensity, density)
    roughImage.data[offset] = tones.roughness
    roughImage.data[offset + 1] = tones.roughness
    roughImage.data[offset + 2] = tones.roughness
    const heightTone = Math.max(0, Math.min(255, bumpImage.data[offset] + tones.bump - 128))
    bumpImage.data[offset] = heightTone
    bumpImage.data[offset + 1] = heightTone
    bumpImage.data[offset + 2] = heightTone
  }
  roughness.putImageData(roughImage, 0, 0)
  bump.putImageData(bumpImage, 0, 0)
}

function applyGlobalMatteSurface(
  width: number,
  height: number,
  effect: CraftEffect,
  roughness: CanvasRenderingContext2D,
  bump: CanvasRenderingContext2D,
): void {
  const roughImage = roughness.getImageData(0, 0, width, height)
  const bumpImage = bump.getImageData(0, 0, width, height)
  const intensity = effect.params.intensity ?? 0.3
  const density = effect.params.noise ?? 0.5
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4
    const tones = matteSurfaceTones(pixel, intensity, density)
    roughImage.data[offset] = tones.roughness
    roughImage.data[offset + 1] = tones.roughness
    roughImage.data[offset + 2] = tones.roughness
    const heightTone = Math.max(0, Math.min(255, bumpImage.data[offset] + tones.bump - 128))
    bumpImage.data[offset] = heightTone
    bumpImage.data[offset + 1] = heightTone
    bumpImage.data[offset + 2] = heightTone
  }
  roughness.putImageData(roughImage, 0, 0)
  bump.putImageData(bumpImage, 0, 0)
}

/** 图层是否携带某工艺。 */
export function hasCraft(layer: LabelLayer, type: CraftType): boolean {
  return layer.craft.some((c) => c.type === type)
}

/** 磨砂噪点：在整幅画布上叠加细噪点。 */
export function applyMatteNoise(ctx: CanvasRenderingContext2D, w: number, h: number, intensity: number, density = 0.5): void {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const n = d.length
  const amt = Math.round(intensity * 18)
  for (let i = 0; i < n; i += 4) {
    if (d[i + 3] === 0) continue
    const pixel = i / 4
    const gate = (((pixel * 1664525 + 1013904223) >>> 0) & 0xffff) / 0xffff
    if (gate > clamp01(density)) continue
    const sample = (((pixel * 1103515245 + 12345) >>> 0) & 0xffff) / 0xffff
    const v = (sample - 0.5) * amt
    d[i] += v
    d[i + 1] += v
    d[i + 2] += v
  }
  ctx.putImageData(img, 0, 0)
}

/** UV 亮油全局效果：轻微提亮 + 顶部柔和光泽。 */
export function applyUvGloss(ctx: CanvasRenderingContext2D, w: number, h: number, gloss: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  const g = ctx.createLinearGradient(0, 0, w * 0.35, h)
  g.addColorStop(0, `rgba(255,255,255,${0.05 * gloss})`)
  g.addColorStop(0.45, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

/**
 * Physical surface crafts belong to roughness/metalness/height channels.
 * Keeping this boundary explicit prevents fixed highlights or grain from staining brand colors.
 */
export function applyPhysicalColorSurface(
  _ctx: CanvasRenderingContext2D,
  _width: number,
  _height: number,
  _effects: CraftEffect[],
): void {}

/** 图片透明轮廓先在独立画布着色，再同步合成到目标 mask，避免污染目标底色。 */
export function drawImageMaskShape(
  ctx: CanvasRenderingContext2D,
  layer: ImageLayer,
  image: CanvasImageSource,
  gray: number,
): void {
  const width = Math.max(1, Math.round(layer.width))
  const height = Math.max(1, Math.round(layer.height))
  const temp = document.createElement('canvas')
  temp.width = width
  temp.height = height
  const tctx = temp.getContext('2d')!
  tctx.clearRect(0, 0, width, height)
  const fit = resolveImageFitBox(layer)
  tctx.drawImage(image, fit.x, fit.y, fit.width, fit.height)
  tctx.globalCompositeOperation = 'source-in'
  tctx.fillStyle = `rgb(${gray},${gray},${gray})`
  tctx.fillRect(0, 0, width, height)
  ctx.save()
  const transform = resolveLayerRenderTransform({
    x: layer.x,
    y: layer.y,
    rotation: layer.rotation,
    width: layer.width,
    height: layer.height,
    anchor: layer.designMetrics?.anchor,
  })
  ctx.translate(transform.origin.x, transform.origin.y)
  ctx.rotate((transform.rotation * Math.PI) / 180)
  ctx.drawImage(temp, transform.box.x, transform.box.y, layer.width, layer.height)
  ctx.restore()
}

/** 为图片预览生成烫金、描边、磨砂与 UV 的颜色结果；透明区域始终保持透明。 */
export function renderCraftedImage(image: CanvasImageSource, layer: ImageLayer): HTMLCanvasElement {
  const width = Math.max(1, Math.round(layer.width))
  const height = Math.max(1, Math.round(layer.height))
  const base = document.createElement('canvas')
  base.width = width
  base.height = height
  const bctx = base.getContext('2d')!
  const fit = resolveImageFitBox(layer)
  bctx.drawImage(image, fit.x, fit.y, fit.width, fit.height)
  const foil = layer.craft.find((effect) => effect.type === 'foil')
  if (foil) {
    const geometry = foilKonvaGradient(foil, width, height)!
    const gradient = bctx.createLinearGradient(geometry.start.x, geometry.start.y, geometry.end.x, geometry.end.y)
    for (let index = 0; index < geometry.colorStops.length; index += 2) {
      gradient.addColorStop(geometry.colorStops[index] as number, geometry.colorStops[index + 1] as string)
    }
    bctx.globalCompositeOperation = 'source-in'
    bctx.fillStyle = gradient
    bctx.fillRect(0, 0, width, height)
    bctx.globalCompositeOperation = 'source-over'
  }
  applyPhysicalColorSurface(bctx, width, height, layer.craft)

  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const octx = output.getContext('2d')!
  const stroke = layer.craft.find((effect) => effect.type === 'stroke')
  if (stroke && (stroke.params.strokeWidth ?? 0) > 0) {
    const radius = Math.max(1, Math.round(stroke.params.strokeWidth ?? 1))
    for (let angle = 0; angle < 360; angle += 30) {
      const radians = (angle * Math.PI) / 180
      octx.drawImage(base, Math.cos(radians) * radius, Math.sin(radians) * radius)
    }
    octx.globalCompositeOperation = 'source-in'
    octx.fillStyle = stroke.params.strokeColor ?? '#000000'
    octx.fillRect(0, 0, width, height)
    octx.globalCompositeOperation = 'source-over'
  }
  octx.drawImage(base, 0, 0)
  return output
}

/** CSS object-fit compatible mapping shared by preview color and all image masks. */
export function resolveImageFitBox(layer: Pick<ImageLayer, 'fit' | 'naturalWidth' | 'naturalHeight' | 'width' | 'height'>): {
  x: number
  y: number
  width: number
  height: number
} {
  const frameWidth = Math.max(1, layer.width)
  const frameHeight = Math.max(1, layer.height)
  const sourceWidth = Number.isFinite(layer.naturalWidth) && layer.naturalWidth > 0 ? layer.naturalWidth : frameWidth
  const sourceHeight = Number.isFinite(layer.naturalHeight) && layer.naturalHeight > 0 ? layer.naturalHeight : frameHeight
  const fit = layer.fit ?? 'stretch'
  if (fit === 'stretch') return { x: 0, y: 0, width: frameWidth, height: frameHeight }
  const scale = fit === 'contain'
    ? Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight)
    : Math.max(frameWidth / sourceWidth, frameHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return { x: (frameWidth - width) / 2, y: (frameHeight - height) / 2, width, height }
}

/**
 * 生成 PBR mask 画布。
 * @param drawLayer 绘制某图层"灰度剪影"的回调（text 用 fillText、image 用 drawImage，样式已设置）
 */
export function renderMasks(
  width: number,
  height: number,
  drawLayer: (ctx: CanvasRenderingContext2D, layer: LabelLayer, gray: number, mode: MaskDrawMode) => void,
  layers: LabelLayer[],
  globalCraft: CraftEffect[],
): { metalness: HTMLCanvasElement; roughness: HTMLCanvasElement; bump: HTMLCanvasElement } {
  const mk = (fill: string): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')!
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, width, height)
    return [c, ctx]
  }
  // 标签底纸是电介质：默认金属度为黑；仅烫金区域写白。
  const [metal, mctx] = mk('#000000')
  const [rough, rctx] = mk('#ffffff')
  const [bump, bctx] = mk('#ffffff')
  // 底值：粗糙纸面
  rctx.fillStyle = '#d9d9d9'
  rctx.fillRect(0, 0, width, height)
  // bump 底值 = 中灰（平面）
  bctx.fillStyle = '#808080'
  bctx.fillRect(0, 0, width, height)

  for (const layer of layers) {
    if (!layer.visible) continue
    for (const contribution of layerMaskContributions(layer)) {
      const ctx = contribution.channel === 'metalness' ? mctx : contribution.channel === 'roughness' ? rctx : bctx
      drawLayer(ctx, layer, contribution.tone, contribution.mode)
    }
    const matte = layer.craft.find((effect) => effect.type === 'matte')
    const uv = layer.craft.find((effect) => effect.type === 'uv')
    if (matte && !uv) applyLayerMatteSurface(width, height, drawLayer, layer, matte, rctx, bctx)
  }
  // 全局工艺
  for (const c of globalCraft) {
    if (c.type === 'matte') applyGlobalMatteSurface(width, height, c, rctx, bctx)
    if (c.type === 'uv') {
      const tone = Math.round(8 + 96 * (1 - clamp01(c.params.gloss ?? 0.5)))
      rctx.fillStyle = `rgb(${tone},${tone},${tone})`
      rctx.fillRect(0, 0, width, height)
    }
  }
  return { metalness: metal, roughness: rough, bump }
}

export interface CarrierMaskResult {
  metalness?: HTMLCanvasElement
  roughness?: HTMLCanvasElement
  bump?: HTMLCanvasElement
  whiteUnderbase?: HTMLCanvasElement
}

interface RendererWhiteUnderbaseProof {
  areaId: string
  bakeVersion: number
  intentKey: string
  rasterSignature: string
  revisionToken: object
}

type WhiteUnderbaseProofArea = Pick<
  LabelAreaConfig,
  | 'id'
  | 'carrier'
  | 'substrate'
  | 'paper'
  | 'legacyPaperCarrier'
  | 'canvas'
  | 'artboard'
  | 'placementPolicy'
  | 'designBinding'
  | 'layers'
  | 'globalCraft'
  | 'fonts'
>

export interface WhiteUnderbaseProofBake {
  whiteUnderbase?: HTMLCanvasElement
  version?: number
}

const rendererWhiteUnderbaseProofs = new WeakMap<HTMLCanvasElement, RendererWhiteUnderbaseProof>()
const latestRendererWhiteUnderbaseRevision = new Map<string, object>()

function beginRendererWhiteUnderbaseRevision(areaId: string, bakeVersion: number | undefined): object | undefined {
  if (!Number.isSafeInteger(bakeVersion) || (bakeVersion ?? 0) <= 0) {
    latestRendererWhiteUnderbaseRevision.delete(areaId)
    return undefined
  }
  const revisionToken = Object.freeze({})
  latestRendererWhiteUnderbaseRevision.set(areaId, revisionToken)
  return revisionToken
}

function mintRendererWhiteUnderbaseProof(
  canvas: HTMLCanvasElement,
  area: WhiteUnderbaseProofArea,
  bakeVersion: number | undefined,
  revisionToken: object | undefined,
): boolean {
  if (canvas.width !== area.canvas.width || canvas.height !== area.canvas.height) {
    rendererWhiteUnderbaseProofs.delete(canvas)
    return false
  }
  const signature = readWhiteUnderbaseRasterSignature(canvas)
  if (!signature?.hasSelectivePixels) {
    rendererWhiteUnderbaseProofs.delete(canvas)
    return false
  }
  if (revisionToken && latestRendererWhiteUnderbaseRevision.get(area.id) === revisionToken) {
    rendererWhiteUnderbaseProofs.set(canvas, {
      areaId: area.id,
      bakeVersion: bakeVersion!,
      intentKey: whiteUnderbaseIntentKey(area),
      rasterSignature: signature.key,
      revisionToken,
    })
  }
  return true
}

/** Verifies renderer provenance, current intent/version, and every current RGBA pixel. */
export function isRendererProvenWhiteUnderbase(
  area: WhiteUnderbaseProofArea,
  bake: WhiteUnderbaseProofBake | undefined,
): bake is WhiteUnderbaseProofBake & { whiteUnderbase: HTMLCanvasElement; version: number } {
  const canvas = bake?.whiteUnderbase
  if (!canvas || !Number.isSafeInteger(bake.version)) return false
  const proof = rendererWhiteUnderbaseProofs.get(canvas)
  if (!proof
    || proof.areaId !== area.id
    || proof.bakeVersion !== bake.version
    || canvas.width !== area.canvas.width
    || canvas.height !== area.canvas.height
    || latestRendererWhiteUnderbaseRevision.get(area.id) !== proof.revisionToken
    || proof.intentKey !== whiteUnderbaseIntentKey(area)) return false
  const current = readWhiteUnderbaseRasterSignature(canvas)
  return current?.hasSelectivePixels === true && current.key === proof.rasterSignature
}

/** Returns an immutable encoding source containing the exact pixels reverified now. */
export function snapshotRendererProvenWhiteUnderbase(
  area: WhiteUnderbaseProofArea,
  bake: WhiteUnderbaseProofBake | undefined,
): HTMLCanvasElement | undefined {
  const canvas = bake?.whiteUnderbase
  if (!canvas || !Number.isSafeInteger(bake.version)) return undefined
  const proof = rendererWhiteUnderbaseProofs.get(canvas)
  if (!proof
    || proof.areaId !== area.id
    || proof.bakeVersion !== bake.version
    || canvas.width !== area.canvas.width
    || canvas.height !== area.canvas.height
    || latestRendererWhiteUnderbaseRevision.get(area.id) !== proof.revisionToken
    || proof.intentKey !== whiteUnderbaseIntentKey(area)) return undefined
  const current = snapshotWhiteUnderbaseRaster(canvas)
  return current?.hasSelectivePixels === true && current.key === proof.rasterSignature
    ? current.canvas
    : undefined
}

/**
 * Carrier-aware mask generation. Substrate-backed labels retain their legacy
 * full-surface PBR defaults; carrier-free artwork allocates only channels with
 * an explicit layer/global craft or process declaration.
 */
export function renderCarrierMasks(
  width: number,
  height: number,
  drawLayer: (ctx: CanvasRenderingContext2D, layer: LabelLayer, gray: number, mode: MaskDrawMode) => boolean | void,
  area: WhiteUnderbaseProofArea,
  bakeVersion?: number,
): CarrierMaskResult {
  const revisionToken = beginRendererWhiteUnderbaseRevision(area.id, bakeVersion)
  const surface = resolveCarrierSurface(area)
  if (!surface.renderDecoration) return {}
  const safeDrawLayer = (ctx: CanvasRenderingContext2D, layer: LabelLayer, gray: number, mode: MaskDrawMode): boolean => {
    try {
      return drawLayer(ctx, layer, gray, mode) !== false
    } catch {
      return false
    }
  }
  const substrateBacked = surface.carrier === 'legacy' || surface.substrateVisible
  const result: CarrierMaskResult = substrateBacked
    ? renderMasks(width, height, safeDrawLayer, area.layers, area.globalCraft.craft)
    : {}
  if (substrateBacked) {
    const underbaseLayers = area.layers.filter(isRenderableWhiteUnderbaseLayer)
    if (underbaseLayers.length > 0) {
      const whiteUnderbase = document.createElement('canvas')
      whiteUnderbase.width = width
      whiteUnderbase.height = height
      const context = whiteUnderbase.getContext('2d')!
      context.fillStyle = 'rgb(0,0,0)'
      context.fillRect(0, 0, width, height)
      let drawFailed = false
      for (const layer of underbaseLayers) {
        try {
          if (drawLayer(context, layer, 255, 'fill') === false) drawFailed = true
        } catch {
          drawFailed = true
        }
      }
      if (!drawFailed && mintRendererWhiteUnderbaseProof(whiteUnderbase, area, bakeVersion, revisionToken)) result.whiteUnderbase = whiteUnderbase
    }
    return result
  }

  const required = new Set<keyof CarrierMaskResult>()
  for (const layer of area.layers) {
    if (!canRenderMaskLayer(layer)) continue
    for (const contribution of layerMaskContributions(layer)) required.add(contribution.channel)
    if (layer.craft.some((effect) => effect.type === 'matte')) {
      required.add('roughness')
      required.add('bump')
    }
    for (const process of layer.processes ?? []) {
      if (process.requiredMask === 'metalness' || process.requiredMask === 'roughness' || process.requiredMask === 'bump') {
        required.add(process.requiredMask)
      }
      if (process.process === 'white_underbase' || process.requiredMask === 'white_underbase') {
        required.add('whiteUnderbase')
      }
    }
  }
  for (const effect of area.globalCraft.craft) {
    if (effect.type === 'matte') {
      required.add('roughness')
      required.add('bump')
    } else if (effect.type === 'uv') required.add('roughness')
  }

  const neutral: Record<keyof CarrierMaskResult, number> = {
    metalness: 0,
    roughness: 255,
    bump: 128,
    whiteUnderbase: 0,
  }
  const contexts = new Map<keyof CarrierMaskResult, CanvasRenderingContext2D>()
  for (const channel of required) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    const tone = neutral[channel]
    context.fillStyle = `rgb(${tone},${tone},${tone})`
    context.fillRect(0, 0, width, height)
    result[channel] = canvas
    contexts.set(channel, context)
  }

  let whiteUnderbaseDrawFailed = false
  for (const layer of area.layers) {
    if (!canRenderMaskLayer(layer)) continue
    for (const process of layer.processes ?? []) {
      const channel = process.process === 'white_underbase' || process.requiredMask === 'white_underbase'
        ? 'whiteUnderbase'
        : process.requiredMask === 'metalness' || process.requiredMask === 'roughness' || process.requiredMask === 'bump'
          ? process.requiredMask
          : undefined
      if (channel) {
        const context = contexts.get(channel)!
        if (channel === 'whiteUnderbase') {
          try {
            if (drawLayer(context, layer, 255, 'fill') === false) whiteUnderbaseDrawFailed = true
          } catch {
            whiteUnderbaseDrawFailed = true
          }
        } else {
          safeDrawLayer(context, layer, channel === 'roughness' ? 0 : 255, 'fill')
        }
      }
    }
    for (const contribution of layerMaskContributions(layer)) {
      const context = contexts.get(contribution.channel)
      if (context) safeDrawLayer(context, layer, contribution.tone, contribution.mode)
    }
    const matte = layer.craft.find((effect) => effect.type === 'matte')
    const roughness = contexts.get('roughness')
    const bump = contexts.get('bump')
    if (matte && roughness && bump) applyLayerMatteSurface(width, height, safeDrawLayer, layer, matte, roughness, bump)
  }
  for (const effect of area.globalCraft.craft) {
    const roughness = contexts.get('roughness')
    const bump = contexts.get('bump')
    if (effect.type === 'matte' && roughness && bump) applyGlobalMatteSurface(width, height, effect, roughness, bump)
    if (effect.type === 'uv' && roughness) {
      const tone = Math.round(8 + 96 * (1 - clamp01(effect.params.gloss ?? 0.5)))
      roughness.fillStyle = `rgb(${tone},${tone},${tone})`
      roughness.fillRect(0, 0, width, height)
    }
  }
  if (result.whiteUnderbase && (whiteUnderbaseDrawFailed || !mintRendererWhiteUnderbaseProof(result.whiteUnderbase, area, bakeVersion, revisionToken))) {
    delete result.whiteUnderbase
  }
  return result
}
