/**
 * ScraperDataSource — authenticated HTTP client for the Liquid Budget web app.
 *
 * The web app is a React + Vite SPA at https://www.liquidbudget.com backed by
 * a Spring Boot API. Auth is **JWT-bearer in an HttpOnly cookie** — POST
 * /api/user/login returns `authorization-cookie=<JWT>` (HS512, 30-day expiry)
 * which is sent on subsequent requests. There is NO server-side CSRF check
 * despite the Axios bundle's `xsrfCookieName`/`xsrfHeaderName` defaults
 * (those are client-side conventions the server doesn't enforce).
 *
 * Plain fetch + a minimal cookie jar bridges it — no Playwright, no headless
 * browser. The cookie jar tracks `authorization-cookie` (the session) plus
 * `__cf_bm` (Cloudflare bot management).
 *
 * Lifecycle: lazy login on first call; cookies live on `this` for the lifetime
 * of the Durable Object instance. On 401 from /api/*, the session is
 * invalidated and one re-login retry runs.
 *
 * Credentials are env-only — never hardcoded, never logged. MFA is sent via
 * the `mfaCode` body field; if `LB_TOTP_CODE` is supplied as a Worker secret,
 * it's passed through (single-shot — TOTP rotation not implemented yet).
 *
 * ToS: personal use against the user's own account. No probing of other
 * users' data. No aggressive request rates.
 */

import type { Account, Envelope, Transaction } from "../types";
import type {
	BalanceSummary,
	DataSource,
	ListTransactionsOpts,
} from "./source";

// ============================================================================
// ENDPOINT PATHS
// ============================================================================
// Confirmed via empirical probing 2026-05-27 (using Nate's session JWT):
//   POST /api/user/login                               — login (JWT response)
//   GET  /api/budget/user                              — list this user's budgets
//   GET  /api/bucket/budget/{budgetId}                 — envelopes (Liquid Budget calls them "buckets")
//   GET  /api/account/budget/{budgetId}                — budget-side accounts (no balances; externalAccountId flags linked accounts)
//   GET  /api/category/budget/{budgetId}               — envelope categories (Bills / Needs / Wants)
//   GET  /api/recurring-transaction/budget/{budgetId}  — scheduled recurring transactions
//   GET  /api/rule/budget/{budgetId}                   — auto-categorization rules
//
// NOTE: /api/view/budget/{id} returns [] (empty array) — it's a "saved views"
// list, NOT a dashboard bulk-view as I'd initially assumed. Per-resource
// fetches are the right pattern.
//
// Transactions read endpoint (discovered via bundle introspection 2026-05-27):
//   GET /api/account/transaction/budget/{budgetId}     — all transactions
//     for the budget. Returns one big array (sortable client-side by
//     dateEpoch). Sample shape:
//       {id, budgetId, accountId, dateEpoch, type, status, payee, bucketId,
//        transferTransactionId, externalTransactionId, outflow|inflow, amount, tagIds}
//     `amount` is SIGNED micro-units (cents = amount / 100). `payee` is the
//     description. `bucketId` is the envelope link.
//
// Amount convention: Liquid Budget uses `amount` (decimal dollars) and
// `amountV2` (micro-units = dollars × 10000). To convert to cents:
// `cents = amountV2 / 100`.
// ============================================================================

const BASE_URL = "https://www.liquidbudget.com";

const ENDPOINTS = {
	authLogin: "/api/user/login",
	budgetList: "/api/budget/user",
	buckets: (budgetId: string) => `/api/bucket/budget/${budgetId}`,
	accounts: (budgetId: string) => `/api/account/budget/${budgetId}`,
	categories: (budgetId: string) => `/api/category/budget/${budgetId}`,
	transactions: (budgetId: string) => `/api/account/transaction/budget/${budgetId}`,
} as const;

// Workers fetch with browser-shape headers so requests look indistinguishable
// from the real SPA. The User-Agent value is arbitrary but must be non-empty.
const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

// ============================================================================
// CookieJar — minimal stand-in for tough-cookie that runs in Workers
// ============================================================================

class CookieJar {
	private cookies = new Map<string, string>();

