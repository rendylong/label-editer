import type { LabelAreaConfig } from './types'
import type { BakeInput } from '../app/exportTypes'
import { carrierReadinessChecks, type CarrierReadinessCode } from './exportReadiness'
import { resolveCarrierBoundary, resolveCarrierSurface } from './paper'
import { isRenderableWhiteUnderbaseLayer } from './whiteUnderbase'
import { validateVectorPath } from './vectorPathValidation'
import { isRendererProvenWhiteUnderbase } from './craft'

export type CarrierInvariantIssueCode =
  | 'carrier-forbidden-substrate'
  | 'missing-applied-substrate'
  | 'missing-applied-boundary'
  | 'non-transparent-clear-substrate'
  | 'decoration-on-bare'
  | 'invalid-custom-boundary'
  | 'missing-clear-boundary'
  | 'invalid-applied-substrate-opacity'

export interface PrintReadinessIssue {
  code: 'missing-print-spec' | 'text-below-minimum-height' | 'foil-without-spot-name' | 'missing-bleed' | 'invalid-vector-path' | CarrierInvariantIssueCode | CarrierReadinessCode
  message: string
  severity?: 'error' | 'warning'
  areaId?: string
  layerId?: string
  field?: string
  fields?: string[]
}

export interface PrintManifest {
  areaId: string
  areaName: string
  carrier?: LabelAreaConfig['carrier'] | 'legacy'
  dimensionsMm: { width: number; height: number; bleed: number; cornerRadius: number } | null
  dieCutShape: string | null
  minimumTextHeightMm: number | null
  /** Canonical renderer proof; user separation strings can never authorize this fact. */
  whiteUnderbaseAuthorized: boolean
  separations: string[]
  issues: PrintReadinessIssue[]
}

function carrierInvariantIssues(area: LabelAreaConfig): PrintReadinessIssue[] {
  const issues: PrintReadinessIssue[] = []
  const surface = resolveCarrierSurface(area)
  const boundaryResolution = resolveCarrierBoundary(area)
  const forbiddenSubstrate = area.carrier === 'direct_surface_print'
    || area.carrier === 'in_mold'
    || area.carrier === 'foil_or_ink_only'
    || area.carrier === 'bare'
  if (forbiddenSubstrate && area.substrate !== undefined) {
    issues.push({
      code: 'carrier-forbidden-substrate', areaId: area.id, fields: ['substrate'],
      message: `区域「${area.name}」的载体 ${area.carrier} 禁止 substrate 面板；渲染已忽略该字段。`,
    })
  }
  if (area.carrier === 'applied_label' && surface.carrier !== 'legacy') {
    if (!area.substrate || area.substrate.kind !== 'opaque') {
      issues.push({
        code: 'missing-applied-substrate', areaId: area.id, fields: ['substrate'],
        message: `区域「${area.name}」的 applied_label 缺少显式不透明 substrate。`,
      })
    }
    if (!area.substrate?.boundary) {
      issues.push({
        code: 'missing-applied-boundary', areaId: area.id, fields: ['substrate.boundary'],
        message: `区域「${area.name}」的 applied_label 缺少实体边界。`,
      })
    }
    if (area.substrate?.kind === 'opaque' && area.substrate.opacity <= 0) {
      issues.push({
        code: 'invalid-applied-substrate-opacity', areaId: area.id, fields: ['substrate.opacity'],
        message: `区域「${area.name}」的 applied_label substrate opacity 必须大于 0。`,
      })
    }
  }
  if (area.carrier === 'clear_label') {
    if (!area.substrate || area.substrate.kind !== 'transparent') {
      issues.push({
        code: 'non-transparent-clear-substrate', areaId: area.id, fields: ['substrate.kind'],
        message: `区域「${area.name}」的 clear_label 必须声明透明 substrate。`,
      })
    } else if (area.substrate.opacity >= 1) {
      issues.push({
        code: 'non-transparent-clear-substrate', areaId: area.id, fields: ['substrate.opacity'],
        message: `区域「${area.name}」的 clear_label substrate 不得为全不透明。`,
      })
    }
    if (!area.substrate?.boundary) {
      issues.push({
        code: 'missing-clear-boundary', areaId: area.id, fields: ['substrate.boundary'],
        message: `区域「${area.name}」的 clear_label 缺少透明膜材范围。`,
      })
    }
  }
  if (boundaryResolution.invalidField) {
    issues.push({
      code: 'invalid-custom-boundary', areaId: area.id, fields: [boundaryResolution.invalidField],
      message: `区域「${area.name}」的 custom substrate boundary 无效，渲染不会回退为矩形。`,
    })
  }
  if (area.carrier === 'bare' && area.layers.length > 0) {
    issues.push({
      code: 'decoration-on-bare', areaId: area.id, fields: ['layers'],
      message: `区域「${area.name}」声明为 bare，但仍包含装饰图层；渲染已抑制这些图层。`,
    })
  }
  return issues
}

