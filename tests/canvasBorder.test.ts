import { describe, expect, it, vi } from 'vitest'
import { clearTransparentCanvasBorder } from '../src/label/canvasBorder'

describe('贴标纹理透明安全边框', () => {
  it('清除四条边，避免 ClampToEdge 把贴边图案复制到区域外', () => {
    const clearRect = vi.fn()
    const save = vi.fn()
    const setTransform = vi.fn()
    const restore = vi.fn()
    clearTransparentCanvasBorder({ clearRect, save, setTransform, restore } as unknown as CanvasRenderingContext2D, 2048, 4408, 2)

    expect(save).toHaveBeenCalledOnce()
    expect(setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    expect(clearRect.mock.calls).toEqual([
      [0, 0, 2048, 2],
      [0, 4406, 2048, 2],
      [0, 0, 2, 4408],
      [2046, 0, 2, 4408],
    ])
    expect(restore).toHaveBeenCalledOnce()
  })
})
