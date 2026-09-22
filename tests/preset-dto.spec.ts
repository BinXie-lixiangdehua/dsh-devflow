import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDevFlowClientSnapshot } from '../src/host/client-snapshot.ts'
import { initialDevFlowState } from '../src/host/state.ts'
import { parseDevFlowResponse } from '../src/client/remote.ts'
import { DEVFLOW_PRESET_ID, DEVFLOW_ACTIVATION_CODES } from '../src/host/preset-activation.ts'
import type { DevFlowBoundReport } from '../src/host/preset-activation.ts'
import { activationReasonZh } from '../src/host/activation-reason.ts'
import type { DevflowController } from '../src/host/index.ts'
import { testReadStore, testScopeResolver } from './support/session-scope.ts'

function controller(report: DevFlowBoundReport | null = null) {
  const state = initialDevFlowState()
  const commanderMode = {
    current: vi.fn(() => ({
      mode: report?.commanderMode ?? 'chat',
      sessionId: report === null ? null : 's-1',
      projectId: report?.projectId ?? null,
      changedAt: 'now',
    })),
  }
  const store = testReadStore(state)
  return {
    readState: () => state,
    resolveSessionScope: testScopeResolver(store),
    store,
    commanderMode,
    presetActivation: report === null ? undefined : {
      report: vi.fn(async () => report),
    },
  } as unknown as DevflowController
}

describe('preset activation DTO projection', () => {
  it('projects a verified bound session with presetId, activation, and verifiedAt', async () => {
    const report: DevFlowBoundReport = {
      presetId: DEVFLOW_PRESET_ID,
      commanderMode: 'commander',
      projectId: 'project-1',
      activation: 'bound',
      activationError: null,
      verifiedAt: '2026-09-10T00:00:00.000Z',
      lastFailure: null,
    }
    const snapshot = await createDevFlowClientSnapshot(controller(report), { id: 's-1' } as Agent)
    expect(snapshot.session).toEqual({
      id: 's-1',
      commanderMode: 'commander',
      // 第九步 项目标识：单库夹具没有工作区，于是两项都为空，
      // 面板据此回落为「本项目 <名字>」而不是编造一个工作区。
      workspacePath: null,
      storeRoot: './.devflow',
      presetId: DEVFLOW_PRESET_ID,
      activation: 'bound',
      activationError: null,
      verifiedAt: '2026-09-10T00:00:00.000Z',
      lastActivationFailure: null,
    })
  })

  it('carries a recorded refusal beside a bound posture instead of hiding it', async () => {
    // A session that was refused and then recovered is exactly the case an
    // operator must be able to read: `activation` says the session is healthy
    // now, and the recorded refusal says what went wrong on the way there.
    const report: DevFlowBoundReport = {
      presetId: DEVFLOW_PRESET_ID,
      commanderMode: 'commander',
      projectId: 'project-1',
      activation: 'bound',
      activationError: null,
      verifiedAt: '2026-09-10T00:00:00.000Z',
      lastFailure: {
        code: DEVFLOW_ACTIVATION_CODES.verificationFailed,
        phase: 'recompose',
        attempts: 4,
        reason: activationReasonZh(DEVFLOW_ACTIVATION_CODES.verificationFailed),
        at: '2026-09-10T00:00:00.000Z',
      },
    }
    const snapshot = await createDevFlowClientSnapshot(controller(report), { id: 's-4' } as Agent)
    expect(snapshot.session.activation).toBe('bound')
    expect(snapshot.session.activationError).toBeNull()
    expect(snapshot.session.lastActivationFailure).toEqual({
      code: DEVFLOW_ACTIVATION_CODES.verificationFailed,
      phase: 'recompose',
      attempts: 4,
      reason: activationReasonZh(DEVFLOW_ACTIVATION_CODES.verificationFailed),
      at: '2026-09-10T00:00:00.000Z',
    })
  })

  it('projects a bounded error surface without raw activation text', async () => {
    const report: DevFlowBoundReport = {
      presetId: DEVFLOW_PRESET_ID,
      commanderMode: 'chat',
      projectId: null,
      activation: 'error',
      activationError: {
        code: DEVFLOW_ACTIVATION_CODES.projectUnavailable,
        message: 'DevFlow project is unavailable for this session.',
      },
      verifiedAt: null,
      lastFailure: null,
    }
    const snapshot = await createDevFlowClientSnapshot(controller(report), { id: 's-2' } as Agent)
    expect(snapshot.session.activation).toBe('error')
    expect(snapshot.session.activationError?.code).toBe(DEVFLOW_ACTIVATION_CODES.projectUnavailable)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('prompt')
    expect(serialized).not.toContain('C:\\\\')
  })

  it('degrades to unbound defaults when no preset adapter is composed', async () => {
    const snapshot = await createDevFlowClientSnapshot(controller(), { id: 's-3' } as Agent)
    expect(snapshot.session).toMatchObject({
      id: 's-3',
      presetId: null,
      activation: 'unbound',
      activationError: null,
      verifiedAt: null,
    })
  })

  it('remote parse accepts the extended session and rejects an invalid activation', () => {
    const legacy = {
      kind: 'snapshot',
      snapshot: {
        version: 1, generatedAt: 'now',
        session: { id: 's-1', commanderMode: 'chat' },
        paused: false, project: null, agents: [], tasks: [], phases: [], assignments: [], executions: [],
        decisions: [], decisionRequests: [],
      },
    }
    const parsed = parseDevFlowResponse(legacy)
    expect(parsed.kind).toBe('snapshot')
    if (parsed.kind === 'snapshot') {
      expect(parsed.snapshot.session).toMatchObject({ id: 's-1', activation: 'unbound', presetId: null })
    }

    const bound = {
      kind: 'snapshot',
      snapshot: {
        version: 1, generatedAt: 'now',
        session: {
          id: 's-2', commanderMode: 'commander', presetId: DEVFLOW_PRESET_ID,
          activation: 'bound', activationError: null, verifiedAt: '2026-09-10T00:00:00.000Z',
        },
        paused: false, project: null, agents: [], tasks: [], phases: [], assignments: [], executions: [],
        decisions: [], decisionRequests: [],
      },
    }
    const parsedBound = parseDevFlowResponse(bound)
    if (parsedBound.kind === 'snapshot') {
      expect(parsedBound.snapshot.session.activation).toBe('bound')
      expect(parsedBound.snapshot.session.presetId).toBe(DEVFLOW_PRESET_ID)
    }

    const invalid = {
      kind: 'snapshot',
      snapshot: {
        version: 1, generatedAt: 'now',
        session: {
          id: 's-3', commanderMode: 'commander', presetId: DEVFLOW_PRESET_ID,
          activation: 'bound-forever', activationError: null, verifiedAt: null,
        },
        paused: false, project: null, agents: [], tasks: [], phases: [], assignments: [], executions: [],
        decisions: [], decisionRequests: [],
      },
    }
    expect(() => parseDevFlowResponse(invalid)).toThrow(/invalid DevFlow/)
  })
})
