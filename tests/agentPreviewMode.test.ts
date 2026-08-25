import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isAgentPreviewUrl } from '../src/agent/previewMode'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'
import { AgentPreviewShell } from '../src/ui/AgentPreviewShell'
import type { LabelAreaConfig } from '../src/label/types'

function area(id: string, name: string): LabelAreaConfig {
  return {
    id,
    name,
    meshIndex: 0,
    nodeName: 'Bottle',
    surfaceMode: 'overlay',
    side: 'front',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0.2, uWidth: 0.3, vStart: 0.1, vHeight: 0.6 },
    canvas: { width: 1024, height: 2048, aspect: 0.5 },
    layers: [{
      id: `${id}-copy`, kind: 'text', text: 'Read only', fontFamily: 'system-sans', fontSize: 64,
      fontWeight: 400, letterSpacing: 0, lineHeight: 1.2, color: '#111111', align: 'center', italic: false,
      x: 0.5, y: 0.5, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [],
    }],
    globalCraft: { craft: [] }, fonts: [], referenceVisible: false, undoStack: [], redoStack: [],
  }
}

describe('Agent live preview mode', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState(useModelStore.getInitialState(), true)
  })

  it('enables only for an explicit query value', () => {
    expect(isAgentPreviewUrl('http://127.0.0.1/editor/?agent-preview=1')).toBe(true)
    expect(isAgentPreviewUrl('http://127.0.0.1/editor/?agent-preview=0')).toBe(false)
    expect(isAgentPreviewUrl('http://127.0.0.1/editor/')).toBe(false)
  })

  it('renders revision, error recovery status, view switching, and read-only inspection only', async () => {
    useLabelStore.getState().addArea(area('front', '正标'))
    useLabelStore.getState().addArea(area('back', '背标'))
    useModelStore.setState({ modelName: 'perfume.glb' })
    useUiStore.getState().setAgentPreviewStatus({
      revision: `sha256:${'b'.repeat(64)}`,
      state: 'error',
      message: 'Waiting for valid JSON',
    })

    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://127.0.0.1/' })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Node', dom.window.Node)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    const root = createRoot(dom.window.document.querySelector('#root')!)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    await act(async () => root.render(createElement(AgentPreviewShell, {
      editorViewMode: 'split',
      workspace: createElement('div', { 'data-testid': 'live-viewport' }),
    })))
    const document = dom.window.document

    expect(document.body.textContent).toContain('Agent 实时预览 · 只读')
    expect(document.body.textContent).toContain('bbbbbbbbbbbb')
    expect(document.body.textContent).toContain('Waiting for valid JSON')
    expect(document.querySelector('[data-testid="live-viewport"]')).not.toBeNull()
    expect(document.querySelectorAll('[aria-label="预览区域"] button')).toHaveLength(2)
    expect(document.querySelector('[aria-label="只读检查器"]')).not.toBeNull()
    expect(document.querySelector('.view-mode-switch')).not.toBeNull()
    expect(document.querySelector('.agent-preview-inspector-scroll')).not.toBeNull()

    const text = document.body.textContent ?? ''
    for (const mutation of ['导入', '导出', '保存', '撤销', '重做', '删除', '添加']) {
      expect(text).not.toContain(mutation)
    }
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  })

  it('switches area selection together with its matching geometry runtime', () => {
    useLabelStore.getState().addArea(area('front', '正标'))
    useLabelStore.getState().addArea(area('back', '背标'))
    expect(useLabelStore.getState().activeAreaId).toBe('back')
    const previousRuntime = { remapOutput: { owner: 'back' } as never, meshAccessors: { owner: 'back' } as never }
    const nextRuntime = { remapOutput: { owner: 'front' } as never, meshAccessors: { owner: 'front' } as never }
    useLabelStore.getState().setAreaData(previousRuntime.remapOutput, previousRuntime.meshAccessors)

    useLabelStore.getState().activateAreaWithRuntime('front', nextRuntime)

    expect(useLabelStore.getState().activeAreaId).toBe('front')
    expect(useLabelStore.getState().remapOutput).toBe(nextRuntime.remapOutput)
    expect(useLabelStore.getState().meshAccessors).toBe(nextRuntime.meshAccessors)
    expect(useLabelStore.getState().areas).toHaveLength(2)
  })
})
