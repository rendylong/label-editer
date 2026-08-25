import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '..')

function markdownSection(document: string, heading: string): string {
  const marker = `## ${heading}`
  const start = document.indexOf(marker)
  expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0)
  const next = document.indexOf('\n## ', start + marker.length)
  return document.slice(start, next === -1 ? undefined : next)
}

function expectTextInOrder(section: string, fragments: string[]): void {
  let cursor = 0
  for (const fragment of fragments) {
    const index = section.indexOf(fragment, cursor)
    expect(index, `missing or out-of-order text: ${fragment}`).toBeGreaterThanOrEqual(cursor)
    cursor = index + fragment.length
  }
}

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

    const qcSection = markdownSection(skill, 'Mandatory quality control')
    const evidenceSection = markdownSection(rubric, 'Evidence integrity and revision')

    expect(qcSection).toContain('references/quality-control.md')
    expect(qcSection).toContain('label-cli qc')
    expect(qcSection).toContain('qc-standard')
    expect(qcSection).toContain('round-0')
    expect(qcSection).toContain('maximum of three repair rounds')

    expect([...evidenceSection.matchAll(/`(qc-model-[^`]+)`/g)].map((match) => match[1])).toEqual([
      'qc-model-front',
      'qc-model-back',
      'qc-model-left',
      'qc-model-right',
      'qc-model-front-right',
      'qc-model-back-left',
    ])
    for (const artifact of [
      'qc-area-<area-id>-face',
      'qc-area-<area-id>-craft',
      'qc-area-<area-id>-metalness',
      'qc-area-<area-id>-roughness',
      'qc-area-<area-id>-bump',
    ]) {
      expect(evidenceSection).toContain(`\`${artifact}\``)
    }
    expect(evidenceSection).toContain('every PBR artifact included by the manifest')

    expectTextInOrder(qcSection, [
      'Any blocking `fail`',
      '`baseRevision`',
      '`patch --force`',
      'exact revision returned by the patch',
      '`ready` for that exact revision',
      '`validate`',
      'new immutable output directory',
      '`qc-manifest.json.input.revision` must exactly equal the current `project` revision',
      'Inspect every required image again',
    ])
    expect(evidenceSection).toContain('`qc-manifest.json.input.revision` must exactly equal the current `project` revision')
    expect(qcSection).toContain('visual defect, evidence gap, or stale/mismatched revision')
    expect(qcSection).toContain('may require recapture rather than a content mutation')
    expect(qcSection).toContain('cannot bypass the gated sequence')
    expect(qcSection).toMatch(/Do not apply\/export[\s\S]{0,120}Do not confirm delivery/)
    expect(qcSection).toMatch(/output-manifest consistency[\s\S]{0,120}GLB cross-check/)
    expect(qcSection).not.toContain('On a visual `fail`')
    expect(qcSection).not.toMatch(/(?:evidence gap|stale\/mismatched revision)[^\n]*(?:may|can) (?:skip|bypass)/i)

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

    const qcSection = markdownSection(skill, 'Mandatory quality control')

    expect(qcSection).toContain('deterministic validation does not replace visual inspection')
    expect(qcSection).toContain('Never overwrite an earlier QC round')
    expect(qcSection).toContain('Warnings remain visible')
    expect(qcSection).not.toContain('schema validation alone proves quality')
    expect(qcSection).not.toContain('silently ignore warnings')
    expect(qcSection).not.toContain('overwrite earlier QC rounds when convenient')
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
