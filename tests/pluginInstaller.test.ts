import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '..')

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, `#!/bin/sh\nset -eu\n${body}\n`)
  await chmod(filePath, 0o755)
}

async function createPluginSource(root: string): Promise<void> {
  for (const directory of [
    '.codex-plugin',
    'assets',
    'public',
    'scripts',
    'skills/cosmetic-label',
    'skills/cosmetic-label-editor',
    'skills/cosmetic-label-editor/references',
    'src',
  ]) {
    await mkdir(path.join(root, directory), { recursive: true })
  }

  await writeFile(path.join(root, '.codex-plugin/plugin.json'), JSON.stringify({
    name: 'glb-label-editor',
    version: '0.3.0',
    skills: './skills/',
    interface: {
      composerIcon: './assets/icon.png',
      logo: './assets/icon.png',
    },
  }))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'glb-label-editor' }))
  await writeFile(path.join(root, 'npm-shrinkwrap.json'), JSON.stringify({
    name: 'glb-label-editor',
    lockfileVersion: 3,
    packages: {},
  }))
  await writeFile(path.join(root, 'index.html'), '<main>editor</main>')
  await writeFile(path.join(root, 'README.md'), '# English')
  await writeFile(path.join(root, 'README.zh-CN.md'), '# Chinese')
  await writeFile(path.join(root, 'README.ja.md'), '# Japanese')
  await writeFile(path.join(root, 'README.fr.md'), '# French')
  await writeFile(path.join(root, 'tsconfig.json'), '{}')
  await writeFile(path.join(root, 'vite.config.ts'), 'export default {}')
  await writeFile(path.join(root, 'PRIVACY.md'), '# Privacy')
  await writeFile(path.join(root, 'SUPPORT.md'), '# Support')
  await writeFile(path.join(root, 'TERMS.md'), '# Terms')
  await writeFile(path.join(root, 'assets/icon.png'), 'icon')
  await writeFile(path.join(root, 'public/asset.txt'), 'asset')
  await writeFile(path.join(root, 'scripts/label-cli.mjs'), `#!/usr/bin/env node
const command = process.argv[2]
if (command !== 'schema') process.exit(2)
process.stdout.write(JSON.stringify({ ok: true, operation: 'schema', data: { schema: {}, cwd: process.cwd() }, warnings: [] }) + '\\n')
`)
  await chmod(path.join(root, 'scripts/label-cli.mjs'), 0o755)
  await writeFile(path.join(root, 'skills/cosmetic-label/SKILL.md'), '# design')
  await writeFile(path.join(root, 'skills/cosmetic-label-editor/SKILL.md'), '# editor')
  await writeFile(
    path.join(root, 'skills/cosmetic-label-editor/references/quality-control.md'),
    '# Quality control fixture',
  )
  await writeFile(path.join(root, 'src/main.ts'), 'export {}')
}

