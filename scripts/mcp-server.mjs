#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { pathToFileURL } from 'node:url'
import { createOperations } from './lib/operations.mjs'
import { createPluginRuntime } from './plugin-runtime.mjs'

function resultFor(envelope) {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: !envelope.ok,
  }
}

export function createLabelMcpServer({ operations, runtime } = {}) {
  const mcp = new McpServer({ name: 'glb-label-editor', version: '0.2.0' })
  const handlers = new Map()

  function register(name, config, invoke) {
    handlers.set(name, invoke)
    mcp.registerTool(name, config, async (input) => resultFor(await invoke(input)))
  }

  register('inspect_model', {
    title: 'Inspect GLB model',
    description: 'Inspect a GLB and return stable mesh selectors, label candidates, mapping suggestions, dimensions, and codec status.',
    inputSchema: { glb_path: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, ({ glb_path }) => operations.inspect({ glbPath: glb_path }))

  register('validate_label_spec', {
    title: 'Validate label specification',
    description: 'Validate inline Label Spec v2 or a local spec file, optionally against a GLB. Does not publish files.',
    inputSchema: {
      spec: z.unknown().optional(),
      spec_path: z.string().min(1).optional(),
      glb_path: z.string().min(1).optional(),
    },
    annotations: { readOnlyHint: true },
  }, ({ spec, spec_path, glb_path }) => operations.validate({ spec, specPath: spec_path, glbPath: glb_path }))

  register('apply_label_spec', {
    title: 'Apply label specification',
    description: 'Run the complete transaction and atomically publish labeled GLB, project, preview, PBR channels, print manifest, and artifact manifest.',
    inputSchema: {
      glb_path: z.string().min(1), spec: z.unknown().optional(), spec_path: z.string().min(1).optional(),
      output_dir: z.string().min(1), force: z.boolean().optional(), open_editor: z.boolean().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, ({ glb_path, spec, spec_path, output_dir, force, open_editor }) => operations.apply({
    glbPath: glb_path, spec, specPath: spec_path, outputDir: output_dir,
    force: force ?? false, openEditor: open_editor ?? false,
  }))

  register('render_label_preview', {
    title: 'Render label preview',
    description: 'Render a 2D, split, or 3D preview from a local Label Spec and GLB.',
    inputSchema: {
      input_path: z.string().min(1), glb_path: z.string().min(1), output_path: z.string().min(1),
      view: z.enum(['2d', 'split', '3d']).optional(),
    },
    annotations: { readOnlyHint: false },
  }, ({ input_path, glb_path, output_path, view }) => operations.preview({
    inputPath: input_path, glbPath: glb_path, outputPath: output_path, view: view ?? '3d',
  }))

  register('export_label_assets', {
    title: 'Export label assets',
    description: 'Export a saved label project or specification with its source GLB to a local output directory.',
    inputSchema: {
      project_path: z.string().min(1), glb_path: z.string().min(1), output_dir: z.string().min(1), force: z.boolean().optional(),
    },
    annotations: { destructiveHint: false },
  }, ({ project_path, glb_path, output_dir, force }) => operations.export({
    projectPath: project_path, glbPath: glb_path, outputDir: output_dir, force: force ?? false,
  }))

  register('open_label_editor', {
    title: 'Open label editor',
    description: 'Open a tokenized loopback editor URL for human review and takeover of a Label Spec and GLB.',
    inputSchema: { input_path: z.string().min(1), glb_path: z.string().min(1) },
    annotations: { readOnlyHint: false },
  }, ({ input_path, glb_path }) => operations.open({ inputPath: input_path, glbPath: glb_path }))

  return {
    registeredToolNames: () => [...handlers.keys()],
    invokeForTest: async (name, input) => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`Unknown test tool: ${name}`)
      return resultFor(await handler(input))
    },
    connect: (transport) => mcp.connect(transport),
    async close() {
      await mcp.close()
      if (runtime) await runtime.close()
    },
  }
}

async function main() {
  const runtime = await createPluginRuntime()
  const operations = createOperations(runtime, { progress: (message) => process.stderr.write(`${message}\n`) })
  const server = createLabelMcpServer({ operations, runtime })
  const shutdown = async () => {
    await server.close().catch(() => undefined)
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
