import { describe, expect, it } from 'vitest'
import { resolveWritingDirection } from '../src/label/textDirection'

describe('portable writing direction', () => {
  it.each([
    ['ABC مرحبا', 'auto', 'rtl'],
    ['ABC مرحبا', 'ltr', 'ltr'],
    ['مرحبا ABC', 'rtl', 'rtl'],
    ['ABC 123', 'auto', 'ltr'],
  ] as const)('resolves %j with %s exactly like the editor', (text, declared, expected) => {
    expect(resolveWritingDirection(text, declared)).toBe(expected)
  })
})
