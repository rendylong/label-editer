/** 将上传图片内联到项目 JSON，避免 blob URL 在刷新/导入后失效。 */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`
}