describe('GLB label editor installer', () => {
  it('packages a deterministic lockfile and executable installer entrypoint', () => {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    const pack = JSON.parse(result.stdout)[0]
    const files = new Map<string, number>(
      pack.files.map((entry: { path: string; mode: number }) => [entry.path, entry.mode]),
    )
    expect(files.has('npm-shrinkwrap.json')).toBe(true)
    expect(files.has('INSTALL_WITH_AGENT.md')).toBe(true)
    expect(files.has('README.md')).toBe(true)
    expect(files.has('README.zh-CN.md')).toBe(true)
    expect(files.has('README.ja.md')).toBe(true)
    expect(files.has('README.fr.md')).toBe(true)
    expect(files.has('PRIVACY.md')).toBe(true)
    expect(files.has('SUPPORT.md')).toBe(true)
    expect(files.has('TERMS.md')).toBe(true)
    expect(files.has('assets/icon.png')).toBe(true)
    expect(files.has('docs/plugin-directory-submission.md')).toBe(true)
    expect(files.has('skills/cosmetic-label-editor/references/quality-control.md')).toBe(true)
    expect(files.get('scripts/install-plugin.mjs')).toBe(0o755)
    for (const runtimeEntry of [
      'scripts/generate-label-validator.mjs',
      'scripts/label-cli.mjs',
      'scripts/plugin-runtime.mjs',
      'scripts/render-design-review.mjs',
      'scripts/write-build-fingerprint.mjs',
      'scripts/lib/build-fingerprint.mjs',
    ]) {
      expect(files.has(runtimeEntry), runtimeEntry).toBe(true)
    }
    expect(files.has('.mcp.json')).toBe(false)
    expect(files.has('scripts/mcp-server.mjs')).toBe(false)

    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    const shrinkwrap = JSON.parse(readFileSync(path.join(repoRoot, 'npm-shrinkwrap.json'), 'utf8'))
    const pluginManifest = JSON.parse(
      readFileSync(path.join(repoRoot, '.codex-plugin/plugin.json'), 'utf8'),
    )
    expect(packageJson.version).toBe('0.3.0')
    expect(shrinkwrap.version).toBe(packageJson.version)
    expect(shrinkwrap.packages[''].version).toBe(packageJson.version)
    expect(pluginManifest.version).toBe(packageJson.version)
    expect(JSON.stringify(shrinkwrap)).not.toContain('registry.npmmirror.com')
    const lockedPaths = Object.keys(shrinkwrap.packages)
    expect(lockedPaths.some((entry) => entry.startsWith('..'))).toBe(false)
    for (const dependency of Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })) {
      expect(lockedPaths).toContain(`node_modules/${dependency}`)
    }
  }, 30_000)

  it('prepares a runnable plugin source and registers it with Codex', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-installer-'))
    const sourceRoot = path.join(root, 'source')
    const installRoot = path.join(root, 'managed-install')
    const fakeBin = path.join(root, 'bin')
    const commandLog = path.join(root, 'commands.log')
    await mkdir(sourceRoot)
    await mkdir(fakeBin)
    await createPluginSource(sourceRoot)

    await writeExecutable(path.join(fakeBin, 'npm'), `
printf 'npm %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$*" in
  *"run build"*) mkdir -p dist; printf '<main>built</main>\\n' > dist/index.html ;;
esac
`)
    await writeExecutable(path.join(fakeBin, 'codex'), `
printf 'codex %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "$*" in
  "plugin marketplace list --json") printf '{"marketplaces":[]}\\n' ;;
  "plugin list --json") printf '{"installed":[]}\\n' ;;
  "mcp list --json") printf '[]\\n' ;;
  *) printf '{}\\n' ;;
esac
`)

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/install-plugin.mjs'),
      '--source', sourceRoot,
      '--install-root', installRoot,
      '--json',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_COMMAND_LOG: commandLog,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    const canonicalInstallRoot = await realpath(installRoot)
    const response = JSON.parse(result.stdout)
    expect(response).toMatchObject({
      ok: true,
      pluginId: 'glb-label-editor@label-editer',
      installRoot: canonicalInstallRoot,
      restartRequired: true,
    })

    await expect(readFile(path.join(installRoot, 'runtime/dist/index.html'), 'utf8'))
      .resolves.toContain('built')
    await expect(readFile(path.join(installRoot, 'runtime/scripts/label-cli.mjs'), 'utf8'))
      .resolves.toContain("command !== 'schema'")
    await expect(readFile(path.join(installRoot, 'runtime/README.md'), 'utf8'))
      .resolves.toBe('# English')
    await expect(readFile(path.join(installRoot, 'runtime/README.zh-CN.md'), 'utf8'))
      .resolves.toBe('# Chinese')
    await expect(readFile(path.join(installRoot, 'runtime/README.ja.md'), 'utf8'))
      .resolves.toBe('# Japanese')
    await expect(readFile(path.join(installRoot, 'runtime/README.fr.md'), 'utf8'))
      .resolves.toBe('# French')
    await expect(readFile(path.join(installRoot, 'plugin/assets/icon.png'), 'utf8'))
      .resolves.toBe('icon')
    await expect(readFile(
      path.join(installRoot, 'plugin/skills/cosmetic-label-editor/references/quality-control.md'),
      'utf8',
    )).resolves.toBe('# Quality control fixture')

    const installedManifest = JSON.parse(
      await readFile(path.join(installRoot, 'plugin/.codex-plugin/plugin.json'), 'utf8'),
    )
    expect(installedManifest.interface).toMatchObject({
      composerIcon: './assets/icon.png',
      logo: './assets/icon.png',
    })
    expect(installedManifest).not.toHaveProperty('mcpServers')

    await expect(readFile(path.join(installRoot, 'plugin/.mcp.json'), 'utf8')).rejects.toThrow()
    const launcherPath = path.join(installRoot, 'plugin/bin/label-cli.mjs')
    const callerRoot = path.join(root, 'caller-workspace')
    await mkdir(callerRoot)
    expect((await stat(launcherPath)).mode & 0o111).not.toBe(0)
    const launcherResult = spawnSync(process.execPath, [launcherPath, 'schema', '--json'], {
      cwd: callerRoot,
      encoding: 'utf8',
    })
    expect(launcherResult.status, launcherResult.stderr).toBe(0)
    expect(JSON.parse(launcherResult.stdout)).toMatchObject({
      ok: true,
      operation: 'schema',
      data: { cwd: await realpath(callerRoot) },
    })
    expect(await readFile(launcherPath, 'utf8')).toContain(path.join(canonicalInstallRoot, 'runtime/scripts/label-cli.mjs'))

    const marketplace = JSON.parse(
      await readFile(path.join(installRoot, '.agents/plugins/marketplace.json'), 'utf8'),
    )
    expect(marketplace.name).toBe('label-editer')
    expect(marketplace.plugins[0]).toMatchObject({
      name: 'glb-label-editor',
      source: { source: 'local', path: './plugin' },
    })

    const commands = await readFile(commandLog, 'utf8')
    expect(commands).toContain('npm ci --include=dev')
    expect(commands).toContain('npm run build')
    expect(commands).toContain('npm run install:browser')
    expect(commands).toContain(`codex plugin marketplace add ${canonicalInstallRoot} --json`)
    expect(commands).toContain('codex plugin add glb-label-editor@label-editer --json')
    expect(commands).toContain('codex mcp list --json')
  })

  it('rejects an installation that Codex still exposes as an MCP server', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-installer-mcp-'))
    const sourceRoot = path.join(root, 'source')
    const installRoot = path.join(root, 'managed-install')
    const fakeBin = path.join(root, 'bin')
    await mkdir(sourceRoot)
    await mkdir(fakeBin)
    await createPluginSource(sourceRoot)

    await writeExecutable(path.join(fakeBin, 'npm'), [
      'case "$*" in',
      '  *"run build"*) mkdir -p dist; printf \'<main>built</main>\\n\' > dist/index.html ;;',
      'esac',
    ].join('\n'))
    await writeExecutable(path.join(fakeBin, 'codex'), [
      'case "$*" in',
      '  "plugin marketplace list --json") printf \'{"marketplaces":[]}\\n\' ;;',
      '  "plugin list --json") printf \'{"installed":[]}\\n\' ;;',
      '  "mcp list --json") printf \'[{"name":"glb-label-editor","enabled":true}]\\n\' ;;',
      '  *) printf \'{}\\n\' ;;',
      'esac',
    ].join('\n'))

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/install-plugin.mjs'),
      '--source', sourceRoot,
      '--install-root', installRoot,
      '--json',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [fakeBin, process.env.PATH ?? ''].join(':'),
      },
    })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: 'Codex still exposes the legacy glb-label-editor MCP server after installation',
    })
  })
})
