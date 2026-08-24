import { createElement } from 'react'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { EditorWorkspace } from '../src/app/App'
import type { EditorViewMode } from '../src/state/stores'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'

function workspaceDocument(editorViewMode: EditorViewMode): Document {
  return new JSDOM(`<!doctype html><body>${renderToStaticMarkup(createElement(EditorWorkspace, { editorViewMode }))}</body>`).window.document
}

describe('rendered central editor modes', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState(useModelStore.getInitialState(), true)
  })

  it('renders only the 2D canvas host in 2D mode', () => {
    const document = workspaceDocument('2d')

    expect(document.querySelector('.center > .canvas-area')).not.toBeNull()
    expect(document.querySelector('.center .viewport-wrap')).toBeNull()
    expect(document.querySelector('.center [role="separator"]')).toBeNull()
  })

  it('renders a 65/35 resizable 2D and marked 3D support workspace in split mode', () => {
    const document = workspaceDocument('split')
    const split = document.querySelector('.center > .split-workspace')

    expect(split).not.toBeNull()
    expect(split?.querySelector('.split-workspace__pane--2d .canvas-area')).not.toBeNull()
    expect(split?.querySelector('.split-workspace__pane--3d .editor-viewport--support')).not.toBeNull()
    expect(split?.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('65')
  })

  it('renders only the formal full 3D viewport in 3D mode', () => {
    const document = workspaceDocument('3d')

    expect(document.querySelector('.center > .editor-viewport--formal')).not.toBeNull()
    expect(document.querySelector('.center .canvas-area')).toBeNull()
    expect(document.querySelector('.center [role="separator"]')).toBeNull()
  })

  it.each(['2d', 'split', '3d'] as const)('keeps the right panel inspector-only in %s mode', (editorViewMode) => {
    const document = workspaceDocument(editorViewMode)
    const rightStack = document.querySelector('.right > .right-stack')

    expect(rightStack).not.toBeNull()
    if (!rightStack) return
    expect(rightStack.children).toHaveLength(1)
    expect(rightStack.querySelector('.inspector-shell')).not.toBeNull()
    expect(rightStack.querySelector('.preview3d, .viewport-wrap')).toBeNull()
  })

  it('places the three-mode control in the toolbar', () => {
    const document = workspaceDocument('2d')

    expect(document.querySelector('.toolbar .view-mode-switch')).not.toBeNull()
  })

  it('keeps panel widths in CSS and wraps the toolbar at the compact desktop breakpoint', () => {
    const document = workspaceDocument('2d')
    const css = readFileSync(new URL('../src/app/styles.css', import.meta.url), 'utf8')

    expect(document.querySelector('.left')?.getAttribute('style')).toBeNull()
    expect(document.querySelector('.right')?.getAttribute('style')).toBeNull()
    expect(css).toMatch(/\.left\s*\{[^}]*width:\s*292px/s)
    expect(css).toMatch(/\.right\s*\{[^}]*width:\s*320px/s)
    expect(css).toMatch(/@media\s*\(max-width:\s*1180px\)[\s\S]*?\.toolbar\s*\{[^}]*flex-wrap:\s*wrap/s)
  })
})
