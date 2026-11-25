import type { ChatStore } from "../../../src/core/ports.ts";
import type { ChatRecord, ChatSummary, PlanTree } from "../../../src/core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../../../src/core/contracts.ts";
import type { LhMessage } from "../../../src/core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../../../src/core/native-messages.ts";
import { phaseAt3Lh } from "../../../src/core/phases.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The app's ChatStore port over a Workspace — same record semantics as the
 * desktop's fs adapter (src/store/chats.ts): one `chats/<id>.json` per
 * session, tab-indented JSON, every write stamped with the current schema
 * version, newer-version records refused on read. Reads are synchronous over
 * what the action pre-loaded (see Workspace).
 */
export function chatPath(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return `chats/${id}.json`;
}

export function serializeChat(record: ChatRecord): string {
	return JSON.stringify({ ...record, version: CURRENT_CHAT_VERSION }, null, "\t");
}

/** Parse a stored record; null for absent, corrupt, or newer-version files. */
export function parseChat(text: string | null): ChatRecord | null {
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) return null;
	return parsed as ChatRecord;
}

/** The desktop's list projection (src/store/chats.ts listChats), per record. */
export function summarizeChat(record: ChatRecord): ChatSummary {
	const { messages, tree: _t, turns: _u, extractions: _e, imageSnapshots: _i, sideChats: _s, ...summary } = record;
	return {
		...summary,
		kind: summary.kind ?? "teach",
		messageCount: messages.length,
		phase: phaseAt3Lh(messages),
		pendingQuestion: danglingQuestionOf(messages) !== null,
		pendingProblem: activeProblemOf(messages) !== null,
	};
}

const unsupported = (what: string) => () => {
	throw new Error(`${what} is not available through the MCP harness`);
};

export function workspaceChatStore(ws: Workspace): ChatStore {
	const read = (id: string): ChatRecord | null => parseChat(ws.get(chatPath(id)));
	const write = (record: ChatRecord) => ws.set(chatPath(record.id), serializeChat(record));
	const mutate = (id: string, fn: (r: ChatRecord) => void) => {
		const record = read(id);
		if (!record) throw new Error(`Chat not found: ${id}`);
		fn(record);
		write(record);
	};
	return {
		createChat(title: string, kind?: "practice"): ChatRecord {
			const now = new Date().toISOString();
			const record: ChatRecord = {
				id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
				title: title.trim() || "Untitled session",
				createdAt: now,
				updatedAt: now,
				messages: [],
				...(kind === "practice" ? { kind: "practice" as const } : {}),
			};
			write(record);
			return { ...record, version: CURRENT_CHAT_VERSION };
		},
		getChat: read,
		listChats: unsupported("listChats (use listSessions)") as ChatStore["listChats"],
		saveMessages(id: string, messages: LhMessage[]) {
			mutate(id, (r) => {
				r.messages = messages;
				r.updatedAt = new Date().toISOString();
			});
		},
		saveTree(id: string, tree: PlanTree) {
			// Like the desktop: a plan write is not conversation activity.
			mutate(id, (r) => {
				r.tree = tree;
			});
		},
		saveImageSnapshot: unsupported("saveImageSnapshot") as ChatStore["saveImageSnapshot"],
		appendTurnUsage: unsupported("appendTurnUsage") as ChatStore["appendTurnUsage"],
		appendExtractionUsage: unsupported("appendExtractionUsage") as ChatStore["appendExtractionUsage"],
		saveSettings: unsupported("saveSettings") as ChatStore["saveSettings"],
		renameChat: unsupported("renameChat") as ChatStore["renameChat"],
		deleteChat: unsupported("deleteChat") as ChatStore["deleteChat"],
		updateSideChats: unsupported("updateSideChats") as unknown as ChatStore["updateSideChats"],
	} as ChatStore;
}
