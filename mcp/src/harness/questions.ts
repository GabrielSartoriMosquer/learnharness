import type { QuestionData, QuestionMode, AskToolInput, ExplainToolInput, QuizToolInput } from "../../../src/core/question-core.ts";
import { normalizeOptions, normalizeQuizType, resolveCorrect, seededRandom, shuffleOptions } from "../../../src/core/question-core.ts";
import { toolQuestionKind } from "../../../src/core/pending.ts";

/**
 * The posed question as the learner sees it — the same construction the
 * desktop's question dock performs (components/question-dock.tsx): quiz
 * options shuffled by a seed of the call id (so the display order, and with
 * it every recorded 1-based index, is identical in a card, in text mode, and
 * in the desktop), ask options in authored order, answer key resolved against
 * the displayed order.
 */
export function questionDataFor(tool: string, toolCallId: string, input: Record<string, unknown>): QuestionData {
	const kind = toolQuestionKind(tool);
	const quizInput = kind === "quiz" ? (input as unknown as QuizToolInput) : null;
	const askInput = kind === "ask" ? (input as unknown as AskToolInput) : null;
	const explainInput = kind === "explain" ? (input as unknown as ExplainToolInput) : null;
	const multi = "multiSelect" in input ? input.multiSelect === true : false;
	const mode: QuestionMode =
		kind === "quiz" ? (multi ? "multi-select" : "single-select") : askInput?.options?.length ? (multi ? "multi-select" : "single-select") : "text";
	const options = normalizeOptions((quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[]);
	const ordered = kind === "quiz" && options.length > 0 ? shuffleOptions(options, seededRandom(toolCallId)) : options;
	const q: QuestionData = {
		id: toolCallId,
		kind,
		questionType: kind === "quiz" ? normalizeQuizType((input as { type?: unknown }).type) : undefined,
		question: String(input.question ?? ""),
		context: typeof input.details === "string" ? input.details : undefined,
		mode,
		options: ordered,
		createdAt: new Date().toISOString(),
	};
	if (quizInput) {
		const resolved = resolveCorrect(quizInput.correctAnswer, ordered);
		q.correctIndices = resolved.indices;
		q.explanation = quizInput.explanation;
	}
	if (explainInput) q.committedAnswer = explainInput.correctAnswer;
	return q;
}

/**
 * Text-mode display: the learner-visible half only — never the answer key,
 * explanation, or commitment (the side-chat's openQuestionMarkdown rule).
 */
export function questionMarkdown(q: QuestionData): string {
	const parts = [q.question.trim()];
	if (q.context?.trim()) parts.push(q.context.trim());
	if (q.options.length > 0) {
		parts.push(q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n"));
	}
	return parts.join("\n\n");
}
