/**
 * Live integration tests for ScraperDataSource against the real Liquid Budget API.
 *
 * Run with: `bun test test/scraper-source.live.test.ts`
 *
 * Requires a valid Liquid Budget session JWT in the LB_TEST_JWT env var.
 * The JWT bypasses login (which we can't run from tests without the
 * password); for full login-flow tests, set LB_TEST_EMAIL + LB_TEST_PASSWORD
 * instead.
 *
 * Tests hit the live www.liquidbudget.com API — keep them focused, no
 * mutations, and respect the personal-use ToS.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { ScraperDataSource } from "../src/data/scraper-source";

const JWT = process.env.LB_TEST_JWT;
const EMAIL = process.env.LB_TEST_EMAIL ?? "test@example.com";
const PASSWORD = process.env.LB_TEST_PASSWORD ?? "test-password-not-used";

// Construct a source with a pre-injected session, bypassing the real login.
// The `as any` is the deliberate test-only escape hatch — production code
// must use the constructor + ensureSession path.
function makeAuthedSource(): ScraperDataSource {
	if (!JWT) {
		throw new Error(
			"LB_TEST_JWT env var is required for live tests. " +
				"Get a fresh JWT by logging in to liquidbudget.com and copying " +
				"the `authorization-cookie` value from DevTools.",
		);
	}
	const source = new ScraperDataSource(EMAIL, PASSWORD);
	// Internals: seed the cookie jar with the JWT + mark as logged in.
	(source as any).jar.cookies.set("authorization-cookie", JWT);
	(source as any).loggedIn = true;
	return source;
}

describe("ScraperDataSource — live Liquid Budget API", () => {
	let source: ScraperDataSource;

	beforeAll(() => {
		source = makeAuthedSource();
	});

	test("listEnvelopes returns non-empty array of well-shaped envelopes", async () => {
		const envelopes = await source.listEnvelopes();
		expect(envelopes.length).toBeGreaterThan(0);

		// Every envelope must have the type's shape.
		for (const e of envelopes) {
			expect(typeof e.id).toBe("string");
			expect(e.id.length).toBeGreaterThan(0);
			expect(typeof e.name).toBe("string");
			expect(e.name.length).toBeGreaterThan(0);
			expect(typeof e.target_amount_cents).toBe("number");
			expect(typeof e.balance_cents).toBe("number");
			expect(e.period).toBe("monthly");
		}

		// At least one envelope should be category-prefixed ("Category / Name").
		const categorized = envelopes.filter((e) => e.name.includes(" / "));
		expect(categorized.length).toBeGreaterThan(0);
	});

	test("listAccounts returns non-empty array with at least one real balance", async () => {
		const accounts = await source.listAccounts();
		expect(accounts.length).toBeGreaterThan(0);

		for (const a of accounts) {
			expect(typeof a.id).toBe("string");
			expect(a.id.length).toBeGreaterThan(0);
			expect(typeof a.name).toBe("string");
			expect(["checking", "savings", "credit", "cash"]).toContain(a.type);
			expect(typeof a.balance_cents).toBe("number");
			expect(typeof a.currency).toBe("string");
		}

		// At least one externally-linked account should report a non-zero balance.
		const withBalance = accounts.filter((a) => a.balance_cents !== 0);
		expect(withBalance.length).toBeGreaterThan(0);
	});

	test("getBalanceSummary aggregates accounts and envelopes correctly", async () => {
		const summary = await source.getBalanceSummary();

		expect(typeof summary.total_balance_cents).toBe("number");
		expect(Array.isArray(summary.per_account)).toBe(true);
		expect(Array.isArray(summary.per_envelope)).toBe(true);
		expect(summary.per_account.length).toBeGreaterThan(0);
		expect(summary.per_envelope.length).toBeGreaterThan(0);

		// total_balance_cents must equal the sum of per_account balances.
		const accountSum = summary.per_account.reduce(
			(s, a) => s + a.balance_cents,
			0,
		);
		expect(summary.total_balance_cents).toBe(accountSum);

		// Every per_account / per_envelope entry should have a non-empty id.
		for (const entry of summary.per_account) {
			expect(entry.account_id.length).toBeGreaterThan(0);
		}
		for (const entry of summary.per_envelope) {
			expect(entry.envelope_id.length).toBeGreaterThan(0);
		}
	});

	test("listTransactions returns real transactions sorted newest-first with well-shaped rows", async () => {
		const all = await source.listTransactions();
		expect(all.length).toBeGreaterThan(10); // budget has many transactions

		for (const t of all.slice(0, 20)) {
			expect(typeof t.id).toBe("string");
			expect(t.id.length).toBeGreaterThan(0);
			// ISO-8601 date string (YYYY-MM-DD)
			expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(typeof t.amount_cents).toBe("number");
			expect(t.currency).toBe("USD");
			expect(typeof t.description).toBe("string");
			expect(typeof t.account_id).toBe("string");
		}

		// Newest-first sort: the first row's date >= the last row's date.
		expect(all[0]!.date >= all[all.length - 1]!.date).toBe(true);
	});

	test("listTransactions filters by date range", async () => {
		const recent = await source.listTransactions({
			start: "2026-01-01",
			end: "2026-12-31",
		});
		for (const t of recent) {
			expect(t.date >= "2026-01-01").toBe(true);
			expect(t.date <= "2026-12-31").toBe(true);
		}
	});

	test("listTransactions respects the limit option", async () => {
		const five = await source.listTransactions({ limit: 5 });
		expect(five.length).toBeLessThanOrEqual(5);
	});

	test("searchTransactions finds Trader Joe's", async () => {
		const hits = await source.searchTransactions("trader joe");
		// The full budget has at least one Trader Joe's transaction
		// (confirmed via direct API probe before this test was written).
		expect(hits.length).toBeGreaterThan(0);
		expect(
			hits.every((t) =>
				t.description.toLowerCase().includes("trader joe") ||
				(t.category ?? "").toLowerCase().includes("trader joe") ||
				(t.notes ?? "").toLowerCase().includes("trader joe"),
			),
		).toBe(true);
	});

	test("addTransaction throws — write path deliberately not yet wired", async () => {
		await expect(
			source.addTransaction({
				date: "2026-05-27",
				amount_cents: 100,
				currency: "USD",
				description: "TEST — should not actually post",
				account_id: "x",
			}),
		).rejects.toThrow(/not yet wired/i);
	});
});
