import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runToolCall } from "@earendil-works/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createProberTools, createTeacherTools } from "../../../src/agent/tools.ts";
import type { ChatRecord } from "../../../src/core/contracts.ts";
import { titleFromPrompt } from "../../../src/core/contracts.ts";
import type { LhMessage } from "../../../src/core/native-messages.ts";
import { hasProbeDone, newAnswerResult, newHandoffMessage, pendingQuestionOf } from "../../../src/core/native-messages.ts";
import { planBlocksFor } from "../../../src/core/plan-blocks.ts";
import { buildAnswer, dismissedAnswer, type AnswerRequest } from "../../../src/core/question-core.ts";
import { QUESTION_TOOLS } from "../../../src/core/pending.ts";
import { sanitizeUserSettings } from "../../../src/core/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../../../src/core/settings-resolution.ts";
import { asAgentMessages, toLlmMessages } from "../../../src/core/native-messages.ts";
import type { ChatStore, JobStore } from "../../../src/core/ports.ts";
import { composeDoctrine, overridePaths, type DoctrineAgent } from "../doctrine.ts";
import { chatPath, parseChat, summarizeChat, workspaceChatStore } from "../storage/chat-store.ts";
import type { DataRepo } from "../storage/repo.ts";
import { Workspace } from "../storage/workspace.ts";
import { appendLearnerMessage, appendProse, appendToolCall, newToolCallId, stampResult } from "./records.ts";
import { questionDataFor, questionMarkdown } from "./questions.ts";

/**
 * The harness actions behind the MCP tools. Each action is one Workspace:
 * read at a pinned commit, mutate through the app's own ports and tools,
 * commit once. Errors meant for the model are HarnessError (the MCP layer
 * returns them as isError tool results); anything else is a server fault.
 */
export class HarnessError extends Error {}

export type DisplayMode = "text" | "card";
export interface Display {
	mode: DisplayMode;
	markdown: string;
}

export interface HarnessDeps {
	repo: DataRepo;
	/** The MCP client's reported name — the record's model stamp. */
	client: string;
	/** Whether the connected host renders MCP Apps cards. Phase 1: text only. */
	mode: DisplayMode;
}

/** The app-tool names the MCP surface exposes, per phase (the rest of the
 *  app registries — files, jobs, images — have no MCP counterpart). */
const PROBE_TOOLS = ["probe", "recall", "ask_user_question", "probe_done"];
const TEACH_TOOLS = ["quiz", "explain", "ask_user_question", "plan_init"];
export const APP_TOOL_NAMES = [...new Set([...PROBE_TOOLS, ...TEACH_TOOLS])];

const SETTINGS_PATH = "settings.json";

type Phase = "prober" | "teacher";

function phaseOf(record: ChatRecord): Phase {
	return hasProbeDone(record.messages) ? "teacher" : "prober";
}

const noJobs = {
	jobStore: {} as JobStore,
	spawn: () => {
		throw new Error("background jobs are not available through the MCP harness");
	},
	searchAvailable: () => false,
};

/** The app's own registry for a phase, filtered to the MCP surface. */
export function appRegistry(
	phase: Phase,
	chatId: string,
	chatStore: ChatStore,
	effective: EffectiveSettings,
	onHandoff: () => void,
): Record<string, AgentTool<any>> {
	const all =
		phase === "prober"
			? createProberTools({ chatId, chatStore, deliver: onHandoff, ...noJobs }, effective.agent.tools)
			: createTeacherTools({ chatId, chatStore, ...noJobs }, effective.agent.tools);
	const allowed = phase === "prober" ? PROBE_TOOLS : TEACH_TOOLS;
	return Object.fromEntries(Object.entries(all).filter(([name]) => allowed.includes(name)));
}

/**
 * The session as the desktop's teacher model would receive it
 * (toLlmMessages: markers flattened, UI-only blocks dropped, answers in their
 * compact learner-only form with thinking and confidence), rendered as text.
 */
export function modelTranscript(messages: readonly LhMessage[]): string {
	const out: string[] = [];
	for (const m of toLlmMessages(asAgentMessages(messages))) {
		const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
		const parts = content.map((b) => {
			if (b.type === "text") return b.text;
			if (b.type === "toolCall") return `[call ${b.name} ${b.id}] ${JSON.stringify(b.arguments)}`;
			if (b.type === "image") return "[image]";
			return "";
		});
		const label = m.role === "toolResult" ? `toolResult ${m.toolName} ${m.toolCallId}${m.isError ? " (error)" : ""}` : m.role;
		out.push(`### ${label}\n\n${parts.filter(Boolean).join("\n\n")}`);
	}
	return out.join("\n\n");
}

export class Harness {
	constructor(private readonly deps: HarnessDeps) {}

