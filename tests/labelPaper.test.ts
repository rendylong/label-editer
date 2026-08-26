import { describe, expect, it } from 'vitest'
import * as labelCanvas from '../src/label/LabelCanvas'
import { resolveCarrierSurface } from '../src/label/paper'
import { validatePrintReadiness } from '../src/label/printReadiness'
import type { LabelAreaConfig } from '../src/label/types'

type Paper = { enabled: boolean; color: string; opacity: number }

describe('标签纸张底色', () => {
  const resolve = (labelCanvas as unknown as {
    resolveLabelPaper?: (paper?: Partial<Paper>) => Paper
  }).resolveLabelPaper

  it('旧项目和新建区域默认保持透明，不回退为白底', () => {
    expect(resolve?.()).toEqual({ enabled: false, color: '#f2efe4', opacity: 1 })
  })

  it('显式启用时保留用户选择的纸张颜色和透明度', () => {
    expect(resolve?.({ enabled: true, color: '#ece9dd', opacity: 0.92 })).toEqual({
      enabled: true,
      color: '#ece9dd',
      opacity: 0.92,
    })
  })

  it('未声明 carrier 时 carrier resolver 复用完全相同的 legacy paper 值', () => {
    expect(resolveCarrierSurface({ paper: { enabled: true, color: '#ece9dd', opacity: 0.92 } })).toMatchObject({
      carrier: 'legacy', substrateVisible: true, substrateColor: '#ece9dd', substrateOpacity: 0.92,
    })
  })

  it('旧项目缺少 printSpec 时精确保留原有的单一 readiness issue', () => {
    const area = {
      id: 'legacy', name: 'Legacy', canvas: { width: 400, height: 600, aspect: 2 / 3 },
      paper: { enabled: true, color: '#ece9dd', opacity: 0.92 },
      layers: [{
        id: 'foil', kind: 'shape', shape: 'rectangle', x: 0, y: 0, width: 10, height: 10,
        fill: '#000', stroke: 'transparent', strokeWidth: 0, cornerRadius: 0, rotation: 0,
        opacity: 1, visible: true, locked: false, zIndex: 0,
        craft: [{ type: 'foil', params: {} }],
      }],
    } as LabelAreaConfig

    expect(validatePrintReadiness(area)).toEqual([
      { code: 'missing-print-spec', message: '尚未设置物理尺寸、出血与刀模。' },
    ])
  })
})
