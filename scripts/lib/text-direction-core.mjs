export function resolvePortableTextDirection(writingDirection, text) {
  if (writingDirection === 'rtl') return 'rtl'
  if (writingDirection === 'ltr') return 'ltr'
  return /[\u0590-\u08ff]/u.test(text) ? 'rtl' : 'ltr'
}