	private async open(): Promise<Workspace> {
		const ws = await Workspace.open(this.deps.repo);
		await ws.load(SETTINGS_PATH);
		return ws;
	}

	private effective(ws: Workspace): EffectiveSettings {
		const text = ws.get(SETTINGS_PATH);
		let raw: unknown = null;
		try {
			raw = text === null ? null : JSON.parse(text);
		} catch {
			raw = null;
		}
		return resolveSettings(sanitizeUserSettings(raw));
	}

	private async doctrine(ws: Workspace, agent: DoctrineAgent, effective: EffectiveSettings): Promise<string> {
		const switches = effective.agent.prompts;
		const wanted = overridePaths(agent).filter((p) => switches?.[p.slice("prompts/".length)] === true);
		await ws.load(...wanted);
		return composeDoctrine(agent, switches, (segment) => (wanted.includes(`prompts/${segment}`) ? ws.get(`prompts/${segment}`) : null));
	}

	private async loadChat(ws: Workspace, sessionId: string): Promise<ChatRecord> {
		const path = chatPath(sessionId);
		await ws.load(path);
		const record = parseChat(ws.get(path));
		if (!record) throw new HarnessError(`No session ${sessionId} in the data repository (or it was written by a newer app version).`);
		if (record.kind === "practice") throw new HarnessError("Practice sessions are not available through the MCP harness yet.");
		return record;
	}

	/** The tool names valid right now for a session (for refusals). */
	private static phaseTools(phase: Phase, registry: Record<string, unknown>): string {
		return Object.keys(registry).join(", ") + (phase === "teacher" ? ", teach" : "");
	}

	// ─── sessions ────────────────────────────────────────────────────────────

	async startSession(goal: string): Promise<{ sessionId: string; title: string; doctrine: string }> {
		const text = goal.trim();
		if (!text) throw new HarnessError("goal is required: the learner's opening message, verbatim.");
		const ws = await this.open();
		const store = workspaceChatStore(ws);
		const record = store.createChat(titleFromPrompt(text));
		const messages: LhMessage[] = [];
		appendLearnerMessage(messages, text);
		store.saveMessages(record.id, messages);
		const doctrine = await this.doctrine(ws, "prober", this.effective(ws));
		await ws.flush(`mcp: start ${record.id}`);
		return { sessionId: record.id, title: record.title, doctrine };
	}

	async listSessions(): Promise<ReturnType<typeof summarizeChat>[]> {
		const ws = await Workspace.open(this.deps.repo);
		const entries = (await ws.listDir("chats")).filter((e) => e.type === "file" && e.name.endsWith(".json"));
		await ws.load(...entries.map((e) => e.path));
		return entries
			.map((e) => parseChat(ws.get(e.path)))
			.filter((r): r is ChatRecord => r !== null)
			.map(summarizeChat)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async resumeSession(sessionId: string): Promise<{ title: string; phase: Phase; doctrine: string; transcript: string; pending: unknown }> {
		const ws = await this.open();
		const record = await this.loadChat(ws, sessionId);
		const phase = phaseOf(record);
		const doctrine = await this.doctrine(ws, phase, this.effective(ws));
		const pending = pendingQuestionOf(record.messages);
		return {
			title: record.title,
			phase,
			doctrine,
			transcript: modelTranscript(record.messages),
			pending: pending
				? {
						toolCallId: pending.toolCallId,
						tool: pending.tool,
						display: { mode: this.deps.mode, markdown: questionMarkdown(questionDataFor(pending.tool, pending.toolCallId, pending.input as Record<string, unknown>)) },
					}
				: null,
		};
	}

	// ─── teaching prose ──────────────────────────────────────────────────────

	async teach(sessionId: string, markdown: string, learnerMessage?: string): Promise<{ display: Display }> {
		const text = markdown.trim();
		if (!text) throw new HarnessError("markdown is required.");
		const ws = await this.open();
		const record = await this.loadChat(ws, sessionId);
		this.refuseWhilePending(record);
		const messages = [...record.messages];
		appendLearnerMessage(messages, learnerMessage);
		appendProse(messages, this.deps.client, text);
		workspaceChatStore(ws).saveMessages(sessionId, messages);
		await ws.flush(`mcp: teach ${sessionId}`);
		return { display: { mode: this.deps.mode, markdown: text } };
	}

	private refuseWhilePending(record: ChatRecord): void {
		const pending = pendingQuestionOf(record.messages);
		if (pending) {
			throw new HarnessError(
				`A ${pending.tool} question (toolCallId ${pending.toolCallId}) is still waiting for his answer. ` +
					"Record his answer with submit_answer (or dismissed:true if he skips it) before anything else.",
			);
		}
	}

	// ─── app tools (questions, probe_done, plan_init) ────────────────────────

	async appTool(
		sessionId: string,
		name: string,
		args: Record<string, unknown>,
		learnerMessage?: string,
	): Promise<{ isError: boolean; text: string; display?: Display; toolCallId: string; doctrine?: string }> {
		const ws = await this.open();
		const record = await this.loadChat(ws, sessionId);
		const effective = this.effective(ws);
		const phase = phaseOf(record);
		const store = workspaceChatStore(ws);
		let handoff = false;
		const registry = appRegistry(phase, sessionId, store, effective, () => {
			handoff = true;
		});
		const tool = registry[name];
		if (!tool) {
			throw new HarnessError(
				`${name} is not available in this session's ${phase === "prober" ? "probe" : "teach"} phase. ` +
					`Available now: ${Harness.phaseTools(phase, registry)}.`,
			);
		}
		this.refuseWhilePending(record);

		const messages = [...record.messages];
		appendLearnerMessage(messages, learnerMessage);
		const call: ToolCall = { type: "toolCall", id: newToolCallId(), name, arguments: args as ToolCall["arguments"] };
		const owner = appendToolCall(messages, this.deps.client, call);
		// The app's tools read the live record (nodeId vs tree, open questions):
		// persist the call first, exactly as the desktop's turn does mid-stream.
		store.saveMessages(sessionId, messages);

		const run = await runToolCall(call, {
			assistantMessage: owner,
			context: { systemPrompt: "", messages: [], tools: Object.values(registry) },
			tools: Object.values(registry),
		} as Parameters<typeof runToolCall>[1]);
		const resultText = (run.result.content ?? [])
			.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : ""))
			.join("");
		const latest = store.getChat(sessionId)!; // tools may have saved (plan_init's tree)
		const after = [...latest.messages];

