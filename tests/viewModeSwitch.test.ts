import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from '../src/state/stores'
import { nextEditorViewMode, ViewModeSwitch } from '../src/ui/ViewModeSwitch'

function documentForSwitch(): Document {
  return new JSDOM(`<!doctype html><body>${renderToStaticMarkup(createElement(ViewModeSwitch))}</body>`).window.document
}

describe('central view mode switch', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
  })

  it.each([
    ['2d', 'ArrowRight', 'split'],
    ['split', 'ArrowRight', '3d'],
    ['3d', 'ArrowRight', '2d'],
    ['2d', 'ArrowLeft', '3d'],
    ['3d', 'ArrowLeft', 'split'],
    ['split', 'Home', '2d'],
    ['2d', 'End', '3d'],
  ] as const)('moves from %s with %s to %s', (current, key, expected) => {
    expect(nextEditorViewMode(current, key)).toBe(expected)
  })

  it('ignores keys outside the horizontal navigation contract', () => {
    expect(nextEditorViewMode('split', 'ArrowDown')).toBeNull()
    expect(nextEditorViewMode('split', 'Enter')).toBeNull()
  })

  it('renders the exact three labels as pressed buttons with one roving tab stop', () => {
    const document = documentForSwitch()
    const group = document.querySelector('[role="group"][aria-label="中央视图"]')
    const buttons = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])]

    expect(buttons.map((button) => button.textContent)).toEqual(['2D 设计', '2D + 3D', '3D 预览'])
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1])
  })

  it('uses ArrowLeft and ArrowRight to update the mode and move focus', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Node', dom.window.Node)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const root = createRoot(dom.window.document.querySelector('#root')!)

    try {
      await act(async () => root.render(createElement(ViewModeSwitch)))
      const first = dom.window.document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!
      expect(first).not.toBeNull()
      if (!first) return
      first.focus()

      await act(async () => {
        first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      })

      const split = dom.window.document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!
      expect(useUiStore.getState().editorViewMode).toBe('split')
      expect(split.textContent).toBe('2D + 3D')
      expect(split.tabIndex).toBe(0)
      expect(first.tabIndex).toBe(-1)
      expect(dom.window.document.activeElement).toBe(split)

      await act(async () => {
        split.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      })

      const twoDimensional = dom.window.document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!
      expect(useUiStore.getState().editorViewMode).toBe('2d')
      expect(dom.window.document.activeElement).toBe(twoDimensional)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })
})
