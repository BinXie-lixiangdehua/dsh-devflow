window.__ModuleLoader__.load({
	id: "@xiaoxie-ide/dsh-devflow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		/** The closed vocabulary a `changed` frame's `changes[].type` may use. */
		const DEVFLOW_CLIENT_CHANGE_KINDS = [
			"task-reviewing",
			"task-executing",
			"task-settled",
			"execution-started",
			"execution-settled",
			"assignment-created",
			"assignment-settled"
		];
		//#endregion
		//#region lib/client/remote.js
		const agentParameter = {
			name: "agent",
			wire: "agentId",
			source: "lookup",
			lookup: "agent",
			codec: {
				mode: "strict",
				typeSymbol: "session-id",
				schema: { parse: (value) => requireString(value, "session id") }
			}
		};
		/** Client-side Remote contribution for DevFlow's narrow public bridge. */
		const DEVFLOW_REMOTE = {
			package: "@xiaoxie-ide/dsh-devflow",
			descriptors: [
				{
					id: "@xiaoxie-ide/dsh-devflow#devflowClient/snapshot",
					service: "devflowClient",
					namespace: "devflow",
					method: "snapshot",
					invocation: { kind: "direct" },
					scope: {
						context: "agent",
						wire: "agentId"
					},
					parameters: [agentParameter],
					result: {
						mode: "strict",
						typeSymbol: "devflow-client-snapshot-response",
						schema: { parse: parseDevFlowResponse }
					}
				},
				{
					id: "@xiaoxie-ide/dsh-devflow#devflowClient/refresh",
					service: "devflowClient",
					namespace: "devflow",
					method: "refresh",
					invocation: { kind: "direct" },
					scope: {
						context: "agent",
						wire: "agentId"
					},
					parameters: [agentParameter],
					result: {
						mode: "strict",
						typeSymbol: "devflow-client-snapshot-response",
						schema: { parse: parseDevFlowResponse }
					}
				},
				{
					id: "@xiaoxie-ide/dsh-devflow#devflowClient/audit-page",
					service: "devflowClient",
					namespace: "devflow",
					method: "audit-page",
					implementation: "auditPage",
					invocation: { kind: "direct" },
					scope: {
						context: "agent",
						wire: "agentId"
					},
					parameters: [agentParameter, {
						name: "query",
						wire: "query",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "devflow-client-audit-query",
							schema: { parse: parseAuditQuery }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "devflow-client-audit-page-response",
						schema: { parse: parseDevFlowAuditResponse }
					}
				},
				{
					id: "@xiaoxie-ide/dsh-devflow#devflowClient/follow",
					service: "devflowClient",
					namespace: "devflow",
					method: "follow",
					mode: "stream",
					invocation: { kind: "direct" },
					scope: {
						context: "agent",
						wire: "agentId"
					},
					parameters: [agentParameter, {
						name: "request",
						wire: "request",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "devflow-client-follow-request",
							schema: { parse: parseFollowRequest }
						}
					}],
					cancellation: { parameter: "signal" },
					result: {
						mode: "strict",
						typeSymbol: "devflow-client-event",
						schema: { parse: parseDevFlowEvent }
					}
				}
			]
		};
		/**
		* Strictly parse the follow request. The cursor is advisory — a channel that cannot
		* read it still opens with a full snapshot — so anything unrecognized degrades to
		* `null` rather than failing the subscription.
		*/
		function parseFollowRequest(value) {
			if (!isRecord(value)) return { sequence: null };
			const sequence = value.sequence;
			return { sequence: typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null };
		}
		/** Strictly parse one live-channel frame; an unknown shape is dropped by the caller. */
		function parseDevFlowEvent(value) {
			if (!isRecord(value) || typeof value.kind !== "string") throw new Error("invalid DevFlow event");
			if (value.kind === "snapshot") {
				const parsed = parseDevFlowResponse({
					kind: "snapshot",
					snapshot: value.snapshot
				});
				if (parsed.kind !== "snapshot") throw new Error("invalid DevFlow event snapshot");
				return {
					kind: "snapshot",
					snapshot: parsed.snapshot
				};
			}
			if (value.kind !== "changed") throw new Error("invalid DevFlow event kind");
			const revision = value.revision;
			if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid DevFlow event revision");
			const sequence = value.sequence;
			if (sequence !== null && (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0)) throw new Error("invalid DevFlow event sequence");
			if (typeof value.at !== "string" || !validTime(value.at)) throw new Error("invalid DevFlow event time");
			if (!Array.isArray(value.changed) || value.changed.length > 12 || !value.changed.every((item) => isBoundedString(item, 240))) throw new Error("invalid DevFlow event paths");
			return {
				kind: "changed",
				revision,
				sequence: sequence === null ? null : sequence,
				changed: value.changed,
				changes: parseChanges(value.changes),
				at: value.at
			};
		}
		/**
		* Read the optional semantic change list off one frame.
		*
		* Absent is the ordinary case for an older host and answers `[]` — the frame then
		* means exactly what it meant before this field existed. A PRESENT but malformed
		* list throws, because "the host sent a shape we cannot read" is the contract-break
		* the caller must degrade on; quietly returning `[]` would let a broken contract
		* keep looking like an idle canvas. An unknown `type` is likewise a contract break:
		* the vocabulary is closed, so a new kind means a newer host and this build must not
		* guess at it.
		* @param value - the raw `changes` value.
		* @returns the bounded change list, or `[]` when the field is absent.
		*/
		function parseChanges(value) {
			if (value === void 0 || value === null) return [];
			if (!Array.isArray(value) || value.length > 8) throw new Error("invalid DevFlow event changes");
			return value.map((item) => {
				if (!isRecord(item) || !isBoundedString(item.type, 64) || !DEVFLOW_CLIENT_CHANGE_KINDS.includes(item.type) || !isBoundedString(item.id, 128) || !validTime(item.at)) throw new Error("invalid DevFlow event change");
				return {
					type: item.type,
					id: item.id,
					at: item.at
				};
			});
		}
		function parseDevFlowResponse(value) {
			if (!isRecord(value) || typeof value.kind !== "string") throw new Error("invalid DevFlow bridge response");
			if (value.kind === "error") {
				if (!isRecord(value.error)) throw new Error("invalid DevFlow bridge error");
				if (value.error.code === "scope-unavailable" && value.error.message === "DevFlow cannot isolate this session: it has no project workspace. Shared state is not shown.") return {
					kind: "error",
					error: {
						code: "scope-unavailable",
						message: "DevFlow cannot isolate this session: it has no project workspace. Shared state is not shown."
					}
				};
				if (value.error.code !== "state-unavailable" || value.error.message !== "DevFlow state is unavailable. Refresh to try again.") throw new Error("invalid DevFlow bridge error");
				return {
					kind: "error",
					error: {
						code: "state-unavailable",
						message: "DevFlow state is unavailable. Refresh to try again."
					}
				};
			}
			if (value.kind !== "snapshot" || !isRecord(value.snapshot)) throw new Error("invalid DevFlow bridge response");
			const snapshot = value.snapshot;
			if (snapshot.version !== 1 || typeof snapshot.generatedAt !== "string" || !isRecord(snapshot.session) || typeof snapshot.session.id !== "string" || snapshot.session.commanderMode !== "chat" && snapshot.session.commanderMode !== "commander" || typeof snapshot.paused !== "boolean" || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.phases) || !Array.isArray(snapshot.assignments) || !Array.isArray(snapshot.executions) || !Array.isArray(snapshot.decisions) || !Array.isArray(snapshot.decisionRequests) || snapshot.project !== null && !isRecord(snapshot.project) || !optionalSummaries(snapshot) || !optionalArray(snapshot.blocked, isBlockedRow)) throw new Error("invalid DevFlow snapshot");
			return {
				kind: "snapshot",
				snapshot: {
					version: 1,
					generatedAt: snapshot.generatedAt,
					session: normalizeSessionState(snapshot.session),
					paused: snapshot.paused,
					project: snapshot.project,
					agents: snapshot.agents,
					tasks: snapshot.tasks,
					phases: snapshot.phases,
					assignments: snapshot.assignments,
					executions: snapshot.executions,
					...snapshot.results === void 0 ? {} : { results: snapshot.results.map(normalizeResultSummary) },
					...snapshot.reports === void 0 ? {} : { reports: snapshot.reports.map(normalizeReportSummary) },
					...snapshot.attempts === void 0 ? {} : { attempts: snapshot.attempts.map(normalizeAttemptSummary) },
					...snapshot.failures === void 0 ? {} : { failures: snapshot.failures.map(normalizeFailureSummary) },
					...snapshot.blocked === void 0 ? {} : { blocked: snapshot.blocked.map(normalizeBlockedRow) },
					decisions: snapshot.decisions,
					decisionRequests: snapshot.decisionRequests
				}
			};
		}
		/** Strictly parse a browser-supplied safe page query; unknown fields are dropped. */
		function parseAuditQuery(value) {
			if (!isRecord(value)) throw new Error("invalid DevFlow audit query");
			const cursor = value.cursor === void 0 ? void 0 : requireBoundedString(value.cursor, "cursor", 2048);
			const filter = value.filter === void 0 ? void 0 : parseAuditFilter(value.filter);
			let range;
			if (value.range !== void 0) {
				if (!isRecord(value.range)) throw new Error("invalid DevFlow audit range");
				const from = value.range.from === void 0 ? void 0 : requireTime(value.range.from);
				const to = value.range.to === void 0 ? void 0 : requireTime(value.range.to);
				range = {
					...from === void 0 ? {} : { from },
					...to === void 0 ? {} : { to }
				};
			}
			return {
				...cursor === void 0 ? {} : { cursor },
				...filter === void 0 ? {} : { filter },
				...range === void 0 ? {} : { range }
			};
		}
		function parseDevFlowAuditResponse(value) {
			if (!isRecord(value) || typeof value.kind !== "string") throw new Error("invalid DevFlow audit response");
			if (value.kind === "error") return {
				kind: "error",
				error: parseAuditError(value.error)
			};
			if (value.kind !== "page" || !isRecord(value.page)) throw new Error("invalid DevFlow audit response");
			const page = value.page;
			if (page.version !== 1 || page.source !== "devflow-journal" || page.projectId !== null && !isBoundedId(page.projectId) || !isRecord(page.range) || !validTime(page.range.from) || !validTime(page.range.to) || !Array.isArray(page.items) || page.items.length > 20 || page.nextCursor !== null && !isBoundedString(page.nextCursor, 2048) || page.capturedHeadSequence !== null && !isSequence(page.capturedHeadSequence) || !isNonNegativeInteger(page.omittedUnsafeCount) || typeof page.truncated !== "boolean" || !page.items.every(isAuditItem)) throw new Error("invalid DevFlow audit page");
			const normalized = {
				version: 1,
				source: "devflow-journal",
				projectId: page.projectId,
				range: {
					from: page.range.from,
					to: page.range.to
				},
				items: page.items.map(normalizeAuditItem),
				nextCursor: page.nextCursor,
				capturedHeadSequence: page.capturedHeadSequence,
				omittedUnsafeCount: page.omittedUnsafeCount,
				truncated: page.truncated
			};
			if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 49152) throw new Error("invalid DevFlow audit page");
			return {
				kind: "page",
				page: normalized
			};
		}
		function parseAuditError(value) {
			if (!isRecord(value)) throw new Error("invalid DevFlow audit error");
			if (value.code === "audit-unavailable" && value.message === "DevFlow audit is unavailable. Refresh to try again.") return {
				code: value.code,
				message: value.message
			};
			if (value.code === "cursor-invalid" && value.message === "DevFlow audit history changed. Refresh to try again.") return {
				code: value.code,
				message: value.message
			};
			throw new Error("invalid DevFlow audit error");
		}
		function parseAuditFilter(value) {
			if (!isRecord(value) || typeof value.kind !== "string") throw new Error("invalid DevFlow audit filter");
			if (value.kind === "project") return { kind: "project" };
			if ([
				"phase",
				"task",
				"agent",
				"execution",
				"decision"
			].includes(value.kind) && isBoundedId(value.id)) return {
				kind: value.kind,
				id: value.id
			};
			throw new Error("invalid DevFlow audit filter");
		}
		function normalizeSafeText(value) {
			return {
				text: value.text,
				truncated: value.truncated,
				redacted: value.redacted
			};
		}
		/** Tolerantly normalize one session state; missing activation fields degrade to unbound. */
		function normalizeSessionState(value) {
			if (typeof value.id !== "string" || value.commanderMode !== "chat" && value.commanderMode !== "commander") throw new Error("invalid DevFlow session state");
			const presetId = value.presetId === void 0 || value.presetId === null ? null : value.presetId;
			if (presetId !== null && !isBoundedString(presetId, 128)) throw new Error("invalid DevFlow session presetId");
			const rawActivation = value.activation === void 0 || value.activation === null ? "unbound" : value.activation;
			if (rawActivation !== "bound" && rawActivation !== "unbound" && rawActivation !== "error") throw new Error("invalid DevFlow session activation");
			let activationError = null;
			if (value.activationError !== void 0 && value.activationError !== null) {
				const error = value.activationError;
				if (!isBoundedString(error.code, 128) || !isBoundedString(error.message, 240) || error.code === void 0) throw new Error("invalid DevFlow activation error");
				activationError = {
					code: error.code,
					message: error.message
				};
			}
			const verifiedAt = value.verifiedAt === void 0 || value.verifiedAt === null ? null : value.verifiedAt;
			if (verifiedAt !== null && !validTime(verifiedAt)) throw new Error("invalid DevFlow session verifiedAt");
			const workspacePath = value.workspacePath === void 0 || value.workspacePath === null ? null : value.workspacePath;
			if (workspacePath !== null && !isBoundedString(workspacePath, 512)) throw new Error("invalid DevFlow session workspacePath");
			const storeRoot = value.storeRoot === void 0 || value.storeRoot === null ? null : value.storeRoot;
			if (storeRoot !== null && !isBoundedString(storeRoot, 512)) throw new Error("invalid DevFlow session storeRoot");
			return {
				id: value.id,
				commanderMode: value.commanderMode,
				workspacePath,
				storeRoot,
				presetId,
				activation: rawActivation,
				activationError,
				verifiedAt,
				lastActivationFailure: normalizeActivationFailure(value.lastActivationFailure)
			};
		}
		/**
		* Read one recorded activation refusal off the wire.
		*
		* Absent is the ordinary case (no refusal recorded) and answers null. A present
		* but malformed record is dropped rather than thrown: this field accompanies
		* the session, and rejecting the whole snapshot would hide every other panel
		* fact because one optional diagnosis was unreadable.
		* @param value - the wire value for the record.
		* @returns the bounded record, or null.
		*/
		function normalizeActivationFailure(value) {
			if (value === void 0 || value === null || typeof value !== "object") return null;
			const record = value;
			if (!isBoundedString(record.code, 128) || !isBoundedString(record.reason, 240) || !isBoundedString(record.phase, 32) || !validTime(record.at) || typeof record.attempts !== "number" || !Number.isSafeInteger(record.attempts) || record.attempts < 1) return null;
			return {
				code: record.code,
				phase: record.phase,
				attempts: record.attempts,
				reason: record.reason,
				at: record.at
			};
		}
		function normalizeResultSummary(value) {
			const item = value;
			return {
				id: item.id,
				taskId: item.taskId,
				source: "result",
				at: item.at,
				summary: normalizeSafeText(item.summary)
			};
		}
		function normalizeReportSummary(value) {
			const item = value;
			return {
				id: item.id,
				executionId: item.executionId,
				...item.taskId === void 0 ? {} : { taskId: item.taskId },
				agentId: item.agentId,
				source: "report",
				status: item.status,
				at: item.at,
				summary: normalizeSafeText(item.summary)
			};
		}
		function normalizeAttemptSummary(value) {
			const item = value;
			return {
				id: item.id,
				executionId: item.executionId,
				source: "attempt",
				status: item.status,
				isRetry: item.isRetry,
				at: item.at,
				completedAt: item.completedAt
			};
		}
		function normalizeFailureSummary(value) {
			const item = value;
			return {
				id: item.id,
				executionId: item.executionId,
				...item.taskId === void 0 ? {} : { taskId: item.taskId },
				agentId: item.agentId,
				source: item.source,
				status: item.status,
				at: item.at,
				summary: item.summary === null ? null : normalizeSafeText(item.summary)
			};
		}
		function normalizeAuditItem(value) {
			const item = value;
			const entity = item.entity;
			const related = item.related;
			return {
				id: item.id,
				sequence: item.sequence,
				category: item.category,
				action: item.action,
				at: item.at,
				entity: {
					type: entity.type,
					id: entity.id,
					display: entity.display === null ? null : normalizeSafeText(entity.display)
				},
				related: pickRelated(related),
				status: item.status,
				summary: item.summary === null ? null : normalizeSafeText(item.summary),
				incomplete: item.incomplete
			};
		}
		function pickRelated(value) {
			return Object.fromEntries([
				"projectId",
				"taskId",
				"phaseId",
				"agentId",
				"assignmentId",
				"executionId",
				"attemptId",
				"reportId",
				"decisionId",
				"requestId"
			].flatMap((key) => typeof value[key] === "string" ? [[key, value[key]]] : []));
		}
		function optionalSummaries(snapshot) {
			return optionalArray(snapshot.results, isResultSummary) && optionalArray(snapshot.reports, isReportSummary) && optionalArray(snapshot.attempts, isAttemptSummary) && optionalArray(snapshot.failures, isFailureSummary);
		}
		function optionalArray(value, predicate) {
			return value === void 0 || Array.isArray(value) && value.length <= 20 && value.every(predicate);
		}
		function isSafeText(value) {
			return isRecord(value) && typeof value.text === "string" && value.text.length <= 500 && typeof value.truncated === "boolean" && typeof value.redacted === "boolean";
		}
		function isResultSummary(value) {
			return isRecord(value) && typeof value.id === "string" && typeof value.taskId === "string" && value.source === "result" && typeof value.at === "string" && isSafeText(value.summary);
		}
		function isReportSummary(value) {
			return isRecord(value) && typeof value.id === "string" && typeof value.executionId === "string" && (value.taskId === void 0 || typeof value.taskId === "string") && typeof value.agentId === "string" && value.source === "report" && (value.status === "success" || value.status === "failed" || value.status === "blocked") && typeof value.at === "string" && isSafeText(value.summary);
		}
		function isAttemptSummary(value) {
			return isRecord(value) && typeof value.id === "string" && typeof value.executionId === "string" && value.source === "attempt" && (value.status === "created" || value.status === "running" || value.status === "completed" || value.status === "failed") && typeof value.isRetry === "boolean" && typeof value.at === "string" && (value.completedAt === null || typeof value.completedAt === "string");
		}
		function isFailureSummary(value) {
			return isRecord(value) && typeof value.id === "string" && typeof value.executionId === "string" && (value.taskId === void 0 || typeof value.taskId === "string") && typeof value.agentId === "string" && (value.source === "execution" || value.source === "report") && (value.status === "failed" || value.status === "blocked") && typeof value.at === "string" && (value.summary === null || isSafeText(value.summary));
		}
		function isBlockedRow(value) {
			return isRecord(value) && typeof value.id === "string" && typeof value.taskId === "string" && typeof value.agentId === "string" && typeof value.agentName === "string" && GAP_KINDS.includes(value.gapKind) && typeof value.missing === "string" && typeof value.suggestedOwner === "string" && isSafeText(value.reason) && typeof value.headline === "string" && validTime(value.at);
		}
		function normalizeBlockedRow(value) {
			const item = value;
			return {
				id: item.id,
				taskId: item.taskId,
				agentId: item.agentId,
				agentName: item.agentName,
				gapKind: item.gapKind,
				missing: item.missing,
				suggestedOwner: item.suggestedOwner,
				reason: normalizeSafeText(item.reason),
				headline: item.headline,
				at: item.at
			};
		}
		const CATEGORIES = [
			"project",
			"task",
			"phase",
			"agent",
			"assignment",
			"execution",
			"attempt",
			"report",
			"decision",
			"control",
			"scope",
			"bridge-review",
			"runtime",
			"commander-action"
		];
		const GAP_KINDS = [
			"tool",
			"permission",
			"dependency",
			"unstated"
		];
		const ACTIONS = [
			"updated",
			"created",
			"removed",
			"transitioned",
			"assigned",
			"unassigned",
			"started",
			"completed",
			"failed",
			"blocked",
			"requested",
			"answered",
			"paused",
			"resumed",
			"imported",
			"exported",
			"boundary-hit",
			"executed",
			"closed"
		];
		const ENTITY_TYPES = [
			"project",
			"task",
			"phase",
			"agent",
			"assignment",
			"execution",
			"attempt",
			"report",
			"decision-request",
			"decision",
			"batch",
			"runtime-session",
			"review",
			"action",
			"unknown"
		];
		function isAuditItem(value) {
			if (!isRecord(value) || !isBoundedId(value.id) || !isSequence(value.sequence) || !CATEGORIES.includes(value.category) || !ACTIONS.includes(value.action) || !validTime(value.at) || !isRecord(value.entity) || !ENTITY_TYPES.includes(value.entity.type) || value.entity.id !== null && !isBoundedId(value.entity.id) || value.entity.display !== null && !isSafeText(value.entity.display) || !isRecord(value.related) || value.status !== null && !isBoundedString(value.status, 64) || value.summary !== null && !isSafeText(value.summary) || typeof value.incomplete !== "boolean") return false;
			return Object.values(value.related).every(isBoundedId);
		}
		function requireTime(value) {
			if (!validTime(value)) throw new Error("invalid DevFlow audit time");
			return value;
		}
		function requireString(value, label) {
			if (typeof value !== "string" || value === "") throw new Error(`invalid ${label}`);
			return value;
		}
		function requireBoundedString(value, label, max) {
			if (!isBoundedString(value, max)) throw new Error(`invalid ${label}`);
			return value;
		}
		function isBoundedString(value, max) {
			return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1F]/.test(value);
		}
		function isBoundedId(value) {
			return isBoundedString(value, 128);
		}
		function validTime(value) {
			return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
		}
		function isSequence(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
		}
		function isNonNegativeInteger(value) {
			return isSequence(value);
		}
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		//#endregion
		//#region lib/client/sidebar-definition.js
		/** The tab kind this plugin owns; what `openTab` names. */
		const DEVFLOW_KIND = "devflow";
		/** This implementation's identity in the tab system, and the key its body and title register under. */
		const DEVFLOW_ID = "@xiaoxie-ide/dsh-devflow";
		/**
		* The DevFlow type's registry definition.
		* @param t - namespace-bound translate, read fresh on every label call.
		* @returns the definition to register into `ctx.sidebarRightTabs`.
		*/
		function devflowDefinition(t) {
			return {
				id: DEVFLOW_ID,
				kind: DEVFLOW_KIND,
				priority: "extension",
				title: () => t("canvas"),
				guide: [{
					order: 20,
					title: () => t("sidebarGuideTitle"),
					description: () => t("sidebarGuideDescription")
				}]
			};
		}
		//#endregion
		//#region lib/client/store.js
		const INITIAL_CONNECTION_STATE = {
			phase: "connecting",
			sequence: null,
			revision: null,
			detail: null,
			attempts: 0
		};
		/** Fixed fallback wording; never carries a raw transport error. */
		const CONNECTION_LOST_DETAIL = "实时连接已断开，正在使用轮询";
		/** How long a live channel may stay silent before the panel treats it as lost. */
		const CHANNEL_SILENCE_MS = 45e3;
		const INITIAL_STATE = {
			phase: "loading",
			snapshot: null,
			error: null
		};
		const INITIAL_AUDIT_STATE = {
			phase: "idle",
			filter: null,
			page: null,
			error: null
		};
		const AUDIT_UNAVAILABLE = {
			code: "audit-unavailable",
			message: "DevFlow audit is unavailable. Refresh to try again."
		};
		/** Per-session audit reader. It never participates in the regular snapshot poll. */
		var DevFlowAuditController = class {
			state = INITIAL_AUDIT_STATE;
			listeners = /* @__PURE__ */ new Set();
			requestGeneration = 0;
			pending;
			remote;
			scopeKey = null;
			constructor(remote) {
				this.remote = remote;
			}
			setRemote(remote) {
				this.remote = remote;
			}
			getSnapshot = () => this.state;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			dispose() {
				this.requestGeneration++;
				this.listeners.clear();
			}
			ensure(filter, scopeKey) {
				const nextScopeKey = scopeKey ?? this.scopeKey;
				const scopeChanged = nextScopeKey !== this.scopeKey;
				this.scopeKey = nextScopeKey;
				if (!scopeChanged && sameFilter(this.state.filter, filter) && this.state.phase !== "idle") return this.pending ?? Promise.resolve();
				return this.reset(filter);
			}
			retry() {
				const filter = this.state.filter;
				if (filter === null) return Promise.resolve();
				return this.state.page === null ? this.reset(filter) : this.refresh();
			}
			refresh() {
				if (this.state.filter === null) return Promise.resolve();
				return this.load(this.state.filter, void 0, "refreshing");
			}
			loadMore() {
				if (this.state.phase !== "ready" || this.state.page.nextCursor === null) return Promise.resolve();
				return this.load(this.state.filter, this.state.page.nextCursor, "loading-more");
			}
			reset(filter) {
				this.requestGeneration++;
				this.pending = void 0;
				return this.load(filter, void 0, "loading");
			}
			load(filter, cursor, mode) {
				if (mode === "loading") this.set({
					phase: "loading",
					filter,
					page: null,
					error: null
				});
				const remote = this.remote;
				if (remote === void 0 || typeof remote["audit-page"] !== "function") {
					this.fail(filter);
					return Promise.resolve();
				}
				if (mode !== "loading" && this.state.page !== null) this.set({
					phase: mode,
					filter,
					page: this.state.page,
					error: null
				});
				const generation = ++this.requestGeneration;
				const request = remote["audit-page"]({
					filter,
					...cursor === void 0 ? {} : { cursor }
				}).then((result) => this.apply(generation, filter, cursor, result)).catch(() => this.fail(filter, generation)).finally(() => {
					if (generation === this.requestGeneration) this.pending = void 0;
				});
				this.pending = request;
				return request;
			}
			apply(generation, filter, cursor, result) {
				if (generation !== this.requestGeneration) return;
				if (!result.ok) return this.fail(filter, generation);
				let response;
				try {
					response = parseDevFlowAuditResponse(result.value);
				} catch {
					return this.fail(filter, generation);
				}
				if (response.kind === "error") {
					if (response.error.code === "cursor-invalid" && cursor !== void 0) {
						this.load(filter, void 0, this.state.page === null ? "loading" : "refreshing");
						return;
					}
					const page = sameFilter(this.state.filter, filter) ? this.state.page : null;
					this.set({
						phase: "error",
						filter,
						page,
						error: response.error
					});
					return;
				}
				if (this.scopeKey !== null && response.page.projectId !== this.scopeKey) {
					this.set({
						phase: "error",
						filter,
						page: null,
						error: AUDIT_UNAVAILABLE
					});
					return;
				}
				const page = mergeAuditPages(this.state.page, response.page);
				this.set({
					phase: "ready",
					filter,
					page,
					error: null
				});
			}
			fail(filter, generation = this.requestGeneration) {
				if (generation !== this.requestGeneration) return;
				const page = sameFilter(this.state.filter, filter) ? this.state.page : null;
				this.set({
					phase: "error",
					filter,
					page,
					error: AUDIT_UNAVAILABLE
				});
			}
			set(next) {
				this.state = next;
				for (const listener of this.listeners) listener();
			}
		};
		/** Per-session state reader; Host state remains the authority. */
		var DevFlowSnapshotController = class {
			sessionId;
			state = INITIAL_STATE;
			inspectorTab = "flow";
			listeners = /* @__PURE__ */ new Set();
			pending;
			remote;
			audit;
			constructor(remote, sessionId) {
				this.sessionId = sessionId;
				this.remote = remote;
				this.audit = new DevFlowAuditController(remote);
			}
			getInspectorTab() {
				return this.inspectorTab;
			}
			setInspectorTab(tab) {
				this.inspectorTab = tab;
			}
			setRemote(remote) {
				this.remote = remote;
				this.audit.setRemote(remote);
				if (remote !== void 0 && this.state.phase === "error") this.refresh();
			}
			getSnapshot = () => this.state;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			ensure() {
				return this.pending ?? this.load("snapshot");
			}
			refresh() {
				return this.pending ?? this.load("refresh");
			}
			markStale() {
				if (this.state.snapshot === null || this.state.phase === "refreshing") return;
				this.set({
					phase: "refreshing",
					snapshot: this.state.snapshot,
					error: null
				});
			}
			dispose() {
				this.audit.dispose();
				this.listeners.clear();
			}
			/** Adopt a snapshot the live channel delivered; it is the same read model. */
			acceptSnapshot(snapshot) {
				if (snapshot.session.id !== this.sessionId) return;
				this.set({
					phase: "ready",
					snapshot,
					error: null
				});
			}
			load(method) {
				const remote = this.remote;
				if (remote === void 0) {
					this.fail();
					return Promise.resolve();
				}
				if (this.state.snapshot === null) this.set(INITIAL_STATE);
				else this.set({
					phase: "refreshing",
					snapshot: this.state.snapshot,
					error: null
				});
				const request = remote[method]().then((result) => this.apply(result)).catch(() => this.fail()).finally(() => {
					this.pending = void 0;
				});
				this.pending = request;
				return request;
			}
			apply(result) {
				if (!result.ok) return this.fail();
				const response = parseDevFlowResponse(result.value);
				if (response.kind === "error") return this.set({
					phase: "error",
					snapshot: this.state.snapshot,
					error: response.error
				});
				if (response.snapshot.session.id !== this.sessionId) return this.fail();
				this.set({
					phase: "ready",
					snapshot: response.snapshot,
					error: null
				});
			}
			fail() {
				this.set({
					phase: "error",
					snapshot: this.state.snapshot,
					error: {
						code: "state-unavailable",
						message: "DevFlow state is unavailable. Refresh to try again."
					}
				});
			}
			set(next) {
				if (this.state === next) return;
				this.state = next;
				for (const listener of this.listeners) listener();
			}
		};
		function mergeAuditPages(previous, incoming) {
			if (previous === null || previous.capturedHeadSequence !== incoming.capturedHeadSequence || previous.range.from !== incoming.range.from || previous.range.to !== incoming.range.to) return incoming;
			const byId = /* @__PURE__ */ new Map();
			for (const item of [...previous.items, ...incoming.items]) byId.set(item.id, item);
			return {
				...incoming,
				items: [...byId.values()].sort((left, right) => right.sequence - left.sequence || left.id.localeCompare(right.id))
			};
		}
		function sameFilter(left, right) {
			return left?.kind === right.kind && ("id" in right ? "id" in left && left.id === right.id : !("id" in (left ?? {})));
		}
		/**
		* Per-session live channel over the `devflow/follow` stream Remote.
		*
		* Responsibilities are deliberately narrow: keep the subscription alive, decide
		* whether an arriving frame is worth acting on, and report the connection posture.
		* It does NOT derive state — a `changed` frame only schedules a re-read through the
		* existing snapshot path, which keeps one source of truth and makes duplicates and
		* out-of-order frames harmless.
		*
		* Ordering rule: frames carry the host's in-process `revision`, which strictly
		* increases within one host run but means nothing across a restart (the opening
		* frame of a new stream is always a fresh snapshot). A frame whose revision is not
		* newer than the newest one already seen is ignored, and re-opening the stream
		* resets the watermark.
		*
		* Frame rule: the subscription iterates the stream Remote's own frames — never a
		* `RemoteResult` envelope, which only unary calls produce. A frame the strict parser
		* refuses is not a state the panel may pass off as live, so it ends the subscription
		* and lets the announced fallback take over; the retry re-opens with a fresh snapshot.
		*/
		var DevFlowLiveController = class {
			sessionId;
			apply;
			connection = INITIAL_CONNECTION_STATE;
			connectionListeners = /* @__PURE__ */ new Set();
			controller = null;
			stopped = true;
			/** A subscription loop is in flight (it survives `stop()` until the abort lands). */
			active = false;
			remote;
			watermark = -1;
			retry = null;
			silence = null;
			retryDelayMs = 1e3;
			/** Injectable so tests can drive the retry ladder without real timers. */
			schedule;
			clear;
			constructor(remote, sessionId, apply, timers = {}) {
				this.sessionId = sessionId;
				this.apply = apply;
				this.remote = remote;
				this.schedule = timers.schedule ?? ((callback, ms) => setTimeout(callback, ms));
				this.clear = timers.clear ?? ((handle) => {
					clearTimeout(handle);
				});
			}
			/**
			* Framework-facing observable pair. The channel is injected as a host
			* observable source, so the slot binder reads it through exactly these two
			* names (`getSnapshot` / `subscribe`) and synthesizes the `useLive` hook.
			*/
			getSnapshot = () => this.connection;
			subscribe = (listener) => {
				this.connectionListeners.add(listener);
				return () => {
					this.connectionListeners.delete(listener);
				};
			};
			/** Explicit alias of {@link DevFlowLiveController.getSnapshot} for call sites. */
			getConnection = () => this.connection;
			/** Explicit alias of {@link DevFlowLiveController.subscribe} for call sites. */
			subscribeConnection = (listener) => this.subscribe(listener);
			setRemote(remote) {
				this.remote = remote;
				if (remote === void 0) {
					this.stop();
					this.setConnection({
						...this.connection,
						phase: "polling",
						detail: CONNECTION_LOST_DETAIL
					});
				} else if (!this.active) this.start();
			}
			/** Open the channel; a second call while a loop is in flight is a no-op. */
			start() {
				this.stopped = false;
				if (this.active) return;
				this.run();
			}
			/** Close the channel deliberately (unmount, session change). */
			stop() {
				this.stopped = true;
				this.controller?.abort();
				this.controller = null;
				this.clearTimers();
			}
			dispose() {
				this.stop();
				this.connectionListeners.clear();
			}
			clearTimers() {
				if (this.retry !== null) {
					this.clear(this.retry);
					this.retry = null;
				}
				if (this.silence !== null) {
					this.clear(this.silence);
					this.silence = null;
				}
			}
			async run() {
				const remote = this.remote;
				if (remote === void 0 || this.stopped) return;
				const abort = new AbortController();
				this.controller = abort;
				this.active = true;
				this.watermark = -1;
				this.setConnection({
					...this.connection,
					phase: this.connection.attempts === 0 ? "connecting" : this.connection.phase
				});
				try {
					const request = { sequence: this.connection.sequence };
					for await (const frame of remote.follow(request, abort.signal)) {
						if (this.stopped) break;
						let event;
						try {
							event = parseDevFlowEvent(frame);
						} catch {
							throw new Error("devflow: live channel frame was not usable");
						}
						this.armSilence();
						if (event.kind === "snapshot") {
							if (event.snapshot.session.id !== this.sessionId) continue;
							this.apply.snapshot(event.snapshot);
							this.watermark = Math.max(this.watermark, 0);
							this.noteFrame(null, null);
							continue;
						}
						if (event.revision <= this.watermark) continue;
						this.watermark = event.revision;
						this.apply.frame(event);
						this.noteFrame(event.revision, event.sequence);
					}
					if (!this.stopped) this.degrade("实时连接已断开，正在使用轮询");
				} catch {
					if (!this.stopped) this.degrade(CONNECTION_LOST_DETAIL);
				} finally {
					this.active = false;
					if (this.controller === abort) this.controller = null;
				}
			}
			noteFrame(revision, sequence) {
				this.retryDelayMs = 1e3;
				this.setConnection({
					phase: "live",
					sequence: sequence ?? this.connection.sequence,
					revision: revision ?? this.connection.revision,
					detail: null,
					attempts: 0
				});
			}
			/** A dead carrier must be announced and retried, never silently replaced by polling. */
			degrade(detail) {
				this.clearTimers();
				const attempts = this.connection.attempts + 1;
				this.setConnection({
					...this.connection,
					phase: "polling",
					detail,
					attempts
				});
				const delay = this.retryDelayMs;
				this.retryDelayMs = Math.min(this.retryDelayMs * 2, 15e3);
				this.retry = this.schedule(() => {
					this.retry = null;
					if (this.stopped) return;
					this.run();
				}, delay);
			}
			/**
			* A live carrier that stops sending anything at all is indistinguishable from a
			* quiet project, so the channel proves liveness with its keepalive interval.
			* Silence past {@link CHANNEL_SILENCE_MS} is treated as a lost connection.
			*/
			armSilence() {
				if (this.silence !== null) this.clear(this.silence);
				this.silence = this.schedule(() => {
					this.silence = null;
					if (this.stopped || this.connection.phase !== "live") return;
					this.controller?.abort();
				}, CHANNEL_SILENCE_MS);
			}
			setConnection(next) {
				if (sameConnection(this.connection, next)) return;
				this.connection = next;
				for (const listener of this.connectionListeners) listener();
			}
		};
		function sameConnection(left, right) {
			return left.phase === right.phase && left.sequence === right.sequence && left.revision === right.revision && left.detail === right.detail && left.attempts === right.attempts;
		}
		//#endregion
		//#region lib/client/workspace.js
		const PROJECT_SELECTION = { kind: "project" };
		/** Convert a Canvas selection into an exact, Host-enforced audit predicate. */
		function auditFilterForSelection(selection) {
			if (selection.kind === "project" || selection.kind === "commander") return { kind: "project" };
			if (selection.kind === "phase") return {
				kind: "phase",
				id: selection.id
			};
			if (selection.kind === "task") return {
				kind: "task",
				id: selection.id
			};
			if (selection.kind === "agent") return {
				kind: "agent",
				id: selection.id
			};
			if (selection.kind === "execution") return {
				kind: "execution",
				id: selection.id
			};
			return {
				kind: "decision",
				id: selection.id
			};
		}
		/** Build the read-only Canvas view model from the current V1 snapshot only. */
		function createWorkspaceModel(snapshot) {
			const phases = [...snapshot.phases].sort((left, right) => left.id.localeCompare(right.id));
			const results = bounded(snapshot.results);
			const reports = bounded(snapshot.reports);
			const attempts = bounded(snapshot.attempts);
			const failures = bounded(snapshot.failures);
			const assignmentsByPhase = groupBy(snapshot.assignments, (assignment) => assignment.phaseId);
			const assignmentsByTask = groupBy(snapshot.assignments.filter(hasTaskId), (assignment) => assignment.taskId);
			const executionsByTask = groupBy(snapshot.executions.filter(hasTaskId), (execution) => execution.taskId);
			const executionsByAgent = groupBy(snapshot.executions, (execution) => execution.agentId);
			const resultsByTask = groupBy(results, (result) => result.taskId);
			const reportsByExecution = groupBy(reports, (report) => report.executionId);
			const attemptsByExecution = groupBy(attempts, (attempt) => attempt.executionId);
			const failuresByExecution = groupBy(failures, (failure) => failure.executionId);
			const assignmentsByAgent = groupBy(snapshot.assignments, (assignment) => assignment.agentId);
			const pendingDecisionsByTask = groupBy(snapshot.decisionRequests.filter(hasPendingTaskId), (request) => request.taskId);
			const tasks = snapshot.tasks.map((task) => {
				const assignments = assignmentsByTask.get(task.id) ?? [];
				const executions = executionsByTask.get(task.id) ?? [];
				const taskReports = executions.flatMap((execution) => reportsByExecution.get(execution.id) ?? []);
				const taskAttempts = executions.flatMap((execution) => attemptsByExecution.get(execution.id) ?? []);
				const taskFailures = executions.flatMap((execution) => failuresByExecution.get(execution.id) ?? []);
				const pendingDecisions = pendingDecisionsByTask.get(task.id) ?? [];
				const phaseIds = unique(assignments.map((assignment) => assignment.phaseId));
				return {
					task,
					assignments,
					executions,
					results: resultsByTask.get(task.id) ?? [],
					reports: taskReports,
					attempts: taskAttempts,
					failures: taskFailures,
					pendingDecisions,
					phaseIds,
					workState: taskWorkState(task, executions, pendingDecisions)
				};
			});
			const taskById = new Map(tasks.map((task) => [task.task.id, task]));
			const agents = snapshot.agents.map((agent) => {
				const assignments = assignmentsByAgent.get(agent.id) ?? [];
				const executions = executionsByAgent.get(agent.id) ?? [];
				const reports = executions.flatMap((execution) => reportsByExecution.get(execution.id) ?? []);
				const failures = executions.flatMap((execution) => failuresByExecution.get(execution.id) ?? []);
				const taskIds = unique([...assignments.flatMap((assignment) => assignment.taskId === void 0 ? [] : [assignment.taskId]), ...executions.flatMap((execution) => execution.taskId === void 0 ? [] : [execution.taskId])]);
				const pendingDecisions = taskIds.flatMap((taskId) => pendingDecisionsByTask.get(taskId) ?? []);
				return {
					agent,
					assignments,
					executions,
					reports,
					failures,
					taskIds,
					pendingDecisions,
					workState: agentWorkState(agent, executions, pendingDecisions, taskIds.some((taskId) => taskById.get(taskId)?.workState === "working"))
				};
			});
			const blockers = createBlockers(snapshot, tasks);
			const recentActivity = createRecentActivity(snapshot);
			return {
				snapshot,
				phases,
				tasks,
				agents,
				assignmentsByPhase,
				taskById,
				agentById: new Map(agents.map((agent) => [agent.agent.id, agent])),
				executionById: new Map(snapshot.executions.map((execution) => [execution.id, execution])),
				decisionRequestsById: new Map(snapshot.decisionRequests.map((request) => [request.id, request])),
				decisionsById: new Map(snapshot.decisions.map((decision) => [decision.id, decision])),
				blockers,
				recentActivity
			};
		}
		/** True when a local selection still refers to an object in the refreshed snapshot. */
		function selectionExists(model, selection) {
			if (selection.kind === "project" || selection.kind === "commander") return true;
			if (selection.kind === "phase") return model.phases.some((phase) => phase.id === selection.id);
			if (selection.kind === "task") return model.taskById.has(selection.id);
			if (selection.kind === "agent") return model.agentById.has(selection.id);
			if (selection.kind === "execution") return model.executionById.has(selection.id);
			return model.decisionRequestsById.has(selection.id) || model.decisionsById.has(selection.id);
		}
		/**
		* The single Chinese display name for a stored agent id.
		*
		* Correction R3 (step 3B): the canvas, the roster and the overview float each carried
		* their own copy of this table, so the same employee could be named differently in two
		* places. One table, one name; an unknown id falls back to what the record itself says.
		*/
		const AGENT_DISPLAY_NAMES = {
			commander: "总指挥",
			"backend-engineer": "代码工程师",
			"frontend-engineer": "前端工程师",
			architect: "架构师",
			"code-auditor": "审计工程师"
		};
		function flowAgentName(agentId, displayName) {
			return AGENT_DISPLAY_NAMES[agentId] ?? displayName;
		}
		function taskWorkStateLabel(state) {
			return {
				created: "Created",
				planned: "Planned",
				working: "Working",
				blocked: "Blocked",
				reviewing: "Reviewing",
				completed: "Completed",
				failed: "Needs rework",
				cancelled: "Cancelled"
			}[state];
		}
		function shortId(id, length = 10) {
			return id.length <= length ? id : `${id.slice(0, length)}…`;
		}
		/**
		* The last path segment of one workspace directory, for the panel identity line.
		*
		* The identity line is one compact Chinese line, so it names the project by its
		* directory while the full path stays available as the element's `title`. Both
		* separators are honoured because a session workspace is whatever the host
		* resolved, not necessarily this process's platform style; a path with no
		* segment at all is returned unchanged rather than rendered as an empty label.
		* @param path - the session workspace directory.
		* @returns its last segment, or the input when it has none.
		*/
		function workspaceBasename(path) {
			const segments = path.split(/[\\/]+/).filter((segment) => segment !== "");
			return segments[segments.length - 1] ?? path;
		}
		/**
		* Derive one task's work state from the task record plus its executions.
		*
		* "Failed" is a statement about the task's CURRENT attempt, not about its history:
		* a dispatch that failed and was then retried to a delivered result is not a failed
		* task any more. Reading the whole execution history instead made the state
		* permanent — once ANY execution of a task had failed, the task read 返工 forever,
		* even after a later attempt delivered (N5: `researcher-refs`'s assignment carries a
		* failed execution at 17:29 and a completed one at 17:52; the panel kept saying
		* 返工中 while the chat had already shown the delivered result). So the failure that
		* counts is the one carried by the NEWEST execution.
		*/
		function taskWorkState(task, executions, pendingDecisions) {
			if (pendingDecisions.length > 0) return "blocked";
			const latest = newestExecution(executions);
			if (latest !== null && latest.status === "failed") return "failed";
			if (task.status === "failed") return "failed";
			if (task.status === "completed") return "completed";
			if (task.status === "reviewing") return "reviewing";
			if (task.status === "cancelled") return "cancelled";
			if (task.status === "executing" || executions.some((execution) => execution.status === "running")) return "working";
			return task.status;
		}
		/**
		* The most recent execution by its own timestamps, or null when there is none.
		*
		* Time decides, not array order: the snapshot sorts executions by id (the host's
		* own order), which says nothing about which attempt ran last.
		*/
		function newestExecution(executions) {
			const at = (value) => {
				if (value === null) return Number.NEGATIVE_INFINITY;
				const parsed = Date.parse(value);
				return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
			};
			let best = null;
			let bestAt = Number.NEGATIVE_INFINITY;
			for (const execution of executions) {
				const when = Math.max(at(execution.completedAt), at(execution.startedAt));
				if (best === null || when > bestAt) {
					best = execution;
					bestAt = when;
				}
			}
			return best;
		}
		function agentWorkState(agent, executions, pendingDecisions, hasActiveTask) {
			if (pendingDecisions.length > 0) return "blocked";
			if (executions.some((execution) => execution.status === "running") || hasActiveTask) return "working";
			if (agent.kind === "temporary" && agent.status === "terminated") return "archived";
			if (executions.some((execution) => execution.status === "completed")) return "done";
			if (agent.kind === "fixed" && agent.status === "active" && executions.length === 0) return "idle";
			return "unknown";
		}
		function createBlockers(snapshot, tasks) {
			const blockers = [];
			if (snapshot.paused) blockers.push({
				id: "shared-dispatch-paused",
				kind: "paused",
				title: "Shared dispatch is paused",
				detail: "New dispatches wait until shared DevFlow dispatch resumes.",
				selection: PROJECT_SELECTION
			});
			for (const request of snapshot.decisionRequests.filter((request) => request.status === "pending")) blockers.push({
				id: `decision-${request.id}`,
				kind: "decision",
				title: "Decision required",
				detail: request.question,
				selection: {
					kind: "decision",
					id: request.id
				}
			});
			for (const item of tasks.filter((item) => item.workState === "failed")) blockers.push({
				id: `task-${item.task.id}`,
				kind: "failed-task",
				title: `${item.task.title} needs rework`,
				detail: "The current task or an execution is marked failed.",
				selection: {
					kind: "task",
					id: item.task.id
				}
			});
			for (const execution of snapshot.executions.filter((execution) => execution.status === "failed" && execution.taskId === void 0)) blockers.push({
				id: `execution-${execution.id}`,
				kind: "failed-execution",
				title: "Execution needs follow-up",
				detail: `Execution ${shortId(execution.id)} is marked failed.`,
				selection: {
					kind: "execution",
					id: execution.id
				}
			});
			return blockers;
		}
		function createRecentActivity(snapshot) {
			return [
				...snapshot.tasks.map((task) => ({
					id: `task-${task.id}`,
					at: task.updatedAt,
					title: "Task updated",
					detail: task.title,
					selection: {
						kind: "task",
						id: task.id
					}
				})),
				...snapshot.executions.flatMap((execution) => [...execution.startedAt === null ? [] : [{
					id: `execution-start-${execution.id}`,
					at: execution.startedAt,
					title: "Execution started",
					detail: `Execution ${shortId(execution.id)}`,
					selection: {
						kind: "execution",
						id: execution.id
					}
				}], ...execution.completedAt === null ? [] : [{
					id: `execution-end-${execution.id}`,
					at: execution.completedAt,
					title: execution.status === "failed" ? "Execution failed" : "Execution completed",
					detail: `Execution ${shortId(execution.id)}`,
					selection: {
						kind: "execution",
						id: execution.id
					}
				}]]),
				...snapshot.decisions.map((decision) => ({
					id: `decision-${decision.id}`,
					at: decision.createdAt,
					title: "Commander decision",
					detail: decision.summary,
					selection: {
						kind: "decision",
						id: decision.id
					}
				}))
			].filter((item) => !Number.isNaN(Date.parse(item.at))).sort((left, right) => right.at.localeCompare(left.at)).slice(0, 8);
		}
		function groupBy(items, key) {
			const grouped = /* @__PURE__ */ new Map();
			for (const item of items) {
				const itemKey = key(item);
				const existing = grouped.get(itemKey);
				if (existing === void 0) grouped.set(itemKey, [item]);
				else existing.push(item);
			}
			return grouped;
		}
		function unique(values) {
			return [...new Set(values)];
		}
		/** Preserve Host bounds when an old or malformed snapshot reaches the UI. */
		function bounded(items) {
			return (items ?? []).slice(0, 20);
		}
		function hasPendingTaskId(request) {
			return request.status === "pending" && request.taskId !== null;
		}
		function hasTaskId(item) {
			return item.taskId !== void 0;
		}
		const FLOW_COMMANDER_ID = "commander";
		const FLOW_REQUIREMENT_ID = "requirement";
		const FLOW_COMMANDER_STATE_LABEL = "总指挥";
		const NODE_HEIGHT_ESTIMATE = 118;
		const REQUIREMENT_WIDTH = 208;
		const REQUIREMENT_HEIGHT_ESTIMATE = 96;
		const COLUMN_GAP = 26;
		const ROW_GAP = 30;
		const CORRIDOR_TOP_PAD = 24;
		const LANE_GROUP_GAP = 13;
		const BAND_PAD = 7;
		const MARGIN_X = 16;
		const MARGIN_Y = 18;
		const ROLE_LABELS = {
			commander: "总指挥",
			planner: "总指挥",
			"backend-engineer": "代码工程师",
			"frontend-engineer": "前端工程师",
			architect: "架构师",
			"code-auditor": "审计工程师",
			reviewer: "审计工程师"
		};
		const NODE_STATE_LABELS = {
			idle: "空闲",
			active: "执行中",
			blocked: "待决策",
			done: "已完成",
			rework: "返工中",
			planned: "待派发",
			lost: "未收尾",
			paused: "已暂停",
			closed: "已收尾"
		};
		const EDGE_STATE_LABELS = {
			queued: "排队中",
			executing: "执行中",
			done: "已完成",
			rework: "返工",
			lost: "未收尾 · 已失联",
			paused: "已暂停",
			closed: "已收尾"
		};
		/** Stable zh-CN copy for the relation kinds drawn on the canvas. */
		const FLOW_SEMANTIC_LABELS = {
			requirement: "需求下达",
			dispatch: "派发",
			delivery: "交付 · 汇报",
			rework: "返工",
			subagent: "子代理创建 / 回传"
		};
		const PHASE_STATUS_LABELS = {
			planned: "计划中",
			in_progress: "进行中",
			completed: "已完成"
		};
		/**
		* Chinese display name for a stored agent id, falling back to the role label.
		*
		* @param agentId - the stored agent id.
		* @param role - the stored role, used only when the id has no name of its own.
		* @param fallback - the name to use when neither the id nor the role is known.
		* @param namedByItself - true when `fallback` is the agent's OWN stored display
		*   name. Such a name must win over the role table: a temporary sub-agent is
		*   registered with a role (`planner`, `reviewer`, …), and those role entries are
		*   the FIXED seats' names, so the role fallback would label a temporary agent
		*   「总指挥」 — the commander's own name — on its card and on its edge.
		*/
		function flowAgentLabel(agentId, role, fallback, namedByItself = false) {
			const byId = ROLE_LABELS[agentId];
			if (byId !== void 0) return byId;
			if (namedByItself) return fallback;
			return (role === void 0 ? void 0 : ROLE_LABELS[role]) ?? fallback;
		}
		/**
		* Project the current snapshot into canvas nodes, association bands and edges.
		*
		* @param model - the read-only workspace model folded from the V1 snapshot.
		* @param now - clock used for the stale judgement.
		* @param nodeHeights - measured card heights, keyed by node id, so a taller card
		*   never collides with the next rank.
		* @param scope - which edge scope the geometry is computed for; the default view
		*   and the full-history view carry different lane counts and therefore different
		*   corridor heights.
		*/
		function createFlowModel(model, now = Date.now(), nodeHeights = {}, scope = "current") {
			const commander = model.agents.find((item) => item.agent.id === FLOW_COMMANDER_ID);
			const visibleAgents = model.agents.filter((item) => item.agent.id !== FLOW_COMMANDER_ID).filter(isVisible);
			const visibleIds = visibleAgents.map((item) => item.agent.id);
			const context = {
				now,
				newestCompletion: newestCompletionAt(model)
			};
			const dispatches = model.tasks.flatMap((task, index) => createTaskEdges(task, index, model, context));
			const liveEdges = dispatches;
			const currentIds = pickCurrentEdges(liveEdges);
			const routed = liveEdges.filter((edge) => visibleIds.includes(edge.targetAgentId));
			const unroutedCount = liveEdges.length - routed.length;
			const current = routed.filter((edge) => currentIds.has(edge.edgeId));
			const runningCount = dispatches.filter((edge) => edge.state === "executing").length;
			const ordered = orderEmployees(visibleAgents, routed);
			const columns = Math.max(1, ordered.length);
			const rowWidth = columns * 172 + (columns - 1) * COLUMN_GAP;
			const rowLeft = 16;
			const shift = Math.max(0, MARGIN_X - (rowLeft + rowWidth / 2 - REQUIREMENT_WIDTH / 2));
			const rowX = rowLeft + shift;
			const centre = rowLeft + rowWidth / 2 + shift;
			const canvasWidth = Math.max(rowX + rowWidth + MARGIN_X, centre + REQUIREMENT_WIDTH / 2 + MARGIN_X);
			const currentLanes = assignLanes(current, ordered, centre, rowX);
			const historyLanes = assignLanes(routed, ordered, centre, rowX);
			const commanderHeight = nodeHeights["commander"] ?? NODE_HEIGHT_ESTIMATE;
			const requirementHeight = nodeHeights["requirement"] ?? REQUIREMENT_HEIGHT_ESTIMATE;
			const requirementY = MARGIN_Y;
			const commanderY = requirementY + requirementHeight + ROW_GAP;
			const corridorTop = commanderY + commanderHeight + CORRIDOR_TOP_PAD;
			const offsetLanes = (laneSet) => ({
				...laneSet,
				laneY: new Map([...laneSet.laneY].map(([id, y]) => [id, y + corridorTop])),
				bands: laneSet.bands.map((band) => ({
					...band,
					y: band.y + corridorTop
				}))
			});
			const lanes = offsetLanes(scope === "history" ? historyLanes : currentLanes);
			const rowY = corridorTop + lanes.height + ROW_GAP;
			const nodes = [];
			nodes.push({
				...commanderNode(commander, routed.length),
				x: centre - 86,
				y: commanderY
			});
			if (model.snapshot.project !== null) nodes.unshift({
				...requirementNode(model.snapshot.project.name, model.snapshot.project.goal, model.snapshot.project.currentStage),
				x: centre - REQUIREMENT_WIDTH / 2,
				y: requirementY
			});
			ordered.forEach((item, index) => {
				nodes.push({
					...agentNode(item, currentDispatch(item.agent.id, routed), routed),
					x: rowX + index * 198,
					y: rowY
				});
			});
			const byId = new Map(nodes.map((node) => [node.id, node]));
			const boxes = new Map(nodes.map((node) => [node.id, {
				x: node.x,
				y: node.y,
				width: nodeWidth(node.kind),
				height: nodeHeights[node.id] ?? (node.kind === "requirement" ? REQUIREMENT_HEIGHT_ESTIMATE : NODE_HEIGHT_ESTIMATE)
			}]));
			const commanderLabel = byId.get("commander")?.label ?? "总指挥";
			const visibleById = new Map(ordered.map((item) => [item.agent.id, item]));
			const currentPorts = assignPorts(current, visibleById, boxes);
			const historyPorts = assignPorts(routed, visibleById, boxes);
			const finalize = (items, laneSet, portSet) => items.map((edge) => finalizeEdge(edge, commanderLabel, visibleById, laneSet, portSet, boxes));
			const requirementEdge = model.snapshot.project === null ? null : requirementRelation(boxes, requirementY, commanderY);
			const bands = sizedBands(lanes.bands, canvasWidth).map((band) => ({
				...band,
				tasks: tasksOfPhase(model, band.id)
			}));
			const lastRowHeight = ordered.length === 0 ? 0 : Math.max(...ordered.map((item) => nodeHeights[item.agent.id] ?? NODE_HEIGHT_ESTIMATE));
			const canvasHeight = (ordered.length === 0 ? rowY - ROW_GAP : rowY + lastRowHeight) + MARGIN_Y;
			return {
				commanderId: FLOW_COMMANDER_ID,
				requirementId: FLOW_REQUIREMENT_ID,
				nodes,
				visibleAgentIds: visibleIds,
				scope,
				edges: finalize(scope === "history" ? routed : current, lanes, scope === "history" ? historyPorts : currentPorts),
				requirementEdge,
				bands,
				canvasWidth,
				canvasHeight,
				concurrency: {
					running: runningCount,
					limit: 5,
					atLimit: runningCount >= 5
				},
				current: {
					edges: finalize(current, offsetLanes(currentLanes), currentPorts),
					unroutedCount
				},
				history: {
					edges: finalize(routed, offsetLanes(historyLanes), historyPorts),
					unroutedCount
				},
				lostCount: routed.filter((edge) => edge.state === "lost").length,
				unroutedCount,
				staleBoundary: context.newestCompletion === 0 ? null : new Date(context.newestCompletion).toISOString(),
				judgedAt: now
			};
		}
		function nodeWidth(kind) {
			return kind === "requirement" ? REQUIREMENT_WIDTH : 172;
		}
		/**
		* Every task associated with one phase, for the inspector's 阶段关联 block.
		* Association only: it is read from the task's own phase links, never inferred.
		*/
		function tasksOfPhase(model, phaseId) {
			if (phaseId === "" || phaseId === "phase:unrecorded") return [];
			return model.tasks.filter((item) => item.phaseIds.includes(phaseId)).sort((left, right) => left.task.updatedAt.localeCompare(right.task.updatedAt) || left.task.id.localeCompare(right.task.id)).map((item) => ({
				id: item.task.id,
				title: item.task.title,
				stateLabel: taskWorkStateLabel(item.workState)
			}));
		}
		/** Anchor corridor-relative band geometry to the canvas width. */
		function sizedBands(bands, canvasWidth) {
			return bands.map((band) => ({
				...band,
				x: MARGIN_X,
				width: Math.max(0, canvasWidth - 32)
			}));
		}
		/**
		* Order the employees left to right so the corridor reads as one dispatch
		* schedule: the employee whose earliest associated dispatch came first sits
		* leftmost. Association order (never a dependency) is the only ordering input.
		*/
		function orderEmployees(agents, routed) {
			const score = /* @__PURE__ */ new Map();
			for (const edge of routed) {
				const current = score.get(edge.targetAgentId);
				if (current === void 0 || edge.order < current) score.set(edge.targetAgentId, edge.order);
			}
			return [...agents].sort((left, right) => {
				const leftScore = score.get(left.agent.id) ?? Number.MAX_SAFE_INTEGER;
				const rightScore = score.get(right.agent.id) ?? Number.MAX_SAFE_INTEGER;
				if (leftScore !== rightScore) return leftScore - rightScore;
				return left.agent.id.localeCompare(right.agent.id);
			});
		}
		/**
		* Give every drawn dispatch its own lane, grouped into 阶段关联带.
		*
		* Why lanes: several dispatches share the same (commander → employee) card pair,
		* and rendering them as one bundle is exactly the "合并不清" the product rejected
		* — so each dispatch owns a distinct horizontal lane and a distinct port on both
		* cards. Distinct lanes plus distinct ports make overlapping edges impossible by
		* construction; the ordering below then keeps crossings low.
		*
		* Ordering rules (association only, no dependency semantics):
		*  1. one band per phase that actually carries a dispatch;
		*  2. bands run in the phase's own association order (see {@link phaseOrder});
		*  3. inside a band, leftmost endpoint first — the same order as the target row,
		*     which is what makes a fan-out non-crossing;
		*  4. a bounded adjacent-swap pass then removes any crossing that order still
		*     leaves, without ever reordering the bands themselves.
		*/
		function assignLanes(edges, agents, centre, rowX) {
			const columnX = new Map(agents.map((item, index) => [item.agent.id, rowX + index * 198 + 86]));
			const agentById = new Map(agents.map((item) => [item.agent.id, item]));
			const phaseIndex = phaseOrder(edges);
			const groups = /* @__PURE__ */ new Map();
			for (const edge of edges) {
				const key = edge.phaseId ?? "";
				const list = groups.get(key);
				if (list === void 0) groups.set(key, [edge]);
				else list.push(edge);
			}
			const ordered = [...groups.entries()].sort(([left], [right]) => {
				const leftIndex = phaseIndex.get(left) ?? Number.MAX_SAFE_INTEGER;
				const rightIndex = phaseIndex.get(right) ?? Number.MAX_SAFE_INTEGER;
				if (leftIndex !== rightIndex) return leftIndex - rightIndex;
				return left.localeCompare(right);
			}).map(([, list]) => sortWithinBand(list, columnX));
			const laneY = /* @__PURE__ */ new Map();
			const bands = [];
			let cursor = 0;
			for (const list of ordered) {
				const ys = list.map((_, index) => cursor + index * 13);
				improveWithinBand(list, ys, (edge, index) => {
					const back = semanticOf(edge, agentById.get(edge.targetAgentId)) === "delivery";
					const employeeX = columnX.get(edge.targetAgentId) ?? centre;
					return {
						sourceX: back ? employeeX : centre,
						targetX: back ? centre : employeeX,
						lane: ys[index] ?? cursor,
						sourceAbove: !back
					};
				});
				list.forEach((edge, index) => {
					laneY.set(edge.edgeId, ys[index] ?? cursor);
				});
				const first = list[0];
				const top = cursor - 13 / 2 - BAND_PAD;
				const height = Math.max(13, (list.length - 1) * 13) + 14;
				bands.push({
					id: first?.phaseId ?? "phase:unrecorded",
					label: `阶段关联 ${bands.length + 1}`,
					name: first?.phaseName ?? "未记录阶段",
					status: first?.phaseStatus ?? "planned",
					statusLabel: PHASE_STATUS_LABELS[first?.phaseStatus ?? "planned"],
					taskCount: new Set(list.map((edge) => edge.taskId)).size,
					dispatchCount: list.length,
					tasks: [],
					x: 0,
					y: top,
					width: 0,
					height
				});
				cursor = top + height + LANE_GROUP_GAP;
			}
			const height = cursor === 0 ? 0 : cursor - LANE_GROUP_GAP + BAND_PAD;
			return {
				laneY,
				bands,
				height: Math.max(height, 0)
			};
		}
		/** Stable left-to-right order inside one band: leftmost endpoint first. */
		function sortWithinBand(edges, columnX) {
			return [...edges].sort((left, right) => {
				const leftX = columnX.get(left.targetAgentId) ?? Number.MAX_SAFE_INTEGER;
				const rightX = columnX.get(right.targetAgentId) ?? Number.MAX_SAFE_INTEGER;
				if (leftX !== rightX) return leftX - rightX;
				return left.order - right.order;
			});
		}
		/**
		* Bounded adjacent-swap pass over one band's lanes. Swaps are accepted only when
		* the measured crossing count strictly decreases, so the pass always terminates;
		* the band's own edge set never changes, so the phase grouping stays intact.
		*/
		function improveWithinBand(edges, laneY, shapeAt) {
			const shapes = () => edges.map((edge, index) => shapeAt(edge, index));
			let current = countCrossings(shapes());
			for (let pass = 0; pass < 3 && current > 0; pass += 1) {
				let swapped = false;
				for (let index = 0; index + 1 < edges.length; index += 1) {
					const leftY = laneY[index];
					const rightY = laneY[index + 1];
					if (leftY === void 0 || rightY === void 0) continue;
					laneY[index] = rightY;
					laneY[index + 1] = leftY;
					const next = countCrossings(shapes());
					if (next < current) {
						current = next;
						swapped = true;
						continue;
					}
					laneY[index] = leftY;
					laneY[index + 1] = rightY;
				}
				if (!swapped) break;
			}
		}
		/**
		* Count proper crossings of a set of orthogonal Z routes that all share one
		* source column. A crossing is an interior intersection between one route's
		* horizontal lane run and another route's vertical run; meeting at the shared
		* source is not a crossing.
		*/
		function countCrossings(shapes) {
			const TOP = -1;
			const BOTTOM = 1e6;
			const segments = shapes.map((shape) => {
				const left = Math.min(shape.sourceX, shape.targetX);
				const right = Math.max(shape.sourceX, shape.targetX);
				return {
					verticals: shape.sourceAbove ? [{
						x1: shape.sourceX,
						y1: TOP,
						x2: shape.sourceX,
						y2: shape.lane
					}, {
						x1: shape.targetX,
						y1: shape.lane,
						x2: shape.targetX,
						y2: BOTTOM
					}] : [{
						x1: shape.sourceX,
						y1: shape.lane,
						x2: shape.sourceX,
						y2: BOTTOM
					}, {
						x1: shape.targetX,
						y1: TOP,
						x2: shape.targetX,
						y2: shape.lane
					}],
					horizontal: {
						x1: left,
						y1: shape.lane,
						x2: right,
						y2: shape.lane
					}
				};
			});
			let total = 0;
			for (let a = 0; a < segments.length; a += 1) for (let b = 0; b < segments.length; b += 1) {
				if (a === b) continue;
				const first = segments[a];
				const second = segments[b];
				if (first === void 0 || second === void 0) continue;
				for (const vertical of second.verticals) {
					const low = Math.min(first.horizontal.x1, first.horizontal.x2);
					const high = Math.max(first.horizontal.x1, first.horizontal.x2);
					if (vertical.x1 <= low || vertical.x1 >= high) continue;
					const top = Math.min(vertical.y1, vertical.y2);
					const bottom = Math.max(vertical.y1, vertical.y2);
					const lane = first.horizontal.y1;
					if (lane > top && lane < bottom) total += 1;
				}
			}
			return total;
		}
		/**
		* Assign a distinct port to every edge endpoint on a card side, ordered by the
		* peer's x.
		*
		* Two separations are needed and both are enforced here:
		*  1. within one card side the ports are evenly spread, so a bundle of dispatches
		*     between the same pair fans out instead of stacking;
		*  2. across ALL card sides the absolute x values stay unique (a small nudge
		*     resolves a collision), because two edges whose vertical runs share an x can
		*     otherwise be drawn on top of each other for part of their length. Two cards
		*     that are centred on the same column would otherwise produce identical ports.
		*/
		function assignPorts(edges, agents, boxes) {
			const ends = [];
			const push = (edge, from, to) => {
				const fromBox = boxes.get(from);
				const toBox = boxes.get(to);
				if (fromBox === void 0 || toBox === void 0) return;
				const targetX = toBox.x + toBox.width / 2;
				const sourceX = fromBox.x + fromBox.width / 2;
				const down = fromBox.y + fromBox.height <= toBox.y;
				ends.push({
					edgeId: edge.edgeId,
					nodeId: from,
					side: down ? "bottom" : "top",
					peerX: targetX,
					order: edge.order
				});
				ends.push({
					edgeId: edge.edgeId,
					nodeId: to,
					side: down ? "top" : "bottom",
					peerX: sourceX,
					order: edge.order
				});
			};
			for (const edge of edges) {
				const { from, to } = endpointsOf(edge, agents.get(edge.targetAgentId));
				push(edge, from, to);
			}
			const grouped = /* @__PURE__ */ new Map();
			for (const end of ends) {
				const key = `${end.nodeId}|${end.side}`;
				const list = grouped.get(key);
				if (list === void 0) grouped.set(key, [end]);
				else list.push(end);
			}
			const used = /* @__PURE__ */ new Set();
			const xOf = /* @__PURE__ */ new Map();
			const orderedGroups = [...grouped.entries()].map(([key, list]) => ({
				key,
				nodeId: key.slice(0, key.lastIndexOf("|")),
				list
			})).sort((left, right) => left.key.localeCompare(right.key));
			for (const group of orderedGroups) {
				const box = boxes.get(group.nodeId);
				if (box === void 0) continue;
				const centre = box.x + box.width / 2;
				const usable = Math.max(0, box.width - 20);
				const sorted = [...group.list].sort((left, right) => left.peerX - right.peerX || left.order - right.order);
				sorted.forEach((end, index) => {
					const ratio = sorted.length === 1 ? .5 : index / (sorted.length - 1);
					xOf.set(`${end.edgeId}|${end.nodeId}`, claim(centre - usable / 2 + ratio * usable, box, used));
				});
			}
			const ports = /* @__PURE__ */ new Map();
			for (const edge of edges) {
				const { from, to } = endpointsOf(edge, agents.get(edge.targetAgentId));
				const fromCentre = centreOf(boxes.get(from));
				const toCentre = centreOf(boxes.get(to));
				ports.set(edge.edgeId, {
					fromPort: (xOf.get(`${edge.edgeId}|${from}`) ?? fromCentre) - fromCentre,
					toPort: (xOf.get(`${edge.edgeId}|${to}`) ?? toCentre) - toCentre
				});
			}
			return ports;
		}
		function centreOf(box) {
			return box === void 0 ? 0 : box.x + box.width / 2;
		}
		/**
		* Claim an unused absolute x on a card edge, nudging until it is unique.
		*
		* The nudge step is larger than a drawn stroke by an order of magnitude, so two
		* nudged ports are still visibly separate lines rather than a doubled one.
		*/
		function claim(preferred, box, used) {
			const minimum = box.x + 4;
			const maximum = box.x + box.width - 4;
			const key = (value) => Math.round(value * 10) / 10;
			for (let attempt = 0; attempt < 40; attempt += 1) {
				const candidate = clampNumber(preferred + Math.ceil(attempt / 2) * 3.2 * (attempt % 2 === 0 ? 1 : -1), minimum, maximum);
				if (!used.has(key(candidate))) {
					used.add(key(candidate));
					return candidate;
				}
			}
			used.add(key(preferred));
			return preferred;
		}
		function clampNumber(value, minimum, maximum) {
			if (minimum > maximum) return (minimum + maximum) / 2;
			return Math.min(maximum, Math.max(minimum, value));
		}
		/**
		* Which relation kind one dispatch draws right now.
		*
		* The relation is a fact of the record, not a decoration: a dispatch still moving
		* is a 派发, one that came back is a 交付 · 汇报 (drawn back into the commander),
		* one that is being redone is a 返工, and a dispatch to a temporary sub-agent is
		* the 子代理创建 / 回传 pair. A dispatch nobody ever closed stays a 派发, because
		* nothing was delivered.
		*/
		function semanticOf(edge, target) {
			if (target?.agent.kind === "temporary") return "subagent";
			if (edge.state === "rework") return "rework";
			if (edge.state === "done") return "delivery";
			return "dispatch";
		}
		/** The two ends of one relation; the commander is always one of them. */
		function endpointsOf(edge, target) {
			const semantic = semanticOf(edge, target);
			const back = semantic === "delivery";
			return {
				from: back ? edge.targetAgentId : FLOW_COMMANDER_ID,
				to: back ? FLOW_COMMANDER_ID : edge.targetAgentId,
				semantic
			};
		}
		/**
		* The association order of phases.
		*
		* `Phase` carries no order field, and the browser contract does not ship the
		* phase's `createdAt` (adding it would need a Host-side projection change, which
		* this round must not make). The order therefore comes from real data the
		* snapshot does carry: the earliest execution start among the phase's associated
		* dispatches, falling back to the phase id so the order is always stable.
		*/
		function phaseOrder(edges) {
			const firstSeen = /* @__PURE__ */ new Map();
			for (const edge of edges) {
				if (edge.phaseId === null) continue;
				const at = Date.parse(edge.execution?.startedAt ?? edge.at ?? "");
				const value = Number.isNaN(at) ? Number.MAX_SAFE_INTEGER - 1 : at;
				const current = firstSeen.get(edge.phaseId);
				if (current === void 0 || value < current) firstSeen.set(edge.phaseId, value);
			}
			return new Map([...firstSeen.entries()].sort(([leftId, left], [rightId, right]) => left - right || leftId.localeCompare(rightId)).map(([id], index) => [id, index]));
		}
		/**
		* The one dispatch each employee's canvas keeps by default: the dispatch still in
		* flight when there is one, otherwise the newest dispatch of that employee.
		*/
		function pickCurrentEdges(edges) {
			const byAgent = /* @__PURE__ */ new Map();
			for (const edge of edges) {
				const list = byAgent.get(edge.targetAgentId);
				if (list === void 0) byAgent.set(edge.targetAgentId, [edge]);
				else list.push(edge);
			}
			const current = /* @__PURE__ */ new Set();
			for (const list of byAgent.values()) {
				const chosen = [...list].reverse().find((edge) => edge.state === "executing" || edge.state === "queued") ?? list.at(-1);
				if (chosen !== void 0) current.add(chosen.edgeId);
			}
			return current;
		}
		/** The dispatch a node presents: the one still in flight, else the newest one. */
		function currentDispatch(agentId, edges) {
			const items = edges.filter((edge) => edge.targetAgentId === agentId);
			if (items.length === 0) return null;
			return [...items].reverse().find((edge) => edge.state === "executing" || edge.state === "queued") ?? items.at(-1) ?? null;
		}
		/**
		* One edge per dispatched assignment: `assignments` is what actually records a
		* dispatch to an employee, so a task that went back and forth produces one edge
		* per hand-off instead of a single edge pinned to whichever assignment came last.
		* A task that never reached an assignment still contributes one unattributed edge
		* so the count stays honest.
		*/
		function createTaskEdges(item, index, model, context) {
			if (item.assignments.length === 0) return [createTaskEdge(item, null, null, index * 100, model, context)];
			return item.assignments.map((assignment, offset) => {
				return createTaskEdge(item, assignment, latestExecutionFor(item.executions, assignment.id), index * 100 + offset, model, context);
			});
		}
		function createTaskEdge(item, assignment, assignedExecution, order, model, context) {
			const execution = assignedExecution ?? (assignment === null ? latestExecution(item.executions) : null);
			const retryCount = item.attempts.filter((attempt) => attempt.isRetry).length + item.executions.filter((candidate) => candidate.status === "failed").length;
			const dispatchAt = latestTimestamp([
				item.task.updatedAt,
				execution?.startedAt ?? null,
				execution?.completedAt ?? null
			]);
			const verdict = edgeState(item.workState, assignment, execution, retryCount, dispatchAt, context);
			const reports = execution === null ? [] : item.reports.filter((report) => report.executionId === execution.id);
			const thought = reports.at(-1)?.summary ?? item.reports.at(-1)?.summary ?? null;
			const output = item.results.at(-1)?.summary ?? reports.at(-1)?.summary ?? null;
			const phase = assignment === null ? void 0 : model.phases.find((candidate) => candidate.id === assignment.phaseId);
			return {
				edgeId: assignment === null ? `task:${item.task.id}` : `dispatch:${assignment.id}`,
				targetAgentId: assignment?.agentId ?? execution?.agentId ?? "",
				taskId: item.task.id,
				task: item.task,
				taskState: item.workState,
				assignment,
				execution,
				state: verdict.state,
				action: edgeAction(verdict.state, item.workState, assignment),
				at: dispatchAt,
				retryCount,
				output: output === null ? null : output.text,
				thought: thought === null ? null : thought.text,
				executionLabel: executionLabel(execution),
				stale: verdict.reason !== null,
				staleReason: verdict.reason,
				phaseId: assignment?.phaseId ?? null,
				phaseName: phase?.name ?? null,
				phaseStatus: phase?.status ?? "planned",
				order
			};
		}
		/** The newest of several ISO timestamps, or null when none parses. */
		function latestTimestamp(values) {
			let best = null;
			let bestTime = Number.NEGATIVE_INFINITY;
			for (const value of values) {
				if (value === null || value === void 0) continue;
				const parsed = Date.parse(value);
				if (Number.isNaN(parsed)) continue;
				if (parsed > bestTime) {
					bestTime = parsed;
					best = value;
				}
			}
			return best;
		}
		/**
		* Epoch ms of the newest completion recorded anywhere in the snapshot, or 0 when
		* nothing ever completed.
		*
		* It is now a DISPLAY boundary only (`FlowModel.staleBoundary`). It used to
		* decide `lost` — "started before a later completion ⇒ never held the single
		* execution slot" — and that inference is invalid once dispatches overlap:
		* concurrent children start before other dispatches complete all the time, so
		* the rule reported running work as 已失联.
		*/
		function newestCompletionAt(model) {
			let newest = 0;
			for (const execution of model.snapshot.executions) {
				if (execution.status !== "completed" || execution.completedAt === null) continue;
				const parsed = Date.parse(execution.completedAt);
				if (!Number.isNaN(parsed) && parsed > newest) newest = parsed;
			}
			return newest;
		}
		/** The newest execution that belongs to one assignment. */
		function latestExecutionFor(executions, assignmentId) {
			return latestExecution(executions.filter((execution) => execution.assignmentId === assignmentId));
		}
		/**
		* The execution that actually ran last.
		*
		* Time decides, not array order. The snapshot's rows are sorted by execution ID
		* (the host's own order), which says nothing about which attempt ran last — and a
		* task whose first attempt failed and whose retry delivered is the ordinary case,
		* not an exotic one. Taking `at(-1)` made the choice depend on the UUID order of
		* the two ids, so the panel could show 返工 for a dispatch that had already
		* delivered (N5, `researcher-refs`: failed 46043611 then delivered aae2028d — the
		* failure sorted last and won).
		*
		* A live attempt still wins over a finished one, because "which execution is this
		* dispatch in" and "which execution is newest" are the same question while one is
		* running or queued.
		*/
		function latestExecution(executions) {
			if (executions.length === 0) return null;
			const running = executions.filter((execution) => execution.status === "running");
			if (running.length > 0) return running.at(-1) ?? null;
			const pending = executions.filter((execution) => execution.status === "pending");
			if (pending.length > 0) return pending.at(-1) ?? null;
			const at = (value) => {
				if (value === null || value === void 0) return Number.NEGATIVE_INFINITY;
				const parsed = Date.parse(value);
				return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
			};
			let best = null;
			let bestAt = Number.NEGATIVE_INFINITY;
			for (const execution of executions) {
				const when = Math.max(at(execution.completedAt), at(execution.startedAt));
				if (best === null || when > bestAt) {
					best = execution;
					bestAt = when;
				}
			}
			return best;
		}
		/**
		* Decide one dispatch's honest state.
		*
		* The rules, in order:
		*  1. a running execution within {@link DISPATCH_STALE_MS} ⇒ 执行中. Several
		*     dispatches may report this at the same time: the ceiling is the in-flight
		*     limit, not one slot.
		*  2. a running execution older than the window ⇒ 未收尾 · 已失联. The judgement
		*     is DURATION ONLY. It used to also fire when the row started before the
		*     newest completion anywhere in the snapshot, on the reasoning that a
		*     blocking dispatch owns the only execution slot — and that reasoning died
		*     with the single slot. Concurrently running children routinely start before
		*     ANOTHER dispatch finishes, so the old rule reported live work as lost
		*     (measured: two running children ⇒ 概览 `active 2→0` / `lost 0→2`). The
		*     capability is NOT removed — a genuinely stale run is still called out,
		*     which is what "不伪造状态" requires — only the false trigger is.
		*  3. failed execution / retry history ⇒ 返工.
		*  4. completed execution / completed task ⇒ 已完成.
		*  5. no execution at all: 排队中 while the dispatch is fresh, otherwise
		*     未收尾 · 已失联 — the host writes an execution when a dispatch starts, so a
		*     dispatch this old never started. A dispatch held back by the in-flight
		*     limit is exactly this case while it waits, which is how 超限排队 stays
		*     visible on the panel instead of looking like a hang.
		*/
		function edgeState(taskState, assignment, execution, retryCount, dispatchAt, context) {
			const closure = closureOf(assignment, execution);
			if (closure !== null) return {
				state: "closed",
				reason: closure.reason
			};
			if (execution !== null && execution.status === "running") {
				const startedAt = Date.parse(execution.startedAt ?? "");
				const started = Number.isNaN(startedAt) ? 0 : startedAt;
				if (context.now - started > 18e5) return {
					state: "lost",
					reason: `运行记录停在 ${execution.startedAt ?? "未知时间"}，超过 30 分钟无更新`
				};
				return {
					state: "executing",
					reason: null
				};
			}
			if (execution !== null && execution.status === "failed") return {
				state: "rework",
				reason: null
			};
			if (retryCount > 0 && (taskState === "failed" || taskState === "working" || taskState === "blocked")) return {
				state: "rework",
				reason: null
			};
			if (taskState === "failed") return {
				state: "rework",
				reason: null
			};
			if (execution !== null && execution.status === "completed") return {
				state: "done",
				reason: null
			};
			if (taskState === "completed") return {
				state: "done",
				reason: null
			};
			if (execution !== null && execution.status === "pending") {
				const pendingAt = Date.parse(execution.startedAt ?? dispatchAt ?? "");
				if (context.now - (Number.isNaN(pendingAt) ? 0 : pendingAt) > 18e5) return {
					state: "lost",
					reason: "排队的执行记录超过 30 分钟未开工"
				};
				return {
					state: "queued",
					reason: null
				};
			}
			if (assignment !== null && assignment.status === "completed") return {
				state: "done",
				reason: null
			};
			const queuedAt = Date.parse(dispatchAt ?? "");
			if (Number.isNaN(queuedAt) || queuedAt === 0) return {
				state: "queued",
				reason: null
			};
			if (context.now - queuedAt > 18e5) return {
				state: "lost",
				reason: `派发于 ${dispatchAt}，此后没有任何执行记录`
			};
			return {
				state: "queued",
				reason: null
			};
		}
		function edgeAction(state, taskState, assignment) {
			if (state === "rework") return "派发返工";
			if (state === "done") return assignment?.role === "reviewer" ? "复核通过" : "交付结果";
			if (state === "executing") return "正在执行";
			if (state === "lost") return "未收尾";
			if (state === "closed") return "已收尾";
			if (taskState === "reviewing") return "复核返工";
			return "已接收";
		}
		/**
		* The authoritative closure of one dispatch, or null when it is not closed.
		*
		* Either layer can carry it, and BOTH are terminal statements about the same dispatch:
		*  * an `execution` closed as stale — the record that claimed to be running;
		*  * an `assignment` closed without ever running — the dispatch that will never start.
		* The execution wins when both are present, because it names the more specific fact.
		*/
		function closureOf(assignment, execution) {
			if (execution !== null && execution.status === "closed") return { reason: `已收尾 · ${closeReasonLabel(execution.closeReason)}` };
			if (assignment !== null && assignment.status === "closed") return { reason: `已收尾 · ${closeReasonLabel(assignment.closeReason)}` };
			return null;
		}
		/** Fixed zh-CN wording per close reason; never a raw stored value. */
		function closeReasonLabel(reason) {
			if (reason === "stale-lost") return "陈旧在飞";
			if (reason === "superseded") return "已被后续派发取代";
			if (reason === "abandoned") return "已放弃";
			return "原因未记录";
		}
		/**
		* REMOVED: `pickExecutingEdge` / `timeOf`.
		*
		* They demoted every live execution but the newest to 排队中, on design §11's
		* "exactly one execution slot" clause. The boss decision of 2026-09-21 replaced
		* that clause with 「并发上限 5 · 超限排队」, so under the new rule two children
		* running at once is the normal case and the demotion was simply false. Kept as
		* a note (not a function) so the next reader does not reintroduce it: the panel
		* must be able to show several 执行中 at once.
		*/
		function requirementNode(name, goal, stage) {
			return {
				id: FLOW_REQUIREMENT_ID,
				label: "用户需求",
				kind: "requirement",
				roleId: "user",
				roleLabel: "用户",
				state: "planned",
				stateLabel: "来源：用户",
				taskId: null,
				taskTitle: name.trim() === "" ? "（未命名需求）" : name,
				taskDescription: goal.trim() === "" ? "未记录需求全文" : goal,
				taskStateLabel: stage.trim() === "" ? "未记录当前阶段" : `当前阶段：${stage}`,
				skillsLabel: "只读状态节点",
				capabilitiesLabel: "不适用（只读）",
				delegationLabel: "委派深度 0 · 只读状态节点不参与派发",
				subagentNote: "子代理：不适用（只读状态节点）",
				delegable: false,
				deliveryCount: 0,
				delegationDepth: null,
				thought: null,
				output: null,
				executionLabel: null,
				modelLabel: "",
				designTarget: false,
				sourceLabel: "来源：用户"
			};
		}
		function commanderNode(agent, dispatchCount) {
			const blocked = agent?.workState === "blocked";
			const working = !blocked && agent?.workState === "working";
			const state = blocked ? "blocked" : working ? "active" : dispatchCount > 0 ? "done" : "planned";
			return {
				id: FLOW_COMMANDER_ID,
				label: flowAgentLabel(FLOW_COMMANDER_ID, agent?.agent.role, FLOW_COMMANDER_STATE_LABEL),
				kind: "commander",
				roleId: agent?.agent.id ?? "commander",
				roleLabel: "总指挥",
				state,
				stateLabel: NODE_STATE_LABELS[state],
				taskId: null,
				taskTitle: `已派出 ${dispatchCount} 次派发`,
				taskDescription: null,
				taskStateLabel: null,
				skillsLabel: "不适用（总指挥不写代码）",
				capabilitiesLabel: capabilityText(agent?.agent.capabilities),
				delegationLabel: delegationText(agent?.agent.delegationDepth ?? 0),
				subagentNote: "子代理：只可由总指挥现场创建，创建后即由本面板呈现（生命周期状态尚未与面板联动）",
				delegable: true,
				deliveryCount: dispatchCount,
				delegationDepth: agent?.agent.delegationDepth ?? 0,
				thought: null,
				output: null,
				executionLabel: null,
				modelLabel: agent === void 0 ? "" : modelLabel(agent.agent),
				designTarget: false,
				sourceLabel: null
			};
		}
		function agentNode(item, current, edges) {
			const label = flowAgentLabel(item.agent.id, item.agent.role, item.agent.displayName, true);
			const state = nodeState(item, current, edges);
			return {
				id: item.agent.id,
				label,
				kind: item.agent.kind === "temporary" ? "temporary" : "fixed",
				roleId: item.agent.id,
				roleLabel: label,
				state,
				stateLabel: NODE_STATE_LABELS[state],
				taskId: current?.taskId ?? null,
				taskTitle: current?.task.title ?? null,
				taskDescription: current?.task.description ?? null,
				taskStateLabel: current === null ? null : taskWorkStateLabel(current.taskState),
				skillsLabel: skillText(item.agent.skills),
				capabilitiesLabel: capabilityText(item.agent.capabilities),
				delegationLabel: delegationText(item.agent.delegationDepth),
				subagentNote: item.agent.kind === "temporary" ? "子代理：本节点就是由总指挥现场创建的临时子代理" : "子代理：固定员工没有委派能力",
				delegable: item.agent.id !== "commander" && item.agent.kind === "temporary",
				deliveryCount: item.executions.filter((execution) => execution.status === "completed").length,
				delegationDepth: item.agent.delegationDepth ?? null,
				thought: current?.thought ?? null,
				output: current?.output ?? null,
				executionLabel: current?.executionLabel ?? null,
				modelLabel: modelLabel(item.agent),
				designTarget: item.agent.kind === "temporary",
				sourceLabel: null
			};
		}
		function nodeState(item, current, edges) {
			if (current !== null) {
				if (current.state === "rework") return "rework";
				if (current.state === "executing") return "active";
				if (current.state === "done") return "done";
				if (current.state === "lost") return "lost";
			}
			if (edges.some((edge) => edge.targetAgentId === item.agent.id && edge.state === "executing")) return "active";
			if (item.workState === "blocked") return "blocked";
			if (item.workState === "working") return "active";
			if (current !== null) return current.state === "rework" ? "rework" : current.state === "lost" ? "lost" : "planned";
			if (item.workState === "done") return "done";
			if (item.workState === "archived") return "done";
			return "idle";
		}
		function finalizeEdge(edge, commanderLabel, agents, lanes, ports, boxes) {
			const target = agents.get(edge.targetAgentId);
			const targetLabel = edge.targetAgentId === "" ? "（未记录员工）" : flowAgentLabel(edge.targetAgentId, target?.agent.role, target?.agent.displayName ?? edge.targetAgentId, target !== void 0);
			const { from, to, semantic } = endpointsOf(edge, target);
			const fromLabel = semantic === "delivery" ? targetLabel : commanderLabel;
			const toLabel = semantic === "delivery" ? commanderLabel : targetLabel;
			const badge = edgeBadge(edge);
			const acceptance = boundText(edge.task.description, 220);
			const laneY = lanes.laneY.get(edge.edgeId) ?? 0;
			const port = ports.get(edge.edgeId) ?? {
				fromPort: 0,
				toPort: 0
			};
			const geometry = routeEdge(from, to, port.fromPort, port.toPort, laneY, boxes);
			return {
				id: edge.edgeId,
				from,
				to,
				fromLabel,
				toLabel,
				state: edge.state,
				semantic,
				phaseId: edge.phaseId,
				laneY,
				fromPort: port.fromPort,
				toPort: port.toPort,
				badge,
				stale: edge.stale,
				taskId: edge.taskId,
				taskLabel: edge.task.title,
				handoff: {
					title: edge.task.title,
					taskId: edge.taskId,
					acceptance: {
						label: "验收标准摘要",
						value: acceptance.text,
						truncated: acceptance.truncated
					},
					statusLabel: `${EDGE_STATE_LABELS[edge.state]} · ${taskWorkStateLabel(edge.taskState)}${edge.staleReason === null ? "" : ` · ${edge.staleReason}`}`,
					fromLabel,
					toLabel,
					at: edge.at,
					retryCount: edge.retryCount,
					detail: edge.output === null ? null : boundText(edge.output, 220).text
				},
				path: geometry.path,
				arrowPath: geometry.arrowPath,
				labelX: geometry.labelX,
				labelY: geometry.labelY
			};
		}
		/** The 用户需求 → 总指挥 relation: one straight vertical, never a dispatch. */
		function requirementRelation(boxes, requirementY, commanderY) {
			const box = boxes.get(FLOW_REQUIREMENT_ID);
			const x = (box?.x ?? 0) + (box?.width ?? REQUIREMENT_WIDTH) / 2;
			const startY = requirementY + (box?.height ?? REQUIREMENT_HEIGHT_ESTIMATE);
			const endY = commanderY;
			const path = `M${round(x)} ${round(startY)} L${round(x)} ${round(endY)}`;
			return {
				id: "relation:requirement",
				from: FLOW_REQUIREMENT_ID,
				to: FLOW_COMMANDER_ID,
				fromLabel: "用户需求",
				toLabel: FLOW_COMMANDER_STATE_LABEL,
				state: "queued",
				semantic: "requirement",
				phaseId: null,
				laneY: (startY + endY) / 2,
				fromPort: 0,
				toPort: 0,
				badge: "需求下达",
				stale: false,
				taskId: null,
				taskLabel: "",
				handoff: {
					title: "用户需求",
					taskId: null,
					acceptance: {
						label: "验收标准摘要",
						value: "未记录",
						truncated: false
					},
					statusLabel: "需求下达 · 只读",
					fromLabel: "用户需求",
					toLabel: FLOW_COMMANDER_STATE_LABEL,
					at: null,
					retryCount: 0,
					detail: null
				},
				path,
				arrowPath: arrowHead(x, endY, "down"),
				labelX: x,
				labelY: (startY + endY) / 2
			};
		}
		/**
		* Route one edge as an orthogonal three-segment Z through its own lane.
		*
		* Down edges leave the source card's bottom edge, drop to the lane, run across and
		* drop into the target's top edge; up edges are the mirror image. Because every
		* edge owns a unique lane AND unique ports, two edges can never share a segment.
		*/
		function routeEdge(from, to, fromPort, toPort, laneY, boxes) {
			const fromBox = boxes.get(from);
			const toBox = boxes.get(to);
			if (fromBox === void 0 || toBox === void 0) return {
				path: "",
				arrowPath: "",
				labelX: 0,
				labelY: 0,
				direction: "down"
			};
			const down = fromBox.y + fromBox.height <= toBox.y;
			const startX = fromBox.x + fromBox.width / 2 + fromPort;
			const endX = toBox.x + toBox.width / 2 + toPort;
			const startY = down ? fromBox.y + fromBox.height : fromBox.y;
			const endY = down ? toBox.y : toBox.y + toBox.height;
			const lane = down ? Math.min(Math.max(laneY, startY + 4), Math.max(startY + 4, endY - 4)) : Math.min(Math.max(laneY, endY + 4), Math.max(endY + 4, startY - 4));
			return {
				path: orthogonalPath([
					{
						x: startX,
						y: startY
					},
					{
						x: startX,
						y: lane
					},
					{
						x: endX,
						y: lane
					},
					{
						x: endX,
						y: endY
					}
				], 5),
				arrowPath: arrowHead(endX, endY, down ? "down" : "up"),
				labelX: (startX + endX) / 2,
				labelY: lane - 4,
				direction: down ? "down" : "up"
			};
		}
		/** Re-anchor edges to the measured boxes; lane and port assignments are kept. */
		function layoutEdges(edges, boxes) {
			return edges.map((edge) => {
				const geometry = routeEdge(edge.from, edge.to, edge.fromPort, edge.toPort, edge.laneY, boxes);
				return {
					...edge,
					path: geometry.path,
					arrowPath: geometry.arrowPath,
					labelX: geometry.labelX,
					labelY: geometry.labelY
				};
			});
		}
		/** Rounded-corner polyline; corners collapse gracefully on very short segments. */
		function orthogonalPath(points, radius = 5) {
			if (points.length === 0) return "";
			const first = points[0];
			if (first === void 0) return "";
			if (points.length === 1) return `M${round(first.x)} ${round(first.y)}`;
			const parts = [`M${round(first.x)} ${round(first.y)}`];
			for (let index = 1; index < points.length - 1; index += 1) {
				const previous = points[index - 1];
				const current = points[index];
				const next = points[index + 1];
				if (previous === void 0 || current === void 0 || next === void 0) continue;
				const incoming = distance(previous, current);
				const outgoing = distance(current, next);
				const corner = Math.min(radius, incoming / 2, outgoing / 2);
				if (corner <= .5) {
					parts.push(`L${round(current.x)} ${round(current.y)}`);
					continue;
				}
				const entry = pointTowards(current, previous, corner);
				const exit = pointTowards(current, next, corner);
				parts.push(`L${round(entry.x)} ${round(entry.y)}`);
				parts.push(`Q${round(current.x)} ${round(current.y)} ${round(exit.x)} ${round(exit.y)}`);
			}
			const last = points[points.length - 1];
			if (last !== void 0) parts.push(`L${round(last.x)} ${round(last.y)}`);
			return parts.join(" ");
		}
		/** Small chevron at the `to` end, pointing the way the relation actually flows. */
		function arrowHead(x, y, direction, size = 5) {
			const offset = direction === "down" ? -size * 1.8 : size * 1.8;
			return `M${round(x - size)} ${round(y + offset)} L${round(x)} ${round(y)} L${round(x + size)} ${round(y + offset)}`;
		}
		function distance(left, right) {
			return Math.hypot(right.x - left.x, right.y - left.y);
		}
		function pointTowards(from, to, length) {
			const total = distance(from, to);
			if (total === 0) return from;
			const ratio = Math.min(1, length / total);
			return {
				x: from.x + (to.x - from.x) * ratio,
				y: from.y + (to.y - from.y) * ratio
			};
		}
		function edgeBadge(edge) {
			const relative = edge.at === null ? null : relativeTime(edge.at);
			const retry = edge.retryCount > 0 ? ` · 返工 ${edge.retryCount} 次` : "";
			const base = `${EDGE_STATE_LABELS[edge.state]} · ${edge.action}`;
			return relative === null ? `${base}${retry}` : `${base} · ${relative}${retry}`;
		}
		function isVisible(item) {
			if (item.assignments.length > 0) return true;
			if (item.executions.length > 0) return true;
			if (item.taskIds.length > 0) return true;
			if (item.reports.length > 0) return true;
			if (item.failures.length > 0) return true;
			return item.pendingDecisions.length > 0;
		}
		function modelLabel(agent) {
			return agent.provider === void 0 ? agent.model : `${agent.provider} · ${agent.model}`;
		}
		function skillText(skills) {
			if (skills === void 0 || skills.length === 0) return "暂未绑定";
			return skills.join("、");
		}
		function capabilityText(capabilities) {
			if (capabilities === void 0 || capabilities.length === 0) return "未记录";
			return capabilities.join("、");
		}
		/** Depth-only statement; the sub-agent fact lives in {@link FlowNode.subagentNote}. */
		function delegationText(depth) {
			const value = depth ?? 0;
			if (value <= 0) return `委派深度 ${value} · 不能再派子代理`;
			return `委派深度 ${value} · 可继续派子代理`;
		}
		function executionLabel(execution) {
			if (execution === null) return null;
			const started = execution.startedAt ?? "未记录开始时间";
			const completed = execution.completedAt ?? (execution.status === "running" ? "进行中" : "未完成");
			return `${executionStatusLabel(execution.status)} · ${started} → ${completed} · ${shortId(execution.id, 14)}`;
		}
		function executionStatusLabel(status) {
			return {
				pending: "排队中",
				running: "执行中",
				completed: "已完成",
				failed: "失败",
				closed: "已收尾"
			}[status];
		}
		function boundText(text, limit) {
			const value = text.trim();
			if (value.length === 0) return {
				text: "未记录",
				truncated: false
			};
			if (value.length <= limit) return {
				text: value,
				truncated: false
			};
			return {
				text: value.slice(0, limit),
				truncated: true
			};
		}
		/** Compact zh-CN relative time; invalid or absent times render no suffix. */
		function relativeTime(at, now = Date.now()) {
			const parsed = Date.parse(at);
			if (Number.isNaN(parsed)) return null;
			const delta = now - parsed;
			if (delta < 0) return "刚刚";
			const seconds = Math.floor(delta / 1e3);
			if (seconds < 60) return `${seconds} 秒前`;
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return `${minutes} 分钟前`;
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return `${hours} 小时前`;
			const days = Math.floor(hours / 24);
			if (days < 30) return `${days} 天前`;
			return at.slice(0, 10);
		}
		function round(value) {
			return Math.round(value * 100) / 100;
		}
		//#endregion
		//#region lib/client/skin.js
		/**
		* The dispatch-flow panel's two skins.
		*
		* The brief fixes the palette: a flat iOS-like **light** skin and a dark skin with
		* **restrained dark-gold** accents. Both reuse the harness' semantic state colours,
		* only tuned for contrast on their own background — the five dispatch states and
		* the four relation line styles are never re-coloured by the skin.
		*
		* Default: **dark gold** (step 3C). The panel used to follow
		* `prefers-color-scheme`, but the host exposes no readable light/dark marker (three
		* probes: no theme data attribute or class, and its `--dsw-alias-*` tokens are
		* identical under both media preferences), so following the OS could disagree with
		* the host's own appearance. That follow-the-system branch is therefore REMOVED —
		* there is no longer any trigger for it — and the default is a constant; an
		* explicit user choice is still remembered in `localStorage`.
		*
		* The skin is applied as an attribute on `documentElement` so a rule can also reach
		* the plugin's own pane wrapper (which is the canvas' PARENT, and therefore cannot
		* be styled by a descendant selector).
		*/
		/** Where an explicit user choice is remembered. */
		const FLOW_SKIN_STORAGE_KEY = "devflow.flow.skin";
		/** The attribute the panel publishes on `documentElement`. */
		const FLOW_SKIN_ATTRIBUTE = "data-devflow-skin";
		/** Stable, bounded labels for the toggle (zh-CN first). */
		const FLOW_SKIN_LABELS = {
			light: {
				label: "浅色皮肤（iOS 扁平 + 液态玻璃）",
				hint: "点按切换到暗金皮肤"
			},
			gold: {
				label: "暗金皮肤（液态玻璃）",
				hint: "点按切换到浅色皮肤"
			}
		};
		/** The next skin in the two-state cycle. */
		function nextSkin(current) {
			return current === "light" ? "gold" : "light";
		}
		/** The remembered choice, or the constant default when nothing is stored. */
		function resolveSkin(stored) {
			return stored ?? "gold";
		}
		/** Read the remembered choice, or null when the user never made one. */
		function readStoredSkin(storage) {
			if (storage === null) return null;
			try {
				const value = storage.getItem(FLOW_SKIN_STORAGE_KEY);
				return value === "light" || value === "gold" ? value : null;
			} catch {
				return null;
			}
		}
		/** Remember an explicit choice; a failing storage is ignored, not fatal. */
		function storeSkin(storage, skin) {
			if (storage === null) return;
			try {
				storage.setItem(FLOW_SKIN_STORAGE_KEY, skin);
			} catch {}
		}
		/** Publish the skin where CSS can read it. */
		function applySkinAttribute(root, skin) {
			root.setAttribute(FLOW_SKIN_ATTRIBUTE, skin);
		}
		/** One-shot sweep played when a dispatch becomes 已完成 (≤1.2s per the brief). */
		const FLOW_DONE_SWEEP_MS = 1100;
		/**
		* Bright highlight colour per rate, by SKIN. Each is a higher-luminance member of
		* the same hue family as the rate's semantic stroke, so the state still reads from
		* the colour while the moving head is unmistakable. Measured in the browser on both
		* skins (see the round report): the light skin needs a deeper cyan than the dark one.
		*/
		const FLOW_GLOW_LIGHT = "#3fbfe0";
		const FLOW_GLOW_GOLD = "#7fd4ea";
		/** Rework head: the same lift applied to the red family, per skin. */
		const FLOW_GLOW_REWORK_LIGHT = "#e8655f";
		const FLOW_GLOW_REWORK_GOLD = "#ff8a86";
		/** Stroke width of the moving highlight, in SVG user units (was 2.6). */
		const FLOW_FLOW_WIDTH = 3.4;
		const FLOW_FLOW_OPACITY_WEAK = .55;
		const STILL = {
			flowing: false,
			multiplier: 0,
			speed: 0,
			durationSeconds: 0,
			opacity: 1
		};
		/**
		* The pause posture (§一·前.2): the iron rule says moving = happening, so a paused
		* dispatch is by definition NOT happening — its motion layer is hidden and its card
		* stops animating, exactly like a finished one. The state's colour is kept, because
		* "paused" is a posture of the same dispatch, not a different one.
		*/
		const PAUSED = {
			flowing: false,
			multiplier: 0,
			speed: 0,
			durationSeconds: 0,
			opacity: 1,
			paused: true
		};
		/**
		* The motion profile of one dispatch state.
		*
		* `lost` is static on purpose: a dispatch nobody wrapped up is not "happening",
		* so animating it would claim activity that does not exist.
		*
		* @param state - the dispatch's projected state.
		* @param paused - the snapshot's shared-dispatch pause flag; when set, a state that
		*   would otherwise move returns {@link PAUSED} instead.
		*/
		function motionProfile(state, paused = false) {
			if (paused && (state === "executing" || state === "rework" || state === "queued" || state === "paused")) return PAUSED;
			if (state === "executing") return profile(1);
			if (state === "rework") return profile(1.4);
			if (state === "queued") return {
				...profile(.5),
				opacity: FLOW_FLOW_OPACITY_WEAK
			};
			return STILL;
		}
		function profile(multiplier) {
			const speed = 52 * multiplier;
			return {
				flowing: true,
				multiplier,
				speed: Math.round(speed * 10) / 10,
				durationSeconds: Math.round(96 / speed * 1e3) / 1e3,
				opacity: 1
			};
		}
		function motionRate(profile) {
			if (profile.paused === true) return "paused";
			if (!profile.flowing) return "still";
			if (profile.multiplier > 1) return "strong";
			if (profile.multiplier < 1) return "weak";
			return "base";
		}
		/**
		* Which edges have JUST become 已完成, and may therefore play the single sweep.
		*
		* An edge that is already completed when it first appears never sweeps: it did not
		* "just" finish, it finished before this view existed. The previous-state map is
		* owned by the caller and is updated in place.
		*/
		function freshlyDoneEdges(previous, edges) {
			const fresh = [];
			const seen = /* @__PURE__ */ new Set();
			for (const edge of edges) {
				seen.add(edge.id);
				const before = previous.get(edge.id);
				if (edge.state === "done" && before !== void 0 && before !== "done") fresh.push(edge.id);
				previous.set(edge.id, edge.state);
			}
			for (const id of [...previous.keys()]) if (!seen.has(id)) previous.delete(id);
			return fresh;
		}
		/**
		* The edge ids whose state ACTUALLY changed in this render, i.e. the edges a real
		* committed event moved.
		*
		* This is the "real drive" primitive: the canvas re-arms an edge's flowing layer
		* only when its projected state differs from the previous render, so the phase of
		* every animation is anchored to an event that really happened rather than to a
		* timer. An idle canvas therefore produces NO re-arm at all, and a frame that
		* arrives without a state change is visibly inert.
		*
		* An edge seen for the FIRST time is not "changed": it did not move, it appeared.
		* That mirrors {@link freshlyDoneEdges}'s rule and is what keeps a refresh, a
		* session switch, or a skin swap from animating the whole canvas at once.
		* @param previous - previous edge states, owned by the caller (mutated in place).
		* @param edges - the current edge states.
		* @returns the ids whose state changed, in edge order.
		*/
		function changedEdges(previous, edges) {
			const changed = [];
			const seen = /* @__PURE__ */ new Set();
			for (const edge of edges) {
				seen.add(edge.id);
				const before = previous.get(edge.id);
				if (before !== void 0 && before !== edge.state) changed.push(edge.id);
				previous.set(edge.id, edge.state);
			}
			for (const id of [...previous.keys()]) if (!seen.has(id)) previous.delete(id);
			return changed;
		}
		/**
		* 入场历史的**起点**：首帧一律从"一个节点都没见过"开始。
		*
		* 这是 boss 2026-09-18 裁决的**产品口径 A（首帧也入场）**：首帧 ⇒ **打开画布 / 刷新时
		* 当帧的全部节点各走一次 {@link FLOW_ENTER_MS}**；**切换会话**后本视图**没见过的 id**
		* 同样入场（新会话的节点集合与旧的完全相同时，则一个也不入场）。
		* 早先这里用 `null` 表示"还没有历史"，让首帧与刷新一起**不播**入场；
		* 那个抑制已被裁决推翻，理由不是"更真实"而是产品：**新面板不该突然出现一批静止的卡片**。
		* **切换皮肤不在入场范围里**：它不改变节点集合（只换 `skin` state 与 `data-skin`/CSS 变量），
		* 而 `FlowCanvas` 里入场 effect 的依赖是 `nodes` ⇒ 不重跑、不产生新的入场标记。
		* 需要抑制时改这里，不要改 {@link newlyEnteredNodes} 的语义。
		*/
		const FLOW_ENTER_HISTORY_START = /* @__PURE__ */ new Set();
		/**
		* The node ids that are genuinely NEW in this view, and may play the entrance.
		*
		* "New" means present now and absent from the previous render. A node set with NO
		* history at all does NOT mean "nothing enters" any more: it means every node enters
		* once — see {@link FLOW_ENTER_HISTORY_START} for the product decision behind that.
		* Only node ids already present in `previousIds` are skipped, so the very first paint and
		* a refresh animate the whole set, while a later render animates exactly the ids it had not
		* seen before (that is what a session switch contributes: the new session's new node ids).
		* A skin swap changes no node set at all — it only swaps `data-skin`/CSS variables — so it
		* never reaches this function with a new id set, and a re-render of the same set animates
		* nothing (an idle canvas still never self-drives).
		* @param previousIds - node ids of the previous render; an empty set is the first frame.
		* @param nodes - the current nodes.
		* @returns the ids to animate, in node order.
		*/
		function newlyEnteredNodes(previousIds, nodes) {
			return nodes.filter((node) => !previousIds.has(node.id)).map((node) => node.id);
		}
		/**
		* The next id set for {@link newlyEnteredNodes}'s history.
		* @param nodes - the current nodes.
		* @returns the id set to hand back on the following render.
		*/
		function nodeIdSet(nodes) {
			return new Set(nodes.map((node) => node.id));
		}
		/**
		* Read the `?devflow-glass=` override.
		* @param search - the document's query string.
		* @returns `degrade` for `solid`/`degrade`, `glass` for `glass`, otherwise `auto`.
		*/
		function readGlassOverride(search) {
			const value = new URLSearchParams(search).get("devflow-glass");
			if (value === "solid" || value === "degrade") return "degrade";
			if (value === "glass" || value === "off") return "glass";
			return "auto";
		}
		/** Pure holder of the two guards; the caller owns sampling and the DOM write. */
		var MotionBudget = class {
			slow = false;
			fast = 0;
			long = 0;
			/**
			* Fold one sample into the posture.
			* @param sample - whether motion is running and how long frames took.
			* @returns the posture to publish.
			*/
			sample(sample) {
				if (Number.isFinite(sample.meanFrameMs)) {
					if (sample.meanFrameMs > 20) {
						this.long++;
						this.fast = 0;
					} else if (sample.meanFrameMs < 17) {
						this.fast++;
						this.long = 0;
					} else {
						this.long = 0;
						this.fast = 0;
					}
					if (this.long >= 6) this.slow = true;
					else if (this.fast >= 6) this.slow = false;
				}
				return {
					budget: sample.animating || this.slow ? "degrade" : "auto",
					motion: this.slow ? "degraded" : sample.animating ? "active" : "idle",
					slow: this.slow
				};
			}
		};
		/** Mean of a frame-gap list; `null` when nothing was sampled. */
		function meanFrameMs(gaps) {
			if (gaps.length === 0) return null;
			let total = 0;
			for (const gap of gaps) total += gap;
			return total / gaps.length;
		}
		//#endregion
		//#region lib/client/pause-presentation.js
		/**
		* §一·前.2 — the shared pause must be visible ON THE CANVAS.
		*
		* Boss verified a task is paused while the canvas still said 「返工中」. The pause flag
		* is not new: the identity line already reads `snapshot.paused` ("派发已暂停"). The
		* bug was that only that line consumed it, so every card and every edge kept claiming
		* live work.
		*
		* The iron rule of the motion round settles the rest: **moving = happening, still =
		* finished**. A paused dispatch is not happening, so its motion must stop — the edge's
		* highlight layer stops travelling and the card's running border stops animating —
		* and then come back exactly as it was when the pause is lifted.
		*
		* This module is pure: it rewrites the PRESENTATION of one projected model (state
		* names, labels, status text) and reports which states were frozen, so the canvas can
		* assert both without a browser. It never invents a state the data does not support:
		* only states that claim "happening right now" are rewritten, and every finished or
		* lost dispatch keeps its own, still-correct label.
		*/
		/** The label a paused in-flight dispatch and card carry. */
		const PAUSED_LABEL = "已暂停";
		/**
		* Edge states that CLAIM activity: only these may be rewritten by a pause.
		* `done` and `lost` are finished postures and keep their honest labels.
		*/
		const IN_FLIGHT_EDGE = /* @__PURE__ */ new Set([
			"executing",
			"rework",
			"queued"
		]);
		/**
		* Node states that claim activity. `blocked`/`done`/`lost`/`idle` are already still.
		*
		* `planned` is in the set because an employee node reads `planned` when it holds a
		* dispatch that has not started, and "waiting for a dispatch that is paused" is not
		* 「待派发」 any more. The two nodes that never hold a dispatch are excluded below.
		*/
		const IN_FLIGHT_NODE = /* @__PURE__ */ new Set([
			"active",
			"rework",
			"planned"
		]);
		/**
		* Apply the session's pause posture to one flow model.
		*
		* @param model - the projected model.
		* @param paused - `snapshot.paused`, the same field the identity line reads.
		* @returns the model unchanged when not paused, else the paused presentation.
		*/
		function applyPausePresentation(model, paused) {
			if (!paused) return model;
			const edges = model.edges.map((edge) => {
				if (!IN_FLIGHT_EDGE.has(edge.state)) return edge;
				return {
					...edge,
					state: "paused",
					badge: pausedBadge(edge.badge),
					handoff: {
						...edge.handoff,
						statusLabel: `${PAUSED_LABEL}（共享派发已暂停）`
					}
				};
			});
			const nodes = model.nodes.map((node) => isPausableNode(node) ? {
				...node,
				state: "paused",
				stateLabel: PAUSED_LABEL
			} : node);
			const byId = new Map(edges.map((edge) => [edge.id, edge]));
			return {
				...model,
				edges,
				nodes,
				current: {
					...model.current,
					edges: model.current.edges.map((edge) => byId.get(edge.id) ?? edge)
				}
			};
		}
		/**
		* Whether a pause may restate this node.
		*
		* Two nodes are never "paused": the 用户需求 node (a read-only source node that carries
		* no dispatch at all — its label is 「来源：用户」, not a work state) and the commander
		* while it only reads `planned` (a commander with nothing running is idle, not frozen).
		* A commander that WAS running or reworking is genuinely frozen by the pause.
		*/
		function isPausableNode(node) {
			if (node.kind === "requirement") return false;
			if (node.kind === "commander" && node.state === "planned") return false;
			return IN_FLIGHT_NODE.has(node.state);
		}
		/**
		* Replace only the state WORD of a dispatch badge. The badge is
		* `状态 · 动作 · 相对时间 · 返工 N 次` (see `edgeBadge`), so the first segment is
		* swapped in place and everything the record actually knows is preserved — the
		* pause changes what the line claims, not what the record says.
		*/
		function pausedBadge(badge) {
			const separator = badge.indexOf(" · ");
			if (separator === -1) return `${PAUSED_LABEL} · ${badge}`;
			return `${PAUSED_LABEL}${badge.slice(separator)}`;
		}
		/** The float's own identity in `shell.overlay`, and its localStorage namespace. */
		const OVERVIEW_CELL_ID = "devflow-overview";
		/**
		* The window event the panel's header action dispatches to bring a CLOSED float back.
		*
		* It lives here, in the pure module both sides already import, so the panel does not
		* have to reach into the float's component module (which would make the two import
		* each other).
		*/
		const OVERVIEW_REOPEN_EVENT = "devflow:overview-reopen";
		/**
		* Storage keys: folding, the explicit close, and the skin the float renders in.
		*
		* The fold and the close are remembered **per session** (see
		* {@link overviewClosedKey} / {@link overviewExpandedKey}). They are UI
		* preferences ABOUT ONE SESSION's float, and a single global flag made one
		* accidental click hide the overview in every DevFlow session — including
		* projects the operator never touched — with no way back except hunting for the
		* panel's reopen action. The `*_KEY` constants below are the LEGACY global keys:
		* they are only read to be discarded (see `legacyFlagCleanup`).
		*/
		const OVERVIEW_EXPANDED_KEY = "devflow.overview.expanded";
		const OVERVIEW_CLOSED_KEY = "devflow.overview.closed";
		/**
		* The per-session close key.
		*
		* Scoped by session id so "I don't need the overview here" stays a decision about
		* THAT session. An id-less call falls back to the legacy global key, which keeps
		* the read total instead of throwing on an unexpected state.
		* @param sessionId - the session the float belongs to.
		* @returns the storage key for that session's close flag.
		*/
		function overviewClosedKey(sessionId) {
			return sessionId === null || sessionId === void 0 || sessionId === "" ? OVERVIEW_CLOSED_KEY : `${OVERVIEW_CLOSED_KEY}.${sessionId}`;
		}
		/**
		* The per-session fold key; same scoping rule as {@link overviewClosedKey}.
		* @param sessionId - the session the float belongs to.
		* @returns the storage key for that session's fold flag.
		*/
		function overviewExpandedKey(sessionId) {
			return sessionId === null || sessionId === void 0 || sessionId === "" ? OVERVIEW_EXPANDED_KEY : `${OVERVIEW_EXPANDED_KEY}.${sessionId}`;
		}
		/**
		* Remove the legacy GLOBAL flags once, so they cannot keep hiding the float.
		*
		* A global `closed` written by an older build would otherwise hide the float
		* forever: the per-session key it is read from now would never match, and the
		* stale flag would sit there resurrecting the bug for anyone whose session id
		* ever collided with it.
		* @param storage - the storage to clean, or null when unavailable.
		*/
		function legacyFlagCleanup(storage) {
			if (storage === null) return;
			try {
				storage.removeItem(OVERVIEW_CLOSED_KEY);
				storage.removeItem(OVERVIEW_EXPANDED_KEY);
			} catch {}
		}
		/**
		* Decide whether the float may exist for the current session.
		*
		* @param sessions - the client session list state.
		* @returns the gate decision; `allowed` is true for exactly one case.
		*/
		function overviewGate(sessions) {
			if (sessions === void 0 || sessions === null || sessions.current === void 0) return {
				allowed: false,
				sessionId: null,
				preset: null,
				reason: "no-session"
			};
			const sessionId = sessions.current;
			const raw = sessions.byId[sessionId]?.projectionValues?.agentPreset;
			if (typeof raw !== "string" || raw === "") return {
				allowed: false,
				sessionId,
				preset: null,
				reason: "preset-unresolved"
			};
			if (raw !== "devflow") return {
				allowed: false,
				sessionId,
				preset: raw,
				reason: "other-preset"
			};
			return {
				allowed: true,
				sessionId,
				preset: raw,
				reason: "allowed"
			};
		}
		/** Chinese wording for the live-channel posture; never a raw transport string. */
		function connectionLabel(connection) {
			if (connection === null) return "轮询兜底";
			if (connection.phase === "live") return "实时通道";
			if (connection.phase === "connecting") return "连接中";
			return "轮询兜底";
		}
		/** The reason line under a polling badge, or null while the channel is healthy. */
		function connectionDetail(connection) {
			if (connection === null || connection.phase !== "polling") return null;
			return connection.detail ?? "实时连接已断开，正在使用轮询";
		}
		/** How many dispatch edges the default (current) view hides behind 全部历史. */
		function hiddenDispatchCount(flow) {
			return Math.max(0, flow.history.edges.length - flow.current.edges.length);
		}
		/**
		* Build the float's read model from the same inputs the canvas uses.
		*
		* @param model - the workspace model folded from the snapshot.
		* @param now - the clock the stale judgement uses (the canvas passes the same one).
		* @param connection - the live-channel posture, or null when unavailable.
		* @returns the overview view model.
		*/
		function buildOverview(model, now, connection = null) {
			const paused = model.snapshot.paused;
			const flow = applyPausePresentation(createFlowModel(model, now, {}, "history"), paused);
			const counts = {
				...countEdges(flow.history.edges, model),
				unrouted: flow.unroutedCount,
				hidden: hiddenDispatchCount(flow)
			};
			const total = flow.history.edges.length;
			const commander = flow.nodes.find((node) => node.id === flow.commanderId);
			/**
			* The employee rows, both rosters.
			*
			* The fixed four are listed always — they are the team, whether or not they are
			* holding anything right now. A temporary sub-agent is listed only when the
			* canvas actually draws it (one card, one row): the float and the canvas read the
			* same node set, so "画布上有卡、概览说没人" cannot happen.
			*/
			const rosterIds = new Set(flow.nodes.map((node) => node.id));
			const members = model.agents.filter((item) => item.agent.id !== flow.commanderId).filter((item) => item.agent.kind === "fixed" || rosterIds.has(item.agent.id)).map((item) => memberRow(item.agent, flow));
			return {
				projectName: model.snapshot.project?.name ?? "（未初始化）",
				bindingLabel: model.snapshot.session.commanderMode === "commander" ? "已绑定" : "未绑定",
				paused,
				counts,
				total,
				summary: summaryLine(counts.lost, counts.active, counts.review, counts.done),
				posture: postureOf(counts),
				postureLabel: postureLabel(postureOf(counts)),
				commanderName: flowAgentName(flow.commanderId, commander?.label ?? "总指挥"),
				commanderStateLabel: paused ? "已暂停" : commander?.stateLabel ?? "未知",
				dispatchCount: total,
				members,
				connectionLabel: connectionLabel(connection),
				connectionPhase: connection?.phase ?? "polling"
			};
		}
		/**
		* The project's dispatch ledger, bucketed the way the panel talks about it.
		*
		* 待验收 is NOT a stored state: a dispatch is waiting for acceptance while it is
		* finished (`done`) and its task is still in 复核中 — the stored status is literally
		* `reviewing`, which the panel words as `Reviewing` (see `taskWorkStateLabel`).
		* Reading it any other way would need a second source of truth, which the round forbids.
		*/
		function countEdges(edges, model) {
			let active = 0;
			let review = 0;
			let done = 0;
			let lost = 0;
			let paused = 0;
			let closed = 0;
			for (const edge of edges) {
				if (edge.state === "executing" || edge.state === "queued") {
					active += 1;
					continue;
				}
				if (edge.state === "rework") {
					active += 1;
					continue;
				}
				if (edge.state === "paused") {
					paused += 1;
					continue;
				}
				if (edge.state === "lost") {
					lost += 1;
					continue;
				}
				if (edge.state === "closed") {
					closed += 1;
					continue;
				}
				if (edge.state === "done") {
					if (edge.taskId !== null && model.taskById.get(edge.taskId)?.workState === "reviewing") review += 1;
					else done += 1;
				}
			}
			return {
				active,
				review,
				done,
				lost,
				paused,
				closed,
				unrouted: 0,
				hidden: 0
			};
		}
		/** The pill's headline: the lede is what is happening now, then what is stuck. */
		function summaryLine(lost, active, review, done) {
			const parts = [];
			if (active > 0) parts.push(`进行中 ${active}`);
			if (review > 0) parts.push(`待验收 ${review}`);
			if (parts.length === 0) parts.push(done > 0 && lost === 0 ? "全部完成" : lost > 0 ? "无进行中" : "暂无派发");
			if (lost > 0) parts.push(`未收尾 ${lost}`);
			return parts.join(" · ");
		}
		/**
		* The pill's status dot. 已收尾 does NOT make the project "active": a project whose only
		* remaining records were wrapped up has nothing happening, so the posture is allowed to
		* read 全部完成 — the closed count is reported in the card's own row instead.
		*/
		function postureOf(counts) {
			if (counts.active > 0 || counts.lost > 0 || counts.paused > 0) return "active";
			if (counts.review > 0) return "review";
			return "done";
		}
		function postureLabel(posture) {
			return posture === "active" ? "进行中" : posture === "review" ? "待验收" : "全部完成";
		}
		/** One employee's row: the node the canvas draws, plus the dispatch it holds. */
		function memberRow(agent, flow) {
			const node = flow.nodes.find((candidate) => candidate.id === agent.id);
			return {
				id: agent.id,
				name: flowAgentName(agent.id, agent.displayName),
				kind: agent.kind === "temporary" ? "temporary" : "fixed",
				state: node?.state ?? "idle",
				stateLabel: node?.stateLabel ?? "空闲",
				taskTitle: node?.taskTitle ?? null
			};
		}
		//#endregion
		//#region lib/client/FlowCanvas.js
		/**
		* Canvas body of the right column's third tab ("派发流").
		*
		* Interaction model (design §2/§11, correction round):
		*   * pan, wheel + button zoom, fit, node drag, edge inspection;
		*   * cards carry a SUMMARY only — the full node record lives in the canvas'
		*     right-hand inspector, so clicking a card never changes its height and never
		*     squeezes the routing;
		*   * one inspector serves all three selections: a node, a dispatch edge
		*     (交接详情) and a 阶段关联带 (阶段关联);
		*   * the inspector is docked beside the canvas when the pane is wide enough and
		*     becomes an overlay drawer at the narrow end, so the canvas is never crushed.
		*
		* Layout and view stay decoupled from data:
		*   * a data refresh only re-projects the model and re-draws the edges;
		*   * node positions the user moved are "user placed" and a refresh never re-lays
		*     them out — only the explicit 重置布局 action returns to auto layout;
		*   * the viewport transform is recomputed only by 适配视图, a real resize of the
		*     canvas box, a scope switch, or the first fit after the cards were measured —
		*     never by a text-only refresh;
		*   * once the operator pans, zooms or drags, automatic fitting stops.
		*/
		const NODE_HEIGHT = 118;
		/**
		* Zoom floor. The round brief fixes the range at 0.4×–1.8×, and with the phase
		* rail gone (correction R2) the canvas is narrow enough that 0.4 still fits the
		* whole chain at the 420px column.
		*/
		const MIN_SCALE = .4;
		const MAX_SCALE = 1.8;
		const FIT_PADDING = 16;
		/** Vertical space the floating overlays occupy at the top / bottom of the canvas. */
		const FIT_TOP_RESERVE = 96;
		const FIT_BOTTOM_RESERVE = 150;
		/** Least amount of the world that must stay inside the viewport while panning. */
		const MIN_VISIBLE = 96;
		const RESIZE_EPSILON = 12;
		/** Above this many edges, per-edge badges would cover the lanes; only these stay. */
		const EDGE_LABEL_LIMIT = 12;
		/** A single row wider than this is a data-density problem, and the panel says so. */
		const WIDE_ROW_LIMIT = 6;
		/**
		* Below this canvas width the inspector floats over the canvas instead of docking
		* (see the R2 measurement in the round report), so the drawing is never crushed.
		*/
		const INSPECTOR_DOCK_MIN = 680;
		const VIEW_LABELS = {
			flow: "派发流",
			audit: "审计",
			tools: "本会话"
		};
		/**
		* The five states the LEGEND lists, in the order the round's design fixes them. The
		* 收尾终态 (closed) is deliberately a sixth, separate presentation: it is not one of the
		* five dispatch states, it is the statement that a dispatch was wrapped up. It is
		* therefore named by the badges/edges themselves and by the overview's own count, and
		* the five-state legend is left exactly as the previous rounds shipped it.
		*/
		const EDGE_STATES = [
			"queued",
			"executing",
			"done",
			"rework",
			"lost"
		];
		const EDGE_STATE_TEXT = {
			queued: "排队/已接收",
			executing: "执行中",
			done: "已完成",
			rework: "返工",
			lost: "未收尾/失联",
			paused: "已暂停",
			closed: "已收尾"
		};
		const SEMANTIC_ORDER = [
			"requirement",
			"dispatch",
			"delivery",
			"rework",
			"subagent"
		];
		const NODE_STATE_CLASS = {
			idle: "",
			active: "run",
			blocked: "wait",
			done: "done",
			rework: "bad",
			planned: "queue",
			lost: "lost",
			paused: "paused",
			closed: "closed"
		};
		/** What the canvas shows per relation, in words, next to the line sample. */
		const SEMANTIC_SHAPE = {
			requirement: "点线 · 指向总指挥",
			dispatch: "实线 · 指向员工",
			delivery: "点划线 · 指回总指挥",
			rework: "长虚线 · 指向原员工",
			subagent: "点线 · 双向"
		};
		/** Render the dispatch-flow canvas plus its overlays, inspector and the secondary views. */
		function FlowCanvas(props) {
			const { model, phase, tab, onTabChange, auditPanel, toolsPanel, now, connection: channel, notice, onReopenOverview } = props;
			const [heights, setHeights] = (0, react.useState)({});
			const [showHistory, setShowHistory] = (0, react.useState)(false);
			const [legendOpen, setLegendOpen] = (0, react.useState)(false);
			const scope = showHistory ? "history" : "current";
			/**
			* §一·前.2: the pause posture is part of what the canvas SHOWS, so it is folded
			* into the same model the cards and the inspector read — one source of truth, no
			* second reading of the flag anywhere in the view.
			*/
			const paused = model.snapshot.paused;
			const flow = (0, react.useMemo)(() => applyPausePresentation(createFlowModel(model, now, heights, scope), paused), [
				model,
				now,
				heights,
				scope,
				paused
			]);
			const connection = channel ?? null;
			const viewportRef = (0, react.useRef)(null);
			/**
			* The viewport element itself, as state, so the ResizeObserver is re-attached
			* when the dock re-creates the pane (which it does when the right column
			* switches layout at narrow widths). Watching a detached node meant a resize
			* never re-fitted the canvas below ~1180px.
			*/
			const [viewportHost, setViewportHost] = (0, react.useState)(null);
			const bindViewport = (0, react.useCallback)((element) => {
				viewportRef.current = element;
				setViewportHost(element);
			}, []);
			/** Canvas host width, used to decide dock vs overlay drawer for the inspector. */
			const [hostWidth, setHostWidth] = (0, react.useState)(0);
			const hostRef = (0, react.useRef)(null);
			const boxRefs = (0, react.useRef)(/* @__PURE__ */ new Map());
			const sizeRef = (0, react.useRef)({
				w: 0,
				h: 0
			});
			/** Set as soon as the operator pans, zooms or drags; stops automatic fitting. */
			const viewTouchedRef = (0, react.useRef)(false);
			const [transform, setTransform] = (0, react.useState)({
				scale: .75,
				x: 12,
				y: 12
			});
			const [positions, setPositions] = (0, react.useState)(() => seedPositions(flow));
			const [pinned, setPinned] = (0, react.useState)([]);
			const [selection, setSelection] = (0, react.useState)(null);
			/** What the 阶段关联 list currently highlights on the canvas. */
			const [highlight, setHighlight] = (0, react.useState)(null);
			const [rosterOpen, setRosterOpen] = (0, react.useState)(false);
			const [rosterCards, setRosterCards] = (0, react.useState)([]);
			const [panning, setPanning] = (0, react.useState)(false);
			/**
			* Skin: the default is the dark-gold skin (step 3C); an explicit choice wins and
			* is remembered. The old "follow the system" branch is gone on purpose (see
			* `skin.ts` for the measured reason).
			*/
			const [skin, setSkin] = (0, react.useState)(() => resolveSkin(readStoredSkin(safeStorage$1())));
			/** The canvas root, where the §11.1 glass budget posture is published for CSS. */
			const rootRef = (0, react.useRef)(null);
			/**
			* Edges that JUST became 已完成, which may play the single pass-through sweep.
			* The map is a ref so a data refresh never rebuilds the animation elements.
			*/
			const previousStatesRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			/**
			* A SECOND history for the flowing re-arm, deliberately not shared with the sweep
			* above: both walk "previous vs current" and both mutate their map, so one shared
			* map would make whichever effect ran second compare against states the first had
			* already overwritten — the re-arm would then never see a change at all.
			*/
			const changedStatesRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			const [freshDone, setFreshDone] = (0, react.useState)([]);
			/**
			* Edges a REAL state change moved in the last render. The flowing layer is
			* re-armed only for these, so animation phase is anchored to committed events
			* rather than to the render loop: an idle canvas re-arms nothing at all.
			*/
			const [rearmedEdges, setRearmedEdges] = (0, react.useState)([]);
			/**
			* Bumped once per re-arm so the re-armed element's key actually changes. The
			* epoch is what makes a REPEATED change to the same edge restart its animation; a
			* key derived from the edge id alone would keep the element across renders and
			* leave the flow running from wherever it happened to be.
			*/
			const [rearmEpoch, setRearmEpoch] = (0, react.useState)(0);
			const nodes = (0, react.useMemo)(() => flow.nodes.map((node) => ({
				...node,
				...positions[node.id] ?? {
					x: node.x,
					y: node.y
				}
			})), [flow, positions]);
			/**
			* Node ids 的历史，以及此刻正在播入场的 id 集合。
			*
			* 初值是**空 Set**（{@link FLOW_ENTER_HISTORY_START}），不是 `null`：这是 boss
			* 2026-09-18 裁决的产品口径 A —— **首帧也入场**（当帧每个节点各走一次
			* {@link FLOW_ENTER_MS} 的入场动效）。触发范围**只有节点集合的变化**：
			* **打开画布 / 刷新**（都是重新挂载 ⇒ 当帧全部节点入场），以及**切换会话**后本视图
			* **没见过的 id**（新会话带来的新节点逐个入场；若新会话的节点集合与旧的完全相同，
			* 则一个也不入场）。**切换皮肤不在这个范围里**：`toggleSkin` 只改 `skin` state 与
			* documentElement 上的 `data-skin`（颜色/CSS 变量），`nodes` 的引用不变 ⇒ 入场 effect
			* 的依赖（`[nodes]`）没变、不会重跑，也不会有新的 id 被写进 `enteringNodes`；
			* 皮肤换色 ≠ 重播入场。
			* 产品理由：面板刚刚出现时若整屏卡片是"静止"的，用户看不出这些卡是刚生成的；裁决取
			* "全量播一次"换掉早先"首帧不播"的抑制。需要重新抑制时改这个初值，别改判定语义。
			*/
			const previousNodeIdsRef = (0, react.useRef)(FLOW_ENTER_HISTORY_START);
			/** 首次渲染的节点集只在挂载时取一次，供入场标记的初值使用。 */
			const initialNodesRef = (0, react.useRef)(null);
			if (initialNodesRef.current === null) initialNodesRef.current = nodes;
			/**
			* 首帧的入场标记在**首次渲染时**就算好，让第一批 DOM 自带的 `data-enter="true"`；
			* effect 在挂载时只会看到"这几个 id 已经在 enteringNodes 里"，因此不会重复又播一遍。
			*/
			const [enteringNodes, setEnteringNodes] = (0, react.useState)(() => newlyEnteredNodes(FLOW_ENTER_HISTORY_START, initialNodesRef.current ?? []));
			const heightOf = (nodeId) => heights[nodeId] ?? NODE_HEIGHT;
			const boxes = (0, react.useMemo)(() => new Map(nodes.map((node) => [node.id, {
				x: node.x,
				y: node.y,
				width: node.kind === "requirement" ? 208 : 172,
				height: heights[node.id] ?? NODE_HEIGHT
			}])), [nodes, heights]);
			const edges = (0, react.useMemo)(() => layoutEdges(flow.edges, boxes), [flow, boxes]);
			const requirementEdge = (0, react.useMemo)(() => flow.requirementEdge === null ? null : layoutEdges([flow.requirementEdge], boxes)[0] ?? null, [flow, boxes]);
			const heightsSignature = Object.entries(heights).sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => `${id}:${value}`).join("|");
			(0, react.useEffect)(() => {
				const manual = new Set(pinned);
				setPositions((previous) => {
					let changed = false;
					const next = { ...previous };
					const seen = /* @__PURE__ */ new Set();
					for (const node of flow.nodes) {
						seen.add(node.id);
						if (manual.has(node.id)) continue;
						const current = next[node.id];
						if (current === void 0 || current.x !== node.x || current.y !== node.y) {
							next[node.id] = {
								x: node.x,
								y: node.y
							};
							changed = true;
						}
					}
					for (const id of Object.keys(next)) if (!seen.has(id)) {
						delete next[id];
						changed = true;
					}
					return changed ? next : previous;
				});
			}, [
				flow,
				pinned,
				heightsSignature
			]);
			(0, react.useEffect)(() => {
				setHeights((previous) => {
					let changed = false;
					const next = { ...previous };
					boxRefs.current.forEach((element, id) => {
						const measured = Math.round(element.offsetHeight);
						if (measured > 0 && next[id] !== measured) {
							next[id] = measured;
							changed = true;
						}
					});
					return changed ? next : previous;
				});
			}, [flow, transform.scale]);
			(0, react.useEffect)(() => {
				const host = hostRef.current;
				if (host === null || typeof ResizeObserver === "undefined") return;
				const observer = new ResizeObserver(() => {
					setHostWidth(host.getBoundingClientRect().width);
				});
				observer.observe(host);
				setHostWidth(host.getBoundingClientRect().width);
				return () => {
					observer.disconnect();
				};
			}, [tab]);
			const fittedForRef = (0, react.useRef)(0);
			const fitRef = (0, react.useRef)(() => void 0);
			fitRef.current = fit;
			(0, react.useEffect)(() => {
				if (viewportHost === null || typeof ResizeObserver === "undefined") return;
				sizeRef.current = {
					w: 0,
					h: 0
				};
				const observer = new ResizeObserver(() => {
					const rect = viewportHost.getBoundingClientRect();
					const previous = sizeRef.current;
					const first = previous.w === 0 && previous.h === 0;
					sizeRef.current = {
						w: rect.width,
						h: rect.height
					};
					if (!first && Math.abs(rect.width - previous.w) < RESIZE_EPSILON && Math.abs(rect.height - previous.h) < RESIZE_EPSILON) return;
					fitRef.current();
				});
				observer.observe(viewportHost);
				return () => {
					observer.disconnect();
				};
			}, [viewportHost]);
			(0, react.useEffect)(() => {
				if (pinned.length > 0 || viewTouchedRef.current) return;
				if (Math.abs(flow.canvasHeight - fittedForRef.current) < 24) return;
				fitRef.current();
			}, [
				heights,
				pinned,
				edges,
				flow.canvasHeight
			]);
			function fit() {
				const viewport = viewportRef.current;
				if (viewport === null) return;
				const rect = viewport.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) return;
				const width = flow.canvasWidth;
				const height = flow.canvasHeight;
				fittedForRef.current = height;
				const top = FIT_TOP_RESERVE;
				const bottom = FIT_BOTTOM_RESERVE;
				const usableWidth = Math.max(80, rect.width - 32);
				const usableHeight = Math.max(80, rect.height - top - bottom);
				const scale = clamp(Math.min(usableWidth / Math.max(width, 1), usableHeight / Math.max(height, 1)), MIN_SCALE, MAX_SCALE);
				setTransform({
					scale,
					x: FIT_PADDING + Math.max(0, (usableWidth - width * scale) / 2),
					y: top + Math.max(0, (usableHeight - height * scale) / 2)
				});
			}
			/** Explicit reset: drop user placement and return to the computed layout. */
			const resetLayout = (0, react.useCallback)(() => {
				viewTouchedRef.current = false;
				setPinned([]);
				setPositions(seedPositions(flow));
				setHeights({});
				window.requestAnimationFrame(() => {
					fitRef.current();
				});
			}, [flow]);
			(0, react.useEffect)(() => {
				const onKeyDown = (event) => {
					if (event.key === "Escape") {
						setSelection(null);
						setHighlight(null);
						setLegendOpen(false);
					}
				};
				window.addEventListener("keydown", onKeyDown);
				return () => {
					window.removeEventListener("keydown", onKeyDown);
				};
			}, []);
			(0, react.useEffect)(() => {
				applySkinAttribute(document.documentElement, skin);
			}, [skin]);
			/**
			* The ONLY scripted part of the motion: notice when a dispatch turns 已完成 so it
			* can play its single sweep. The sweep itself is a CSS animation (no frame loop),
			* and the flag is cleared by one timer shortly after it starts.
			*/
			(0, react.useEffect)(() => {
				const fresh = freshlyDoneEdges(previousStatesRef.current, edges);
				if (fresh.length === 0) return;
				setFreshDone((previous) => [.../* @__PURE__ */ new Set([...previous, ...fresh])]);
				const timer = window.setTimeout(() => {
					setFreshDone([]);
				}, FLOW_DONE_SWEEP_MS);
				return () => {
					window.clearTimeout(timer);
				};
			}, [edges]);
			/**
			* Re-arm the flowing layer for the edges a real change moved.
			*
			* `changedEdges` is a pure diff over the projected states, so this fires exactly
			* when the committed state actually changed — never on a timer, and never for an
			* edge merely because it is present. That is what "真实事件驱动" means here: the
			* frame tells us the state moved, the snapshot tells us how, and only the
			* difference produces motion.
			*/
			(0, react.useEffect)(() => {
				const changed = changedEdges(changedStatesRef.current, edges);
				if (changed.length === 0) return;
				setRearmedEdges(changed);
				setRearmEpoch((epoch) => epoch + 1);
			}, [edges]);
			/**
			* Play the entrance for nodes that appeared while this view was live.
			*
			* `previousNodeIdsRef` starts as an EMPTY set (boss 2026-09-18 裁决 A：首帧也入场),
			* so every node of the first render counts as new and plays one entrance — the markers
			* are already computed in the initial state, which is why this effect adds nothing on
			* mount and simply takes over the history for the renders after it. 首帧那一次的全量
			* 入场是**产品决策**（见 {@link FLOW_ENTER_HISTORY_START}），代价是首帧同时跑一遍全场动效。
			* 本 effect 的唯一依赖是 `nodes`：**只有节点集合变了才会重跑**，所以入场只发生在
			* 打开画布 / 刷新（挂载）与"新会话带来的、本视图没见过的 id"这两类情形上；
			* **切换皮肤不触发**——它只换 `data-skin`/CSS 变量，`nodes` 还是同一个引用，effect 不重跑，
			* 也就不会产生新的 `data-enter=true`。空闲画布（节点集合不变）因此永远不会自我驱动。
			*/
			(0, react.useEffect)(() => {
				const entered = newlyEnteredNodes(previousNodeIdsRef.current, nodes);
				previousNodeIdsRef.current = nodeIdSet(nodes);
				if (entered.length === 0) return;
				setEnteringNodes(entered);
				const timer = window.setTimeout(() => {
					setEnteringNodes([]);
				}, 420);
				return () => {
					window.clearTimeout(timer);
				};
			}, [nodes]);
			/** Flip the skin and remember the choice from now on. */
			function toggleSkin() {
				const next = nextSkin(skin);
				storeSkin(safeStorage$1(), next);
				setSkin(next);
			}
			/**
			* §11.1 玻璃 × 动效的降级策略：动画运行期间把叠加的玻璃层降级为实色，动画停下
			* {@link MOTION_QUIET_MS} 后恢复；另加一道"持续长帧"的自适应兜底。判定结果写在
			* 画布根节点的 data-glass-budget / data-motion 上，供样式与取证读取。
			* 这里只切换背景与模糊，绝不改动布局、语义色或动效本身。
			*/
			useGlassMotionBudget(rootRef);
			/**
			* The wheel over the canvas ZOOMS and must never scroll anything else.
			*
			* Root cause measured in correction R2: React attaches `onWheel` as a PASSIVE
			* listener, so `event.preventDefault()` inside the JSX handler was a no-op and
			* the wheel bubbled into the dock's pane body (`overflow-y:auto`,
			* `scrollHeight 916 > clientHeight 862`), which shifted the whole panel by 54px.
			* The listener therefore has to be registered natively with `passive: false`.
			*/
			(0, react.useEffect)(() => {
				if (viewportHost === null) return;
				const onWheel = (event) => {
					event.preventDefault();
					event.stopPropagation();
					zoomAt(event.deltaY < 0 ? 1.08 : .92, event.clientX, event.clientY);
				};
				viewportHost.addEventListener("wheel", onWheel, { passive: false });
				return () => {
					viewportHost.removeEventListener("wheel", onWheel);
				};
			}, [viewportHost]);
			/** Clamp panning so a slice of the canvas always stays reachable. */
			function panTo(next) {
				const viewport = viewportRef.current;
				if (viewport === null) return next;
				const rect = viewport.getBoundingClientRect();
				const worldW = flow.canvasWidth * next.scale;
				const worldH = flow.canvasHeight * next.scale;
				return {
					scale: next.scale,
					x: clamp(next.x, Math.min(MIN_VISIBLE, rect.width) - worldW, Math.max(0, rect.width - MIN_VISIBLE)),
					y: clamp(next.y, Math.min(MIN_VISIBLE, rect.height) - worldH, Math.max(0, rect.height - MIN_VISIBLE))
				};
			}
			function zoomBy(delta) {
				const viewport = viewportRef.current;
				if (viewport === null) return;
				const rect = viewport.getBoundingClientRect();
				const anchorX = rect.width / 2;
				const anchorY = rect.height / 2;
				viewTouchedRef.current = true;
				setTransform((current) => {
					const scale = clamp(current.scale + delta, MIN_SCALE, MAX_SCALE);
					return panTo({
						scale,
						x: anchorX - (anchorX - current.x) * (scale / current.scale),
						y: anchorY - (anchorY - current.y) * (scale / current.scale)
					});
				});
			}
			function zoomAt(factor, clientX, clientY) {
				const viewport = viewportRef.current;
				if (viewport === null) return;
				const rect = viewport.getBoundingClientRect();
				const anchorX = clientX - rect.left;
				const anchorY = clientY - rect.top;
				viewTouchedRef.current = true;
				setTransform((current) => {
					const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
					return panTo({
						scale,
						x: anchorX - (anchorX - current.x) * (scale / current.scale),
						y: anchorY - (anchorY - current.y) * (scale / current.scale)
					});
				});
			}
			function startPan(event) {
				if (event.button !== 0) return;
				const target = event.target;
				if (target.closest("[data-flow-node]") !== null) return;
				if (target.closest("[data-flow-edge]") !== null) return;
				if (target.closest(".devflow-flow-float") !== null) return;
				const startX = event.clientX;
				const startY = event.clientY;
				const origin = transform;
				let moved = 0;
				setPanning(true);
				const move = (moveEvent) => {
					moved += Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY);
					viewTouchedRef.current = true;
					setTransform(panTo({
						scale: origin.scale,
						x: origin.x + (moveEvent.clientX - startX),
						y: origin.y + (moveEvent.clientY - startY)
					}));
				};
				const up = () => {
					setPanning(false);
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
					if (moved < 4) setSelection(null);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
			}
			function startNodeDrag(nodeId, event) {
				if (event.button !== 0) return;
				event.stopPropagation();
				const startX = event.clientX;
				const startY = event.clientY;
				const origin = positions[nodeId] ?? {
					x: 0,
					y: 0
				};
				let moved = 0;
				const move = (moveEvent) => {
					const dx = (moveEvent.clientX - startX) / transform.scale;
					const dy = (moveEvent.clientY - startY) / transform.scale;
					moved += Math.abs(dx) + Math.abs(dy);
					viewTouchedRef.current = true;
					setPositions((current) => ({
						...current,
						[nodeId]: {
							x: origin.x + dx,
							y: origin.y + dy
						}
					}));
				};
				const up = () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
					if (moved < 4) selectNode(nodeId);
					else setPinned((current) => current.includes(nodeId) ? current : [...current, nodeId]);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
			}
			/** A tap on a card opens its detail in the inspector — the card itself never grows. */
			function selectNode(nodeId) {
				setSelection({
					kind: "node",
					id: nodeId
				});
			}
			function selectEdge(edgeId) {
				setSelection({
					kind: "edge",
					id: edgeId
				});
			}
			function toggleRosterCard(agentId) {
				setRosterCards((current) => current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]);
			}
			const selectedEdge = selection?.kind === "edge" ? edges.find((edge) => edge.id === selection.id) ?? null : null;
			const selectedNode = selection?.kind === "node" ? nodes.find((node) => node.id === selection.id) ?? null : null;
			const selectedBand = selection?.kind === "phase" ? flow.bands.find((band) => band.id === selection.id) ?? null : null;
			const docked = hostWidth >= INSPECTOR_DOCK_MIN;
			const inspectorMode = selection === null ? "closed" : docked ? "dock" : "drawer";
			/**
			* Which nodes/edges the 阶段关联 list currently highlights: a single task, or
			* every task and dispatch of one phase.
			*/
			const highlightedTasks = highlight === null ? /* @__PURE__ */ new Set() : highlight.kind === "task" ? /* @__PURE__ */ new Set([highlight.id]) : new Set((flow.bands.find((band) => band.id === highlight.id)?.tasks ?? []).map((task) => task.id));
			const highlightedPhase = highlight !== null && highlight.kind === "phase" ? highlight.id : null;
			const isHighlighted = (taskId, phaseId) => taskId !== null && (highlightedTasks.has(taskId) || phaseId !== null && phaseId === highlightedPhase);
			const roster = model.agents.filter((item) => item.agent.kind === "fixed");
			const temporaryRoster = model.agents.filter((item) => item.agent.kind === "temporary");
			const runningIds = new Set(nodes.filter((node) => node.state === "active").map((node) => node.id));
			const session = model.snapshot.session;
			/**
			* The panel's project identifier (第九步).
			*
			* It names THIS session's project — the workspace the session is isolated to —
			* not a machine-wide shared root. The project name comes from the durable
			* project record; the workspace path is what makes two same-named projects
			* distinguishable, and the full path is carried verbatim so an operator can
			* copy it. `（未初始化）` keeps meaning "no project record in this workspace".
			*/
			const projectName = model.snapshot.project?.name ?? "（未初始化）";
			const workspacePath = session.workspacePath ?? null;
			const workspaceLabel = workspacePath === null ? null : workspaceBasename(workspacePath);
			const identityLine = [
				workspacePath === null ? `本项目 ${projectName}` : `本项目 ${projectName} @ ${workspaceLabel}`,
				session.commanderMode === "commander" ? "本会话已绑定总指挥" : "本会话未绑定总指挥",
				`会话 ${shortId(session.id, 12)}`,
				model.snapshot.paused ? "派发已暂停" : "派发中",
				freshnessLine(phase, model.snapshot.generatedAt),
				channelLine(connection)
			].join(" ｜ ");
			const labelled = (edge) => edges.length <= EDGE_LABEL_LIMIT || edge.id === selection?.id || edge.semantic === "rework";
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "devflow-flow",
				"data-skin": skin,
				"data-paused": paused,
				ref: rootRef,
				children: [tab !== "flow" && (0, react_jsx_runtime.jsxs)("div", {
					className: "devflow-flow-panel devflow-flow-secondary",
					role: "tabpanel",
					children: [(0, react_jsx_runtime.jsxs)("header", {
						className: "devflow-flow-secondaryhead",
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								onTabChange("flow");
							},
							children: "← 返回派发流画布"
						}), (0, react_jsx_runtime.jsx)("strong", { children: VIEW_LABELS[tab] })]
					}), (0, react_jsx_runtime.jsx)("div", {
						className: "devflow-flow-secondarybody",
						children: tab === "audit" ? auditPanel : toolsPanel
					})]
				}), tab === "flow" && (0, react_jsx_runtime.jsxs)("div", {
					className: "devflow-flow-canvas",
					role: "tabpanel",
					"data-inspector": inspectorMode,
					ref: hostRef,
					children: [(0, react_jsx_runtime.jsxs)("div", {
						className: "devflow-flow-viewport",
						"data-panning": panning,
						ref: bindViewport,
						onPointerDown: startPan,
						children: [
							(0, react_jsx_runtime.jsx)("div", {
								className: "devflow-flow-grid",
								"aria-hidden": "true"
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "devflow-flow-world",
								style: {
									width: flow.canvasWidth,
									height: flow.canvasHeight,
									transform: `translate(${Math.round(transform.x)}px, ${Math.round(transform.y)}px) scale(${transform.scale})`
								},
								children: [(0, react_jsx_runtime.jsxs)("svg", {
									className: "devflow-flow-edges",
									width: flow.canvasWidth,
									height: flow.canvasHeight,
									"aria-hidden": "true",
									children: [requirementEdge !== null && requirementEdge.path !== "" && (0, react_jsx_runtime.jsxs)("g", { children: [(0, react_jsx_runtime.jsx)("path", {
										className: "devflow-flow-edge",
										"data-edge-semantic": requirementEdge.semantic,
										"data-edge-id": requirementEdge.id,
										"data-edge-from": requirementEdge.from,
										"data-edge-to": requirementEdge.to,
										d: requirementEdge.path
									}), (0, react_jsx_runtime.jsx)("path", {
										className: "devflow-flow-arrow",
										"data-edge-semantic": requirementEdge.semantic,
										d: requirementEdge.arrowPath
									})] }, requirementEdge.id), edges.filter((edge) => edge.path !== "").map((edge) => {
										const motion = motionProfile(edge.state, paused);
										const fresh = freshDone.includes(edge.id);
										const rearmed = rearmedEdges.includes(edge.id);
										return (0, react_jsx_runtime.jsxs)("g", {
											"data-flow-rate": motionRate(motion),
											"data-highlight": isHighlighted(edge.taskId, edge.phaseId),
											"data-fresh": fresh ? "true" : "false",
											"data-rearmed": rearmed ? "true" : "false",
											style: { opacity: motion.opacity },
											children: [
												(0, react_jsx_runtime.jsx)("path", {
													className: "devflow-flow-edge",
													"data-edge-state": edge.state,
													"data-edge-semantic": edge.semantic,
													"data-edge-id": edge.id,
													"data-edge-from": edge.from,
													"data-edge-to": edge.to,
													"data-selected": edge.id === selection?.id,
													d: edge.path
												}),
												(0, react_jsx_runtime.jsx)("path", {
													className: "devflow-flow-arrow",
													"data-edge-semantic": edge.semantic,
													"data-arrow-state": edge.state,
													d: edge.arrowPath
												}),
												(0, react_jsx_runtime.jsx)("path", {
													className: "devflow-flow-flow",
													"data-flow-overlay": edge.id,
													style: motion.flowing ? { animationDuration: `${motion.durationSeconds}s` } : void 0,
													d: edge.path
												}, rearmed ? `${edge.id}:${rearmEpoch}` : edge.id),
												(0, react_jsx_runtime.jsx)("path", {
													className: "devflow-flow-sweep",
													"data-flow-sweep": edge.id,
													pathLength: 100,
													d: edge.path
												}),
												(0, react_jsx_runtime.jsx)("path", {
													className: "devflow-flow-edge-hit",
													"data-flow-edge": edge.id,
													"data-stale-reason": edge.handoff.statusLabel,
													d: edge.path,
													onClick: (event) => {
														event.stopPropagation();
														selectEdge(edge.id);
													}
												}),
												labelled(edge) && (0, react_jsx_runtime.jsx)("text", {
													className: "devflow-flow-edge-label",
													x: edge.labelX,
													y: edge.labelY,
													textAnchor: "middle",
													children: edge.badge
												})
											]
										}, edge.id);
									})]
								}), nodes.map((node) => (0, react_jsx_runtime.jsxs)("div", {
									ref: (element) => {
										if (element === null) boxRefs.current.delete(node.id);
										else boxRefs.current.set(node.id, element);
									},
									className: "devflow-flow-card",
									"data-flow-node": node.id,
									"data-kind": node.kind,
									"data-state": node.state,
									"data-enter": enteringNodes.includes(node.id) ? "true" : "false",
									"data-selected": selectedNode?.id === node.id,
									"data-highlight": isHighlighted(node.taskId, null),
									"data-card-h": heightOf(node.id),
									style: {
										left: node.x,
										top: node.y,
										width: node.kind === "requirement" ? 208 : 172
									},
									onPointerDown: (event) => {
										startNodeDrag(node.id, event);
									},
									children: [
										(0, react_jsx_runtime.jsxs)("p", {
											className: "devflow-flow-name",
											children: [
												node.label,
												node.kind === "requirement" && (0, react_jsx_runtime.jsx)("span", {
													className: "devflow-flow-tag user",
													children: node.sourceLabel
												}),
												node.kind === "temporary" && (0, react_jsx_runtime.jsx)("span", {
													className: "devflow-flow-tag subagent",
													children: "子代理"
												})
											]
										}),
										(0, react_jsx_runtime.jsx)("p", {
											className: "devflow-flow-sub",
											children: nodeSubtitle(node)
										}),
										node.taskTitle !== null && (0, react_jsx_runtime.jsx)("p", {
											className: "devflow-flow-task",
											children: node.taskTitle
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: `devflow-flow-badge ${NODE_STATE_CLASS[node.state]}`,
											children: node.stateLabel
										})
									]
								}, node.id))]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "devflow-flow-float devflow-flow-info",
								"data-freshness": phase,
								"data-connection": connection?.phase ?? "off",
								"data-skin": skin,
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										className: "devflow-flow-identrow",
										children: [
											(0, react_jsx_runtime.jsx)("span", {
												className: "devflow-flow-ident devflow-freshness",
												"data-freshness": phase,
												"data-connection": connection?.phase ?? "off",
												"data-project-workspace": workspacePath ?? "none",
												title: workspacePath === null ? session.id : `${session.id} · ${workspacePath}`,
												children: identityLine
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "devflow-flow-skin",
												"data-skin": skin,
												"aria-label": FLOW_SKIN_LABELS[skin].label,
												title: `${FLOW_SKIN_LABELS[skin].label} · ${FLOW_SKIN_LABELS[skin].hint}`,
												onClick: toggleSkin,
												children: (0, react_jsx_runtime.jsx)("span", {
													className: "devflow-flow-skinicon",
													"data-shape": skin === "light" ? "moon" : "ring",
													"aria-hidden": "true"
												})
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "devflow-flow-skin",
												"data-role": "overview-reopen",
												"aria-label": "重新打开右上角概览浮层",
												title: "重新打开右上角概览浮层",
												onClick: () => {
													onReopenOverview === void 0 ? window.dispatchEvent(new Event("devflow:overview-reopen")) : onReopenOverview();
												},
												children: (0, react_jsx_runtime.jsx)("span", {
													className: "devflow-flow-overviewicon",
													"aria-hidden": "true"
												})
											})
										]
									}),
									connection?.phase === "polling" && (0, react_jsx_runtime.jsxs)("span", {
										className: "devflow-flow-channel",
										"data-connection": "polling",
										role: "status",
										children: [connection.detail ?? "实时连接已断开，正在使用轮询", "（画布仍在每 5 秒拉取快照，重连成功后自动恢复实时更新）"]
									}),
									connection?.phase === "connecting" && (0, react_jsx_runtime.jsx)("span", {
										className: "devflow-flow-channel",
										"data-connection": "connecting",
										role: "status",
										children: "正在建立实时通道…（当前按 5 秒轮询快照）"
									}),
									(0, react_jsx_runtime.jsxs)("span", {
										className: "devflow-flow-zoomchip",
										children: [
											"缩放 ",
											Math.round(transform.scale * 100),
											"%"
										]
									})
								]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "devflow-flow-float devflow-flow-bottomstack",
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										className: "devflow-flow-bottom",
										children: [(0, react_jsx_runtime.jsxs)("span", {
											className: "devflow-flow-hint",
											children: ["拖动空白处平移 · 滚轮缩放 · 拖动卡片 · 点卡片看详情 · ", (0, react_jsx_runtime.jsx)("b", { children: "点连线看这次派发的任务" })]
										}), (0, react_jsx_runtime.jsxs)("span", {
											className: "devflow-flow-notices",
											children: [
												notice !== null && notice !== void 0 && (0, react_jsx_runtime.jsx)("span", {
													role: "status",
													children: notice
												}),
												flow.visibleAgentIds.length === 0 && (0, react_jsx_runtime.jsx)("span", {
													role: "status",
													children: "画布初始只有总指挥：用到谁才会被调用下来并连线。"
												}),
												flow.visibleAgentIds.length > WIDE_ROW_LIMIT && (0, react_jsx_runtime.jsxs)("span", {
													role: "status",
													children: [
														"同层 ",
														flow.visibleAgentIds.length,
														" 位员工落在同一行，画布会变宽；这是数据侧密度问题，不是连线问题。"
													]
												}),
												flow.lostCount > 0 && (0, react_jsx_runtime.jsxs)("span", {
													role: "status",
													children: [
														"其中 ",
														flow.lostCount,
														" 条派发没有正在运行的执行记录，已按「未收尾 · 已失联」标出（历史数据未清理）"
													]
												}),
												flow.unroutedCount > 0 && (0, react_jsx_runtime.jsxs)("span", {
													role: "status",
													children: [
														"另有 ",
														flow.unroutedCount,
														" 条派发的员工不在当前快照，无法落点（不画悬空连线）"
													]
												}),
												flow.history.edges.length > flow.current.edges.length && (0, react_jsx_runtime.jsx)("span", {
													role: "status",
													children: showHistory ? `正在显示全部 ${flow.history.edges.length} 条历史派发边（每次交接各自一条，未合并）` : `已隐藏 ${flow.history.edges.length - flow.current.edges.length} 条历史派发边（工具栏 ⇥ 全部历史可展开）`
												})
											]
										})]
									}),
									(0, react_jsx_runtime.jsxs)("span", {
										className: "devflow-flow-legend",
										"aria-label": "连线图例",
										children: [
											(0, react_jsx_runtime.jsx)("span", {
												className: "devflow-flow-legendgroup",
												"data-legend-group": "semantic",
												children: SEMANTIC_ORDER.map((semantic) => (0, react_jsx_runtime.jsxs)("span", {
													"data-legend-kind": "semantic",
													"data-semantic": semantic,
													title: `关系：${FLOW_SEMANTIC_LABELS[semantic]}（${SEMANTIC_SHAPE[semantic]}）`,
													children: [(0, react_jsx_runtime.jsx)("i", {
														className: `devflow-flow-line is-${semantic}`,
														"aria-hidden": "true"
													}), FLOW_SEMANTIC_LABELS[semantic]]
												}, semantic))
											}),
											(0, react_jsx_runtime.jsx)("span", {
												className: "devflow-flow-legendgroup",
												"data-legend-group": "state",
												children: EDGE_STATES.map((value) => (0, react_jsx_runtime.jsxs)("span", {
													"data-legend-kind": "state",
													"data-state": value,
													children: [(0, react_jsx_runtime.jsx)("i", {
														className: `devflow-flow-swatch is-${value}`,
														"aria-hidden": "true"
													}), EDGE_STATE_TEXT[value]]
												}, value))
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "devflow-flow-legendtoggle",
												"aria-expanded": legendOpen,
												onClick: () => {
													setLegendOpen((open) => !open);
												},
												children: legendOpen ? "收起图例" : "图例说明"
											})
										]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: "devflow-flow-bottomrow",
										children: [
											(0, react_jsx_runtime.jsxs)("span", {
												className: "devflow-flow-concurrency",
												"data-at-limit": flow.concurrency.atLimit,
												role: "status",
												"aria-label": `并发上限 ${flow.concurrency.running}/${flow.concurrency.limit}`,
												title: `同时最多 ${flow.concurrency.limit} 个派发在执行；达到上限后新的派发排队等待，不会丢`,
												children: [(0, react_jsx_runtime.jsxs)("b", { children: [
													"并发 ",
													flow.concurrency.running,
													"/",
													flow.concurrency.limit
												] }), flow.concurrency.atLimit && (0, react_jsx_runtime.jsx)("span", {
													className: "devflow-flow-concurrencynote",
													children: "已达并发上限 · 后续排队"
												})]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "devflow-flow-roster",
												"data-open": rosterOpen,
												children: [(0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: "devflow-flow-rosterhead",
													"aria-expanded": rosterOpen,
													onClick: () => {
														setRosterOpen((open) => !open);
													},
													children: [
														(0, react_jsx_runtime.jsx)("span", {
															className: "devflow-flow-rosterkicker",
															children: "员工名册"
														}),
														(0, react_jsx_runtime.jsxs)("strong", { children: [
															"固定员工 · ",
															roster.length,
															" 人 / 临时子代理 · ",
															temporaryRoster.length,
															" 人"
														] }),
														(0, react_jsx_runtime.jsx)("span", {
															className: "devflow-flow-rosterhint",
															children: rosterOpen ? "收起" : "展开"
														})
													]
												}), rosterOpen && (0, react_jsx_runtime.jsxs)("div", {
													className: "devflow-flow-rosterbody",
													children: [
														roster.map((item) => (0, react_jsx_runtime.jsxs)("div", {
															className: "devflow-flow-pcard",
															"data-open": rosterCards.includes(item.agent.id),
															children: [(0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: "devflow-flow-pcardbutton",
																onClick: () => {
																	toggleRosterCard(item.agent.id);
																},
																children: [
																	(0, react_jsx_runtime.jsx)("strong", { children: flowAgentName(item.agent.id, item.agent.displayName) }),
																	runningIds.has(item.agent.id) && (0, react_jsx_runtime.jsx)("span", {
																		className: "devflow-flow-tag live",
																		children: "运行中"
																	}),
																	item.agent.id !== flow.commanderId && (item.agent.skills ?? []).length === 0 && (0, react_jsx_runtime.jsx)("span", {
																		className: "devflow-flow-tag",
																		children: "暂未绑定"
																	}),
																	(0, react_jsx_runtime.jsx)("small", { children: rosterCountLabel(item.agent.id, item.executions.filter((execution) => execution.status === "completed").length) })
																]
															}), rosterCards.includes(item.agent.id) && (0, react_jsx_runtime.jsxs)("div", {
																className: "devflow-flow-pdet",
																children: [
																	(0, react_jsx_runtime.jsxs)("p", { children: ["技能：", rosterSkillsLabel(item.agent.id, item.agent.skills)] }),
																	(0, react_jsx_runtime.jsxs)("p", { children: ["能力：", rosterCapabilitiesLabel(item.agent.id, item.agent.capabilities)] }),
																	(0, react_jsx_runtime.jsxs)("p", { children: ["模型：", item.agent.provider === void 0 ? item.agent.model : `${item.agent.provider} · ${item.agent.model}`] }),
																	(0, react_jsx_runtime.jsx)("p", { children: rosterDelegationLabel(item.agent.id, item.agent.delegationDepth) }),
																	(0, react_jsx_runtime.jsxs)("p", { children: ["状态：", agentWorkStateLabel(item.workState)] })
																]
															})]
														}, item.agent.id)),
														(0, react_jsx_runtime.jsxs)("div", {
															className: "devflow-flow-rostergroup",
															children: [(0, react_jsx_runtime.jsxs)("strong", { children: [
																"临时子代理 · ",
																temporaryRoster.length,
																" 人"
															] }), temporaryRoster.length === 0 ? (0, react_jsx_runtime.jsx)("small", { children: "本次会话尚未创建临时子代理（只能由总指挥现场创建 · 1–2 层）。" }) : temporaryRoster.map((item) => (0, react_jsx_runtime.jsxs)("div", {
																className: "devflow-flow-pcard",
																"data-open": rosterCards.includes(item.agent.id),
																children: [(0, react_jsx_runtime.jsxs)("button", {
																	type: "button",
																	className: "devflow-flow-pcardbutton",
																	onClick: () => {
																		toggleRosterCard(item.agent.id);
																	},
																	children: [
																		(0, react_jsx_runtime.jsx)("strong", { children: flowAgentName(item.agent.id, item.agent.displayName) }),
																		(0, react_jsx_runtime.jsx)("span", {
																			className: "devflow-flow-tag",
																			children: "临时子代理"
																		}),
																		runningIds.has(item.agent.id) && (0, react_jsx_runtime.jsx)("span", {
																			className: "devflow-flow-tag live",
																			children: "运行中"
																		}),
																		(0, react_jsx_runtime.jsx)("small", { children: rosterCountLabel(item.agent.id, item.executions.filter((execution) => execution.status === "completed").length) })
																	]
																}), rosterCards.includes(item.agent.id) && (0, react_jsx_runtime.jsxs)("div", {
																	className: "devflow-flow-pdet",
																	children: [
																		(0, react_jsx_runtime.jsxs)("p", { children: ["技能：", rosterSkillsLabel(item.agent.id, item.agent.skills)] }),
																		(0, react_jsx_runtime.jsxs)("p", { children: ["能力：", rosterCapabilitiesLabel(item.agent.id, item.agent.capabilities)] }),
																		(0, react_jsx_runtime.jsxs)("p", { children: ["模型：", item.agent.provider === void 0 ? item.agent.model : `${item.agent.provider} · ${item.agent.model}`] }),
																		(0, react_jsx_runtime.jsx)("p", { children: rosterDelegationLabel(item.agent.id, item.agent.delegationDepth) }),
																		(0, react_jsx_runtime.jsxs)("p", { children: ["状态：", agentWorkStateLabel(item.workState)] })
																	]
																})]
															}, item.agent.id))]
														}),
														(0, react_jsx_runtime.jsxs)("div", {
															className: "devflow-flow-pcard",
															"data-plan": "true",
															children: [
																(0, react_jsx_runtime.jsxs)("strong", { children: ["临时子代理 ", (0, react_jsx_runtime.jsx)("span", {
																	className: "devflow-flow-tag live",
																	children: temporaryRoster.length > 0 ? `已启用 · ${temporaryRoster.length} 人` : "设计目标"
																})] }),
																(0, react_jsx_runtime.jsx)("small", { children: "只能由总指挥现场创建 · 1–2 层" }),
																(0, react_jsx_runtime.jsxs)("div", {
																	className: "devflow-flow-pdet",
																	children: [(0, react_jsx_runtime.jsxs)("p", { children: [
																		"创建者是总指挥（固定员工 ",
																		(0, react_jsx_runtime.jsx)("code", { children: "delegationDepth = 0" }),
																		"，没有委派能力）。"
																	] }), (0, react_jsx_runtime.jsxs)("p", { children: [
																		"临时子代理由总指挥现场创建并派发；其生命周期状态（运行中 / 已终止）尚未与面板联动，节点状态暂按执行记录推导。当前快照有 ",
																		temporaryRoster.length,
																		" 个临时 Agent 记录。"
																	] })]
																})
															]
														})
													]
												})]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "devflow-flow-toolbar",
												children: [
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "devflow-flow-action",
														"data-primary": "true",
														title: "适配视图（重置缩放并平移到全部节点可见）",
														"aria-label": "适配视图",
														onClick: () => {
															fit();
														},
														children: "⤢"
													}),
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "devflow-flow-action",
														title: "放大",
														"aria-label": "放大",
														onClick: () => {
															zoomBy(.15);
														},
														children: "＋"
													}),
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "devflow-flow-action",
														title: "缩小",
														"aria-label": "缩小",
														onClick: () => {
															zoomBy(-.15);
														},
														children: "－"
													}),
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "devflow-flow-action",
														"data-primary": showHistory,
														"aria-pressed": showHistory,
														title: showHistory ? "只看当前链路" : "显示全部历史链路",
														"aria-label": showHistory ? "只看当前链路" : "全部历史链路",
														onClick: () => {
															setShowHistory((value) => !value);
															window.requestAnimationFrame(() => {
																fit();
															});
														},
														children: showHistory ? "⇤ 当前链路" : "⇥ 全部历史"
													}),
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "devflow-flow-action",
														title: "重置布局（回到自动布局并恢复自动适配）",
														"aria-label": "重置布局",
														onClick: resetLayout,
														children: "⟳ 重置布局"
													}),
													(0, react_jsx_runtime.jsx)("span", {
														className: "devflow-flow-viewswitch",
														children: ["audit", "tools"].map((view) => (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: "devflow-flow-action",
															onClick: () => {
																onTabChange(view);
															},
															children: VIEW_LABELS[view]
														}, view))
													})
												]
											})
										]
									})
								]
							}),
							legendOpen && (0, react_jsx_runtime.jsxs)("section", {
								className: "devflow-flow-float devflow-flow-legendpanel",
								"aria-label": "图例说明",
								children: [
									(0, react_jsx_runtime.jsx)("h3", { children: "关系（看线型与箭头方向）" }),
									(0, react_jsx_runtime.jsx)("ul", { children: SEMANTIC_ORDER.map((semantic) => (0, react_jsx_runtime.jsxs)("li", { children: [(0, react_jsx_runtime.jsx)("i", {
										className: `devflow-flow-line is-${semantic}`,
										"aria-hidden": "true"
									}), semanticLine(semantic)] }, semantic)) }),
									(0, react_jsx_runtime.jsx)("h3", { children: "状态（只看颜色）" }),
									(0, react_jsx_runtime.jsx)("ul", { children: EDGE_STATES.map((value) => (0, react_jsx_runtime.jsxs)("li", { children: [(0, react_jsx_runtime.jsx)("i", {
										className: `devflow-flow-swatch is-${value}`,
										"aria-hidden": "true"
									}), EDGE_STATE_TEXT[value]] }, value)) }),
									(0, react_jsx_runtime.jsx)("p", {
										className: "devflow-flow-legendnote",
										children: "阶段关联带按阶段把同阶段的派发分组显示；每一次交接都各自成边，不做合并。"
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "devflow-flow-xferclose",
										onClick: () => {
											setLegendOpen(false);
										},
										children: "收起"
									})
								]
							}),
							flow.concurrency.running > 1 && (0, react_jsx_runtime.jsxs)("p", {
								className: "devflow-flow-float devflow-flow-note",
								role: "status",
								children: [
									"快照中有 ",
									flow.concurrency.running,
									" 条执行记录正在运行，画布如实把每一条都标为「执行中」。同轮派发彼此独立、同时推进；同时最多 ",
									flow.concurrency.limit,
									" 条，达到上限后新的派发按「排队中」等待，不会悄悄延后。"
								]
							})
						]
					}), selection !== null && (0, react_jsx_runtime.jsx)(FlowInspector, {
						mode: docked ? "dock" : "drawer",
						flow,
						edges,
						node: selectedNode,
						edge: selectedEdge,
						band: selectedBand,
						highlight,
						onClose: () => {
							setSelection(null);
							setHighlight(null);
						},
						onSelectNode: selectNode,
						onSelectEdge: selectEdge,
						onSelectBand: (bandId) => {
							setSelection({
								kind: "phase",
								id: bandId
							});
							setHighlight({
								kind: "phase",
								id: bandId
							});
						},
						onHighlightTask: (taskId) => {
							setHighlight((current) => current?.kind === "task" && current.id === taskId ? null : {
								kind: "task",
								id: taskId
							});
						}
					})]
				})]
			});
		}
		/**
		* The canvas' right-hand inspector: one panel for node detail, dispatch handoff
		* detail and 阶段关联 — exactly one of them at a time.
		*
		* Correction R2 moved EVERY phase visual here: the canvas no longer draws a box,
		* a name, a count badge or a rail for 阶段关联, so this list is the only place
		* phase association is shown.
		*
		* Exported so the panel's content can be rendered and asserted directly, without
		* driving the canvas' pointer interactions.
		*/
		function FlowInspector(props) {
			const { mode, flow, edges, node, edge, band, highlight, onClose, onSelectNode: _onSelectNode, onSelectEdge, onSelectBand, onHighlightTask } = props;
			const title = node !== null ? node.label : edge !== null ? edge.handoff.title : band !== null ? band.name : "详情";
			const kicker = node !== null ? "节点详情" : edge !== null ? "交接详情" : "阶段关联";
			const relatedEdges = node === null ? [] : edges.filter((item) => item.from === node.id || item.to === node.id);
			const bandEdges = band === null ? [] : edges.filter((item) => item.phaseId === band.id);
			return (0, react_jsx_runtime.jsxs)("aside", {
				className: "devflow-flow-inspector",
				"data-mode": mode,
				"aria-label": kicker,
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: "devflow-flow-inspectorhead",
						children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("p", {
							className: "devflow-kicker",
							children: kicker
						}), (0, react_jsx_runtime.jsx)("h3", { children: title })] }), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "devflow-flow-inspectorclose",
							"aria-label": "关闭详情",
							onClick: onClose,
							children: "✕"
						})]
					}),
					node !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						(0, react_jsx_runtime.jsxs)("dl", {
							className: "devflow-flow-table",
							children: [
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "角色 / id" }), (0, react_jsx_runtime.jsxs)("dd", { children: [
									node.roleLabel,
									" · ",
									node.id
								] })] }),
								node.sourceLabel !== null && (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "来源" }), (0, react_jsx_runtime.jsxs)("dd", { children: [node.sourceLabel, "（只读状态节点）"] })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "委派深度" }), (0, react_jsx_runtime.jsx)("dd", { children: node.delegationLabel })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "子代理" }), (0, react_jsx_runtime.jsx)("dd", { children: node.subagentNote })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "能力" }), (0, react_jsx_runtime.jsx)("dd", { children: node.capabilitiesLabel })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "模型" }), (0, react_jsx_runtime.jsx)("dd", { children: node.modelLabel === "" ? "不适用" : node.modelLabel })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "绑定技能" }), (0, react_jsx_runtime.jsx)("dd", { children: node.skillsLabel })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "已交付" }), (0, react_jsx_runtime.jsxs)("dd", { children: [node.deliveryCount, " 次"] })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "状态" }), (0, react_jsx_runtime.jsxs)("dd", { children: [node.stateLabel, node.taskStateLabel === null ? "" : ` · ${node.taskStateLabel}`] })] }),
								node.executionLabel !== null && (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "执行" }), (0, react_jsx_runtime.jsx)("dd", { children: node.executionLabel })] })
							]
						}),
						(0, react_jsx_runtime.jsx)("h4", {
							className: "devflow-flow-inspectorsection",
							children: node.kind === "requirement" ? "需求全文" : "当前任务"
						}),
						node.taskTitle === null ? (0, react_jsx_runtime.jsx)("p", {
							className: "devflow-flow-mutedline",
							children: "当前没有关联的派发任务。"
						}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							(0, react_jsx_runtime.jsxs)("p", {
								className: "devflow-flow-inspectortask",
								children: [node.taskTitle, node.taskId === null ? "" : `（${shortId(node.taskId, 14)}）`]
							}),
							node.taskDescription !== null && (0, react_jsx_runtime.jsx)("p", {
								className: "devflow-flow-xferdetail",
								children: node.taskDescription
							}),
							node.kind === "requirement" && (0, react_jsx_runtime.jsx)("p", {
								className: "devflow-flow-mutedline",
								children: "用户需求节点不承载派发任务，只承载需求全文与来源。"
							})
						] }),
						(0, react_jsx_runtime.jsxs)("h4", {
							className: "devflow-flow-inspectorsection",
							children: [
								"相关边（",
								relatedEdges.length,
								"）"
							]
						}),
						relatedEdges.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
							className: "devflow-flow-mutedline",
							children: "该节点当前没有画出的边。"
						}) : (0, react_jsx_runtime.jsx)("ul", {
							className: "devflow-flow-inspectorlist",
							children: relatedEdges.map((item) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								"data-inspector-edge": item.id,
								onClick: () => {
									onSelectEdge(item.id);
								},
								children: [
									(0, react_jsx_runtime.jsx)("i", {
										className: `devflow-flow-line is-${item.semantic}`,
										"aria-hidden": "true"
									}),
									(0, react_jsx_runtime.jsxs)("span", {
										className: "devflow-flow-inspectorlinetitle",
										children: [
											FLOW_SEMANTIC_LABELS[item.semantic],
											" · ",
											item.fromLabel,
											" → ",
											item.toLabel
										]
									}),
									(0, react_jsx_runtime.jsx)("small", { children: item.badge })
								]
							}) }, item.id))
						})
					] }),
					edge !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("dl", {
						className: "devflow-flow-table",
						children: [
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "关系" }), (0, react_jsx_runtime.jsxs)("dd", { children: [
								FLOW_SEMANTIC_LABELS[edge.semantic],
								"（",
								edge.semantic === "delivery" ? "员工 → 总指挥" : "总指挥 → 员工",
								"）"
							] })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "taskId" }), (0, react_jsx_runtime.jsx)("dd", { children: edge.handoff.taskId ?? "未记录" })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: edge.handoff.acceptance.label }), (0, react_jsx_runtime.jsxs)("dd", { children: [edge.handoff.acceptance.value, edge.handoff.acceptance.truncated ? "（已截断）" : ""] })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "交接双方" }), (0, react_jsx_runtime.jsxs)("dd", { children: [
								edge.handoff.fromLabel,
								" → ",
								edge.handoff.toLabel
							] })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "状态" }), (0, react_jsx_runtime.jsx)("dd", { children: edge.handoff.statusLabel })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "时间" }), (0, react_jsx_runtime.jsx)("dd", { children: edge.handoff.at ?? "未记录" })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "返工次数" }), (0, react_jsx_runtime.jsx)("dd", { children: edge.handoff.retryCount })] })
						]
					}), edge.handoff.detail !== null && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-flow-xferdetail",
						children: edge.handoff.detail
					})] }),
					band !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						(0, react_jsx_runtime.jsxs)("dl", {
							className: "devflow-flow-table",
							children: [
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "阶段" }), (0, react_jsx_runtime.jsx)("dd", { children: band.name })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "状态" }), (0, react_jsx_runtime.jsx)("dd", { children: band.statusLabel })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "任务数 / 派发数" }), (0, react_jsx_runtime.jsxs)("dd", { children: [
									band.taskCount,
									" / ",
									band.dispatchCount
								] })] })
							]
						}),
						(0, react_jsx_runtime.jsxs)("h4", {
							className: "devflow-flow-inspectorsection",
							children: [
								"该阶段的任务（",
								band.tasks.length,
								"）"
							]
						}),
						band.tasks.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
							className: "devflow-flow-mutedline",
							children: "该阶段当前没有关联任务。"
						}) : (0, react_jsx_runtime.jsx)("ul", {
							className: "devflow-flow-inspectorlist",
							children: band.tasks.map((task) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								"data-inspector-task": task.id,
								"data-highlight": highlight?.kind === "task" && highlight.id === task.id,
								onClick: () => {
									onHighlightTask(task.id);
								},
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "devflow-flow-inspectorlinetitle",
									children: task.title
								}), (0, react_jsx_runtime.jsx)("small", { children: task.stateLabel })]
							}) }, task.id))
						}),
						(0, react_jsx_runtime.jsxs)("h4", {
							className: "devflow-flow-inspectorsection",
							children: [
								"该阶段的派发（",
								bandEdges.length,
								"）"
							]
						}),
						bandEdges.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
							className: "devflow-flow-mutedline",
							children: "该阶段当前没有画出的派发边（默认视图只画每位员工的当前链路）。"
						}) : (0, react_jsx_runtime.jsx)("ul", {
							className: "devflow-flow-inspectorlist",
							children: bandEdges.map((item) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								"data-inspector-edge": item.id,
								onClick: () => {
									onSelectEdge(item.id);
								},
								children: [
									(0, react_jsx_runtime.jsx)("i", {
										className: `devflow-flow-line is-${item.semantic}`,
										"aria-hidden": "true"
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: "devflow-flow-inspectorlinetitle",
										children: item.taskLabel
									}),
									(0, react_jsx_runtime.jsx)("small", { children: item.badge })
								]
							}) }, item.id))
						}),
						(0, react_jsx_runtime.jsx)("p", {
							className: "devflow-flow-mutedline",
							children: "画布上不再画任何阶段元素；阶段关联只在这里列出。点一项即高亮画布上对应的节点与边。"
						})
					] }),
					band === null && (0, react_jsx_runtime.jsxs)("h4", {
						className: "devflow-flow-inspectorsection",
						children: [
							"阶段关联（",
							flow.bands.length,
							"）"
						]
					}),
					band === null && (0, react_jsx_runtime.jsx)("ul", {
						className: "devflow-flow-inspectorlist",
						children: flow.bands.map((item) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							"data-inspector-band": item.id,
							"data-highlight": highlight?.kind === "phase" && highlight.id === item.id,
							title: `${item.name} · ${item.statusLabel} · 任务 ${item.taskCount} · 派发 ${item.dispatchCount}`,
							onClick: () => {
								onSelectBand(item.id);
							},
							children: [
								(0, react_jsx_runtime.jsx)("i", {
									className: "devflow-flow-banddot",
									"data-status": item.status,
									"aria-hidden": "true"
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: "devflow-flow-inspectorlinetitle",
									children: item.name
								}),
								(0, react_jsx_runtime.jsxs)("small", { children: [
									item.statusLabel,
									" · ",
									item.taskCount,
									"/",
									item.dispatchCount
								] })
							]
						}) }, item.id))
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "devflow-flow-xferclose",
						onClick: onClose,
						children: "关闭"
					})
				]
			});
		}
		function semanticLine(semantic) {
			if (semantic === "requirement") return "需求下达：用户需求 → 总指挥（只读来源）";
			if (semantic === "dispatch") return "派发：总指挥 → 员工 / 审计（箭头指向接收方）";
			if (semantic === "delivery") return "交付 · 汇报：员工 / 审计 → 总指挥（箭头指回总指挥）";
			if (semantic === "rework") return "返工：总指挥 → 原员工（同一任务的再次派发，边上标注返工次数）";
			return "子代理创建 / 回传：总指挥 ↔ 临时子代理（总指挥现场创建后即由本面板呈现）";
		}
		function agentWorkStateLabel(state) {
			if (state === "working") return "工作中";
			if (state === "blocked") return "等待决策";
			if (state === "done") return "已完成作业";
			if (state === "idle") return "空闲";
			if (state === "archived") return "已归档";
			return "未知";
		}
		function freshnessLine(phase, generatedAt) {
			if (phase === "refreshing") return `更新中…（上次 ${clock(generatedAt)}）`;
			if (phase === "error") return `上次成功 ${clock(generatedAt)}`;
			return `更新 ${clock(generatedAt)}`;
		}
		/**
		* Name the data path the panel is actually on. This is an honesty line, not a
		* decoration: while the channel is down the panel says so instead of letting the
		* 5-second polling pass as realtime.
		*/
		function channelLine(connection) {
			if (connection === null) return "实时通道未启用 · 轮询快照";
			if (connection.phase === "live") return `实时通道已连接${connection.sequence === null ? "" : ` · 游标 #${connection.sequence}`}`;
			if (connection.phase === "connecting") return "实时通道连接中 · 轮询快照";
			return "实时通道已断开 · 轮询兜底";
		}
		function clock(at) {
			const parsed = Date.parse(at);
			if (Number.isNaN(parsed)) return at;
			return new Date(parsed).toLocaleTimeString("zh-CN", { hour12: false });
		}
		function nodeSubtitle(node) {
			if (node.kind === "requirement") return "用户需求 · 只读状态节点";
			if (node.kind === "commander") return "拆解 · 派发 · 组织审计 · 验收";
			if (node.kind === "temporary") return "临时子代理 · 由总指挥现场创建";
			return `固定员工 · 已交付 ${node.deliveryCount} 次`;
		}
		function rosterSkillsLabel(agentId, skills) {
			if (agentId === "commander") return "不适用（总指挥不写代码）";
			if (skills === void 0 || skills.length === 0) return "暂未绑定";
			return skills.join("、");
		}
		function rosterCapabilitiesLabel(agentId, capabilities) {
			if (agentId === "commander") return "需求分析、任务拆解、派发、验收";
			if (capabilities === void 0 || capabilities.length === 0) return "未记录";
			return capabilities.join("、");
		}
		function rosterDelegationLabel(agentId, depth) {
			const value = depth ?? 0;
			if (agentId === "commander") return `委派深度 ${value}：可以现场创建临时子代理（生命周期状态尚未与面板联动）`;
			if (value <= 0) return `委派深度 ${value}：不能再派子代理`;
			return `委派深度 ${value}：可继续派子代理`;
		}
		function rosterCountLabel(agentId, count) {
			if (agentId === "commander") return `已派出 ${count} 次执行`;
			if (agentId === "code-auditor") return `已复核 ${count} 次`;
			return `已交付 ${count} 次`;
		}
		function seedPositions(flow) {
			const positions = {};
			for (const node of flow.nodes) positions[node.id] = {
				x: node.x,
				y: node.y
			};
			return positions;
		}
		/** `localStorage` access that never throws (private mode, disabled storage). */
		function safeStorage$1() {
			try {
				return typeof window === "undefined" ? null : window.localStorage;
			} catch {
				return null;
			}
		}
		function clamp(value, minimum, maximum) {
			if (minimum > maximum) return (minimum + maximum) / 2;
			return Math.min(maximum, Math.max(minimum, value));
		}
		/**
		* `true` when at least one flow layer inside `root` is actually animating right now.
		*
		* The selector is the MOTION, not the state: an element hidden by CSS still carries
		* `data-flow-rate`, so the class list alone would keep the glass degraded forever.
		* A 25-element scan at {@link SAMPLE_MS} cadence is a bounded, cheap read that never
		* touches layout (`getComputedStyle(...).animationName` only re-resolves style).
		*/
		function motionRunning(root) {
			for (const group of root.querySelectorAll("g[data-flow-rate]")) {
				const rate = group.getAttribute("data-flow-rate");
				if (rate !== "base" && rate !== "strong" && rate !== "weak") continue;
				const layer = group.querySelector(".devflow-flow-flow");
				if (layer === null) continue;
				if (window.getComputedStyle(layer).animationName !== "none") return true;
			}
			return false;
		}
		/**
		* §11.1: publish the glass-vs-motion posture on the canvas root.
		*
		* Sampling is one `requestAnimationFrame` loop plus a {@link SAMPLE_MS} DOM read; it
		* neither renders nor notifies React, so a refresh cannot be triggered by the guard
		* itself. A manual `?devflow-glass=solid|glass` override short-circuits the automatic
		* rules so a reviewer can hold either path in a real browser.
		*/
		function useGlassMotionBudget(root) {
			(0, react.useEffect)(() => {
				const element = root.current;
				if (element === null || typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
				const override = readGlassOverride(window.location.search);
				const budget = new MotionBudget();
				let frame = 0;
				let timer = null;
				let gaps = [];
				let lastFrame = 0;
				let lastMotionAt = 0;
				let stopped = false;
				const publish = (decision) => {
					const next = override === "degrade" ? "degrade" : override === "glass" ? "auto" : decision.budget;
					const motion = override === "degrade" ? "degraded" : override === "glass" ? "idle" : decision.motion;
					if (element.dataset.glassBudget !== next) element.dataset.glassBudget = next;
					if (element.dataset.motion !== motion) element.dataset.motion = motion;
					element.dataset.glassOverride = override;
				};
				const read = () => {
					const running = motionRunning(element);
					const now = window.performance.now();
					if (running) lastMotionAt = now;
					const active = running || now - lastMotionAt < 1200;
					publish(budget.sample({
						animating: active,
						meanFrameMs: meanFrameMs(gaps) ?? NaN
					}));
					gaps = [];
				};
				const tick = (now) => {
					if (stopped) return;
					if (lastFrame !== 0) gaps.push(now - lastFrame);
					lastFrame = now;
					frame = window.requestAnimationFrame(tick);
				};
				const start = () => {
					if (stopped || timer !== null) return;
					lastFrame = 0;
					gaps = [];
					frame = window.requestAnimationFrame(tick);
					timer = window.setInterval(read, 250);
					read();
				};
				const stop = () => {
					if (timer === null) return;
					window.clearInterval(timer);
					timer = null;
					if (frame !== 0) {
						window.cancelAnimationFrame(frame);
						frame = 0;
					}
					lastMotionAt = 0;
					gaps = [];
				};
				const onVisibility = () => {
					if (document.visibilityState === "hidden") stop();
					else start();
				};
				if (document.visibilityState !== "hidden") start();
				else publish({
					budget: "auto",
					motion: "idle"
				});
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					stopped = true;
					document.removeEventListener("visibilitychange", onVisibility);
					stop();
				};
			}, []);
		}
		//#endregion
		//#region lib/client/tool-activity.js
		const MAX_ITEMS = 20;
		const MAX_SAFE_STATE_BYTES = 32768;
		const MAX_ID_LENGTH = 128;
		const MAX_TOOL_NAME_LENGTH = 128;
		const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
		const SOURCE = "harness-official-tool";
		const WINDOW = "current-loaded-window";
		const UNKNOWN_RELATION = { kind: "unknown" };
		function mapCurrentSessionTools(expectedSessionId, sources) {
			const { session, chat } = sources;
			if (!isSafeIdentifier(expectedSessionId)) return unavailableState();
			try {
				if (session.sessionId !== expectedSessionId || !isSafeIdentifier(String(session.sessionId))) return unavailableState();
				if (session.subagent !== null) return unavailableState();
				const read = readSafeItems(expectedSessionId, session, chat);
				if (read === null) return unavailableState();
				const { items, incompleteCount } = read;
				const hasMore = session.hasMore === true;
				if (read.storeUnavailable) return state("unavailable", items, hasMore, items.length > 0, incompleteCount);
				if (session.openState === "open") return state("ready", items, hasMore, false, incompleteCount);
				if (session.openState === "cold" || session.openState === "loading") return state("loading", items, hasMore, items.length > 0, incompleteCount);
				if (session.openState === "error") return state("unavailable", items, hasMore, items.length > 0, incompleteCount);
				return unavailableState();
			} catch {
				return unavailableState();
			}
		}
		function equalCurrentSessionToolsState(left, right) {
			if (left === right) return true;
			if (left.phase !== right.phase || left.hasMore !== right.hasMore || left.staleSafeItems !== right.staleSafeItems || left.incompleteCount !== right.incompleteCount || left.items.length !== right.items.length) return false;
			return left.items.every((item, index) => equalActivity(item, right.items[index]));
		}
		function readSafeItems(sessionId, session, chat) {
			const nodes = chat.nodes;
			if (nodes === null || typeof nodes !== "object" || typeof nodes.get !== "function") return null;
			const order = chat.order;
			if (!Array.isArray(order) || !order.every((key) => typeof key === "string")) return null;
			const items = [];
			let storeUnavailable = false;
			let incompleteCount = 0;
			for (const key of order) {
				let value;
				try {
					value = nodes.get(key);
				} catch {
					storeUnavailable = true;
					continue;
				}
				if (!isToolChatNode(value)) continue;
				try {
					if (isUnconfirmedToolNode(value, session)) {
						incompleteCount++;
						continue;
					}
					const candidate = mapToolNode(sessionId, value);
					if (candidate !== null) insertBounded(items, candidate);
				} catch {
					continue;
				}
			}
			return serializedStateSize(items, incompleteCount) <= MAX_SAFE_STATE_BYTES ? {
				items,
				storeUnavailable,
				incompleteCount
			} : null;
		}
		function isUnconfirmedToolNode(node, session) {
			const root = node.data.root;
			if ("kind" in root) return root.kind === "tool-result" && isFiniteFraction(root.seq);
			if (session.running !== true) return true;
			const location = node.location;
			if (location.kind === "step") return location.step.status !== "open" || location.turn.status !== "open";
			if (location.kind === "turn") return location.turn.status !== "open";
			return true;
		}
		function mapToolNode(sessionId, node) {
			const root = node.data.root;
			const callId = root.callId;
			if (!isSafeIdentifier(callId)) return null;
			if (!("kind" in root)) return mapRunning(sessionId, callId, node.anchorSeq, root);
			if (root.kind !== "tool-result") return null;
			return mapSettled(sessionId, callId, node.anchorSeq, root);
		}
		function mapRunning(sessionId, callId, anchorSeq, root) {
			const start = safeTime(root.time);
			return activity({
				sessionId,
				callId,
				toolName: safeToolName(root.name),
				status: "running",
				startedAt: start?.iso ?? null,
				endedAt: null,
				durationMs: null,
				startSeq: safeSequence(anchorSeq),
				resultSeq: null,
				resultSummary: "running"
			});
		}
		function mapSettled(sessionId, callId, anchorSeq, root) {
			if (typeof root.isError !== "boolean") return null;
			const resultSeq = safeSequence(root.seq);
			if (root.call === null) {
				if (resultSeq === null) return null;
				return activity({
					sessionId,
					callId,
					toolName: "Unknown tool",
					status: "result-without-call",
					startedAt: null,
					endedAt: safeTime(root.time)?.iso ?? null,
					durationMs: null,
					startSeq: null,
					resultSeq,
					resultSummary: "result received without visible call"
				});
			}
			const startSeq = safeSequence(anchorSeq);
			const start = safeTime(root.callTime);
			if (resultSeq === null) return null;
			if (startSeq !== null && resultSeq <= startSeq) return null;
			const end = safeTime(root.time);
			const failed = root.isError === true;
			return activity({
				sessionId,
				callId,
				toolName: safeToolName(root.call.name),
				status: failed ? "failed" : "succeeded",
				startedAt: start?.iso ?? null,
				endedAt: end?.iso ?? null,
				durationMs: start !== null && end !== null && end.epochMs >= start.epochMs ? end.epochMs - start.epochMs : null,
				startSeq,
				resultSeq,
				resultSummary: failed ? "failed" : "completed"
			});
		}
		function activity(input) {
			return {
				id: `${input.sessionId}:${input.callId}`,
				source: SOURCE,
				sessionId: input.sessionId,
				callId: input.callId,
				toolName: input.toolName,
				status: input.status,
				startedAt: input.startedAt,
				endedAt: input.endedAt,
				durationMs: input.durationMs,
				startSeq: input.startSeq,
				resultSeq: input.resultSeq,
				resultSummary: input.resultSummary,
				devflowRelation: UNKNOWN_RELATION
			};
		}
		function insertBounded(items, candidate) {
			const duplicateIndex = items.findIndex((item) => item.id === candidate.id);
			if (duplicateIndex >= 0) items[duplicateIndex] = preferredActivity(items[duplicateIndex], candidate);
			else if (items.length < MAX_ITEMS) items.push(candidate);
			else if (compareActivity(candidate, items[19]) < 0) items[19] = candidate;
			else return;
			items.sort(compareActivity);
			if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
		}
		function preferredActivity(left, right) {
			const leftRank = evidenceRank(left.status);
			const rightRank = evidenceRank(right.status);
			if (leftRank !== rightRank) return leftRank > rightRank ? left : right;
			const leftSeq = sortSequence(left);
			const rightSeq = sortSequence(right);
			if (leftSeq !== rightSeq) return leftSeq > rightSeq ? left : right;
			if (left.status !== right.status && (left.status === "failed" || right.status === "failed")) return left.status === "failed" ? left : right;
			return compareCodeUnits(activityFingerprint(left), activityFingerprint(right)) <= 0 ? left : right;
		}
		function evidenceRank(status) {
			if (status === "running") return 0;
			if (status === "result-without-call") return 1;
			return 2;
		}
		function compareActivity(left, right) {
			const leftSeq = sortSequence(left);
			const rightSeq = sortSequence(right);
			if (leftSeq !== rightSeq) return leftSeq > rightSeq ? -1 : 1;
			return compareCodeUnits(left.callId, right.callId);
		}
		function sortSequence(item) {
			return item.resultSeq ?? item.startSeq ?? -1;
		}
		function compareCodeUnits(left, right) {
			return left < right ? -1 : left > right ? 1 : 0;
		}
		function activityFingerprint(item) {
			return JSON.stringify([
				item.status,
				item.toolName,
				item.startedAt,
				item.endedAt,
				item.durationMs,
				item.startSeq,
				item.resultSeq,
				item.resultSummary
			]);
		}
		function isToolChatNode(value) {
			try {
				if (value === null || typeof value !== "object") return false;
				const node = value;
				if (node.kind !== "tool-call" || node.target !== "chat" || node.visibility !== "visible" || node.data === null || typeof node.data !== "object") return false;
				const data = node.data;
				if (data.root === null || typeof data.root !== "object") return false;
				return typeof data.root.callId === "string";
			} catch {
				return false;
			}
		}
		function serializedStateSize(items, incompleteCount) {
			return new TextEncoder().encode(JSON.stringify({
				phase: "unavailable",
				source: SOURCE,
				window: WINDOW,
				hasMore: true,
				staleSafeItems: true,
				incompleteCount,
				items
			})).byteLength;
		}
		function isSafeIdentifier(value) {
			return value.length > 0 && codePointLengthAtMost(value, MAX_ID_LENGTH) && !CONTROL_CHARACTER.test(value);
		}
		function safeToolName(value) {
			return typeof value === "string" && value.length > 0 && codePointLengthAtMost(value, MAX_TOOL_NAME_LENGTH) && !CONTROL_CHARACTER.test(value) ? value : "Unknown tool";
		}
		function codePointLengthAtMost(value, maximum) {
			let length = 0;
			for (const _character of value) {
				length++;
				if (length > maximum) return false;
			}
			return true;
		}
		function safeSequence(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
		}
		function isFiniteFraction(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 && !Number.isInteger(value);
		}
		function safeTime(value) {
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return null;
			return {
				epochMs: value,
				iso: date.toISOString()
			};
		}
		function equalActivity(left, right) {
			return right !== void 0 && left.id === right.id && left.toolName === right.toolName && left.status === right.status && left.startedAt === right.startedAt && left.endedAt === right.endedAt && left.durationMs === right.durationMs && left.startSeq === right.startSeq && left.resultSeq === right.resultSeq && left.resultSummary === right.resultSummary;
		}
		function state(phase, items, hasMore, staleSafeItems, incompleteCount = 0) {
			return {
				phase,
				source: SOURCE,
				window: WINDOW,
				hasMore,
				staleSafeItems,
				incompleteCount,
				items
			};
		}
		function unavailableState() {
			return state("unavailable", [], false, false);
		}
		//#endregion
		//#region lib/client/DevFlowCanvas.js
		/**
		* Fixed readable phrase per refusal phase, mirroring the Host's own vocabulary
		* so the panel and `/devflow commander status` name the same act the same way.
		*/
		const ACTIVATION_PHASE_LABELS = {
			initial: "首次激活",
			recompose: "切换 preset",
			deactivate: "撤销激活",
			restore: "回滚恢复",
			journal: "留痕写入"
		};
		/**
		* The one readable conclusion for a recorded activation refusal.
		*
		* The banner's old headline was the raw refusal code, which reads as an internal
		* identifier rather than as an answer: an operator who saw
		* `devflow-activation-verification-failed` once read it as an employee id. The
		* code stays in the DOM (it is the one string that can be quoted into a report),
		* but it is no longer the sentence that carries the meaning.
		*
		* Only two conclusions are drawn, both from data the Host verified:
		*
		*  - `session` `bound` ⇒ the refusal was absorbed by the bounded settle retry and
		*    this session is live now, so the banner says so and points at the readable
		*    verdict rather than at the code;
		*  - anything else ⇒ the refusal stands, and the sentence is
		*    `激活未通过（原因：…）` with the recorded Chinese reason.
		*
		* No third branch invents a recovery: a refusal that was never followed by a
		* verified bound posture is never described as retried-and-recovered.
		* @param failure - the refusal record carried by the snapshot.
		* @param activation - the Host-verified posture of the same session.
		* @returns the headline, the factual meta line, and the fixed phase phrase.
		*/
		function activationFailureVerdict(failure, activation) {
			const retried = Math.max(failure.attempts - 1, 0);
			const meta = retried === 0 ? `首次尝试即被拒绝 · ${failure.at}` : `已自动重试 ${String(retried)} 次 · ${failure.attempts} 次尝试 · ${failure.at}`;
			return {
				headline: activation === "bound" ? "DevFlow 激活未通过，重试后已恢复绑定（不影响当前会话）" : `DevFlow 激活未通过（原因：${failure.reason}）`,
				meta,
				phase: ACTIVATION_PHASE_LABELS[failure.phase] ?? "激活"
			};
		}
		/** Render the read-only DevFlow workspace as the right Sidebar's DevFlow tab body. */
		function DevFlowCanvas(props) {
			const { useDevflow, useSession, useChat, sessionId, refresh, t, audit, getInspectorTab, setInspectorTab: persistInspectorTab, reopenOverview } = props;
			const state = useDevflow((value) => value);
			const auditHook = props.useAudit;
			const auditState = auditHook === void 0 ? null : auditHook((value) => value);
			const liveHook = props.useLive;
			const connection = liveHook === void 0 ? null : liveHook((value) => value) ?? null;
			const liveConnected = connection?.phase === "live";
			const [selection, setSelection] = (0, react.useState)(PROJECT_SELECTION);
			const [history, setHistory] = (0, react.useState)([]);
			const [selectionNotice, setSelectionNotice] = (0, react.useState)(null);
			const [inspectorOpen, setInspectorOpen] = (0, react.useState)(false);
			const [inspectorTab, setInspectorTab] = (0, react.useState)(() => getInspectorTab());
			(0, react.useId)();
			const changeInspectorTab = (tab) => {
				persistInspectorTab(tab);
				setInspectorTab(tab);
			};
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const snapshot = state.snapshot;
			const devflowSessionId = snapshot?.session.id;
			const projectId = snapshot?.project?.id;
			const previousProjectId = (0, react.useRef)(projectId);
			const projectChanged = previousProjectId.current !== projectId;
			const model = snapshot === null ? null : createWorkspaceModel(snapshot);
			(0, react.useEffect)(() => {
				previousProjectId.current = projectId;
				if (model === null || !projectChanged && selectionExists(model, selection)) return;
				setSelection(PROJECT_SELECTION);
				setHistory([]);
				setSelectionNotice(projectChanged ? "当前项目已变更，已回到项目总览。" : "原先选中的对象已不在当前快照，已回到项目总览。");
			}, [
				projectId,
				model,
				selection
			]);
			(0, react.useEffect)(() => {
				if (devflowSessionId === void 0 || projectId === void 0 || audit === void 0 || inspectorTab !== "audit") return;
				if (projectChanged) {
					audit.ensure({ kind: "project" }, projectId);
					return;
				}
				audit.ensure(auditFilterForSelection(selection), projectId);
			}, [
				devflowSessionId,
				projectId,
				projectChanged,
				audit,
				inspectorTab,
				selection
			]);
			(0, react.useEffect)(() => {
				if (liveConnected) return;
				const timer = window.setInterval(() => {
					refresh();
				}, 5e3);
				return () => {
					window.clearInterval(timer);
				};
			}, [refresh, liveConnected]);
			const select = (next) => {
				setHistory((previous) => [...previous, selection]);
				setSelection(next);
				setSelectionNotice(null);
				setInspectorOpen(true);
			};
			if (state.phase === "loading") return (0, react_jsx_runtime.jsx)("main", {
				className: "devflow-canvas devflow-flow",
				"aria-busy": "true",
				children: (0, react_jsx_runtime.jsx)("p", {
					className: "devflow-notice",
					children: t("loading")
				})
			});
			if (snapshot === null || model === null) return (0, react_jsx_runtime.jsx)("main", {
				className: "devflow-canvas devflow-flow",
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: "devflow-notice",
					children: [(0, react_jsx_runtime.jsx)("p", { children: t("unavailable") }), (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => {
							refresh();
						},
						children: t("retry")
					})]
				})
			});
			const failure = snapshot.session.lastActivationFailure ?? null;
			/** Blocked dispatches, newest first; empty for snapshots that predate them. */
			const blockedRows = snapshot.blocked ?? [];
			const verdict = failure === null ? null : activationFailureVerdict(failure, snapshot.session.activation);
			return (0, react_jsx_runtime.jsxs)("main", {
				className: "devflow-canvas devflow-flow",
				"data-phase": state.phase,
				"data-preset": snapshot.session.presetId ?? "none",
				"data-devflow-panel": "true",
				"data-activation-failure": failure?.code ?? "none",
				children: [
					failure !== null && verdict !== null && (0, react_jsx_runtime.jsxs)("div", {
						className: "devflow-activation-failure",
						role: "status",
						"data-activation-code": failure.code,
						"data-activation-phase": failure.phase,
						"data-activation-attempts": String(failure.attempts),
						"data-activation-recovered": String(snapshot.session.activation === "bound"),
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: "devflow-activation-failure-head",
								children: verdict.headline
							}),
							(0, react_jsx_runtime.jsxs)("span", {
								className: "devflow-activation-failure-code",
								title: `内部编码：${failure.code}`,
								children: [
									"内部编码 〈",
									failure.code,
									"〉"
								]
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "devflow-activation-failure-meta",
								children: `${verdict.phase} · ${verdict.meta}`
							})
						]
					}),
					state.phase === "error" && (0, react_jsx_runtime.jsxs)("div", {
						className: "devflow-error-notice",
						role: "alert",
						"data-error-code": state.error.code,
						children: [(0, react_jsx_runtime.jsx)("span", { children: state.error.code === "scope-unavailable" ? t("scopeUnavailable") : `${t("unavailable")} 显示最近一次成功的数据。` }), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								refresh();
							},
							children: t("retry")
						})]
					}),
					blockedRows.length > 0 && (0, react_jsx_runtime.jsxs)("div", {
						className: "devflow-blocked-banner",
						role: "status",
						"data-blocked-count": String(blockedRows.length),
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "devflow-blocked-head",
							children: "受阻 · 需要处理"
						}), blockedRows.slice(0, 3).map((row) => (0, react_jsx_runtime.jsxs)("span", {
							className: "devflow-blocked-row",
							"data-gap-kind": row.gapKind,
							"data-task-id": row.taskId,
							children: [row.headline, (0, react_jsx_runtime.jsx)("span", {
								className: "devflow-blocked-why",
								children: row.reason.text
							})]
						}, row.id))]
					}),
					(0, react_jsx_runtime.jsx)(FlowCanvas, {
						model,
						phase: state.phase,
						tab: inspectorTab,
						now: props.now,
						connection,
						notice: selectionNotice,
						onTabChange: changeInspectorTab,
						onReopenOverview: reopenOverview,
						auditPanel: snapshot.project === null ? (0, react_jsx_runtime.jsx)(EmptyProject, { t }) : (0, react_jsx_runtime.jsx)(BusinessAudit, {
							state: projectChanged ? null : auditState,
							model,
							onSelect: select,
							onRefresh: () => {
								audit?.refresh();
							},
							onMore: () => {
								audit?.loadMore();
							},
							onRetry: () => {
								audit?.retry();
							}
						}),
						toolsPanel: (0, react_jsx_runtime.jsx)(CurrentSessionToolsView, {
							useSession,
							useChat,
							sessionId
						})
					})
				]
			});
		}
		function EmptyProject({ t }) {
			return (0, react_jsx_runtime.jsxs)("section", {
				className: "devflow-empty-state",
				children: [
					(0, react_jsx_runtime.jsx)("h1", { children: "共享 DevFlow 项目" }),
					(0, react_jsx_runtime.jsx)("p", { children: t("empty") }),
					(0, react_jsx_runtime.jsxs)("p", { children: [
						"在本机 Chat 里执行 ",
						(0, react_jsx_runtime.jsx)("code", { children: "/devflow init <name>" }),
						" 即可初始化。本工作区只读。"
					] })
				]
			});
		}
		function InspectorSourceHeading({ title, badges }) {
			return (0, react_jsx_runtime.jsx)("header", {
				className: "devflow-panel-heading",
				children: (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h3", { children: title }), badges.map((badge) => (0, react_jsx_runtime.jsx)("span", {
					className: "devflow-source-badge",
					children: badge
				}, badge))] })
			});
		}
		function CurrentSessionToolsView({ useSession, useChat, sessionId }) {
			const chat = useChat((snapshot) => snapshot);
			const state = useSession((session) => mapCurrentSessionTools(sessionId, {
				session,
				chat
			}), equalCurrentSessionToolsState);
			return (0, react_jsx_runtime.jsx)(CurrentSessionTools, { state });
		}
		function CurrentSessionTools({ state }) {
			const hasItems = state.items.length > 0;
			return (0, react_jsx_runtime.jsxs)("section", {
				className: "devflow-tools",
				"aria-busy": state.phase === "loading",
				children: [
					(0, react_jsx_runtime.jsx)(InspectorSourceHeading, {
						title: "本会话工具动态",
						badges: [
							"本会话 · Harness 官方数据",
							"当前已加载会话窗口",
							"最新最多 20 条"
						]
					}),
					(0, react_jsx_runtime.jsx)("p", {
						className: "devflow-detail-note",
						children: "这里显示当前会话已加载窗口里可见的官方工具动态；当前的 DevFlow 选择不参与过滤。"
					}),
					state.phase === "loading" && !hasItems && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-muted",
						children: "正在从当前已加载的会话窗口读取官方工具动态…"
					}),
					state.phase === "loading" && hasItems && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-tools-stale",
						role: "status",
						children: "会话窗口仍在加载，这里只显示当前可见的安全内容。"
					}),
					state.phase === "unavailable" && !hasItems && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-tools-unavailable",
						role: "status",
						children: "当前会话的官方工具动态不可用。此处不会用 `.devflow` 记录顶替。"
					}),
					state.phase === "unavailable" && hasItems && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-tools-stale",
						role: "status",
						children: "官方工具动态当前不可用，显示仍留在已加载窗口中的安全条目。"
					}),
					state.phase === "ready" && !hasItems && state.incompleteCount === 0 && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-muted",
						children: "当前会话已加载窗口里没有可见的官方工具动态。"
					}),
					state.incompleteCount > 0 && (0, react_jsx_runtime.jsxs)("p", {
						className: "devflow-muted",
						children: [
							"有 ",
							state.incompleteCount,
							" 条可见工具调用因为没有确认到活跃结果而被略过。"
						]
					}),
					hasItems && (0, react_jsx_runtime.jsx)("ol", {
						className: "devflow-tool-list",
						children: state.items.map((item) => (0, react_jsx_runtime.jsx)(ToolActivityItem, { item }, item.id))
					}),
					state.hasMore && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-muted",
						children: "更早的会话历史在这个已加载窗口之外，本视图不会去加载它。"
					})
				]
			});
		}
		function ToolActivityItem({ item }) {
			return (0, react_jsx_runtime.jsxs)("li", {
				"data-status": item.status,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "devflow-tool-title",
						children: [(0, react_jsx_runtime.jsx)("strong", { children: item.toolName }), (0, react_jsx_runtime.jsx)("em", { children: toolStatusLabel(item.status) })]
					}),
					(0, react_jsx_runtime.jsxs)("dl", {
						className: "devflow-tool-meta",
						children: [
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "调用" }), (0, react_jsx_runtime.jsx)("dd", {
								title: item.callId,
								children: shortId(item.callId, 18)
							})] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "开始" }), (0, react_jsx_runtime.jsxs)("dd", { children: [item.startedAt ?? "不可见", item.startSeq === null ? "" : ` · #${item.startSeq}`] })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "结果" }), (0, react_jsx_runtime.jsxs)("dd", { children: [item.endedAt ?? "不可见", item.resultSeq === null ? "" : ` · #${item.resultSeq}`] })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: "耗时" }), (0, react_jsx_runtime.jsx)("dd", { children: item.durationMs === null ? "不可用" : `${item.durationMs} 毫秒` })] })
						]
					}),
					(0, react_jsx_runtime.jsxs)("p", {
						className: "devflow-tool-summary",
						children: ["结果 · ", item.resultSummary]
					}),
					(0, react_jsx_runtime.jsx)("p", {
						className: "devflow-tool-relation",
						children: "未知 — 没有记录到 DevFlow 关联"
					})
				]
			});
		}
		function toolStatusLabel(status) {
			return {
				running: "进行中",
				succeeded: "成功",
				failed: "失败",
				"result-without-call": "只有结果、看不到调用"
			}[status];
		}
		function BusinessAudit({ state, model, onSelect, onRefresh, onMore, onRetry }) {
			if (state === null) return (0, react_jsx_runtime.jsxs)("section", {
				className: "devflow-audit",
				children: [(0, react_jsx_runtime.jsx)(InspectorSourceHeading, {
					title: "业务审计",
					badges: ["共享 · .devflow"]
				}), (0, react_jsx_runtime.jsx)("p", {
					className: "devflow-muted",
					children: "当前客户端版本没有业务审计能力。"
				})]
			});
			if (state.phase === "idle" || state.phase === "loading") return (0, react_jsx_runtime.jsxs)("section", {
				className: "devflow-audit",
				"aria-busy": "true",
				children: [(0, react_jsx_runtime.jsx)(AuditHeading, { onRefresh }), (0, react_jsx_runtime.jsx)("p", {
					className: "devflow-muted",
					children: "正在读取共享 DevFlow 业务审计…"
				})]
			});
			if (state.phase === "error" && state.page === null) return (0, react_jsx_runtime.jsxs)("section", {
				className: "devflow-audit",
				children: [
					(0, react_jsx_runtime.jsx)(AuditHeading, { onRefresh }),
					(0, react_jsx_runtime.jsx)("p", {
						className: "devflow-audit-error",
						children: "DevFlow 审计不可用，请刷新重试。"
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "devflow-audit-action",
						onClick: onRetry,
						children: "重试"
					})
				]
			});
			const page = state.page;
			if (page === null) return null;
			return (0, react_jsx_runtime.jsxs)("section", {
				className: "devflow-audit",
				children: [
					(0, react_jsx_runtime.jsx)(AuditHeading, { onRefresh }),
					state.phase === "refreshing" && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-audit-stale",
						children: "刷新中 · 显示最近一次成功的审计数据"
					}),
					state.phase === "error" && (0, react_jsx_runtime.jsxs)("div", {
						className: "devflow-audit-error",
						role: "alert",
						children: ["DevFlow 审计不可用，显示最近一次成功的数据。", (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "devflow-audit-action",
							onClick: onRetry,
							children: "重试"
						})]
					}),
					page.items.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-muted",
						children: "当前项目或对象没有可展示的 DevFlow 业务审计记录。"
					}) : (0, react_jsx_runtime.jsx)("ol", {
						className: "devflow-audit-list",
						children: page.items.map((item) => (0, react_jsx_runtime.jsx)(AuditItem, {
							item,
							model,
							onSelect
						}, item.id))
					}),
					page.omittedUnsafeCount > 0 && (0, react_jsx_runtime.jsxs)("p", {
						className: "devflow-muted",
						children: [
							"有 ",
							page.omittedUnsafeCount,
							" 条不安全或不受支持的审计记录已隐藏。"
						]
					}),
					page.truncated && (0, react_jsx_runtime.jsx)("p", {
						className: "devflow-muted",
						children: "本页在完整记录边界处被安全截断。"
					}),
					page.nextCursor !== null && (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "devflow-audit-action",
						disabled: state.phase !== "ready",
						onClick: onMore,
						children: state.phase === "loading-more" ? "加载中…" : "加载更多"
					})
				]
			});
		}
		function AuditHeading({ onRefresh, disabled = false }) {
			return (0, react_jsx_runtime.jsxs)("header", {
				className: "devflow-audit-heading",
				children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h3", { children: "业务审计" }), (0, react_jsx_runtime.jsx)("span", {
					className: "devflow-source-badge",
					children: "共享 · .devflow"
				})] }), (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "devflow-audit-action",
					disabled,
					onClick: onRefresh,
					children: "刷新"
				})]
			});
		}
		function AuditItem({ item, model, onSelect }) {
			const related = relatedSelection(item, model);
			return (0, react_jsx_runtime.jsxs)("li", {
				"data-incomplete": item.incomplete,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "devflow-audit-meta",
						children: [(0, react_jsx_runtime.jsx)("time", { children: item.at }), (0, react_jsx_runtime.jsxs)("span", { children: ["#", item.sequence] })]
					}),
					(0, react_jsx_runtime.jsxs)("strong", { children: [
						auditLabel(item.category),
						" · ",
						auditLabel(item.action)
					] }),
					item.status !== null && (0, react_jsx_runtime.jsx)("em", { children: item.status }),
					related === void 0 ? (0, react_jsx_runtime.jsx)("p", { children: item.entity.display?.text ?? (item.incomplete ? "未知 / 历史遗留记录" : "当前没有对应对象") }) : (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => {
							onSelect(related);
						},
						children: auditEntityLabel(item, model)
					}),
					item.summary !== null && (0, react_jsx_runtime.jsx)(SafeText, {
						text: item.summary.text,
						truncated: item.summary.truncated,
						redacted: item.summary.redacted
					}),
					item.incomplete && (0, react_jsx_runtime.jsx)("small", { children: "历史遗留或不完整记录" })
				]
			});
		}
		function relatedSelection(item, model) {
			const id = item.entity.id;
			if (item.entity.type === "phase" && id !== null && model.phases.some((phase) => phase.id === id)) return {
				kind: "phase",
				id
			};
			if (item.entity.type === "task" && id !== null && model.taskById.has(id)) return {
				kind: "task",
				id
			};
			if (item.entity.type === "agent" && id !== null && model.agentById.has(id)) return {
				kind: "agent",
				id
			};
			if (item.entity.type === "execution" && id !== null && model.executionById.has(id)) return {
				kind: "execution",
				id
			};
			if ((item.entity.type === "decision" || item.entity.type === "decision-request") && id !== null && (model.decisionsById.has(id) || model.decisionRequestsById.has(id))) return {
				kind: "decision",
				id
			};
		}
		function auditEntityLabel(item, model) {
			const id = item.entity.id;
			if (id === null) return "未知 / 历史遗留记录";
			if (item.entity.type === "phase") return model.phases.find((phase) => phase.id === id)?.name ?? "未知 / 阶段已删除";
			if (item.entity.type === "task") return model.taskById.get(id)?.task.title ?? "未知 / 任务已删除";
			if (item.entity.type === "agent") return model.agentById.get(id)?.agent.displayName ?? "未知 / Agent 已删除";
			if (item.entity.type === "execution") return `执行 ${shortId(id)}`;
			return `决策 ${shortId(id)}`;
		}
		/**
		* Audit categories/actions arrive as stored English enum values. The panel shows
		* a Chinese name where one exists and falls back to the stored value, so an
		* unmapped code is visible rather than silently blanked.
		*/
		const AUDIT_WORDS = {
			project: "项目",
			task: "任务",
			phase: "阶段",
			agent: "Agent",
			assignment: "派发",
			execution: "执行",
			attempt: "尝试",
			report: "报告",
			decision: "决策",
			control: "控制",
			scope: "范围",
			"bridge-review": "桥接复核",
			runtime: "运行时",
			"commander-action": "总指挥动作",
			updated: "更新",
			created: "创建",
			removed: "移除",
			transitioned: "状态流转",
			assigned: "已派发",
			unassigned: "已取消派发",
			started: "开始",
			completed: "完成",
			failed: "失败",
			blocked: "阻塞",
			requested: "已请求",
			answered: "已回答",
			paused: "已暂停",
			resumed: "已恢复",
			imported: "已导入",
			exported: "已导出",
			"boundary-hit": "触达边界",
			executed: "已执行"
		};
		function auditLabel(value) {
			const known = AUDIT_WORDS[value];
			if (known !== void 0) return known;
			return value.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
		}
		/** Render one bounded audit summary without ever echoing raw runtime text. */
		function SafeText({ text, truncated, redacted }) {
			return (0, react_jsx_runtime.jsxs)("p", { children: [text, redacted ? (0, react_jsx_runtime.jsx)("em", { children: " · 敏感内容已隐藏" }) : truncated ? (0, react_jsx_runtime.jsx)("em", { children: " · 已截断" }) : null] });
		}
		//#endregion
		//#region lib/client/DevFlowCanvasTitle.js
		/**
		* The title as the chip and a floating panel's header show it.
		* @param props - the tab information hook and the bound copy namespace.
		* @returns the DevFlow label for the tab.
		*/
		function DevFlowCanvasTitle({ t }) {
			return t("canvas");
		}
		//#endregion
		//#region lib/client/DevFlowOverview.js
		/**
		* Step 3B — the top-right DevFlow overview float (`shell.overlay`).
		*
		* The float is the "简版概览" the boss asked for: one glance at the current session's
		* DevFlow state without opening the right panel, and one click into the full panel.
		* It is explicitly NOT a second full panel — no audit list, no tool activity, no
		* handoff detail, no history chain, and none of the canvas' motion matrix.
		*
		* Three states, all of them reachable by keyboard:
		*   * **折叠** — a small pill in the frame's top-right corner: status dot, the
		*     headline counts, and the live-channel posture ("实时通道" / "轮询兜底").
		*   * **展开** — a docked float beside the panel: project + binding, the segmented
		*     progress bar, the commander line, one row per fixed employee, the small-print
		*     counts, and 打开完整面板.
		*   * **关闭** — the pill goes too; the way back in is the DevFlow panel's own
		*     header action (see `DevFlowCanvas`), which is why the closed flag is remembered.
		*
		* §四 (session filtering) is the round's real trap: `shell.overlay` is ROOT-scoped, so
		* this component owns the gate and {@link overviewGate} executes it deny-by-default.
		* A session change ALSO folds the float, so a value from the previous session can
		* never be on screen while the next one loads.
		*
		* §11.2 (motion): the float is still by default and distinguishes its states by
		* COLOUR. The only motion it may carry is one very weak opacity pulse on the status
		* dot while dispatches are in flight — no glass resampling, no travelling dash, no
		* animation matrix. `prefers-reduced-motion` removes even that.
		*/
		/** Bounded, safe storage reads: private mode must never break the float. */
		function readFlag(storage, key, fallback) {
			if (storage === null) return fallback;
			try {
				const value = storage.getItem(key);
				if (value === "1" || value === "true") return true;
				if (value === "0" || value === "false") return false;
				return fallback;
			} catch {
				return fallback;
			}
		}
		function writeFlag(storage, key, value) {
			if (storage === null) return;
			try {
				storage.setItem(key, value ? "1" : "0");
			} catch {}
		}
		function safeStorage() {
			try {
				return typeof window === "undefined" ? null : window.localStorage;
			} catch {
				return null;
			}
		}
		/** The segmented progress bar, in the panel's own order and wording. */
		const SEGMENTS = [
			{
				key: "active",
				label: "进行中",
				tone: "run"
			},
			{
				key: "review",
				label: "待验收",
				tone: "wait"
			},
			{
				key: "done",
				label: "已完成",
				tone: "done"
			},
			{
				key: "lost",
				label: "未收尾·失联",
				tone: "lost"
			},
			{
				key: "closed",
				label: "已收尾",
				tone: "closed"
			}
		];
		/** The float's own tone names for the node states it colours. */
		const MEMBER_TONE = {
			idle: "idle",
			active: "run",
			blocked: "wait",
			done: "done",
			rework: "bad",
			planned: "queue",
			lost: "lost",
			paused: "paused",
			closed: "closed"
		};
		const LOADING = {
			phase: "loading",
			snapshot: null,
			error: null
		};
		/**
		* Gap kept to the right of the column's own toggle button. The button is 28px wide and
		* sits at the frame's right edge while the column is collapsed, so the float has to clear
		* the button PLUS this margin — a bare "column width" offset put the float on top of it
		* at every narrow viewport (measured at 420/600/720px in the first evidence pass).
		*/
		const TOGGLE_CLEARANCE = 44;
		/** The float's cell body. */
		function DevFlowOverview(props) {
			const { useSessions, controllerFor, liveFor, openPanel } = props;
			const gate = overviewGate(useSessions((state) => state));
			const sessionId = gate.sessionId;
			const readSessionFlags = (0, react.useCallback)(() => {
				const storage = safeStorage();
				legacyFlagCleanup(storage);
				return {
					expanded: readFlag(storage, overviewExpandedKey(sessionId), false),
					closed: readFlag(storage, overviewClosedKey(sessionId), false)
				};
			}, [sessionId]);
			/**
			* The fold and close are remembered PER SESSION. They are preferences about ONE
			* session's float; a single global flag meant one accidental close hid the
			* overview in every other project too — which is what "概览没有了" looked like.
			*/
			const initialFlags = (0, react.useRef)(null);
			if (initialFlags.current === null || initialFlags.current.sessionId !== sessionId) initialFlags.current = {
				sessionId,
				...readSessionFlags()
			};
			const [expanded, setExpanded] = (0, react.useState)(initialFlags.current.expanded);
			const [closed, setClosed] = (0, react.useState)(initialFlags.current.closed);
			const hostRef = (0, react.useRef)(null);
			const previousSession = (0, react.useRef)(null);
			const controller = sessionId === null ? null : controllerFor(sessionId);
			const live = sessionId === null ? void 0 : liveFor(sessionId);
			const state = useControllerState(controller);
			const connection = useConnectionState(live ?? null);
			(0, react.useEffect)(() => {
				if (previousSession.current === sessionId) return;
				previousSession.current = sessionId;
				const flags = readSessionFlags();
				setExpanded(flags.expanded);
				setClosed(flags.closed);
			}, [sessionId, readSessionFlags]);
			(0, react.useEffect)(() => {
				const onReopen = () => {
					writeFlag(safeStorage(), overviewClosedKey(sessionId), false);
					setClosed(false);
				};
				window.addEventListener(OVERVIEW_REOPEN_EVENT, onReopen);
				return () => {
					window.removeEventListener(OVERVIEW_REOPEN_EVENT, onReopen);
				};
			}, [sessionId]);
			/**
			* Docking: the float never covers the right column's own controls, at any column width
			* or any of the three viewport widths the round checks.
			*
			* The offset is MEASURED, never assumed from a breakpoint: the frame has three layout
			* modes, the column can be collapsed to a narrow rail, and the toggle button sits at
			* the frame's right edge in the collapsed mode — where a "column width + small gap"
			* rule would put the float straight on top of it. The rule below is therefore:
			* clear the column, and clear the toggle with {@link TOGGLE_CLEARANCE} to spare.
			*/
			(0, react.useEffect)(() => {
				const host = hostRef.current;
				if (host === null || typeof window === "undefined") return;
				const place = () => {
					const column = document.querySelector("[class*=\"rightbarCol\"]");
					const columnWidth = column === null ? 0 : Math.round(column.getBoundingClientRect().width);
					const toggle = document.querySelector("button[data-sidebar-right-toggle=\"true\"]");
					const toggleWidth = toggle === null ? 0 : Math.ceil(toggle.getBoundingClientRect().width);
					const width = Math.max(columnWidth, toggle === null ? 0 : toggleWidth + TOGGLE_CLEARANCE);
					host.style.setProperty("--devflow-ov-offset", Math.round(width) + "px");
				};
				place();
				if (typeof ResizeObserver === "undefined") return;
				const observer = new ResizeObserver(place);
				observer.observe(document.body);
				const column = document.querySelector("[class*=\"rightbarCol\"]");
				if (column !== null) observer.observe(column);
				return () => {
					observer.disconnect();
				};
			}, [
				gate.allowed,
				expanded,
				closed
			]);
			const toggle = (0, react.useCallback)(() => {
				setExpanded((value) => {
					writeFlag(safeStorage(), overviewExpandedKey(sessionId), !value);
					return !value;
				});
			}, [sessionId]);
			const close = (0, react.useCallback)(() => {
				setExpanded(false);
				writeFlag(safeStorage(), overviewExpandedKey(sessionId), false);
				writeFlag(safeStorage(), overviewClosedKey(sessionId), true);
				setClosed(true);
			}, [sessionId]);
			const model = state.snapshot === null ? null : createWorkspaceModel(state.snapshot);
			const view = (0, react.useMemo)(() => model === null ? null : buildOverview(model, void 0, connection), [model, connection]);
			if (!gate.allowed || sessionId === null || closed) return null;
			const ready = view !== null && state.phase !== "loading";
			const summary = view?.summary ?? "正在读取 DevFlow 状态";
			const posture = view?.posture ?? "active";
			const paused = view?.paused ?? false;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "devflow-ov",
				"data-expanded": expanded,
				"data-posture": posture,
				"data-paused": paused,
				"data-connection": view?.connectionPhase ?? "polling",
				"data-preset": gate.preset ?? "none",
				"data-gate": gate.reason,
				"data-session": sessionId,
				ref: hostRef,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "devflow-ov-pill",
					"aria-expanded": expanded,
					"aria-label": expanded ? "收起 DevFlow 概览" : `展开 DevFlow 概览：${summary}`,
					title: expanded ? "收起 DevFlow 概览" : "展开 DevFlow 概览",
					onClick: toggle,
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: "devflow-ov-dot",
							"data-posture": posture,
							"aria-hidden": "true"
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: "devflow-ov-pilltext",
							children: summary
						}),
						(0, react_jsx_runtime.jsx)("span", {
							className: "devflow-ov-pillconn",
							"data-connection": view?.connectionPhase ?? "polling",
							children: view?.connectionLabel ?? "轮询兜底"
						})
					]
				}), expanded && (0, react_jsx_runtime.jsxs)("section", {
					className: "devflow-ov-card",
					"aria-label": "DevFlow 概览",
					children: [
						(0, react_jsx_runtime.jsxs)("header", {
							className: "devflow-ov-head",
							children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("p", {
								className: "devflow-ov-kicker",
								children: "DevFlow 概览"
							}), (0, react_jsx_runtime.jsx)("h2", {
								className: "devflow-ov-title",
								children: ready && view !== null ? view.projectName : "正在读取…"
							})] }), (0, react_jsx_runtime.jsxs)("div", {
								className: "devflow-ov-headactions",
								children: [(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "devflow-ov-icon",
									"aria-label": "收起 DevFlow 概览",
									onClick: toggle,
									children: "▾"
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "devflow-ov-icon",
									"aria-label": "关闭 DevFlow 概览",
									onClick: close,
									children: "✕"
								})]
							})]
						}),
						!ready && (0, react_jsx_runtime.jsx)("p", {
							className: "devflow-ov-muted",
							role: "status",
							children: "正在读取当前会话的 DevFlow 状态…"
						}),
						ready && view !== null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							(0, react_jsx_runtime.jsxs)("p", {
								className: "devflow-ov-meta",
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: "devflow-ov-chip",
										"data-state": view.bindingLabel === "已绑定" ? "bound" : "unbound",
										children: view.bindingLabel
									}),
									view.paused && (0, react_jsx_runtime.jsx)("span", {
										className: "devflow-ov-chip",
										"data-state": "paused",
										children: "已暂停"
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: "devflow-ov-chip",
										"data-state": view.connectionPhase === "live" ? "live" : "poll",
										children: view.connectionLabel
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								className: "devflow-ov-segments",
								role: "group",
								"aria-label": "派发分段进度",
								children: SEGMENTS.map((segment) => (0, react_jsx_runtime.jsxs)("div", {
									className: "devflow-ov-segment",
									"data-tone": segment.tone,
									"data-count": view.counts[segment.key],
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: "devflow-ov-segbar",
											"aria-hidden": "true"
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: "devflow-ov-seglabel",
											children: segment.label
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: "devflow-ov-segnum",
											children: view.counts[segment.key]
										})
									]
								}, segment.key))
							}),
							(0, react_jsx_runtime.jsxs)("p", {
								className: "devflow-ov-commander",
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: "devflow-ov-dot",
										"data-state": "commander",
										"aria-hidden": "true"
									}),
									(0, react_jsx_runtime.jsx)("strong", { children: view.commanderName }),
									(0, react_jsx_runtime.jsx)("span", {
										className: "devflow-ov-memberstate",
										children: view.commanderStateLabel
									}),
									(0, react_jsx_runtime.jsxs)("span", {
										className: "devflow-ov-muted",
										children: [
											"已派出 ",
											view.dispatchCount,
											" 次派发"
										]
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("ul", {
								className: "devflow-ov-members",
								children: view.members.map((member) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "devflow-ov-member",
									"data-state": member.state,
									"data-kind": member.kind,
									"aria-label": `打开完整面板查看 ${member.name}（${member.stateLabel}）`,
									onClick: openPanel,
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: "devflow-ov-dot",
											"data-state": MEMBER_TONE[member.state] ?? "idle",
											"aria-hidden": "true"
										}),
										(0, react_jsx_runtime.jsxs)("span", {
											className: "devflow-ov-membername",
											children: [member.name, member.kind === "temporary" && (0, react_jsx_runtime.jsx)("span", {
												className: "devflow-ov-membertag",
												children: "临时子代理"
											})]
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: "devflow-ov-memberstate",
											"data-state": member.state,
											children: member.stateLabel
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: "devflow-ov-membertask",
											children: member.taskTitle ?? "当前没有派发任务"
										})
									]
								}) }, member.id))
							}),
							(0, react_jsx_runtime.jsxs)("p", {
								className: "devflow-ov-tally",
								children: [
									"未落点 ",
									view.counts.unrouted,
									" · 未收尾 ",
									view.counts.lost,
									" · 已隐藏 ",
									view.counts.hidden,
									view.counts.paused > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · 已暂停 ", view.counts.paused] })
								]
							}),
							connectionDetail(connection) !== null && (0, react_jsx_runtime.jsx)("p", {
								className: "devflow-ov-notice",
								role: "status",
								children: connectionDetail(connection)
							}),
							(0, react_jsx_runtime.jsx)("footer", {
								className: "devflow-ov-foot",
								children: (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "devflow-ov-open",
									onClick: openPanel,
									children: "打开完整面板"
								})
							})
						] })
					]
				})]
			});
		}
		/** Subscribe to the panel's per-session controller as an external store. */
		function useControllerState(controller) {
			const subscribe = (0, react.useCallback)((listener) => controller === null ? () => void 0 : controller.subscribe(listener), [controller]);
			const read = (0, react.useCallback)(() => controller === null ? LOADING : controller.getSnapshot(), [controller]);
			return (0, react.useSyncExternalStore)(subscribe, read, read);
		}
		/** Subscribe to the session's live channel as an external store. */
		function useConnectionState(live) {
			const subscribe = (0, react.useCallback)((listener) => live === null ? () => void 0 : live.subscribeConnection(listener), [live]);
			const read = (0, react.useCallback)(() => live === null ? null : live.getConnection(), [live]);
			return (0, react.useSyncExternalStore)(subscribe, read, read);
		}
		//#endregion
		//#region lib/client/flow-css.js
		/** 一次扫光的时长（秒），与 motion.ts 的 FLOW_DONE_SWEEP_MS 同源。 */
		const FLOW_SWEEP_SECONDS = (FLOW_DONE_SWEEP_MS / 1e3).toFixed(2);
		//#endregion
		//#region lib/client/styles.js
		const DEVFLOW_CSS = `
.devflow-canvas{--ink:#e8eef4;--muted:#92a2b2;--line:rgba(177,201,219,.18);--panel:#112130;--panel-soft:rgba(18,31,45,.82);--blue:#54b8d3;--green:#61d6ac;--amber:#f1b86b;--red:#ee817e;--violet:#a78bfa;height:100%;overflow:auto;padding:18px clamp(16px,3vw,36px) 36px;color:var(--ink);background:#0d1723;font-family:var(--ds-font-family-sans,ui-sans-serif,system-ui,sans-serif)}
.devflow-canvas button{font:inherit;color:inherit;cursor:pointer}.devflow-canvas button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.devflow-notice,.devflow-empty-state{max-width:600px;margin:18vh auto;padding:28px;text-align:center;color:var(--muted);border:1px dashed var(--line);background:var(--panel-soft)}.devflow-notice button,.devflow-error-notice button{margin-left:14px;padding:7px 12px;border:1px solid var(--blue);border-radius:4px;background:transparent;color:var(--blue)}
.devflow-identity-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:0 0 15px;border-bottom:1px solid var(--line)}.devflow-source-badge,.devflow-freshness{display:inline-flex;align-items:center;min-height:26px;padding:3px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:rgba(84,184,211,.05);font:11px/1.2 var(--ds-font-family-code,ui-monospace,monospace)}.devflow-source-badge[data-state=bound],.devflow-source-badge[data-state=live]{color:var(--green)}.devflow-source-badge[data-state=unbound]{color:var(--amber)}.devflow-source-badge[data-state=paused]{color:var(--amber);border-color:rgba(241,184,107,.45)}.devflow-freshness{margin-left:auto;color:var(--blue)}.devflow-freshness[data-state=error]{color:var(--amber)}
.devflow-refresh-notice,.devflow-selection-notice{margin:11px 0;padding:8px 10px;border-left:2px solid var(--blue);background:rgba(84,184,211,.08);color:var(--blue);font-size:12px}.devflow-error-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:11px 0;padding:9px 12px;border-left:2px solid var(--red);background:rgba(238,129,126,.1);color:var(--red);font-size:13px}.devflow-empty-state h1{margin:0 0 8px;color:var(--ink);font-size:22px}.devflow-empty-state p{margin:9px 0;line-height:1.5}.devflow-empty-state code,.devflow-detail-note code{color:var(--blue);font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.devflow-workspace{display:grid;grid-template-columns:minmax(248px,288px) minmax(520px,1fr) minmax(340px,420px);gap:14px;align-items:stretch;min-height:calc(100% - 43px);padding-top:14px}.devflow-navigation,.devflow-overview,.devflow-inspector{min-width:0;border:1px solid var(--line);background:var(--panel-soft)}.devflow-navigation{max-height:calc(100vh - 150px);overflow:auto;padding:12px}.devflow-navigation-collapse{display:block}.devflow-navigation-collapse>summary{display:none}.devflow-navigation-group+ .devflow-navigation-group{margin-top:18px}.devflow-navigation-group header,.devflow-section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:0 1px 8px;border-bottom:1px solid rgba(177,201,219,.12)}.devflow-navigation-group h2,.devflow-section-heading h2{margin:0;color:var(--blue);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.devflow-navigation-group header span,.devflow-section-heading span{color:var(--muted);font:10px var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.04em}.devflow-navigation-item{position:relative;display:flex;flex-direction:column;width:100%;gap:3px;margin-top:3px;padding:9px 9px 9px 12px;border:0;border-left:2px solid transparent;background:transparent;text-align:left}.devflow-navigation-item:hover{background:rgba(84,184,211,.06)}.devflow-navigation-item[data-selected=true]{border-left-color:var(--blue);background:rgba(84,184,211,.13)}.devflow-navigation-item strong{overflow:hidden;color:var(--ink);font-size:12px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}.devflow-navigation-item small{color:var(--muted);font:10px var(--ds-font-family-code,ui-monospace,monospace)}
.devflow-overview{padding:17px;overflow:auto}.devflow-overview-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:17px;border-bottom:1px solid var(--line)}.devflow-kicker{margin:0 0 6px;color:var(--blue);font:10px/1.2 var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.14em;text-transform:uppercase}.devflow-overview h1{max-width:640px;margin:0;color:var(--ink);font-size:clamp(22px,3vw,32px);font-weight:650;letter-spacing:-.028em}.devflow-overview-header p:not(.devflow-kicker){max-width:620px;margin:7px 0 0;color:var(--muted);font-size:13px;line-height:1.45}.devflow-task-summary{display:flex;flex-wrap:wrap;gap:6px;padding:12px 0;border-bottom:1px solid var(--line)}.devflow-task-summary span{padding:4px 7px;border:1px solid rgba(177,201,219,.14);color:var(--muted);font:10px var(--ds-font-family-code,ui-monospace,monospace)}.devflow-overview-header dl{display:grid;grid-template-columns:repeat(2,minmax(72px,1fr));gap:1px;flex:0 0 auto;margin:0;border:1px solid var(--line);background:var(--line)}.devflow-overview-header dl div{padding:9px;background:var(--panel)}.devflow-overview-header dt{color:var(--muted);font:9px var(--ds-font-family-code,ui-monospace,monospace);text-transform:uppercase}.devflow-overview-header dd{margin:5px 0 0;color:var(--ink);font-size:14px;font-weight:650}
.devflow-priority-queue,.devflow-phase-area,.devflow-agent-summary,.devflow-activity{margin-top:20px;padding-top:15px;border-top:1px solid var(--line)}.devflow-priority-queue{border-top:0;margin-top:0;padding:16px 0 0}.devflow-priority-queue ul,.devflow-phase-lane ul,.devflow-activity ol{display:flex;flex-direction:column;gap:6px;margin:10px 0 0;padding:0;list-style:none}.devflow-priority-queue li button{display:grid;width:100%;gap:4px;padding:10px 12px;border:0;border-left:3px solid var(--amber);background:rgba(241,184,107,.09);text-align:left}.devflow-priority-queue strong{color:var(--amber);font-size:12px}.devflow-priority-queue span{color:var(--ink);font-size:12px;line-height:1.4}.devflow-priority-queue small{color:var(--muted);font:9px var(--ds-font-family-code,ui-monospace,monospace)}
.devflow-phase-lane{margin-top:11px;padding:13px;border:1px solid var(--line);background:rgba(13,23,35,.5)}.devflow-phase-lane[data-selected=true]{border-color:rgba(84,184,211,.65);box-shadow:inset 3px 0 var(--blue)}.devflow-phase-lane header>button{display:flex;align-items:baseline;gap:10px;padding:0;border:0;background:transparent;text-align:left}.devflow-phase-lane header strong{font-size:14px}.devflow-phase-lane header span{color:var(--blue);font:10px var(--ds-font-family-code,ui-monospace,monospace);text-transform:uppercase}.devflow-phase-lane header p{margin:5px 0 0;color:var(--muted);font-size:12px;line-height:1.4}.devflow-phase-lane li[data-related=false]{opacity:.44}.devflow-relation-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 9px;color:var(--muted);background:rgba(84,184,211,.06);font:10px var(--ds-font-family-code,ui-monospace,monospace)}.devflow-relation-row>span:first-child{color:var(--violet)}.devflow-relation-row button{padding:0;border:0;background:transparent;color:var(--ink);text-decoration:underline;text-decoration-color:rgba(84,184,211,.45);text-underline-offset:3px}.devflow-relation-row em{margin-left:auto;color:var(--blue);font-style:normal}.devflow-execution-row{display:block;width:100%;padding:7px 9px;border:0;border-top:1px solid rgba(177,201,219,.1);background:transparent;color:var(--green);font:10px var(--ds-font-family-code,ui-monospace,monospace);text-align:left}
.devflow-agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-top:10px}.devflow-agent-card{display:flex;flex-direction:column;gap:5px;padding:11px;border:1px solid var(--line);background:rgba(13,23,35,.36);text-align:left}.devflow-agent-card[data-related=false]{opacity:.44}.devflow-agent-card strong{font-size:12px}.devflow-agent-card span,.devflow-agent-card em{font:10px var(--ds-font-family-code,ui-monospace,monospace);font-style:normal}.devflow-agent-card span{color:var(--muted)}.devflow-agent-card em{color:var(--muted)}.devflow-agent-card em[data-status=working]{color:var(--blue)}.devflow-agent-card em[data-status=blocked]{color:var(--amber)}.devflow-agent-card em[data-status=done]{color:var(--green)}.devflow-agent-card em[data-status=archived]{color:var(--muted)}
.devflow-activity li button{display:grid;grid-template-columns:auto 1fr;column-gap:10px;width:100%;padding:8px 0;border:0;border-bottom:1px solid rgba(177,201,219,.1);background:transparent;text-align:left}.devflow-activity time{grid-row:span 2;color:var(--blue);font:10px var(--ds-font-family-code,ui-monospace,monospace)}.devflow-activity strong{font-size:11px}.devflow-activity span{color:var(--muted);font-size:11px}
.devflow-inspector-shell{min-width:0}.devflow-inspector-toggle{display:none}.devflow-inspector{position:sticky;top:0;max-height:calc(100vh - 150px);overflow:auto;padding:17px}.devflow-inspector>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--line)}.devflow-inspector h2{margin:0;font-size:18px;line-height:1.2}.devflow-back-button{padding:5px 8px;border:1px solid var(--line);border-radius:4px;background:transparent;color:var(--blue);font-size:11px}.devflow-detail-list{margin:0}.devflow-detail-list div{padding:11px 0;border-bottom:1px solid rgba(177,201,219,.1)}.devflow-detail-list dt{color:var(--muted);font:10px var(--ds-font-family-code,ui-monospace,monospace);text-transform:uppercase}.devflow-detail-list dd{margin:4px 0 0;overflow-wrap:anywhere;color:var(--ink);font-size:12px;line-height:1.45}.devflow-detail-note{margin:14px 0 0;padding:10px;border-left:2px solid var(--blue);background:rgba(84,184,211,.06);color:var(--muted);font-size:12px;line-height:1.45}.devflow-related-actions,.devflow-source-details{margin-top:17px;padding-top:14px;border-top:1px solid var(--line)}.devflow-related-actions h3,.devflow-source-details h3{margin:0 0 9px;color:var(--blue);font-size:10px;letter-spacing:.1em;text-transform:uppercase}.devflow-related-actions button{display:block;width:100%;margin-top:5px;padding:8px 9px;border:1px solid rgba(177,201,219,.12);background:rgba(84,184,211,.05);color:var(--ink);font-size:11px;text-align:left}.devflow-safe-summaries{margin-top:17px;padding-top:14px;border-top:1px solid var(--line)}.devflow-safe-summaries h3{margin:0 0 9px;color:var(--blue);font-size:10px;letter-spacing:.1em;text-transform:uppercase}.devflow-safe-summaries article{margin-top:7px;padding:8px 9px;border-left:2px solid rgba(84,184,211,.45);background:rgba(84,184,211,.04)}.devflow-safe-summaries article>small{display:block;color:var(--muted);font:9px/1.4 var(--ds-font-family-code,ui-monospace,monospace)}.devflow-safe-summaries article>div{margin-top:7px}.devflow-safe-summaries article strong{display:block;color:var(--muted);font:10px var(--ds-font-family-code,ui-monospace,monospace);text-transform:uppercase}.devflow-safe-summaries article p{margin:4px 0 0;overflow-wrap:anywhere;color:var(--ink);font-size:11px;line-height:1.45}.devflow-safe-summaries article em{color:var(--amber);font-style:normal}.devflow-source-details ul{display:grid;gap:6px;margin:0;padding-left:17px;color:var(--muted);font-size:11px;line-height:1.4}.devflow-source-details p{margin:10px 0 0;color:var(--muted);font-size:11px;line-height:1.45}.devflow-muted{margin:10px 0;color:var(--muted);font-size:12px;line-height:1.4}.devflow-inspector-tabs{display:flex;flex-wrap:wrap;gap:5px;margin:14px 0 0;padding:2px 2px 12px;border-bottom:1px solid var(--line)}.devflow-inspector-tabs button{flex:0 1 auto;min-width:0;padding:6px 8px;border:1px solid var(--line);background:transparent;color:var(--muted);font-size:11px}.devflow-inspector-tabs button[data-selected=true]{border-color:var(--blue);background:rgba(84,184,211,.1);color:var(--blue)}.devflow-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:14px}.devflow-panel-heading>div{display:flex;align-items:center;flex-wrap:wrap;gap:7px}.devflow-panel-heading h3{margin:0;color:var(--blue);font-size:10px;letter-spacing:.1em;text-transform:uppercase}.devflow-tools{min-width:0}.devflow-tool-list{display:flex;flex-direction:column;gap:8px;margin:13px 0;padding:0;list-style:none}.devflow-tool-list>li{display:grid;gap:8px;min-width:0;padding:10px;border:1px solid var(--line);border-left:3px solid var(--blue);background:rgba(84,184,211,.04)}.devflow-tool-list>li[data-status=succeeded]{border-left-color:var(--green)}.devflow-tool-list>li[data-status=failed],.devflow-tool-list>li[data-status=result-without-call]{border-left-color:var(--red)}.devflow-tool-title{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.devflow-tool-title strong{min-width:0;overflow-wrap:anywhere;font-size:12px}.devflow-tool-title em{flex:0 0 auto;color:var(--blue);font:10px var(--ds-font-family-code,ui-monospace,monospace);font-style:normal}.devflow-tool-list>li[data-status=succeeded] .devflow-tool-title em{color:var(--green)}.devflow-tool-list>li[data-status=failed] .devflow-tool-title em,.devflow-tool-list>li[data-status=result-without-call] .devflow-tool-title em{color:var(--red)}.devflow-tool-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:0}.devflow-tool-meta div{min-width:0;padding:7px;background:rgba(13,23,35,.45)}.devflow-tool-meta dt{color:var(--muted);font:9px var(--ds-font-family-code,ui-monospace,monospace);text-transform:uppercase}.devflow-tool-meta dd{margin:3px 0 0;overflow-wrap:anywhere;color:var(--ink);font:10px/1.4 var(--ds-font-family-code,ui-monospace,monospace)}.devflow-tool-summary,.devflow-tool-relation{margin:0;color:var(--muted);font-size:11px;line-height:1.4}.devflow-tool-relation{color:var(--amber)}.devflow-tools-unavailable,.devflow-tools-stale{margin:11px 0;padding:8px 9px;border-left:2px solid var(--red);background:rgba(238,129,126,.1);color:var(--red);font-size:11px;line-height:1.4}.devflow-tools-stale{border-left-color:var(--amber);background:rgba(241,184,107,.1);color:var(--amber)}.devflow-audit{padding-top:14px}.devflow-audit-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.devflow-audit-heading h3{margin:0 0 7px;color:var(--blue);font-size:10px;letter-spacing:.1em;text-transform:uppercase}.devflow-audit-heading>div{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.devflow-audit-list{display:flex;flex-direction:column;gap:8px;margin:13px 0;padding:0;list-style:none}.devflow-audit-list li{display:grid;gap:6px;padding:10px;border:1px solid var(--line);border-left:3px solid var(--blue);background:rgba(84,184,211,.04)}.devflow-audit-list li[data-incomplete=true]{border-left-color:var(--amber)}.devflow-audit-meta{display:flex;justify-content:space-between;gap:8px;color:var(--muted);font:9px var(--ds-font-family-code,ui-monospace,monospace)}.devflow-audit-list strong{font-size:11px}.devflow-audit-list em{color:var(--blue);font:10px var(--ds-font-family-code,ui-monospace,monospace);font-style:normal}.devflow-audit-list button{width:max-content;max-width:100%;padding:0;border:0;background:transparent;color:var(--ink);font-size:11px;text-align:left;text-decoration:underline;text-decoration-color:rgba(84,184,211,.45);text-underline-offset:3px}.devflow-audit-list p{margin:0;color:var(--muted);font-size:11px;line-height:1.4}.devflow-audit-list small{color:var(--amber);font:9px var(--ds-font-family-code,ui-monospace,monospace)}.devflow-audit-action{padding:6px 8px;border:1px solid var(--line);background:rgba(84,184,211,.05);color:var(--blue);font-size:11px}.devflow-audit-action:disabled{cursor:wait;opacity:.55}.devflow-audit-error,.devflow-audit-stale{margin:11px 0;padding:8px 9px;border-left:2px solid var(--red);background:rgba(238,129,126,.1);color:var(--red);font-size:11px;line-height:1.4}.devflow-audit-stale{border-left-color:var(--amber);background:rgba(241,184,107,.1);color:var(--amber)}
.devflow-activation-failure{display:flex;flex-direction:column;gap:3px;margin:0 0 12px;padding:9px 12px;border-left:3px solid var(--red);background:rgba(238,129,126,.1)}.devflow-activation-failure-head{color:var(--ink);font-size:13px;font-weight:600;line-height:1.45}.devflow-activation-failure-code{color:var(--muted);font:10px var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.02em;overflow-wrap:anywhere}.devflow-activation-failure-reason{color:var(--muted);font-size:11px;line-height:1.45}.devflow-activation-failure-meta{color:var(--muted);font:10px var(--ds-font-family-code,ui-monospace,monospace)}
@media (max-width:1179px){.devflow-workspace{grid-template-columns:minmax(230px,270px) minmax(0,1fr)}.devflow-inspector-shell{position:fixed;z-index:20;right:0;bottom:0;top:0;width:min(420px,92vw);padding:70px 0 0;pointer-events:none}.devflow-inspector{visibility:hidden;height:100%;max-height:none;transform:translateX(101%);transition:transform .18s ease;box-shadow:-18px 0 36px rgba(0,0,0,.32);pointer-events:auto}.devflow-inspector-shell[data-open=true] .devflow-inspector{visibility:visible;transform:translateX(0)}.devflow-inspector-toggle{display:block;position:absolute;right:0;top:93px;padding:8px 10px;border:1px solid var(--line);border-right:0;background:var(--panel);color:var(--blue);pointer-events:auto;font-size:11px}.devflow-inspector-shell[data-open=true] .devflow-inspector-toggle{right:min(420px,92vw)}}
@media (max-width:767px){.devflow-canvas{padding:14px 12px 28px}.devflow-identity-bar{align-items:flex-start}.devflow-freshness{width:100%;margin-left:0}.devflow-workspace{display:flex;flex-direction:column;gap:12px}.devflow-navigation{max-height:none;padding:9px}.devflow-navigation-collapse>summary{display:list-item;padding:5px;color:var(--blue);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}.devflow-navigation-collapse:not([open]) .devflow-navigation-groups{display:none}.devflow-overview{padding:13px}.devflow-overview-header{flex-direction:column}.devflow-overview-header dl{width:100%}.devflow-inspector-shell{position:static;width:auto;padding:0;pointer-events:auto}.devflow-inspector-toggle{display:block;position:static;width:100%;border:1px solid var(--line);border-radius:0;background:var(--panel);text-align:left}.devflow-inspector{display:none;visibility:visible;position:static;height:auto;max-height:none;transform:none;box-shadow:none}.devflow-inspector-shell[data-open=true] .devflow-inspector{display:block}.devflow-inspector-shell[data-open=true] .devflow-inspector-toggle{right:auto}.devflow-agent-grid{grid-template-columns:1fr}.devflow-activity li button{grid-template-columns:1fr}.devflow-activity time{grid-row:auto}.devflow-inspector-tabs button{flex:1 1 120px}.devflow-tool-meta{grid-template-columns:1fr}.devflow-tool-title{flex-direction:column}.devflow-tool-title em{flex-basis:auto}}
@media (prefers-reduced-motion:reduce){.devflow-canvas *{scroll-behavior:auto!important;transition:none!important}}
${`
/* ===== 皮肤变量 ===== */
.devflow-canvas.devflow-flow{
  --flow-run:var(--blue);--flow-done:var(--green);--flow-warn:var(--amber);--flow-bad:var(--red);--flow-lost:#6b7d8f;
  --flow-link:#4a7fa8;
  /* 流动亮头：比语义色更亮的同色相高亮（§一·前.1）。三种速率各一档，排队最弱。 */
  --flow-glow:${FLOW_GLOW_GOLD};--flow-glow-rework:${FLOW_GLOW_REWORK_GOLD};--flow-glow-weak:#8fb6d8;
  --flow-ink:#e8eef4;--flow-muted:#93a4b4;--flow-line:rgba(177,201,219,.28);--flow-line-soft:rgba(177,201,219,.14);
  --flow-bg:rgba(14,25,38,.74);--flow-surface-solid:#16283a;--flow-card:rgba(24,42,60,.56);
  --flow-panel:rgba(13,23,35,.78);--flow-chip:rgba(13,23,35,.70);--flow-inset:rgba(255,255,255,.07);--flow-sheen:rgba(255,255,255,.06);
  --flow-accent:var(--blue);--flow-accent-ink:#dff3fb;--flow-accent-soft:rgba(84,184,211,.16);
  --flow-shadow:0 6px 18px rgba(0,0,0,.28);
  --flow-grid:rgba(177,201,219,.07);
  --flow-blur:16px;
}
/* 暗金：深底 + 克制的暗金点缀（徽标、选中态、关键分隔、图标描边）。 */
html[data-devflow-skin=gold] .devflow-canvas.devflow-flow{
  --flow-bg:rgba(12,14,18,.72);--flow-surface-solid:#191d25;--flow-card:rgba(32,36,46,.54);
  --flow-panel:rgba(16,18,23,.80);--flow-chip:rgba(16,18,23,.70);
  --flow-ink:#efe7d8;--flow-muted:#a2967f;--flow-line:rgba(214,188,132,.30);--flow-line-soft:rgba(214,188,132,.16);
  --flow-accent:#d8b45a;--flow-accent-ink:#f6e9c8;--flow-accent-soft:rgba(216,180,90,.16);
  --flow-inset:rgba(255,255,255,.06);--flow-sheen:rgba(255,255,255,.07);
  --flow-shadow:0 8px 22px rgba(0,0,0,.42);
  --flow-grid:rgba(214,188,132,.06);
  /* 暗金皮肤：亮头维持"比语义色更亮"的同色相高亮，不引入金色。 */
  --flow-glow:${FLOW_GLOW_GOLD};--flow-glow-rework:${FLOW_GLOW_REWORK_GOLD};--flow-glow-weak:#8fb6d8;
}
/* 浅色：干净的白/浅灰底、iOS 扁平（弱阴影、统一圆角、留白充足）。
   五态色只做"同色相加深"，保证浅底上的对比度；关系线型完全不变。 */
