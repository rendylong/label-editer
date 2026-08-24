import { describe, expect, it } from 'vitest'
import * as labelCanvas from '../src/label/LabelCanvas'

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
})
