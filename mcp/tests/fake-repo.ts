import { ConflictError, type Changes, type DataRepo, type DirEntry } from "../src/storage/repo.ts";

/** An in-memory git-like DataRepo: immutable snapshots per commit, a moving
 *  branch head, and the same rebase-or-refuse rule as GitHubDataRepo. */
export class FakeRepo implements DataRepo {
	private readonly commits = new Map<string, Map<string, string>>();
	private readonly parents = new Map<string, string | null>();
	branch: string;
	commitCount = 0;

	constructor(files: Record<string, string> = {}) {
		this.branch = this.store(new Map(Object.entries(files)), null);
	}

	private store(snapshot: Map<string, string>, parent: string | null): string {
		const sha = `c${this.commits.size}`;
		this.commits.set(sha, snapshot);
		this.parents.set(sha, parent);
		return sha;
	}

	files(commit = this.branch): Map<string, string> {
		return new Map(this.commits.get(commit)!);
	}

	async head() {
		return this.branch;
	}

	async readText(path: string, commit: string) {
		return this.commits.get(commit)!.get(path) ?? null;
	}

	async listDir(path: string, commit: string): Promise<DirEntry[]> {
		const prefix = `${path}/`;
		const names = new Map<string, "file" | "dir">();
		for (const p of this.commits.get(commit)!.keys()) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? "file" : "dir");
		}
		return [...names].map(([name, type]) => ({ name, path: `${prefix}${name}`, type }));
	}

	/** Simulate the desktop pushing a change. */
	push(changes: Record<string, string | null>) {
		const next = this.files();
		for (const [p, c] of Object.entries(changes)) c === null ? next.delete(p) : next.set(p, c);
		this.branch = this.store(next, this.branch);
	}

	async commit(base: string, changes: Changes, _message: string) {
		if (this.branch !== base) {
			const before = this.commits.get(base)!;
			const now = this.commits.get(this.branch)!;
			const overlap = [...changes.keys()].filter((p) => before.get(p) !== now.get(p));
			if (overlap.length > 0) throw new ConflictError(overlap);
		}
		const next = this.files();
		for (const [p, c] of changes) c === null ? next.delete(p) : next.set(p, c);
		this.branch = this.store(next, this.branch);
		this.commitCount++;
		return this.branch;
	}
}
