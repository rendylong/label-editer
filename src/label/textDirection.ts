import { resolvePortableTextDirection } from '../../scripts/lib/text-direction-core.mjs'
import type { TextLayer } from './types'

export function resolveWritingDirection(text: string, declared?: TextLayer['writingDirection']): 'ltr' | 'rtl' {
  return resolvePortableTextDirection(declared, text)
}

export function resolvedTextDirection(layer: Pick<TextLayer, 'text' | 'writingDirection'>): 'ltr' | 'rtl' {
  return resolveWritingDirection(layer.text, layer.writingDirection)
}
