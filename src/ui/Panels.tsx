/**
 * 兼容面板：旧部件树与图层列表。属性检查器已拆分到 Inspector。
 */

import { useMemo, useRef, useState } from 'react'
import { useModelStore, useLabelStore, useUiStore, flashToast } from '../state/stores'
import type { PartNode, LabelLayer, TextLayer, ImageLayer, ShapeLayer } from '../label/types'
import { CRAFT_LABELS, FONT_STACKS } from '../label/types'
import { bytesToDataUrl } from '../label/imageSource'
import { nextLayerSelection } from '../label/selection'
import { duplicateUnlockedLayer, moveUnlockedLayer, removeUnlockedLayer } from '../label/layerMutations'
import { canonicalLayerOrder } from '../label/layerOrder'
import { Icon } from './icons'

// ── 部件树（含贴标区域分组）───────────────────────────────────────────
export function PartTree(): React.JSX.Element {
  const parts = useModelStore((s) => s.parts)
  const selectedPartId = useModelStore((s) => s.selectedPartId)
  const hiddenIds = useModelStore((s) => s.hiddenIds)
  const selectPart = useModelStore((s) => s.selectPart)
  const toggleVisible = useModelStore((s) => s.toggleVisible)
  const areas = useLabelStore((s) => s.areas)
  const setMode = useUiStore((s) => s.setMode)
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    if (!filter) return parts
    const f = filter.toLowerCase()
    const walk = (nodes: PartNode[]): PartNode[] =>
      nodes
        .map((n) => {
          const children = walk(n.children)
          const self = n.name.toLowerCase().includes(f)
          return self || children.length ? { ...n, children } : null
        })
        .filter((n): n is PartNode => n !== null)
    return walk(parts)
  }, [parts, filter])

  const renderNode = (node: PartNode, depth: number): React.JSX.Element => {
    const selected = node.id === selectedPartId
    const isLabel = areas.some((a) => a.nodeName === node.name)
    return (
      <div key={node.id}>
        <div
          className={`tree-row ${selected ? 'selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            selectPart(node.id)
            if (node.meshIndex !== undefined && isLabel) setMode('design')
            else if (node.meshIndex !== undefined) setMode('browse')
          }}
          title={node.material ? `材质：${node.material}` : undefined}
        >
          <button
            className="icon-btn"
            onClick={(e) => {
              e.stopPropagation()
              toggleVisible(node.id)
            }}
            title={hiddenIds.has(node.id) ? '显示' : '隐藏'}
          >
            {Icon.eye(13, !hiddenIds.has(node.id))}
          </button>
          <span className={`tree-icon ${isLabel ? 'tree-icon--accent' : 'tree-icon--decorative'}`}>
            {node.children.length ? Icon.group(13) : isLabel ? Icon.label(13) : Icon.cube(13)}
          </span>
          <span className="tree-name">{node.name}</span>
          {isLabel && <span className="tree-badge">贴标</span>}
          {node.triangleCount !== undefined && <span className="tree-meta">{node.triangleCount.toLocaleString()}▲</span>}
        </div>
        {node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-title">部件列表</div>
      <input className="input" placeholder="搜索部件…" value={filter} onChange={(e) => setFilter(e.target.value)} />

      <div className="tree">
        {parts.length === 0 ? (
          <div className="empty-hint">打开一个 GLB 或加载示例模型</div>
        ) : filtered.length === 0 ? (
          <div className="empty-hint">
            无匹配部件
            <button className="btn ghost" onClick={() => setFilter('')}>
              清除搜索
            </button>
          </div>
        ) : (
          filtered.map((n) => renderNode(n, 0))
        )}
      </div>
    </div>
  )
}

// ── 图层列表 ───────────────────────────────────────────────────────────
let layerSeq = 0
export function uid(): string {
  return `l${++layerSeq}`
}

export function LayersPanel(): React.JSX.Element {
  const area = useLabelStore((s) => s.activeArea)
  const selectedLayerIds = useLabelStore((s) => s.selectedLayerIds)
  const selectLayers = useLabelStore((s) => s.selectLayers)
  const applyAreaOp = useLabelStore((s) => s.applyAreaOp)
  const imgInputRef = useRef<HTMLInputElement>(null)

  if (!area) return <div className="panel empty-hint">未激活贴标区域</div>
  const layers = area.layers
  const selectedLayerId = selectedLayerIds[0] ?? null
  const selectedLayer = layers.find((layer) => layer.id === selectedLayerId) ?? null
  const canMoveUp = selectedLayerId !== null && moveUnlockedLayer(layers, selectedLayerId, 1) !== layers
  const canMoveDown = selectedLayerId !== null && moveUnlockedLayer(layers, selectedLayerId, -1) !== layers

  const addText = (): void => {
    const z = Math.max(-1, ...layers.map((l) => l.zIndex)) + 1
    const layer: TextLayer = {
      id: uid(),
      kind: 'text',
      text: '新品上市',
      fontFamily: FONT_STACKS[0].name,
      fontSize: 120,
      fontWeight: 700,
      letterSpacing: 8,
      lineHeight: 1.2,
      color: '#1a1a1a',
      align: 'center',
      italic: false,
      x: area.canvas.width / 2,
      y: area.canvas.height / 2,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      zIndex: z,
      craft: [],
    }
    applyAreaOp(area.id, (cfg) => ({ ...cfg, layers: [...cfg.layers, layer] }))
    selectLayers([layer.id])
  }

  const addRectangle = (): void => {
    const z = Math.max(-1, ...layers.map((l) => l.zIndex)) + 1
    const layer: ShapeLayer = {
      id: uid(),
      kind: 'shape',
      shape: 'rectangle',
      width: area.canvas.width * 0.6,
      height: area.canvas.height * 0.16,
      fill: '#111111',
      stroke: '#111111',
      strokeWidth: 0,
      cornerRadius: 0,
      x: area.canvas.width / 2,
      y: area.canvas.height / 2,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      zIndex: z,
      craft: [],
    }
    applyAreaOp(area.id, (cfg) => ({ ...cfg, layers: [...cfg.layers, layer] }))
    selectLayers([layer.id])
  }

  const addImage = async (file: File): Promise<void> => {
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) {
      flashToast('仅支持 PNG / JPG / WebP', 'error')
      return
    }
    if (file.size > 64 * 1024 * 1024) {
      flashToast('图片超过 64MB 上限', 'error')
      return
    }
    const url = bytesToDataUrl(new Uint8Array(await file.arrayBuffer()), file.type || 'application/octet-stream')
    const img = new Image()
    img.src = url
    try {
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = () => rej(new Error('解码失败'))
      })
      const px = img.naturalWidth * img.naturalHeight
      if (px > 16 * 1024 * 1024) {
        flashToast('图片像素过大（>1600 万像素），已拒绝', 'error')
        return
      }
      const z = Math.max(-1, ...layers.map((l) => l.zIndex)) + 1
      // 默认尺寸适配画布：宽 ≤ 画布 50%、高 ≤ 画布 40%，保持原图比例（避免变形/截断）
      const scale = Math.min((area.canvas.width * 0.5) / img.naturalWidth, (area.canvas.height * 0.4) / img.naturalHeight, 1)
      const w = img.naturalWidth * scale
      const h = img.naturalHeight * scale
      const layer: ImageLayer = {
        id: uid(),
        kind: 'image',
        src: url,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        width: w,
        height: h,
        x: area.canvas.width / 2,
        y: area.canvas.height / 2,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        zIndex: z,
        craft: [],
      }
      applyAreaOp(area.id, (cfg) => ({ ...cfg, layers: [...cfg.layers, layer] }))
      selectLayers([layer.id])
    } catch {
      flashToast('图片解码失败', 'error')
    }
  }

  const move = (id: string, dir: -1 | 1): void => {
    applyAreaOp(area.id, (cfg) => {
      const nextLayers = moveUnlockedLayer(cfg.layers, id, dir)
      return nextLayers === cfg.layers ? cfg : { ...cfg, layers: nextLayers }
    })
  }

  const remove = (id: string): void => {
    applyAreaOp(area.id, (cfg) => {
      const nextLayers = removeUnlockedLayer(cfg.layers, id)
      return nextLayers === cfg.layers ? cfg : { ...cfg, layers: nextLayers }
    })
  }

  const duplicate = (id: string): void => {
    const copyId = uid()
    applyAreaOp(area.id, (cfg) => {
      const nextLayers = duplicateUnlockedLayer(cfg.layers, id, copyId)
      return nextLayers === cfg.layers ? cfg : { ...cfg, layers: nextLayers }
    })
  }

  const patchLayerState = (id: string, p: Partial<Pick<LabelLayer, 'visible' | 'locked'>>): void => {
    applyAreaOp(area.id, (cfg) => ({ ...cfg, layers: cfg.layers.map((l) => (l.id === id ? ({ ...l, ...p } as LabelLayer) : l)) }))
  }

  const sorted = canonicalLayerOrder(layers)

  return (
    <div className="panel">
      <div className="panel-title">
        图层 · {area.name}
        <span className="panel-actions">
          <button className="btn primary sm" onClick={addText} title="添加文字">
            {Icon.plus(12)} 文字
          </button>
          <button className="btn primary sm" onClick={addRectangle} title="添加矩形色块或分隔线">
            {Icon.plus(12)} 矩形
          </button>
          <button className="btn primary sm" title="添加图片（PNG/JPG/WebP）" onClick={() => imgInputRef.current?.click()}>
            {Icon.plus(12)} 图片
            <input
              ref={imgInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void addImage(f)
                e.target.value = ''
              }}
            />
          </button>
        </span>
      </div>
      <div className="layer-list">
        {sorted.length === 0 && (
          <div className="empty-hint">
            三步开始：① 点「+ 文字」或「+ 图片」② 调整属性 ③ 看右侧 3D 预览
          </div>
        )}
        {[...sorted].reverse().map((l) => (
          <div
            key={l.id}
            className={`layer-row ${selectedLayerIds.includes(l.id) ? 'selected' : ''}`}
            onClick={(event) => {
              const state = useLabelStore.getState()
              state.selectLayers(nextLayerSelection(state.selectedLayerIds, l.id, event.shiftKey))
            }}
          >
            <span className="tree-icon">{l.kind === 'text' ? Icon.label(12) : Icon.cube(12)}</span>
            <span className="tree-name" style={{ flex: 1 }}>
              {l.kind === 'text'
                ? (l as TextLayer).text.slice(0, 12) || '（空文字）'
                : l.kind === 'image'
                  ? `图片 ${Math.round((l as ImageLayer).width)}×${Math.round((l as ImageLayer).height)}`
                  : `矩形 ${Math.round((l as ShapeLayer).width)}×${Math.round((l as ShapeLayer).height)}`}
            </span>
            {l.craft.length > 0 && <span className="tree-badge craft">{l.craft.map((c) => CRAFT_LABELS[c.type]).join('+')}</span>}
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); patchLayerState(l.id, { visible: !l.visible }) }} title={l.visible ? '隐藏' : '显示'}>
              {Icon.eye(12, l.visible)}
            </button>
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); patchLayerState(l.id, { locked: !l.locked }) }} title={l.locked ? '解锁' : '锁定'}>
              {Icon.lock(12)}
            </button>
            <button className="icon-btn" disabled={l.locked} onClick={(e) => { e.stopPropagation(); duplicate(l.id) }} title={l.locked ? '请先解锁图层' : '复制'}>
              {Icon.dup(12)}
            </button>
            <button className="icon-btn" disabled={l.locked} onClick={(e) => { e.stopPropagation(); remove(l.id) }} title={l.locked ? '请先解锁图层' : '删除'}>
              {Icon.trash(12)}
            </button>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn ghost sm" disabled={!selectedLayer || !canMoveUp} onClick={() => selectedLayerId && move(selectedLayerId, 1)}>
          ↑ 上移
        </button>
        <button className="btn ghost sm" disabled={!selectedLayer || !canMoveDown} onClick={() => selectedLayerId && move(selectedLayerId, -1)}>
          ↓ 下移
        </button>
      </div>
    </div>
  )
}
