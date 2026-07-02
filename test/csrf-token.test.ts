/**
 * Regression tests for the OAuth approval-form CSRF protection.
 *
 * Bug (2026-07-02): connecting the PAI Finances (Liquid) MCP over OAuth failed with
 *   {"error":"invalid_request","error_description":"CSRF token mismatch"}
 * because every `GET /authorize` render minted a BRAND-NEW token in both the
 * `__Host-CSRF_TOKEN` cookie and the hidden form field. The cookie is browser-global
 * (Path=/), so a second render (CLI auto-open + manual paste, a reload, a prefetch)
 * overwrote the cookie while an older form stayed on screen — submitting it sent
 * form_token=A with cookie_token=B and the equality gate threw "CSRF token mismatch".
 *
 * Fix: make the token STABLE across renders by reusing an existing valid
 * `__Host-CSRF_TOKEN` cookie value instead of always minting a new one, while keeping
 * the double-submit equality check as the sole gate (still CSRF-safe: an attacker
 * cannot read the victim's __Host- cookie).
 *
 * Runs under `bun test` — no network, no node_modules install.
 */

import { describe, expect, it } from "bun:test";
import {
	generateCSRFProtection,
	OAuthError,
	readCSRFCookie,
	validateCSRFToken,
} from "../src/workers-oauth-utils";

const COOKIE_NAME = "__Host-CSRF_TOKEN";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pull the token value out of a Set-Cookie header string. */
function cookieValueFromSetCookie(setCookie: string): string {
	const m = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
	if (!m) throw new Error(`no ${COOKIE_NAME} in Set-Cookie: ${setCookie}`);
	return m[1];
}

/** Build a POST request carrying the given cookie token (or none). */
function postWithCookie(cookieToken: string | null): Request {
	const headers = new Headers();
	if (cookieToken !== null) headers.set("Cookie", `${COOKIE_NAME}=${cookieToken}`);
	return new Request("https://example.workers.dev/authorize", { method: "POST", headers });
}

function form(csrfToken: string | null): FormData {
	const fd = new FormData();
	if (csrfToken !== null) fd.set("csrf_token", csrfToken);
	return fd;
}

describe("readCSRFCookie", () => {
	it("returns the token when the cookie is present", () => {
		const req = postWithCookie("11111111-1111-1111-1111-111111111111");
		expect(readCSRFCookie(req)).toBe("11111111-1111-1111-1111-111111111111");
	});

	it("returns null when the cookie header is absent", () => {
		expect(readCSRFCookie(postWithCookie(null))).toBeNull();
	});

	it("returns null when the cookie is present but blank", () => {
		const req = new Request("https://example.workers.dev/authorize", {
			headers: { Cookie: `${COOKIE_NAME}=` },
		});
		expect(readCSRFCookie(req)).toBeNull();
	});

	it("picks the right cookie among several", () => {
		const req = new Request("https://example.workers.dev/authorize", {
			headers: {
				Cookie: `foo=bar; ${COOKIE_NAME}=22222222-2222-2222-2222-222222222222; baz=qux`,
			},
		});
		expect(readCSRFCookie(req)).toBe("22222222-2222-2222-2222-222222222222");
	});
});

describe("generateCSRFProtection", () => {
	it("mints a fresh UUID token on a cold render (no existing cookie)", () => {
		const { token, setCookie } = generateCSRFProtection(null);
		expect(token).toMatch(UUID_RE);
		expect(cookieValueFromSetCookie(setCookie)).toBe(token);
	});

	it("keeps the required cookie attributes", () => {
		const { setCookie } = generateCSRFProtection(null);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Max-Age=600");
		expect(setCookie).not.toContain("Domain=");
	});

	it("REUSES an existing valid token instead of minting a new one (warm render)", () => {
		const existing = "33333333-3333-3333-3333-333333333333";
		const { token, setCookie } = generateCSRFProtection(existing);
		expect(token).toBe(existing);
		// still re-sets the cookie so presence + sliding expiry are guaranteed every render
		expect(cookieValueFromSetCookie(setCookie)).toBe(existing);
		expect(setCookie).toContain("Max-Age=600");
	});

	it("does NOT reflect a malformed / non-UUID cookie value (mints fresh instead)", () => {
		const evil = 'abc"><script>alert(1)</script>';
		const { token } = generateCSRFProtection(evil);
		expect(token).not.toBe(evil);
		expect(token).toMatch(UUID_RE);
	});
});

describe("validateCSRFToken (unchanged double-submit gate)", () => {
	it("passes when form token equals cookie token (same render)", () => {
		const { token, setCookie } = generateCSRFProtection(null);
		const cookieTok = cookieValueFromSetCookie(setCookie);
		expect(() => validateCSRFToken(form(token), postWithCookie(cookieTok))).not.toThrow();
	});

	it("throws 'CSRF token mismatch' on a genuine cross-value pair (two distinct UUIDs)", () => {
		const a = "44444444-4444-4444-4444-444444444444";
		const b = "55555555-5555-5555-5555-555555555555";
		expect(() => validateCSRFToken(form(a), postWithCookie(b))).toThrow("CSRF token mismatch");
	});

	it("throws 'Missing CSRF token in form data' when the form field is absent", () => {
		expect(() => validateCSRFToken(form(null), postWithCookie("66666666-6666-6666-6666-666666666666"))).toThrow(
			"Missing CSRF token in form data",
		);
	});

	it("throws 'Missing CSRF token cookie' when the cookie is absent", () => {
		expect(() => validateCSRFToken(form("77777777-7777-7777-7777-777777777777"), postWithCookie(null))).toThrow(
			"Missing CSRF token cookie",
		);
	});

	it("throws an OAuthError instance (400) on mismatch", () => {
		try {
			validateCSRFToken(form("88888888-8888-8888-8888-888888888888"), postWithCookie("99999999-9999-9999-9999-999999999999"));
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(OAuthError);
			expect((e as OAuthError).statusCode).toBe(400);
		}
	});
});

describe("REGRESSION: repeated GET /authorize no longer desyncs cookie from form", () => {
	it("two sequential renders (2nd sees 1st's cookie) yield the SAME form token", () => {
		const r1 = generateCSRFProtection(readCSRFCookie(postWithCookie(null)));
		const cookieAfterR1 = cookieValueFromSetCookie(r1.setCookie);
		// browser now holds cookieAfterR1; second render reads it
		const r2 = generateCSRFProtection(readCSRFCookie(postWithCookie(cookieAfterR1)));
		expect(r2.token).toBe(r1.token);
	});

	it("submitting an OLD form after the cookie was refreshed still validates", () => {
		// Render 1 — cold. Browser stores cookie A, form (tab 1) carries token A.
		const r1 = generateCSRFProtection(null);
		const cookieA = cookieValueFromSetCookie(r1.setCookie);

		// Render 2 — the CLI auto-open / reload. Browser sends cookie A; fix reuses it.
		const r2 = generateCSRFProtection(readCSRFCookie(postWithCookie(cookieA)));
		const cookieAfterR2 = cookieValueFromSetCookie(r2.setCookie);

		// Nate approves on the FIRST tab: form carries r1.token, browser cookie is post-render-2.
		// Before the fix cookieAfterR2 !== r1.token → "CSRF token mismatch". After: equal → passes.
		expect(() =>
			validateCSRFToken(form(r1.token), postWithCookie(cookieAfterR2)),
		).not.toThrow();
	});
});
