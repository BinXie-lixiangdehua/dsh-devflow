#!/usr/bin/env node
/**
 * EXECUTABLE PLATFORM CHECK — is the `agent/created` window wide enough?
 *
 * ## The claim this pins
 *
 * DevFlow's host-side fallback (and, on `0.1.7+`, the ONLY installation path)
 * registers the Commander's tools from inside an `agent/created` listener and
 * relies on the host assembling that Agent's FIRST model request AFTER the edge
 * has been dispatched. That is a PLATFORM timing property, not a property of this
 * repository: no unit test in `tests/*.spec.ts` can observe it, because no unit
 * test has a host. Until this script existed the claim rested on manual sandbox
 * logs only, and a Harness change to the create/dispatch ordering would have
 * broken it silently.
 *
 * The check is therefore a real host run:
 *
 *   1. boot a named profile from a real Harness checkout;
 *   2. register a uniquely named MARKER tool from inside `agent/created`;
 *   3. create one session through the session CONTROLLER (the real agent path);
 *   4. read the Agent's `request/header` event with `reason === 'initial'` out of
 *      the persisted session log;
 *   5. PASS only when the marker tool name is in that first request's `tools`.
 *
 * `request/header` is the host's own record of what the first model call was
 * assembled with, so the reading does not depend on a model answering, on this
 * plugin's own bookkeeping, or on any log line the probe prints.
 *
 * ## Version notes (edit when you re-run against a new host)
 *
 * | host | measured | reading |
 * |---|---|---|
 * | `0.1.5-rc.2` (`dsh-v0.1.5-rc.2-140-g26091bec18`) | 2026-09-25 | see `window-check-015.txt` |
 * | `0.1.7-rc.1` (`dsh-v0.1.7-rc.1`) | 2026-09-20, manual headless log | marker reached the first request |
 *
 * The `0.1.7` row is the older, manual observation; re-run this script against a
 * `0.1.7` checkout to replace it with an executable reading.
 *
 * ## Usage
 *
 *   $env:DSH_HOST_WINDOW_REPO = 'D:\Deepseek\Harness'          # required
 *   $env:DSH_HOST_WINDOW_HOME = 'D:\path\to\throwaway-home'    # required
 *   $env:DSH_HOST_WINDOW_PROFILE = 'web'                       # optional
 *   $env:DSH_HOST_WINDOW_PORT = '3087'                         # optional
 *   node tests/host-window-check.e2e.mjs
 *
 * Exit code 0 = PASS, 1 = FAIL, 2 = could not run (missing env / host did not boot).
 * The file is named `*.e2e.mjs` on purpose: `vitest run tests` does not collect it,
 * so CI stays green on machines with no Harness checkout, while the check remains
 * one command away and re-runnable against any host version.
 *
 * @module dsh-devflow/tests/host-window-check
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.env.DSH_HOST_WINDOW_REPO
const HOME = process.env.DSH_HOST_WINDOW_HOME
const PROFILE = process.env.DSH_HOST_WINDOW_PROFILE ?? 'web'
const PORT = process.env.DSH_HOST_WINDOW_PORT ?? '3087'
const MARKER = 'window_check_marker_tool'
const BOOT_TIMEOUT_MS = 180_000
const ANSWER_TIMEOUT_MS = 90_000

const say = message => process.stdout.write(`window-check: ${message}\n`)

if (REPO === undefined || HOME === undefined) {
  say('FAIL could not run — set DSH_HOST_WINDOW_REPO and DSH_HOST_WINDOW_HOME (see the header of this file).')
  process.exit(2)
}

/** The host identity the reading belongs to; printed so a re-run is comparable. */
function hostVersions(repo) {
  const manifest = JSON.parse(readFileSync(join(repo, 'apps', 'cli', 'package.json'), 'utf8'))
  let describe = 'unknown'
  try {
    describe = execFileSync('git', ['-C', repo, 'describe', '--tags'], { encoding: 'utf8' }).trim()
  } catch { /* a checkout without git facts still reports its manifest version */ }
  return { version: String(manifest.version), describe }
}

/**
 * The probe module the host loads. It registers the marker from inside the very
 * edge under test and drives one session, printing raw machine-readable lines.
 */
