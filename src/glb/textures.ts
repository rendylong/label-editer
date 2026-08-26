/**
 * 纹理编码工具：canvas → PNG 字节；金属/粗糙度打包（G=roughness, B=metalness）；
 * bump 高度 → 法线贴图（Sobel）。
 */

/** PNG 颜色贴图保留透明背景，GLB 材质必须使用 alpha 混合。 */
export function configureTransparentLabelExport(material: { setAlphaMode(mode: 'BLEND'): unknown }): void {
  material.setAlphaMode('BLEND')
}

export function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((res, rej) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        rej(new Error('PNG 编码失败'))
        return
      }
      try {
        void blob.arrayBuffer().then((buffer) => {
          const bytes = new Uint8Array(buffer)
          const signature = [137, 80, 78, 71, 13, 10, 26, 10]
          if (bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value)) {
            rej(new Error('PNG 编码返回了无效数据'))
            return
          }
          res(bytes)
        }, rej)
      } catch (error) {
        rej(error)
      }
    }, 'image/png')
  })
}

/** 将 metalness（白=金属）与 roughness（黑=光滑）打包进一张 metallicRoughness 纹理。 */
export function packMetalRough(metalness: HTMLCanvasElement, roughness: HTMLCanvasElement): HTMLCanvasElement {
  const w = metalness.width
  const h = metalness.height
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')!
  octx.fillStyle = '#000000'
  octx.fillRect(0, 0, w, h)
  const om = octx.getImageData(0, 0, w, h)
  const mctx = metalness.getContext('2d')!
  const rctx = roughness.getContext('2d')!
  const md = mctx.getImageData(0, 0, w, h).data
  const rd = rctx.getImageData(0, 0, w, h).data
  for (let i = 0; i < om.data.length; i += 4) {
    om.data[i] = 0 // R unused
    om.data[i + 1] = rd[i] // G = roughness
    om.data[i + 2] = md[i] // B = metalness
    om.data[i + 3] = 255
  }
  octx.putImageData(om, 0, 0)
  return out
}

/** bump 高度（0.5=平面）→ 法线贴图（Sobel 梯度）。 */
export function bumpToNormal(bump: HTMLCanvasElement, strength = 2): HTMLCanvasElement {
  const w = bump.width
  const h = bump.height
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')!
  const src = bump.getContext('2d')!.getImageData(0, 0, w, h).data
  const o = octx.createImageData(w, h)
  const d = o.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      const x0 = Math.max(0, x - 1)
      const x1 = Math.min(w - 1, x + 1)
      const y0 = Math.max(0, y - 1)
      const y1 = Math.min(h - 1, y + 1)
      const hL = src[(y * w + x0) * 4] / 255
      const hR = src[(y * w + x1) * 4] / 255
      const hU = src[(y0 * w + x) * 4] / 255
      const hD = src[(y1 * w + x) * 4] / 255
      let nx = (hL - hR) * strength
      let ny = (hU - hD) * strength
      const nz = 1
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
      nx /= len
      ny /= len
      d[idx] = Math.round((nx * 0.5 + 0.5) * 255)
      d[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      d[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      d[idx + 3] = 255
    }
  }
  octx.putImageData(o, 0, 0)
  return out
}
