/**
 * DevFlow Agent handoff protocol: the vendor-neutral envelopes Agents
 * exchange. The protocol defines roles and task/result packages only — no
 * Agent instances, no registry, no scheduling. Any Agent (Harness, Codex,
 * Claude Code, Cursor, a human operator, a future external Agent) joins the
 * workflow by consuming a task package and producing a result package.
 * Every function here is pure: no fs, no Agent, no I/O.
 * @module @xiaoxie-ide/dsh-devflow/protocol
 */

import type { Project, ResultVerdict, Task, TaskScopeGuard } from './types.ts'
import type { AssignedRole } from './types.ts'
import { isRecord, isString, isStringArray } from './json.ts'

/** The current wire protocol version; produced exports carry this. */
export const PROTOCOL_VERSION = '0.4'

/** Protocol versions this build can consume; exports always use the current version. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['0.1', '0.2', '0.3', '0.4']

/** Id of one built-in Agent role (the same value set as task assignments). */
export type AgentRoleId = AssignedRole

/** One Agent role definition: a responsibility contract, not an instance. */
export interface AgentRole {
  /** Stable role id, referenced by task packages and assignments. */
  readonly roleId: string
  /** Display name. */
  readonly name: string
  /** One-paragraph responsibility description. */
  readonly description: string
  /** Task input document template the role consumes. */
  readonly inputTemplate: string
  /** Result output document template the role produces. */
  readonly outputTemplate: string
  /** Capability tags for future role-based assignment. */
  readonly capabilities: readonly string[]
}

/** The four built-in roles of the fixed DevFlow team. */
export const BUILTIN_AGENT_ROLES: Readonly<Record<AgentRoleId, AgentRole>> = {
  planner: {
    roleId: 'planner',
    name: 'Commander',
    description: '唯一与用户直接交流的入口，负责理解需求、制定方案、拆分任务、派发任务、验收结果和决策弹窗。',
    inputTemplate: [
      '# Task input',
      '',
      '## Background',
      '## Goal',
      '## Scope',
      '## Requirements',
      '## Acceptance criteria',
    ].join('\n'),
    outputTemplate: [
      '# Task plan',
      '',
      '## Breakdown',
      '## Approach',
      '## Risks',
    ].join('\n'),
    capabilities: ['task-planning', 'requirements-analysis'],
  },
  'backend-engineer': {
    roleId: 'backend-engineer',
    name: 'Backend Engineer',
    description: '负责后端代码编写、接口实现、数据处理和后端验证。',
    inputTemplate: [
      '# Task input',
      '',
      '## Background',
      '## Goal',
      '## Scope',
      '## Requirements',
      '## Acceptance criteria',
    ].join('\n'),
    outputTemplate: [
      '# Task result',
      '',
      '## Summary',
      '## Changes',
      '## Verification',
      '## Issues',
      '## Next steps',
    ].join('\n'),
    capabilities: ['backend-implementation', 'file-modification', 'test-execution'],
  },
  'frontend-engineer': {
    roleId: 'frontend-engineer',
    name: 'Frontend UI Engineer',
    description: '负责前端页面、视觉呈现、交互行为和浏览器端验证。',
    inputTemplate: [
      '# Task input',
      '',
      '## Background',
      '## Goal',
      '## Scope',
      '## Requirements',
      '## Acceptance criteria',
    ].join('\n'),
    outputTemplate: [
      '# Task result',
      '',
      '## Summary',
      '## Changes',
      '## Verification',
      '## Issues',
      '## Next steps',
    ].join('\n'),
    capabilities: ['frontend-implementation', 'ui-interaction', 'browser-verification'],
  },
  reviewer: {
    roleId: 'reviewer',
    name: 'Code Auditor',
    description: '负责代码审查、安全检查和质量把关。',
    inputTemplate: [
      '# Review input',
      '',
      '## Task',
      '## Changes',
      '## Verification',
    ].join('\n'),
    outputTemplate: [
      '# Review result',
      '',
      '## Verdict',
      '## Findings',
      '## Required changes',
    ].join('\n'),
    capabilities: ['code-review', 'quality-check'],
  },
}

