import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Build freshness is directly executable Node ESM.
import { assertFreshEditorBuild, writeEditorBuildFingerprint } from '../scripts/lib/build-fingerprint.mjs'
// @ts-expect-error Plugin runtime is directly executable ESM.
import { createPluginRuntime } from '../scripts/plugin-runtime.mjs'

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'glb-label-build-fingerprint-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'public', 'nested'), { recursive: true })
  await mkdir(path.join(root, 'dist'), { recursive: true })
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const version = 1\n')
  await writeFile(path.join(root, 'public', 'nested', 'runtime.bin'), 'public-v1')
  await writeFile(path.join(root, 'index.html'), '<main>source</main>')
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(path.join(root, 'npm-shrinkwrap.json'), '{"lockfileVersion":3}\n')
  await writeFile(path.join(root, 'vite.config.ts'), 'export default {}\n')
  await writeFile(path.join(root, 'tsconfig.json'), '{}\n')
  await writeFile(path.join(root, 'dist', 'index.html'), '<main>built</main>')
  return root
}

describe('editor build freshness', () => {
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
    await expectStaleAfter(() => writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npatched: true\n'))
    await expectStaleAfter(() => writeFile(path.join(root, 'npm-shrinkwrap.json'), '{"lockfileVersion":3,"patched":true}\n'))
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

  it('makes standalone plugin E2E build first and plugin verification reuse that build', async () => {
    const packageJson = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile('package.json', 'utf8')))
    expect(packageJson.scripts['test:plugin-e2e']).toMatch(/pnpm build/)
    expect(packageJson.scripts['plugin:verify']).toMatch(/pnpm build/)
    expect((packageJson.scripts['plugin:verify'].match(/pnpm build/g) ?? [])).toHaveLength(1)
  })
})
