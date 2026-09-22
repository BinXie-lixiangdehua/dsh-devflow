/**
 * MarkdownBridge: the first AgentBridge representation — renders
 * AgentTaskPackage into a fixed, deterministic Markdown document an external
 * Executor Agent can consume. Pure string generation: no file I/O, no Agent
 * execution, no randomness — identical input yields byte-identical output.
 * @module @xiaoxie-ide/dsh-devflow/markdown-bridge
 */
import { type AgentBridge } from './bridge.ts';
import type { AgentResultPackage, AgentTaskPackage } from './protocol.ts';
/**
 * A result document that could not be accepted, with the bounded reason list.
 *
 * `problems` names only what is wrong with the document (missing section, key,
 * or an out-of-range verdict) — never the model's raw reply, so the list is safe
 * to persist in a report summary and to show in a tool error.
 */
export declare class ResultParseError extends Error {
    readonly problems: readonly string[];
    constructor(problems: readonly string[]);
}
/**
 * Parse one Markdown result document into a result package. Simple and
 * stable: the document is split on `##` headings and sections are mapped by
 * name; `protocolVersion`, `taskId`, and `summary` are required and fail
 * loud, the list sections default to []. No Markdown AST is involved.
 * @param markdown - the result document produced by an external Agent.
 * @returns the validated result package.
 */
export declare function parseResultMarkdown(markdown: string): AgentResultPackage;
/** Render one task package into the fixed Markdown template. Pure and deterministic. */
export declare function renderTaskMarkdown(pkg: AgentTaskPackage): string;
/**
 * The Markdown bridge: renders task packages to Markdown and (from Task-013
 * on) parses result Markdown back into result packages.
 */
export declare class MarkdownBridge implements AgentBridge {
    /** Stable bridge kind. */
    readonly name: "markdown";
    /**
     * Render one task package into Markdown. The package is audited first;
     * a non-exportable package fails loud.
     * @param pkg - the task package to export.
     * @returns the rendered Markdown document.
     */
    exportTask(pkg: AgentTaskPackage): string;
    /**
     * Parse one Markdown result document back into a result package.
     * @param content - the result document produced by an external Agent.
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
