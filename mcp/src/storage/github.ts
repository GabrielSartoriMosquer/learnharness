import { ConflictError, type Changes, type DataRepo, type DirEntry } from "./repo.ts";

/**
 * DataRepo over the GitHub REST API (contents + git data). The token is a
 * fine-grained personal access token scoped to the data repository only
 * (Contents: read and write) — stored as a Worker secret, never logged.
 */
export interface GitHubRepoConfig {
	owner: string;
	repo: string;
	branch: string;
	token: string;
	/** Test seam; defaults to the global fetch. */
	fetch?: typeof fetch;
	apiBase?: string;
}

const MAX_REBASE_ATTEMPTS = 3;

export class GitHubDataRepo implements DataRepo {
	private readonly f: typeof fetch;
	private readonly api: string;

	constructor(private readonly cfg: GitHubRepoConfig) {
		this.f = cfg.fetch ?? fetch;
		this.api = cfg.apiBase ?? "https://api.github.com";
	}

	private url(path: string): string {
		return `${this.api}/repos/${this.cfg.owner}/${this.cfg.repo}${path}`;
	}

	private async call(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
		return this.f(this.url(path), {
			method,
			headers: {
				authorization: `Bearer ${this.cfg.token}`,
				accept,
				"x-github-api-version": "2022-11-28",
				"user-agent": "learnharness-mcp",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}

	private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.call(method, path, body);
		if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
		return (await res.json()) as T;
	}

	async head(): Promise<string> {
		const ref = await this.json<{ object: { sha: string } }>("GET", `/git/ref/heads/${encodeURIComponent(this.cfg.branch)}`);
		return ref.object.sha;
	}

	async readText(path: string, commit: string): Promise<string | null> {
		const res = await this.call("GET", `/contents/${encodePath(path)}?ref=${commit}`, undefined, "application/vnd.github.raw+json");
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GitHub read ${path} failed: ${res.status} ${await res.text()}`);
		return await res.text();
	}

	async listDir(path: string, commit: string): Promise<DirEntry[]> {
		const res = await this.call("GET", `/contents/${encodePath(path)}?ref=${commit}`);
		if (res.status === 404) return [];
		if (!res.ok) throw new Error(`GitHub list ${path} failed: ${res.status} ${await res.text()}`);
		const body = (await res.json()) as unknown;
		if (!Array.isArray(body)) return [];
		return body
			.filter((e: { type?: string }) => e.type === "file" || e.type === "dir")
			.map((e: { name: string; path: string; type: "file" | "dir" }) => ({ name: e.name, path: e.path, type: e.type }));
	}

	async commit(base: string, changes: Changes, message: string): Promise<string> {
		let parent = base;
		for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
			const parentCommit = await this.json<{ tree: { sha: string } }>("GET", `/git/commits/${parent}`);
			const tree = await this.json<{ sha: string }>("POST", "/git/trees", {
				base_tree: parentCommit.tree.sha,
				tree: [...changes].map(([path, content]) =>
					content === null
						? { path, mode: "100644", type: "blob", sha: null }
						: { path, mode: "100644", type: "blob", content },
				),
			});
			const created = await this.json<{ sha: string }>("POST", "/git/commits", { message, tree: tree.sha, parents: [parent] });
			const res = await this.call("PATCH", `/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`, { sha: created.sha, force: false });
			if (res.ok) return created.sha;
			if (res.status !== 422) throw new Error(`GitHub ref update failed: ${res.status} ${await res.text()}`);
			// Not a fast-forward: the branch moved. Rebuild on the new head only
			// when nothing this action writes changed in between.
			const head = await this.head();
			const compare = await this.json<{ files?: Array<{ filename: string; previous_filename?: string }> }>(
				"GET",
				`/compare/${base}...${head}`,
			);
			const touched = new Set((compare.files ?? []).flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]));
			const overlap = [...changes.keys()].filter((p) => touched.has(p));
			if (overlap.length > 0) throw new ConflictError(overlap);
			parent = head;
		}
		throw new Error("GitHub ref update kept racing other writes; nothing was written. Retry.");
	}
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
