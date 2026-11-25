import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { handleAuth, type AuthEnv, type AuthProps } from "./auth/github-login.ts";
import { buildServer } from "./mcp/server.ts";
import { GitHubDataRepo } from "./storage/github.ts";

/**
 * LearnHarness MCP Worker. One Worker is both the OAuth authorization server
 * (GitHub sign-in, owner-only) and the MCP resource at /mcp. Every MCP request
 * is served statelessly; all state lives in the learner's data repository.
 */
export interface Env extends AuthEnv {
	OAUTH_KV: KVNamespace;
	DATA_REPO_OWNER: string;
	DATA_REPO_NAME: string;
	DATA_REPO_BRANCH: string;
	/** Fine-grained PAT: the data repository only, Contents read and write. */
	DATA_REPO_TOKEN: string;
	/** This Worker's public origin, e.g. https://learnharness-mcp.<you>.workers.dev (no trailing slash). */
	PUBLIC_URL: string;
}

const mcp = createMcpHandler(async () => {
	const props = getMcpAuthContext()?.props as AuthProps | undefined;
	if (!props) throw new Error("MCP request without verified OAuth props");
	const e = env as unknown as Env;
	const repo = new GitHubDataRepo({ owner: e.DATA_REPO_OWNER, repo: e.DATA_REPO_NAME, branch: e.DATA_REPO_BRANCH, token: e.DATA_REPO_TOKEN });
	return buildServer({ repo, client: props.clientName });
});

export default new OAuthProvider<Env>({
	apiRoute: "/mcp",
	apiHandler: { fetch: mcp as unknown as ExportedHandlerFetchHandler<Env> },
	defaultHandler: { fetch: (req, e) => handleAuth(req, e as Env) },
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	clientIdMetadataDocumentEnabled: true,
	scopesSupported: ["learnharness"],
	resourceMetadata: {
		resource: `${(env as unknown as Env).PUBLIC_URL}/mcp`,
		authorization_servers: [(env as unknown as Env).PUBLIC_URL],
		resource_name: "LearnHarness",
	},
});