const PROBE_MODULE = `
const LOG = message => process.stderr.write('WINDOWCHECK ' + message + '\\n')
const MARKER = ${JSON.stringify(MARKER)}
const WORKSPACE = ${JSON.stringify(join(tmpdir(), 'dsh-host-window-workspace'))}
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

export const name = 'window-check-probe'
export const inject = ['sessionController']

export function apply(ctx) {
  ctx.on('agent/created', payload => {
    const agent = payload && payload.agent
    if (agent === undefined) return
    LOG('agent/created ' + String(agent.id) + ' — registering marker from inside the edge')
    try {
      agent.ctx.tools.register({
        name: MARKER,
        description: 'Window probe marker tool registered from an agent/created listener.',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {} },
          render: () => [{ type: 'text', text: 'marker' }],
        },
        execute: async () => ({}),
      })
      LOG('marker registered on the Agent scope')
    } catch (error) {
      LOG('marker registration FAILED ' + String(error && error.message))
    }
  })
  setTimeout(() => { void run(ctx) }, 6000)
}

async function run(ctx) {
  try {
    const controller = ctx.get('sessionController')
    if (controller === undefined) { LOG('VERDICT FAIL sessionController unavailable'); return }
    const created = await controller.create({ cwd: WORKSPACE })
    LOG('create() => ' + String(created && created.sessionId))
    // The prompt is what makes the host ASSEMBLE a first model request. No
    // credential is needed: the host persists \`request/header\` while assembling,
    // before any provider is contacted, so the reading holds even when the model
    // call itself fails.
    try {
      const receipt = await controller.prompt({
        requestId: 'window-check-' + String(Date.now()),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'window check' }],
      }, new AbortController().signal)
      LOG('prompt() receipt=' + JSON.stringify(receipt))
    } catch (error) {
      LOG('prompt() rejected ' + String(error && error.message))
    }
    const deadline = Date.now() + ${ANSWER_TIMEOUT_MS}
    for (;;) {
      let inspection
      try { inspection = await controller.inspect(created.sessionId) } catch (error) {
        LOG('inspect() failed ' + String(error && error.message))
        await sleep(5000)
        continue
      }
      const events = Array.isArray(inspection && inspection.events) ? inspection.events : []
      const initial = events.find(entry => String(entry && entry.type) === 'request/header'
        && entry.data && entry.data.reason === 'initial')
      if (initial !== undefined) {
        const tools = (initial.data.header && initial.data.header.tools) || []
        const names = tools.map(tool => String(tool && tool.name))
        LOG('initial request tools (' + names.length + ') = [' + names.join(',') + ']')
        LOG('marker present = ' + String(names.includes(MARKER)))
        LOG('VERDICT ' + (names.includes(MARKER) ? 'PASS' : 'FAIL'))
        return
      }
      if (Date.now() > deadline) { LOG('VERDICT FAIL no initial request/header within the budget'); return }
      await sleep(3000)
    }
  } catch (error) {
    LOG('VERDICT FAIL ' + String(error && error.name) + ': ' + String(error && error.message))
  } finally {
    setTimeout(() => process.exit(0), 500)
  }
}
`

/** The overlay that mounts the probe; written beside it so nothing lands in the checkout. */
const PROBE_PATCH = `# Generated by tests/host-window-check.e2e.mjs — mounts the window probe.
- insert:
    - id: window-check-probe
      name: 'file:///${join(tmpdir(), 'dsh-host-window-check').replaceAll('\\', '/')}/probe.mjs'
`

function main() {
  const versions = hostVersions(REPO)
  say(`host version=${versions.version} describe=${versions.describe}`)
  say(`profile=${PROFILE} port=${PORT} home=${HOME}`)
  say(`marker=${MARKER}`)

  const scratch = join(tmpdir(), 'dsh-host-window-check')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  mkdirSync(join(tmpdir(), 'dsh-host-window-workspace'), { recursive: true })
  writeFileSync(join(scratch, 'probe.mjs'), PROBE_MODULE)
  writeFileSync(join(scratch, 'probe.patch.yml'), PROBE_PATCH)

  const child = spawn(process.execPath, [
    '--expose-internals',
    '--import', 'tsx/esm',
    'apps/cli/src/bin.ts',
    '--profile', PROFILE,
    '--patch', join(scratch, 'probe.patch.yml'),
    '--port', PORT,
    '--no-open',
  ], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let verdict
  const consume = chunk => {
    for (const line of String(chunk).split('\n')) {
      if (!line.startsWith('WINDOWCHECK ')) continue
      const text = line.slice('WINDOWCHECK '.length)
      say(text)
      if (text.startsWith('VERDICT ')) verdict = text.slice('VERDICT '.length).trim()
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)

  const bootTimer = setTimeout(() => {
    say('FAIL host did not boot within the budget')
    child.kill()
  }, BOOT_TIMEOUT_MS)

  child.on('exit', code => {
    clearTimeout(bootTimer)
    say(`host exited code=${String(code)} verdict=${String(verdict)}`)
    if (verdict === undefined) {
      say('FAIL could not run — the host produced no verdict line; see the lines above.')
      process.exit(2)
    }
    say(verdict === 'PASS'
      ? 'PASS — a tool registered inside agent/created reached the Agent\'s FIRST request.'
      : 'FAIL — the marker tool did NOT reach the Agent\'s first request; the window has closed.')
    process.exit(verdict === 'PASS' ? 0 : 1)
  })
}

main()
