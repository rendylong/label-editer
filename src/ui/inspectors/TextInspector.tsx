import { useMemo } from 'react'
import { fontEntry } from '../../label/fontCatalog'
import { uploadedFontId } from '../../label/fontRuntime'
import { uploadFontFile, type UploadedFont } from '../../label/fonts'
import type { AreaMutationGateway } from '../../label/selection'
import type { LabelAreaConfig, LabelLayer, TextLayer } from '../../label/types'
import { BASIC_PALETTE } from '../../label/types'
import { flashToast } from '../../state/stores'
import { CraftEditor } from '../CraftEditor'
import { FontBrowser, fontVariantSupport } from '../FontBrowser'
import { InspectorSection } from '../InspectorSection'

export function commitFreshUploadedFont(
  areaId: string,
  layerId: string,
  font: UploadedFont,
  applyAreaOp: AreaMutationGateway,
): void {
  applyAreaOp(areaId, (config) => {
    const target = config.layers.find((item) => item.id === layerId)
    if (!target || target.kind !== 'text' || target.locked) return config
    return {
      ...config,
      fonts: [...config.fonts.filter((item) => item.name !== font.name), { name: font.name, dataUrl: font.dataUrl }],
      layers: config.layers.map((item) => item.id === layerId ? { ...target, fontFamily: uploadedFontId(font.name) } : item),
    }
  })
}