html[data-devflow-skin=light] .devflow-canvas.devflow-flow{
  --flow-run:#0b6f8d;--flow-done:#12734f;--flow-warn:#96620f;--flow-bad:#b3261e;--flow-lost:#6b7280;
  --flow-link:#7c8794;
  --flow-ink:#1c1c1e;--flow-muted:#6b7280;--flow-line:rgba(60,60,67,.18);--flow-line-soft:rgba(60,60,67,.10);
  --flow-bg:rgba(247,247,249,.80);--flow-surface-solid:#ffffff;--flow-card:rgba(255,255,255,.70);
  --flow-panel:rgba(255,255,255,.84);--flow-chip:rgba(255,255,255,.78);
  --flow-accent:#0a84ff;--flow-accent-ink:#0a3f78;--flow-accent-soft:rgba(10,132,255,.12);
  --flow-inset:rgba(255,255,255,.9);--flow-sheen:rgba(255,255,255,.85);
  --flow-shadow:0 1px 2px rgba(0,0,0,.06);
  --flow-grid:rgba(60,60,67,.05);
  /* 浅色皮肤：白底上必须有足够对比，所以亮头取同色相"更深更饱和"的一档。 */
  --flow-glow:${FLOW_GLOW_LIGHT};--flow-glow-rework:${FLOW_GLOW_REWORK_LIGHT};--flow-glow-weak:#5f7f9c;
}
html[data-devflow-skin=light] .devflow-canvas.devflow-flow{background:var(--flow-surface-solid);color:var(--flow-ink)}

