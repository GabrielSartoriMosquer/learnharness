import { McpServer, fromJsonSchema as toStandard, type CallToolResult, type JsonSchemaType } from "@modelcontextprotocol/server";
import type { TSchema } from "typebox";
import { createProberTools, createTeacherTools } from "../../../src/agent/tools.ts";
import type { ChatStore } from "../../../src/core/ports.ts";
import { resolveSettings } from "../../../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../../../src/core/settings.ts";
import { Harness, HarnessError } from "../harness/harness.ts";
import { ConflictError, type DataRepo } from "../storage/repo.ts";

/**
 * The MCP surface. App tools keep their own names, schemas and descriptions
 * (read from the app's registries), plus `sessionId` and — where the approved
 * doctrine says so — `learnerMessage`. MCP-only tools: start_session,
 * list_sessions, resume_session, teach, submit_answer.
 */
export interface ServerDeps {
	repo: DataRepo;
	/** The connected client's registered name (the record's model stamp). */
	client: string;
}

const SESSION_ID = { type: "string", description: "The LearnHarness session id (from start_session, list_sessions, or resume_session)." };
const LEARNER_MESSAGE = {
	type: "string",
	description:
		"Optional. Everything the learner typed in the chat since your last LearnHarness call, copied verbatim — every word, no summary, no cleanup. Omit when he wrote nothing new. Never repeat answers given in a card or through submit_answer.",
};

const MCP_NOTE =
	"\n\n[LearnHarness MCP] Pass sessionId. The result's display block says how to show it: mode \"card\" — the host rendered it; mode \"text\" — show display.markdown verbatim and collect his answer for submit_answer.";

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

// The SDK validates arguments against these JSON Schemas (the app's own TypeBox
// schemas, serialized) before a handler runs; handlers receive plain objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fromJsonSchema = (schema: JsonSchema): any => toStandard(schema as unknown as JsonSchemaType);

function jsonOf(schema: TSchema): JsonSchema {
	// TypeBox schemas are JSON Schema objects with symbol metadata; drop it.
	return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

function withSession(schema: JsonSchema, learnerMessage: boolean): JsonSchema {
	return {
		...schema,
		type: "object",
		properties: { sessionId: SESSION_ID, ...(schema.properties ?? {}), ...(learnerMessage ? { learnerMessage: LEARNER_MESSAGE } : {}) },
		required: ["sessionId", ...(schema.required ?? [])],
	};
}

function ok(payload: Record<string, unknown>, extra: string[] = []): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }, ...extra.map((text) => ({ type: "text" as const, text }))] };
}

function fail(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof HarnessError || err instanceof ConflictError) return fail(err.message);
		throw err;
	}
}

/** The armed quizzing mechanic per settings.json (probe/quiz vs recall/explain). */
async function armedTools(repo: DataRepo): Promise<Record<string, { description: string; parameters: TSchema }>> {
	const head = await repo.head();
	const text = await repo.readText("settings.json", head);
	let raw: unknown = null;
	try {
		raw = text === null ? null : JSON.parse(text);
	} catch {
		raw = null;
	}
	const effective = resolveSettings(sanitizeUserSettings(raw));
	const stub = { chatId: "chat_listing", chatStore: {} as ChatStore, deliver: () => {}, jobStore: {} as never, spawn: () => {} };
	const prober = createProberTools(stub, effective.agent.tools);
	const teacher = createTeacherTools(stub, effective.agent.tools);
	const pick = ["probe", "recall", "ask_user_question", "probe_done"].map((n) => [n, prober[n]] as const);
	const teach = ["quiz", "explain", "plan_init"].map((n) => [n, teacher[n]] as const);
	return Object.fromEntries([...pick, ...teach].filter(([, t]) => t !== undefined).map(([n, t]) => [n, { description: t!.description, parameters: t!.parameters as TSchema }]));
}

