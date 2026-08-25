import type { LabelAreaConfig } from './types'

export interface PrintReadinessIssue {
  code: 'missing-print-spec' | 'text-below-minimum-height' | 'foil-without-spot-name' | 'missing-bleed'
  message: string
  layerId?: string
}

export interface PrintManifest {
  areaId: string
  areaName: string
  dimensionsMm: { width: number; height: number; bleed: number; cornerRadius: number }
  dieCutShape: string
  minimumTextHeightMm: number
  separations: string[]
  issues: PrintReadinessIssue[]
}

export function validatePrintReadiness(area: LabelAreaConfig): PrintReadinessIssue[] {
  const spec = area.printSpec
  if (!spec) return [{ code: 'missing-print-spec', message: '尚未设置物理尺寸、出血与刀模。' }]
  const issues: PrintReadinessIssue[] = []
  if (spec.bleedMm <= 0) issues.push({ code: 'missing-bleed', message: '出血为 0 mm，请确认印厂要求。' })
  const mmPerPixel = spec.physicalHeightMm / Math.max(area.canvas.height, 1)
  for (const layer of area.layers) {
    if (layer.kind === 'text' && layer.visible && layer.fontSize * mmPerPixel < spec.minTextHeightMm) {
      issues.push({ code: 'text-below-minimum-height', layerId: layer.id, message: `文字「${layer.text.slice(0, 24)}」低于 ${spec.minTextHeightMm} mm 最小字高。` })
    }
    const foil = layer.craft.find((effect) => effect.type === 'foil')
    if (foil && !foil.params.foilSpotName && spec.spotColors.length === 0) {
      issues.push({ code: 'foil-without-spot-name', layerId: layer.id, message: '烫金图层缺少专色/箔版名称。' })
    }
  }
  return issues
}

export function buildPrintManifest(area: LabelAreaConfig): PrintManifest {
  if (!area.printSpec) throw new Error(`贴标区域「${area.name}」尚未设置印刷规格`)
  const spec = area.printSpec
  const foilNames = area.layers.flatMap((layer) => layer.craft.flatMap((effect) => effect.type === 'foil' && effect.params.foilSpotName ? [effect.params.foilSpotName] : []))
  return {
    areaId: area.id,
    areaName: area.name,
    dimensionsMm: { width: spec.physicalWidthMm, height: spec.physicalHeightMm, bleed: spec.bleedMm, cornerRadius: spec.cornerRadiusMm },
    dieCutShape: spec.dieCutShape,
    minimumTextHeightMm: spec.minTextHeightMm,
    separations: [...new Set(['color', 'metalness', 'roughness', 'bump', ...spec.spotColors, ...foilNames])],
    issues: validatePrintReadiness(area),
  }
}
