import { deriveDesignFontRequests } from './fontRuntime'
import { canonicalLayerOrder } from './layerOrder'
import type { LabelAreaConfig } from './types'
import { sha256HexSync } from '../agent/syncSha256'

export type CarrierReadinessCode =
  | 'ink-adhesion'
  | 'opacity'
  | 'curvature'
  | 'registration'
  | 'rub-resistance'
  | 'white-underbase'
  | 'bleed'
  | 'die-cut'
  | 'edge-adhesion'
  | 'film-extent'
  | 'in-mold-process'
  | 'declared-process'

export interface CarrierReadinessCheck {
  code: CarrierReadinessCode
  areaId: string
  message: string
  /** These are unverified production prompts, never manufacturing certification. */
  status: 'unverified'
}

function check(area: LabelAreaConfig, code: CarrierReadinessCode, message: string): CarrierReadinessCheck {
  return { code, areaId: area.id, message, status: 'unverified' }
}

function hasProcess(area: LabelAreaConfig, predicate: (process: NonNullable<LabelAreaConfig['layers'][number]['processes']>[number]) => boolean): boolean {
  return area.layers.some((layer) => (layer.processes ?? []).some(predicate))
}

/** Returns carrier-specific prompts that still require physical supplier validation. */
export function carrierReadinessChecks(area: LabelAreaConfig): CarrierReadinessCheck[] {
  switch (area.carrier) {
    case 'direct_surface_print': {
      const checks = [
        check(area, 'ink-adhesion', '需按实际包材与油墨验证附着力。'),
        check(area, 'opacity', '需在实际包材底色上验证油墨遮盖力。'),
        check(area, 'curvature', '需验证曲面可印刷范围与图文变形。'),
        check(area, 'registration', '需验证多色及工艺套准。'),
        check(area, 'rub-resistance', '需通过实际耐摩擦测试。'),
      ]
      if (hasProcess(area, (process) => process.process === 'white_underbase' || process.requiredMask === 'white_underbase')) {
        checks.push(check(area, 'white-underbase', '需验证已声明的选择性白墨底版。'))
      }
      return checks
    }
    case 'applied_label':
      return [
        check(area, 'bleed', '需按供应商刀模验证出血。'),
        check(area, 'die-cut', '需验证实体标签边界与刀模。'),
        check(area, 'edge-adhesion', '需在实际包材曲面验证边缘粘接。'),
      ]
    case 'clear_label': {
      const checks = [
        check(area, 'film-extent', '需验证透明膜材范围与边缘可见性。'),
        check(area, 'registration', '需验证透明膜上油墨与工艺套准。'),
        check(area, 'edge-adhesion', '需在实际包材上验证透明膜边缘粘接。'),
      ]
      if (hasProcess(area, (process) => process.process === 'white_underbase' || process.requiredMask === 'white_underbase')) {
        checks.push(check(area, 'white-underbase', '需验证已声明区域的选择性白墨底版。'))
      }
      return checks
    }
    case 'in_mold':
      return [
        check(area, 'in-mold-process', '需由成型供应商验证材料与模内工艺兼容性。'),
        check(area, 'registration', '需验证模内装饰定位与套准。'),
      ]
    case 'foil_or_ink_only': {
      const checks = [check(area, 'registration', '需验证已声明装饰工艺的定位与套准。')]
      if (hasProcess(area, () => true)) checks.push(check(area, 'declared-process', '需验证每个已声明装饰工艺及其专色版。'))
      return checks
    }
    case 'bare':
      return []
    case undefined:
      return []
  }
}

/** Stable identity for the visible font assets a baked area was drawn with. */
export function designFontReadinessKey(area: Pick<LabelAreaConfig, 'layers' | 'fonts'>): string {
  return deriveDesignFontRequests(
    canonicalLayerOrder(area.layers).filter((layer) => layer.visible),
    area.fonts,
  ).map((request) => request.key).join('|')
}

/** Fingerprint every visible external asset identity required by one exact bake. */
export function designAssetReadinessKey(area: Pick<LabelAreaConfig, 'layers' | 'fonts'>): string {
  const visible = canonicalLayerOrder(area.layers).filter((layer) => layer.visible)
  const identity = {
    fonts: deriveDesignFontRequests(visible, area.fonts).map((request) => request.key),
    images: visible.flatMap((layer) => layer.kind === 'image' ? [{
      id: layer.id,
      src: layer.src,
      naturalWidth: layer.naturalWidth,
      naturalHeight: layer.naturalHeight,
    }] : []),
  }
  return `sha256:${sha256HexSync(new TextEncoder().encode(JSON.stringify(identity)))}`
}

/** A current owner reference alone is insufficient: the successful asset set must match too. */
export function isBakeAssetReadyForArea(
  area: Pick<LabelAreaConfig, 'layers' | 'fonts'>,
  bake: { fontReadinessKey?: string; assetReadinessKey?: string },
): boolean {
  return (bake.fontReadinessKey ?? '') === designFontReadinessKey(area)
    && bake.assetReadinessKey === designAssetReadinessKey(area)
}
