function pickerHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value)
  return shortHex ? `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}` : '#000000'
}

export function CssColorField({
  label,
  ariaLabel,
  value,
  onChange,
  palette = [],
}: {
  label: string
  ariaLabel: string
  value: string
  onChange: (value: string) => void
  palette?: readonly string[]
}): React.JSX.Element {
  return <label className="css-color-field">
    {label}
    {palette.length > 0 && <div className="swatches">
      {palette.map((color) => <button type="button" key={color} className={`swatch ${value === color ? 'active' : ''}`} style={{ background: color }} onClick={() => onChange(color)} title={color} />)}
    </div>}
    <div className="css-color-controls">
      <input aria-label={ariaLabel} type="text" value={value} maxLength={64} onInput={(event) => onChange(event.currentTarget.value)} />
      <span className="css-color-preview" style={{ background: value }} aria-hidden="true" />
      <input aria-label={`${ariaLabel}取色器`} type="color" value={pickerHex(value)} onChange={(event) => onChange(event.target.value)} title="取色器（写入十六进制颜色）" />
    </div>
  </label>
}
