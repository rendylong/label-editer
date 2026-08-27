/**
 * 2D 标签设计画布（Konva）：参考层、设计图层（含工艺近似）、接缝线、正面标记、
 * Transformer 交互、烘焙（stage.toCanvas 为颜色唯一路径）+ PBR mask 生成。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Group, Text as KText, Image as KImage, Rect as KRect, Ellipse as KEllipse, Path as KPath, Shape as KShape, Line, Transformer } from 'react-konva'
import type Konva from 'konva'
import { useLabelStore, useUiStore } from '../state/stores'
import type { LabelLayer, TextLayer, ImageLayer } from './types'
import { canonicalLayerOrder } from './layerOrder'
import { fontCssFor } from './fonts'
import { resolvedTextDirection } from './textDirection'
import { useDesignFontReadiness } from './designFontReadiness'
import { designAssetReadinessKey, designFontReadinessKey } from './exportReadiness'
import {
  bindImageAssetReceipt,
  loadAreaContentBoundImage,
  visibleImageLayersForRuntime,
} from './imageAssetReceipt'
import { clearTransparentCanvasBorder } from './canvasBorder'
import {
  renderCarrierMasks,
  applyPhysicalColorSurface,
  craftStrokePaint,
  drawImageMaskShape,
  drawShapeMask,
  drawShapePreview,
  foilFillProps,
  genericShapePaintProps,
  measureTextLayerLayout,
  renderCraftedImage,
  rectangleRenderProps,
  resolveLayerRenderTransform,
  shapeUsesOpenStroke,
  type MaskDrawMode,
  type TextMeasureMetrics,
} from './craft'
import { clearFilmDiagnosticSpec, fitCarrierBoundaryToCanvas, resolveCarrierSurface, resolveLabelPaper } from './paper'
import { normalizeShapeLayer } from './shapeGeometry'
import { commitLayerGesture, nextLayerSelection, type LayerNodeTransform } from './selection'
import { useFlushableDebouncedBake } from './useFlushableDebouncedBake'
import { registerExportBakeSurface } from '../app/actions'
import { assertRasterAspect, assertRasterDimensions, fitRasterDisplayHeight, RasterAspectError } from '../app/canvasLayout'

export { resolveCarrierSurface, resolveLabelPaper } from './paper'

const LABEL_CANVAS_GUIDES = {
  seam: 'rgba(217,45,32,0.55)',
  front: '#356AE6',
} as const

interface Props {
  displayWidth: number
  readOnly?: boolean
}

interface ExportVisibilityNode {
  visible(): boolean
  visible(value: boolean): unknown
}

interface ExportReliefNode {
  shadowEnabled(): boolean
  shadowEnabled(value: boolean): unknown
}

interface ExportableStage {
  find(selector: string): ArrayLike<ExportVisibilityNode | ExportReliefNode>
  draw(): unknown
  width(): number
  height(): number
  toCanvas(options: { pixelRatio: number; width?: number; height?: number }): HTMLCanvasElement
}

const LOGICAL_CAPTURE_ULP_BUDGET = 16

function equalWithinFloatingArithmetic(actual: number, expected: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false
  const scale = Math.max(Math.abs(actual), Math.abs(expected))
  return Math.abs(actual - expected) <= Number.EPSILON * LOGICAL_CAPTURE_ULP_BUDGET * scale
}

function assertCanonicalStageGeometry(
  stage: Pick<ExportableStage, 'width' | 'height'>,
  pixelRatio: number,
  expectedCanvas: { width: number; height: number; aspect: number },
): void {
  const stageWidth = stage.width()
  const stageHeight = stage.height()
  const scaledWidth = stageWidth * pixelRatio
  const scaledHeight = stageHeight * pixelRatio

  if (!expectedCanvas) {
    assertRasterDimensions({ width: scaledWidth, height: scaledHeight }, expectedCanvas)
    return
  }
  assertRasterDimensions(expectedCanvas, expectedCanvas)

  // The quotient may accumulate a few binary floating-point roundings. Sixteen
  // scale-relative epsilons cover that arithmetic while remaining many orders
  // below one raster pixel; this is deliberately not a raster-rounding tolerance.
  const expectedStageWidth = expectedCanvas.width / pixelRatio
  const expectedStageHeight = expectedCanvas.height / pixelRatio
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0
    || !equalWithinFloatingArithmetic(stageWidth, expectedStageWidth)
    || !equalWithinFloatingArithmetic(stageHeight, expectedStageHeight)) {
    throw new RasterAspectError({
      declaredAspect: expectedCanvas.aspect,
      rasterAspect: scaledWidth / scaledHeight,
      width: scaledWidth,
      height: scaledHeight,
      tolerance: 0,
    })
  }
}

/**
 * 只捕获可交付的标签内容。参考图、Transformer 和定位线属于编辑器 UI，
 * 必须在导出期间排除，并在异常情况下也恢复原有可见状态。
 */