export async function buildServer(deps: ServerDeps): Promise<McpServer> {
	const server = new McpServer(
		{ name: "learnharness", version: "0.1.0" },
		{
			instructions:
				"LearnHarness: adaptive teaching with a persistent learning record. To start studying, call start_session with the learner's opening message; to continue, list_sessions then resume_session. Each returns the teaching doctrine you must follow for the session.",
		},
	);
	const harness = new Harness({ repo: deps.repo, client: deps.client, mode: "text" });

	server.registerTool(
		"start_session",
		{
			description:
				"Start a new LearnHarness teaching session. Returns the sessionId and the doctrine you must follow from now on (the probe phase). The goal is the learner's opening message, verbatim.",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { goal: { type: "string", description: "The learner's opening message — what he wants to understand — verbatim." } },
				required: ["goal"],
			}),
		},
		async ({ goal }: { goal: string }) =>
			guarded(async () => {
				const r = await harness.startSession(goal);
				return ok({ sessionId: r.sessionId, title: r.title, phase: "probe" }, [r.doctrine]);
			}),
	);

	server.registerTool(
		"list_sessions",
		{
			description: "List the learner's LearnHarness sessions (newest activity first) with phase and whether a question is waiting.",
			inputSchema: fromJsonSchema({ type: "object", properties: {} }),
		},
		async () => guarded(async () => ok({ sessions: await harness.listSessions() })),
	);

	server.registerTool(
		"resume_session",
		{
			description:
				"Resume a LearnHarness session: returns its current phase, the doctrine for that phase, the history as the teacher sees it, and any question still waiting for his answer. Continue from the record, not from memory of another chat.",
			inputSchema: fromJsonSchema({ type: "object", properties: { sessionId: SESSION_ID }, required: ["sessionId"] }),
		},
		async ({ sessionId }: { sessionId: string }) =>
			guarded(async () => {
				const r = await harness.resumeSession(sessionId);
				return ok({ sessionId, title: r.title, phase: r.phase === "prober" ? "probe" : "teach", pending: r.pending }, [r.doctrine, `# Session history\n\n${r.transcript}`]);
			}),
	);

	server.registerTool(
		"teach",
		{
			description:
				"Deliver teaching prose to the learner and record it: every explanation, worked example, plan presentation, and diagram (mermaid inline) goes here as markdown with LaTeX. Prose written outside LearnHarness tools is missing from his record and the knowledge graph." +
				MCP_NOTE,
			inputSchema: fromJsonSchema(
				withSession({ type: "object", properties: { markdown: { type: "string", description: "The teaching text (markdown, $...$ / $$...$$ math, mermaid blocks)." } }, required: ["markdown"] }, true),
			),
		},
		async ({ sessionId, markdown, learnerMessage }: { sessionId: string; markdown: string; learnerMessage?: string }) =>
			guarded(async () => ok({ ok: true, ...(await harness.teach(sessionId, markdown, learnerMessage)) })),
	);

	server.registerTool(
		"submit_answer",
		{
			description:
				"Record the learner's answer to the open question (text mode, or when he answered in the chat). Pass exactly what he gave, in his own words, unedited; never supply a confidence or thinking he did not give. Returns what he answered as the teacher reads it (graded for multiple choice).",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: {
					sessionId: SESSION_ID,
					toolCallId: { type: "string", description: "The toolCallId the question call returned." },
					selected: { type: "array", items: { type: "integer", minimum: 1 }, description: "Displayed option number(s) he chose (1-based, as shown in display.markdown)." },
					text: { type: "string", description: "His free-text answer (recall/explain, or an ask without options)." },
					other: { type: "string", description: "His own answer instead of the listed options (ask_user_question)." },
					dontKnow: { type: "boolean", description: "He said he does not know." },
					dismissed: { type: "boolean", description: "He skipped the question." },
					confidence: { type: "integer", minimum: 0, maximum: 100, description: "Multiple choice only: his stated probability (0, 30, 50, 70, 90, or 100) that his answer is right. Omit if he gave none." },
					thinking: { type: "string", description: "His reasoning on the question, verbatim." },
					readingThinking: { type: "string", description: "What he was thinking while reading the teaching before this check, verbatim." },
				},
				required: ["sessionId", "toolCallId"],
			}),
		},
		async ({ sessionId, toolCallId, ...answer }: { sessionId: string; toolCallId: string } & Record<string, unknown>) =>
			guarded(async () => {
				const r = await harness.submitAnswer(sessionId, toolCallId, answer as Parameters<Harness["submitAnswer"]>[2]);
				return ok({ ok: true, answer: JSON.parse(r.text) });
			}),
	);

	for (const [name, tool] of Object.entries(await armedTools(deps.repo))) {
		const learnerMessage = name !== "probe_done";
		server.registerTool(
			name,
			{ description: tool.description + MCP_NOTE, inputSchema: fromJsonSchema(withSession(jsonOf(tool.parameters), learnerMessage)) },
			async (input: Record<string, unknown>) =>
				guarded(async () => {
					const { sessionId, learnerMessage: relayed, ...args } = input as { sessionId: string; learnerMessage?: string };
					const r = await harness.appTool(sessionId, name, args, relayed);
					if (r.isError) return fail(r.text);
					return ok(
						{ ok: true, toolCallId: r.toolCallId, result: r.text, ...(r.display ? { display: r.display } : {}), ...(r.doctrine ? { phase: "teach" } : {}) },
						r.doctrine ? [r.doctrine] : [],
					);
				}),
		);
	}
	return server;
}
