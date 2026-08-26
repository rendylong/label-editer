export function resolvePortableLayerTransform(input) {
  const anchor = input.anchor ?? 'center'
  const baselineFromTop = input.baselineFromTop ?? input.height / 2
  const box = {
    x: anchor === 'top_left' || anchor === 'baseline_left' ? 0 : -input.width / 2,
    y: anchor === 'top_left' || anchor === 'top_center' ? 0 : anchor === 'center' ? -input.height / 2 : -baselineFromTop,
    width: input.width,
    height: input.height,
  }
  const radians = input.rotation * Math.PI / 180
  const cosine = Math.cos(radians); const sine = Math.sin(radians)
  const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]]
    .map(([x, y]) => ({ x: input.x + x * cosine - y * sine, y: input.y + x * sine + y * cosine }))
  const xs = corners.map(({ x }) => x); const ys = corners.map(({ y }) => y)
  return { origin: { x: input.x, y: input.y }, rotation: input.rotation, box, worldBounds: {
    x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
  } }
}

export function fallbackTextBaselineFromTop(fontSize, lineHeight) {
  return (fontSize * lineHeight - fontSize) / 2 + fontSize * 0.8
}
