/**
 * 字体：系统栈 + 用户上传（FontFace API）。上传字体注册为全局可用（含 Konva/canvas）。
 */

import { FONT_STACKS, type UploadedFontRecord } from './types'
import { fontCssFor, prepareUploadedFontUpload, uploadFamily, uploadedFontId, uploadedFontReceipt } from './fontRuntime'

export interface UploadedFont {
  id: string
  name: string
  css: string
  dataUrl: string
}

/** 上传字体文件：由项目级托管缓存校验并注册唯一 FontFace。 */
export async function uploadFontFile(
  file: File,
  existingFonts: readonly UploadedFontRecord[] = [],
): Promise<UploadedFont> {
  if (!/\.(ttf|otf|woff2)$/i.test(file.name)) throw new Error('仅支持 ttf / otf / woff2 字体')
  if (file.size > 20 * 1024 * 1024) throw new Error('字体文件超过 20MB 上限')
  const dataUrl = await fileToDataUrl(file)
  const name = file.name.replace(/\.(ttf|otf|woff2)$/i, '')
  const id = uploadedFontId(name)
  if (existingFonts.some((font) => uploadedFontId(font.name) === id && font.name !== name)) {
    throw new Error(`Uploaded font runtime identity conflict: ${id}`)
  }
  const family = uploadedFontReceipt({ name, dataUrl }).cssFamily
  const css = `"${family}", sans-serif`
  const loaded = await prepareUploadedFontUpload({ name, dataUrl })
  if (!loaded.ok) throw new Error(loaded.error ?? '字体加载失败')
  return { id, name, css, dataUrl }
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