export function captureDesignCanvas(
  stage: ExportableStage,
  pixelRatio: number,
  expectedCanvas: { width: number; height: number; aspect: number },
): HTMLCanvasElement {
  const excluded = Array.from(stage.find('.non-export')).filter((node): node is ExportVisibilityNode => 'visible' in node)
  const relief = Array.from(stage.find('.craft-relief')).filter((node): node is ExportReliefNode => 'shadowEnabled' in node)
  const visibility = excluded.map((node) => node.visible())
  const shadowVisibility = relief.map((node) => node.shadowEnabled())
  try {
    excluded.forEach((node) => node.visible(false))
    relief.forEach((node) => node.shadowEnabled(false))
    stage.draw()
    assertCanonicalStageGeometry(stage, pixelRatio, expectedCanvas)

    const captured = stage.toCanvas({ pixelRatio })
    if (captured.width === expectedCanvas.width && captured.height === expectedCanvas.height) return captured

    const widthShortfall = expectedCanvas.width - captured.width
    const heightShortfall = expectedCanvas.height - captured.height
    const isKonvaOnePixelShort = Number.isInteger(captured.width)
      && Number.isInteger(captured.height)
      && captured.width <= expectedCanvas.width
      && captured.height <= expectedCanvas.height
      && widthShortfall <= 1
      && heightShortfall <= 1
      && (widthShortfall === 1 || heightShortfall === 1)
    if (isKonvaOnePixelShort) {
      // Konva may floor a raw crop by one pixel. Retry only after the canonical
      // logical geometry proof above, and require the retried raster to be exact.
      const recovered = stage.toCanvas({
        pixelRatio,
        width: expectedCanvas.width / pixelRatio,
        height: expectedCanvas.height / pixelRatio,
      })
      assertRasterDimensions(recovered, expectedCanvas)
      return recovered
    }

    assertRasterDimensions(captured, expectedCanvas)
    return captured
  } finally {
    excluded.forEach((node, index) => node.visible(visibility[index]))
    relief.forEach((node, index) => node.shadowEnabled(shadowVisibility[index]))
    stage.draw()
  }
}

function fontString(layer: TextLayer, css: string): string {
  const style = layer.italic ? 'italic ' : ''
  const weight = typeof layer.fontWeight === 'number' ? layer.fontWeight : layer.fontWeight === 'bold' ? 700 : 400
  return `${style}${weight} ${layer.fontSize}px ${css}`
}

function measureTextWidth(ctx: CanvasRenderingContext2D, layer: TextLayer, line: string): TextMeasureMetrics {
  const measured = ctx.measureText(line)
  return {
    width: measured.width + Math.max(0, Array.from(line).length - 1) * layer.letterSpacing,
    actualBoundingBoxAscent: measured.actualBoundingBoxAscent,
    actualBoundingBoxDescent: measured.actualBoundingBoxDescent,
  }
}

