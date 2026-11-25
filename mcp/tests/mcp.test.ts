import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer } from "../src/mcp/server.ts";
import { FakeRepo } from "./fake-repo.ts";

/** Drive the MCP surface over HTTP exactly as a 2025-era client does. */
function client(repo: FakeRepo) {
	const handler = createMcpHandler(() => buildServer({ repo, client: "Claude" }));
	let id = 0;
	return async (method: string, params: Record<string, unknown> = {}) => {
		const res = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
				body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
			}),
		);
		const text = await res.text();
		const data = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
		const msg = JSON.parse(data) as { result?: any; error?: any };
		if (msg.error) throw new Error(JSON.stringify(msg.error));
		return msg.result;
	};
}

const call = async (rpc: ReturnType<typeof client>, name: string, args: Record<string, unknown>) => {
	const r = await rpc("tools/call", { name, arguments: args });
	return { isError: r.isError === true, body: r.content.map((c: { text: string }) => c.text) as string[] };
};

test("tools/list exposes the armed app tools with sessionId and learnerMessage", async () => {
	const rpc = client(new FakeRepo());
	await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
	const { tools } = await rpc("tools/list");
	const names = tools.map((t: { name: string }) => t.name).sort();
	assert.deepEqual(names, ["ask_user_question", "list_sessions", "plan_init", "probe", "probe_done", "quiz", "resume_session", "start_session", "submit_answer", "teach"]);
	const quiz = tools.find((t: { name: string }) => t.name === "quiz");
	assert.ok(quiz.inputSchema.required.includes("sessionId"));
	assert.ok(quiz.inputSchema.required.includes("nodeId"));
	assert.ok(quiz.inputSchema.properties.learnerMessage);
	const done = tools.find((t: { name: string }) => t.name === "probe_done");
	assert.equal(done.inputSchema.properties.learnerMessage, undefined);
});

test("a session runs end to end over MCP", async () => {
	const repo = new FakeRepo();
	const rpc = client(repo);
	const start = await call(rpc, "start_session", { goal: "Quero entender logaritmos" });
	assert.equal(start.isError, false);
	const { sessionId } = JSON.parse(start.body[0]!);
	assert.match(start.body[1]!, /The harness over MCP/);

	const probe = await call(rpc, "probe", {
		sessionId,
		question: "Which is larger?",
		options: [
			{ label: "A", value: "a" },
			{ label: "B", value: "b" },
		],
		explanation: "A is.",
		correctAnswer: "a",
	});
	const posed = JSON.parse(probe.body[0]!);
	assert.equal(posed.display.mode, "text");
	const ans = await call(rpc, "submit_answer", { sessionId, toolCallId: posed.toolCallId, selected: [1], confidence: 70 });
	assert.equal(ans.isError, false, ans.body.join());

	// Schema validation happens at the MCP boundary: a missing field is refused.
	const bad = await call(rpc, "probe_done", { sessionId });
	assert.equal(bad.isError, true);

	const done = await call(rpc, "probe_done", { sessionId, assessment: { strands: [{ strand: "s", assessment: "a" }] } });
	assert.equal(done.isError, false, done.body.join());
	assert.equal(JSON.parse(done.body[0]!).phase, "teach");
	assert.ok(done.body[1]!.length > 1000, "teacher doctrine returned");

	const resumed = await call(rpc, "resume_session", { sessionId });
	assert.equal(JSON.parse(resumed.body[0]!).phase, "teach");
	assert.match(resumed.body[2]!, /Session history/);

	const list = await call(rpc, "list_sessions", {});
	assert.equal(JSON.parse(list.body[0]!).sessions[0].id, sessionId);

	const rec = JSON.parse(repo.files().get(`chats/${sessionId}.json`)!);
	assert.equal(rec.messages.find((m: { role: string }) => m.role === "assistant").model, "Claude");
});
