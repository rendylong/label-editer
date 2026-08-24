import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('application shell', () => {
  it('declares a bundled favicon so a clean browser load has no missing-icon request', () => {
    const html = readFileSync(resolve('index.html'), 'utf8')
    const href = html.match(/<link[^>]+rel=["']icon["'][^>]+href=["']([^"']+)["']/)?.[1]

    expect(href).toBe('/favicon.svg')
    expect(existsSync(resolve('public', href!.slice(1)))).toBe(true)
  })
})
