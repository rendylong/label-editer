import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '..')

describe('plugin skill bundle', () => {
  it('installs both cosmetic label skills from the plugin skills root', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, '.codex-plugin/plugin.json'), 'utf8'),
    )
    expect(manifest.skills).toBe('./skills/')

    const entries = await readdir(path.join(repoRoot, 'skills'), { withFileTypes: true })
    const bundledSkills = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    expect(bundledSkills).toEqual(expect.arrayContaining([
      'cosmetic-label',
      'cosmetic-label-editor',
    ]))

    for (const skill of ['cosmetic-label', 'cosmetic-label-editor']) {
      await expect(readFile(path.join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8'))
        .resolves.toMatch(new RegExp(`name: ${skill}`))
    }
  })

  it('encodes the design-to-production handoff in both skills', async () => {
    const designSkill = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label/SKILL.md'),
      'utf8',
    )
    const editorSkill = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label-editor/SKILL.md'),
      'utf8',
    )

    expect(designSkill).toContain('cosmetic-label -> cosmetic-label-editor')
    expect(designSkill).toContain('Editor Handoff')
    expect(editorSkill).toContain('cosmetic-label -> cosmetic-label-editor')
    expect(editorSkill).toContain('Editor Handoff')
  })

  it('requires a visible browser preview throughout label production', async () => {
    const editorSkill = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label-editor/SKILL.md'),
      'utf8',
    )

    expect(editorSkill).toContain('## Mandatory live browser preview')
    expect(editorSkill).toContain('MUST call `open_label_editor`')
    expect(editorSkill).toContain('Do not merely return the URL')
    expect(editorSkill).toContain('Do not wait until final delivery')
    expect(editorSkill).toContain('`open_editor: true`')
  })

  it('provides explicit default prompts for both skills', async () => {
    const designMetadata = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label/agents/openai.yaml'),
      'utf8',
    )
    const editorMetadata = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label-editor/agents/openai.yaml'),
      'utf8',
    )

    expect(designMetadata).toContain('$cosmetic-label')
    expect(editorMetadata).toContain('$cosmetic-label-editor')
    expect(editorMetadata).toContain('$cosmetic-label')
  })
})
