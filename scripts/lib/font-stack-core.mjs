const GENERIC_FAMILIES = new Set(['serif','sans-serif','monospace','cursive','fantasy','system-ui','ui-serif','ui-sans-serif','ui-monospace','ui-rounded','math','fangsong','emoji'])
export function validatePortableFontStack(stack) {
  return Array.isArray(stack) && stack.length > 0 && stack.length <= 16
    && stack.every((family) => typeof family === 'string' && family.length > 0 && family.length <= 128 && /^[\p{L}\p{N} ._-]+$/u.test(family))
}
export function portableFontStackCss(stack) {
  if (!validatePortableFontStack(stack)) throw new Error('Invalid font stack')
  return stack.map((family) => GENERIC_FAMILIES.has(family.toLowerCase()) ? family.toLowerCase() : `"${family}"`).join(',')
}
