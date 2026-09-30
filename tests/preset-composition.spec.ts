import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESETS = join(REPO_ROOT, 'presets', 'devflow')
/**
 * The harness-home copy the installer deploys on this machine, derived from the
 * home directory rather than hardcoded: the assertion below is about the
 * relationship between the two copies, not about where the checkout lives.
 * Absent on a machine that never installed DevFlow, in which case the case
 * skips itself (see the `text === undefined` guard).
 */
const DEPLOYED_PRESET = join(homedir(), '.dsh', '.agent-presets', 'devflow', 'agent.cordis.yml')
/** This checkout's built activation module, in the URL form the row carries. */
const REPO_ACTIVATION_MODULE = pathToFileURL(join(REPO_ROOT, 'lib', 'host', 'preset-activation.js')).href

/** Drop comment lines so assertions target the actual YAML rows only. */
function rowsOf(text: string): string {
  return text.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
}

/** Every top-level row id in a composition file, in file order. */
function rowIds(text: string): string[] {
  return [...text.matchAll(/^- id:\s*(\S+)/gm)].map(match => match[1] ?? '')
}

describe('the devflow agent preset composition', () => {
  it('keeps exactly one isolated activation row', async () => {
    const composition = await readFile(join(PRESETS, 'agent.cordis.yml'), 'utf8')
    const activationRows = composition.split(/\n(?=- id:)/).filter(row => row.includes('id: devflow-activation'))
    expect(activationRows).toHaveLength(1)
    expect(activationRows[0]).toContain('agentPresetActivation: true')
    expect(activationRows[0]).toContain('isolate:')
  })

  it('carries the capability rows dispatched employees need', async () => {
    const ids = rowIds(await readFile(join(PRESETS, 'agent.cordis.yml'), 'utf8'))
    // File/edit and search primitives plus the platform shell and the
    // model-facing interaction rows; without these a child agent inherits an
    // empty tool set and can only report `rejected`.
    for (const id of ['tool-fs', 'tool-fs-search', 'tool-pwsh', 'tool-bash', 'tool-jobs', 'tool-todo', 'tool-ask-user']) {
      expect(ids).toContain(id)
    }
    // Delegation/plan/compaction stay out: DevFlow owns orchestration.
    for (const id of ['planning', 'compaction', 'delegation', 'tool-web', 'tool-goal']) {
      expect(ids).not.toContain(id)
    }
    // Exactly one shell row is enabled per platform, mirroring `standard`.
    expect(ids.filter(id => id === 'tool-pwsh' || id === 'tool-bash')).toHaveLength(2)
  })

  it('never loads the host bundle, Remote, client slot, or a second store', async () => {
    const composition = rowsOf(await readFile(join(PRESETS, 'agent.cordis.yml'), 'utf8'))
    expect(composition).not.toContain('@xiaoxie-ide/dsh-devflow')
    expect(composition).not.toContain('cordis.patch.yml')
    expect(composition).not.toContain('stateDir')
    expect(composition).not.toContain('.devflow')
    expect(composition).not.toContain('client')
    expect(composition).not.toContain('Remote')
    expect(composition).not.toContain('provide')
    // A capability row that published a service would need a realm; these rows
    // only register model-facing tools, so the sole realm is the adapter's.
    expect(composition.match(/isolate:/g) ?? []).toHaveLength(1)
  })

  it('references the built adapter module this repository ships', async () => {
    const composition = await readFile(join(PRESETS, 'agent.cordis.yml'), 'utf8')
    const name = /name:\s*(\S+)/.exec(composition)?.[1]
    expect(name).toBe('../../lib/host/preset-activation.js')
    const target = resolve(dirname(join(PRESETS, 'agent.cordis.yml')), name!)
    const exists = await import('node:fs/promises').then(fs => fs.stat(target).then(() => true, () => false))
    expect(exists).toBe(true)
  })

  it('keeps picker metadata declarative with no code-bearing keys', async () => {
    const metadata = await readFile(join(PRESETS, 'preset.yml'), 'utf8')
    expect(metadata).toContain('name: DevFlow')
    expect(metadata).toContain('description:')
    expect(metadata).toContain('order:')
    expect(metadata).not.toContain('@xiaoxie-ide/dsh-devflow')
    expect(metadata).not.toContain('- id:')
    expect(metadata).not.toContain('apply')
  })

  it('ships the same rows in the deployed harness-home copy', async () => {
    const text = await readFile(DEPLOYED_PRESET, 'utf8').catch(() => undefined)
    if (text === undefined) return
    const repository = await readFile(join(PRESETS, 'agent.cordis.yml'), 'utf8')
    expect(rowIds(text)).toEqual(rowIds(repository))
    // Only the adapter module reference differs: absolute in the deployed copy,
    // and carrying the revision token a running host needs — a standing mount
    // re-imports a row only when the composition's stamp changes, and an
    // unchanged module URL is served from the ESM cache, so bumping `rev` is
    // what delivers a rebuilt adapter to a host that is already running. The
    // module itself must stay this repository's built adapter.
    const deployedName = /name:\s*'([^']+)'/.exec(text)?.[1] ?? ''
    expect(deployedName).toMatch(/\?rev=[A-Za-z0-9._-]+$/)
    expect(fileURLToPath(deployedName).replaceAll('\\', '/'))
      .toBe(fileURLToPath(REPO_ACTIVATION_MODULE).replaceAll('\\', '/'))
    expect(text).toContain('agentPresetActivation: true')
  })
})
