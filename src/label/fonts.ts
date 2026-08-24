/**
 * 字体：系统栈 + 用户上传（FontFace API）。上传字体注册为全局可用（含 Konva/canvas）。
 */

import { FONT_STACKS, type UploadedFontRecord } from './types'
import { fontCssFor, uploadFamily, uploadedFontId } from './fontRuntime'

export interface UploadedFont {
  id: string
  name: string
  css: string
  dataUrl: string
}

/** 上传字体文件：校验 + 注册 FontFace + 返回记录。 */
export async function uploadFontFile(file: File): Promise<UploadedFont> {
  if (!/\.(ttf|otf|woff2)$/i.test(file.name)) throw new Error('仅支持 ttf / otf / woff2 字体')
  if (file.size > 20 * 1024 * 1024) throw new Error('字体文件超过 20MB 上限')
  const dataUrl = await fileToDataUrl(file)
  const name = file.name.replace(/\.(ttf|otf|woff2)$/i, '')
  const family = uploadFamily(name)
  const css = `"${family}", sans-serif`
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    throw new Error('当前环境不支持字体加载')
  }
  const ff = new FontFace(family, `url("${dataUrl}")`)
  const loaded = await ff.load()
  document.fonts.add(loaded)
  await document.fonts.ready
  return { id: uploadedFontId(name), name, css, dataUrl }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

export { FONT_STACKS }
export { fontCssFor, uploadFamily, uploadedFontId }
export type { UploadedFontRecord }
