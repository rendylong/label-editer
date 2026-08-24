import { useState } from 'react'
import { craftTypesForScope } from '../label/craft'
import type { CraftEffect, CraftType } from '../label/types'
import { CRAFT_LABELS, FOIL_COLORS } from '../label/types'
import { Icon } from './icons'

const DEFAULT_PARAMS: Record<CraftType, CraftEffect['params']> = {
  foil: { foilColor: 'gold', gradientAngle: 60, highlight: 0.4 },
  emboss: { depth: 0.08, lightAngle: 45 },
  deboss: { depth: 0.08, lightAngle: 225 },
  matte: { intensity: 0.3, noise: 0.5 },
  uv: { gloss: 0.5 },
  stroke: { strokeColor: '#222222', strokeWidth: 4 },
}

const CRAFT_DESCRIPTIONS: Record<CraftType, string> = {
  foil: '金属反射随环境光变化，适合品牌字与细线图形。',
  emboss: '以高度与法线形成向外起伏，颜色本身保持干净。',
  deboss: '以反向高度形成内压边缘，适合克制的触感标记。',
  matte: '细颗粒写入粗糙度与微表面，减少镜面反射。',
  uv: '降低局部粗糙度，高光会随视角和环境移动。',
  stroke: '为文字、图形和透明图片生成一致的圆润轮廓。',
}

export function CraftEditor({ craft, onChange, scope }: {
  craft: CraftEffect[]
  onChange: (next: CraftEffect[]) => void
  scope: 'layer' | 'global'
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const update = (index: number, patch: Partial<CraftEffect>): void => {
    onChange(craft.map((effect, current) => current === index
      ? { ...effect, ...patch, params: { ...effect.params, ...(patch.params ?? {}) } }
      : effect))
  }
  const add = (type: CraftType): void => {
    onChange([...craft.filter((effect) => effect.type !== type), { type, params: DEFAULT_PARAMS[type] }])
    setAdding(false)
  }

  return (
    <div className="craft-editor">
      {craft.length === 0 && <div className="hint">尚未应用工艺效果。</div>}
      {craft.map((effect, index) => (
        <div className="craft-item" key={effect.type}>
          <div className="craft-head">
            <div className="craft-identity">
              <span className="craft-effect-preview" data-craft-effect={effect.type} aria-hidden="true" />
              <span className="tree-badge craft">{CRAFT_LABELS[effect.type]}</span>
            </div>
            <button className="icon-btn" type="button" onClick={() => onChange(craft.filter((_, current) => current !== index))} title="移除工艺">{Icon.trash(12)}</button>
          </div>
          <p className="craft-effect-description">{CRAFT_DESCRIPTIONS[effect.type]}</p>
          <div className="craft-params">
            {effect.type === 'foil' && <>
              <label>色系
                <select value={effect.params.foilColor ?? 'gold'} onChange={(event) => update(index, { params: { foilColor: event.target.value as CraftEffect['params']['foilColor'] } })}>
                  {Object.entries(FOIL_COLORS).map(([id, color]) => <option value={id} key={id}>{color.name}</option>)}
                </select>
              </label>
              <label>渐变角 {effect.params.gradientAngle ?? 60}°
                <input type="range" min={0} max={360} value={effect.params.gradientAngle ?? 60} onChange={(event) => update(index, { params: { gradientAngle: +event.target.value } })} />
              </label>
              <label>高光 {Math.round((effect.params.highlight ?? 0.4) * 100)}%
                <input type="range" min={0} max={1} step={0.05} value={effect.params.highlight ?? 0.4} onChange={(event) => update(index, { params: { highlight: +event.target.value } })} />
              </label>
              <div className="hint">生产提示：烫金最小线宽 ≥0.1mm；此处为专色层预览。</div>
            </>}
            {(effect.type === 'emboss' || effect.type === 'deboss') && <>
              <label>深度 {Math.round((effect.params.depth ?? 0.08) * 100)}%
                <input type="range" min={0} max={0.4} step={0.01} value={effect.params.depth ?? 0.08} onChange={(event) => update(index, { params: { depth: +event.target.value } })} />
              </label>
              <label>光向 {Math.round(effect.params.lightAngle ?? (effect.type === 'emboss' ? 45 : 225))}°
                <input type="range" min={0} max={360} value={effect.params.lightAngle ?? (effect.type === 'emboss' ? 45 : 225)} onChange={(event) => update(index, { params: { lightAngle: +event.target.value } })} />
              </label>
            </>}
            {effect.type === 'matte' && <>
              <label>强度 {Math.round((effect.params.intensity ?? 0.3) * 100)}%
                <input type="range" min={0} max={1} step={0.05} value={effect.params.intensity ?? 0.3} onChange={(event) => update(index, { params: { intensity: +event.target.value } })} />
              </label>
              <label>噪点密度 {Math.round((effect.params.noise ?? 0.5) * 100)}%
                <input type="range" min={0} max={1} step={0.05} value={effect.params.noise ?? 0.5} onChange={(event) => update(index, { params: { noise: +event.target.value } })} />
              </label>
            </>}
            {effect.type === 'uv' && <label>光泽 {Math.round((effect.params.gloss ?? 0.5) * 100)}%
              <input type="range" min={0} max={1} step={0.05} value={effect.params.gloss ?? 0.5} onChange={(event) => update(index, { params: { gloss: +event.target.value } })} />
            </label>}
            {effect.type === 'stroke' && <div className="row2">
              <label>颜色<input type="color" value={effect.params.strokeColor ?? '#222222'} onChange={(event) => update(index, { params: { strokeColor: event.target.value } })} /></label>
              <label>宽度 {effect.params.strokeWidth ?? 4}px<input type="number" min={1} max={40} value={effect.params.strokeWidth ?? 4} onChange={(event) => update(index, { params: { strokeWidth: +event.target.value } })} /></label>
            </div>}
          </div>
        </div>
      ))}
      {adding ? (
        <div className="row wrap">
          {craftTypesForScope(scope).filter((type) => !craft.some((effect) => effect.type === type)).map((type) => <button className="btn ghost sm" type="button" key={type} onClick={() => add(type)}>{CRAFT_LABELS[type]}</button>)}
          <button className="btn ghost sm" type="button" onClick={() => setAdding(false)}>取消</button>
        </div>
      ) : <button className="btn ghost sm" type="button" onClick={() => setAdding(true)}>+ {scope === 'global' ? '全局工艺' : '工艺'}</button>}
    </div>
  )
}
