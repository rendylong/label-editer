import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react'
import type { ImageLayer, LabelAreaConfig, LabelLayer, ShapeLayer } from '../label/types'
import { CRAFT_LABELS } from '../label/types'
import { bytesToDataUrl } from '../label/imageSource'
import { MAX_EMBEDDED_ASSET_BYTES } from '../label/boundedAssetBytes'
import { imageResourceBudgetIssue, MAX_IMAGE_PIXELS_PER_LAYER } from '../label/imageResourceLimits'
import { inspectBoundedImageBytes } from '../label/imageAssetReceipt'
import { moveUnlockedLayer, removeUnlockedLayer, reorderUnlockedLayer, type LayerDropPlacement } from '../label/layerMutations'
import { canonicalLayerOrderDescending } from '../label/layerOrder'
import { nextLayerSelection } from '../label/selection'
import { flashToast, useLabelStore, useUiStore } from '../state/stores'
import { ElementLibrary } from './ElementLibrary'
import { Icon } from './icons'
import { deleteSelectedLayers, duplicateSelectedLayers, getAreaDeleteIntent } from './sidebarActions'

const SHAPE_NAMES: Record<ShapeLayer['shape'], string> = {
  rectangle: '矩形',
  ellipse: '椭圆',
  triangle: '三角形',
  diamond: '菱形',
  polygon: '多边形',
  star: '星形',
  line: '线条',
  wave: '曲线',
  burst: '放射形',
  cross: '十字',
  bracket: '括号',
  'dot-grid': '圆点阵列',
  frame: '边框',
  path: '路径',
}

function layerMeta(layer: LabelLayer): { type: string; name: string; icon: React.JSX.Element } {
  if (layer.kind === 'text') return { type: '文字', name: layer.text.trim().slice(0, 18) || '空文字', icon: Icon.text(13) }
  if (layer.kind === 'image') return { type: '图片', name: `${Math.round(layer.width)} × ${Math.round(layer.height)}`, icon: Icon.image(13) }
  return { type: '形状', name: SHAPE_NAMES[layer.shape], icon: Icon.shape(13) }
}

interface LayerListProps {
  layers: LabelLayer[]
  selectedLayerIds: string[]
  onSelect: (id: string, additive: boolean) => void
  onPatchState: (id: string, patch: Partial<Pick<LabelLayer, 'visible' | 'locked'>>) => void
  onReorder: (draggedId: string, targetId: string, placement: LayerDropPlacement) => void
  onDelete: (id: string) => void
  emptyContent?: ReactNode
}

