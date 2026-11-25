import { APP_SEGMENTS, MCP_SEGMENTS } from "./generated/prompts.ts";

/**
 * Doctrine composition — the desktop's rules (src/agent/prompt-segments.ts +
 * teacher-agent.ts composeInstructions), applied to the build-time snapshot:
 *
 *   prober/teacher: system-prompt.md → sorted <agent>/ fragments → sorted shared/
 *   practice:       sorted practice/ fragments → the curated shared allowlist
 *
 * An override (data repo `prompts/<segment path>`) replaces a segment only
 * when settings.json agent.prompts[path] === true AND the file exists; an
 * enabled empty override contributes nothing. Segments trim, empties drop,
 * and the rest join with "\n\n---\n\n".
 *
 * MCP deltas (owner-approved): four segments that drive app-only tools are
 * removed, and the MCP fragments (mcp/prompts/) are appended last.
 */
export type DoctrineAgent = "prober" | "teacher" | "practice";

/** Mirrors PRACTICE_SHARED_FRAGMENTS in src/agent/prompt-segments.ts. */
const PRACTICE_SHARED_FRAGMENTS = ["10-voice.md", "15-accuracy.md", "16-mental-model.md", "35-side-conversations.md", "40-formatting.md"];

/** Segments describing tools the MCP harness does not have. */
export const MCP_REMOVED_SEGMENTS = ["teacher/40-jobs.md", "teacher/50-demos.md", "teacher/55-images.md", "shared/30-learner-files.md"];

export function sourceSegmentPaths(agent: DoctrineAgent): string[] {
	const keys = Object.keys(APP_SEGMENTS);
	const fragmentsOf = (dir: string) =>
		keys
			.filter((k) => k.startsWith(`${dir}/`))
			.map((k) => k.slice(dir.length + 1))
			.sort()
			.map((f) => `${dir}/${f}`);
	const shared = fragmentsOf("shared").filter((p) => agent !== "practice" || PRACTICE_SHARED_FRAGMENTS.includes(p.slice("shared/".length)));
	return [...(agent === "practice" ? [] : ["system-prompt.md"]), ...fragmentsOf(agent), ...shared];
}

/** Paths a composition may read overrides for (load these before composing). */
export function overridePaths(agent: DoctrineAgent): string[] {
	return sourceSegmentPaths(agent)
		.filter((p) => !MCP_REMOVED_SEGMENTS.includes(p))
		.map((p) => `prompts/${p}`);
}

export function composeDoctrine(
	agent: DoctrineAgent,
	switches: Record<string, boolean> | undefined,
	readOverride: (segmentPath: string) => string | null,
): string {
	const texts = sourceSegmentPaths(agent)
		.filter((p) => !MCP_REMOVED_SEGMENTS.includes(p))
		.map((p) => {
			const override = switches?.[p] === true ? readOverride(p) : null;
			return override !== null ? override : APP_SEGMENTS[p]!;
		});
	const mcp = Object.keys(MCP_SEGMENTS)
		.sort()
		.map((k) => MCP_SEGMENTS[k]!);
	return [...texts, ...mcp]
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}
