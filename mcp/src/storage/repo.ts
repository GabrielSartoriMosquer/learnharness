/**
 * The data-repo port: the learner's `learnharness-data` repository, read at a
 * pinned commit and written as ONE atomic commit per harness action.
 *
 * Conflict rule (owner decision, "disciplina manual"): the MCP writes straight
 * to the branch. If the branch moved since the action's base commit (the
 * desktop pushed meanwhile) and none of the files this action writes changed
 * in between, the commit is rebuilt on the new head. If any of them changed,
 * the write is refused with ConflictError — nothing is merged or overwritten.
 */

export interface DirEntry {
	name: string;
	path: string;
	type: "file" | "dir";
}

/** path → new text content, or null to delete the file. */
export type Changes = ReadonlyMap<string, string | null>;

export interface DataRepo {
	/** The branch head commit sha. */
	head(): Promise<string>;
	/** UTF-8 text of one file at a commit, or null when absent. */
	readText(path: string, commit: string): Promise<string | null>;
	/** Entries of one directory at a commit ([] when absent). */
	listDir(path: string, commit: string): Promise<DirEntry[]>;
	/** Commit `changes` on top of `base` and advance the branch. */
	commit(base: string, changes: Changes, message: string): Promise<string>;
}

export class ConflictError extends Error {
	constructor(readonly paths: string[]) {
		super(
			`The data repository changed on GitHub since this action began, in files this action writes (${paths.join(", ")}). ` +
				"Nothing was written. This usually means the desktop app pushed changes to the same session or graph: " +
				"pull them into the desktop copy, stop using the desktop for this session, and retry.",
		);
		this.name = "ConflictError";
	}
}
