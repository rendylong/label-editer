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
    expect(manifest).not.toHaveProperty('mcpServers')

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

  it('requires the pure-local CLI and automatically opened live Web preview throughout production', async () => {
    const editorSkill = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label-editor/SKILL.md'),
      'utf8',
    )

    expect(editorSkill).toContain('## Mandatory live Web preview')
    expect(editorSkill).toContain('bin/label-cli.mjs')
    expect(editorSkill).toContain('`label-cli live <working-spec.json> --glb <model.glb> --json`')
    expect(editorSkill).toContain('automatically opens')
    expect(editorSkill).toContain('Do not use MCP')
    expect(editorSkill).toContain('Do not use computer use')
    expect(editorSkill).toContain('Do not navigate or click the preview')
    expect(editorSkill).toContain('production blocker')
  })

  it('documents revision-safe patching and last-good preview recovery', async () => {
    const editorSkill = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label-editor/SKILL.md'),
      'utf8',
    )

    expect(editorSkill).toContain('`project`')
    expect(editorSkill).toContain('`patch --force`')
    expect(editorSkill).toContain('`baseRevision`')
    expect(editorSkill).toContain('`REVISION_CONFLICT`')
    expect(editorSkill).toContain('last valid preview')
    expect(editorSkill).toContain('same working spec')
    expect(editorSkill).toContain('explicit human takeover')
    for (const oldTool of ['inspect_model', 'validate_label_spec', 'apply_label_spec', 'render_label_preview', 'export_label_assets', 'open_label_editor']) {
      expect(editorSkill).not.toContain(oldTool)
    }
  })

  it('requires revision-bound multi-view QC and bounded repair', async () => {
    const skill = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label-editor/SKILL.md'),
      'utf8',
    )
    const rubric = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label-editor/references/quality-control.md'),
      'utf8',
    )

    expect(skill).toContain('## Mandatory quality control')
    expect(skill).toContain('references/quality-control.md')
    expect(skill).toContain('label-cli qc')
    expect(skill).toContain('qc-standard')
    expect(skill).toContain('qc-manifest.json')
    expect(skill).toContain('manifest revision')
    expect(skill).toContain('round-0')
    expect(skill).toContain('maximum of three repair rounds')
    expect(skill).toContain('Do not confirm delivery')
    expect(skill).toContain('GLB cross-check')

    for (const heading of [
      'Target and labeled surface',
      'Placement, coverage, and seams',
      'Orientation',
      'Text readiness',
      'Artwork and brand assets',
      'Craft and material rendering',
      'Cross-view and output consistency',
    ]) {
      expect(rubric).toContain(`## ${heading}`)
    }

    for (const requirement of [
      'Evidence integrity and revision',
      'pass | warning | fail',
      'every required artifact id',
      'every label area',
      '2D composition, 3D render, and channel output',
      'visual simulation',
      'does not certify',
    ]) {
      expect(rubric).toContain(requirement)
    }
  })

  it('forbids validation-only acceptance and stale or destructive QC evidence', async () => {
    const skill = await readFile(
      path.join(repoRoot, 'skills/cosmetic-label-editor/SKILL.md'),
      'utf8',
    )

    expect(skill).toContain('deterministic validation does not replace visual inspection')
    expect(skill).toContain('Never overwrite an earlier QC round')
    expect(skill).toContain('Warnings remain visible')
    expect(skill).not.toContain('schema validation alone proves quality')
    expect(skill).not.toContain('silently ignore warnings')
    expect(skill).not.toContain('overwrite earlier QC rounds when convenient')
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

  it('ships complete public-directory listing metadata and assets', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, '.codex-plugin/plugin.json'), 'utf8'),
    )

    expect(manifest.homepage).toBe('https://github.com/rendylong/label-editer')
    expect(manifest.repository).toBe('https://github.com/rendylong/label-editer')
    expect(manifest.keywords).toEqual(expect.arrayContaining(['glb', 'label-design', 'cosmetics']))
    expect(manifest.interface).toMatchObject({
      websiteURL: 'https://github.com/rendylong/label-editer',
      privacyPolicyURL: 'https://github.com/rendylong/label-editer/blob/main/PRIVACY.md',
      termsOfServiceURL: 'https://github.com/rendylong/label-editer/blob/main/TERMS.md',
      composerIcon: './assets/icon.png',
      logo: './assets/icon.png',
    })

    const icon = await readFile(path.join(repoRoot, 'assets/icon.png'))
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    await expect(readFile(path.join(repoRoot, 'PRIVACY.md'), 'utf8')).resolves.toContain('# Privacy Policy')
    await expect(readFile(path.join(repoRoot, 'SUPPORT.md'), 'utf8')).resolves.toContain('# Support')
    await expect(readFile(path.join(repoRoot, 'TERMS.md'), 'utf8')).resolves.toContain('# Terms of Service')
  })
})