export function LayerList({ layers, selectedLayerIds, onSelect, onPatchState, onReorder, onDelete, emptyContent }: LayerListProps): React.JSX.Element {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: LayerDropPlacement } | null>(null)

  const previewDrop = (event: DragEvent<HTMLLIElement>, targetId: string): void => {
    if (!draggedId || draggedId === targetId) {
      setDropTarget(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const placement: LayerDropPlacement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (reorderUnlockedLayer(layers, draggedId, targetId, placement) === layers) {
      setDropTarget(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget({ id: targetId, placement })
  }

  const clearDrag = (): void => {
    setDraggedId(null)
    setDropTarget(null)
  }

  return (
    <ul className="layer-list sidebar-layer-list" aria-label="设计图层">
      {layers.length === 0 ? (
        <li className="empty-hint">{emptyContent}</li>
      ) : (
        layers.map((layer) => {
          const meta = layerMeta(layer)
          const selected = selectedLayerIds.includes(layer.id)
          return (
            <li
              key={layer.id}
              className={`layer-row sidebar-layer-row ${selected ? 'selected' : ''} ${dropTarget?.id === layer.id ? `drop-${dropTarget.placement}` : ''}`}
              onDragOver={(event) => previewDrop(event, layer.id)}
              onDrop={(event) => {
                event.preventDefault()
                if (draggedId && dropTarget?.id === layer.id) onReorder(draggedId, layer.id, dropTarget.placement)
                clearDrag()
              }}
            >
              <button
                className="icon-btn layer-drag-handle"
                type="button"
                draggable={!layer.locked}
                disabled={layer.locked}
                aria-label={`拖动${meta.type}${meta.name}调整层级`}
                title={layer.locked ? '请先解锁图层' : '拖动调整层级'}
                onClick={(event) => event.stopPropagation()}
                onDragStart={(event) => {
                  setDraggedId(layer.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', layer.id)
                }}
                onDragEnd={clearDrag}
              >
                {Icon.grip(13)}
              </button>
              <button
                className="layer-selection-button"
                type="button"
                aria-pressed={selected}
                aria-label={`${selected ? '已选择' : '选择'}${meta.type}${meta.name}`}
                onClick={(event) => onSelect(layer.id, event.shiftKey)}
              >
                <span className="layer-kind-icon">{meta.icon}</span>
                <span className="layer-copy">
                  <span className="layer-type">{meta.type}</span>
                  <span className="layer-name">{meta.name}</span>
                </span>
                {layer.craft.length > 0 && <span className="layer-craft-marker" title={layer.craft.map((craft) => CRAFT_LABELS[craft.type]).join('、')}>工艺</span>}
              </button>
              <button
                className="icon-btn"
                type="button"
                onClick={() => onPatchState(layer.id, { visible: !layer.visible })}
                aria-label={layer.visible ? `隐藏${meta.name}` : `显示${meta.name}`}
                title={layer.visible ? '隐藏' : '显示'}
              >
                {Icon.eye(13, layer.visible)}
              </button>
              <button
                className="icon-btn"
                type="button"
                onClick={() => onPatchState(layer.id, { locked: !layer.locked })}
                aria-label={layer.locked ? `解锁${meta.name}` : `锁定${meta.name}`}
                title={layer.locked ? '解锁' : '锁定'}
              >
                {Icon.lock(13, layer.locked)}
              </button>
              <button
                className="icon-btn danger layer-delete-btn"
                type="button"
                disabled={layer.locked}
                onClick={() => onDelete(layer.id)}
                aria-label={`删除${meta.name}`}
                title={layer.locked ? '请先解锁图层' : '删除图层'}
              >
                {Icon.trash(13)}
              </button>
            </li>
          )
        })
      )}
    </ul>
  )
}

interface AreaDeleteConfirmationProps {
  area: LabelAreaConfig
  onCancel: () => void
  onConfirm: () => void
  cancelButtonRef?: RefObject<HTMLButtonElement | null>
}

export function AreaDeleteConfirmation({ area, onCancel, onConfirm, cancelButtonRef }: AreaDeleteConfirmationProps): React.JSX.Element {
  return (
    <div
      className="area-delete-confirm"
      role="group"
      aria-label="确认删除贴标区域"
      aria-describedby="area-delete-description"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <div>
        <strong>删除“{area.name}”？</strong>
        <span id="area-delete-description" role="status">区域内 {area.layers.length} 个设计图层将一并删除，且无法通过区域撤销恢复。</span>
      </div>
      <div className="row">
        <button ref={cancelButtonRef} className="btn ghost sm" type="button" onClick={onCancel}>取消</button>
        <button className="btn danger sm" type="button" onClick={onConfirm}>确认删除</button>
      </div>
    </div>
  )
}

export function LabelWorkspace(): React.JSX.Element {
  const areas = useLabelStore((state) => state.areas)
  const area = useLabelStore((state) => state.activeArea)
  const selectedLayerIds = useLabelStore((state) => state.selectedLayerIds)
  const activateArea = useLabelStore((state) => state.activateArea)
  const applyAreaOp = useLabelStore((state) => state.applyAreaOp)
  const removeArea = useLabelStore((state) => state.removeArea)
  const setMode = useUiStore((state) => state.setMode)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [areaMenuOpen, setAreaMenuOpen] = useState(false)
  const [pendingDeleteAreaId, setPendingDeleteAreaId] = useState<string | null>(null)
  const [restoreDeleteFocus, setRestoreDeleteFocus] = useState(false)
  const deleteAreaButtonRef = useRef<HTMLButtonElement>(null)
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imageUploadOperationRef = useRef(0)
  const imageUploadDecodeCancelRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let activeAreaId = useLabelStore.getState().activeAreaId
    const unsubscribe = useLabelStore.subscribe((state) => {
      if (state.activeAreaId === activeAreaId) return
      activeAreaId = state.activeAreaId
      imageUploadOperationRef.current += 1
      const cancelDecode = imageUploadDecodeCancelRef.current
      imageUploadDecodeCancelRef.current = null
      cancelDecode?.()
    })
    return () => {
      unsubscribe()
      imageUploadOperationRef.current += 1
      const cancelDecode = imageUploadDecodeCancelRef.current
      imageUploadDecodeCancelRef.current = null
      cancelDecode?.()
    }
  }, [])

  useEffect(() => {
    setAreaMenuOpen(false)
    setPendingDeleteAreaId(null)
    setRestoreDeleteFocus(false)
  }, [area?.id])

  useEffect(() => {
    if (pendingDeleteAreaId) {
      cancelDeleteButtonRef.current?.focus()
      return
    }
    if (!restoreDeleteFocus) return
    deleteAreaButtonRef.current?.focus()
    setRestoreDeleteFocus(false)
  }, [pendingDeleteAreaId, restoreDeleteFocus])

  const pendingDeleteArea = pendingDeleteAreaId ? areas.find((candidate) => candidate.id === pendingDeleteAreaId) ?? null : null
  const sortedLayers = area ? canonicalLayerOrderDescending(area.layers) : []
  const selectedLayers = area?.layers.filter((layer) => selectedLayerIds.includes(layer.id)) ?? []
  const editableSelectionCount = selectedLayers.filter((layer) => !layer.locked).length
  const primaryLayer = selectedLayers[0] ?? null
  const canMoveUp = area !== null && primaryLayer !== null && selectedLayers.length === 1 && moveUnlockedLayer(area.layers, primaryLayer.id, 1) !== area.layers
  const canMoveDown = area !== null && primaryLayer !== null && selectedLayers.length === 1 && moveUnlockedLayer(area.layers, primaryLayer.id, -1) !== area.layers

  const beginAreaCreation = (): void => {
    useUiStore.getState().setWorkspaceTab('model')
    useUiStore.getState().setView('areaSetup')
    useUiStore.getState().setMode('browse')
  }

  const deleteArea = (target: LabelAreaConfig): void => {
    removeArea(target.id)
    setPendingDeleteAreaId(null)
    flashToast(`已删除贴标区域「${target.name}」`, 'info')
  }

  const requestAreaDelete = (): void => {
    if (!area) return
    setAreaMenuOpen(false)
    if (getAreaDeleteIntent(area) === 'confirm') setPendingDeleteAreaId(area.id)
    else deleteArea(area)
  }

  const cancelAreaDelete = (): void => {
    setAreaMenuOpen(true)
    setPendingDeleteAreaId(null)
    setRestoreDeleteFocus(true)
  }

  const patchLayerState = (id: string, patch: Partial<Pick<LabelLayer, 'visible' | 'locked'>>): void => {
    if (!area) return
    applyAreaOp(area.id, (config) => ({
      ...config,
      layers: config.layers.map((layer) => layer.id === id ? ({ ...layer, ...patch } as LabelLayer) : layer),
    }))
  }

  const addImage = async (file: File): Promise<void> => {
    const ownerState = useLabelStore.getState()
    const owner = ownerState.activeArea
    const operation = ++imageUploadOperationRef.current
    const supersededDecode = imageUploadDecodeCancelRef.current
    imageUploadDecodeCancelRef.current = null
    supersededDecode?.()
    if (!owner || ownerState.activeAreaId !== owner.id) return
    const ownsOperation = (): boolean => {
      const current = useLabelStore.getState()
      return imageUploadOperationRef.current === operation
        && current.activeAreaId === owner.id
        && current.activeArea === owner
        && current.areas.find((candidate) => candidate.id === owner.id) === owner
    }
    const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase() ?? ''
    const mimeByExtension: Record<string, readonly string[]> = {
      png: ['image/png'],
      jpg: ['image/jpeg', 'image/jpg'],
      jpeg: ['image/jpeg', 'image/jpg'],
      webp: ['image/webp'],
    }
    const acceptedMimes = mimeByExtension[extension]
    if (!acceptedMimes || (file.type !== '' && !acceptedMimes.includes(file.type.toLowerCase()))) {
      if (ownsOperation()) flashToast('仅支持 PNG / JPG / WebP', 'error')
      return
    }
    if (file.size > MAX_EMBEDDED_ASSET_BYTES) {
      if (ownsOperation()) flashToast('图片超过 20MB 上限', 'error')
      return
    }

    let bytes: ArrayBuffer
    try {
      bytes = await file.arrayBuffer()
    } catch {
      if (ownsOperation()) flashToast('图片读取失败', 'error')
      return
    }
    if (!ownsOperation()) return
    const imageBytes = new Uint8Array(bytes)
    const mimeType = file.type || acceptedMimes[0]
    let verifiedDimensions: { width: number; height: number }
    try {
      verifiedDimensions = inspectBoundedImageBytes(imageBytes, mimeType)
    } catch {
      if (ownsOperation()) flashToast('图片文件结构或尺寸无效，已拒绝', 'error')
      return
    }
    const source = bytesToDataUrl(imageBytes, mimeType)
    if (!ownsOperation()) return
    const naturalWidth = verifiedDimensions.width
    const naturalHeight = verifiedDimensions.height
    const scale = Math.min((owner.canvas.width * 0.5) / naturalWidth, (owner.canvas.height * 0.4) / naturalHeight, 1)
    const uuid = globalThis.crypto?.randomUUID?.()
    const layer: ImageLayer = {
      id: uuid ? `layer-${uuid}` : `layer-image-${Date.now().toString(36)}`,
      kind: 'image', src: source, naturalWidth, naturalHeight,
      width: naturalWidth * scale, height: naturalHeight * scale,
      x: owner.canvas.width / 2, y: owner.canvas.height / 2,
      rotation: 0, opacity: 1, visible: true, locked: false,
      zIndex: Math.max(-1, ...owner.layers.map((candidate) => candidate.zIndex)) + 1,
      craft: [],
    }
    const currentAreas = useLabelStore.getState().areas
    const imageIssue = imageResourceBudgetIssue(currentAreas.map((candidate) => candidate.id === owner.id
      ? { ...candidate, layers: [...candidate.layers, layer] }
      : candidate))
    if (imageIssue) {
      flashToast('图片资源超出项目上限，已拒绝', 'error')
      return
    }
    const image = new Image()
    let cancelDecode: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void): void => {
          if (settled) return
          settled = true
          if (imageUploadDecodeCancelRef.current === cancelDecode) imageUploadDecodeCancelRef.current = null
          image.onload = null
          image.onerror = null
          callback()
        }
        cancelDecode = () => finish(() => {
          image.src = ''
          reject(new Error('decode cancelled'))
        })
        imageUploadDecodeCancelRef.current = cancelDecode
        image.onload = () => finish(resolve)
        image.onerror = () => finish(() => reject(new Error('decode failed')))
        image.src = source
      })
      if (!ownsOperation()) {
        image.onload = null
        image.onerror = null
        image.src = ''
        return
      }
      if (image.naturalWidth !== naturalWidth || image.naturalHeight !== naturalHeight) {
        flashToast('图片解码尺寸与文件结构不一致，已拒绝', 'error')
        image.onload = null
        image.onerror = null
        image.src = ''
        return
      }
      if (naturalWidth * naturalHeight > MAX_IMAGE_PIXELS_PER_LAYER) {
        flashToast('图片像素过大（>1600 万像素），已拒绝', 'error')
        image.onload = null
        image.onerror = null
        image.src = ''
        return
      }
      image.onload = null
      image.onerror = null
      image.src = ''

      if (!ownsOperation()) return
      let committed = false
      applyAreaOp(owner.id, (config) => {
        if (config !== owner || imageUploadOperationRef.current !== operation) return config
        committed = true
        return { ...config, layers: [...config.layers, layer] }
      })
      if (!committed) return
      const committedState = useLabelStore.getState()
      const committedOwner = committedState.areas.find((candidate) => candidate.id === owner.id)
      if (
        imageUploadOperationRef.current !== operation
        || committedState.activeAreaId !== owner.id
        || committedState.activeArea !== committedOwner
        || !committedOwner?.layers.some((candidate) => candidate.id === layer.id)
      ) return
      useLabelStore.getState().selectLayers([layer.id])
      flashToast('已添加图片', 'success')
    } catch {
      image.onload = null
      image.onerror = null
      image.src = ''
      if (ownsOperation()) flashToast('图片解码失败', 'error')
    } finally {
      if (imageUploadDecodeCancelRef.current === cancelDecode) imageUploadDecodeCancelRef.current = null
    }
  }

  const movePrimaryLayer = (direction: -1 | 1): void => {
    if (!area || !primaryLayer || selectedLayers.length !== 1) return
    applyAreaOp(area.id, (config) => {
      const layers = moveUnlockedLayer(config.layers, primaryLayer.id, direction)
      return layers === config.layers ? config : { ...config, layers }
    })
  }

  const reorderLayer = (draggedId: string, targetId: string, placement: LayerDropPlacement): void => {
    if (!area) return
    applyAreaOp(area.id, (config) => {
      const layers = reorderUnlockedLayer(config.layers, draggedId, targetId, placement)
      return layers === config.layers ? config : { ...config, layers }
    })
  }

  const deleteLayer = (id: string): void => {
    if (!area) return
    applyAreaOp(area.id, (config) => {
      const layers = removeUnlockedLayer(config.layers, id)
      return layers === config.layers ? config : { ...config, layers }
    })
  }

  return (
    <section className="label-workspace" aria-label="贴标工作区">
      <div className="area-toolbar">
        <label className="area-select-label">
          <span>贴标区域</span>
          <select
            className="input area-select"
            value={area?.id ?? ''}
            disabled={areas.length === 0}
            onChange={(event) => {
              activateArea(event.target.value)
              setMode('design')
            }}
          >
            {areas.length === 0 ? <option value="">尚未创建</option> : areas.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <button className="icon-btn area-add-btn" type="button" onClick={beginAreaCreation} aria-label="创建贴标区域" title="创建贴标区域">
          {Icon.plus(14)}
        </button>
        <div className="area-menu-wrap">
          <button
            className="icon-btn"
            type="button"
            disabled={!area}
            aria-label="贴标区域菜单"
            aria-haspopup="menu"
            aria-expanded={areaMenuOpen}
            onClick={() => setAreaMenuOpen((open) => !open)}
          >
            {Icon.more(15)}
          </button>
          {areaMenuOpen && area && (
            <div className="area-menu" role="menu">
              <button ref={deleteAreaButtonRef} className="area-menu-item danger" type="button" role="menuitem" onClick={requestAreaDelete}>
                {Icon.trash(13)} 删除区域
              </button>
            </div>
          )}
        </div>
      </div>

      {pendingDeleteArea && (
        <AreaDeleteConfirmation
          area={pendingDeleteArea}
          onCancel={cancelAreaDelete}
          onConfirm={() => deleteArea(pendingDeleteArea)}
          cancelButtonRef={cancelDeleteButtonRef}
        />
      )}

      <div className="label-workspace-actions">
        <button
          className="btn primary add-element-btn"
          type="button"
          disabled={!area}
          aria-expanded={libraryOpen}
          onClick={() => setLibraryOpen((open) => !open)}
        >
          {Icon.plus(13)} 添加元素
          {Icon.down(12)}
        </button>
        <button
          className="btn ghost sm"
          type="button"
          disabled={!area}
          aria-label="上传图片"
          title="上传图片（PNG / JPG / WebP）"
          onClick={() => imageInputRef.current?.click()}
        >
          {Icon.image(13)} 图片
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp"
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void addImage(file)
            event.target.value = ''
          }}
        />
        {area && <span className="sidebar-count">{area.layers.length} 图层</span>}
      </div>

      {(libraryOpen || !area) && <ElementLibrary onClose={area ? () => setLibraryOpen(false) : undefined} />}

      <section className="layers-section" aria-label="图层">
        <div className="sidebar-section-head">
          <span>图层</span>
          {selectedLayerIds.length > 0 && <span className="sidebar-selection-count">已选 {selectedLayerIds.length}</span>}
        </div>
        <LayerList
          layers={sortedLayers}
          selectedLayerIds={selectedLayerIds}
          onSelect={(id, additive) => {
            const state = useLabelStore.getState()
            state.selectLayers(nextLayerSelection(state.selectedLayerIds, id, additive))
          }}
          onPatchState={patchLayerState}
          onReorder={reorderLayer}
          onDelete={deleteLayer}
          emptyContent={!area ? (
            <>
              <span>当前没有贴标区域。</span>
              <button className="btn ghost sm" type="button" onClick={() => useUiStore.getState().setWorkspaceTab('model')}>从模型开始</button>
            </>
          ) : '点击“添加元素”，从文字、形状或标签组件开始设计。'}
        />
      </section>

      <footer className="layer-footer" aria-label="图层操作">
        <span className="layer-footer-status">{editableSelectionCount > 0 ? `${editableSelectionCount} 个可编辑` : '选择图层后操作'}</span>
        <button className="icon-btn" type="button" disabled={!canMoveUp} onClick={() => movePrimaryLayer(1)} aria-label="上移图层" title={selectedLayers.length > 1 ? '层级调整仅支持单选' : '上移'}>{Icon.up(14)}</button>
        <button className="icon-btn" type="button" disabled={!canMoveDown} onClick={() => movePrimaryLayer(-1)} aria-label="下移图层" title={selectedLayers.length > 1 ? '层级调整仅支持单选' : '下移'}>{Icon.down(14)}</button>
        <span className="layer-footer-divider" />
        <button className="icon-btn" type="button" disabled={editableSelectionCount === 0} onClick={() => duplicateSelectedLayers()} aria-label="复制选中图层" title="复制选中图层">{Icon.duplicate(14)}</button>
        <button className="icon-btn danger" type="button" disabled={editableSelectionCount === 0} onClick={() => deleteSelectedLayers()} aria-label="删除选中图层" title="删除选中图层">{Icon.trash(14)}</button>
      </footer>
    </section>
  )
}
