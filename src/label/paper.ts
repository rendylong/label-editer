import type { CarrierMode, LabelAreaConfig, LabelPaper } from './types'
import { hasOpenSvgSubpath, parseNormalizedSvgPath, svgPathBounds, type SvgPathBounds } from './svgPath'

const DEFAULT_LABEL_PAPER: LabelPaper = {
  enabled: false,
  color: '#f2efe4',
  opacity: 1,
}

/** 旧项目没有 paper 字段时仍保持透明；颜色只是启用后的建议纸色。 */
export function resolveLabelPaper(paper?: Partial<LabelPaper>): LabelPaper {
  return {
    enabled: paper?.enabled === true,
    color: typeof paper?.color === 'string' ? paper.color : DEFAULT_LABEL_PAPER.color,
    opacity: Math.max(0, Math.min(1, typeof paper?.opacity === 'number' ? paper.opacity : DEFAULT_LABEL_PAPER.opacity)),
  }
}

export interface CarrierSurface {
  carrier: CarrierMode | 'legacy'
  substrateVisible: boolean
  substrateColor: string
  substrateOpacity: number
  boundaryVisible: boolean
  adhesiveApplicable: boolean
  bleedApplicable: boolean
  dieCutApplicable: boolean
  whiteUnderbaseApplicable: boolean
  renderDecoration: boolean
  diagnosticFilmExtent: boolean
  boundary?: CarrierBoundary
}

export interface CarrierBoundary {
  shape: 'rectangle' | 'rounded_rectangle' | 'ellipse' | 'custom'
  radiusMm?: number
  pathData?: string
  pathBounds?: SvgPathBounds
}

export interface CarrierBoundaryResolution {
  boundary?: CarrierBoundary
  invalidField?: 'substrate.boundary.pathData'
}

type CarrierSurfaceInput = Pick<LabelAreaConfig, 'carrier' | 'substrate' | 'paper' | 'legacyPaperCarrier'>

export function resolveCarrierBoundary(area: Pick<LabelAreaConfig, 'substrate'>): CarrierBoundaryResolution {
  const boundary = area.substrate?.boundary
  if (!boundary) return {}
  if (boundary.shape !== 'custom') {
    return { boundary: { shape: boundary.shape, ...(boundary.radiusMm === undefined ? {} : { radiusMm: boundary.radiusMm }) } }
  }
  if (typeof boundary.pathData !== 'string' || boundary.pathData.length === 0) {
    return { invalidField: 'substrate.boundary.pathData' }
  }
  try {
    const commands = parseNormalizedSvgPath(boundary.pathData)
    const pathBounds = svgPathBounds(commands)
    if (hasOpenSvgSubpath(commands) || pathBounds.width <= 0 || pathBounds.height <= 0) {
      return { invalidField: 'substrate.boundary.pathData' }
    }
    return { boundary: { shape: 'custom', pathData: boundary.pathData, pathBounds } }
  } catch {
    return { invalidField: 'substrate.boundary.pathData' }
  }
}

/**
 * Resolves clean artwork geometry independently from production diagnostics.
 * A carrier-incompatible substrate remains available to readiness validation,
 * but can never make this resolver synthesize a panel.
 */
export function resolveCarrierSurface(area: CarrierSurfaceInput): CarrierSurface {
  if (!area.carrier || (
    area.legacyPaperCarrier === true
    && area.carrier === 'applied_label'
    && area.substrate === undefined
    && area.paper?.enabled === true
  )) {
    const paper = resolveLabelPaper(area.paper)
    return {
      carrier: 'legacy',
      substrateVisible: paper.enabled,
      substrateColor: paper.color,
      substrateOpacity: paper.opacity,
      boundaryVisible: paper.enabled,
      adhesiveApplicable: paper.enabled,
      // Preserve the legacy paper readiness path whether or not its optional
      // visual fill is enabled.
      bleedApplicable: true,
      dieCutApplicable: true,
      whiteUnderbaseApplicable: false,
      renderDecoration: true,
      diagnosticFilmExtent: false,
    }
  }

  const substrate = area.substrate
  const boundaryResolution = resolveCarrierBoundary(area)
  const base = {
    carrier: area.carrier,
    substrateColor: substrate?.color ?? '#ffffff',
    substrateOpacity: Math.max(0, Math.min(1, substrate?.opacity ?? 0)),
    renderDecoration: area.carrier !== 'bare',
  } as const

  switch (area.carrier) {
    case 'applied_label':
      return {
        ...base,
        substrateVisible: substrate?.kind === 'opaque' && base.substrateOpacity > 0 && boundaryResolution.boundary !== undefined,
        boundaryVisible: boundaryResolution.boundary !== undefined,
        adhesiveApplicable: true,
        bleedApplicable: true,
        dieCutApplicable: true,
        whiteUnderbaseApplicable: false,
        diagnosticFilmExtent: false,
        ...(boundaryResolution.boundary ? { boundary: boundaryResolution.boundary } : {}),
      }
    case 'clear_label':
      return {
        ...base,
        substrateVisible: false,
        boundaryVisible: false,
        adhesiveApplicable: true,
        bleedApplicable: false,
        dieCutApplicable: false,
        whiteUnderbaseApplicable: true,
        diagnosticFilmExtent: substrate?.kind === 'transparent'
          && base.substrateOpacity < 1
          && boundaryResolution.boundary !== undefined,
        ...(boundaryResolution.boundary ? { boundary: boundaryResolution.boundary } : {}),
      }
    case 'direct_surface_print':
      return {
        ...base,
        substrateVisible: false,
        boundaryVisible: false,
        adhesiveApplicable: false,
        bleedApplicable: false,
        dieCutApplicable: false,
        whiteUnderbaseApplicable: true,
        diagnosticFilmExtent: false,
      }
    case 'in_mold':
    case 'foil_or_ink_only':
    case 'bare':
      return {
        ...base,
        substrateVisible: false,
        boundaryVisible: false,
        adhesiveApplicable: false,
        bleedApplicable: false,
        dieCutApplicable: false,
        whiteUnderbaseApplicable: false,
        diagnosticFilmExtent: false,
      }
  }
}
