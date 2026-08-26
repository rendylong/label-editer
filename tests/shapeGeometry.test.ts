import { describe, expect, it } from 'vitest'
import { normalizeShapeLayer, shapeCommands, traceShape, type ShapeCommand, type ShapeDrawingContext } from '../src/label/shapeGeometry'
import { validateVectorPath } from '../src/label/vectorPathValidation'
import type { ShapeGeometry, ShapeKind, ShapeLayer } from '../src/label/types'

function makeShape(overrides: Partial<ShapeLayer> & { shape?: ShapeKind; geometry?: ShapeGeometry } = {}): ShapeLayer {
  return {
    id: 'shape-1',
    kind: 'shape',
    shape: 'rectangle',
    geometry: {},
    width: 100,
    height: 60,
    fill: '#111111',
    stroke: '#eeeeee',
    strokeWidth: 2,
    cornerRadius: 0,
    x: 500,
    y: 300,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    craft: [],
    ...overrides,
  }
}

function commandNumbers(command: ShapeCommand): number[] {
  return Object.values(command).filter((value): value is number => typeof value === 'number')
}

function expectCommandsInside(commands: ShapeCommand[], halfWidth: number, halfHeight: number): void {
  for (const command of commands) {
    if (command.type === 'moveTo' || command.type === 'lineTo') {
      expect(Math.abs(command.x)).toBeLessThanOrEqual(halfWidth)
      expect(Math.abs(command.y)).toBeLessThanOrEqual(halfHeight)
    } else if (command.type === 'bezierTo') {
      expect(Math.abs(command.cp1x)).toBeLessThanOrEqual(halfWidth)
      expect(Math.abs(command.cp2x)).toBeLessThanOrEqual(halfWidth)
      expect(Math.abs(command.x)).toBeLessThanOrEqual(halfWidth)
      expect(Math.abs(command.cp1y)).toBeLessThanOrEqual(halfHeight)
      expect(Math.abs(command.cp2y)).toBeLessThanOrEqual(halfHeight)
      expect(Math.abs(command.y)).toBeLessThanOrEqual(halfHeight)
    } else if (command.type === 'arc') {
      expect(Math.abs(command.x) + command.radius).toBeLessThanOrEqual(halfWidth)
      expect(Math.abs(command.y) + command.radius).toBeLessThanOrEqual(halfHeight)
    }
  }
}

function recordShape(layer: ShapeLayer): unknown[][] {
  const calls: unknown[][] = []
  const context: ShapeDrawingContext = {
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    lineTo: (...args) => calls.push(['lineTo', ...args]),
    bezierCurveTo: (...args) => calls.push(['bezierCurveTo', ...args]),
    arc: (...args) => calls.push(['arc', ...args]),
    closePath: () => calls.push(['closePath']),
  }
  traceShape(context, layer)
  return calls
}