		const isQuestion = (QUESTION_TOOLS as readonly string[]).includes(name);
		if (isQuestion && !run.isError) {
			// A posed question persists as the bare call (never a placeholder):
			// the learner's answer becomes its result via submit_answer.
			await ws.flush(`mcp: ${name} ${sessionId}`);
			const q = questionDataFor(name, call.id, (run.toolCall?.arguments ?? call.arguments) as Record<string, unknown>);
			return { isError: false, text: "Question posed.", toolCallId: call.id, display: { mode: this.deps.mode, markdown: questionMarkdown(q) } };
		}

		const result = stampResult({
			role: "toolResult",
			toolCallId: call.id,
			toolName: name,
			content: run.result.content ?? [],
			details: run.result.details,
			isError: run.isError,
			timestamp: Date.now(),
		} as ToolResultMessage);
		after.push(result);
		if (name === "plan_init" && !run.isError) after.push(...planBlocksFor(after, [result], store.getChat(sessionId)?.tree, after));
		if (name === "probe_done" && handoff) after.push(newHandoffMessage(sessionId));
		store.saveMessages(sessionId, after);
		await ws.flush(`mcp: ${name} ${sessionId}`);

		const doctrine = name === "probe_done" && handoff ? await this.doctrine(ws, "teacher", effective) : undefined;
		return { isError: run.isError, text: resultText, toolCallId: call.id, ...(doctrine ? { doctrine } : {}) };
	}

	// ─── answers ─────────────────────────────────────────────────────────────

	async submitAnswer(
		sessionId: string,
		toolCallId: string,
		req: AnswerRequest & { selected?: number[]; dismissed?: boolean },
	): Promise<{ text: string }> {
		const ws = await this.open();
		const record = await this.loadChat(ws, sessionId);
		const pending = pendingQuestionOf(record.messages);
		if (!pending || pending.toolCallId !== toolCallId) {
			throw new HarnessError(
				pending
					? `toolCallId ${toolCallId} is not the open question; the open one is ${pending.toolCallId} (${pending.tool}).`
					: "No question is waiting for an answer in this session.",
			);
		}
		const q = questionDataFor(pending.tool, toolCallId, pending.input as Record<string, unknown>);
		let answer;
		if (req.dismissed) {
			answer = dismissedAnswer(q.kind, q.question);
		} else {
			const values = [...(req.values ?? [])];
			for (const n of req.selected ?? []) {
				const option = q.options[n - 1];
				if (!option) throw new HarnessError(`selected ${n} is not a displayed option number (1–${q.options.length}).`);
				values.push(option.value);
			}
			const empty = !req.dontKnow && values.length === 0 && !req.text?.trim() && !req.other?.trim();
			if (empty) throw new HarnessError("The answer is empty: pass selected option numbers, text, other, dontKnow, or dismissed.");
			answer = buildAnswer(q, { ...req, values }, pending.tool);
		}
		const result = newAnswerResult(toolCallId, pending.tool, answer);
		workspaceChatStore(ws).saveMessages(sessionId, [...record.messages, result]);
		await ws.flush(`mcp: answer ${sessionId}`);
		// The model reads exactly what the desktop's model reads for an answer.
		return { text: (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("") };
	}
}