/* 面板必须"正好装进宿主给的面板槽"：.devflow-canvas 默认是 content-box，
   height:100% 再加 18/36 的上下内边距就会比槽高 54px ⇒ 宿主面板体变成可滚动，
   滚轮在画布上会把它滚走（R2 实测：整块面板上移 54px）。改成 border-box 后
   面板体没有可滚动余量，画布滚轮只做缩放。 */
.devflow-canvas.devflow-flow{box-sizing:border-box;height:100%;min-height:0;padding:0;overflow:hidden;overscroll-behavior:contain;color:var(--flow-ink)}
.devflow-flow{display:flex;flex-direction:column;gap:0;height:100%;min-height:0;overflow:hidden}
.devflow-flow-canvas{position:relative;display:flex;flex:1 1 auto;min-height:0;min-width:0}
/* 液态玻璃：面板容器一层，卡片一层，侧栏与底部提示行各一层——数量受控。 */
.devflow-flow-viewport{position:relative;flex:1 1 auto;height:100%;min-width:0;min-height:0;box-sizing:border-box;border:1px solid var(--flow-line);border-radius:12px;background:var(--flow-bg);-webkit-backdrop-filter:blur(var(--flow-blur)) saturate(140%);backdrop-filter:blur(var(--flow-blur)) saturate(140%);overflow:hidden;overflow:clip;cursor:grab;touch-action:none;user-select:none;overscroll-behavior:contain}
.devflow-flow-viewport[data-panning=true]{cursor:grabbing}
.devflow-flow-grid{position:absolute;inset:0;background-image:linear-gradient(var(--flow-grid) 1px,transparent 1px),linear-gradient(90deg,var(--flow-grid) 1px,transparent 1px);background-size:24px 24px}
.devflow-flow-world{position:absolute;left:0;top:0;transform-origin:0 0}
.devflow-flow-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:1}
/* 关系看线型（dash pattern），状态看颜色（stroke）。皮肤只改背景层，这两条不变。 */
.devflow-flow-edge{fill:none;stroke:var(--flow-link);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.devflow-flow-edge[data-edge-semantic=requirement]{stroke-width:1.2;stroke-dasharray:2 3}
.devflow-flow-edge[data-edge-semantic=dispatch]{stroke-dasharray:none}
.devflow-flow-edge[data-edge-semantic=delivery]{stroke-dasharray:9 3 2 3}
.devflow-flow-edge[data-edge-semantic=rework]{stroke-dasharray:12 4}
.devflow-flow-edge[data-edge-semantic=subagent]{stroke-dasharray:2 4}
.devflow-flow-edge[data-edge-state=executing]{stroke:var(--flow-run)}
.devflow-flow-edge[data-edge-state=done]{stroke:var(--flow-done)}
.devflow-flow-edge[data-edge-state=rework]{stroke:var(--flow-bad)}
/* 第五态：未收尾/失联——灰、细、更稀的虚线（静态，不流动）。 */
.devflow-flow-edge[data-edge-state=lost]{stroke:var(--flow-lost);stroke-width:1.1;stroke-dasharray:14 6;opacity:.8}
/* 第六种表现：收尾终态（第四步）。它不是"失联"——它是"这条派发已经收尾了"，所以用
   更沉、更整齐的点线（明确"结束"，不暗示"还在等"），并且**一律静止**
   （动 = 正在发生；收尾不是正在发生）。这是本轮唯一新增的表现，五态语义/颜色/图例未动。 */
.devflow-flow-edge[data-edge-state=closed]{stroke:var(--flow-lost);stroke-width:1.3;stroke-dasharray:2 4;opacity:.55}
.devflow-flow-edge[data-selected=true]{stroke-width:3.2}
.devflow-flow-arrow{fill:none;stroke:var(--flow-link);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.devflow-flow-arrow[data-arrow-state=executing]{stroke:var(--flow-run)}
.devflow-flow-arrow[data-arrow-state=done]{stroke:var(--flow-done)}
.devflow-flow-arrow[data-arrow-state=rework]{stroke:var(--flow-bad)}
.devflow-flow-arrow[data-arrow-state=lost]{stroke:var(--flow-lost);opacity:.8}
.devflow-flow-arrow[data-edge-semantic=requirement]{stroke:var(--flow-muted)}
.devflow-flow-edge-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.devflow-flow-edge-label{fill:var(--flow-muted);font-size:10px;font-family:var(--ds-font-family-code,ui-monospace,monospace);pointer-events:none}
/* ===== 线的动效（第三步C）：动 = 正在发生，静止 = 已经结束 =====
   纯 SVG 属性 + CSS 动画：没有 requestAnimationFrame 循环、没有逐帧读布局。
   流动虚线的周期恒为 96px，位移速度 = 周期 / 时长，时长由
   motion.ts 的 motionProfile() 按状态算好、写在元素行内样式里，所以
   执行中 = 52px/s、返工 = 1.4×、排队 = 0.5×，方向恒为"起点 → 终点"。
   动效元素恒定存在（身份不随数据刷新重建），静止状态只是被隐藏。
   §一·前.1：亮头 12px ⇒ 32px（周期仍 96px，速度公式不变），
   描边加粗一档、不透明度 1.0，颜色取 --flow-glow（比语义色更亮的同色相高亮）。
   层次不丢：排队仍最弱（更细 + 半透明），已完成仍只掠一次，未收尾仍静止。 */
.devflow-flow-flow{fill:none;stroke:var(--flow-glow);stroke-width:${FLOW_FLOW_WIDTH};stroke-linecap:round;stroke-dasharray:32 64;opacity:1;animation:devflow-flow-run 1.846s linear infinite;pointer-events:none}
g[data-flow-rate=still] .devflow-flow-flow,g[data-flow-rate=paused] .devflow-flow-flow{visibility:hidden;animation:none}
g[data-flow-rate=strong] .devflow-flow-flow{stroke:var(--flow-glow-rework);stroke-width:${FLOW_FLOW_WIDTH}}
g[data-flow-rate=weak] .devflow-flow-flow{stroke:var(--flow-glow-weak);stroke-width:3;opacity:${FLOW_FLOW_OPACITY_WEAK}}
/* 高亮 / 选中的线停下来：这时用户看的是"这一条是什么"，而不是"它在不在跑"。
   半透明只给高亮态，执行中/返工在正常阅读时保持 1.0。 */
g[data-highlight=true] .devflow-flow-flow,.devflow-flow-edge[data-selected=true]~.devflow-flow-flow{animation-play-state:paused;opacity:.35}
@keyframes devflow-flow-run{from{stroke-dashoffset:0}to{stroke-dashoffset:-96}}
/* 刚刚完成：沿"起点 → 终点"扫一次（pathLength 归一化到 100，虚线 100 100 即"整条线"，
   偏移 100 → 0 就是从起点画到终点），${FLOW_SWEEP_SECONDS}s 内跑完并淡出，此后永久静止。 */
.devflow-flow-sweep{fill:none;stroke:var(--flow-done);stroke-width:2.8;stroke-linecap:round;stroke-dasharray:100 100;visibility:hidden;pointer-events:none}
g[data-fresh=true] .devflow-flow-sweep{visibility:visible;animation:devflow-flow-done ${FLOW_SWEEP_SECONDS}s ease-out 1 both}
@keyframes devflow-flow-done{0%{stroke-dashoffset:100;opacity:0}12%{opacity:.95}72%{opacity:.8}100%{stroke-dashoffset:0;opacity:0}}
/* 卡片的当场生成：data-enter=true 时播一次。
   入场只改透明度与极小缩放，**不改尺寸/位置/边框/语义色**——其它节点因此一动不动
   （不位移画布其它节点是本轮的硬约束）；一次性、≤FLOW_ENTER_MS，之后永久静止。
   data-enter 由纯函数判定"本次渲染里该 id 还没被见过"：首帧也入场（boss 2026-09-18
   裁决 A）⇒ 打开画布 / 刷新 / 切换会话 / 切换皮肤都会全量入场一次；同一批节点重复
   渲染不入场，空闲画布仍然不会自我驱动。 */
@keyframes devflow-flow-enter{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:scale(1)}}
.devflow-flow-card[data-enter=true]{animation:devflow-flow-enter ${(420 / 1e3).toFixed(3)}s ease-out 1 both}
/* 真实变化才重新武装流动层：data-rearmed 只作取证标记，动画本身仍由 data-flow-rate
   决定（静止/暂停一律不动的铁律不受影响）。 */
g[data-rearmed=true] .devflow-flow-flow{will-change:stroke-dashoffset}
/* 阶段关联：R2 起**画布上不再画任何**阶段元素（无框、无名、无计数、无左侧栏）。
   这里只剩右侧栏列表里用到的一个状态点。 */
.devflow-flow-banddot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--flow-muted)}
.devflow-flow-banddot[data-status=in_progress]{background:var(--flow-run)}
.devflow-flow-banddot[data-status=completed]{background:var(--flow-done)}
/* 角色卡片：玻璃质感比其它容器明显一点（更厚的模糊 + 内侧高光），但不用发光/噪点/霓虹。
   box-sizing:border-box 必需：布局按 FLOW_NODE_WIDTH 预留宽度。 */
