export function resolvePortableTextLayoutMetric(input) {
  const width = Number(input.width); const fontSize = Number(input.fontSize); const lineHeightRatio = Number(input.lineHeight)
  const totalLineCount = Math.max(1, Math.trunc(input.lineCount))
  const maximumLines = Number.isInteger(input.maxLines) && input.maxLines > 0 ? input.maxLines : totalLineCount
  const lineCount = Math.min(totalLineCount, maximumLines)
  const lineHeight = fontSize * lineHeightRatio
  const ascent = Number.isFinite(input.ascent) ? input.ascent : fontSize * 0.8
  const descent = Number.isFinite(input.descent) ? input.descent : fontSize * 0.2
  if (![width, fontSize, lineHeightRatio, lineHeight, ascent, descent].every(Number.isFinite) || !(width > 0) || !(fontSize > 0) || !(lineHeight > 0)) {
    throw new Error('Invalid text layout metric')
  }
  return Object.freeze({
    width,
    height: Math.max(1, lineHeight * lineCount),
    lineCount,
    totalLineCount,
    baselineFromTop: Math.max(0, (lineHeight - ascent - descent) / 2 + ascent),
  })
}
