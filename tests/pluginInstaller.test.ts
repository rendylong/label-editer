import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { compileBlueprintToSpecAreas } from '../src/agent/blueprintCompiler'
import type { DesignReviewManifestV1, EditorHandoffV2, LayoutBlueprintV1 } from '../src/agent/designContracts'

const repoRoot = path.resolve(import.meta.dirname, '..')

const approvalRuntimeFiles = [
  'src/agent/layout-blueprint-v1.schema.json',
  'src/agent/editor-handoff-v2.schema.json',
  'src/agent/approval-record-v1.schema.json',
  'src/agent/design-review-manifest-v1.schema.json',
  'src/agent/review-manifest-v1.schema.json',
  'src/agent/generated/designContractValidators.ts',
  'src/agent/generated/labelSpecV2Validator.ts',
  'scripts/render-design-review.mjs',
  'scripts/lib/design-review.mjs',
  'scripts/lib/review-output.mjs',
  'src/agent/areaArtifactToken.mjs',
  'src/agent/areaArtifactToken.d.mts',
  'src/label/cssColor.ts',
  'scripts/write-build-fingerprint.mjs',
  'scripts/lib/build-fingerprint.mjs',
] as const

const approvalSkillFiles = [
  'skills/cosmetic-label/SKILL.md',
  'skills/cosmetic-label/references/editor_handoff.md',
  'skills/cosmetic-label/references/label_content.md',
  'skills/cosmetic-label/references/label_mockup.html',
  'skills/cosmetic-label/references/label_patterns_by_category.md',
  'skills/cosmetic-label/references/label_process.md',
  'skills/cosmetic-label/references/label_spec_template.md',
  'skills/cosmetic-label/references/typography_guide.md',
  'skills/cosmetic-label/scripts/query_labels.py',
  'skills/cosmetic-label-editor/SKILL.md',
  'skills/cosmetic-label-editor/references/quality-control.md',
] as const

const runtimeClosureEntries = [
  'scripts/label-cli.mjs',
  'scripts/plugin-runtime.mjs',
  'scripts/render-design-review.mjs',
  'scripts/lib/design-review.mjs',
  'scripts/lib/review-output.mjs',
  'scripts/write-build-fingerprint.mjs',
  'src/label/cssColor.ts',
] as const

const externalReviewModel = process.env.GLB_LABEL_E2E_MODEL
  ?? '/Users/apple/realibox/cosmetic-bottles-glb/02_perfume_glass_with_cap.glb'
const externalReviewModelPresent = existsSync(externalReviewModel)

type PackFile = { path: string; mode: number; size: number }
type PackageArchive = {
  root: string
  packageRoot: string
  tarballPath: string
  pack: {
    filename: string
    size: number
    integrity: string
    shasum: string
    entryCount: number
    files: PackFile[]
  }
}

type InstalledPackage = PackageArchive & {
  installRoot: string
  canonicalInstallRoot: string
  callerRoot: string
  launcherPath: string
  installerStdout: string
  installerStderr: string
  codexLog: string
  scriptShellLog: string
  browserMockLog: string
}

let packageArchivePromise: Promise<PackageArchive> | undefined
let installedPackagePromise: Promise<InstalledPackage> | undefined
let packageTemporaryRoot: string | undefined
const unitTemporaryRoots: string[] = []

function commandFailure(label: string, result: ReturnType<typeof spawnSync>): Error {
  return new Error([
    `${label} failed with status ${String(result.status)}`,
    result.error?.stack ?? '',
    String(result.stdout ?? ''),
    String(result.stderr ?? ''),
  ].filter(Boolean).join('\n'))
}

