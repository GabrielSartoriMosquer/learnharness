import type { Changes, DataRepo } from "./repo.ts";

/**
 * One harness action's unit of work: every read sees the same pinned commit,
 * writes are buffered, and flush() lands them as a single commit. The app's
 * tool code reads storage synchronously (its ports are sync), so callers
 * `load()` what an action needs first; `get()` on an unloaded path throws
 * instead of silently reading nothing.
 */
export class Workspace {
	private readonly loaded = new Map<string, string | null>();
	private readonly writes = new Map<string, string | null>();

	private constructor(
		readonly repo: DataRepo,
		readonly base: string,
	) {}

	static async open(repo: DataRepo): Promise<Workspace> {
		return new Workspace(repo, await repo.head());
	}

	async load(...paths: string[]): Promise<void> {
		await Promise.all(
			paths
				.filter((p) => !this.loaded.has(p))
				.map(async (p) => {
					this.loaded.set(p, await this.repo.readText(p, this.base));
				}),
		);
	}

	has(path: string): boolean {
		return this.writes.has(path) || this.loaded.has(path);
	}

	get(path: string): string | null {
		if (this.writes.has(path)) return this.writes.get(path)!;
		if (!this.loaded.has(path)) throw new Error(`Workspace read of unloaded path: ${path}`);
		return this.loaded.get(path)!;
	}

	set(path: string, content: string | null): void {
		this.writes.set(path, content);
	}

	listDir(path: string) {
		return this.repo.listDir(path, this.base);
	}

	pending(): Changes {
		return this.writes;
	}

	/** Commit buffered writes (no-op when nothing changed). */
	async flush(message: string): Promise<string | null> {
		const changed = new Map([...this.writes].filter(([p, c]) => !this.loaded.has(p) || this.loaded.get(p) !== c));
		if (changed.size === 0) return null;
		return this.repo.commit(this.base, changed, message);
	}
}
