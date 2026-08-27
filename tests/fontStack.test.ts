import { describe, expect, it } from 'vitest'
import { canonicalFontStack, fontStackCss, validateFontStack } from '../src/label/fontStack'

describe('portable font-stack whitespace boundary', () => {
  it.each([
    [['   '], 'ASCII spaces'],
    [['\t'], 'tab'],
    [['\u00a0'], 'non-breaking space'],
    [['Arial', '   '], 'mixed valid and blank'],
  ] as const)('rejects %s before canonicalization can produce an empty family (%s)', (stack, _label) => {
    expect(validateFontStack(stack)).toBe(false)
    expect(() => canonicalFontStack(stack)).toThrow(/fontStack/i)
    expect(() => fontStackCss(stack)).toThrow(/fontStack/i)
  })

  it('trims and canonicalizes a valid padded stack without dropping any family', () => {
    const source = ['  Arial  ', ' sans-serif ']

    expect(validateFontStack(source)).toBe(true)
    expect(canonicalFontStack(source)).toEqual(['arial', 'sans-serif'])
    expect(fontStackCss(source)).toBe('"Arial",sans-serif')
    expect(source).toEqual(['  Arial  ', ' sans-serif '])
  })
})