	/** Ingest all Set-Cookie headers from a Response into the jar. */
	ingest(response: Response): void {
		// `getSetCookie` returns an array of individual Set-Cookie header values,
		// honoring the spec even when the platform folds them. Workers exposes it.
		const setCookies =
			typeof (response.headers as Headers & {
				getSetCookie?: () => string[];
			}).getSetCookie === "function"
				? (response.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
				: [];
		for (const raw of setCookies) {
			const [pair] = raw.split(";");
			if (!pair) continue;
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			this.cookies.set(name, value);
		}
	}

	/** Serialize the jar as a Cookie header. */
	cookieHeader(): string {
		return [...this.cookies.entries()]
			.map(([k, v]) => `${k}=${v}`)
			.join("; ");
	}

	get(name: string): string | undefined {
		return this.cookies.get(name);
	}

	clear(): void {
		this.cookies.clear();
	}
}

// ============================================================================
// ScraperDataSource
// ============================================================================

export class ScraperDataSource implements DataSource {
	private jar = new CookieJar();
	private loggedIn = false;
	private loginPromise: Promise<void> | null = null;
	// Budget context — Liquid Budget scopes most data under a budget UUID.
	// Auto-discovered from /api/budget/user on first call; cached for the DO
	// instance lifetime.
	private budgetId: string | null = null;
	private budgetPromise: Promise<string> | null = null;

	constructor(
		private readonly email: string,
		private readonly password: string,
		private readonly mfaCode: string = "",
	) {
		if (!email || !password) {
			throw new Error(
				"ScraperDataSource requires LB_EMAIL and LB_PASSWORD env vars",
			);
		}
	}

	/**
	 * Resolve the active budget UUID. Lazy + cached. If the user has multiple
	 * budgets, the first one in the response is used — extend with a budget
	 * picker env var if Nate ever needs explicit selection.
	 */
	private async ensureBudgetId(): Promise<string> {
		if (this.budgetId) return this.budgetId;
		if (this.budgetPromise) return this.budgetPromise;
		this.budgetPromise = (async () => {
			const resp = await this.authedGet(ENDPOINTS.budgetList);
			const raw = (await resp.json()) as unknown;
			const list = unwrap(raw);
			if (list.length === 0) {
				throw new Error("GET /api/budget/user returned an empty list");
			}
			const first = list[0] as Record<string, unknown>;
			const id = first.id ?? first.budget_id ?? first.uuid;
			if (typeof id !== "string" || id.length === 0) {
				throw new Error(
					`No budget id found in first row: ${JSON.stringify(first).slice(0, 200)}`,
				);
			}
			this.budgetId = id;
			return id;
		})().finally(() => {
			this.budgetPromise = null;
		});
		return this.budgetPromise;
	}

	/** No-op cache invalidation — kept for callers; nothing to clear today. */
	private invalidateCache(): void {
		// Future: when we add a per-resource cache, clear it here.
	}

	// ------------------------------------------------------------------------
	// Session lifecycle
	// ------------------------------------------------------------------------

	private async ensureSession(): Promise<void> {
		if (this.loggedIn) return;
		// Coalesce concurrent ensureSession calls to a single login.
		if (this.loginPromise) {
			await this.loginPromise;
			return;
		}
		this.loginPromise = this.login().finally(() => {
			this.loginPromise = null;
		});
		await this.loginPromise;
	}

	private async login(): Promise<void> {
		// POST /api/user/login with the exact body shape the SPA sends:
		// {email, password, mfaCode, longExpire}. No CSRF token required —
		// the login endpoint is not CSRF-protected (Axios's xsrfCookieName
		// default is a client-side convention only).
		const loginResp = await fetch(`${BASE_URL}${ENDPOINTS.authLogin}`, {
			method: "POST",
			headers: {
				...this.browserHeaders(),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				email: this.email,
				password: this.password,
				mfaCode: this.mfaCode,
				longExpire: true,
			}),
		});

		this.jar.ingest(loginResp);

