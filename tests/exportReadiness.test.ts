import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelAreaConfig, LabelLayer } from '../src/label/types'
import { useLabelStore, useModelStore, useUiStore, type BakeResult } from '../src/state/stores'
import { carrierReadinessChecks, designFontReadinessKey } from '../src/label/exportReadiness'

const external = vi.hoisted(() => ({
  canvasToPngBytes: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
  prepareAllAreas: vi.fn(async () => [{ meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', fullRange: false }]),
  exportGlb: vi.fn(async () => ({
    ok: true,
    glbBytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    crossCheck: { loaded: true, uvSampleOk: true },
  })),
  downloadBytes: vi.fn(),
}))

vi.mock('../src/glb/textures', () => ({
  canvasToPngBytes: external.canvasToPngBytes,
  packMetalRough: vi.fn(),
  bumpToNormal: vi.fn(),
}))
vi.mock('../src/glb/rebuild', () => ({
  exportGlb: external.exportGlb,
  downloadBytes: external.downloadBytes,
}))
vi.mock('../src/app/areaExporter', () => ({ prepareAllAreas: external.prepareAllAreas }))

import * as actions from '../src/app/actions'

class ControlledFontFace {
  static created: ControlledFontFace[] = []
  static pending = false
  static failingSource = ''
  static releases: Array<() => void> = []

  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: FontFaceDescriptors = {},
  ) {
    ControlledFontFace.created.push(this)
  }

  async load(): Promise<ControlledFontFace> {
    if (ControlledFontFace.pending) {
      await new Promise<void>((resolve) => ControlledFontFace.releases.push(resolve))
    }
    if (ControlledFontFace.failingSource && this.source.includes(ControlledFontFace.failingSource)) {
      throw new Error('font unavailable')
    }
    return this
  }

  static releaseAll(): void {
    const releases = ControlledFontFace.releases.splice(0)
    releases.forEach((release) => release())
  }
}

function textLayer(id: string, fontFamily: string, visible = true): LabelLayer {
  return {
    id,
    kind: 'text',
    text: id,
    fontFamily,
    fontSize: 42,
    fontWeight: 400,
    letterSpacing: 0,
    lineHeight: 1.2,
    color: '#20242c',
    align: 'left',
    italic: false,
    x: 120,
    y: 100,
    rotation: 0,
    opacity: 1,
    visible,
    locked: false,
    zIndex: 0,
    craft: [],
  }
}

function area(layers: LabelLayer[], fonts: LabelAreaConfig['fonts'] = []): LabelAreaConfig {
  return {
    id: 'area-a',
    name: 'Front label',
    meshIndex: 0,
    nodeName: 'Bottle',
    surfaceMode: 'overlay',
    remap: {
      mode: 'cylindrical',
      axis: [0, 1, 0],
      origin: [0, 0, 0],
      radius: 1,
      wrap: 1,
      offset: 0,
      planarBox: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    range: { uStart: 0, uWidth: 0.8, vStart: 0.1, vHeight: 0.7 },
    canvas: { width: 640, height: 320, aspect: 2 },
    paper: { enabled: false, color: '#f4efe2', opacity: 1 },
    layers,
    globalCraft: { craft: [] },
    fonts,
    referenceVisible: false,
    undoStack: [],
    redoStack: [],
  }
}

function namedArea(
  id: string,
  name: string,
  layers: LabelLayer[],
  fonts: LabelAreaConfig['fonts'] = [],
): LabelAreaConfig {
  return { ...area(layers, fonts), id, name, nodeName: name }
}

function canvas(name: string): HTMLCanvasElement {
  return { width: 640, height: 320, dataset: { name } } as unknown as HTMLCanvasElement
}

function bake(name: string, version: number): BakeResult {
  return {
    color: canvas(`${name}-color`),
    metalness: canvas(`${name}-metalness`),
    roughness: canvas(`${name}-roughness`),
    bump: canvas(`${name}-bump`),
    spec: { width: 640, height: 320, aspect: 2 },
    version,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

type RegisterExportBakeSurface = (
  areaId: string,
  requestBake: () => boolean,
) => () => void

function registerFreshBake(name = 'fresh', version = 2): () => void {
  const register = (actions as typeof actions & {
    registerExportBakeSurface?: RegisterExportBakeSurface
  }).registerExportBakeSurface
  return register?.('area-a', () => {
    useLabelStore.getState().setBake('area-a', bake(name, version))
    return true
  }) ?? (() => undefined)
}

function registerAreaBake(areaId: string, name: string, version: number): () => void {
  const register = (actions as typeof actions & {
    registerExportBakeSurface?: RegisterExportBakeSurface
  }).registerExportBakeSurface
  return register?.(areaId, () => {
    useLabelStore.getState().setBake(areaId, bake(name, version))
    return true
  }) ?? (() => undefined)
}

function installSecondArea(
  layers: LabelLayer[],
  existingBake: BakeResult | null,
  fonts: LabelAreaConfig['fonts'] = [],
): LabelAreaConfig {
  useLabelStore.getState().addArea(namedArea('area-b', 'Back label', layers, fonts))
  useLabelStore.getState().setBake('area-b', existingBake)
  useLabelStore.getState().activateArea('area-a')
  return useLabelStore.getState().areas.find((candidate) => candidate.id === 'area-b')!
}

function installArea(layers: LabelLayer[], fonts: LabelAreaConfig['fonts'] = []): void {
  useLabelStore.getState().addArea(area(layers, fonts))
  useLabelStore.getState().setBake('area-a', bake('stale', 1))
}

describe('carrier export readiness', () => {
  it('exposes only declared-process checks for foil-or-ink-only output', () => {
    const source = {
      ...area([{ ...textLayer('foil', 'system-sans'), processes: [{ process: 'hot_stamp_foil' as const, spotName: 'COPPER' }] }]),
      carrier: 'foil_or_ink_only' as const,
    }

    expect(carrierReadinessChecks(source).map((check) => check.code)).toEqual([
      'registration', 'declared-process',
    ])
  })
})

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  useLabelStore.setState(useLabelStore.getInitialState(), true)
  useModelStore.setState(useModelStore.getInitialState(), true)
  useUiStore.setState(useUiStore.getInitialState(), true)
  external.canvasToPngBytes.mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]))
  external.prepareAllAreas.mockReset().mockResolvedValue([{ meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', fullRange: false }])
  external.exportGlb.mockReset().mockResolvedValue({
    ok: true,
    glbBytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    crossCheck: { loaded: true, uvSampleOk: true },
  })
  external.downloadBytes.mockReset()
  ControlledFontFace.created = []
  ControlledFontFace.pending = false
  ControlledFontFace.failingSource = ''
  ControlledFontFace.releases = []
  vi.stubGlobal('FontFace', ControlledFontFace)
  vi.stubGlobal('document', { fonts: { add: vi.fn(), ready: Promise.resolve() } })
  vi.stubGlobal('window', {})
})

afterEach(() => {
  ControlledFontFace.releaseAll()
  vi.unstubAllGlobals()
})

describe('export font and bake readiness', () => {
  it('does not begin PNG encoding until a used catalog font settles, then reads the forced fresh bake', async () => {
    ControlledFontFace.pending = true
    installArea([textLayer('brand', 'inter')])
    const unregister = registerFreshBake('fresh', 2)

    const exporting = actions.exportPng()
    await settleAsyncWork()

    expect(ControlledFontFace.created).toHaveLength(1)
    expect(external.canvasToPngBytes).not.toHaveBeenCalled()

    ControlledFontFace.releaseAll()
    await exporting

    expect(external.canvasToPngBytes).toHaveBeenCalledWith(expect.objectContaining({ dataset: { name: 'fresh-color' } }))
    expect(useLabelStore.getState().bakeMap['area-a'].version).toBe(2)
    unregister()
  })

  it('allows a mounted active canvas to create the first PNG bake from version zero', async () => {
    installArea([textLayer('body', 'system-sans')])
    useLabelStore.getState().setBake('area-a', null)
    const unregister = registerFreshBake('first', 1)

    await actions.exportPng()

    expect(external.canvasToPngBytes).toHaveBeenCalledWith(expect.objectContaining({ dataset: { name: 'first-color' } }))
    expect(external.downloadBytes).toHaveBeenCalledOnce()
    unregister()
  })

  it('blocks export when the current bake reports clipped approved copy', async () => {
    installArea([textLayer('body', 'system-sans')])
    const register = (actions as typeof actions & { registerExportBakeSurface?: RegisterExportBakeSurface }).registerExportBakeSurface
    const unregister = register?.('area-a', () => {
      useLabelStore.getState().setBake('area-a', {
        ...bake('overflow', 2),
        textOverflowLayerIds: ['body'],
      })
      return true
    }) ?? (() => undefined)

    await actions.exportPng()

    expect(external.canvasToPngBytes).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({
      msg: '贴标区域「Front label」有 1 个文本图层溢出，未完整渲染获批文案',
      kind: 'error',
    })
    unregister()
  })

  it('blocks PNG encoding with the exact unavailable used-font display names', async () => {
    ControlledFontFace.failingSource = '/fonts/playfair-display/'
    installArea([
      textLayer('title', 'playfair-display'),
      textLayer('legacy', 'Missing Legacy Face'),
    ])
    const unregister = registerFreshBake()

    await actions.exportPng()

    expect(external.canvasToPngBytes).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({
      msg: '字体尚未就绪：Playfair Display、Missing Legacy Face',
      kind: 'error',
    })
    unregister()
  })

  it('loads only visible used faces and never lets hidden or unused uploaded fonts block PNG export', async () => {
    ControlledFontFace.failingSource = 'QkFE'
    installArea(
      [textLayer('body', 'outfit'), textLayer('hidden-title', 'lora', false)],
      [{ name: 'Unused Bad Upload', dataUrl: 'data:font/woff2;base64,QkFE' }],
    )
    const unregister = registerFreshBake()

    await actions.exportPng()

    expect(ControlledFontFace.created.map((face) => face.source)).toEqual([
      'url("/fonts/outfit/400-normal.woff2")',
    ])
    expect(external.canvasToPngBytes).toHaveBeenCalledOnce()
    unregister()
  })

  it('does not begin GLB area preparation while a used font is pending', async () => {
    ControlledFontFace.pending = true
    installArea([textLayer('body', 'roboto')])
    useModelStore.setState({
      glbBytes: new Uint8Array([1, 2, 3]),
      modelName: 'serum.glb',
      status: 'ready',
    })
    const unregister = registerFreshBake()

    const exporting = actions.exportGlbFile()
    await settleAsyncWork()

    expect(ControlledFontFace.created).toHaveLength(1)
    expect(external.prepareAllAreas).not.toHaveBeenCalled()

    ControlledFontFace.releaseAll()
    await exporting

    expect(external.prepareAllAreas).toHaveBeenCalledOnce()
    expect(external.exportGlb).toHaveBeenCalledOnce()
    unregister()
  })

  it('allows a mounted active canvas to create the first GLB bake from version zero', async () => {
    installArea([textLayer('body', 'system-sans')])
    useLabelStore.getState().setBake('area-a', null)
    useModelStore.setState({ glbBytes: new Uint8Array([1, 2, 3]), modelName: 'serum.glb', status: 'ready' })
    const unregister = registerFreshBake('first-glb', 1)

    await actions.exportGlbFile()

    expect(external.prepareAllAreas).toHaveBeenCalledOnce()
    expect(external.downloadBytes).toHaveBeenCalledOnce()
    unregister()
  })

  it('waits for a non-active used font, then rejects its uncertified stale fallback bake by area name', async () => {
    ControlledFontFace.pending = true
    installArea([textLayer('front', 'system-sans')])
    installSecondArea([textLayer('back', 'lora')], bake('fallback', 4))
    useModelStore.setState({ glbBytes: new Uint8Array([1, 2, 3]), modelName: 'serum.glb', status: 'ready' })
    const unregister = registerFreshBake('front-fresh', 2)

    const exporting = actions.exportGlbFile()
    await settleAsyncWork()
    expect(external.prepareAllAreas).not.toHaveBeenCalled()

    ControlledFontFace.releaseAll()
    await exporting

    expect(external.prepareAllAreas).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({
      msg: '贴标区域「Back label」尚未完成当前设计与字体的烘焙：请打开该区域并在 2D 设计或 2D + 3D 视图中刷新后重试',
      kind: 'error',
    })
    unregister()
  })

  it('never silently omits a non-active area whose bake is missing', async () => {
    installArea([textLayer('front', 'system-sans')])
    installSecondArea([textLayer('back', 'system-sans')], null)
    useModelStore.setState({ glbBytes: new Uint8Array([1, 2, 3]), modelName: 'serum.glb', status: 'ready' })
    const unregister = registerFreshBake('front-fresh', 2)

    await actions.exportGlbFile()

    expect(external.prepareAllAreas).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast?.msg).toContain('Back label')
    unregister()
  })

  it('blocks GLB preparation when a used font is unavailable', async () => {
    ControlledFontFace.failingSource = '/fonts/oswald/'
    installArea([textLayer('body', 'oswald')])
    useModelStore.setState({
      glbBytes: new Uint8Array([1, 2, 3]),
      modelName: 'serum.glb',
      status: 'ready',
    })
    const unregister = registerFreshBake()

    await actions.exportGlbFile()

    expect(external.prepareAllAreas).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({ msg: '字体尚未就绪：Oswald', kind: 'error' })
    unregister()
  })

  it('aborts instead of combining a pre-wait design snapshot with a bake from a changed design', async () => {
    ControlledFontFace.pending = true
    installArea([textLayer('body', 'montserrat')])
    const unregister = registerFreshBake()

    const exporting = actions.exportPng()
    await settleAsyncWork()
    useLabelStore.getState().applyAreaOp('area-a', (current) => ({
      ...current,
      layers: current.layers.map((layer) => layer.kind === 'text' ? { ...layer, text: 'Changed while waiting' } : layer),
    }))
    ControlledFontFace.releaseAll()
    await exporting

    expect(external.canvasToPngBytes).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({
      msg: '设计已在导出准备期间更改，请重试',
      kind: 'error',
    })
    unregister()
  })

  it('aborts when a design mutates during asynchronous GLB area preparation', async () => {
    installArea([textLayer('body', 'system-sans')])
    useModelStore.setState({ glbBytes: new Uint8Array([1, 2, 3]), modelName: 'serum.glb', status: 'ready' })
    const entered = deferred<void>()
    const release = deferred<void>()
    external.prepareAllAreas.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return [{ meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', fullRange: false }]
    })
    const unregister = registerFreshBake('front-fresh', 2)

    const exporting = actions.exportGlbFile()
    await entered.promise
    useLabelStore.getState().applyAreaOp('area-a', (current) => ({ ...current, name: 'Changed during prepare' }))
    release.resolve(undefined)
    await exporting

    expect(external.exportGlb).not.toHaveBeenCalled()
    expect(external.downloadBytes).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({ msg: '设计已在导出准备期间更改，请重试', kind: 'error' })
    unregister()
  })

  it('aborts when a design mutates while the GLB worker is exporting', async () => {
    installArea([textLayer('body', 'system-sans')])
    useModelStore.setState({ glbBytes: new Uint8Array([1, 2, 3]), modelName: 'serum.glb', status: 'ready' })
    const entered = deferred<void>()
    const release = deferred<void>()
    external.exportGlb.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return {
        ok: true,
        glbBytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
        crossCheck: { loaded: true, uvSampleOk: true },
      }
    })
    const unregister = registerFreshBake('front-fresh', 2)

    const exporting = actions.exportGlbFile()
    await entered.promise
    useLabelStore.getState().applyAreaOp('area-a', (current) => ({ ...current, name: 'Changed during worker' }))
    release.resolve(undefined)
    await exporting

    expect(external.downloadBytes).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({ msg: '设计已在导出准备期间更改，请重试', kind: 'error' })
    unregister()
  })

  it('aborts when the loaded model identity changes during GLB preparation', async () => {
    installArea([textLayer('body', 'system-sans')])
    useModelStore.setState({ glbBytes: new Uint8Array([1, 2, 3]), modelName: 'serum.glb', status: 'ready' })
    const entered = deferred<void>()
    const release = deferred<void>()
    external.prepareAllAreas.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return [{ meshIndex: 0, nodeName: 'Bottle', surfaceMode: 'overlay', fullRange: false }]
    })
    const unregister = registerFreshBake('front-fresh', 2)

    const exporting = actions.exportGlbFile()
    await entered.promise
    useModelStore.setState({ glbBytes: new Uint8Array([9, 9, 9]), modelName: 'replacement.glb', status: 'ready' })
    release.resolve(undefined)
    await exporting

    expect(external.exportGlb).not.toHaveBeenCalled()
    expect(external.downloadBytes).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({ msg: '模型已在导出准备期间更改，请重试', kind: 'error' })
    unregister()
  })

  it('rejects a successful live-surface request that does not advance the bake version', async () => {
    installArea([textLayer('body', 'system-sans')])
    const register = (actions as typeof actions & { registerExportBakeSurface: RegisterExportBakeSurface }).registerExportBakeSurface
    const unregister = register('area-a', () => true)

    await actions.exportPng()

    expect(external.canvasToPngBytes).not.toHaveBeenCalled()
    expect(useUiStore.getState().toast).toEqual({ msg: '贴标区域「Front label」未完成最新烘焙，请重试', kind: 'error' })
    unregister()
  })

  it('exports the latest ownership-checked bake after the 2D canvas flushes and unmounts for pure 3D', async () => {
    installArea([textLayer('body', 'system-sans')])
    const owner = useLabelStore.getState().activeArea!
    useLabelStore.getState().setBake(owner.id, {
      ...bake('flushed', 2),
      areaOwner: owner,
      fontReadinessKey: designFontReadinessKey(owner),
    })

    await actions.exportPng()

    expect(external.canvasToPngBytes).toHaveBeenCalledWith(expect.objectContaining({ dataset: { name: 'flushed-color' } }))
    expect(external.downloadBytes).toHaveBeenCalledOnce()
    expect(useUiStore.getState().toast).toEqual({ msg: '已导出 color 通道 640×320px', kind: 'success' })
  })

  it('does not let an unregistered stale surface remove the current registered owner', async () => {
    installArea([textLayer('body', 'system-sans')])
    const first = registerAreaBake('area-a', 'first-owner', 2)
    const second = registerAreaBake('area-a', 'current-owner', 3)
    first()

    await actions.exportPng()

    expect(external.canvasToPngBytes).toHaveBeenCalledWith(expect.objectContaining({ dataset: { name: 'current-owner-color' } }))
    second()
  })
})
