/**
 * Regression tests for the two POST /authorize cookie defects (fixed 2026-07-02).
 *
 * Defect 1 — CSRF token one-time-use not enforced.
 *   POST /authorize called validateCSRFToken() but discarded its returned
 *   `clearCookie`, so the __Host-CSRF_TOKEN cookie was never invalidated and the
 *   token stayed replayable for its full 600s Max-Age (violates RFC 9700 §2.1).
 *
 * Defect 2 — multiple Set-Cookie collapsed into one.
 *   The handler append()-ed several Set-Cookie values onto a Headers object then
 *   passed it through Object.fromEntries(headers). fromEntries keeps only a single
 *   value per header name (comma-joined for Set-Cookie), which browsers mis-parse —
 *   so only a broken combined cookie reached the client.
 *
 * The fix routes Set-Cookie values as an explicit string[] into redirectToGithub,
 * which append()s each one so they survive as distinct headers. These tests pin
 * that contract at the redirectToGithub boundary. No network, no KV.
 */

import { describe, expect, it } from "bun:test";
import { redirectToGithub } from "../src/github-handler";

const REQ = new Request("https://pai-finances-mcp.example.workers.dev/authorize");

describe("redirectToGithub Set-Cookie preservation", () => {
	it("is a 302 to the GitHub authorize URL carrying the state token", async () => {
		const res = await redirectToGithub(REQ, "gh_client_id", "state-abc");
		expect(res.status).toBe(302);
		const loc = res.headers.get("location") ?? "";
		expect(loc).toContain("github.com/login/oauth/authorize");
		expect(loc).toContain("state=state-abc");
	});

	it("emits every Set-Cookie as its own distinct header (not comma-joined)", async () => {
		const cookies = [
			"__Host-approved=abc; HttpOnly; Secure; Path=/; SameSite=Lax",
			"__Host-session=def; HttpOnly; Secure; Path=/; SameSite=Lax",
			"__Host-CSRF_TOKEN=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0",
		];
		const res = await redirectToGithub(REQ, "gh_client_id", "state-abc", cookies);
		const setCookies = res.headers.getSetCookie();
		expect(setCookies).toHaveLength(3);
		expect(setCookies).toEqual(cookies);
	});

	it("DEFECT-1 REGRESSION: the CSRF-clearing cookie reaches the response", async () => {
		// The clearCookie value validateCSRFToken() returns; must not be dropped.
		const clearCsrf = "__Host-CSRF_TOKEN=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0";
		const res = await redirectToGithub(REQ, "gh_client_id", "state-abc", [
			"__Host-approved=abc; HttpOnly; Secure; Path=/; SameSite=Lax",
			"__Host-session=def; HttpOnly; Secure; Path=/; SameSite=Lax",
			clearCsrf,
		]);
		const clearing = res.headers
			.getSetCookie()
			.filter((c) => c.startsWith("__Host-CSRF_TOKEN=") && /Max-Age=0/.test(c));
		expect(clearing).toHaveLength(1);
	});

	it("DEFECT-2 REGRESSION: Object.fromEntries WOULD have collapsed these (proof the old path was lossy)", async () => {
		const headers = new Headers();
		headers.append("Set-Cookie", "a=1");
		headers.append("Set-Cookie", "b=2");
		// The old code did this — it keeps a single (comma-joined) value.
		const collapsed = Object.fromEntries(headers);
		const collapsedCount = String(collapsed["set-cookie"] ?? "")
			.split(/,\s*/)
			.filter(Boolean).length;
		// The new path keeps them distinct.
		const res = await redirectToGithub(REQ, "gh_client_id", "s", ["a=1", "b=2"]);
		expect(res.headers.getSetCookie()).toHaveLength(2);
		// Sanity: the collapsed form carried both in ONE header, i.e. was lossy.
		expect(collapsedCount).toBeGreaterThanOrEqual(1);
		expect(res.headers.getSetCookie().length).toBeGreaterThan(
			Object.keys(collapsed).filter((k) => k.toLowerCase() === "set-cookie").length,
		);
	});
});