/** The envelope one Agent hands to another to request work. */
export interface AgentTaskPackage {
  /** Wire protocol version of this envelope. */
  readonly protocolVersion: string
  /** The task this package delivers. */
  readonly taskId: string
  /** Target role id (see {@link AgentRole.roleId}). */
  readonly role: string
  /** Project context the receiving Agent works against. */
  readonly projectContext: Project
  /** The task record being handed over. */
  readonly task: Task
  /** Free-form instructions for the receiving Agent. */
  readonly instructions: string
  /** Checkable acceptance criteria, one per entry. */
  readonly acceptanceCriteria: readonly string[]
  /** Optional file-scope boundary for the executing Agent (v0.2 extension). */
  readonly fileScope?: readonly string[]
  /** Optional task-level limits that override the project ScopeGuard. */
  readonly scopeGuard?: TaskScopeGuard
}

/** The envelope an executing Agent returns with its work. */
export interface AgentResultPackage {
  /** Wire protocol version of this envelope. */
  readonly protocolVersion: string
  /** The task this result answers. */
  readonly taskId: string
  /** Review outcome for this result; accepted results reset the retry count. */
  readonly verdict: ResultVerdict
  /** One-paragraph execution summary. */
  readonly summary: string
  /** Files, interfaces, or config changes made, one per entry. */
  readonly changes: readonly string[]
  /** Verification method and outcome, one per entry. */
  readonly verification: readonly string[]
  /** Unfinished work, risks, and follow-ups, one per entry. */
  readonly issues: readonly string[]
  /** Suggested next steps, one per entry. */
  readonly nextSteps: readonly string[]
}

/** Options controlling task package creation. */
export interface TaskPackageOptions {
  /** Target role; defaults to the task's `assignedRole`. */
  role?: string
  /** Free-form instructions; defaults to ''. */
  instructions?: string
  /** Acceptance criteria; defaults to []. */
  acceptanceCriteria?: readonly string[]
  /** File-scope boundary; omitted when not supplied. */
  fileScope?: readonly string[]
  /** Task-level limits; omitted to use the project ScopeGuard. */
  scopeGuard?: TaskScopeGuard
}

/**
 * Create the task package for one task against one project. Pure: no I/O.
 * @param task - the task to hand over.
 * @param project - the project context the receiving Agent works against.
 * @param options - role, instructions, and acceptance criteria overrides.
 * @returns the task package.
 */
export function createTaskPackage(task: Task, project: Project, options: TaskPackageOptions = {}): AgentTaskPackage {
  const role = options.role ?? task.assignedRole
  if (role === undefined) {
    throw new Error(`createTaskPackage: task ${task.id} has no assigned role; pass options.role`)
  }
  if (!(role in BUILTIN_AGENT_ROLES)) {
    throw new Error(`createTaskPackage: unsupported role ${JSON.stringify(role)}; legacy executor packages are rejected`)
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: task.id,
    role,
    projectContext: project,
    task,
    instructions: options.instructions ?? '',
    acceptanceCriteria: options.acceptanceCriteria ?? [],
    ...(options.fileScope === undefined ? {} : { fileScope: options.fileScope }),
    ...(options.scopeGuard === undefined ? {} : { scopeGuard: options.scopeGuard }),
  }
}

/**
 * Parse and validate one result package from an Agent. Pure: no I/O.
 * Missing fields, non-string values, and unsupported protocol versions are
 * rejected with the offending detail; empty arrays stay valid.
 * @param input - the raw parsed value (e.g. from JSON).
 * @returns the validated result package.
 */
export function parseResultPackage(input: unknown): AgentResultPackage {
  if (!isRecord(input)) throw new Error('Invalid agent result package: expected an object')
  const { protocolVersion, taskId, verdict, summary, changes, verification, issues, nextSteps } = input
  if (!isString(protocolVersion) || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    throw new Error(`Unsupported agent result protocol version: ${JSON.stringify(protocolVersion)}`)
  }
  if (!isString(taskId) || taskId.trim() === '' || !isString(summary) || summary.trim() === '') {
    throw new Error('Invalid agent result package: taskId and summary must be non-empty strings')
  }
  if (verdict !== 'accepted' && verdict !== 'changes-requested' && verdict !== 'rejected') {
    throw new Error(`Invalid agent result package: unsupported verdict ${JSON.stringify(verdict)}`)
  }
  if (!isStringArray(changes) || !isStringArray(verification) || !isStringArray(issues) || !isStringArray(nextSteps)) {
    throw new Error('Invalid agent result package: changes, verification, issues, and nextSteps must be string arrays')
  }
  return { protocolVersion, taskId, verdict, summary, changes, verification, issues, nextSteps }
}
