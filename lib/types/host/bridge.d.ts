/**
 * DevFlow Agent Bridge: the standard connection layer between DevFlow task
 * packages and external Agent environments. A bridge is a pure renderer and
 * parser — it never executes an Agent, performs no file I/O, and knows no
 * concrete Agent vendor. Storage hands strings in, storage takes strings
 * out.
 * @module @xiaoxie-ide/dsh-devflow/bridge
 */
import type { AgentResultPackage, AgentTaskPackage } from './protocol.ts';
/** Known bridge kinds; MarkdownBridge lands in Task-012, more kinds follow. */
export type BridgeType = 'markdown';
/**
 * One transport between the DevFlow protocol and an external Agent
 * representation. Pure by contract: `exportTask` renders a package to
 * external form, `importResult` parses external form back into a result
 * package (fail loud on malformed input), and `validate` audits a package
 * before export.
 */
export interface AgentBridge {
    /** Stable bridge kind. */
    readonly name: BridgeType;
    /**
     * Render one task package into the bridge's external form.
     * @param pkg - the task package to export.
     * @returns the external representation as text.
     */
    exportTask(pkg: AgentTaskPackage): string;
    /**
     * Parse external result form back into a result package.
     * @param content - the external representation produced by an Agent.
     * @returns the validated result package.
     */
    importResult(content: string): AgentResultPackage;
    /**
     * Audit one task package before export.
     * @param pkg - the package to audit.
     * @returns one problem per finding; an empty list means exportable.
     */
    validate(pkg: AgentTaskPackage): readonly string[];
}
/**
 * Assert that a parsed protocol version is one this build can consume.
 * @param version - the version read from external content.
 * @returns the accepted version.
 */
export declare function assertSupportedProtocolVersion(version: unknown): string;
/**
 * Audit one task package before export: value-semantic checks across fields
 * (field presence and types are the TypeScript interface's guarantee). One
 * problem per finding; an empty list means the package is exportable.
 * @param pkg - the package to audit.
 * @returns the problem list.
 */
export declare function validateTaskPackage(pkg: AgentTaskPackage): string[];
