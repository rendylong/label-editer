import { describe, expect, it } from 'vitest'
// @ts-expect-error MCP server is directly executable ESM.
import { createLabelMcpServer } from '../scripts/mcp-server.mjs'

describe('label editor MCP surface', () => {
  it('registers only the six coarse-grained Agent tools', () => {
    const server = createLabelMcpServer({ operations: {} })
    expect(server.registeredToolNames()).toEqual([
      'inspect_model',
      'validate_label_spec',
      'apply_label_spec',
      'render_label_preview',
      'export_label_assets',
      'open_label_editor',
    ])
  })

  it('returns the operation envelope as structured content', async () => {
    const server = createLabelMcpServer({
      operations: {
        inspect: async () => ({ ok: true, operation: 'inspect_model', data: { meshes: 2 }, warnings: [] }),
      },
    })
    const result = await server.invokeForTest('inspect_model', { glb_path: 'bottle.glb' })
    expect(result.structuredContent).toEqual({ ok: true, operation: 'inspect_model', data: { meshes: 2 }, warnings: [] })
    expect(result.content[0].text).toContain('inspect_model')
  })
})