		if (!loginResp.ok) {
			const body = (await loginResp.text()).slice(0, 300);
			if (
				/mfa|totp|two[-_ ]?factor|2fa/i.test(body) ||
				loginResp.status === 428
			) {
				throw new Error(
					"Liquid Budget MFA required. Set LB_TOTP_CODE secret to the " +
						"current 6-digit TOTP code (single-shot — full TOTP rotation " +
						"not yet implemented). Response excerpt: " + body,
				);
			}
			throw new Error(
				`POST ${ENDPOINTS.authLogin} failed: ${loginResp.status} — ${body}`,
			);
		}

		// Verify the auth cookie actually landed. If not, something changed
		// upstream and the JWT-bearer flow is no longer valid.
		if (!this.jar.get("authorization-cookie")) {
			throw new Error(
				"Login returned 2xx but no `authorization-cookie` Set-Cookie header was present. " +
					"Upstream may have changed auth flow.",
			);
		}

		this.loggedIn = true;
	}

	private browserHeaders(): Record<string, string> {
		return {
			Accept: "application/json, text/plain, */*",
			"Accept-Language": "en-US,en;q=0.9",
			Origin: BASE_URL,
			Referer: `${BASE_URL}/`,
			"Sec-Fetch-Dest": "empty",
			"Sec-Fetch-Mode": "cors",
			"Sec-Fetch-Site": "same-origin",
			"User-Agent": BROWSER_UA,
		};
	}

	/**
	 * Authenticated GET that auto-refreshes the session on 401.
	 */
	private async authedGet(path: string): Promise<Response> {
		await this.ensureSession();
		const url = `${BASE_URL}${path}`;

		let resp = await fetch(url, {
			headers: {
				...this.browserHeaders(),
				Cookie: this.jar.cookieHeader(),
			},
		});
		this.jar.ingest(resp);

		if (resp.status === 401) {
			// Session expired — clear, log in again, retry once.
			this.loggedIn = false;
			this.jar.clear();
			await this.ensureSession();
			resp = await fetch(url, {
				headers: {
					...this.browserHeaders(),
					Cookie: this.jar.cookieHeader(),
				},
			});
			this.jar.ingest(resp);
		}

		if (!resp.ok) {
			const body = (await resp.clone().text()).slice(0, 300);
			throw new Error(`GET ${path} failed: ${resp.status} — ${body}`);
		}
		return resp;
	}

	/**
	 * Authenticated POST. The session JWT (in `authorization-cookie`) is the
	 * sole auth mechanism — no CSRF header needed for /api/* mutations either.
	 */
	private async authedPost(path: string, body: unknown): Promise<Response> {
		await this.ensureSession();
		const url = `${BASE_URL}${path}`;

		const doPost = () => fetch(url, {
			method: "POST",
			headers: {
				...this.browserHeaders(),
				"Content-Type": "application/json",
				Cookie: this.jar.cookieHeader(),
			},
			body: JSON.stringify(body),
		});

		let resp = await doPost();
		this.jar.ingest(resp);

		if (resp.status === 401) {
			this.loggedIn = false;
			this.jar.clear();
			await this.ensureSession();
			resp = await doPost();
			this.jar.ingest(resp);
		}

		if (!resp.ok) {
			const text = (await resp.clone().text()).slice(0, 300);
			throw new Error(`POST ${path} failed: ${resp.status} — ${text}`);
		}
		return resp;
	}

	// ------------------------------------------------------------------------
	// DataSource implementation
	// ------------------------------------------------------------------------

	async listTransactions(opts?: ListTransactionsOpts): Promise<Transaction[]> {
		const budgetId = await this.ensureBudgetId();
		// Build a bucket id → category-prefixed name map for the `category` field.
		const [txResp, bucketsResp, categoriesResp] = await Promise.all([
			this.authedGet(ENDPOINTS.transactions(budgetId)),
			this.authedGet(ENDPOINTS.buckets(budgetId)),
			this.authedGet(ENDPOINTS.categories(budgetId)),
		]);
		const bucketCategoryMap = await buildBucketCategoryMap(bucketsResp, categoriesResp);
		const rows = mapTransactions(unwrap(await txResp.json()), bucketCategoryMap);

		let result = rows;
		if (opts?.start) result = result.filter((r) => r.date >= opts.start!);
		if (opts?.end) result = result.filter((r) => r.date <= opts.end!);
		if (opts?.account_id) result = result.filter((r) => r.account_id === opts.account_id);
		// Sort newest-first; matches what a budgeting UI usually wants.
		result.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
		if (opts?.limit) result = result.slice(0, opts.limit);
		return result;
	}

