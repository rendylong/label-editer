import { describe, expect, it } from 'vitest'
import { bytesToDataUrl } from '../src/label/imageSource'

describe('项目图片持久化', () => {
  it('把上传图片字节保存为可序列化 data URL，而不是会失效的 blob URL', () => {
    const url = bytesToDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')

    expect(url).toBe('data:image/png;base64,iVBORw==')
    expect(url.startsWith('blob:')).toBe(false)
  })
})