/** 绘制图层文本剪影（mask 用），与 Konva 可见文字共享已声明的锚点。 */
function drawTextShape(ctx: CanvasRenderingContext2D, layer: TextLayer, gray: number, css: string, mode: MaskDrawMode): void {
  ctx.save()
  ctx.font = fontString(layer, css)
  const layout = measureTextLayerLayout(layer, (line) => measureTextWidth(ctx, layer, line))
  const transform = resolveLayerRenderTransform({
    x: layer.x,
    y: layer.y,
    rotation: layout.rotation,
    width: layout.width,
    height: layout.height,
    anchor: layer.designMetrics?.anchor,
    baselineFromTop: layout.baselineFromTop,
  })
  ctx.translate(transform.origin.x, transform.origin.y)
  ctx.rotate((transform.rotation * Math.PI) / 180)
  ctx.fillStyle = `rgb(${gray},${gray},${gray})`
  ctx.strokeStyle = `rgb(${gray},${gray},${gray})`
  ctx.lineWidth = Math.max(1, layer.craft.find((effect) => effect.type === 'stroke')?.params.strokeWidth ?? 1)
  ctx.lineJoin = 'round'
  ctx.textAlign = layer.align
  ctx.direction = resolvedTextDirection(layer)
  ctx.textBaseline = 'alphabetic'
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${layer.letterSpacing}px`
  const lineH = layer.fontSize * (layer.lineHeight || 1.2)
  const startY = transform.box.y + layout.baselineFromTop
  const x = layer.align === 'left'
    ? transform.box.x
    : layer.align === 'right'
      ? transform.box.x + layout.width
      : transform.box.x + layout.width / 2
  for (let i = 0; i < layout.lines.length; i++) {
    if (mode === 'stroke') ctx.strokeText(layout.lines[i], x, startY + i * lineH)
    else ctx.fillText(layout.lines[i], x, startY + i * lineH)
  }
  ctx.restore()
}

interface ImageBits {
  src: string
  receiptKey: string
  original: HTMLImageElement
  preview: HTMLCanvasElement
}

export function LabelCanvas({ displayWidth, readOnly = false }: Props): React.JSX.Element {
  const config = useLabelStore((s) => s.activeArea)
  const areaId = config?.id ?? null
  const setBake = useLabelStore((s) => s.setBake)
  const selectedLayerIds = useLabelStore((s) => s.selectedLayerIds)
  const applyAreaOp = useLabelStore((s) => s.applyAreaOp)
  const interactionLayerIdsRef = useRef<string[] | null>(null)
  const showSeam = useUiStore((s) => s.showSeam)
  const activationRevision = useLabelStore((s) => s.activations)

  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const [imgBits, setImgBits] = useState<Map<string, ImageBits>>(new Map())

  const spec = config?.canvas
  const layers = config?.layers ?? []
  const globalCraft = config?.globalCraft.craft ?? []
  const uploadedFonts = config?.fonts ?? []
  const fontReadiness = useDesignFontReadiness(areaId, layers, uploadedFonts)
  const fontRevision = fontReadiness.revision
  const visibleFontReadinessKey = useMemo(
    () => config ? designFontReadinessKey(config) : '',
    [config],
  )
  const selectedLayerIdSet = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds])
  const transformableLayerIds = useMemo(
    () => readOnly ? [] : layers.filter((layer) => selectedLayerIdSet.has(layer.id) && !layer.locked).map((layer) => layer.id),
    [layers, readOnly, selectedLayerIdSet],
  )

  const selectFromClick = (clickedId: string | null, shiftKey: boolean): void => {
    const state = useLabelStore.getState()
    state.selectLayers(nextLayerSelection(state.selectedLayerIds, clickedId, shiftKey))
  }

  // 图片图层位图缓存
  useEffect(() => {
    let alive = true
    const imageLayers = config ? visibleImageLayersForRuntime(config) : []
    setImgBits((previous) => {
      const current = new Map<string, ImageBits>()
      for (const layer of imageLayers) {
        const bits = previous.get(layer.id)
        if (bits?.src === layer.src) current.set(layer.id, bits)
      }
      return current
    })
    void (async () => {
      const readyImages: Array<{ layer: ImageLayer; src: string; image: HTMLImageElement; receiptKey: string }> = []
      for (const layer of imageLayers) {
        try {
          if (!areaId) throw new Error('Image area is inactive')
          const loaded = await loadAreaContentBoundImage(areaId, activationRevision, layer)
          readyImages.push({ layer, src: layer.src, image: loaded.image, receiptKey: loaded.receiptKey })
        } catch {
          // A failed layer remains absent and therefore cannot satisfy bake readiness.
        }
      }
      if (!alive) return
      const m = new Map<string, ImageBits>()
      for (const readyImage of readyImages) {
        m.set(readyImage.layer.id, {
          src: readyImage.src,
          receiptKey: readyImage.receiptKey,
          original: readyImage.image,
          preview: renderCraftedImage(readyImage.image, readyImage.layer),
        })
        if (areaId) bindImageAssetReceipt(
          areaId, readyImage.layer.id, readyImage.src,
          readyImage.layer.naturalWidth, readyImage.layer.naturalHeight,
          readyImage.receiptKey,
        )
      }
      setImgBits(m)
    })()
    return () => {
      alive = false
    }
  }, [layers.map((l) => (l.kind === 'image' ? `${l.src}:${l.naturalWidth}:${l.naturalHeight}:${l.width}:${l.height}:${l.fit ?? 'stretch'}:${JSON.stringify(l.craft)}` : '')).join('|'), config?.meshIndex, activationRevision])

  const displayHeight = useMemo(() => {
    if (!spec || displayWidth <= 0) return 300
    return fitRasterDisplayHeight(displayWidth, spec)
  }, [spec, displayWidth])

  // 烘焙（防抖）
  const bake = useCallback((): boolean => {
    const stage = stageRef.current
    const cfg = useLabelStore.getState().activeArea
    if (!stage || !cfg || cfg.id !== areaId) return false
    assertRasterAspect(cfg.canvas)
    const ratio = cfg.canvas.width / (stage.width() || 1)
    if (!isFinite(ratio) || ratio <= 0) return false
    const color = captureDesignCanvas(stage, ratio, cfg.canvas)
    const carrierSurface = resolveCarrierSurface(cfg)
    const renderLayers = carrierSurface.renderDecoration ? cfg.layers : []
    const renderGlobalCraft = carrierSurface.renderDecoration ? cfg.globalCraft.craft : []
    // 全局工艺后处理（颜色画布）
    const cctx = color.getContext('2d')
    if (cctx) {
      applyPhysicalColorSurface(cctx, color.width, color.height, renderGlobalCraft)
      clearTransparentCanvasBorder(cctx, color.width, color.height)
    }
    const drawLayer = (ctx: CanvasRenderingContext2D, layer: LabelLayer, gray: number, mode: MaskDrawMode): boolean => {
      if (layer.kind === 'text') {
        if (layer.text.trim().length === 0) return false
        drawTextShape(ctx, layer, gray, fontCssFor(layer.fontFamily, cfg.fonts, layer.fontStack), mode)
      }
      else if (layer.kind === 'image') {
        const bits = imgBits.get(layer.id)
        if (!bits || bits.src !== layer.src) return false
        drawImageMaskShape(ctx, layer, bits.original, gray)
      } else drawShapeMask(ctx, layer, gray, mode)
      return true
    }
    const previousVersion = useLabelStore.getState().bakeMap[cfg.id]?.version ?? 0
    const version = Math.max(Date.now(), previousVersion + 1)
    const masks = renderCarrierMasks(cfg.canvas.width, cfg.canvas.height, drawLayer, cfg, version)
    const textOverflowLayerIds = renderLayers.flatMap((layer) => {
      if (layer.kind !== 'text' || !layer.visible) return []
      const measurementCanvas = document.createElement('canvas')
      const measurementContext = measurementCanvas.getContext('2d')
      if (!measurementContext) return []
      measurementContext.font = fontString(layer, fontCssFor(layer.fontFamily, cfg.fonts, layer.fontStack))
      return measureTextLayerLayout(layer, (line) => measureTextWidth(measurementContext, layer, line)).overflow
        ? [layer.id]
        : []
    })
    const visibleImagesReady = cfg.layers.every((layer) => layer.kind !== 'image' || !layer.visible
      || (imgBits.get(layer.id)?.src === layer.src))
    const assetsReady = fontReadiness.ready && visibleImagesReady
    const imageAssetReceipts = Object.fromEntries(cfg.layers.flatMap((layer) => {
      if (layer.kind !== 'image' || !layer.visible) return []
      const receiptKey = imgBits.get(layer.id)?.receiptKey
      return receiptKey ? [[layer.id, receiptKey]] : []
    }))
    setBake(cfg.id, {
      color,
      ...masks,
      spec: cfg.canvas,
      version,
      areaOwner: cfg,
      textOverflowLayerIds,
      fontReadinessKey: fontReadiness.ready ? visibleFontReadinessKey : undefined,
      imageAssetReceipts: assetsReady ? imageAssetReceipts : undefined,
      assetReadinessKey: assetsReady ? designAssetReadinessKey(cfg, imageAssetReceipts) : undefined,
    })
    return true
  }, [areaId, fontReadiness.ready, fontRevision, imgBits, setBake, visibleFontReadinessKey])

  const flushBake = useCallback((): boolean => {
    const stage = stageRef.current
    if (!stage) return false
    stage.draw()
    return bake()
  }, [bake])

  useLayoutEffect(() => {
    if (!areaId) return
    return registerExportBakeSurface(areaId, flushBake)
  }, [areaId, flushBake])

  // 编辑中保持 300ms 防抖；若立即切到纯 3D，layout cleanup 会在 Stage ref
  // 释放前同步完成最后一次烘焙，避免 bakeMap 永久停留在旧版本。
  useFlushableDebouncedBake(flushBake, [layers, globalCraft, config?.paper, config?.carrier, config?.substrate, config?.canvas, imgBits, fontRevision, flushBake], 300)

  // Transformer 绑定
  useEffect(() => {
    const tr = trRef.current
    const stage = stageRef.current
    if (!tr || !stage) return
    const nodes = transformableLayerIds
      .map((id) => stage.findOne((node: Konva.Node) => node.id() === `layer-${id}`))
      .filter((node): node is Konva.Node => node !== undefined)
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  }, [transformableLayerIds])

  const commitNodeTransforms = (layerIds: string[]): void => {
    const id = areaId
    const stage = stageRef.current
    if (!id || !stage || layerIds.length === 0) return
    const transforms = layerIds.flatMap<LayerNodeTransform>((layerId) => {
      const node = stage.findOne((candidate: Konva.Node) => candidate.id() === `layer-${layerId}`)
      if (!node) return []
      const layer = useLabelStore.getState().activeArea?.layers.find((candidate) => candidate.id === layerId)
      const transform = {
        id: layerId,
        x: node.x(),
        y: node.y(),
        rotation: node.rotation(),
        scaleX: node.scaleX(),
        scaleY: node.scaleY(),
        ...(layer?.kind === 'text' ? { baseWidth: layer.width ?? node.width() } : {}),
      }
      node.scaleX(1)
      node.scaleY(1)
      return [transform]
    })
    if (transforms.length === 0) return
    // One completed Konva gesture maps to one mutation-gateway call/history entry.
    if (commitLayerGesture(id, transforms, applyAreaOp)) requestAnimationFrame(() => bake())
  }

  if (!spec || !config) {
    return (
      <div className="label-canvas-empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13 }}>
        在左侧选择一个标签部件以开始设计
      </div>
    )
  }

  const sorted = canonicalLayerOrder(layers)
  const carrierSurface = resolveCarrierSurface(config)
  const substrateBoundary = carrierSurface.boundary
  const filmDiagnostic = clearFilmDiagnosticSpec(config)
  const customBoundaryTransform = substrateBoundary?.shape === 'custom'
    ? fitCarrierBoundaryToCanvas(substrateBoundary, spec)
    : undefined
  // 显示尺寸 → 画布坐标 1:1 缩放：Stage 显示 displayWidth×displayHeight，
  // 内部所有元素统一使用画布坐标（canvas.width×canvas.height），经 contentScale 映射。
  const contentScale = spec.width > 0 ? displayWidth / spec.width : 1

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <div className="label-canvas-surface" style={{ position: 'relative', width: displayWidth, height: displayHeight, maxWidth: '100%' }}>
        <Stage
          ref={stageRef}
          width={displayWidth}
          height={displayHeight}
          onMouseDown={(e) => {
            if (!readOnly && e.target === e.target.getStage()) selectFromClick(null, e.evt.shiftKey)
          }}
        >
          {/* 设计层（画布坐标） */}
          <Layer scaleX={contentScale} scaleY={contentScale}>
            {carrierSurface.substrateVisible && substrateBoundary?.shape === 'ellipse' ? (
              <KEllipse
                x={spec.width / 2}
                y={spec.height / 2}
                radiusX={spec.width / 2}
                radiusY={spec.height / 2}
                fill={carrierSurface.substrateColor}
                opacity={carrierSurface.substrateOpacity}
                listening={false}
              />
            ) : carrierSurface.substrateVisible && substrateBoundary?.shape === 'custom' && substrateBoundary.pathData ? (
              <KPath
                data={substrateBoundary.pathData}
                x={customBoundaryTransform?.x}
                y={customBoundaryTransform?.y}
                scaleX={customBoundaryTransform?.scaleX}
                scaleY={customBoundaryTransform?.scaleY}
                fill={carrierSurface.substrateColor}
                opacity={carrierSurface.substrateOpacity}
                listening={false}
              />
            ) : carrierSurface.substrateVisible ? (
              <KRect
                width={spec.width}
                height={spec.height}
                fill={carrierSurface.substrateColor}
                opacity={carrierSurface.substrateOpacity}
                cornerRadius={substrateBoundary?.shape === 'rounded_rectangle'
                  ? Math.max(0, (substrateBoundary.radiusMm ?? 0) * spec.width / Math.max(config.artboard?.widthMm ?? spec.width, 1))
                  : 0}
                listening={false}
              />
            ) : null}
            {carrierSurface.renderDecoration && sorted.map((layer) => {
              const css = layer.kind === 'text' ? fontCssFor(layer.fontFamily, uploadedFonts, layer.fontStack) : ''
              const foil = layer.craft.find((c) => c.type === 'foil')
              const emboss = layer.craft.find((c) => c.type === 'emboss')
              const deboss = layer.craft.find((c) => c.type === 'deboss')
              const strokePaint = craftStrokePaint(layer)
              const baseOpacity = layer.opacity
              const textLayout = layer.kind === 'text'
                ? (() => {
                    const canvas = document.createElement('canvas')
                    const ctx = canvas.getContext('2d')!
                    ctx.font = fontString(layer, css)
                    return measureTextLayerLayout(layer, (line) => measureTextWidth(ctx, layer, line))
                })()
                : null
              const shapeLayout = layer.kind === 'shape' ? normalizeShapeLayer(layer) : null
              const renderTransform = layer.kind === 'text' && textLayout
                ? resolveLayerRenderTransform({
                    x: layer.x,
                    y: layer.y,
                    rotation: textLayout.rotation,
                    width: textLayout.width,
                    height: textLayout.height,
                    anchor: layer.designMetrics?.anchor,
                    baselineFromTop: textLayout.baselineFromTop,
                  })
                : resolveLayerRenderTransform({
                    x: layer.x,
                    y: layer.y,
                    rotation: layer.rotation,
                    width: layer.kind === 'text' ? 1 : layer.width,
                    height: layer.kind === 'text' ? 1 : layer.height,
                    anchor: layer.designMetrics?.anchor,
                  })
              const foilProps = textLayout ? foilFillProps(foil, textLayout.width, textLayout.height) : foilFillProps(undefined, 1, 1)
              const shapeFoilProps = shapeLayout ? foilFillProps(foil, shapeLayout.width, shapeLayout.height) : null
              const genericShapePaint = shapeLayout && layer.kind === 'shape' && layer.shape !== 'rectangle'
                ? genericShapePaintProps(shapeLayout, foil)
                : null
              const relief = emboss ?? deboss
              const reliefSign = emboss ? 1 : deboss ? -1 : 0
              const reliefDepth = (relief?.params.depth ?? 0.08) * (layer.kind === 'text' ? layer.fontSize : Math.min(layer.width, layer.height))
              const reliefAngle = ((relief?.params.lightAngle ?? (emboss ? 45 : 225)) * Math.PI) / 180
              return (
                <Group
                  key={layer.id}
                  id={`layer-${layer.id}`}
                  x={renderTransform.origin.x}
                  y={renderTransform.origin.y}
                  rotation={renderTransform.rotation}
                  width={textLayout?.width}
                  height={textLayout?.height}
                  opacity={layer.visible ? baseOpacity : 0}
                  draggable={!readOnly && !layer.locked && layer.visible}
                  listening={!readOnly && layer.visible}
                  onClick={(e) => {
                    e.cancelBubble = true
                    selectFromClick(layer.id, e.evt.shiftKey)
                  }}
                  onDragStart={() => {
                    if (interactionLayerIdsRef.current) return
                    const state = useLabelStore.getState()
                    const selected = new Set(state.selectedLayerIds)
                    const ids = selected.has(layer.id)
                      ? (state.activeArea?.layers.filter((item) => selected.has(item.id) && !item.locked).map((item) => item.id) ?? [])
                      : [layer.id]
                    interactionLayerIdsRef.current = ids
                    if (!selected.has(layer.id)) state.selectLayers([layer.id])
                  }}
                  onDragEnd={() => {
                    const ids = interactionLayerIdsRef.current
                    if (!ids) return
                    interactionLayerIdsRef.current = null
                    commitNodeTransforms(ids)
                  }}
                >
                  {layer.kind === 'text' ? (
                    <KText
                      name={relief ? 'craft-relief' : undefined}
                      text={textLayout?.lines.join('\n') ?? layer.text}
                      fontFamily={css}
                      fontStyle={`${layer.italic ? 'italic ' : ''}${typeof layer.fontWeight === 'number' ? layer.fontWeight : layer.fontWeight === 'bold' ? 700 : 400}`}
                      fontSize={layer.fontSize}
                      letterSpacing={layer.letterSpacing}
                      lineHeight={layer.lineHeight || 1.2}
                      x={renderTransform.box.x}
                      y={renderTransform.box.y}
                      width={textLayout?.width}
                      height={textLayout?.height}
                      wrap="none"
                      align={layer.align}
                      direction={resolvedTextDirection(layer)}
                      fill={layer.color}
                      fillPriority={foilProps.fillPriority}
                      fillLinearGradientStartPoint={foilProps.fillLinearGradientStartPoint}
                      fillLinearGradientEndPoint={foilProps.fillLinearGradientEndPoint}
                      fillLinearGradientColorStops={foilProps.fillLinearGradientColorStops}
                      stroke={strokePaint.stroke}
                      strokeWidth={strokePaint.strokeWidth}
                      shadowColor={emboss ? 'rgba(0,0,0,0.35)' : deboss ? 'rgba(255,255,255,0.3)' : 'transparent'}
                      shadowOffsetX={Math.cos(reliefAngle) * reliefDepth * reliefSign}
                      shadowOffsetY={Math.sin(reliefAngle) * reliefDepth * reliefSign}
                      shadowBlur={Math.max(1, layer.fontSize * 0.06)}
                      listening={layer.visible}
                      perfectDrawEnabled={false}
                    />
                  ) : layer.kind === 'image' ? (
                    (() => {
                      const bits = imgBits.get(layer.id)
                      return bits?.src === layer.src ? (
                        <KImage
                          name={relief ? 'craft-relief' : undefined}
                          image={bits.preview}
                          x={renderTransform.box.x}
                          y={renderTransform.box.y}
                          width={layer.width}
                          height={layer.height}
                          shadowColor={emboss ? 'rgba(0,0,0,0.35)' : deboss ? 'rgba(255,255,255,0.3)' : 'transparent'}
                          shadowOffsetX={Math.cos(reliefAngle) * reliefDepth * reliefSign}
                          shadowOffsetY={Math.sin(reliefAngle) * reliefDepth * reliefSign}
                          shadowBlur={Math.max(1, Math.min(layer.width, layer.height) * 0.06)}
                          listening={layer.visible}
                        />
                      ) : null
                    })()
                  ) : layer.shape === 'rectangle' ? (
                    <KRect
                      name={relief ? 'craft-relief' : undefined}
                      {...rectangleRenderProps(layer)}
                      stroke={strokePaint.stroke}
                      strokeWidth={strokePaint.strokeWidth}
                      fillPriority={shapeFoilProps?.fillPriority}
                      fillLinearGradientStartPoint={shapeFoilProps?.fillLinearGradientStartPoint}
                      fillLinearGradientEndPoint={shapeFoilProps?.fillLinearGradientEndPoint}
                      fillLinearGradientColorStops={shapeFoilProps?.fillLinearGradientColorStops}
                      shadowColor={emboss ? 'rgba(0,0,0,0.35)' : deboss ? 'rgba(255,255,255,0.3)' : 'transparent'}
                      shadowOffsetX={Math.cos(reliefAngle) * reliefDepth * reliefSign}
                      shadowOffsetY={Math.sin(reliefAngle) * reliefDepth * reliefSign}
                      shadowBlur={Math.max(1, Math.min(layer.width, layer.height) * 0.06)}
                      listening={layer.visible}
                    />
                  ) : (
                    <KShape
                      name={relief ? 'craft-relief' : undefined}
                      x={renderTransform.box.x}
                      y={renderTransform.box.y}
                      width={shapeLayout?.width ?? layer.width}
                      height={shapeLayout?.height ?? layer.height}
                      sceneFunc={(context, shape) => {
                        context.save()
                        context.translate((shapeLayout?.width ?? layer.width) / 2, (shapeLayout?.height ?? layer.height) / 2)
                        drawShapePreview(context, shapeLayout ?? layer, shape)
                        context.restore()
                      }}
                      fill={genericShapePaint?.fill ?? layer.fill}
                      fillPriority={genericShapePaint?.fillPriority}
                      fillLinearGradientStartPoint={genericShapePaint?.fillLinearGradientStartPoint}
                      fillLinearGradientEndPoint={genericShapePaint?.fillLinearGradientEndPoint}
                      fillLinearGradientColorStops={genericShapePaint?.fillLinearGradientColorStops}
                      fillRule={layer.fillRule ?? 'nonzero'}
                      stroke={strokePaint.stroke ?? genericShapePaint?.stroke ?? layer.stroke}
                      strokeLinearGradientStartPoint={genericShapePaint?.strokeLinearGradientStartPoint}
                      strokeLinearGradientEndPoint={genericShapePaint?.strokeLinearGradientEndPoint}
                      strokeLinearGradientColorStops={genericShapePaint?.strokeLinearGradientColorStops}
                      strokeWidth={shapeUsesOpenStroke(layer) ? Math.max(1, strokePaint.strokeWidth) : strokePaint.strokeWidth}
                      dash={shapeLayout?.geometry?.dash}
                      shadowColor={emboss ? 'rgba(0,0,0,0.35)' : deboss ? 'rgba(255,255,255,0.3)' : 'transparent'}
                      shadowOffsetX={Math.cos(reliefAngle) * reliefDepth * reliefSign}
                      shadowOffsetY={Math.sin(reliefAngle) * reliefDepth * reliefSign}
                      shadowBlur={Math.max(1, Math.min(layer.width, layer.height) * 0.06)}
                      listening={layer.visible}
                    />
                  )}
                </Group>
              )
            })}
          </Layer>
          {filmDiagnostic ? (
            <Layer name="non-export" scaleX={contentScale} scaleY={contentScale} listening={false}>
              {filmDiagnostic.shape === 'ellipse' ? (
                <KEllipse x={spec.width / 2} y={spec.height / 2} radiusX={spec.width / 2} radiusY={spec.height / 2} stroke="rgba(70,110,130,.65)" strokeWidth={1.5} dash={[6, 4]} />
              ) : filmDiagnostic.shape === 'custom' && filmDiagnostic.pathData ? (
                <KPath data={filmDiagnostic.pathData} x={customBoundaryTransform?.x} y={customBoundaryTransform?.y} scaleX={customBoundaryTransform?.scaleX} scaleY={customBoundaryTransform?.scaleY} stroke="rgba(70,110,130,.65)" strokeWidth={1.5} dash={[6, 4]} />
              ) : (
                <KRect width={spec.width} height={spec.height} stroke="rgba(70,110,130,.65)" strokeWidth={1.5} dash={[6, 4]} cornerRadius={filmDiagnostic.shape === 'rounded_rectangle' ? Math.max(0, (filmDiagnostic.radiusMm ?? 0) * spec.width / Math.max(config.artboard?.widthMm ?? spec.width, 1)) : 0} />
              )}
            </Layer>
          ) : null}
          {/* 选中 Transform（屏幕坐标层，绑定画布坐标节点） */}
          {transformableLayerIds.length > 0 && (
            <Layer name="non-export">
              <Transformer
                ref={trRef}
                rotateEnabled
                flipEnabled={false}
                shouldOverdrawWholeArea={transformableLayerIds.length > 1}
                enabledAnchors={(() => {
                  if (transformableLayerIds.length > 1) return ['top-left', 'top-right', 'bottom-left', 'bottom-right']
                  const selected = layers.find((layer) => layer.id === transformableLayerIds[0])
                  if (!selected) return []
                  return selected.kind === 'text'
                    ? ['middle-left', 'middle-right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']
                    : ['top-left', 'top-right', 'bottom-left', 'bottom-right']
                })()}
                keepRatio={(() => {
                  if (transformableLayerIds.length > 1) return true
                  const selected = layers.find((layer) => layer.id === transformableLayerIds[0])
                  return selected ? selected.kind === 'image' : true
                })()}
                boundBoxFunc={(oldBox, newBox) => (newBox.width < 6 || newBox.height < 6 ? oldBox : newBox)}
                onTransformStart={() => { interactionLayerIdsRef.current = transformableLayerIds }}
                onTransformEnd={() => {
                  const ids = interactionLayerIdsRef.current
                  if (!ids) return
                  interactionLayerIdsRef.current = null
                  commitNodeTransforms(ids)
                }}
                onDragStart={() => {
                  if (!interactionLayerIdsRef.current) interactionLayerIdsRef.current = transformableLayerIds
                }}
                onDragEnd={() => {
                  const ids = interactionLayerIdsRef.current
                  if (!ids) return
                  interactionLayerIdsRef.current = null
                  commitNodeTransforms(ids)
                }}
              />
            </Layer>
          )}
          {/* 接缝线 + 正面标记（画布坐标覆盖层） */}
          <Layer name="non-export" scaleX={contentScale} scaleY={contentScale} listening={false}>
            {showSeam && (
              <>
                <Line points={[0.5, 0, 0.5, spec.height]} stroke={LABEL_CANVAS_GUIDES.seam} dash={[4, 4]} strokeWidth={1.5} />
                <Line points={[spec.width - 0.5, 0, spec.width - 0.5, spec.height]} stroke={LABEL_CANVAS_GUIDES.seam} dash={[4, 4]} strokeWidth={1.5} />
              </>
            )}
            {/* 正面（u=0.5）三角标 */}
            <Line points={[spec.width / 2 - 8, 0, spec.width / 2 + 8, 0, spec.width / 2, 12]} closed fill={LABEL_CANVAS_GUIDES.front} stroke={LABEL_CANVAS_GUIDES.front} strokeWidth={1.5} />
          </Layer>
        </Stage>
      </div>
    </div>
  )
}