	async listEnvelopes(): Promise<Envelope[]> {
		const budgetId = await this.ensureBudgetId();
		const resp = await this.authedGet(ENDPOINTS.buckets(budgetId));
		const buckets = unwrap(await resp.json());
		// Build a category id → name map so envelope output can show the group.
		const categoriesResp = await this.authedGet(ENDPOINTS.categories(budgetId));
		const categoryMap = new Map<string, string>();
		for (const c of unwrap(await categoriesResp.json())) {
			const obj = c as Record<string, unknown>;
			if (typeof obj.id === "string" && typeof obj.name === "string") {
				categoryMap.set(obj.id, obj.name);
			}
		}
		return mapBucketsToEnvelopes(buckets, categoryMap);
	}

	/**
	 * Accounts with LEDGER-DERIVED balances. Fetches internal accounts + the full
	 * transaction ledger, then sets each balance to the sum of that account's
	 * transactions (incl. ADJUSTMENT + TRANSFER legs — both move real money). Liquid
	 * Budget's reconcile (account.reconciledOn) trues-up the ledger. NOTE: an account
	 * with no ledger transactions resolves to 0. This is the interface method, so both
	 * MCP tools (list_accounts, get_balance_summary via getBalanceSummary) read every
	 * balance straight from the ledger.
	 */
	async listAccounts(): Promise<Account[]> {
		const [accounts, txs] = await Promise.all([
			this.listAccountsNoBalances(),
			this.listTransactions(),
		]);
		const ledger = new Map<string, number>();
		for (const t of txs) {
			ledger.set(t.account_id, (ledger.get(t.account_id) ?? 0) + t.amount_cents);
		}
		return accounts.map((a) => ({ ...a, balance_cents: ledger.get(a.id) ?? 0 }));
	}

	/**
	 * Like listAccounts(), but returns Account[] with balance_cents = 0 — fetches ONLY
	 * the internal /api/account/budget endpoint; callers derive real balances from the
	 * transaction ledger. The "(manual)" name suffix is derived from the internal
	 * object's externalAccountId field (a flag Liquid Budget sets on linked accounts;
	 * absent = manually-entered), read off the same internal response — no extra fetch.
	 */
	async listAccountsNoBalances(): Promise<Account[]> {
		const budgetId = await this.ensureBudgetId();
		const accountsResp = await this.authedGet(ENDPOINTS.accounts(budgetId));
		const internalAccounts = unwrap(await accountsResp.json());
		return mapInternalAccounts(internalAccounts);
	}

	async getBalanceSummary(): Promise<BalanceSummary> {
		const [accounts, envelopes] = await Promise.all([
			this.listAccounts(),
			this.listEnvelopes(),
		]);
		const total = accounts.reduce((sum, a) => sum + a.balance_cents, 0);
		return {
			total_balance_cents: total,
			per_account: accounts.map((a) => ({
				account_id: a.id,
				balance_cents: a.balance_cents,
			})),
			per_envelope: envelopes.map((e) => ({
				envelope_id: e.id,
				balance_cents: e.balance_cents,
			})),
		};
	}

	async searchTransactions(query: string, limit?: number): Promise<Transaction[]> {
		// In-memory filter against the full transaction set. Liquid Budget
		// budgets typically have a few thousand transactions max — fits
		// comfortably in Worker memory.
		const all = await this.listTransactions();
		const needle = query.toLowerCase();
		const hits = all.filter(
			(t) =>
				t.description.toLowerCase().includes(needle) ||
				(t.category ?? "").toLowerCase().includes(needle) ||
				(t.notes ?? "").toLowerCase().includes(needle),
		);
		return limit ? hits.slice(0, limit) : hits;
	}