.devflow-flow-card{position:absolute;z-index:2;box-sizing:border-box;padding:9px 10px;border:1px solid var(--flow-line);border-radius:14px;background:var(--flow-card);background-image:linear-gradient(180deg,var(--flow-sheen),rgba(255,255,255,0) 46%);-webkit-backdrop-filter:blur(22px) saturate(165%);backdrop-filter:blur(22px) saturate(165%);box-shadow:var(--flow-shadow),inset 0 1px 0 var(--flow-inset);cursor:grab;touch-action:none}
.devflow-flow-card:active{cursor:grabbing}
.devflow-flow-card[data-kind=requirement]{border-color:var(--flow-line)}
.devflow-flow-card[data-kind=commander]{border-color:var(--flow-accent)}
.devflow-flow-card[data-kind=temporary]{border-style:dashed}
.devflow-flow-card[data-state=done]{border-color:var(--flow-done)}
.devflow-flow-card[data-state=rework]{border-color:var(--flow-bad)}
/* 收尾终态：中性点线边框，和"未收尾"的灰虚线区分开（收尾是结束，不是悬着）。 */
.devflow-flow-card[data-state=closed]{border-color:var(--flow-lost);border-style:dotted}
.devflow-flow-card[data-selected=true]{box-shadow:0 0 0 2px var(--flow-accent-soft),var(--flow-shadow)}
.devflow-flow-card[data-highlight=true]{box-shadow:0 0 0 2px var(--flow-warn),var(--flow-shadow)}
.devflow-flow-name{margin:0;font-size:13px;font-weight:600;color:var(--flow-ink)}
.devflow-flow-sub{margin:2px 0 0;color:var(--flow-muted);font-size:11px}
/* 卡片只放摘要：任务标题最多两行，超出省略（详情在右侧栏）。 */
.devflow-flow-task{display:-webkit-box;margin:6px 0 0;overflow:hidden;color:var(--flow-ink);font-size:12px;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.devflow-flow-skill{margin:4px 0 0;color:var(--flow-muted);font-size:11px;overflow-wrap:anywhere}
.devflow-flow-badge{display:inline-block;margin-top:6px;padding:1px 7px;border:1px solid var(--flow-line);border-radius:999px;color:var(--flow-muted);font-size:11px}
.devflow-flow-badge.run{color:var(--flow-run);border-color:var(--flow-run)}
.devflow-flow-badge.done{color:var(--flow-done);border-color:var(--flow-done)}
.devflow-flow-badge.wait{color:var(--flow-warn);border-color:var(--flow-warn)}
.devflow-flow-badge.bad{color:var(--flow-bad);border-color:var(--flow-bad)}
.devflow-flow-badge.queue{color:var(--flow-muted);border-style:dashed}
.devflow-flow-badge.lost{color:var(--flow-lost);border-color:var(--flow-lost);border-style:dashed}
/* 已暂停（§一·前.2）：派发被暂停不是"未收尾"，所以实线 + 中性色，不借用失联的样式。 */
.devflow-flow-badge.paused{color:var(--flow-muted);border-color:var(--flow-muted);border-style:solid}
/* 已收尾（第四步）：终态，中性色点线；它既不是"失联"也不是"完成"。 */
.devflow-flow-badge.closed{color:var(--flow-lost);border-color:var(--flow-lost);border-style:dotted}
.devflow-flow-tag{display:inline-block;margin-left:5px;padding:0 5px;border:1px solid var(--flow-line);border-radius:999px;color:var(--flow-muted);font-size:10px}
.devflow-flow-tag.live{color:var(--flow-run);border-color:var(--flow-run)}
.devflow-flow-tag.plan{color:var(--flow-accent);border-color:var(--flow-accent)}
.devflow-flow-tag.subagent{color:var(--flow-accent);border-color:var(--flow-accent)}
.devflow-flow-tag.user{color:var(--flow-muted);border-color:var(--flow-line)}
/* ===== 卡片边框的动效（第三步C）：同样只有"正在发生"才动 =====
   执行中 = 一圈 4s 的绕行高光 + 4s 的明暗呼吸；返工 = 3.4s、更亮一点但绝不闪；
   排队 = 静态虚线且更弱；已完成 / 未收尾 / 待派发 = 完全静止。
   高光画在 ::after 上（1px 内环 + mask 挖空），卡片自己的 border-color 和
   box-shadow 一分不动 —— 所以选中环、指挥官金边、卡片高度都不受影响。
   @property 让 --flow-beam 成为可插值的角度；不支持 @property 的引擎只是
   高光不绕行（呼吸仍在），不会闪。mask-composite 不支持时整块降级不画。 */
@property --flow-beam{syntax:'<angle>';inherits:false;initial-value:0deg}
@supports ((-webkit-mask-composite:xor) or (mask-composite:exclude)){
  .devflow-flow-card::after{position:absolute;inset:0;padding:1px;border-radius:inherit;background:conic-gradient(from var(--flow-beam),transparent 0deg,var(--flow-beam-color,var(--flow-run)) 42deg,transparent 118deg);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;opacity:0;pointer-events:none;content:''}
  .devflow-flow-card[data-state=active]::after{--flow-beam-color:var(--flow-run);animation:devflow-flow-beam 4s linear infinite,devflow-flow-breathe 4s ease-in-out infinite}
  .devflow-flow-card[data-state=rework]::after{--flow-beam-color:var(--flow-bad);animation:devflow-flow-beam 3.4s linear infinite,devflow-flow-breathe-strong 3.4s ease-in-out infinite}
}
@keyframes devflow-flow-beam{from{--flow-beam:0deg}to{--flow-beam:360deg}}
@keyframes devflow-flow-breathe{0%,100%{opacity:.28}50%{opacity:.66}}
@keyframes devflow-flow-breathe-strong{0%,100%{opacity:.42}50%{opacity:.92}}
/* 已暂停（§一·前.2）：卡片明确写出"已暂停"，边框回到中性色，卡片动效完全停止
   （铁律"动＝正在发生"：暂停就不是正在发生）。恢复后状态与动效一起回来。 */
.devflow-flow-card[data-state=paused]{border-color:var(--flow-muted)}
.devflow-flow-card[data-state=paused]::after{animation:none;opacity:0}
.devflow-flow-card[data-state=planned]:not([data-kind=requirement]){border-style:dashed;border-color:var(--flow-line-soft)}
/* 浮层：全部 absolute 叠在画布上，文本变化不会推动画布盒子（防跳动）。 */
.devflow-flow-float{position:absolute;z-index:3;pointer-events:none;box-sizing:border-box}
.devflow-flow-info{left:10px;top:10px;display:flex;flex-direction:column;gap:4px;max-width:calc(100% - 60px)}
.devflow-flow-identrow{display:flex;align-items:flex-start;gap:6px}
.devflow-flow-ident{display:block;flex:1 1 auto;min-width:0;overflow-wrap:anywhere;padding:5px 9px;border:1px solid var(--flow-line-soft);border-radius:10px;background:var(--flow-chip);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:var(--flow-muted);font-size:11px;line-height:1.45}
.devflow-flow-ident[data-freshness=refreshing]{color:var(--flow-run);border-color:var(--flow-run)}
.devflow-flow-ident[data-freshness=error]{color:var(--flow-warn);border-color:var(--flow-warn)}
.devflow-flow-ident[data-connection=live]{border-color:var(--flow-line)}
.devflow-flow-ident[data-connection=polling]{border-color:var(--flow-warn)}
/* 皮肤切换：几何图形图标（非 emoji），位于身份行右侧；可 Tab 聚焦、有 aria-label。
   pointer-events:auto 必需 —— 它所在的 .devflow-flow-float 是"穿透"的，缺了这句点击会被穿透掉。 */
.devflow-flow-skin{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--flow-line);border-radius:10px;background:var(--flow-chip);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:var(--flow-accent);pointer-events:auto;cursor:pointer}
.devflow-flow-skin:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-skin:focus-visible{outline:2px solid var(--flow-accent);outline-offset:2px}
.devflow-flow-skinicon{display:block;width:12px;height:12px;border-radius:50%;background:currentColor}
.devflow-flow-skinicon[data-shape=moon]{background:transparent;box-shadow:inset -3.5px -2.5px 0 0 currentColor}
.devflow-flow-skinicon[data-shape=ring]{background:transparent;border:2px solid currentColor}
/* 重新打开概览浮层：几何图标（外框 + 右上角小方点），与皮肤按钮同尺寸同交互。 */
.devflow-flow-overviewicon{position:relative;display:block;width:12px;height:9px;border:1.6px solid currentColor;border-radius:2px}
.devflow-flow-overviewicon::after{position:absolute;right:-3px;top:-4px;width:5px;height:4px;border:1.4px solid currentColor;border-radius:1px;background:var(--flow-chip);content:''}
.devflow-flow-channel{display:block;padding:4px 9px;border:1px solid var(--flow-line-soft);border-radius:10px;background:var(--flow-chip);color:var(--flow-muted);font-size:11px;line-height:1.4;overflow-wrap:anywhere}
.devflow-flow-channel[data-connection=polling]{border-color:var(--flow-warn);color:var(--flow-warn)}
.devflow-flow-zoomchip{display:inline-block;align-self:flex-start;padding:3px 8px;border:1px solid var(--flow-line-soft);border-radius:999px;background:var(--flow-chip);color:var(--flow-muted);font-size:11px}
/* 底部一个纵向栈：提示行 → 图例 → （花名册 + 工具条）。三者同处一个 flex 列，
   高度随内容增长，彼此永远不可能像上一轮那样互相压住（实测曾横向重叠 80–171px）。 */
