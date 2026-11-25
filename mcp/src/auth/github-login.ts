import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * The /authorize page: consent per MCP client, then GitHub sign-in, and only
 * the owner's GitHub account (ALLOWED_GITHUB_USER_ID) is let through. GitHub
 * is used only to prove identity — the GitHub token is discarded; data-repo
 * access uses the Worker's own fine-grained token.
 */
export interface AuthEnv {
	OAUTH_PROVIDER: OAuthHelpers;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	ALLOWED_GITHUB_USER_ID: string;
}

/** What completeAuthorization stores; the MCP handler reads it as ctx.props. */
export interface AuthProps extends Record<string, unknown> {
	githubLogin: string;
	clientName: string;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
	headers.set("content-type", "text/html; charset=utf-8");
	return new Response(
		`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>` +
			`<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#151515}}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style>` +
			`<body><h1>${escape(title)}</h1>${body}</body></html>`,
		{ status, headers },
	);
}

function consentPage(d: ConsentDescription, handle: string, headers: Headers): Response {
	const origin = d.clientDomain ? `Publicado por <strong>${escape(d.clientDomain)}</strong>.` : "Este app se registrou sozinho; o nome não é verificado.";
	return page(
		`Conectar ${d.clientName} ao LearnHarness?`,
		`<p><strong>${escape(d.clientName)}</strong> vai poder ler e gravar suas sessões e seu grafo de conhecimento no repositório de dados.</p>` +
			`<p>${origin} O acesso será enviado para <strong>${escape(d.redirectHost)}</strong>.</p>` +
			(d.redirectIsLoopback ? "<p><strong>Isso envia acesso para um app no seu computador.</strong> Continue só se você acabou de iniciar a conexão nele.</p>" : "") +
			`<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">` +
			`<button name="decision" value="approve">Permitir e entrar com GitHub</button><button name="decision" value="deny">Negar</button></form>`,
		200,
		headers,
	);
}

async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function handleAuth(req: Request, env: AuthEnv): Promise<Response> {
	const url = new URL(req.url);
	const oauth = env.OAUTH_PROVIDER;
	try {
		if (url.pathname === "/authorize" && req.method === "GET") {
			const request = await oauth.parseAuthRequest(req);
			const details = await oauth.describeConsent(request);
			const consent = await oauth.beginConsent(request);
			return consentPage(details, consent.handle, consent.headers);
		}
		if (url.pathname === "/authorize" && req.method === "POST") {
			const form = await req.formData();
			const handle = String(form.get("handle"));
			if (form.get("decision") !== "approve") {
				const denied = await oauth.denyConsent(req, handle);
				return new Response(null, { status: 302, headers: denied.headers });
			}
			const approved = await oauth.approveConsent(req, handle);
			const verifier = crypto.randomUUID() + crypto.randomUUID();
			const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
			const gh = new URL("https://github.com/login/oauth/authorize");
			gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
			gh.searchParams.set("redirect_uri", `${url.origin}/callback`);
			gh.searchParams.set("state", state);
			gh.searchParams.set("code_challenge", await s256(verifier));
			gh.searchParams.set("code_challenge_method", "S256");
			gh.searchParams.set("allow_signup", "false");
			headers.set("location", gh.toString());
			return new Response(null, { status: 302, headers });
		}
		if (url.pathname === "/callback") {
			const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
			const code = url.searchParams.get("code");
			if (url.searchParams.get("error") || !code) {
				headers.set("location", authorizationErrorRedirect(original, "access_denied"));
				return new Response(null, { status: 302, headers });
			}
			const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: { accept: "application/json", "content-type": "application/json", "user-agent": "learnharness-mcp" },
				body: JSON.stringify({
					client_id: env.GITHUB_CLIENT_ID,
					client_secret: env.GITHUB_CLIENT_SECRET,
					code,
					code_verifier: data.verifier,
					redirect_uri: `${url.origin}/callback`,
				}),
			});
			const token = (await tokenRes.json()) as { access_token?: string };
			if (!token.access_token) return page("Falha no login do GitHub", "<p>O GitHub não confirmou o login. Tente conectar de novo.</p>", 502);
			const userRes = await fetch("https://api.github.com/user", {
				headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "learnharness-mcp" },
			});
			const user = (await userRes.json()) as { id?: number; login?: string };
			if (!user.id || String(user.id) !== env.ALLOWED_GITHUB_USER_ID.trim()) {
				headers.set("location", authorizationErrorRedirect(original, "access_denied"));
				return new Response(null, { status: 302, headers });
			}
			const client = await oauth.lookupClient(original.clientId);
			const props: AuthProps = { githubLogin: user.login ?? String(user.id), clientName: client?.clientName ?? "unknown-client" };
			const { redirectTo } = await oauth.completeAuthorization({
				request: original,
				userId: String(user.id),
				metadata: {},
				scope: original.scope,
				props,
			});
			headers.set("location", redirectTo);
			return new Response(null, { status: 302, headers });
		}
		return new Response("Not found", { status: 404 });
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
		if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
			const message = error instanceof AuthorizationError ? error.description : "Este app não pôde ser verificado.";
			return page("Não foi possível autorizar", `<p>${escape(message ?? "Pedido inválido.")}</p><p>Comece a conexão de novo pelo seu cliente.</p>`, 400);
		}
		throw error;
	}
}
