/** 清除烘焙纹理边缘，避免 ClampToEdge 把贴边像素复制到贴标区域之外。 */
export function clearTransparentCanvasBorder(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  border = 2,
): void {
  const size = Math.max(1, Math.min(Math.floor(border), Math.floor(width / 2), Math.floor(height / 2)))
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, width, size)
  context.clearRect(0, height - size, width, size)
  context.clearRect(0, 0, size, height)
  context.clearRect(width - size, 0, size, height)
  context.restore()
}