.devflow-flow-bottomstack{left:10px;right:10px;bottom:10px;z-index:8;display:flex;flex-direction:column;gap:5px;align-items:stretch;padding:7px 9px;border:1px solid var(--flow-line-soft);border-radius:14px;background:var(--flow-panel);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%)}
.devflow-flow-bottom{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.devflow-flow-bottomrow{display:flex;align-items:flex-end;justify-content:flex-start;gap:10px}
.devflow-flow-toolbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:flex-end;max-width:100%;margin-left:auto;pointer-events:auto}
.devflow-flow-action{padding:5px 9px;border:1px solid var(--flow-line);border-radius:10px;background:var(--flow-chip);color:var(--flow-ink);font-size:12px;line-height:1.2}
.devflow-flow-action:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-action[data-primary=true]{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-action[aria-pressed=true]{border-color:var(--flow-accent);background:var(--flow-accent-soft);color:var(--flow-accent-ink)}
html[data-devflow-skin=light] .devflow-flow-action[aria-pressed=true]{color:var(--flow-accent-ink)}
.devflow-flow-viewswitch{display:inline-flex;gap:5px;padding-left:5px;border-left:1px solid var(--flow-line-soft)}
/* 并发上限 N/5（boss 要求必须展现）。放在名册同一区、同一行，和名册一起收缩：
   它是运行事实，不是工具按钮，所以用 chip 样式而非 action 样式。到顶时换成 warn 色
   并追加「已达并发上限 · 后续排队」——上限被看见，排队才不是「悄悄拖时间」。 */
.devflow-flow-concurrency{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;padding:5px 9px;border:1px solid var(--flow-line);border-radius:10px;background:var(--flow-chip);color:var(--flow-ink);font-size:12px;line-height:1.2;pointer-events:auto}
.devflow-flow-concurrency b{font-weight:600}
.devflow-flow-concurrency[data-at-limit=true]{border-color:var(--flow-warn);color:var(--flow-warn)}
.devflow-flow-concurrencynote{color:var(--flow-warn);font-size:11px}
.devflow-flow-roster{flex:0 1 auto;width:min(240px,42vw);pointer-events:auto}
.devflow-flow-rosterhead{display:flex;align-items:center;gap:6px;width:100%;padding:5px 9px;border:1px solid var(--flow-line);border-radius:10px;background:var(--flow-chip);color:var(--flow-ink);text-align:left}
.devflow-flow-rosterkicker{position:absolute;width:1px;height:1px;overflow:hidden;white-space:nowrap}
.devflow-flow-rosterhead strong{flex:1;font-size:12px;font-weight:500}
.devflow-flow-rosterhint{color:var(--flow-muted);font-size:11px}
.devflow-flow-roster[data-open=true] .devflow-flow-rosterhead{border-color:var(--flow-accent);border-bottom-left-radius:0;border-bottom-right-radius:0}
.devflow-flow-rosterbody{max-height:min(320px,46vh);overflow:auto;padding:7px 8px;border:1px solid var(--flow-line);border-top:0;border-radius:0 0 10px 10px;background:var(--flow-panel)}
.devflow-flow-pcard{margin-bottom:6px;border:1px solid var(--flow-line-soft);border-radius:10px;background:var(--flow-surface-solid);padding:7px 9px}
.devflow-flow-rostergroup{margin:8px 0 6px;padding-top:7px;border-top:1px dashed var(--flow-line)}
.devflow-flow-rostergroup>strong{display:block;margin-bottom:4px;color:var(--flow-muted);font-size:11px;font-weight:500}
.devflow-flow-rostergroup>small{display:block;color:var(--flow-muted);font-size:11px}
.devflow-flow-pcard:last-child{margin-bottom:0}
.devflow-flow-pcard[data-plan=true]{border-style:dashed;border-color:var(--flow-warn)}
.devflow-flow-pcardbutton{display:flex;align-items:center;gap:5px;width:100%;padding:0;border:0;background:transparent;text-align:left}
.devflow-flow-pcardbutton strong{flex:1;color:var(--flow-ink);font-size:12px;font-weight:500}
.devflow-flow-pcard>small{display:block;color:var(--flow-muted);font-size:11px}
.devflow-flow-pdet{margin-top:6px;padding-top:6px;border-top:1px solid var(--flow-line-soft);color:var(--flow-muted);font-size:11px}
.devflow-flow-pdet p{margin:0 0 3px;overflow-wrap:anywhere}
.devflow-flow-hint{flex:1 1 auto;min-width:0;color:var(--flow-muted);font-size:11px}
/* 提示压成一行，减少纵向占用，保证画布高度占比。 */
.devflow-flow-notices{display:block;min-width:0;color:var(--flow-warn);font-size:11px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.devflow-flow-notices span{margin-right:12px}
.devflow-flow-legend{display:flex;align-items:center;flex-wrap:wrap;gap:9px;color:var(--flow-muted);font-size:11px;pointer-events:auto}
.devflow-flow-legendgroup{display:inline-flex;align-items:center;gap:8px;padding-right:8px;border-right:1px solid var(--flow-line-soft)}
.devflow-flow-legendgroup:last-of-type{border-right:0}
.devflow-flow-legend span{display:inline-flex;align-items:center;gap:4px}
/* 关系样例：线型 + 箭头方向（颜色跟随状态语义，不由皮肤决定）。 */
.devflow-flow-line{position:relative;display:inline-block;width:22px;height:0;border-top:1.6px solid var(--flow-link)}
.devflow-flow-line::after{position:absolute;right:-1px;top:-3.4px;width:0;height:0;border-top:3px solid transparent;border-bottom:3px solid transparent;border-left:5px solid currentColor;color:var(--flow-link);content:''}
.devflow-flow-line.is-requirement{border-top-style:dotted;border-top-color:var(--flow-muted);color:var(--flow-muted)}
.devflow-flow-line.is-dispatch{border-top-style:solid}
.devflow-flow-line.is-delivery{border-top-style:dashed;border-top-color:var(--flow-done);color:var(--flow-done)}
.devflow-flow-line.is-delivery::after{right:auto;left:-1px;border-left:0;border-right:5px solid currentColor}
.devflow-flow-line.is-rework{border-top-style:dashed;border-top-color:var(--flow-bad);color:var(--flow-bad)}
.devflow-flow-line.is-subagent{border-top-style:dotted}
.devflow-flow-line.is-subagent::after{right:auto;left:-4px;border-left:0;border-right:5px solid currentColor}
/* 状态样例：只表达颜色。 */
.devflow-flow-swatch{display:inline-block;width:16px;height:0;border-top:1.8px solid var(--flow-link)}
.devflow-flow-swatch.is-queued{border-top-color:var(--flow-link)}
.devflow-flow-swatch.is-executing{border-top-color:var(--flow-run)}
.devflow-flow-swatch.is-done{border-top-color:var(--flow-done)}
.devflow-flow-swatch.is-rework{border-top-color:var(--flow-bad)}
.devflow-flow-swatch.is-lost{border-top-color:var(--flow-lost)}
.devflow-flow-legendtoggle{padding:2px 7px;border:1px solid var(--flow-line);border-radius:999px;background:var(--flow-chip);color:var(--flow-ink);font-size:10px;line-height:1.4}
.devflow-flow-legendtoggle:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-legendpanel{right:10px;top:56px;width:min(360px,calc(100% - 20px));max-height:calc(100% - 150px);overflow:auto;overscroll-behavior:contain;pointer-events:auto;padding:11px 12px;border:1px solid var(--flow-line);border-radius:12px;background:var(--flow-panel);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%);box-shadow:var(--flow-shadow);color:var(--flow-muted);font-size:11px;line-height:1.5}
.devflow-flow-legendpanel h3{margin:8px 0 4px;color:var(--flow-accent);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.devflow-flow-legendpanel h3:first-child{margin-top:0}
.devflow-flow-legendpanel ul{margin:0;padding:0;list-style:none}
.devflow-flow-legendpanel li{display:flex;align-items:center;gap:7px;padding:3px 0}
.devflow-flow-legendnote{margin:9px 0 0;padding:7px 8px;border-left:2px solid var(--flow-accent);background:var(--flow-accent-soft);color:var(--flow-muted);font-size:11px}
.devflow-flow-note{left:10px;right:10px;top:64px;pointer-events:auto;margin:0;padding:7px 9px;border:1px solid var(--flow-warn);border-radius:10px;background:var(--flow-panel);color:var(--flow-warn);font-size:11px;line-height:1.45}
/* 交接详情与节点详情共用右侧栏；这里只保留旧的浮层类名以兼容既有用例。 */
.devflow-flow-xfer{right:10px;top:56px;width:min(340px,calc(100% - 20px));max-height:calc(100% - 150px);overflow:auto;overscroll-behavior:contain;pointer-events:auto;padding:11px 12px;border:1px solid var(--flow-line);border-radius:12px;background:var(--flow-panel);box-shadow:var(--flow-shadow)}
.devflow-flow-xfer>header h3{margin:2px 0 0;font-size:14px;color:var(--flow-ink)}
.devflow-flow-table{margin:8px 0 0}
.devflow-flow-table>div{padding:7px 0;border-bottom:1px solid var(--flow-line-soft)}
.devflow-flow-table dt{color:var(--flow-muted);font:10px var(--ds-font-family-code,ui-monospace,monospace);text-transform:uppercase}
.devflow-flow-table dd{margin:3px 0 0;overflow-wrap:anywhere;color:var(--flow-ink);font-size:12px;line-height:1.45}
.devflow-flow-xferdetail{margin:9px 0 0;padding:8px 9px;border-left:2px solid var(--flow-accent);background:var(--flow-accent-soft);color:var(--flow-muted);font-size:12px;line-height:1.45;overflow-wrap:anywhere}
.devflow-flow-xferclose{margin-top:9px;padding:4px 9px;border:1px solid var(--flow-line);border-radius:10px;background:transparent;color:var(--flow-ink);font-size:11px}
.devflow-flow-xferclose:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
/* 审计 / 本会话：既有能力的次要入口（工具栏右侧两个按钮），不再占 Tab 栏。 */
/* 状态条抬到底部三条浮层之上：它是会话级提示，可能随时出现，绝不能盖住工具条。 */
.devflow-flow .devflow-refresh-notice,.devflow-flow .devflow-selection-notice,.devflow-flow .devflow-error-notice{position:absolute;left:10px;right:10px;bottom:118px;z-index:9;margin:0;padding:6px 9px;border-radius:10px;background:var(--flow-panel);font-size:11px;line-height:1.4}
.devflow-flow .devflow-refresh-notice{border:1px solid var(--flow-run)}
.devflow-flow .devflow-selection-notice{border:1px solid var(--flow-run)}
.devflow-flow .devflow-error-notice{border:1px solid var(--flow-bad)}
/* 受阻横幅：员工如实上报「做不了」时的可见终态。用警示色 + 一眼可分的中文，
   且**不带任何按钮** —— 它要的是修配置，不是一个可以点的选择。 */
.devflow-flow .devflow-blocked-banner{position:absolute;left:10px;right:10px;top:10px;z-index:11;display:flex;flex-direction:column;gap:4px;margin:0;padding:7px 10px;border:1px solid var(--flow-bad);border-radius:10px;background:var(--flow-panel);font-size:11px;line-height:1.45}
.devflow-flow .devflow-blocked-head{color:var(--flow-bad);font-weight:600}
.devflow-flow .devflow-blocked-row{display:block}
.devflow-flow .devflow-blocked-why{display:block;color:var(--flow-muted);padding-left:10px}
.devflow-flow-panel{display:flex;flex:1 1 auto;flex-direction:column;gap:0;min-height:0;overflow:hidden}
.devflow-flow-secondary{height:100%}
.devflow-flow-secondaryhead{display:flex;align-items:center;gap:10px;flex:0 0 auto;padding:0 0 8px}
.devflow-flow-secondaryhead button{padding:5px 10px;border:1px solid var(--flow-line);border-radius:10px;background:transparent;color:var(--flow-accent);font-size:12px}
.devflow-flow-secondaryhead strong{font-size:13px;color:var(--flow-ink)}
.devflow-flow-secondarybody{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px 12px;border:1px solid var(--flow-line);border-radius:12px;background:var(--flow-panel)}
.devflow-flow .devflow-inspector{padding:0;max-height:none;border:0;background:transparent}
.devflow-flow .devflow-inspector>header{padding-bottom:10px}
.devflow-flow .devflow-inspector h2{font-size:15px}
.devflow-flow .devflow-tools,.devflow-flow .devflow-audit{padding:2px 0 0}
/* 右侧详情栏：节点详情 / 交接详情 / 阶段关联共用同一栏位，一次只显示一种。
   宽档停靠（挤压画布，画布自动重新适配），窄档改为覆盖式抽屉（不挤压画布）。 */
.devflow-flow-inspector{display:flex;flex:0 0 300px;flex-direction:column;gap:0;box-sizing:border-box;width:300px;margin-left:8px;padding:11px 12px;border:1px solid var(--flow-line);border-radius:14px;background:var(--flow-panel);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%);box-shadow:var(--flow-shadow);overflow:auto;overscroll-behavior:contain;color:var(--flow-muted);font-size:12px}
.devflow-flow-inspector[data-mode=drawer]{position:absolute;right:0;top:0;bottom:108px;z-index:12;width:min(320px,calc(100% - 24px));margin-left:0}
.devflow-flow-inspectorhead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--flow-line-soft)}
.devflow-flow-inspectorhead h3{margin:2px 0 0;color:var(--flow-ink);font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.devflow-flow-inspectorclose{flex:0 0 auto;padding:3px 8px;border:1px solid var(--flow-line);border-radius:10px;background:transparent;color:var(--flow-ink);font-size:12px;line-height:1.2}
.devflow-flow-inspectorclose:hover{border-color:var(--flow-accent);color:var(--flow-accent)}
.devflow-flow-inspectorsection{margin:12px 0 5px;color:var(--flow-accent);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.devflow-flow-inspectortask{margin:0 0 6px;color:var(--flow-ink);font-size:12px;line-height:1.45;overflow-wrap:anywhere}
.devflow-flow-mutedline{margin:0 0 6px;color:var(--flow-muted);font-size:11px;line-height:1.45}
.devflow-flow-inspectorlist{margin:0;padding:0;list-style:none}
.devflow-flow-inspectorlist li+li{margin-top:4px}
.devflow-flow-inspectorlist button{display:flex;align-items:center;gap:7px;width:100%;padding:6px 8px;border:1px solid var(--flow-line-soft);border-radius:10px;background:var(--flow-accent-soft);color:var(--flow-ink);text-align:left}
.devflow-flow-inspectorlist button:hover{border-color:var(--flow-accent)}
.devflow-flow-inspectorlist button[data-highlight=true]{border-color:var(--flow-warn);background:var(--flow-accent-soft)}
.devflow-flow-inspectorlinetitle{flex:1 1 auto;min-width:0;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.devflow-flow-inspectorlist small{flex:0 0 auto;color:var(--flow-muted);font:10px var(--ds-font-family-code,ui-monospace,monospace)}
/* ===== 右上角概览浮层（第三步B，shell.overlay 停靠单元） =====
   这是 frame 级浮层里的一个单元，不在画布子树里（所以画布的 .devflow-flow 变量
   在这里读不到，颜色直接用语义变量 + 与皮肤一致的常量兜底）。
   §11.2：浮层默认静止，只用颜色区分状态；唯一的动效是"进行中"状态点的极弱呼吸，
   不叠加玻璃 × 动效的重采样代价。 */
.devflow-ov{position:absolute;top:10px;right:var(--devflow-ov-offset,80px);z-index:4;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(400px,calc(100vw - var(--devflow-ov-offset,80px) - 8px));font-size:12px;line-height:1.45;color:var(--dsw-alias-text-primary,#e8eef4)}
.devflow-ov-pill{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:999px;background:var(--dsw-alias-bg-elevated,rgba(16,18,23,.92));box-shadow:0 2px 8px rgba(0,0,0,.28);color:inherit;font-size:12px;line-height:1.3;cursor:pointer}
.devflow-ov-pill:hover{border-color:var(--dsw-alias-border-l2,#93a4b4)}
.devflow-ov-pill:focus-visible{outline:2px solid var(--dsw-alias-text-accent,#d8b45a);outline-offset:2px}
.devflow-ov-pilltext{font-variant-numeric:tabular-nums}
.devflow-ov-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#6b7d8f}
.devflow-ov-dot[data-posture=active],.devflow-ov-dot[data-state=run]{background:var(--dsw-alias-text-accent,#54b8d3)}
.devflow-ov-dot[data-posture=review],.devflow-ov-dot[data-state=wait]{background:var(--dsw-alias-text-warning,#f1b86b)}
.devflow-ov-dot[data-posture=done],.devflow-ov-dot[data-state=done]{background:var(--dsw-alias-text-success,#6fcf97)}
.devflow-ov-dot[data-state=bad],.devflow-ov-dot[data-state=paused]{background:#ee817e}
.devflow-ov-dot[data-state=queue]{background:#93a4b4}
.devflow-ov-dot[data-state=lost]{background:#6b7d8f}
.devflow-ov-dot[data-state=closed]{background:#55636f}
.devflow-ov-dot[data-state=idle]{background:#6b7d8f}
.devflow-ov-dot[data-state=commander]{background:#d8b45a}
/* §11.2 允许的唯一动效：仅"进行中/返工"的浮标状态点做极弱呼吸（不涉及玻璃重采样）。 */
.devflow-ov[data-posture=active][data-paused=false] .devflow-ov-pill .devflow-ov-dot{animation:devflow-ov-pulse 3.2s ease-in-out infinite}
@keyframes devflow-ov-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.devflow-ov-pillconn{padding:1px 7px;border:1px solid currentColor;border-radius:999px;font-size:11px;opacity:.85}
.devflow-ov-pillconn[data-connection=polling]{color:var(--dsw-alias-text-warning,#f1b86b)}
.devflow-ov-pillconn[data-connection=connecting]{color:#93a4b4}
.devflow-ov-card{width:min(384px,calc(100vw - var(--devflow-ov-offset,80px) - 8px));max-height:min(64vh,560px);overflow:auto;overscroll-behavior:contain;padding:11px 12px;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:14px;background:var(--dsw-alias-bg-elevated,rgba(16,18,23,.92));box-shadow:0 8px 22px rgba(0,0,0,.4)}
.devflow-ov-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l4,rgba(177,201,219,.16))}
.devflow-ov-kicker{margin:0;color:var(--dsw-alias-text-accent,#d8b45a);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.devflow-ov-title{margin:2px 0 0;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.devflow-ov-headactions{display:flex;flex:0 0 auto;gap:5px}
.devflow-ov-icon{width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:8px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer}
.devflow-ov-icon:hover{border-color:var(--dsw-alias-text-accent,#d8b45a)}
.devflow-ov-icon:focus-visible{outline:2px solid var(--dsw-alias-text-accent,#d8b45a);outline-offset:2px}
.devflow-ov-meta{display:flex;flex-wrap:wrap;gap:5px;margin:9px 0 0}
.devflow-ov-chip{padding:1px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:999px;font-size:11px;color:var(--dsw-alias-text-secondary,#93a4b4)}
.devflow-ov-chip[data-state=bound]{color:var(--dsw-alias-text-success,#6fcf97);border-color:currentColor}
.devflow-ov-chip[data-state=unbound]{color:var(--dsw-alias-text-warning,#f1b86b);border-color:currentColor}
.devflow-ov-chip[data-state=paused]{color:#ee817e;border-color:currentColor}
.devflow-ov-chip[data-state=live]{color:var(--dsw-alias-text-success,#6fcf97);border-color:currentColor}
.devflow-ov-chip[data-state=poll]{color:var(--dsw-alias-text-warning,#f1b86b);border-color:currentColor}
.devflow-ov-segments{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:11px 0 0}
.devflow-ov-segment{display:flex;flex-direction:column;gap:4px;min-width:0}
.devflow-ov-segbar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l4,rgba(177,201,219,.16))}
.devflow-ov-segment[data-tone=run] .devflow-ov-segbar{background:var(--dsw-alias-text-accent,#54b8d3)}
.devflow-ov-segment[data-tone=wait] .devflow-ov-segbar{background:var(--dsw-alias-text-warning,#f1b86b)}
.devflow-ov-segment[data-tone=done] .devflow-ov-segbar{background:var(--dsw-alias-text-success,#6fcf97)}
.devflow-ov-segment[data-tone=lost] .devflow-ov-segbar{background:#6b7d8f}
/* 收尾终态：比"未收尾"更沉的点线色，一眼能分开"收尾了"和"还悬着"。 */
.devflow-ov-segment[data-tone=closed] .devflow-ov-segbar{background:#55636f;opacity:.75}
.devflow-ov-seglabel{color:var(--dsw-alias-text-secondary,#93a4b4);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.devflow-ov-segnum{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.devflow-ov-commander{display:flex;align-items:center;gap:7px;margin:11px 0 0;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l4,rgba(177,201,219,.16))}
.devflow-ov-state{color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px}
.devflow-ov-members{margin:6px 0 0;padding:0;list-style:none}
.devflow-ov-members li+li{margin-top:3px}
.devflow-ov-member{display:grid;grid-template-columns:auto auto auto 1fr;align-items:center;gap:7px;width:100%;padding:5px 7px;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;text-align:left;cursor:pointer}
.devflow-ov-member:hover{border-color:var(--dsw-alias-border-l3,rgba(177,201,219,.3))}
.devflow-ov-member:focus-visible{outline:2px solid var(--dsw-alias-text-accent,#d8b45a);outline-offset:1px}
.devflow-ov-membername{font-size:12px;font-weight:500}
.devflow-ov-membertag{margin-left:6px;padding:0 5px;border:1px solid var(--dsw-alias-border-l3,rgba(177,201,219,.3));border-radius:7px;color:var(--dsw-alias-text-secondary,#93a4b4);font-size:10px;font-weight:400;white-space:nowrap}
.devflow-ov-memberstate{color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px;white-space:nowrap}
.devflow-ov-memberstate[data-state=active]{color:var(--dsw-alias-text-accent,#54b8d3)}
.devflow-ov-memberstate[data-state=rework]{color:#ee817e}
.devflow-ov-memberstate[data-state=paused]{color:#ee817e}
.devflow-ov-memberstate[data-state=blocked]{color:var(--dsw-alias-text-warning,#f1b86b)}
.devflow-ov-memberstate[data-state=done]{color:var(--dsw-alias-text-success,#6fcf97)}
.devflow-ov-membertask{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px}
.devflow-ov-tally{margin:9px 0 0;color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px}
.devflow-ov-muted{margin:6px 0 0;color:var(--dsw-alias-text-secondary,#93a4b4);font-size:11px}
.devflow-ov-notice{margin:7px 0 0;padding:5px 8px;border:1px solid var(--dsw-alias-text-warning,#f1b86b);border-radius:9px;color:var(--dsw-alias-text-warning,#f1b86b);font-size:11px}
.devflow-ov-foot{display:flex;justify-content:flex-end;margin:10px 0 0;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l4,rgba(177,201,219,.16))}
.devflow-ov-open{padding:5px 11px;border:1px solid var(--dsw-alias-text-accent,#d8b45a);border-radius:9px;background:transparent;color:var(--dsw-alias-text-accent,#d8b45a);font-size:12px;cursor:pointer}
.devflow-ov-open:hover{background:rgba(216,180,90,.14)}
.devflow-ov-open:focus-visible{outline:2px solid var(--dsw-alias-text-accent,#d8b45a);outline-offset:2px}
@media (max-width:1040px){
  .devflow-ov{max-width:min(320px,calc(100vw - var(--devflow-ov-offset,80px) - 8px))}
  .devflow-ov-card{max-height:56vh}
}
/* 减少动效：浮层本来就只有"进行中"状态点一个极弱动效，这里也一并关掉。 */
@media (prefers-reduced-motion:reduce){
  .devflow-ov *{animation:none!important}
}
/* ===== 降级：不支持背景模糊、或用户要求减少透明时，一律退回实色。 ===== */
@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){
  .devflow-flow-viewport{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
  .devflow-flow-card{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
  .devflow-flow-inspector,.devflow-flow-bottomstack,.devflow-flow-legendpanel,.devflow-flow-ident,.devflow-flow-skin{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
}
@media (prefers-reduced-transparency:reduce){
  .devflow-flow-viewport{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
  .devflow-flow-card{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
  .devflow-flow-inspector,.devflow-flow-bottomstack,.devflow-flow-legendpanel,.devflow-flow-ident,.devflow-flow-skin{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
}
@media (max-width:560px){
  .devflow-flow-info{max-width:calc(100% - 20px)}
  .devflow-flow-bottomrow{flex-wrap:wrap}
  .devflow-flow-toolbar{max-width:100%}
  /* The keyboard hint is the least load-bearing overlay: drop it in the narrow
     column so the toolbar keeps one row and the canvas keeps its height. */
  .devflow-flow-hint{display:none}
  .devflow-flow-xfer{top:auto;bottom:150px;max-height:40%}
  /* 窄栏：图例压小；详情栏走覆盖式抽屉，并让出底部栈高度。 */
  .devflow-flow-legend{gap:6px;font-size:10px}
  .devflow-flow-legendpanel{top:96px;max-height:46%}
  .devflow-flow-inspector[data-mode=drawer]{width:calc(100% - 16px);bottom:186px}
}
/* 减少动效：所有动画一律关掉，且动效层直接不出现（静态信息一分不少）。 */
@media (prefers-reduced-motion:reduce){
  .devflow-flow-edge,.devflow-flow-card,.devflow-flow-card::after{animation:none!important}
  .devflow-flow-flow,.devflow-flow-sweep{animation:none!important;visibility:hidden!important}
}
/* ===== §11.1 玻璃 × 动效的降级路径（性能兜底） =====
   实测（第三步C）：软件光栅器下"backdrop-filter 玻璃 + 正在动的画布"只有约 6fps，
   代价来自玻璃逐帧重采样正在动的背景；关掉动画或关掉玻璃任一即回到 60fps。
   策略：**动画运行期间**（画布上有真正在跑的流动层，或刚刚做过布局/滚动/缩放）把
   叠加在动背景上的玻璃层降级为实色，回到 B 轮已有的实色退化路径；动画停下来的
   1.2s 后自动恢复原先已验收的玻璃观感。降级只切换"背景 + 模糊"，不改动任何布局、
   语义色、动效本身（绝不用"关动效"换性能）。
   由 motion-budget.ts 在画布根节点上写 data-glass-budget=degrade|auto 与
   data-motion=idle|active|degraded。 */
.devflow-flow[data-glass-budget=degrade] .devflow-flow-viewport{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
.devflow-flow[data-glass-budget=degrade] .devflow-flow-card{background:var(--flow-surface-solid);background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none}
.devflow-flow[data-glass-budget=degrade] .devflow-flow-inspector,
.devflow-flow[data-glass-budget=degrade] .devflow-flow-bottomstack,
.devflow-flow[data-glass-budget=degrade] .devflow-flow-legendpanel,
.devflow-flow[data-glass-budget=degrade] .devflow-flow-ident,
.devflow-flow[data-glass-budget=degrade] .devflow-flow-skin{background:var(--flow-surface-solid);-webkit-backdrop-filter:none;backdrop-filter:none}
`}
`;
		/** Inject and remove only this plugin's style sheet. */
		function installDevFlowStyles() {
			const style = document.createElement("style");
			style.dataset.plugin = "@xiaoxie-ide/dsh-devflow";
			style.textContent = DEVFLOW_CSS;
			document.head.append(style);
			return () => {
				style.remove();
			};
		}
		//#endregion
		//#region lib/client/index.js
		const NS = "devflow";
		/** The Agent preset that owns this panel; every other preset sees no DevFlow tab. */
		const DEVFLOW_PRESET_ID = "devflow";
		const inject = [
			"slots",
			"locale",
			"remote",
			"sessions",
			"sidebarRightTabs",
			"sidebarRight"
		];
		/** Mount DevFlow's typed Remote and expose one session-scoped Canvas tab. */
		function apply(ctx) {
			ctx.effect(() => {
				return installDevFlowStyles();
			}, "devflow: styles");
			ctx.effect(() => ctx.locale.register(NS, {
				en: {
					canvas: "DevFlow Canvas",
					sidebarGuideTitle: "DevFlow state",
					sidebarGuideDescription: "Read-only project, phase, task, and dispatch state",
					loading: "Restoring DevFlow state...",
					refreshing: "Refreshing DevFlow state",
					retry: "Retry",
					empty: "No project has been initialized yet. Run /devflow init <name>.",
					unavailable: "DevFlow state is unavailable. Refresh to try again.",
					scopeUnavailable: "This session has no project workspace, so DevFlow refuses to share state: no project data is shown here.",
					project: "Project route",
					team: "Team roster",
					work: "Dispatch ledger",
					assignments: "Assignments",
					noAssignments: "No assignments yet",
					noTasks: "No tasks yet",
					noAgents: "No agents registered",
					pause: "Paused",
					live: "Dispatch live",
					commander: "Commander",
					chat: "Native chat",
					task: "Task",
					phase: "Phase",
					agent: "Agent",
					status: "Status",
					goal: "Goal",
					stage: "Stage",
					decisions: "Decision queue",
					noDecisions: "No pending decisions",
					decisionHistory: "Decision history",
					noDecisionHistory: "No decisions recorded",
					executions: "Execution status",
					noExecutions: "No executions recorded",
					relation: "route"
				},
				zh: {
					canvas: "DevFlow 画布",
					sidebarGuideTitle: "DevFlow 状态",
					sidebarGuideDescription: "只读查看项目、阶段、任务与派发状态",
					loading: "正在恢复 DevFlow 状态...",
					refreshing: "正在刷新 DevFlow 状态",
					retry: "重试",
					empty: "还没有初始化项目，请运行 /devflow init <name>。",
					unavailable: "DevFlow 状态暂时不可用，请刷新重试。",
					scopeUnavailable: "本会话没有工作区，DevFlow 拒绝与其它项目共享状态：这里不显示任何项目数据。",
					project: "项目路线",
					team: "团队 roster",
					work: "派发台账",
					assignments: "任务关系",
					noAssignments: "暂无任务关系",
					noTasks: "暂无任务",
					noAgents: "暂无 Agent",
					pause: "已暂停",
					live: "派发中",
					commander: "总指挥",
					chat: "原生对话",
					task: "任务",
					phase: "阶段",
					agent: "Agent",
					status: "状态",
					goal: "目标",
					stage: "阶段",
					decisions: "待处理决定",
					noDecisions: "暂无待处理决定",
					decisionHistory: "决定记录",
					noDecisionHistory: "暂无决定记录",
					executions: "执行状态",
					noExecutions: "暂无执行记录",
					relation: "路线"
				}
			}), "devflow: dictionaries");
			const controllers = /* @__PURE__ */ new Map();
			const liveControllers = /* @__PURE__ */ new Map();
			let remoteReady = false;
			const scopedRemoteFor = (sessionId) => {
				const agentCtx = ctx.sessions.scope(sessionId);
				if (agentCtx === void 0 || !remoteReady) return void 0;
				return agentCtx.get("remote.devflow");
			};
			const remoteFor = (sessionId) => {
				return scopedRemoteFor(sessionId);
			};
			const controllerFor = (sessionId) => {
				let controller = controllers.get(sessionId);
				if (controller === void 0) {
					controller = new DevFlowSnapshotController(remoteFor(sessionId), sessionId);
					controllers.set(sessionId, controller);
					const live = new DevFlowLiveController(remoteFor(sessionId), sessionId, {
						snapshot: (snapshot) => {
							controller?.acceptSnapshot(snapshot);
						},
						frame: () => {
							controller?.refresh();
						}
					});
					liveControllers.set(sessionId, live);
					live.start();
				}
				return controller;
			};
			const liveFor = (sessionId) => liveControllers.get(sessionId);
			const refreshControllers = () => {
				for (const [sessionId, controller] of controllers) controller.setRemote(remoteFor(sessionId));
				for (const [sessionId, live] of liveControllers) live.setRemote(remoteFor(sessionId));
			};
			ctx.effect(() => {
				const disposeCanvas = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
					name: "sidebar.right.pane.tab",
					key: DEVFLOW_ID,
					locale: NS,
					inject: (sessionId) => {
						const controller = controllerFor(sessionId);
						const live = liveFor(sessionId);
						return {
							hooks: {
								devflow: controller,
								audit: controller.audit,
								live
							},
							refresh: () => controller.refresh(),
							getInspectorTab: () => controller.getInspectorTab(),
							setInspectorTab: (tab) => {
								controller.setInspectorTab(tab);
							},
							audit: {
								ensure: (filter, scopeKey) => controller.audit.ensure(filter, scopeKey),
								refresh: () => controller.audit.refresh(),
								loadMore: () => controller.audit.loadMore(),
								retry: () => controller.audit.retry()
							},
							/** §二·3: the panel is where the closed overview float is reopened from. */
							reopenOverview: () => {
								window.dispatchEvent(new Event(OVERVIEW_REOPEN_EVENT));
							}
						};
					}
				}, DevFlowCanvas));
				const disposeTitle = ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: DEVFLOW_ID,
					locale: NS
				}, DevFlowCanvasTitle));
				const list = ctx.sessions.list;
				let disposeType = null;
				const syncType = () => {
					const state = list.getSnapshot();
					const session = state.current === void 0 ? void 0 : state.byId[state.current];
					const wanted = session?.projectionValues?.agentPreset === DEVFLOW_PRESET_ID;
					try {
						document.documentElement.dataset.devflowPreset = String(session?.projectionValues?.agentPreset ?? "none");
						document.documentElement.dataset.devflowPresetWanted = String(wanted);
					} catch {}
					if (wanted && disposeType === null) disposeType = ctx.sidebarRightTabs.register(devflowDefinition(ctx.locale.bind(NS)));
					else if (!wanted && disposeType !== null) {
						disposeType();
						disposeType = null;
					}
				};
				const disposeWatch = list.subscribe(syncType);
				syncType();
				/**
				* The top-right overview float (step 3B, §二~§五).
				*
				* `shell.overlay` is ROOT-scoped, so it is registered ONCE and the filter lives
				* inside the cell: the round's hard requirement is that the float is absent in
				* every session whose preset is not `devflow`, and a registration that exists but
				* renders `null` is exactly "缺席即正确语义" — no placeholder, no empty strip.
				*
				* `openPanel` is the float's one action: expand the right column and focus the
				* DevFlow tab. The kind is only registered while the CURRENT session runs the
				* DevFlow preset, so asking for it elsewhere would throw — the guard keeps the
				* float's own gate honest rather than relying on the throw.
				*/
				const openPanel = () => {
					try {
						if (document.documentElement.dataset.devflowPresetWanted !== "true") return;
						ctx.sidebarRight.openTab(DEVFLOW_KIND);
					} catch {}
				};
				const disposeOverview = ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: OVERVIEW_CELL_ID,
					order: 10,
					label: "DevFlow 概览",
					inject: () => ({
						controllerFor,
						liveFor,
						openPanel
					})
				}, DevFlowOverview));
				return () => {
					disposeWatch();
					disposeOverview();
					if (disposeType !== null) disposeType();
					disposeTitle();
					disposeCanvas();
					for (const live of liveControllers.values()) live.dispose();
					liveControllers.clear();
					for (const controller of controllers.values()) controller.dispose();
					controllers.clear();
				};
			}, "devflow: right Sidebar tab");
			ctx.effect(async () => {
				const disposeRemote = await ctx.remote.$mount(DEVFLOW_REMOTE);
				remoteReady = true;
				refreshControllers();
				const disposeReset = ctx.on("connection/reset", () => {
					refreshControllers();
					for (const controller of controllers.values()) controller.markStale();
				});
				return async () => {
					disposeReset();
					remoteReady = false;
					for (const live of liveControllers.values()) live.dispose();
					liveControllers.clear();
					for (const controller of controllers.values()) controller.dispose();
					await disposeRemote();
				};
			}, "devflow: Remote");
		}
		//#endregion
		exports.DevFlowCanvas = DevFlowCanvas;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