	async addTransaction(_t: Omit<Transaction, "id">): Promise<Transaction> {
		// Write path is not yet wired — the read endpoint
		// `/api/account/transaction/budget/{budgetId}` confirms 200 for GET,
		// but the POST shape and exact path for creating a new transaction
		// still need a DevTools capture (open the "+ Transaction" flow in
		// the SPA and capture the POST that fires).
		throw new Error(
			"add_transaction not yet wired. Read path is live, but the write " +
				"flow needs a DevTools capture of the SPA's 'add transaction' " +
				"action. Skipping in v1 since real reads cover most queries.",
		);
	}
}

// ============================================================================
// Response mappers — PATCH-ME after first capture
// ============================================================================
// These assume a flat array of records with field names matching our types.
// Real Liquid Budget responses may differ — common patches:
//   - Wrapped: response is { data: [...] } → unwrap before mapping
//   - Case: snake_case vs camelCase field names
//   - Amount units: dollars (float) vs cents (int)
//   - Date format: epoch ms vs ISO-8601 string
//   - Account/envelope as nested object vs string id
// If a mapper throws, the error message includes 200 chars of the raw response
// so the patch is obvious.
// ============================================================================

function unwrap(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (raw && typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		if (Array.isArray(obj.data)) return obj.data;
		if (Array.isArray(obj.items)) return obj.items;
		if (Array.isArray(obj.results)) return obj.results;
	}
	throw new Error(
		`Expected an array (or {data|items|results: [...]}), got: ${JSON.stringify(raw).slice(0, 200)}`,
	);
}

/**
 * Build a map of bucketId → "Category / Bucket Name" so transactions can show
 * a human-readable envelope label without an extra round-trip per row.
 */
async function buildBucketCategoryMap(
	bucketsResp: Response,
	categoriesResp: Response,
): Promise<Map<string, string>> {
	const buckets = unwrap(await bucketsResp.json());
	const categories = unwrap(await categoriesResp.json());
	const categoryNameById = new Map<string, string>();
	for (const c of categories) {
		const o = c as Record<string, unknown>;
		if (typeof o.id === "string" && typeof o.name === "string") {
			categoryNameById.set(o.id, o.name);
		}
	}
	const bucketLabelById = new Map<string, string>();
	for (const b of buckets) {
		const o = b as Record<string, unknown>;
		if (typeof o.id !== "string" || typeof o.name !== "string") continue;
		const catId = typeof o.categoryId === "string" ? o.categoryId : undefined;
		const catName = catId ? categoryNameById.get(catId) : undefined;
		bucketLabelById.set(o.id, catName ? `${catName} / ${o.name}` : o.name);
	}
	return bucketLabelById;
}

/**
 * Map Liquid Budget transactions → our Transaction type.
 *
 * Real shape (captured 2026-05-27):
 *   { id, budgetId, accountId, dateEpoch (seconds), type, status, payee,
 *     bucketId, transferTransactionId?, externalTransactionId?,
 *     outflow|inflow, amount (signed micro-units), tagIds? }
 *
 * - `payee` → `description`
 * - `bucketId` → `envelope_id`; bucket → "Category / Name" label populates `category`
 * - `dateEpoch` → ISO-8601 date string (UTC) via `new Date(dateEpoch * 1000)`
 * - `amount` is signed micro-units (amount / 100 = cents)
 * - `status` + `type` go into `notes` so the LLM has visibility (ADJUSTMENT vs
 *   TRANSACTION, CLEARED vs RECONCILED) without bloating the schema
 */
function mapTransactions(rows: unknown[], bucketLabels: Map<string, string>): Transaction[] {
	return rows.map((r) => {
		const o = r as Record<string, unknown>;
		const amount_cents = typeof o.amount === "number"
			? Math.round((o.amount as number) / 100)
			: 0;
		const dateEpoch = typeof o.dateEpoch === "number" ? (o.dateEpoch as number) : 0;
		const date = dateEpoch > 0 ? new Date(dateEpoch * 1000).toISOString().slice(0, 10) : "";
		const bucketId = typeof o.bucketId === "string" ? (o.bucketId as string) : undefined;
		const status = typeof o.status === "string" ? (o.status as string) : "";
		const type = typeof o.type === "string" ? (o.type as string) : "";
		const noteParts: string[] = [];
		if (type && type !== "TRANSACTION") noteParts.push(type);
		if (status && status !== "CLEARED") noteParts.push(status);
		const notes = noteParts.length ? noteParts.join(", ") : undefined;
		return {
			id: String(o.id ?? ""),
			date,
			amount_cents,
			currency: "USD",
			description: String(o.payee ?? ""),
			account_id: String(o.accountId ?? ""),
			envelope_id: bucketId,
			category: bucketId ? bucketLabels.get(bucketId) : undefined,
			notes,
		};
	});
}

