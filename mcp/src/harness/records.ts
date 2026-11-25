import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../../../src/core/native-messages.ts";
import { newMessageId, newUserMessage } from "../../../src/core/native-messages.ts";

/**
 * Native message assembly for MCP-authored turns. The harness sees one tool
 * call at a time; these helpers fold them into the shapes the desktop's agent
 * loop would have written:
 *
 * - consecutive `teach` prose → text blocks of ONE assistant message
 *   (stopReason "stop"), like a reply the model streamed;
 * - a tool call right after prose joins that message (stopReason "toolUse");
 * - learner chat text relayed by the model (learnerMessage) → a user message.
 *
 * Owner-approved stamp: provider "mcp", api "faux", model = the MCP client's
 * reported name. Usage is zero: the app's money channel is the separate turns
 * log, and history serialization reads only content blocks.
 */
export const MCP_PROVIDER = "mcp";

type Assistant = LhMessage & AssistantMessage;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function newAssistant(client: string, content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): Assistant {
	return {
		id: newMessageId(),
		role: "assistant",
		content,
		api: "faux",
		provider: MCP_PROVIDER,
		model: client,
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
		stopReason,
		timestamp: Date.now(),
	} as Assistant;
}

/** The trailing MCP prose message still open for more text or a call. */
function openProse(messages: LhMessage[]): Assistant | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return null;
	const a = last as Assistant;
	if (a.provider !== MCP_PROVIDER || a.stopReason !== "stop") return null;
	return a.content.every((b) => b.type === "text") ? a : null;
}

export function appendLearnerMessage(messages: LhMessage[], text: string | undefined): void {
	const t = text?.trim();
	if (t) messages.push(newUserMessage(t));
}

export function appendProse(messages: LhMessage[], client: string, markdown: string): void {
	const open = openProse(messages);
	if (open) open.content.push({ type: "text", text: markdown });
	else messages.push(newAssistant(client, [{ type: "text", text: markdown }], "stop"));
}

/** Append a tool call; returns the owning assistant message. */
export function appendToolCall(messages: LhMessage[], client: string, call: ToolCall): Assistant {
	const open = openProse(messages);
	if (open) {
		open.content.push(call);
		open.stopReason = "toolUse";
		return open;
	}
	const msg = newAssistant(client, [call], "toolUse");
	messages.push(msg);
	return msg;
}

export function newToolCallId(): string {
	// Same alphabet the desktop's ids use; prefixed so MCP calls are recognizable.
	return `call_mcp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function stampResult(result: ToolResultMessage): LhMessage & ToolResultMessage {
	return { ...result, id: newMessageId() } as LhMessage & ToolResultMessage;
}
