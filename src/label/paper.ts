import type { LabelPaper } from './types'

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
