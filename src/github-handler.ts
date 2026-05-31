/**
 * GitHub OAuth handler for the PAI Finances MCP Worker.
 *
 * Adapted from cloudflare/ai/demos/remote-mcp-github-oauth/src/github-handler.ts
 * with two changes:
 *   1. Branding (name, description, logo) reflects this server.
 *   2. The GitHub user lookup uses bare `fetch` against the REST API instead
 *      of pulling in Octokit (~500 KB) for a single call.
 *
 * Everything else — CSRF, state, approval-dialog, session binding, error
 * handling — is verbatim from the reference, which is the canonical
 * Cloudflare-supported pattern.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "./index";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

type HandlerBindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: HandlerBindings }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		return redirectToGithub(c.req.raw, c.env.GITHUB_CLIENT_ID, stateToken, {
			"Set-Cookie": sessionBindingCookie,
		});
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description:
				"Personal envelope-budget data over MCP. Single-user, locked to one GitHub login.",
			logo: "https://github.githubassets.com/images/modules/logos_page/Octocat.png",
			name: "PAI Finances MCP",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToGithub(
			c.req.raw,
			c.env.GITHUB_CLIENT_ID,
			stateToken,
			Object.fromEntries(headers),
		);
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text(`Internal server error: ${error.message}`, 500);
	}
});

async function redirectToGithub(
	request: Request,
	githubClientId: string,
	stateToken: string,
	headers: Record<string, string> = {},
) {
	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				client_id: githubClientId,
				redirect_uri: new URL("/callback", request.url).href,
				scope: "read:user",
				state: stateToken,
				upstream_url: "https://github.com/login/oauth/authorize",
			}),
		},
		status: 302,
	});
}

/**
 * OAuth callback. Exchanges the GitHub code for an access token, fetches the
 * authenticated user's profile via bare fetch (no Octokit), and hands props
 * back to the MCP layer via OAuthProvider.completeAuthorization.
 *
 * Security: validateOAuthState checks BOTH the KV-stored state AND the
 * session-binding cookie. Prevents CSRF where an attacker injects their state
 * into a victim's flow.
 */
app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	// Bare-fetch replacement for Octokit's `users.getAuthenticated()`. GitHub
	// requires a non-empty User-Agent on REST API calls.
	const userResp = await fetch("https://api.github.com/user", {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "pai-finances-mcp",
		},
	});
	if (!userResp.ok) {
		return c.text(`Failed to fetch GitHub user (${userResp.status})`, 500);
	}
	const user = (await userResp.json()) as {
		login: string;
		name?: string | null;
		email?: string | null;
	};
	const { login, name, email } = user;

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: name ?? login,
		},
		props: {
			accessToken,
			email: email ?? null,
			login,
			name: name ?? null,
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, {
		status: 302,
		headers,
	});
});

export { app as GitHubHandler };
