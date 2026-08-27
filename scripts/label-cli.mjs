#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { exitCodeForEnvelope, failure } from './lib/envelope.mjs'

const valueOptions = new Set(['glb', 'output', 'view', 'operations', 'preset', 'camera-config', 'width', 'height'])
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
  const seenOptions = new Set()
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positional.push(value)
      continue
    }
    const name = value.slice(2)
    if (seenOptions.has(name) && command === 'review') throw usageError(`Duplicate option: --${name}`)
    seenOptions.add(name)
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

function parseDimension(value, name, defaultValue = 1440) {
  if (value === undefined) return defaultValue
  if (!/^\d+$/.test(value)) throw usageError(`--${name} must be an integer from 1 to 4096`)
  const number = Number(value)
  if (number < 1 || number > 4096) throw usageError(`--${name} must be an integer from 1 to 4096`)
  return number
}

function assertShape(parsed) {
  const { command, positional, options } = parsed
  if (command === 'schema') {
    if (positional.length !== 0) throw usageError('schema accepts no positional arguments')
    return
  }
  if (!['inspect', 'project', 'patch', 'validate', 'apply', 'preview', 'qc', 'review', 'live', 'export', 'open'].includes(command)) {
    throw usageError(`Unknown command: ${command}`)
  }
  if (positional.length !== 1) throw usageError(`${command} requires exactly one input path`)
  if (command === 'review') {
    const allowed = new Set(['glb', 'output', 'width', 'height', 'force', 'json'])
    const unsupported = Object.keys(options).find((name) => !allowed.has(name))
    if (unsupported) throw usageError(`--${unsupported} is not supported by review`)
    if (!options.glb) throw usageError('review requires --glb <model.glb>')
    if (!options.output) throw usageError('review requires --output <directory>')
    options.width = parseDimension(options.width, 'width', 1600)
    options.height = parseDimension(options.height, 'height', 1600)
    return
  }
  if (command !== 'qc' && options['camera-config']) {
    throw usageError('--camera-config is only supported by qc')
  }
  if (command === 'inspect') return
  if (command === 'project') return
  if (command === 'patch') {
    if (!options.operations) throw usageError('patch requires --operations <operations.json>')
    if (!options.output) throw usageError('patch requires --output <patched-spec.json>')
    return
  }
  if (command === 'validate') return
  if (command === 'live') {
    if (!options.glb) throw usageError('live requires --glb <model.glb>')
    return
  }
  if (!options.glb) throw usageError(`${command} requires --glb <model.glb>`)
  if (command === 'open') return
  if (!options.output) throw usageError(`${command} requires --output <path>`)
  if (command === 'qc' && options.preset !== undefined && options.preset !== 'qc-standard') {
    throw usageError('--preset must be qc-standard')
  }
  if (command === 'qc') {
    options.width = parseDimension(options.width, 'width')
    options.height = parseDimension(options.height, 'height')
  }
  if (command === 'preview' && options.view && !['2d', 'split', '3d'].includes(options.view)) {
    throw usageError('--view must be 2d, split, or 3d')
  }
}

async function invoke(parsed, operations) {
  const input = parsed.positional[0]
  const options = parsed.options
  if (parsed.command === 'schema') return operations.schema({})
  if (parsed.command === 'inspect') return operations.inspect({ glbPath: input })
  if (parsed.command === 'project') return operations.project({ inputPath: input })
  if (parsed.command === 'patch') return operations.patch({
    inputPath: input,
    operationsPath: options.operations,
    outputPath: options.output,
    force: options.force === true,
  })
  if (parsed.command === 'validate') return operations.validate({ specPath: input, glbPath: options.glb })
  if (parsed.command === 'live') return operations.live({ specPath: input, glbPath: options.glb })
  if (parsed.command === 'apply') return operations.apply({ specPath: input, glbPath: options.glb, outputDir: options.output, force: options.force === true, openEditor: options.open === true })
  if (parsed.command === 'preview') return operations.preview({ inputPath: input, glbPath: options.glb, outputPath: options.output, view: options.view ?? '3d' })
  if (parsed.command === 'qc') return operations.qc({
    inputPath: input,
    glbPath: options.glb,
    outputDir: options.output,
    preset: options.preset ?? 'qc-standard',
    cameraConfigPath: options['camera-config'],
    width: options.width,
    height: options.height,
    force: options.force === true,
  })
  if (parsed.command === 'review') return operations.review({
    inputPath: input,
    glbPath: options.glb,
    outputDir: options.output,
    width: options.width,
    height: options.height,
    force: options.force === true,
  })
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
      const { createOperations } = await import('./lib/operations.mjs')
      if (['schema', 'project', 'patch'].includes(parsed.command)) {
        operations = createOperations(undefined, {
          progress: stderr,
          allowedRoots: dependencies.runtimeOptions?.allowedRoots,
        })
      } else {
        const { createPluginRuntime } = await import('./plugin-runtime.mjs')
        const runtimeOptions = parsed.command === 'live'
          ? {
              ...dependencies.runtimeOptions,
              headless: false,
              browserQuery: { ...dependencies.runtimeOptions?.browserQuery, 'agent-preview': '1' },
            }
          : dependencies.runtimeOptions
        runtime = await createPluginRuntime(runtimeOptions)
        operations = createOperations(runtime, {
          progress: stderr,
          onFatal: dependencies.onFatal ?? (async (error) => {
            stderr(`live fatal: ${error instanceof Error ? error.message : String(error)}`)
            process.exitCode = 6
            await runtime.close()
          }),
        })
      }
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