async function createPackageArchive(): Promise<PackageArchive> {
  const root = await mkdtemp(path.join(tmpdir(), 'glb-label-real-package-'))
  packageTemporaryRoot = root
  const packRoot = path.join(root, 'pack')
  const extractRoot = path.join(root, 'extract')
  await mkdir(packRoot)
  await mkdir(extractRoot)
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', packRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) throw commandFailure('npm pack', result)
  const parsed = JSON.parse(result.stdout)
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('npm pack did not return one package')
  const pack = parsed[0] as PackageArchive['pack']
  const tarballPath = path.join(packRoot, pack.filename)
  const extracted = spawnSync('tar', ['-xzf', tarballPath, '-C', extractRoot], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (extracted.status !== 0) throw commandFailure('tar extract', extracted)
  const packageRoot = path.join(extractRoot, 'package')
  if (!(await stat(packageRoot)).isDirectory()) throw new Error('npm tarball did not contain package/')
  return { root, packageRoot, tarballPath, pack }
}

function packageArchive(): Promise<PackageArchive> {
  packageArchivePromise ??= createPackageArchive()
  return packageArchivePromise
}

function importedSpecifiers(source: string, fileName: string): string[] {
  const specifiers = new Set<string>()
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.add(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...specifiers]
}

function resolvePackagedImport(sourcePath: string, specifier: string, packagedPaths: Set<string>): string | undefined {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier))
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new Error(`Packaged import escapes package root: ${sourcePath} -> ${specifier}`)
  }
  for (const candidate of [
    resolved,
    `${resolved}.mjs`,
    `${resolved}.ts`,
    `${resolved}.json`,
    path.posix.join(resolved, 'index.mjs'),
    path.posix.join(resolved, 'index.ts'),
  ]) {
    if (packagedPaths.has(candidate)) return candidate
  }
  return undefined
}

async function importedRuntimeClosure(
  packageRoot: string,
  entryPaths: readonly string[],
  packagedPaths: Set<string>,
): Promise<{ files: string[]; externalPackages: string[] }> {
  const pending = [...entryPaths]
  const visited = new Set<string>()
  const externalPackages = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    if (!packagedPaths.has(current)) throw new Error(`Missing packaged runtime entry: ${current}`)
    visited.add(current)
    const source = await readFile(path.join(packageRoot, current), 'utf8')
    for (const specifier of importedSpecifiers(source, current)) {
      if (specifier.startsWith('node:')) continue
      if (!specifier.startsWith('.')) {
        externalPackages.add(specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0])
        continue
      }
      const dependency = resolvePackagedImport(current, specifier, packagedPaths)
      if (!dependency) throw new Error(`Missing relative runtime dependency: ${current} -> ${specifier}`)
      pending.push(dependency)
    }
  }
  return { files: [...visited].sort(), externalPackages: [...externalPackages].sort() }
}

async function installRealPackage(): Promise<InstalledPackage> {
  const archive = await packageArchive()
  const fakeBin = path.join(archive.root, 'external-bin')
  const installRoot = path.join(archive.root, 'managed-install')
  const callerRoot = path.join(archive.root, 'unrelated-caller')
  const codexLogPath = path.join(archive.root, 'codex.log')
  const scriptShellLogPath = path.join(archive.root, 'npm-script-shell.log')
  const browserMockLogPath = path.join(archive.root, 'browser-download-mock.log')
  const scriptShellPath = path.join(archive.root, 'npm-script-shell')
  await mkdir(fakeBin)
  await mkdir(callerRoot)
  await writeExecutable(path.join(fakeBin, 'codex'), `
printf 'codex %s\\n' "$*" >> "$CODEX_COMMAND_LOG"
case "$*" in
  "plugin marketplace list --json") printf '{"marketplaces":[]}\\n' ;;
  "plugin list --json") printf '{"installed":[]}\\n' ;;
  "mcp list --json") printf '[]\\n' ;;
  *) printf '{}\\n' ;;
esac
`)
  await writeExecutable(scriptShellPath, `
printf '%s\\n' "$*" >> "$NPM_SCRIPT_SHELL_LOG"
if [ "$#" -eq 2 ] && [ "$1" = "-c" ] && [ "$2" = "playwright install chromium" ]; then
  printf '%s\\n' "$2" > "$BROWSER_DOWNLOAD_MOCK_LOG"
  exit 0
fi
exec /bin/sh "$@"
`)

  const result = spawnSync(process.execPath, [
    path.join(archive.packageRoot, 'scripts/install-plugin.mjs'),
    '--source', archive.packageRoot,
    '--install-root', installRoot,
    '--json',
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      npm_config_script_shell: scriptShellPath,
      CODEX_COMMAND_LOG: codexLogPath,
      NPM_SCRIPT_SHELL_LOG: scriptShellLogPath,
      BROWSER_DOWNLOAD_MOCK_LOG: browserMockLogPath,
    },
  })
  if (result.status !== 0) throw commandFailure('real packaged installer', result)
  const canonicalInstallRoot = await realpath(installRoot)
  return {
    ...archive,
    installRoot,
    canonicalInstallRoot,
    callerRoot,
    launcherPath: path.join(installRoot, 'plugin/bin/label-cli.mjs'),
    installerStdout: result.stdout,
    installerStderr: result.stderr,
    codexLog: await readFile(codexLogPath, 'utf8'),
    scriptShellLog: await readFile(scriptShellLogPath, 'utf8'),
    browserMockLog: await readFile(browserMockLogPath, 'utf8'),
  }
}

