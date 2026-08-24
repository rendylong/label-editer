import { describe, expect, it } from 'vitest'
import { fitCanvasDisplayWidth, resizeSplitPercent, splitPercentFromPointer } from '../src/app/canvasLayout'

describe('2D 标签画布视口适配', () => {
  it('超高标签同时受容器高度约束，顶部与底部都可见', () => {
    const width = fitCanvasDisplayWidth({ containerWidth: 660, containerHeight: 680, aspect: 0.44, maxWidth: 900, padding: 24 })

    expect(width).toBeCloseTo((680 - 24) * 0.44)
    expect(width / 0.44).toBeLessThanOrEqual(680 - 24)
  })

  it('普通横向标签仍优先使用可用宽度', () => {
    expect(fitCanvasDisplayWidth({ containerWidth: 660, containerHeight: 680, aspect: 2, maxWidth: 900, padding: 24 })).toBe(636)
  })

  it('在中央区的 65% 2D 分栏中返回有效且不溢出的画布尺寸', () => {
    const paneWidth = 1000 * 0.65
    const width = fitCanvasDisplayWidth({ containerWidth: paneWidth, containerHeight: 720, aspect: 4 / 3, maxWidth: 900, padding: 24 })

    expect(width).toBe(626)
    expect(width).toBeGreaterThan(0)
    expect(width).toBeLessThanOrEqual(paneWidth - 24)
    expect(width / (4 / 3)).toBeLessThanOrEqual(720 - 24)
  })
})

describe('2D/3D 分栏尺寸', () => {
  it('将指针位置换算为分栏百分比并保持两个面板有效', () => {
    expect(splitPercentFromPointer({ clientX: 40, containerLeft: 100, containerWidth: 1000 })).toBe(25)
    expect(splitPercentFromPointer({ clientX: 600, containerLeft: 100, containerWidth: 1000 })).toBe(50)
    expect(splitPercentFromPointer({ clientX: 1060, containerLeft: 100, containerWidth: 1000 })).toBe(80)
    expect(splitPercentFromPointer({ clientX: 600, containerLeft: 100, containerWidth: 0 })).toBe(65)
  })

  it('支持键盘调整并在边界停止', () => {
    expect(resizeSplitPercent(65, 'ArrowLeft')).toBe(60)
    expect(resizeSplitPercent(65, 'ArrowRight')).toBe(70)
    expect(resizeSplitPercent(26, 'ArrowLeft')).toBe(25)
    expect(resizeSplitPercent(79, 'ArrowRight')).toBe(80)
    expect(resizeSplitPercent(65, 'Home')).toBe(25)
    expect(resizeSplitPercent(65, 'End')).toBe(80)
    expect(resizeSplitPercent(65, 'ArrowUp')).toBeNull()
  })
})
