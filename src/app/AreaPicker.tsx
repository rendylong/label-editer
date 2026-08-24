/**
 * 可视化贴标区域选择器（Konva 2D 平面展开图）：
 * 在标签网格的展开图上拖拽/缩放一个矩形，即定义贴标区域（uStart/uWidth/vStart/vHeight）。
 * 轻量交互（无 remap 重算，直到确认创建），替换原 3D 控制框拖拽方案。
 */

import { useEffect, useRef } from 'react'
import { Stage, Layer, Rect, Transformer, Text as KText, Line } from 'react-konva'
import type Konva from 'konva'
import type { LabelAreaRange } from '../label/types'
import { pickerRectToRange, rangeToPickerRect } from '../glb/areaMath'

interface Props {
  /** 展开图宽高比（2πr : h） */
  aspect: number
  value: LabelAreaRange
  onChange: (range: LabelAreaRange) => void
}

const DISPLAY_W = 640

const AREA_PICKER_COLORS = {
  surface: '#F8FAFC',
  grid: 'rgba(102,112,133,0.18)',
  guide: 'rgba(53,106,230,0.58)',
  seam: 'rgba(217,45,32,0.62)',
  text: '#667085',
  accentText: '#356AE6',
  accentFill: 'rgba(53,106,230,0.12)',
  accent: '#356AE6',
} as const

export function AreaPicker({ aspect, value, onChange }: Props): React.JSX.Element {
  const rectRef = useRef<Konva.Rect>(null)
  const trRef = useRef<Konva.Transformer>(null)
  // 画布内容尺寸（归一化 0..1 空间，宽 DISPLAY_W 显示）
  const contentW = DISPLAY_W
  const contentH = Math.max(120, Math.min(420, Math.round(DISPLAY_W / Math.max(aspect, 0.5))))

  useEffect(() => {
    const tr = trRef.current
    const rect = rectRef.current
    if (!tr || !rect) return
    tr.nodes([rect])
    tr.getLayer()?.batchDraw()
  }, [value.uWidth, value.vHeight, value.uStart, value.vStart])

  const pickerRect = rangeToPickerRect(value)
  const x = pickerRect.x * contentW
  const y = pickerRect.y * contentH
  const w = pickerRect.width * contentW
  const h = pickerRect.height * contentH

  const commitRect = (next: { x: number; y: number; width: number; height: number }): void => {
    onChange(
      pickerRectToRange({
        x: next.x / contentW,
        y: next.y / contentH,
        width: next.width / contentW,
        height: next.height / contentH,
      }),
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <Stage width={contentW} height={contentH} style={{ background: 'var(--color-canvas)', borderRadius: 6, border: '1px solid var(--color-border)' }}>
        {/* 展开图背景 */}
        <Layer listening={false}>
          <Rect x={0} y={0} width={contentW} height={contentH} fill={AREA_PICKER_COLORS.surface} />
          {[0.25, 0.5, 0.75].map((n) => (
            <Line key={`h-${n}`} points={[0, contentH * n, contentW, contentH * n]} stroke={AREA_PICKER_COLORS.grid} strokeWidth={1} />
          ))}
          {[0.25, 0.75].map((n) => (
            <Line key={`v-${n}`} points={[contentW * n, 0, contentW * n, contentH]} stroke={AREA_PICKER_COLORS.grid} strokeWidth={1} />
          ))}
          <Line points={[contentW / 2, 0, contentW / 2, contentH]} stroke={AREA_PICKER_COLORS.guide} strokeWidth={1.25} dash={[5, 5]} />
          <Line points={[0.5, 0, 0.5, contentH]} stroke={AREA_PICKER_COLORS.seam} strokeWidth={1.5} />
          <Line points={[contentW - 0.5, 0, contentW - 0.5, contentH]} stroke={AREA_PICKER_COLORS.seam} strokeWidth={1.5} />
          <KText text="顶部 · v=1" x={8} y={8} fontSize={11} fill={AREA_PICKER_COLORS.text} />
          <KText text="正面 · u=0.5" x={contentW / 2 - 38} y={8} fontSize={11} fill={AREA_PICKER_COLORS.accentText} />
          <KText text="底部 · v=0" x={8} y={contentH - 20} fontSize={11} fill={AREA_PICKER_COLORS.text} />
          <KText text="背部接缝" x={contentW - 58} y={contentH - 20} fontSize={11} fill={AREA_PICKER_COLORS.seam} />
        </Layer>
        {/* 选择矩形 */}
        <Layer>
          <Rect
            ref={rectRef}
            x={x}
            y={y}
            width={w}
            height={h}
            fill={AREA_PICKER_COLORS.accentFill}
            stroke={AREA_PICKER_COLORS.accent}
            strokeWidth={1.5}
            draggable
            dragBoundFunc={(pos) => ({
              x: Math.max(0, Math.min(contentW - w, pos.x)),
              y: Math.max(0, Math.min(contentH - h, pos.y)),
            })}
            onDragEnd={(e) => {
              const node = e.target as Konva.Rect
              commitRect({ x: node.x(), y: node.y(), width: node.width(), height: node.height() })
            }}
            onTransformEnd={(e) => {
              const node = e.target as Konva.Rect
              const scaleX = node.scaleX()
              const scaleY = node.scaleY()
              node.scaleX(1)
              node.scaleY(1)
              commitRect({ x: node.x(), y: node.y(), width: node.width() * scaleX, height: node.height() * scaleY })
            }}
          />
          <Transformer
            ref={trRef}
            rotateEnabled={false}
            flipEnabled={false}
            keepRatio={false}
            enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
            boundBoxFunc={(oldBox, newBox) => {
              if (newBox.width < 8 || newBox.height < 8) return oldBox
              const normalized = rangeToPickerRect(
                pickerRectToRange({
                  x: newBox.x / contentW,
                  y: newBox.y / contentH,
                  width: newBox.width / contentW,
                  height: newBox.height / contentH,
                }),
              )
              return {
                ...newBox,
                x: normalized.x * contentW,
                y: normalized.y * contentH,
                width: normalized.width * contentW,
                height: normalized.height * contentH,
              }
            }}
          />
        </Layer>
      </Stage>
      <div className="row" style={{ gap: 16, fontSize: 12, color: 'var(--text-2)' }}>
        <span>环绕宽度：{Math.round(value.uWidth * 100)}%（占一圈）</span>
        <span>高度：{Math.round(value.vHeight * 100)}%（占标签高度）</span>
      </div>
      <div className="hint">拖动矩形移动位置，拖四角调整大小；选区始终对应模型表面的有效 UV 范围</div>
    </div>
  )
}
