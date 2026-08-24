import { useState } from 'react'
import type { ImageLayer, LabelLayer } from '../../label/types'
import { CraftEditor } from '../CraftEditor'
import { InspectorSection } from '../InspectorSection'
import { TransformFields } from './TextInspector'

export function ImageInspector({ layer, patch }: { layer: ImageLayer; patch: (patch: Partial<LabelLayer>) => void }): React.JSX.Element {
  const [ratioLocked, setRatioLocked] = useState(true)
  const ratio = layer.naturalWidth > 0 && layer.naturalHeight > 0 ? layer.naturalWidth / layer.naturalHeight : layer.width / Math.max(layer.height, 1)
  return <div className="inspector-body">
    <InspectorSection objectType="image" sectionId="content" title="图片">
      <div className="image-source-summary"><img src={layer.src} alt="所选图片预览" /><div><b>{layer.naturalWidth} × {layer.naturalHeight}px</b><span>嵌入项目的图像资源</span></div></div>
    </InspectorSection>
    <InspectorSection objectType="image" sectionId="geometry" title="尺寸">
      <div className="props">
        <label className="inline-toggle"><span>锁定原始比例</span><input type="checkbox" checked={ratioLocked} onChange={(event) => setRatioLocked(event.target.checked)} /></label>
        <div className="row2">
          <label>宽度<input type="number" min={4} value={Math.round(layer.width)} onChange={(event) => { const width = Math.max(4, +event.target.value || 4); patch(ratioLocked ? { width, height: width / ratio } : { width }) }} /></label>
          <label>高度<input type="number" min={4} value={Math.round(layer.height)} onChange={(event) => { const height = Math.max(4, +event.target.value || 4); patch(ratioLocked ? { height, width: height * ratio } : { height }) }} /></label>
        </div>
      </div>
    </InspectorSection>
    <InspectorSection objectType="image" sectionId="transform" title="变换"><TransformFields layer={layer} patch={patch} /></InspectorSection>
    <InspectorSection objectType="image" sectionId="craft" title="工艺"><CraftEditor craft={layer.craft} onChange={(craft) => patch({ craft })} scope="layer" /></InspectorSection>
  </div>
}

