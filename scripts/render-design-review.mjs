#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { exitCodeForEnvelope, failure, success } from './lib/envelope.mjs'
import { renderDesignReview as defaultRenderDesignReview } from './lib/design-review.mjs'

function usageError(message) {
  const error = new Error(message)
  error.code = 'INVALID_USAGE'
  return error
}

function parseNumber(value, name, { integer = false, minimum = 0, maximum = Infinity } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < minimum || parsed > maximum) {
    throw usageError(`--${name} has an invalid value`)
  }
  return parsed
}

function parseArgv(argv) {
  const positional = []
  const options = { reference: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) { positional.push(value); continue }
    const name = value.slice(2)
    if (name === 'json' || name === 'force') { options[name] = true; continue }
    if (!['output', 'width', 'height', 'px-per-mm', 'reference'].includes(name)) throw usageError(`Unknown option: --${name}`)
    const next = argv[++index]
    if (!next || next.startsWith('--')) throw usageError(`Option --${name} requires a value`)
    if (name === 'reference') options.reference.push(next)
    else options[name] = next
  }
  if (positional.length !== 1) throw usageError('Exactly one layout-blueprint.json path is required')
  if (!options.output) throw usageError('--output is required')
  return {
    blueprintPath: positional[0], outputDir: options.output,
    width: options.width === undefined ? 1600 : parseNumber(options.width, 'width', { integer: true, minimum: 1, maximum: 4096 }),
    height: options.height === undefined ? 1200 : parseNumber(options.height, 'height', { integer: true, minimum: 1, maximum: 4096 }),
    pxPerMm: options['px-per-mm'] === undefined ? 5 : parseNumber(options['px-per-mm'], 'px-per-mm', { minimum: Number.EPSILON, maximum: 100 }),
    referencePaths: options.reference, force: options.force === true, json: options.json === true,
  }
}

export async function runDesignReviewCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(`${value}\n`))
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(`${value}\n`))
  let parsed
  let envelope
  try {
    parsed = parseArgv(argv)
    const renderDesignReview = dependencies.renderDesignReview ?? defaultRenderDesignReview
    const result = await renderDesignReview(parsed)
    envelope = success('render_design_review', {
      outputDir: result.outputDir,
      artifacts: result.artifacts,
      manifest: result.manifest,
    })
  } catch (error) {
    envelope = failure('render_design_review', error)
  }
  stdout(JSON.stringify(envelope, null, parsed?.json ? 0 : 2))
  return exitCodeForEnvelope(envelope)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runDesignReviewCli(process.argv.slice(2))
}