describe('shape geometry', () => {
  it.each([
    [0.5, 1, 'M0 0 L1000000000000 0', [0, 0, 0.125, 1] as [number, number, number, number], false],
    [0.5, 0.5, 'M0 0 L0.125 1', [0, 0, 0.125, 1] as [number, number, number, number], true],
    [40, 60, 'M0 0 L1 1', [0, 0, 0, 1] as [number, number, number, number], false],
    [40, 60, 'M0 0 L1 1', [0, 0, 1e19, 1] as [number, number, number, number], false],
    [40, 60, 'M0 0 A1 1 0 0 1 0 0', [0, 0, 1, 1] as [number, number, number, number], false],
    [40, 60, 'M0 0 A1 1 0 0 1 1 1', [0, 0, 1, 1] as [number, number, number, number], true],
  ] as const)('keeps vector validation in parity with renderer-normalized %sx%s geometry', (width, height, pathData, pathViewBox, expectedValid) => {
    const layer = makeShape({ shape: 'path', width, height, pathData, pathViewBox })
    const validationSucceeded = validateVectorPath(pathData, pathViewBox, width, height) === undefined
    let rendererSucceeded = true
    try {
      shapeCommands(layer)
    } catch {
      rendererSucceeded = false
    }

    expect(validationSucceeded).toBe(expectedValid)
    expect(rendererSucceeded).toBe(expectedValid)
  })
  it.each<ShapeKind>([
    'rectangle', 'ellipse', 'triangle', 'diamond', 'polygon', 'star', 'line',
    'wave', 'burst', 'cross', 'bracket', 'dot-grid', 'frame',
  ])('%s produces finite drawing commands inside its centered local box', (shape) => {
    const commands = shapeCommands(makeShape({ shape }))

    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) {
      for (const value of commandNumbers(command)) expect(Number.isFinite(value)).toBe(true)
      if ('x' in command) expect(command.x).toBeGreaterThanOrEqual(-50)
      if ('x' in command) expect(command.x).toBeLessThanOrEqual(50)
      if ('y' in command) expect(command.y).toBeGreaterThanOrEqual(-30)
      if ('y' in command) expect(command.y).toBeLessThanOrEqual(30)
    }
  })

  it('describes a plain rectangle with hand-derived centered coordinates', () => {
    expect(shapeCommands(makeShape({ width: 80, height: 40 }))).toEqual([
      { type: 'moveTo', x: -40, y: -20 },
      { type: 'lineTo', x: 40, y: -20 },
      { type: 'lineTo', x: 40, y: 20 },
      { type: 'lineTo', x: -40, y: 20 },
      { type: 'close' },
    ])
  })

  it('describes a triangle with literal corners at the local bounds', () => {
    expect(shapeCommands(makeShape({ shape: 'triangle', width: 120, height: 80 }))).toEqual([
      { type: 'moveTo', x: 0, y: -40 },
      { type: 'lineTo', x: 60, y: 40 },
      { type: 'lineTo', x: -60, y: 40 },
      { type: 'close' },
    ])
  })

  it('winds a frame inner contour opposite its outer contour so the center stays hollow', () => {
    expect(shapeCommands(makeShape({ shape: 'frame', width: 100, height: 60, geometry: { inset: 10 } }))).toEqual([
      { type: 'moveTo', x: -50, y: -30 },
      { type: 'lineTo', x: 50, y: -30 },
      { type: 'lineTo', x: 50, y: 30 },
      { type: 'lineTo', x: -50, y: 30 },
      { type: 'close' },
      { type: 'moveTo', x: -40, y: -20 },
      { type: 'lineTo', x: -40, y: 20 },
      { type: 'lineTo', x: 40, y: 20 },
      { type: 'lineTo', x: 40, y: -20 },
      { type: 'close' },
    ])
  })

  it('clamps unsafe geometry without mutating the source layer', () => {
    const source = makeShape({
      shape: 'star',
      geometry: {
        sides: 1,
        points: 100,
        innerRatio: 0,
        amplitude: Number.POSITIVE_INFINITY,
        frequency: -2,
        rows: 0,
        columns: 99,
        gap: -1,
        inset: 999,
        dash: [12, -4, Number.NaN],
      },
    })

    expect(normalizeShapeLayer(source).geometry).toEqual({
      sides: 3,
      points: 32,
      innerRatio: 0.05,
      amplitude: 15,
      frequency: 0.5,
      arrowStart: false,
      arrowEnd: false,
      parallel: false,
      dash: [12],
      inset: 30,
      rows: 1,
      columns: 32,
      gap: 0,
    })
    expect(source.geometry).toMatchObject({ points: 100, innerRatio: 0 })
  })

  it('normalizes non-finite and negative dimensions before producing commands', () => {
    const normalized = normalizeShapeLayer(makeShape({ width: Number.NaN, height: -20, cornerRadius: 99 }))

    expect(normalized).toMatchObject({ width: 1, height: 20, cornerRadius: 0.5 })
    expect(JSON.stringify(shapeCommands(normalized))).not.toContain('null')
  })

  it.each<ShapeKind>(['cross', 'dot-grid', 'frame'])('%s stays inside normalized bounds for 0.1 by 0.1 input', (shape) => {
    const source = makeShape({ shape, width: 0.1, height: 0.1 })
    const normalized = normalizeShapeLayer(source)

    expect(normalized).toMatchObject({ width: 1, height: 1 })
    expectCommandsInside(shapeCommands(source), 0.5, 0.5)
  })

  it('normalizes extreme z-indexes to finite safe integers', () => {
    expect(normalizeShapeLayer(makeShape({ zIndex: 1e308 })).zIndex).toBe(Number.MAX_SAFE_INTEGER)
    expect(normalizeShapeLayer(makeShape({ zIndex: -1e308 })).zIndex).toBe(Number.MIN_SAFE_INTEGER)
    expect(Number.isSafeInteger(normalizeShapeLayer(makeShape({ zIndex: 7.8 })).zIndex)).toBe(true)
  })

  it('replays the returned commands on a drawing context in order', () => {
    expect(recordShape(makeShape({ shape: 'triangle', width: 120, height: 80 }))).toEqual([
      ['moveTo', 0, -40],
      ['lineTo', 60, 40],
      ['lineTo', -60, 40],
      ['closePath'],
    ])
  })

  it('replays normalized path geometry without mutating its editable source metadata', () => {
    const source = makeShape({
      shape: 'path',
      width: 100,
      height: 50,
      pathData: 'M 0.08 0.92 L 0.08 0.08 L 0.92 0.08 L 0.92 0.92',
      pathViewBox: [0, 0, 1, 1],
      fillRule: 'evenodd',
    })
    const before = structuredClone(source)

    expect(recordShape(source)).toEqual([
      ['moveTo', -42, 21],
      ['lineTo', -42, -21],
      ['lineTo', 42, -21],
      ['lineTo', 42, 21],
    ])
    expect(source).toEqual(before)
  })

  it('replays the same normalized path at every bake size without persisting derived points', () => {
    const source = makeShape({
      shape: 'path', pathData: 'M0 0L1 1', pathViewBox: [0, 0, 1, 1], width: 1024, height: 512,
    })
    const small = recordShape(source)
    const large = recordShape({ ...source, width: 4096, height: 2048 })

    expect(small).toEqual([['moveTo', -512, -256], ['lineTo', 512, 256]])
    expect(large).toEqual([['moveTo', -2048, -1024], ['lineTo', 2048, 1024]])
    expect(source.pathData).toBe('M0 0L1 1')
    expect(source.pathViewBox).toEqual([0, 0, 1, 1])
  })

  it('replays ellipse bezier commands with literal control points', () => {
    expect(recordShape(makeShape({ shape: 'ellipse', width: 100, height: 60 }))).toEqual([
      ['moveTo', 50, 0],
      ['bezierCurveTo', 50, 16.568542494923808, 27.61423749153968, 30, 0, 30],
      ['bezierCurveTo', -27.61423749153968, 30, -50, 16.568542494923808, -50, 0],
      ['bezierCurveTo', -50, -16.568542494923808, -27.61423749153968, -30, 0, -30],
      ['bezierCurveTo', 27.61423749153968, -30, 50, -16.568542494923808, 50, 0],
      ['closePath'],
    ])
  })

  it('replays rounded rectangle arcs including their direction argument', () => {
    expect(recordShape(makeShape({ width: 40, height: 20, cornerRadius: 5 }))).toEqual([
      ['moveTo', -15, -10],
      ['lineTo', 15, -10],
      ['arc', 15, -5, 5, -Math.PI / 2, 0, undefined],
      ['lineTo', 20, 5],
      ['arc', 15, 5, 5, 0, Math.PI / 2, undefined],
      ['lineTo', -15, 10],
      ['arc', -15, 5, 5, Math.PI / 2, Math.PI, undefined],
      ['lineTo', -20, -5],
      ['arc', -15, -5, 5, Math.PI, Math.PI * 1.5, undefined],
      ['closePath'],
    ])
  })

  it('replays the rounded frame inner arcs anticlockwise', () => {
    const arcs = recordShape(makeShape({ shape: 'frame', width: 40, height: 30, cornerRadius: 6, geometry: { inset: 2 } }))
      .filter(([operation]) => operation === 'arc')

    expect(arcs).toEqual([
      ['arc', 14, -9, 6, -Math.PI / 2, 0, undefined],
      ['arc', 14, 9, 6, 0, Math.PI / 2, undefined],
      ['arc', -14, 9, 6, Math.PI / 2, Math.PI, undefined],
      ['arc', -14, -9, 6, Math.PI, Math.PI * 1.5, undefined],
      ['arc', -14, -9, 4, -Math.PI / 2, -Math.PI, true],
      ['arc', -14, 9, 4, Math.PI, Math.PI / 2, true],
      ['arc', 14, 9, 4, Math.PI / 2, 0, true],
      ['arc', 14, -9, 4, 0, -Math.PI / 2, true],
    ])
  })
})
