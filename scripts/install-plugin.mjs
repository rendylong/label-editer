#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_ID = 'glb-label-editor@label-editer'
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const runtimeEntries = [
  '.codex-plugin',
  '.mcp.json',
  'INSTALL_WITH_AGENT.md',
  'README.md',
  'index.html',
  'npm-shrinkwrap.json',
  'package.json',
  'public',
  'scripts',
  'skills',
  'src',
  'tsconfig.json',
  'vite.config.ts',
]

function usage() {
  return `Install GLB Label Editor into Codex.

Usage:
  glb-label-editor-install [--install-root PATH] [--source PATH] [--json]

Options:
  --install-root PATH  Managed installation directory (default: ~/.codex/glb-label-editor)
  --source PATH        Plugin source directory (default: package containing this installer)
  --json               Print the final result as JSON
  -h, --help           Show this help
`
}

function parseArgs(argv) {
  const options = { sourceRoot: scriptRoot, installRoot: undefined, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') options.json = true
    else if (argument === '-h' || argument === '--help') options.help = true
    else if (argument === '--source' || argument === '--install-root') {
      const value = argv[index + 1]
      if (!value) throw new Error(`${argument} requires a path`)
      if (argument === '--source') options.sourceRoot = path.resolve(value)
      else options.installRoot = path.resolve(value)
      index += 1
    } else {
      throw new Error(`Unknown option: ${argument}`)
    }
  }
  return options
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const details = `\n${result.stderr || result.stdout}`.trimEnd()
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${details}`)
  }
  if (!options.capture) {
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  return options.capture ? result.stdout : ''
}

function runJson(command, args, options = {}) {
  const stdout = run(command, args, { ...options, capture: true })
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${command} returned invalid JSON`)
  }
}

function validateNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10)
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22 or newer is required; found ${process.version}`)
  }
}

function validateInstallRoot(installRoot) {
  const parsed = path.parse(installRoot)
  const home = path.resolve(process.env.HOME || os.homedir())
  if (installRoot === parsed.root || installRoot === home) {
    throw new Error(`Refusing unsafe install root: ${installRoot}`)
  }
}

async function copyRuntime(sourceRoot, runtimeRoot) {
  for (const required of ['.codex-plugin/plugin.json', 'package.json', 'npm-shrinkwrap.json', 'scripts/mcp-server.mjs', 'skills']) {
    if (!existsSync(path.join(sourceRoot, required))) {
      throw new Error(`Plugin source is missing ${required}: ${sourceRoot}`)
    }
  }

  await mkdir(runtimeRoot, { recursive: true })
  for (const entry of runtimeEntries) {
    const source = path.join(sourceRoot, entry)
    if (existsSync(source)) {
      await cp(source, path.join(runtimeRoot, entry), { recursive: true })
    }
  }
}

async function prepareRuntime(runtimeRoot, progress) {
  progress('Installing locked dependencies…')
  run('npm', ['ci', '--include=dev'], { cwd: runtimeRoot })
  progress('Building the editor runtime…')
  run('npm', ['run', 'build'], { cwd: runtimeRoot })
  progress('Installing Chromium for preview rendering…')
  run('npm', ['run', 'install:browser'], { cwd: runtimeRoot })

  if (!existsSync(path.join(runtimeRoot, 'dist/index.html'))) {
    throw new Error('Build completed without dist/index.html')
  }
}

async function writePluginWrapper(stageRoot, finalInstallRoot) {
  const pluginRoot = path.join(stageRoot, 'plugin')
  const finalRuntimeRoot = path.join(finalInstallRoot, 'runtime')
  await mkdir(pluginRoot, { recursive: true })
  await cp(path.join(stageRoot, 'runtime/.codex-plugin'), path.join(pluginRoot, '.codex-plugin'), { recursive: true })
  await cp(path.join(stageRoot, 'runtime/skills'), path.join(pluginRoot, 'skills'), { recursive: true })
  await writeFile(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      'glb-label-editor': {
        command: process.execPath,
        args: [path.join(finalRuntimeRoot, 'scripts/mcp-server.mjs')],
        cwd: finalRuntimeRoot,
      },
    },
  }, null, 2)}\n`)

  const marketplaceDir = path.join(stageRoot, '.agents/plugins')
  await mkdir(marketplaceDir, { recursive: true })
  await writeFile(path.join(marketplaceDir, 'marketplace.json'), `${JSON.stringify({
    name: 'label-editer',
    interface: { displayName: 'GLB Label Editor' },
    plugins: [{
      name: 'glb-label-editor',
      source: { source: 'local', path: './plugin' },
      description: 'Design, preview, validate, and export cosmetic labels on GLB packaging.',
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Design',
    }],
  }, null, 2)}\n`)
}

