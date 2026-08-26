import { useEffect, useState } from 'react'
import { normalizeShapeLayer } from '../../label/shapeGeometry'
import type { LabelLayer, ShapeGeometry, ShapeKind, ShapeLayer } from '../../label/types'
import { CraftEditor } from '../CraftEditor'
import { CssColorField } from '../CssColorField'
import { InspectorSection } from '../InspectorSection'
import { TransformFields } from './TextInspector'

const SHAPE_NAMES: Record<ShapeKind, string> = {
  rectangle: '矩形', ellipse: '椭圆', triangle: '三角形', diamond: '菱形', polygon: '多边形', star: '星形',
  line: '线条', wave: '波浪线', burst: '放射形', cross: '十字', bracket: '括号', 'dot-grid': '点阵', frame: '边框', path: '路径',
}

export function ShapeInspector({ layer, patch }: { layer: ShapeLayer; patch: (patch: Partial<LabelLayer>) => void }): React.JSX.Element {
  const [ratioLocked, setRatioLocked] = useState(false)
  const normalized = normalizeShapeLayer(layer)
  const geometry = normalized.geometry!
  const ratio = layer.width / Math.max(layer.height, 1)
  const hasFill = !['line', 'wave', 'bracket'].includes(layer.shape)
  const transparentFill = layer.fill === 'transparent'
  const opaqueFill = transparentFill ? null : layer.fill
  const [lastOpaqueFill, setLastOpaqueFill] = useState(opaqueFill ?? '#111111')
  useEffect(() => {
    setLastOpaqueFill(opaqueFill ?? '#111111')
  }, [layer.id])
  useEffect(() => {
    if (opaqueFill) setLastOpaqueFill(opaqueFill)
  }, [opaqueFill])
  const patchGeometry = (value: Partial<ShapeGeometry>): void => patch({ geometry: { ...layer.geometry, ...value } })
  const numberGeometry = (key: keyof ShapeGeometry, label: string, min: number, max: number, step = 1): React.JSX.Element => (
    <label>{label}<input type="number" min={min} max={max} step={step} value={String(geometry[key])} onChange={(event) => patchGeometry({ [key]: +event.target.value })} /></label>
  )
  return <div className="inspector-body">
    <InspectorSection objectType="shape" sectionId="geometry" title={`几何 · ${SHAPE_NAMES[layer.shape]}`}>
      <div className="props">
        <label className="inline-toggle"><span>锁定宽高比</span><input type="checkbox" checked={ratioLocked} onChange={(event) => setRatioLocked(event.target.checked)} /></label>
        <div className="row2">
          <label>宽度<input type="number" min={1} value={Math.round(layer.width)} onChange={(event) => { const width = Math.max(1, +event.target.value || 1); patch(ratioLocked ? { width, height: width / ratio } : { width }) }} /></label>
          <label>高度<input type="number" min={1} value={Math.round(layer.height)} onChange={(event) => { const height = Math.max(1, +event.target.value || 1); patch(ratioLocked ? { height, width: height * ratio } : { height }) }} /></label>
        </div>
        {layer.shape === 'frame' && numberGeometry('inset', '边框内距', 0, Math.min(layer.width, layer.height) / 2)}
        {layer.shape === 'polygon' && numberGeometry('sides', '边数', 3, 32)}
        {(layer.shape === 'star' || layer.shape === 'burst') && <div className="row2">{numberGeometry('points', '尖角数量', 3, 32)}{numberGeometry('innerRatio', '内径比例', 0.05, 0.95, 0.05)}</div>}
        {layer.shape === 'wave' && <div className="row2">{numberGeometry('amplitude', '振幅', 0, layer.height / 2)}{numberGeometry('frequency', '频率', 0.5, 32, 0.5)}</div>}
        {layer.shape === 'line' && <>
          <div className="row2"><label className="inline-toggle"><span>起点箭头</span><input type="checkbox" checked={geometry.arrowStart} onChange={(event) => patchGeometry({ arrowStart: event.target.checked })} /></label><label className="inline-toggle"><span>终点箭头</span><input type="checkbox" checked={geometry.arrowEnd} onChange={(event) => patchGeometry({ arrowEnd: event.target.checked })} /></label></div>
          <label className="inline-toggle"><span>平行双线</span><input type="checkbox" checked={geometry.parallel} onChange={(event) => patchGeometry({ parallel: event.target.checked })} /></label>
          {geometry.parallel && numberGeometry('gap', '双线间距', 0, Math.max(layer.width, layer.height))}
          <label>虚线节奏<input type="text" value={geometry.dash?.join(', ') ?? ''} placeholder="例如 12, 8" onChange={(event) => patchGeometry({ dash: event.target.value.split(/[ ,]+/).map(Number).filter((value) => Number.isFinite(value) && value > 0) })} /></label>
        </>}
        {(layer.shape === 'cross' || layer.shape === 'bracket') && numberGeometry('inset', '内距', 0, Math.min(layer.width, layer.height) / 2)}
        {layer.shape === 'dot-grid' && <><div className="row2">{numberGeometry('rows', '行数', 1, 32)}{numberGeometry('columns', '列数', 1, 32)}</div>{numberGeometry('gap', '点间距', 0, Math.max(layer.width, layer.height))}</>}
      </div>
    </InspectorSection>
    <InspectorSection objectType="shape" sectionId="appearance" title="外观">
      <div className="props">
        {hasFill && <>
          <label className="inline-toggle"><span>无填色（透明）</span><input aria-label="无填色（透明）" type="checkbox" checked={transparentFill} onChange={(event) => patch({ fill: event.target.checked ? 'transparent' : lastOpaqueFill })} /></label>
          {transparentFill && <span className="field-status" role="status">当前填色：透明</span>}
          <CssColorField label="填色颜色" ariaLabel="填色颜色" value={layer.fill} onChange={(fill) => { if (fill && fill !== 'transparent') setLastOpaqueFill(fill); patch({ fill }) }} />
        </>}
        <CssColorField label="描边" ariaLabel="描边颜色" value={layer.stroke} onChange={(stroke) => patch({ stroke })} />
        <label>描边宽度<input type="number" min={0} max={100} value={layer.strokeWidth} onChange={(event) => patch({ strokeWidth: Math.max(0, +event.target.value || 0) })} /></label>
        {(layer.shape === 'rectangle' || layer.shape === 'frame') && <label>圆角<input type="number" min={0} value={layer.cornerRadius} onChange={(event) => patch({ cornerRadius: Math.max(0, +event.target.value || 0) })} /></label>}
      </div>
    </InspectorSection>
    <InspectorSection objectType="shape" sectionId="transform" title="变换"><TransformFields layer={layer} patch={patch} /></InspectorSection>
    <InspectorSection objectType="shape" sectionId="craft" title="工艺"><CraftEditor craft={layer.craft} onChange={(craft) => patch({ craft })} scope="layer" /></InspectorSection>
  </div>
}
