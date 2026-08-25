import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLabelStore, useModelStore, useUiStore } from '../src/state/stores'
import type { LabelAreaConfig } from '../src/label/types'

const controlledViewport = vi.hoisted(() => ({
  instances: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  pending: [] as Array<{ promise: Promise<boolean>; resolve: (accepted: boolean) => void }>,
}))

vi.mock('../src/scene/SceneController', () => ({
  SceneController: class ControlledSceneController {
    loadModel = vi.fn()
    dispose = vi.fn()
    applyLabelGeometry = vi.fn()
    setFrontMarker = vi.fn()
    hideFrontMarker = vi.fn()
    applyLabelBake = vi.fn()
    reconcileLabelAreas = vi.fn()
    setChannelView = vi.fn()
    setActiveAreaHighlight = vi.fn()
    requestRender = vi.fn()
    setHidden = vi.fn()
    setOutlineTargets = vi.fn()
    setSelectedMesh = vi.fn()

    constructor() {
      let resolve!: (accepted: boolean) => void
      const promise = new Promise<boolean>((next) => { resolve = next })
      controlledViewport.pending.push({ promise, resolve })
      this.loadModel.mockReturnValue(promise)
      controlledViewport.instances.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>)
    }
  },
}))

import { Viewport } from '../src/scene/Viewport'

function ViewportHarness({ visible }: { visible: boolean }): React.JSX.Element | null {
  return visible ? createElement(Viewport) : null
}

function area(id: string, nodeName: string): LabelAreaConfig {
  return {
    id,
    name: nodeName,
    meshIndex: id === 'area-a' ? 0 : 1,
    nodeName,
    surfaceMode: id === 'area-a' ? 'replace' : 'overlay',
    remap: {
      mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1,
      wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
    canvas: { width: 400, height: 300, aspect: 4 / 3 },
    layers: [], globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
    undoStack: [], redoStack: [],
  }
}

function bake(document: Document) {
  const makeCanvas = (): HTMLCanvasElement => document.createElement('canvas')
  return {
    color: makeCanvas(), metalness: makeCanvas(), roughness: makeCanvas(), bump: makeCanvas(),
    spec: { width: 400, height: 300, aspect: 4 / 3 }, version: 1,
  }
}

describe('Viewport async load continuation boundary', () => {
  let dom: JSDOM
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    controlledViewport.instances.length = 0
    controlledViewport.pending.length = 0
    useUiStore.setState(useUiStore.getInitialState(), true)
    useLabelStore.setState(useLabelStore.getInitialState(), true)
    useModelStore.setState({
      ...useModelStore.getInitialState(),
      status: 'ready',
      modelName: 'controlled.glb',
      glbBytes: new Uint8Array([1, 2, 3]),
    }, true)
    dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Node', dom.window.Node)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    root = createRoot(dom.window.document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  })

  it('blocks a disposed controller continuation while allowing the remounted current controller', async () => {
    await act(async () => root.render(createElement(ViewportHarness, { visible: true })))
    const stale = controlledViewport.instances[0]
    const staleChannelCalls = stale.setChannelView.mock.calls.length
    const staleHighlightCalls = stale.setActiveAreaHighlight.mock.calls.length

    await act(async () => root.render(createElement(ViewportHarness, { visible: false })))
    expect(stale.dispose).toHaveBeenCalledTimes(1)
    await act(async () => root.render(createElement(ViewportHarness, { visible: true })))
    const current = controlledViewport.instances[1]
    const currentChannelCalls = current.setChannelView.mock.calls.length
    const currentHighlightCalls = current.setActiveAreaHighlight.mock.calls.length

    await act(async () => {
      controlledViewport.pending[0].resolve(true)
      await controlledViewport.pending[0].promise
    })
    expect(stale.setChannelView).toHaveBeenCalledTimes(staleChannelCalls)
    expect(stale.setActiveAreaHighlight).toHaveBeenCalledTimes(staleHighlightCalls)

    await act(async () => {
      controlledViewport.pending[1].resolve(true)
      await controlledViewport.pending[1].promise
    })
    expect(current.setChannelView).toHaveBeenCalledTimes(currentChannelCalls + 1)
    expect(current.setActiveAreaHighlight).toHaveBeenCalledTimes(currentHighlightCalls + 1)
  })

  it('reconciles a non-active area deletion without removing the remaining area', async () => {
    const areaA = area('area-a', 'Part A')
    const areaB = area('area-b', 'Part B')
    useLabelStore.setState({
      ...useLabelStore.getInitialState(),
      areas: [areaA, areaB],
      activeAreaId: areaB.id,
      activeArea: areaB,
      meshIndex: areaB.meshIndex,
      nodeName: areaB.nodeName,
      bakeMap: { [areaA.id]: bake(dom.window.document), [areaB.id]: bake(dom.window.document) },
    }, true)
    await act(async () => root.render(createElement(ViewportHarness, { visible: true })))
    const controller = controlledViewport.instances[0]

    await act(async () => useLabelStore.getState().removeArea(areaA.id))

    expect(controller.reconcileLabelAreas.mock.calls.at(-1)?.[0]).toEqual([areaB.id])
    expect(useLabelStore.getState().areas.map((item) => item.id)).toEqual([areaB.id])
    expect(useLabelStore.getState().bakeMap[areaA.id]).toBeUndefined()
    expect(useLabelStore.getState().bakeMap[areaB.id]).toBeDefined()
  })
})