/**
 * Map Liquid Budget buckets → our Envelope type.
 *
 * - Liquid Budget's "bucket" === our "envelope"
 * - The current-month allocation (assignments[i] where year/month match today)
 *   is the envelope's target_amount_cents
 * - balance_cents is set to target for now — Liquid Budget doesn't expose a
 *   bucket "balance" directly; computing it requires transactions, which
 *   we haven't discovered the endpoint for. KNOWN-LIMITATION: this means
 *   "balance" really means "monthly allocation" until transactions are wired.
 * - Bucket name is prefixed with the category name (Bills / Needs / Wants /
 *   etc.) for human-readable output: "Needs / 🖥️ Software"
 */
function mapBucketsToEnvelopes(
	rows: unknown[],
	categoryMap: Map<string, string>,
): Envelope[] {
	const now = new Date();
	const currentYear = now.getUTCFullYear();
	const currentMonth = now.getUTCMonth() + 1; // 1-indexed to match Liquid Budget
	return rows
		.filter((r) => {
			const o = r as Record<string, unknown>;
			return o.archived !== true;
		})
		.map((r) => {
			const o = r as Record<string, unknown>;
			const assignments = Array.isArray(o.assignments)
				? (o.assignments as Array<Record<string, unknown>>)
				: [];
			const current = assignments.find(
				(a) => a.year === currentYear && a.month === currentMonth,
			);
			const targetCents = typeof current?.amountV2 === "number"
				? Math.round((current.amountV2 as number) / 100)
				: 0;
			const categoryId = typeof o.categoryId === "string" ? o.categoryId : undefined;
			const categoryName = categoryId ? categoryMap.get(categoryId) : undefined;
			const baseName = String(o.name ?? "");
			const displayName = categoryName ? `${categoryName} / ${baseName}` : baseName;
			return {
				id: String(o.id ?? ""),
				name: displayName,
				target_amount_cents: targetCents,
				balance_cents: targetCents, // KNOWN-LIMITATION until transactions wired
				period: "monthly" as const,
			};
		});
}

// The external-balance join was REMOVED 2026-06-15 when balances moved to
// ledger-derived everywhere — no external-balance endpoint is fetched by this
// source. listAccounts() now builds on listAccountsNoBalances() + the ledger.

/** Liquid Budget uppercase account enum → our lowercase union. */
function toAccountType(raw: unknown): Account["type"] {
	const t = String(raw ?? "CHECKING").toUpperCase();
	return t === "SAVINGS"
		? "savings"
		: t === "CREDIT" || t === "CREDIT_CARD"
			? "credit"
			: t === "CASH"
				? "cash"
				: "checking";
}

/**
 * Map internal Liquid Budget accounts (/api/account/budget) → Account[] with
 * balance_cents = 0 (the caller derives real balances from the transaction ledger).
 * The "(manual)" suffix is taken from the internal object's externalAccountId field
 * (set on linked accounts; absent = manually-entered), read off the same internal
 * response. Used by listAccountsNoBalances().
 */
function mapInternalAccounts(internal: unknown[]): Account[] {
	return internal.map((r) => {
		const o = r as Record<string, unknown>;
		const externalId = typeof o.externalAccountId === "string" ? o.externalAccountId : null;
		const name = String(o.name ?? "");
		return {
			id: String(o.id ?? ""),
			name: externalId ? name : `${name} (manual)`,
			type: toAccountType(o.type),
			balance_cents: 0,
			currency: "USD",
		};
	});
}