function installedPackage(): Promise<InstalledPackage> {
  installedPackagePromise ??= installRealPackage()
  return installedPackagePromise
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeInstalledReviewFixture(callerRoot: string): Promise<{
  inputPath: string
  modelPath: string
  outputDir: string
  blueprintSha256: string
  designReviewManifestSha256: string
}> {
  const blueprint: LayoutBlueprintV1 = {
    version: 1,
    revision: 'installed-review-v1',
    carrierDefaults: { carrier: 'direct_surface_print' },
    assets: [],
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      artboard: { widthMm: 58.76605666054, heightMm: 30, background: 'transparent' },
      placementIntent: 'Centered direct print on the front face.', placementPolicy: 'block',
      layers: [{
        id: 'installed-mark', kind: 'shape', boundsMm: { x: 16, y: 4, width: 26, height: 22 },
        anchor: 'top_left', rotation: 0, opacity: 1, visible: true, zIndex: 0,
        processes: [{ process: 'screen_print' }], shape: 'ellipse',
        fill: '#b88a44', stroke: '#3b2411', strokeWidthMm: 0.5, cornerRadiusMm: 0,
      }],
    }],
  }
  const blueprintJson = JSON.stringify(blueprint)
  const blueprintSha256 = sha256(blueprintJson)
  const designManifest: DesignReviewManifestV1 = {
    version: 1, createdAt: '2026-08-28T00:00:00.000Z',
    blueprint: { revision: blueprint.revision, sha256: blueprintSha256 },
    html: { sha256: '1'.repeat(64) }, references: [],
    areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
    artifacts: [{
      id: 'mockup-front', path: 'mockup-front.png', sha256: '2'.repeat(64),
      mimeType: 'image/png', width: 1600, height: 1200, viewKind: 'mockup-front',
    }, {
      id: 'mockup-back', path: 'mockup-back.png', sha256: '3'.repeat(64),
      mimeType: 'image/png', width: 1600, height: 1200, viewKind: 'mockup-back',
    }, {
      id: 'mockup-area-front', path: 'areas/front.png', sha256: '4'.repeat(64),
      mimeType: 'image/png', width: 1200, height: 1200, viewKind: 'mockup-area',
      areaId: 'front', carrier: 'direct_surface_print',
    }],
  }
  const designManifestJson = JSON.stringify(designManifest)
  const designReviewManifestSha256 = sha256(designManifestJson)
  const handoff: EditorHandoffV2 = {
    handoff_version: 2, status: 'approved',
    source: {
      design_spec: 'design.md', mockup_html: 'mockup.html', blueprint: 'layout-blueprint.json',
      design_review_manifest: 'design-review-manifest.json', blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha256, review_manifest_sha256: designReviewManifestSha256,
    },
    approval: {
      mode: 'explicit_approval', scope: 'current_task', blueprint_revision: blueprint.revision,
      blueprint_sha256: blueprintSha256, review_manifest_sha256: designReviewManifestSha256,
    },
    model: { package_type: 'bottle' },
    areas: [{
      id: 'front', side: 'front', carrier: 'direct_surface_print',
      placement: 'Centered direct print on the front face.',
      physical_size_mm: { width: 58.76605666054, height: 30 }, blueprint_area_id: 'front',
    }],
    assets: [], production_constraints: {}, assumptions: [], blockers: [],
  }
  const areas = compileBlueprintToSpecAreas(blueprint, [{
    blueprintAreaId: 'front', name: 'Front',
    target: { nodeName: 'Cube.001_Material.001_0' }, surfaceMode: 'overlay',
    range: { uStart: 0.35, uWidth: 0.3, vStart: 0.2, vHeight: 0.6 },
  }])
  areas[0].designBinding = {
    blueprintRevision: blueprint.revision,
    blueprintSha256,
    reviewManifestSha256: designReviewManifestSha256,
  }
  const inputPath = path.join(callerRoot, 'working-label-spec.json')
  const modelPath = path.join(callerRoot, 'package.glb')
  const outputDir = path.join(callerRoot, 'production-review-revision-001')
  await Promise.all([
    writeFile(inputPath, `${JSON.stringify({ version: 2, areas })}\n`),
    writeFile(path.join(callerRoot, 'editor-handoff.json'), `${JSON.stringify(handoff)}\n`),
    writeFile(path.join(callerRoot, 'layout-blueprint.json'), blueprintJson),
    writeFile(path.join(callerRoot, 'design-review-manifest.json'), designManifestJson),
    copyFile(externalReviewModel, modelPath),
  ])
  return { inputPath, modelPath, outputDir, blueprintSha256, designReviewManifestSha256 }
}