function normalizePath(value) {
  return value ? path.resolve(value) : undefined
}

function registerWithCodex(installRoot, progress) {
  progress('Registering the local marketplace…')
  const marketplaceState = runJson('codex', ['plugin', 'marketplace', 'list', '--json'])
  const existingMarketplace = marketplaceState.marketplaces?.find((entry) => entry.name === 'label-editer')
  if (existingMarketplace && normalizePath(existingMarketplace.root) !== installRoot) {
    throw new Error(`Codex marketplace "label-editer" already points to ${existingMarketplace.root}`)
  }
  if (!existingMarketplace) {
    run('codex', ['plugin', 'marketplace', 'add', installRoot, '--json'])
  }

  const pluginState = runJson('codex', ['plugin', 'list', '--json'])
  if (pluginState.installed?.some((entry) => entry.pluginId === PLUGIN_ID)) {
    progress('Refreshing the existing plugin installation…')
    run('codex', ['plugin', 'remove', PLUGIN_ID, '--json'])
  }
  run('codex', ['plugin', 'add', PLUGIN_ID, '--json'])
}

async function install(options) {
  validateNodeVersion()
  const sourceRoot = await realpath(path.resolve(options.sourceRoot))
  const requestedInstallRoot = path.resolve(
    options.installRoot || path.join(process.env.HOME || os.homedir(), '.codex', 'glb-label-editor'),
  )
  validateInstallRoot(requestedInstallRoot)

  const progress = options.json
    ? (message) => process.stderr.write(`[glb-label-editor] ${message}\n`)
    : (message) => process.stdout.write(`${message}\n`)
  const requestedParent = path.dirname(requestedInstallRoot)
  await mkdir(requestedParent, { recursive: true })
  const parent = await realpath(requestedParent)
  const installRoot = path.join(parent, path.basename(requestedInstallRoot))
  validateInstallRoot(installRoot)
  const stageRoot = await mkdtemp(path.join(parent, `.${path.basename(installRoot)}.tmp-`))
  let backupRoot

  try {
    progress('Preparing the managed plugin runtime…')
    await copyRuntime(sourceRoot, path.join(stageRoot, 'runtime'))
    await prepareRuntime(path.join(stageRoot, 'runtime'), progress)
    await writePluginWrapper(stageRoot, installRoot)

    if (existsSync(installRoot)) {
      backupRoot = `${installRoot}.backup-${Date.now()}`
      await rename(installRoot, backupRoot)
    }
    await rename(stageRoot, installRoot)

    try {
      registerWithCodex(installRoot, progress)
    } catch (error) {
      await rm(installRoot, { recursive: true, force: true })
      if (backupRoot) await rename(backupRoot, installRoot)
      throw error
    }
    if (backupRoot) await rm(backupRoot, { recursive: true, force: true })

    return {
      ok: true,
      pluginId: PLUGIN_ID,
      installRoot,
      restartRequired: true,
    }
  } catch (error) {
    if (existsSync(stageRoot)) await rm(stageRoot, { recursive: true, force: true })
    throw error
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(usage())
      return
    }
    const result = await install(options)
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`)
    else {
      process.stdout.write('\nGLB Label Editor is installed. Start a new Codex session to load its skills and MCP tools.\n')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (options?.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    else process.stderr.write(`Installation failed: ${message}\n`)
    process.exitCode = 1
  }
}

await main()
