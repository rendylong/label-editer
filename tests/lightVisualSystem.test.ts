import { readFileSync, readdirSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/app/styles.css', import.meta.url), 'utf8')

function documentWithStyles(): Document {
  return new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`).window.document
}

function styleRules(document: Document): CSSStyleRule[] {
  const flattened: CSSStyleRule[] = []
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if ('style' in rule && 'selectorText' in rule) flattened.push(rule as CSSStyleRule)
      if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules)
  return flattened
}

function tsxFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) return tsxFiles(url)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [url] : []
  })
}

describe('light visual system', () => {
  it('publishes the exact approved semantic color contract at the root', () => {
    const document = documentWithStyles()
    const root = document.defaultView!.getComputedStyle(document.documentElement)
    const expected = {
      '--color-app': '#F4F6F8',
      '--color-panel': '#FFFFFF',
      '--color-canvas': '#EEF1F4',
      '--color-text-primary': '#20242C',
      '--color-text-secondary': '#667085',
      '--color-text-weak': '#98A2B3',
      '--color-border': '#E4E7EC',
      '--color-accent': '#356AE6',
      '--color-accent-hover': '#2859C5',
      '--color-selected': '#EAF1FF',
      '--color-danger': '#D92D20',
      '--color-success': '#178A50',
    }

    for (const [property, value] of Object.entries(expected)) {
      expect(root.getPropertyValue(property).trim().toUpperCase(), property).toBe(value)
    }
  })

  it('routes shell, panel, canvas, selection, and status seams through semantic tokens', () => {
    const rules = styleRules(documentWithStyles())
    const declarations = (selector: string) => rules
      .filter((rule) => rule.selectorText.split(',').some((item) => item.trim() === selector))
      .map((rule) => rule.style.cssText)
      .join(' ')

    expect(declarations('html')).toContain('var(--color-app)')
    expect(declarations('.toolbar')).toContain('var(--color-panel)')
    expect(declarations('.center')).toContain('var(--color-canvas)')
    expect(declarations('.tree-row.selected')).toContain('var(--color-selected)')
    expect(declarations('.viewport-overlay.error')).toContain('var(--color-danger)')
    expect(declarations('.toast.success')).toContain('var(--color-success)')
  })

  it('contains no declared dark legacy palette or non-transform/opacity transitions', () => {
    const rules = styleRules(documentWithStyles())
    const declared = rules.map((rule) => rule.style.cssText.toLowerCase()).join('\n')
    const legacyDarkColors = ['#0f1115', '#161920', '#1e222b', '#232833', '#2c3240', '#171a20', '#252a33']

    for (const color of legacyDarkColors) expect(declared, color).not.toContain(color)
    for (const rule of rules) {
      const transition = rule.style.getPropertyValue('transition')
      if (!transition) continue
      expect(transition, rule.selectorText).not.toMatch(/background|border|color|width|height|top|left/)
      expect(transition, rule.selectorText).toMatch(/transform|opacity/)
    }
  })

  it('provides separated accent focus and zero-duration reduced motion', () => {
    const document = documentWithStyles()
    const rules = styleRules(document)
    const focusRules = rules.filter((rule) => rule.selectorText.includes(':focus-visible'))
    const focusDeclarations = focusRules.map((rule) => rule.style.cssText).join(' ')
    const mediaRules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSMediaRule => rule instanceof document.defaultView!.CSSMediaRule)
    const reducedMotion = mediaRules.find((rule) => rule.conditionText.includes('prefers-reduced-motion'))

    expect(focusDeclarations).toContain('2px solid var(--color-accent)')
    expect(focusDeclarations).toContain('outline-offset: 2px')
    expect(reducedMotion?.cssText).toContain('transition-duration: 0s')
    expect(reducedMotion?.cssText).toContain('animation-duration: 0s')
  })

  it('reserves the weak text token for an exhaustive decorative-only whitelist', () => {
    const rules = styleRules(documentWithStyles())
    const weakConsumers = rules.flatMap((rule) => rule.selectorText.split(',').map((selector) => selector.trim()).flatMap((selector) => (
      Array.from(rule.style)
        .filter((property) => !property.startsWith('--'))
        .filter((property) => rule.style.getPropertyValue(property).includes('var(--text-3)') || rule.style.getPropertyValue(property).includes('var(--color-text-weak)'))
        .map((property) => `${selector}|${property}`)
    ))).sort()

    expect(weakConsumers).toEqual([
      '.font-upload-mark|color',
      '.icon-btn:disabled:hover|color',
      '.inspector-empty-content > svg|color',
      '.inspector-lock-mark|color',
      '.layer-kind-icon|color',
      '.model-tree-row .tree-icon|color',
      '.preset-thumbnail|color',
      '.split-workspace__divider-grip|background',
      '.tree-icon--decorative|color',
    ])
  })

  it('keeps sub-11px visible copy only for the decorative font upload glyph', () => {
    const rules = styleRules(documentWithStyles())
    const smallCopySelectors = rules.flatMap((rule) => {
      const size = Number.parseFloat(rule.style.fontSize)
      if (!Number.isFinite(size) || size > 10) return []
      return rule.selectorText.split(',').map((selector) => selector.trim())
    }).sort()

    expect(smallCopySelectors).toEqual([
      '.font-upload-mark',
    ])
  })

  it('keeps weak inline TSX styling out of the semantic consumer audit', () => {
    const inlineWeakConsumers = tsxFiles(new URL('../src/', import.meta.url)).flatMap((file) => (
      readFileSync(file, 'utf8').split('\n').flatMap((line, index) => (
        line.includes('var(--text-3)') || line.includes('var(--color-text-weak)')
          ? [`${file.pathname}:${index + 1}`]
          : []
      ))
    ))

    expect(inlineWeakConsumers).toEqual([])
  })
})
