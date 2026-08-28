import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, appendFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Build freshness is directly executable Node ESM.
import { assertFreshEditorBuild, editorSourceFingerprint, snapshotEditorDist, writeEditorBuildFingerprint } from '../scripts/lib/build-fingerprint.mjs'
// @ts-expect-error Plugin runtime is directly executable ESM.
import { createPluginRuntime } from '../scripts/plugin-runtime.mjs'

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'glb-label-build-fingerprint-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'public', 'nested'), { recursive: true })
  await mkdir(path.join(root, 'scripts', 'lib'), { recursive: true })
  await mkdir(path.join(root, 'dist', 'assets'), { recursive: true })
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const version = 1\n')
  await writeFile(path.join(root, 'scripts', 'lib', 'browser-core.mjs'), 'export const browserCore = 1\n')
  await writeFile(path.join(root, 'scripts', 'generate-label-validator.mjs'), 'export {}\n')
  await writeFile(path.join(root, 'public', 'nested', 'runtime.bin'), 'public-v1')
  await writeFile(path.join(root, 'index.html'), '<main>source</main>')
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(path.join(root, 'npm-shrinkwrap.json'), '{"lockfileVersion":3}\n')
  await writeFile(path.join(root, 'vite.config.ts'), 'export default {}\n')
  await writeFile(path.join(root, 'tsconfig.json'), '{}\n')
  await writeFile(path.join(root, 'dist', 'index.html'), '<script src="/assets/app.js"></script>')
  await writeFile(
    path.join(root, 'dist', 'assets', 'app.js'),
    'globalThis.__GLB_LABEL_EDITOR_AGENT_V1__ = {}\n',
  )
  return root
}