afterAll(async () => {
  await Promise.all([
    ...(packageTemporaryRoot ? [rm(packageTemporaryRoot, { recursive: true, force: true })] : []),
    ...unitTemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ])
}, 30_000)

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
    'scripts/lib',
    'skills/cosmetic-label',
    'skills/cosmetic-label/references',
    'skills/cosmetic-label/scripts',
    'skills/cosmetic-label-editor',
    'skills/cosmetic-label-editor/references',
    'src',
    'src/agent/generated',
    'src/label',
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
  for (const requiredFile of approvalRuntimeFiles) {
    const body = requiredFile.endsWith('.json')
      ? JSON.stringify({ fixture: `fixture:${requiredFile}` })
      : `// fixture:${requiredFile}\n`
    await writeFile(path.join(root, requiredFile), body)
  }
  for (const requiredFile of approvalSkillFiles) {
    await writeFile(path.join(root, requiredFile), `# fixture:${requiredFile}\n`)
  }
  await writeFile(path.join(root, 'src/main.ts'), 'export {}')
}

describe('GLB label editor installer', () => {
  it('packages the complete approval and review runtime in a real npm tarball', async () => {
    const { packageRoot, pack, tarballPath } = await packageArchive()
    const tarballInfo = await stat(tarballPath)
    expect(tarballInfo.isFile()).toBe(true)
    expect(tarballInfo.size).toBe(pack.size)
    expect(pack.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/)
    expect(pack.shasum).toMatch(/^[a-f0-9]{40}$/)
    const files = new Map<string, PackFile>(
      pack.files.map((entry) => [entry.path, entry]),
    )
    expect(files.size).toBe(pack.entryCount)
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
    expect(files.get('scripts/install-plugin.mjs')?.mode).toBe(0o755)
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
    for (const requiredFile of [...approvalRuntimeFiles, ...approvalSkillFiles]) {
      expect(files.has(requiredFile), requiredFile).toBe(true)
      expect(files.get(requiredFile)?.size, requiredFile).toBeGreaterThan(0)
      const packagedInfo = await lstat(path.join(packageRoot, requiredFile))
      expect(packagedInfo.isFile(), requiredFile).toBe(true)
      expect(packagedInfo.isSymbolicLink(), requiredFile).toBe(false)
      expect(await readFile(path.join(packageRoot, requiredFile)), requiredFile)
        .toEqual(await readFile(path.join(repoRoot, requiredFile)))
    }
    expect(files.has('.mcp.json')).toBe(false)
    expect(files.has('scripts/mcp-server.mjs')).toBe(false)

    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    const shrinkwrap = JSON.parse(await readFile(path.join(packageRoot, 'npm-shrinkwrap.json'), 'utf8'))
    const pluginManifest = JSON.parse(
      await readFile(path.join(packageRoot, '.codex-plugin/plugin.json'), 'utf8'),
    )
    expect(packageJson.version).toBe('0.3.0')
    expect(shrinkwrap.version).toBe(packageJson.version)
    expect(shrinkwrap.packages[''].version).toBe(packageJson.version)
    expect(pluginManifest.version).toBe(packageJson.version)
    expect(packageJson.dependencies).toMatchObject({
      '@csstools/css-color-parser': '4.2.0',
      '@csstools/css-parser-algorithms': '4.0.0',
      '@csstools/css-tokenizer': '4.0.0',
      ajv: '8.20.0',
      playwright: '1.62.1',
    })
    expect(JSON.stringify(shrinkwrap)).not.toContain('registry.npmmirror.com')
    const lockedPaths = Object.keys(shrinkwrap.packages)
    expect(lockedPaths.some((entry) => entry.startsWith('..'))).toBe(false)
    for (const dependency of Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })) {
      expect(lockedPaths).toContain(`node_modules/${dependency}`)
    }

    const closure = await importedRuntimeClosure(packageRoot, runtimeClosureEntries, new Set(files.keys()))
    expect(closure.files).toEqual(expect.arrayContaining([
      'scripts/lib/operations.mjs',
      'scripts/lib/review-output.mjs',
      'scripts/lib/design-manifest-core.mjs',
      'scripts/lib/png-core.mjs',
      'src/agent/areaArtifactToken.mjs',
      'src/agent/review-manifest-v1.schema.json',
    ]))
    for (const dependency of closure.externalPackages) {
      expect(packageJson.dependencies, `runtime dependency ${dependency}`).toHaveProperty(dependency)
      expect(lockedPaths, `locked runtime dependency ${dependency}`).toContain(`node_modules/${dependency}`)
    }
  }, 60_000)

  it('installs the extracted real tarball with real npm/build and routes the real launcher from an unrelated cwd', async () => {
    const installed = await installedPackage()
    const response = JSON.parse(installed.installerStdout)
    expect(response).toMatchObject({
      ok: true,
      pluginId: 'glb-label-editor@label-editer',
      installRoot: installed.canonicalInstallRoot,
      restartRequired: true,
    })
    expect(installed.installerStderr).toContain('[glb-label-editor] Installing locked dependencies')
    expect(installed.installerStderr).toContain('[glb-label-editor] Building the editor runtime')
    expect(installed.scriptShellLog).toContain('tsc -b && vite build && node scripts/write-build-fingerprint.mjs')
    expect(installed.browserMockLog.trim()).toBe('playwright install chromium')
    expect(installed.codexLog).toContain(`codex plugin marketplace add ${installed.canonicalInstallRoot} --json`)
    expect(installed.codexLog).toContain('codex plugin add glb-label-editor@label-editer --json')
    expect(installed.codexLog).toContain('codex mcp list --json')

    const runtimeRoot = path.join(installed.installRoot, 'runtime')
    expect((await stat(path.join(runtimeRoot, 'node_modules/.package-lock.json'))).isFile()).toBe(true)
    expect((await stat(path.join(runtimeRoot, 'node_modules/ajv/package.json'))).isFile()).toBe(true)
    expect((await stat(path.join(runtimeRoot, 'node_modules/playwright/package.json'))).isFile()).toBe(true)
    expect((await stat(path.join(runtimeRoot, 'dist/index.html'))).isFile()).toBe(true)
    expect((await stat(path.join(runtimeRoot, 'dist/build-fingerprint.json'))).isFile()).toBe(true)
    for (const requiredFile of approvalRuntimeFiles) {
      expect(await readFile(path.join(runtimeRoot, requiredFile)), requiredFile)
        .toEqual(await readFile(path.join(installed.packageRoot, requiredFile)))
    }
    for (const requiredFile of approvalSkillFiles) {
      const packagedBytes = await readFile(path.join(installed.packageRoot, requiredFile))
      expect(await readFile(path.join(runtimeRoot, requiredFile)), `runtime/${requiredFile}`).toEqual(packagedBytes)
      expect(await readFile(path.join(installed.installRoot, 'plugin', requiredFile)), `plugin/${requiredFile}`).toEqual(packagedBytes)
    }

    const launcherInfo = await lstat(installed.launcherPath)
    expect(launcherInfo.isFile()).toBe(true)
    expect(launcherInfo.isSymbolicLink()).toBe(false)
    expect(launcherInfo.mode & 0o111).not.toBe(0)
    const launcherSource = await readFile(installed.launcherPath, 'utf8')
    expect(launcherSource).toContain(path.join(installed.canonicalInstallRoot, 'runtime/scripts/label-cli.mjs'))
    expect(launcherSource).not.toContain(repoRoot)
    expect(launcherSource).not.toContain(installed.packageRoot)

    const schemaResult = spawnSync(process.execPath, [installed.launcherPath, 'schema', '--json'], {
      cwd: installed.callerRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    expect(schemaResult.status, schemaResult.stderr).toBe(0)
    expect(JSON.parse(schemaResult.stdout)).toMatchObject({
      ok: true,
      operation: 'schema',
      data: {
        schema: {
          $id: 'https://realibox.com/schemas/glb-label-spec-v2.json',
          title: 'GLB Label Editor Label Spec v2',
          properties: { version: { const: 2 } },
        },
      },
    })

    const invalidReviewResult = spawnSync(process.execPath, [
      installed.launcherPath, 'review', 'working.json', '--json',
    ], {
      cwd: installed.callerRoot,
      encoding: 'utf8',
    })
    expect(invalidReviewResult.status, invalidReviewResult.stderr).toBe(2)
    expect(JSON.parse(invalidReviewResult.stdout)).toMatchObject({
      ok: false,
      operation: 'review',
      error: { code: 'INVALID_USAGE' },
    })

    await writeFile(path.join(installed.callerRoot, 'invalid-label-spec.json'), '{"version":2,"areas":[]}\n')
    const invalidSpecResult = spawnSync(process.execPath, [
      installed.launcherPath, 'validate', 'invalid-label-spec.json', '--json',
    ], {
      cwd: installed.callerRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    expect(invalidSpecResult.status, invalidSpecResult.stderr).toBe(4)
    expect(JSON.parse(invalidSpecResult.stdout)).toMatchObject({
      ok: false,
      operation: 'validate_label_spec',
      error: {
        code: 'INVALID_LABEL_SPEC',
        details: { issues: [expect.objectContaining({ path: '/areas', keyword: 'minItems' })] },
      },
    })
    expect([launcherSource, schemaResult.stdout, invalidReviewResult.stdout, invalidSpecResult.stdout].join('\n'))
      .not.toContain(repoRoot)
  }, 180_000)

  it.skipIf(!externalReviewModelPresent)(
    'publishes and reads back a real clean review through the installed launcher when the external GLB is available',
    async () => {
      const installed = await installedPackage()
      const fixture = await writeInstalledReviewFixture(installed.callerRoot)
      const result = spawnSync(process.execPath, [
        installed.launcherPath,
        'review', path.basename(fixture.inputPath),
        '--glb', path.basename(fixture.modelPath),
        '--output', path.basename(fixture.outputDir),
        '--width', '320',
        '--height', '320',
        '--json',
      ], {
        cwd: installed.callerRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
      expect(result.status, [result.stderr, result.stdout].join('\n')).toBe(0)
      const envelope = JSON.parse(result.stdout)
      expect(envelope).toMatchObject({
        ok: true,
        operation: 'render_label_review',
        data: {
          outputDir: await realpath(fixture.outputDir),
          manifestPath: path.join(await realpath(fixture.outputDir), 'review-manifest.json'),
          revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          modelFingerprint: sha256(await readFile(fixture.modelPath)),
          validation: { ready: true },
          fidelity: { pass: true },
        },
      })
      expect(result.stdout).not.toContain(repoRoot)
      expect(result.stderr).not.toContain(repoRoot)

      const outputInfo = await lstat(fixture.outputDir)
      expect(outputInfo.isDirectory()).toBe(true)
      expect(outputInfo.isSymbolicLink()).toBe(false)
      const manifestPath = path.join(fixture.outputDir, 'review-manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      expect(manifest).toMatchObject({
        version: 1,
        input: { revision: envelope.data.revision },
        blueprint: { revision: 'installed-review-v1', sha256: fixture.blueprintSha256 },
        designReviewManifest: { sha256: fixture.designReviewManifestSha256 },
        model: { fingerprint: sha256(await readFile(fixture.modelPath)) },
        areaTargetsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        areas: [{ id: 'front', side: 'front', carrier: 'direct_surface_print' }],
      })
      expect(manifest.artifacts).toHaveLength(5)
      expect((await readdir(fixture.outputDir)).sort()).toEqual([
        'label-front.png', 'model-back.png', 'model-front.png', 'review-manifest.json',
        'review-sheet.png', 'surface-front.png',
      ])
      for (const artifact of manifest.artifacts) {
        const artifactPath = path.join(fixture.outputDir, artifact.path)
        const artifactInfo = await lstat(artifactPath)
        expect(artifactInfo.isFile(), artifact.path).toBe(true)
        expect(artifactInfo.isSymbolicLink(), artifact.path).toBe(false)
        const bytes = await readFile(artifactPath)
        expect(bytes.subarray(0, 8), artifact.path)
          .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        expect(bytes.readUInt32BE(16), artifact.path).toBe(320)
        expect(bytes.readUInt32BE(20), artifact.path).toBe(320)
        expect(sha256(bytes), artifact.path).toBe(artifact.sha256)
      }
    },
    180_000,
  )

  it('unit-tests installer staging and Codex registration with controlled commands', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glb-label-installer-'))
    unitTemporaryRoots.push(root)
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
    )).resolves.toContain('fixture:skills/cosmetic-label-editor/references/quality-control.md')
    for (const requiredFile of approvalRuntimeFiles) {
      await expect(readFile(path.join(installRoot, 'runtime', requiredFile), 'utf8'))
        .resolves.toContain(`fixture:${requiredFile}`)
    }
    for (const requiredFile of approvalSkillFiles) {
      await expect(readFile(path.join(installRoot, 'runtime', requiredFile), 'utf8'))
        .resolves.toContain(`fixture:${requiredFile}`)
      await expect(readFile(path.join(installRoot, 'plugin', requiredFile), 'utf8'))
        .resolves.toContain(`fixture:${requiredFile}`)
    }

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
    const launcherSource = await readFile(launcherPath, 'utf8')
    expect(launcherSource).toContain(path.join(canonicalInstallRoot, 'runtime/scripts/label-cli.mjs'))
    expect(launcherSource).not.toContain(repoRoot)

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
    unitTemporaryRoots.push(root)
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