export function TextInspector({ area, layer, patch, uploadFont = uploadFontFile, commitUploadedFont }: {
  area: LabelAreaConfig
  layer: TextLayer
  patch: (patch: Partial<LabelLayer>) => void
  uploadFont?: (file: File) => Promise<UploadedFont>
  commitUploadedFont: (font: UploadedFont) => void
}): React.JSX.Element {
  const requestedWeight = typeof layer.fontWeight === 'number' ? layer.fontWeight : layer.fontWeight === 'bold' ? 700 : 400
  const entry = fontEntry(layer.fontFamily)
  const uploaded = area.fonts.some((font) => uploadedFontId(font.name) === layer.fontFamily || font.name === layer.fontFamily)
  const support = useMemo(() => entry ? fontVariantSupport(entry, requestedWeight, layer.italic) : null, [entry, requestedWeight, layer.italic])
  const weights = support?.weights.length ? support.weights : uploaded ? [400] : [300, 400, 700, 900]
  const displayWeight = support?.resolvedWeight ?? (uploaded ? 400 : requestedWeight)
  const italicSupported = uploaded ? false : !support || support.styles.includes('italic')

  return (
    <div className="inspector-body">
      <InspectorSection objectType="text" sectionId="content" title="内容">
        <div className="props"><label>文字内容<textarea rows={3} value={layer.text} onChange={(event) => patch({ text: event.target.value })} /></label></div>
      </InspectorSection>
      <InspectorSection objectType="text" sectionId="typography" title="排版">
        <div className="props">
          <FontBrowser
            selectionKey={`${area.id}/${layer.id}`}
            currentFontId={layer.fontFamily}
            currentWeight={requestedWeight}
            italic={layer.italic}
            sampleText={layer.text}
            uploadedFonts={area.fonts}
            onSelect={(fontFamily) => patch({ fontFamily })}
            uploadFont={uploadFont}
            onUploadCommit={(font) => {
              commitUploadedFont(font)
              flashToast(`字体「${font.name}」已加载`, 'success')
            }}
          />
          <div className="row2">
            <label>字号<input type="number" min={8} max={1200} value={layer.fontSize} onChange={(event) => patch({ fontSize: +event.target.value || 12 })} /></label>
            <label>字重
              <select value={displayWeight} disabled={weights.length <= 1} onChange={(event) => patch({ fontWeight: +event.target.value })}>
                {weights.map((weight) => <option key={weight} value={weight}>{weight}{weight === 400 ? ' 常规' : ''}{weight >= 700 ? ' 粗体' : ''}</option>)}
              </select>
            </label>
          </div>
          {support && (support.usesNearestWeight || support.usesNearestStyle) && <div className="font-variant-note">当前字体仅含 {support.resolvedWeight} {support.resolvedStyle === 'normal' ? '正体' : '斜体'}；请求样式以最接近的真实字形显示。</div>}
          {uploaded && <div className="font-variant-note">该上传记录只包含一个 400 正体文件，不合成粗体或斜体资源。</div>}
          <div className="row2">
            <label>字距 {layer.letterSpacing}px<input type="range" min={-20} max={120} value={layer.letterSpacing} onChange={(event) => patch({ letterSpacing: +event.target.value })} /></label>
            <label>行距 {layer.lineHeight}<input type="range" min={0.8} max={2.5} step={0.05} value={layer.lineHeight} onChange={(event) => patch({ lineHeight: +event.target.value })} /></label>
          </div>
          <div className="row2">
            <label>文本框宽度<input type="number" min={8} max={4096} value={Math.round(layer.width ?? 320)} onChange={(event) => patch({ width: Math.max(8, +event.target.value || 8) })} /></label>
            <label>书写方向<select value={layer.writingDirection ?? 'auto'} onChange={(event) => patch({ writingDirection: event.target.value as TextLayer['writingDirection'] })}><option value="auto">自动</option><option value="ltr">从左到右</option><option value="rtl">从右到左</option></select></label>
          </div>
          <div className="row2">
            <label>对齐<select value={layer.align} onChange={(event) => patch({ align: event.target.value as TextLayer['align'] })}><option value="left">左</option><option value="center">中</option><option value="right">右</option></select></label>
            <label>朝向<select value={layer.direction ?? 'horizontal'} onChange={(event) => patch({ direction: event.target.value as TextLayer['direction'] })}><option value="horizontal">横向环绕</option><option value="vertical">纵向瓶高</option></select></label>
          </div>
          <label>语言标签<input type="text" value={layer.language ?? ''} placeholder="例如 ar、zh-Hans" onChange={(event) => patch({ language: event.target.value })} /></label>
          <label className="inline-toggle"><span>斜体{!italicSupported ? '（无真实斜体资源）' : ''}</span><input type="checkbox" checked={italicSupported && layer.italic} disabled={!italicSupported} onChange={(event) => patch({ italic: event.target.checked })} /></label>
        </div>
      </InspectorSection>
      <InspectorSection objectType="text" sectionId="appearance" title="外观">
        <div className="props"><label>颜色<div className="swatches">{BASIC_PALETTE.map((color) => <button type="button" key={color} className={`swatch ${layer.color === color ? 'active' : ''}`} style={{ background: color }} onClick={() => patch({ color })} title={color} />)}<input type="color" value={layer.color} onChange={(event) => patch({ color: event.target.value })} title="取色器" /></div></label></div>
      </InspectorSection>
      <InspectorSection objectType="text" sectionId="transform" title="变换">
        <TransformFields layer={layer} patch={patch} />
      </InspectorSection>
      <InspectorSection objectType="text" sectionId="craft" title="工艺">
        <CraftEditor craft={layer.craft} onChange={(craft) => patch({ craft })} scope="layer" />
      </InspectorSection>
    </div>
  )
}

export function TransformFields({ layer, patch }: { layer: LabelLayer; patch: (patch: Partial<LabelLayer>) => void }): React.JSX.Element {
  return <div className="props">
    <div className="row2"><label>X<input type="number" value={Math.round(layer.x)} onChange={(event) => patch({ x: +event.target.value })} /></label><label>Y<input type="number" value={Math.round(layer.y)} onChange={(event) => patch({ y: +event.target.value })} /></label></div>
    <label>旋转 {Math.round(layer.rotation)}°<input type="range" min={-180} max={180} value={layer.rotation} onChange={(event) => patch({ rotation: +event.target.value })} /></label>
    <label>不透明度 {Math.round(layer.opacity * 100)}%<input type="range" min={0} max={1} step={0.05} value={layer.opacity} onChange={(event) => patch({ opacity: +event.target.value })} /></label>
  </div>
}
