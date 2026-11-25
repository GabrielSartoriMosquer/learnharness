import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Harness, HarnessError, modelTranscript } from "../src/harness/harness.ts";
import { ConflictError } from "../src/storage/repo.ts";
import { parseChat } from "../src/storage/chat-store.ts";
import { FakeRepo } from "./fake-repo.ts";
import { hasProbeDone, needsContinuation, pendingQuestionOf, questionCallsOf } from "../../src/core/native-messages.ts";
import { phaseAt3Lh } from "../../src/core/phases.ts";

const probeArgs = {
	question: "Which is larger, $2^{10}$ or $10^3$?",
	options: [
		{ label: "$2^{10}$", value: "pow2" },
		{ label: "$10^3$", value: "pow10" },
		{ label: "They are equal", value: "equal" },
	],
	explanation: "$2^{10} = 1024 > 1000$.",
	correctAnswer: "pow2",
};

const assessment = { assessment: { strands: [{ strand: "exponents", assessment: "Solid on integer powers; floor reached." }] } };

const quizArgs = {
	type: "check",
	nodeId: "powers",
	question: "What is $2^3$?",
	options: [
		{ label: "6", value: "six" },
		{ label: "8", value: "eight" },
		{ label: "9", value: "nine" },
	],
	explanation: "$2 \\cdot 2 \\cdot 2 = 8$.",
	correctAnswer: "eight",
};

function setup(files: Record<string, string> = {}) {
	const repo = new FakeRepo(files);
	const harness = new Harness({ repo, client: "claude-ai", mode: "text" });
	return { repo, harness };
}

function record(repo: FakeRepo, id: string) {
	return parseChat(repo.files().get(`chats/${id}.json`) ?? null)!;
}

