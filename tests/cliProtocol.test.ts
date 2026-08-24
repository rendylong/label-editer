import { describe, expect, it } from 'vitest'
// @ts-expect-error CLI is directly executable ESM.
import { runCli } from '../scripts/label-cli.mjs'

describe('label-cli protocol', () => {
  it('writes exactly one machine-readable JSON result to stdout', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runCli(['inspect', 'model.glb', '--json'], {
      operations: {
        inspect: async () => ({ ok: true, operation: 'inspect_model', data: { meshes: [] }, warnings: [] }),
      },
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    })

    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toEqual({ ok: true, operation: 'inspect_model', data: { meshes: [] }, warnings: [] })
    expect(stderr).toEqual([])
  })

  it('maps a validation failure to exit code 4', async () => {
    const output: string[] = []
    const code = await runCli(['validate', 'bad.json', '--json'], {
      operations: {
        validate: async () => ({
          ok: false,
          operation: 'validate_label_spec',
          error: { code: 'INVALID_LABEL_SPEC', message: 'bad schema' },
          warnings: [],
        }),
      },
      stdout: (value: string) => output.push(value),
      stderr: () => undefined,
    })
    expect(code).toBe(4)
    expect(output).toHaveLength(1)
  })

  it('rejects missing apply options before invoking an operation', async () => {
    let invoked = false
    const output: string[] = []
    const code = await runCli(['apply', 'spec.json', '--json'], {
      operations: { apply: async () => { invoked = true } },
      stdout: (value: string) => output.push(value),
      stderr: () => undefined,
    })
    expect(code).toBe(2)
    expect(invoked).toBe(false)
    expect(JSON.parse(output[0]).error.code).toBe('INVALID_USAGE')
  })
})