export function validatePrintReadiness(area: LabelAreaConfig): PrintReadinessIssue[] {
  const spec = area.printSpec
  const vectorIssues = area.layers.flatMap((layer): PrintReadinessIssue[] => {
    if (layer.kind !== 'shape' || layer.shape !== 'path') return []
    const vectorIssue = validateVectorPath(layer.pathData, layer.pathViewBox, layer.width, layer.height)
    return vectorIssue ? [{
      severity: 'error', code: 'invalid-vector-path', areaId: area.id, layerId: layer.id,
      field: vectorIssue.field, fields: [vectorIssue.field],
      message: `区域「${area.name}」图层「${layer.id}」的 ${vectorIssue.message}。`,
    }] : []
  })
  if (!area.carrier && !spec) {
    return [...vectorIssues, { code: 'missing-print-spec', message: '尚未设置物理尺寸、出血与刀模。' }]
  }
  const surface = resolveCarrierSurface(area)
  const issues: PrintReadinessIssue[] = [
    ...vectorIssues,
    ...carrierInvariantIssues(area),
    ...carrierReadinessChecks(area),
  ]
  if (area.carrier === 'bare') return issues
  if (!spec && (!area.carrier || area.carrier === 'applied_label')) {
    issues.push({ code: 'missing-print-spec', areaId: area.id, message: '尚未设置物理尺寸、出血与刀模。' })
  }
  if (spec && surface.bleedApplicable && spec.bleedMm <= 0) {
    issues.push({
      code: 'missing-bleed', message: '出血为 0 mm，请确认印厂要求。',
      ...(area.carrier ? { areaId: area.id } : {}),
    })
  }
  const mmPerPixel = spec ? spec.physicalHeightMm / Math.max(area.canvas.height, 1) : null
  for (const layer of area.layers) {
    if (spec && mmPerPixel !== null && layer.kind === 'text' && layer.visible && layer.fontSize * mmPerPixel < spec.minTextHeightMm) {
      issues.push({ code: 'text-below-minimum-height', layerId: layer.id, message: `文字「${layer.text.slice(0, 24)}」低于 ${spec.minTextHeightMm} mm 最小字高。` })
    }
    const foil = layer.craft.find((effect) => effect.type === 'foil')
    const declaredFoilSpot = (layer.processes ?? []).some((process) => process.process === 'hot_stamp_foil' && process.spotName)
    if (foil && !foil.params.foilSpotName && !declaredFoilSpot && (!spec || spec.spotColors.length === 0)) {
      issues.push({ code: 'foil-without-spot-name', layerId: layer.id, message: '烫金图层缺少专色/箔版名称。' })
    }
  }
  return issues
}

export function buildPrintManifest(
  area: LabelAreaConfig,
  bake?: BakeInput,
): PrintManifest {
  if (!area.printSpec && !area.carrier) throw new Error(`贴标区域「${area.name}」尚未设置印刷规格`)
  const spec = area.printSpec
  const userSeparation = (value: string | undefined): string[] => value && value !== 'white_underbase' ? [value] : []
  const foilNames = area.layers.flatMap((layer) => layer.craft.flatMap((effect) => (
    effect.type === 'foil' ? userSeparation(effect.params.foilSpotName) : []
  )))
  const declaresWhiteUnderbase = area.layers.some((layer) => (layer.processes ?? []).some((process) => (
    process.process === 'white_underbase' || process.requiredMask === 'white_underbase'
  )))
  const rendererProvesCurrentWhiteUnderbase = declaresWhiteUnderbase
    && isRendererProvenWhiteUnderbase(area, bake)
  const declaredSeparations = area.layers.flatMap((layer) => (layer.processes ?? []).flatMap((process) => {
    const whiteUnderbase = process.process === 'white_underbase' || process.requiredMask === 'white_underbase'
    if (whiteUnderbase && (
      !rendererProvesCurrentWhiteUnderbase
      || !isRenderableWhiteUnderbaseLayer(layer)
    )) return []
    return [
      ...(whiteUnderbase ? ['white_underbase'] : []),
      ...(process.requiredMask ? [process.requiredMask] : []),
      ...userSeparation(process.spotName),
    ]
  }))
  const isLegacy = !area.carrier
  const separations = area.carrier === 'bare'
    ? []
    : isLegacy
      ? ['color', 'metalness', 'roughness', 'bump', ...(spec?.spotColors ?? []).flatMap(userSeparation), ...foilNames]
      : [...declaredSeparations, ...(spec?.spotColors ?? []).flatMap(userSeparation), ...foilNames]
  return {
    areaId: area.id,
    areaName: area.name,
    carrier: area.carrier ?? 'legacy',
    dimensionsMm: spec
      ? { width: spec.physicalWidthMm, height: spec.physicalHeightMm, bleed: spec.bleedMm, cornerRadius: spec.cornerRadiusMm }
      : null,
    dieCutShape: spec?.dieCutShape ?? null,
    minimumTextHeightMm: spec?.minTextHeightMm ?? null,
    whiteUnderbaseAuthorized: rendererProvesCurrentWhiteUnderbase,
    separations: [...new Set(separations)],
    issues: validatePrintReadiness(area),
  }
}
