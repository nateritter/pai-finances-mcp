/**
 * PAI Finances MCP — Worker entrypoint with GitHub OAuth.
 *
 * Wraps the FinanceMcpAgent in @cloudflare/workers-oauth-provider with GitHub
 * as the upstream identity provider. The Worker's default export IS the OAuth
 * provider; it intercepts every request, routes /authorize and /callback to
 * the GitHubHandler, and forwards authenticated /mcp traffic to the MCP agent
 * with the auth context attached as `this.props`.
 *
 * Single-user lock: ALLOWED_USERNAMES Set. Authenticated GitHub users not in
 * the Set complete the OAuth dance but reach a tools-empty MCP server — no
 * surface to call. Trivially extensible to multi-user later.
 *
 * Reference: https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

import { GitHubHandler } from "./github-handler";
import { CsvDataSource } from "./data/csv-source";
import { ScraperDataSource } from "./data/scraper-source";
import type { DataSource } from "./data/source";

/**
 * Single-user allowlist. The authenticated GitHub `login` MUST match an entry
 * here for tools to register. An empty Set locks everyone out.
 *
 * REPLACE "your-github-username" with your own GitHub login. Add more entries
 * to allow multiple users.
 */
const ALLOWED_USERNAMES = new Set<string>(["your-github-username"]);

/** Worker bindings declared in wrangler.jsonc + secrets via `wrangler secret put`. */
export interface Env {
  /** Durable Object namespace that hosts FinanceMcpAgent instances. */
  MCP_OBJECT: DurableObjectNamespace;
  /** KV namespace used by @cloudflare/workers-oauth-provider for tokens + PKCE state. */
  OAUTH_KV: KVNamespace;
  /** GitHub OAuth App client id. Set via `bunx wrangler secret put GITHUB_CLIENT_ID`. */
  GITHUB_CLIENT_ID: string;
  /** GitHub OAuth App client secret. Set via `bunx wrangler secret put GITHUB_CLIENT_SECRET`. */
  GITHUB_CLIENT_SECRET: string;
  /** Random 32-byte hex used to encrypt the approval cookie. `openssl rand -hex 32`. */
  COOKIE_ENCRYPTION_KEY: string;
  /** Liquid Budget login email. When set together with LB_PASSWORD, the
   *  ScraperDataSource activates and replaces the in-memory CsvDataSource. */
  LB_EMAIL?: string;
  /** Liquid Budget login password. Set via `bunx wrangler secret put LB_PASSWORD`. */
  LB_PASSWORD?: string;
}

/**
 * Auth-context props injected by OAuthProvider after a successful GitHub dance.
 * Available inside FinanceMcpAgent as `this.props`.
 */
export type Props = {
  login: string;
  name: string | null;
  email: string | null;
  accessToken: string;
  [key: string]: unknown;
};

/**
 * The MCP agent. Each session gets its own DO instance, so per-session state
 * (auth principal, recent query cache, etc.) lives on `this` without leaking
 * between users. The auth context is on `this.props.login`.
 */
export class FinanceMcpAgent extends McpAgent<Env, Record<string, never>, Props> {
  /**
   * Active data backend. Env-gated:
   *   - Both LB_EMAIL and LB_PASSWORD set → ScraperDataSource (real data)
   *   - Either missing → CsvDataSource (in-memory stub)
   * Initialized in init() so we can read this.env after construction.
   */
  private dataSource!: DataSource;

  server = new McpServer({
    name: "pai-finances-mcp",
    version: "0.3.0",
  });

  async init(): Promise<void> {
    // Allowlist gate. Unauthorized users land with a tools-empty server.
    if (!ALLOWED_USERNAMES.has(this.props!.login)) {
      return;
    }

    // Pick the active data source based on installed secrets.
    this.dataSource =
      this.env.LB_EMAIL && this.env.LB_PASSWORD
        ? new ScraperDataSource(this.env.LB_EMAIL, this.env.LB_PASSWORD)
        : new CsvDataSource();

    // ----- list_transactions -----
    this.server.tool(
      "list_transactions",
      "List transactions, optionally filtered by date range and account.",
      {
        start: z
          .string()
          .optional()
          .describe("Inclusive lower-bound ISO-8601 date."),
        end: z
          .string()
          .optional()
          .describe("Inclusive upper-bound ISO-8601 date."),
        account_id: z
          .string()
          .optional()
          .describe("Restrict to a single account id."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Hard cap on returned rows."),
      },
      async (args) => {
        const rows = await this.dataSource.listTransactions(args);
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      },
    );

    // ----- list_envelopes -----
    this.server.tool(
      "list_envelopes",
      "List every configured envelope with current balances and targets.",
      {},
      async () => {
        const rows = await this.dataSource.listEnvelopes();
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      },
    );

    // ----- list_accounts -----
    this.server.tool(
      "list_accounts",
      "List every configured account with current balances.",
      {},
      async () => {
        const rows = await this.dataSource.listAccounts();
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      },
    );

    // ----- get_balance_summary -----
    this.server.tool(
      "get_balance_summary",
      "Aggregated balance view across accounts and envelopes.",
      {},
      async () => {
        const summary = await this.dataSource.getBalanceSummary();
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        };
      },
    );

    // ----- search_transactions -----
    this.server.tool(
      "search_transactions",
      "Substring search across transaction descriptions, categories, and notes.",
      {
        query: z.string().min(1).describe("Search needle."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Hard cap on returned rows."),
      },
      async ({ query, limit }) => {
        const rows = await this.dataSource.searchTransactions(query, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      },
    );

    // ----- add_transaction -----
    this.server.tool(
      "add_transaction",
      "Insert a new transaction. Read-only backends will reject this call.",
      {
        date: z.string().describe("ISO-8601 date or datetime."),
        amount_cents: z
          .number()
          .int()
          .describe("Signed integer cents. Negative = outflow."),
        currency: z.string().describe("ISO 4217 currency code, e.g. USD."),
        description: z.string().describe("Free-text payee or memo."),
        account_id: z.string().describe("Account this posts against."),
        envelope_id: z
          .string()
          .optional()
          .describe("Envelope to draw from, if allocated."),
        category: z.string().optional().describe("Descriptive tag for reporting."),
        notes: z.string().optional().describe("Free-text annotation."),
      },
      async (args) => {
        const txn = await this.dataSource.addTransaction(args);
        return {
          content: [{ type: "text", text: JSON.stringify(txn, null, 2) }],
        };
      },
    );
  }
}

export default new OAuthProvider({
  apiHandler: FinanceMcpAgent.serve("/mcp") as any,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: "/token",
});
