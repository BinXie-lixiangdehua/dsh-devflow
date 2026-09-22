/**
 * DevFlow Agent Bridge: the standard connection layer between DevFlow task
 * packages and external Agent environments. A bridge is a pure renderer and
 * parser — it never executes an Agent, performs no file I/O, and knows no
 * concrete Agent vendor. Storage hands strings in, storage takes strings
 * out.
 * @module @xiaoxie-ide/dsh-devflow/bridge
 */

import { BUILTIN_AGENT_ROLES, SUPPORTED_PROTOCOL_VERSIONS } from './protocol.ts'
import type { AgentResultPackage, AgentTaskPackage } from './protocol.ts'

/** Known bridge kinds; MarkdownBridge lands in Task-012, more kinds follow. */
export type BridgeType = 'markdown'

/**
 * One transport between the DevFlow protocol and an external Agent
 * representation. Pure by contract: `exportTask` renders a package to
 * external form, `importResult` parses external form back into a result
 * package (fail loud on malformed input), and `validate` audits a package
 * before export.
 */
export interface AgentBridge {
  /** Stable bridge kind. */
  readonly name: BridgeType
  /**
   * Render one task package into the bridge's external form.
   * @param pkg - the task package to export.
   * @returns the external representation as text.
   */
  exportTask(pkg: AgentTaskPackage): string
  /**
   * Parse external result form back into a result package.
   * @param content - the external representation produced by an Agent.
   * @returns the validated result package.
   */
  importResult(content: string): AgentResultPackage
  /**
   * Audit one task package before export.
   * @param pkg - the package to audit.
   * @returns one problem per finding; an empty list means exportable.
   */
  validate(pkg: AgentTaskPackage): readonly string[]
}

/**
 * Assert that a parsed protocol version is one this build can consume.
 * @param version - the version read from external content.
 * @returns the accepted version.
 */
export function assertSupportedProtocolVersion(version: unknown): string {
  if (typeof version !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw new Error(`Invalid AgentResultPackage: unsupported protocol version ${JSON.stringify(version)}`)
  }
  return version
}

/**
 * Audit one task package before export: value-semantic checks across fields
 * (field presence and types are the TypeScript interface's guarantee). One
 * problem per finding; an empty list means the package is exportable.
 * @param pkg - the package to audit.
 * @returns the problem list.
 */
export function validateTaskPackage(pkg: AgentTaskPackage): string[] {
  const problems: string[] = []
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(pkg.protocolVersion)) {
    problems.push(`unsupported protocol version ${JSON.stringify(pkg.protocolVersion)}`)
  }
  if (pkg.taskId.trim() === '') {
    problems.push('taskId must be a non-empty string')
  }
  if (pkg.role.trim() === '') {
    problems.push('role must be a non-empty string')
  } else if (!(pkg.role in BUILTIN_AGENT_ROLES)) {
    problems.push(`unsupported role ${JSON.stringify(pkg.role)}; legacy executor packages are rejected`)
  }
  if (pkg.projectContext.goal.trim() === '') {
    problems.push('projectContext must carry a non-empty goal')
  }
  if (pkg.task.title.trim() === '') {
    problems.push('task must carry a non-empty title')
  }
  if (pkg.task.id !== pkg.taskId) {
    problems.push(`task id ${JSON.stringify(pkg.task.id)} does not match package taskId ${JSON.stringify(pkg.taskId)}`)
  }
  return problems
}
