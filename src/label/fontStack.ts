import { canonicalPortableFontStack, portableFontStackCss, validatePortableFontStack } from '../../scripts/lib/font-stack-core.mjs'

export const fontStackCss = portableFontStackCss
export const validateFontStack = validatePortableFontStack
export function canonicalFontStack(stack: readonly string[]): string[] { return canonicalPortableFontStack(stack) }
