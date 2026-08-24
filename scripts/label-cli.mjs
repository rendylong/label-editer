#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { exitCodeForEnvelope, failure } from './lib/envelope.mjs'

const valueOptions = new Set(['glb', 'output', 'view'])
const booleanOptions = new Set(['json', 'force', 'open'])

function usageError(message) {
  const error = new Error(message)
  error.code = 'INVALID_USAGE'
  return error
}

function parseArgv(argv) {
  const command = argv[0]
  if (!command) throw usageError('A command is required')
  const positional = []
  const options = {}
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positional.push(value)
      continue
    }
    const name = value.slice(2)
    if (booleanOptions.has(name)) {
      options[name] = true
      continue
    }
    if (!valueOptions.has(name)) throw usageError(`Unknown option: --${name}`)
    const next = argv[++index]
    if (!next || next.startsWith('--')) throw usageError(`Option --${name} requires a value`)
    options[name] = next
  }
  return { command, positional, options }
}

function assertShape(parsed) {
  const { command, positional, options } = parsed
  if (command === 'schema') {
    if (positional.length !== 0) throw usageError('schema accepts no positional arguments')
    return
  }
  if (!['inspect', 'validate', 'apply', 'preview', 'export', 'open'].includes(command)) {
    throw usageError(`Unknown command: ${command}`)
  }
  if (positional.length !== 1) throw usageError(`${command} requires exactly one input path`)
  if (command === 'inspect') return
  if (command === 'validate') return
  if (!options.glb) throw usageError(`${command} requires --glb <model.glb>`)
  if (command === 'open') return
  if (!options.output) throw usageError(`${command} requires --output <path>`)
  if (command === 'preview' && options.view && !['2d', 'split', '3d'].includes(options.view)) {
    throw usageError('--view must be 2d, split, or 3d')
  }
}

async function invoke(parsed, operations) {
  const input = parsed.positional[0]
  const options = parsed.options
  if (parsed.command === 'schema') return operations.schema({})
  if (parsed.command === 'inspect') return operations.inspect({ glbPath: input })
  if (parsed.command === 'validate') return operations.validate({ specPath: input, glbPath: options.glb })
  if (parsed.command === 'apply') return operations.apply({ specPath: input, glbPath: options.glb, outputDir: options.output, force: options.force === true, openEditor: options.open === true })
  if (parsed.command === 'preview') return operations.preview({ inputPath: input, glbPath: options.glb, outputPath: options.output, view: options.view ?? '3d' })
  if (parsed.command === 'export') return operations.export({ projectPath: input, glbPath: options.glb, outputDir: options.output, force: options.force === true })
  return operations.open({ inputPath: input, glbPath: options.glb })
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(`${value}\n`))
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(`${value}\n`))
  let runtime
  let parsed
  let envelope
  try {
    parsed = parseArgv(argv)
    assertShape(parsed)
    let operations = dependencies.operations
    if (!operations) {
      const [{ createPluginRuntime }, { createOperations }] = await Promise.all([
        import('./plugin-runtime.mjs'),
        import('./lib/operations.mjs'),
      ])
      runtime = await createPluginRuntime(dependencies.runtimeOptions)
      operations = createOperations(runtime, { progress: stderr })
    }
    envelope = await invoke(parsed, operations)
  } catch (error) {
    envelope = failure(parsed?.command ?? 'cli', error)
  }
  const keepAlive = envelope?.ok && envelope.data?.keepAlive === true
  if (runtime && !keepAlive) {
    await runtime.close().catch((error) => stderr(`cleanup: ${error instanceof Error ? error.message : String(error)}`))
  } else if (runtime && keepAlive) {
    const close = async () => {
      await runtime.close().catch(() => undefined)
      process.exit(0)
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  }
  stdout(JSON.stringify(envelope, null, parsed?.options.json ? 0 : 2))
  return exitCodeForEnvelope(envelope)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
