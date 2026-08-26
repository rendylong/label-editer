import { describe, expect, it } from 'vitest'
import {
  parseNormalizedSvgPath,
  serializeNormalizedSvgPath,
  svgPathBounds,
  traceNormalizedSvgPath,
  type NormalizedSvgPathCommand,
} from '../src/label/svgPath'

describe('normalized SVG path data', () => {
  it('keeps the Lavira copper frame bottom gap open', () => {
    const commands = parseNormalizedSvgPath('M 0.08 0.92 L 0.08 0.08 L 0.92 0.08 L 0.92 0.92')

    expect(commands.at(-1)?.kind).toBe('lineTo')
    expect(commands.some((command) => command.kind === 'close')).toBe(false)
  })

  it('round-trips compound subpaths without implicit close, merge, or reorder', () => {
    const source = 'M .1 .5 C .2 .1 .8 .1 .9 .5 M .2 .8 C .4 .6 .6 .6 .8 .8'
    const commands = parseNormalizedSvgPath(source)

    expect(serializeNormalizedSvgPath(commands)).toBe(source)
    expect(commands.map((command) => command.kind)).toEqual(['moveTo', 'cubicTo', 'moveTo', 'cubicTo'])
  })

  it('resolves relative commands, repeated parameter sets, mixed separators, and exponents', () => {
    const commands = parseNormalizedSvgPath('m1e1,-2 5.5.5 2-1 h3-2 v4,-1 q2 4 4 0 1-2 3-1 c1 0 2 1 3 1')

    expect(commands).toMatchObject([
      { kind: 'moveTo', x: 10, y: -2 },
      { kind: 'lineTo', x: 15.5, y: -1.5 },
      { kind: 'lineTo', x: 17.5, y: -2.5 },
      { kind: 'lineTo', x: 20.5, y: -2.5 },
      { kind: 'lineTo', x: 18.5, y: -2.5 },
      { kind: 'lineTo', x: 18.5, y: 1.5 },
      { kind: 'lineTo', x: 18.5, y: 0.5 },
      { kind: 'quadraticTo', cpx: 20.5, cpy: 4.5, x: 22.5, y: 0.5 },
      { kind: 'quadraticTo', cpx: 23.5, cpy: -1.5, x: 25.5, y: -0.5 },
      { kind: 'cubicTo', cp1x: 26.5, cp1y: -0.5, cp2x: 27.5, cp2y: 0.5, x: 28.5, y: 0.5 },
    ])
  })

  it('retains elliptical arc semantics instead of degrading the segment to a line', () => {
    const commands = parseNormalizedSvgPath('M 0 0 A 50 30 25 0 1 100 0')

    expect(commands.at(-1)).toEqual({
      kind: 'arcTo', rx: 50, ry: 30, rotation: 25, largeArc: false, sweep: true, x: 100, y: 0,
    })
  })

  it.each([
    'M 0 0 S 1 1 2 2',
    'M 0 0 L 1',
    'M 0 0 A 2 2 0 2 0 4 4',
    'M 0 0 A -2 2 0 0 0 4 4',
    'M 0 0 A 0 2 0 0 0 4 4',
    'M 0 0 L Infinity 2',
    'M 0 0 L 1 1 trailing',
    ',M 0 0 L 1 1',
    'M,0 0 L 1 1',
    'M 0 0,L 1 1',
    'M 0 0,Z',
    '<path d="M0 0L1 1"/>',
    'M0 0L1 1 url(javascript:alert(1))',
  ])('rejects unsupported, malformed, or active-content input: %s', (source) => {
    expect(() => parseNormalizedSvgPath(source)).toThrow()
  })

  it('enforces bounded input and emitted command counts', () => {
    expect(() => parseNormalizedSvgPath(`M0 0 ${'L1 1 '.repeat(4096)}`)).toThrow(/4096/)
    expect(() => parseNormalizedSvgPath(`M0 0 ${' '.repeat(131072)}`)).toThrow(/131072/)
  })

  it.each([
    [undefined, 'missing'],
    [[0, 0, 0, 1], 'zero width'],
    [[0, 0, 1, -1], 'negative height'],
    [[0, 0, Number.NaN, 1], 'non-finite width'],
  ] as const)('rejects an invalid path viewBox (%s)', (viewBox, _label) => {
    const commands = parseNormalizedSvgPath('M0 0L1 1')
    expect(() => traceNormalizedSvgPath({
      moveTo: () => undefined,
      lineTo: () => undefined,
      bezierCurveTo: () => undefined,
      closePath: () => undefined,
    }, commands, viewBox as [number, number, number, number], 100, 50)).toThrow()
  })

  it('maps viewBox coordinates into centered layer-local coordinates', () => {
    const calls: unknown[][] = []
    traceNormalizedSvgPath({
      moveTo: (...values) => calls.push(['moveTo', ...values]),
      lineTo: (...values) => calls.push(['lineTo', ...values]),
      bezierCurveTo: (...values) => calls.push(['bezierCurveTo', ...values]),
      closePath: () => calls.push(['closePath']),
    }, parseNormalizedSvgPath('M10 20 L30 60'), [10, 20, 20, 40], 200, 100)

    expect(calls).toEqual([
      ['moveTo', -100, -50],
      ['lineTo', 100, 50],
    ])
  })

  it('includes quadratic, cubic, and arc extrema in finite bounds', () => {
    expect(svgPathBounds(parseNormalizedSvgPath('M0 0 Q50 100 100 0'))).toEqual({ x: 0, y: 0, width: 100, height: 50 })
    expect(svgPathBounds(parseNormalizedSvgPath('M0 0 C0 100 100 100 100 0'))).toEqual({ x: 0, y: 0, width: 100, height: 75 })

    const arcBounds = svgPathBounds(parseNormalizedSvgPath('M0 0 A50 50 0 0 1 100 0'))
    expect(arcBounds.x).toBeCloseTo(0)
    expect(arcBounds.width).toBeCloseTo(100)
    expect(arcBounds.height).toBeCloseTo(50)
    expect(Object.values(arcBounds).every(Number.isFinite)).toBe(true)
  })

  it('serializes a caller-constructed inert command list deterministically', () => {
    const commands: NormalizedSvgPathCommand[] = [
      { kind: 'moveTo', x: 0, y: 0 },
      { kind: 'lineTo', x: 1, y: 1 },
      { kind: 'close' },
    ]
    expect(serializeNormalizedSvgPath(commands)).toBe('M 0 0 L 1 1 Z')
  })
})