test("a full probe → plan → teach → answer flow writes a native record", async () => {
	const { repo, harness } = setup();
	const { sessionId, doctrine, title } = await harness.startSession("Quero entender logaritmos");
	assert.equal(title, "Quero entender logaritmos");
	assert.match(doctrine, /The harness over MCP/);
	assert.doesNotMatch(doctrine, /## Background research/, "app-only job doctrine is removed");

	const posed = await harness.appTool(sessionId, "probe", probeArgs);
	assert.equal(posed.isError, false);
	assert.equal(posed.display?.mode, "text");
	assert.doesNotMatch(posed.display!.markdown, /1024/, "the explanation never reaches the display");
	assert.equal(pendingQuestionOf(record(repo, sessionId).messages)?.toolCallId, posed.toolCallId);

	// The gate: nothing else while a question is open.
	await assert.rejects(harness.teach(sessionId, "more"), HarnessError);

	// Answer by the displayed option number.
	const displayed = posed.display!.markdown.split("\n").filter((l) => /^\d\. /.test(l));
	const n = displayed.findIndex((l) => l.includes("$2^{10}$")) + 1;
	const answered = await harness.submitAnswer(sessionId, posed.toolCallId, { selected: [n], confidence: 90, thinking: "1024 vs 1000" });
	assert.deepEqual(JSON.parse(answered.text).correct, true);

	const done = await harness.appTool(sessionId, "probe_done", assessment);
	assert.equal(done.isError, false);
	assert.ok(done.doctrine && /plan/i.test(done.doctrine), "probe_done returns the teacher doctrine");
	assert.ok(hasProbeDone(record(repo, sessionId).messages));

	// Teach-phase tools only now.
	await assert.rejects(harness.appTool(sessionId, "probe", probeArgs), /not available/);

	const plan = await harness.appTool(sessionId, "plan_init", { mermaid: "graph TD\n  powers[Powers] --> logs[Logarithms]" });
	assert.equal(plan.isError, false, plan.text);
	await harness.teach(sessionId, "A power repeats multiplication.", "ok, pode seguir");
	await harness.teach(sessionId, "So $2^3$ multiplies three twos.");
	const quiz = await harness.appTool(sessionId, "quiz", quizArgs);
	assert.equal(quiz.isError, false, quiz.text);
	await harness.submitAnswer(sessionId, quiz.toolCallId, { dontKnow: true, thinking: "não lembro" });

	const r = record(repo, sessionId);
	assert.equal(r.version, 2);
	assert.equal(phaseAt3Lh(r.messages), "teach");
	assert.ok(r.tree && r.tree.nodes.length === 2);
	assert.ok(r.messages.some((m) => m.role === "custom" && m.customType === "plan-block"));
	assert.ok(r.messages.some((m) => m.role === "custom" && m.customType === "probe-handoff"));
	// Relayed learner text is a user message; consecutive prose + the quiz share one assistant message.
	assert.ok(r.messages.some((m) => m.role === "user" && m.content === "ok, pode seguir"));
	const owner = r.messages.find((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.name === "quiz"));
	assert.ok(owner && owner.role === "assistant");
	assert.deepEqual(owner.content.map((b) => b.type), ["text", "text", "toolCall"]);
	assert.equal(owner.provider, "mcp");
	assert.equal(owner.model, "claude-ai");
	assert.equal(questionCallsOf(r.messages).length, 0, "nothing left dangling");
	assert.equal(needsContinuation(r.messages), true, "ends on an answer: the desktop would continue the lesson");
	const md = modelTranscript(r.messages);
	assert.match(md, /A power repeats multiplication/);
	assert.match(md, /não lembro/);
});

test("invalid tool input is recorded like the desktop records it and returned to the model", async () => {
	const { repo, harness } = setup();
	const { sessionId } = await harness.startSession("x");
	const bad = await harness.appTool(sessionId, "probe", { ...probeArgs, correctAnswer: "nope" });
	assert.equal(bad.isError, true);
	assert.match(bad.text, /does not match any option value/);
	const r = record(repo, sessionId);
	const last = r.messages[r.messages.length - 1]!;
	assert.equal(last.role, "toolResult");
	assert.equal(pendingQuestionOf(r.messages), null);
});

test("dismissal and wrong ids", async () => {
	const { harness } = setup();
	const { sessionId } = await harness.startSession("x");
	const posed = await harness.appTool(sessionId, "probe", probeArgs);
	await assert.rejects(harness.submitAnswer(sessionId, "call_other", { selected: [1] }), /not the open question/);
	await assert.rejects(harness.submitAnswer(sessionId, posed.toolCallId, {}), /empty/);
	await assert.rejects(harness.submitAnswer(sessionId, posed.toolCallId, { selected: [9] }), /not a displayed option/);
	const ok = await harness.submitAnswer(sessionId, posed.toolCallId, { dismissed: true });
	assert.deepEqual(JSON.parse(ok.text), { kind: "quiz", dismissed: true });
});

test("free-recall mechanic follows settings.json (recall instead of probe)", async () => {
	const { harness } = setup({ "settings.json": JSON.stringify({ version: 1, agent: { tools: { explain: true } } }) });
	const { sessionId } = await harness.startSession("x");
	await assert.rejects(harness.appTool(sessionId, "probe", probeArgs), /not available/);
	const r = await harness.appTool(sessionId, "recall", { question: "Define a logarithm.", correctAnswer: "The exponent..." });
	assert.equal(r.isError, false);
	await harness.submitAnswer(sessionId, r.toolCallId, { text: "the inverse of exponentiation" });
});

test("enabled prompt overrides replace their segment", async () => {
	const { harness } = setup({
		"settings.json": JSON.stringify({ version: 1, agent: { prompts: { "shared/10-voice.md": true } } }),
		"prompts/shared/10-voice.md": "## Voice\n\nOVERRIDDEN VOICE",
	});
	const { doctrine } = await harness.startSession("x");
	assert.match(doctrine, /OVERRIDDEN VOICE/);
});

test("conflict rule: rebuild on a moved head unless this action's files changed", async () => {
	const { repo, harness } = setup();
	const { sessionId } = await harness.startSession("x");
	// The desktop pushes an unrelated file: the next action still lands.
	repo.push({ "graph/positions.json": "{}" });
	await harness.teach(sessionId, "hello");
	// A write to the same session file between read and commit is refused.
	const original = repo.commit.bind(repo);
	repo.commit = async (base, changes, msg) => {
		repo.push({ [`chats/${sessionId}.json`]: repo.files().get(`chats/${sessionId}.json`)! + "\n" });
		repo.commit = original;
		return original(base, changes, msg);
	};
	await assert.rejects(harness.teach(sessionId, "again"), ConflictError);
});

test("the desktop's own store reads MCP-written sessions", async () => {
	const { repo, harness } = setup();
	const { sessionId } = await harness.startSession("Quero entender logaritmos");
	const posed = await harness.appTool(sessionId, "probe", probeArgs);
	await harness.submitAnswer(sessionId, posed.toolCallId, { selected: [1], confidence: 50 });

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-"));
	for (const [p, c] of repo.files()) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), c);
	}
	const env = { ...process.env, LH_DATA_DIR: dir };
	const listed = execFileSync(
		process.execPath,
		["--import", "tsx", "-e", "import('../../src/store/chats.ts').then(m => console.log(JSON.stringify(m.chatStore.listChats())))"],
		{ cwd: path.dirname(new URL(import.meta.url).pathname), env },
	).toString();
	const rows = JSON.parse(listed) as Array<{ id: string; phase: string; pendingQuestion: boolean }>;
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.id, sessionId);
	assert.equal(rows[0]!.phase, "probe");

});