describe('editor build freshness', () => {
  it('bounds every source input and rejects deep, long, numerous, linked, and nonregular trees', async () => {
    const oversized = await fixtureRoot()
    await writeFile(path.join(oversized, 'public', 'too-large.bin'), Buffer.alloc(32 * 1024 * 1024 + 1))
    await expect(editorSourceFingerprint(oversized)).rejects.toThrow(/byte limit/i)

    const numerous = await fixtureRoot()
    await Promise.all(Array.from({ length: 513 }, (_, index) => (
      writeFile(path.join(numerous, 'public', `entry-${String(index).padStart(3, '0')}.txt`), 'x')
    )))
    await expect(editorSourceFingerprint(numerous)).rejects.toThrow(/count limit/i)

    const deep = await fixtureRoot()
    const deepDirectory = path.join(deep, 'public', 'a', 'b', 'c', 'd')
    await mkdir(deepDirectory, { recursive: true })
    await writeFile(path.join(deepDirectory, 'deep.txt'), 'deep')
    await expect(editorSourceFingerprint(deep, { maxEditorTreeDepth: 3 }))
      .rejects.toThrow(/depth limit/i)

    const long = await fixtureRoot()
    const longDirectory = path.join(long, 'public', 'x'.repeat(40))
    await mkdir(longDirectory)
    await writeFile(path.join(longDirectory, 'long.txt'), 'long')
    await expect(editorSourceFingerprint(long, { maxEditorAssetPathBytes: 32 }))
      .rejects.toThrow(/path byte limit/i)

    const linked = await fixtureRoot()
    await symlink(path.join(linked, 'index.html'), path.join(linked, 'public', 'linked.html'))
    await expect(editorSourceFingerprint(linked)).rejects.toThrow(/symbolic link/i)

    const fifo = await fixtureRoot()
    await promisify(execFile)('mkfifo', [path.join(fifo, 'public', 'blocked.fifo')])
    await expect(editorSourceFingerprint(fifo)).rejects.toThrow(/regular file|non-regular/i)
  }, 30_000)

  it('charges source aggregate bytes and the installed npm shrinkwrap to the same bounded fingerprint', async () => {
    const root = await fixtureRoot()
    await expect(editorSourceFingerprint(root, {
      maxEditorAssetBytes: 64,
      maxEditorSnapshotBytes: 64,
    })).rejects.toThrow(/snapshot byte limit/i)

    const original = await editorSourceFingerprint(root)
    await writeFile(path.join(root, 'npm-shrinkwrap.json'), '{"lockfileVersion":3,"installed":true}\n')
    await expect(editorSourceFingerprint(root)).resolves.not.toEqual(original)
  })

  it.each([
    ['growing descriptor', async (root: string, filePath: string) => {
      await appendFile(filePath, 'grown')
    }],
    ['path replacement', async (root: string, filePath: string) => {
      await rename(filePath, `${filePath}.original`)
      await writeFile(filePath, 'replacement')
    }],
    ['file-directory replacement', async (root: string, filePath: string) => {
      await rename(filePath, `${filePath}.original`)
      await mkdir(filePath)
    }],
    ['parent rename-swap-restore', async (root: string, filePath: string) => {
      const parent = path.dirname(filePath)
      const preserved = `${parent}.original`
      const external = path.join(root, 'external-assets')
      await cp(parent, external, { recursive: true })
      await rename(parent, preserved)
      await symlink(external, parent)
      await rm(parent)
      await rename(preserved, parent)
    }],
  ])('rejects a %s after opening but before retaining dist bytes', async (_name, mutate) => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    const assetPath = path.join(editorRoot, 'assets', 'app.js')
    await expect(snapshotEditorDist(editorRoot, {
      onEditorAssetOpened: async ({ relativePath }: { relativePath: string }) => {
        if (relativePath === 'assets/app.js') await mutate(root, assetPath)
      },
    })).rejects.toThrow(/changed|regular file|inventory/i)
  })

  it('charges bytes actually read after descriptor open against the aggregate cap', async () => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    const assetPath = path.join(editorRoot, 'assets', 'app.js')
    const initialTotal = (await readFile(path.join(editorRoot, 'index.html'))).byteLength
      + (await readFile(assetPath)).byteLength
    await expect(snapshotEditorDist(editorRoot, {
      maxEditorAssetBytes: initialTotal,
      maxEditorSnapshotBytes: initialTotal + 2,
      onEditorAssetOpened: async ({ relativePath }: { relativePath: string }) => {
        if (relativePath === 'index.html') await appendFile(path.join(editorRoot, 'index.html'), 'actual-growth')
      },
    })).rejects.toThrow(/snapshot byte limit/i)
  })

  it('treats a fresh checkout with no dist fingerprint as unavailable before browser launch', async () => {
    const root = await fixtureRoot()
    await expect(assertFreshEditorBuild(root, path.join(root, 'dist')))
      .rejects.toThrow(/build fingerprint is missing/i)
    await expect(createPluginRuntime({ pluginRoot: root }))
      .rejects.toThrow(/build fingerprint is missing/i)
  })

  it('accepts an exact build fingerprint and rejects a later source mutation', async () => {
    const root = await fixtureRoot()
    await writeEditorBuildFingerprint(root, path.join(root, 'dist'))
    await expect(assertFreshEditorBuild(root, path.join(root, 'dist'))).resolves.toBeDefined()

    await writeFile(path.join(root, 'src', 'main.ts'), 'export const version = 2\n')
    await expect(assertFreshEditorBuild(root, path.join(root, 'dist')))
      .rejects.toThrow(/stale editor build/i)
    await expect(createPluginRuntime({ pluginRoot: root }))
      .rejects.toThrow(/stale editor build/i)
  })

  it('binds the exact regular-file dist inventory and bytes after the marker is written', async () => {
    const mutations: Array<[string, (root: string) => Promise<unknown>]> = [
      ['modified index', (root) => writeFile(path.join(root, 'dist', 'index.html'), '<main>tampered</main>')],
      ['missing referenced asset', (root) => rm(path.join(root, 'dist', 'assets', 'app.js'))],
      ['stale referenced asset', (root) => writeFile(path.join(root, 'dist', 'assets', 'app.js'), 'built-v0')],
      ['added file', (root) => writeFile(path.join(root, 'dist', 'extra.js'), 'unexpected')],
      ['renamed referenced asset', (root) => rename(
        path.join(root, 'dist', 'assets', 'app.js'),
        path.join(root, 'dist', 'assets', 'renamed.js'),
      )],
      ['file replaced by directory', async (root) => {
        await rm(path.join(root, 'dist', 'assets', 'app.js'))
        await mkdir(path.join(root, 'dist', 'assets', 'app.js'))
      }],
      ['symlinked index', async (root) => {
        await rm(path.join(root, 'dist', 'index.html'))
        await symlink(path.join(root, 'index.html'), path.join(root, 'dist', 'index.html'))
      }],
    ]

    for (const [name, mutate] of mutations) {
      const root = await fixtureRoot()
      const editorRoot = path.join(root, 'dist')
      await writeEditorBuildFingerprint(root, editorRoot)
      await mutate(root)
      await expect(assertFreshEditorBuild(root, editorRoot), name).rejects.toThrow(/stale editor build|symbolic link/i)
    }
  })

  it('serves only the verified dist byte snapshot after runtime creation', async () => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    const assetPath = path.join(editorRoot, 'assets', 'app.js')
    const verifiedBytes = await readFile(assetPath, 'utf8')
    await writeEditorBuildFingerprint(root, editorRoot)
    const runtime = await createPluginRuntime({ pluginRoot: root })
    try {
      await writeFile(assetPath, 'globalThis.__GLB_LABEL_EDITOR_AGENT_V1__ = { tampered: true }\n')
      const response = await fetch(`${runtime.origin}/assets/app.js`, { cache: 'no-store' })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(verifiedBytes)
    } finally {
      await runtime.close()
    }
  })

  it.each([
    ['source mutation', async (root: string) => {
      await writeFile(path.join(root, 'src', 'main.ts'), 'export const version = 2\n')
    }],
    ['marker byte mutation', async (root: string) => {
      const marker = path.join(root, 'dist', 'build-fingerprint.json')
      await writeFile(marker, `${await readFile(marker, 'utf8')} `)
    }],
    ['dist byte mutation', async (root: string) => {
      await writeFile(path.join(root, 'dist', 'assets', 'app.js'), 'tampered')
    }],
    ['dist addition', async (root: string) => {
      await writeFile(path.join(root, 'dist', 'added.js'), 'added')
    }],
    ['dist deletion', async (root: string) => {
      await rm(path.join(root, 'dist', 'assets', 'app.js'))
    }],
    ['dist rename', async (root: string) => {
      await rename(path.join(root, 'dist', 'assets', 'app.js'), path.join(root, 'dist', 'assets', 'renamed.js'))
    }],
    ['dist symlink replacement', async (root: string) => {
      const asset = path.join(root, 'dist', 'assets', 'app.js')
      await rm(asset)
      await symlink(path.join(root, 'index.html'), asset)
    }],
  ])('rejects %s before the lazy browser executable can run', async (_name, mutate) => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    await writeEditorBuildFingerprint(root, editorRoot)
    const runtime = await createPluginRuntime({
      pluginRoot: root,
      launchOptions: { executablePath: path.join(root, 'browser-must-not-run') },
    })
    try {
      const session = await runtime.createSession()
      await mutate(root)
      await expect(runtime.openEditor(session)).rejects.toThrow(/stale editor build|symbolic link/i)
    } finally {
      await runtime.close()
    }
  })

  it('keeps one verified byte inventory across multiple browser opens and the final request race', async () => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    const assetPath = path.join(editorRoot, 'assets', 'app.js')
    const verifiedBytes = await readFile(assetPath, 'utf8')
    await writeEditorBuildFingerprint(root, editorRoot)
    const runtime = await createPluginRuntime({ pluginRoot: root })
    try {
      const first = await runtime.createSession()
      const second = await runtime.createSession()
      const firstUrl = await runtime.openEditor(first)
      await expect(runtime.openEditor(second)).resolves.toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect((await fetch(firstUrl)).status).toBe(200)

      await writeFile(assetPath, 'globalThis.__GLB_LABEL_EDITOR_AGENT_V1__ = { tampered: true }\n')
      await expect(fetch(`${runtime.origin}/assets/app.js`).then((response) => response.text()))
        .resolves.toBe(verifiedBytes)
      await expect(runtime.openEditor(await runtime.createSession()))
        .rejects.toThrow(/stale editor build/i)
      await expect(runtime.openEditor(first)).resolves.toBe(firstUrl)
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it('excludes the marker from its own inventory and leaves no partial marker files', async () => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    await writeEditorBuildFingerprint(root, editorRoot)
    await writeEditorBuildFingerprint(root, editorRoot)
    await expect(assertFreshEditorBuild(root, editorRoot)).resolves.toBeDefined()
    expect((await readdir(editorRoot)).filter((entry) => entry.includes('build-fingerprint')))
      .toEqual(['build-fingerprint.json'])
  })

  it('validates an npm-packaged runtime without a workspace-only pnpm lockfile', async () => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    await rm(path.join(root, 'pnpm-lock.yaml'))
    await writeEditorBuildFingerprint(root, editorRoot)
    await expect(assertFreshEditorBuild(root, editorRoot)).resolves.toMatchObject({
      version: 2,
      algorithm: 'sha256',
      distFileCount: 2,
    })
    const runtime = await createPluginRuntime({ pluginRoot: root })
    try {
      await expect(fetch(`${runtime.origin}/assets/app.js`).then((response) => response.text()))
        .resolves.toContain('__GLB_LABEL_EDITOR_AGENT_V1__')
    } finally {
      await runtime.close()
    }
  })

  it('invalidates an existing build when recursive public assets or supported lockfiles change, appear, or disappear', async () => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    const expectStaleAfter = async (mutate: () => Promise<void>) => {
      await writeEditorBuildFingerprint(root, editorRoot)
      await expect(assertFreshEditorBuild(root, editorRoot)).resolves.toBeDefined()
      await mutate()
      await expect(assertFreshEditorBuild(root, editorRoot)).rejects.toThrow(/stale editor build/i)
    }

    await expectStaleAfter(() => writeFile(path.join(root, 'public', 'nested', 'runtime.bin'), 'public-v2'))
    await expectStaleAfter(() => writeFile(path.join(root, 'scripts', 'lib', 'browser-core.mjs'), 'export const browserCore = 2\n'))
    await expectStaleAfter(() => writeFile(path.join(root, 'scripts', 'generate-label-validator.mjs'), 'export const changed = true\n'))
    await expectStaleAfter(() => writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npatched: true\n'))
    await expectStaleAfter(() => writeFile(path.join(root, 'npm-shrinkwrap.json'), '{"lockfileVersion":3,"patched":true}\n'))
    await expectStaleAfter(() => rm(path.join(root, 'npm-shrinkwrap.json')))
    await expectStaleAfter(() => writeFile(path.join(root, 'npm-shrinkwrap.json'), '{"lockfileVersion":3,"restored":true}\n'))
    await expectStaleAfter(() => writeFile(path.join(root, 'public', 'added.bin'), 'added'))
    await expectStaleAfter(() => rm(path.join(root, 'public', 'added.bin')))
    await expectStaleAfter(() => writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n'))
    await expectStaleAfter(() => rm(path.join(root, 'package-lock.json')))
  })

  it('fails closed on symlinked build inputs and does not write a marker for that failed fingerprint', async () => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    const outside = path.join(root, 'outside.bin')
    const marker = path.join(editorRoot, 'build-fingerprint.json')
    await writeFile(outside, 'outside')
    await symlink(outside, path.join(root, 'public', 'nested', 'linked.bin'))

    await expect(writeEditorBuildFingerprint(root, editorRoot)).rejects.toThrow(/symbolic link/i)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['src parent', async (root: string) => {
      await rename(path.join(root, 'src'), path.join(root, 'src.real'))
      await symlink(path.join(root, 'src.real'), path.join(root, 'src'))
    }],
    ['nested public parent', async (root: string) => {
      await rename(path.join(root, 'public', 'nested'), path.join(root, 'public', 'nested.real'))
      await symlink(path.join(root, 'public', 'nested.real'), path.join(root, 'public', 'nested'))
    }],
    ['config leaf', async (root: string) => {
      await rename(path.join(root, 'vite.config.ts'), path.join(root, 'vite.config.real'))
      await symlink(path.join(root, 'vite.config.real'), path.join(root, 'vite.config.ts'))
    }],
    ['package leaf', async (root: string) => {
      await rename(path.join(root, 'package.json'), path.join(root, 'package.real'))
      await symlink(path.join(root, 'package.real'), path.join(root, 'package.json'))
    }],
    ['installed lock leaf', async (root: string) => {
      await rename(path.join(root, 'npm-shrinkwrap.json'), path.join(root, 'npm-shrinkwrap.real'))
      await symlink(path.join(root, 'npm-shrinkwrap.real'), path.join(root, 'npm-shrinkwrap.json'))
    }],
  ])('rejects a symlink at the %s fingerprint boundary', async (_name, mutate) => {
    const root = await fixtureRoot()
    await mutate(root)
    await expect(editorSourceFingerprint(root)).rejects.toThrow(/symbolic link/i)
  })

  it('rejects a symlinked intermediate source parent even when every selected leaf is byte-identical', async () => {
    const root = await fixtureRoot()
    const editorRoot = path.join(root, 'dist')
    await writeEditorBuildFingerprint(root, editorRoot)

    const originalScripts = path.join(root, 'scripts')
    const preservedScripts = path.join(root, 'scripts.original')
    const externalScripts = path.join(root, 'external-scripts')
    await cp(originalScripts, externalScripts, { recursive: true })
    await writeFile(path.join(externalScripts, 'unselected-malicious-runtime.mjs'), 'globalThis.compromised = true\n')
    await rename(originalScripts, preservedScripts)
    await symlink(externalScripts, originalScripts)

    await expect(assertFreshEditorBuild(root, editorRoot)).rejects.toThrow(/symbolic link/i)
  })

  it('rejects a symlinked fingerprint root instead of treating its target as repository authority', async () => {
    const root = await fixtureRoot()
    const aliasParent = await mkdtemp(path.join(tmpdir(), 'glb-label-build-alias-'))
    const alias = path.join(aliasParent, 'plugin')
    const distAlias = path.join(aliasParent, 'dist')
    await symlink(root, alias)
    await symlink(path.join(root, 'dist'), distAlias)

    await expect(editorSourceFingerprint(alias)).rejects.toThrow(/symbolic link/i)
    await expect(snapshotEditorDist(distAlias)).rejects.toThrow(/symbolic link/i)
  })

  it('detects a source parent rename-swap-restore completed while a selected leaf is open', async () => {
    const root = await fixtureRoot()
    const scripts = path.join(root, 'scripts')
    const preservedScripts = path.join(root, 'scripts.original')
    const externalScripts = path.join(root, 'external-scripts')
    await cp(scripts, externalScripts, { recursive: true })

    await expect(editorSourceFingerprint(root, {
      onEditorAssetOpened: async ({ relativePath }: { relativePath: string }) => {
        if (relativePath !== 'scripts/lib/browser-core.mjs') return
        await rename(scripts, preservedScripts)
        await symlink(externalScripts, scripts)
        await rm(scripts)
        await rename(preservedScripts, scripts)
      },
    })).rejects.toThrow(/changed while fingerprinting/i)
  })

  it('makes standalone plugin E2E build first and plugin verification reuse that build', async () => {
    const packageJson = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile('package.json', 'utf8')))
    expect(packageJson.scripts['test:plugin-e2e']).toMatch(/pnpm build/)
    expect(packageJson.scripts['plugin:verify']).toMatch(/pnpm build/)
    expect((packageJson.scripts['plugin:verify'].match(/pnpm build/g) ?? [])).toHaveLength(1)
  })
})
