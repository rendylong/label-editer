import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizableSplitPane } from '../src/ui/ResizableSplitPane'

function pointerEvent(dom: JSDOM, type: string, pointerId: number, clientX: number): Event {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
  })
  return event
}

describe('resizable 2D/3D split pane', () => {
  let dom: JSDOM
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Node', dom.window.Node)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    root = createRoot(dom.window.document.querySelector('#root')!)
  })

  async function mount(onAncestorPointer?: () => void): Promise<HTMLElement> {
    await act(async () => root.render(createElement(
      'div',
      { onPointerDown: onAncestorPointer, onPointerMove: onAncestorPointer },
      createElement(ResizableSplitPane, {
        primary: createElement('div', { id: 'two-dimensional-content' }, '2D'),
        secondary: createElement('div', { id: 'three-dimensional-content' }, '3D'),
      }),
    )))
    return dom.window.document.querySelector<HTMLElement>('.split-workspace')!
  }

  it('starts at 65/35 with a keyboard-operable vertical separator', async () => {
    await mount()

    const separator = dom.window.document.querySelector<HTMLElement>('[role="separator"]')!
    const controlledIds = separator.getAttribute('aria-controls')!.split(' ')

    expect(separator.tabIndex).toBe(0)
    expect(separator.getAttribute('aria-orientation')).toBe('vertical')
    expect(separator.getAttribute('aria-valuemin')).toBe('25')
    expect(separator.getAttribute('aria-valuemax')).toBe('80')
    expect(separator.getAttribute('aria-valuenow')).toBe('65')
    expect(controlledIds).toHaveLength(2)
    expect(controlledIds.every((id) => dom.window.document.getElementById(id) !== null)).toBe(true)
  })

  it('resizes with the keyboard and clamps both panes to valid widths', async () => {
    await mount()
    const separator = dom.window.document.querySelector<HTMLElement>('[role="separator"]')!

    await act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(separator.getAttribute('aria-valuenow')).toBe('70')

    await act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    await act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(separator.getAttribute('aria-valuenow')).toBe('80')

    await act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    await act(async () => separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(separator.getAttribute('aria-valuenow')).toBe('25')
  })

  it('uses pointer capture without global listeners and stops canvas gesture leakage', async () => {
    let ancestorPointerEvents = 0
    const split = await mount(() => { ancestorPointerEvents += 1 })
    const separator = dom.window.document.querySelector<HTMLElement>('[role="separator"]')!
    split.getBoundingClientRect = () => ({ left: 100, width: 1000, right: 1100, top: 0, bottom: 600, height: 600, x: 100, y: 0, toJSON: () => ({}) })
    const captured = new Set<number>()
    separator.setPointerCapture = (pointerId) => { captured.add(pointerId) }
    separator.hasPointerCapture = (pointerId) => captured.has(pointerId)
    separator.releasePointerCapture = (pointerId) => { captured.delete(pointerId) }
    const windowListener = vi.spyOn(dom.window, 'addEventListener')

    await act(async () => separator.dispatchEvent(pointerEvent(dom, 'pointerdown', 7, 750)))
    expect(dom.window.document.activeElement).toBe(separator)
    await act(async () => separator.dispatchEvent(pointerEvent(dom, 'pointermove', 7, 600)))

    expect(separator.getAttribute('aria-valuenow')).toBe('50')
    expect(captured.has(7)).toBe(true)
    expect(ancestorPointerEvents).toBe(0)
    expect(windowListener).not.toHaveBeenCalled()

    await act(async () => separator.dispatchEvent(pointerEvent(dom, 'pointerup', 7, 600)))
    expect(captured.has(7)).toBe(false)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
