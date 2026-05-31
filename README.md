# pai-finances-mcp

A personal **MCP (Model Context Protocol) server** that exposes envelope-budget
data — accounts, envelopes, transactions, balances — to Claude and any other MCP
client. It runs as a single **Cloudflare Worker**, is locked to your own GitHub
login via OAuth, and reads from a pluggable data backend.

Ask your assistant things like *"how much is left in groceries this month?"* or
*"what did I spend at Trader Joe's last week?"* without screen-sharing your
budgeting app.

> Single-user by default. Self-hosted. Your data and credentials stay in your own
> Cloudflare account — nothing in this repo contains secrets.

## How it works

```
MCP client (Claude, etc.)
        │
        ▼
GitHub OAuth  ──  @cloudflare/workers-oauth-provider  (single-user allowlist)
        │
        ▼
Cloudflare Worker: FinanceMcpAgent  (Durable Object, SQLite-backed)
        │
        ▼
DataSource interface           ◄── the swap point (src/data/source.ts)
        ├── CsvDataSource       in-memory stub (default; no secrets needed)
        └── ScraperDataSource   authenticated HTTP client against a budgeting
                                web app (activated by LB_* secrets)
```

Every MCP tool delegates to the active `DataSource`, so the backend can change
without touching the tool layer.

## Tool surface

Six tools, all backed by the active `DataSource`. All money is **integer cents**;
negative amounts are outflows.

| Tool | Arguments |
|------|-----------|
| `list_transactions` | optional `start`, `end`, `account_id`, `limit` |
| `list_envelopes` | none |
| `list_accounts` | none |
| `get_balance_summary` | none |
| `search_transactions` | `query`, optional `limit` |
| `add_transaction` | full transaction payload (read-only backends reject it) |

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers free tier
  is enough — Durable Objects and KV are included).
- [Bun](https://bun.sh/) installed locally.
- A [GitHub account](https://github.com/) to create an OAuth App for the login lock.

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/<you>/pai-finances-mcp.git
cd pai-finances-mcp
bun install
```

### 2. Authenticate Wrangler and set your account

```bash
bunx wrangler login
bunx wrangler whoami      # copy your Account ID
```

Open `wrangler.jsonc` and replace `<YOUR_CLOUDFLARE_ACCOUNT_ID>` with it.

### 3. Create the OAuth KV namespace

```bash
bunx wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into `wrangler.jsonc` → `kv_namespaces[0].id`
(replacing `<YOUR_OAUTH_KV_NAMESPACE_ID>`).

### 4. Create a GitHub OAuth App

At <https://github.com/settings/applications/new>:

| Field | Value |
|-------|-------|
| Application name | `pai-finances-mcp` |
| Homepage URL | `https://pai-finances-mcp.<your-subdomain>.workers.dev` |
| Authorization callback URL | `https://pai-finances-mcp.<your-subdomain>.workers.dev/callback` |

Copy the **Client ID**, then **Generate a new client secret** and copy it (shown
once). You can fill the final `workers.dev` hostname in after your first deploy
prints it, then edit the OAuth App.

### 5. Set your secrets

Secrets are stored encrypted in Cloudflare and are **never committed**. Run each
from your own terminal and paste the value when prompted:

```bash
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put COOKIE_ENCRYPTION_KEY    # openssl rand -hex 32
```

### 6. Set your allowlist

In `src/index.ts`, replace `your-github-username` in `ALLOWED_USERNAMES` with
your GitHub login. Anyone else who completes the OAuth flow reaches a tools-empty
server.

### 7. Deploy

```bash
bunx wrangler deploy
```

Your endpoint is `https://pai-finances-mcp.<your-subdomain>.workers.dev/mcp`.

### 8. Connect an MCP client

Point your client at the `/mcp` URL. Example for Claude Desktop
(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pai-finances": {
      "command": "npx",
      "args": ["mcp-remote", "https://pai-finances-mcp.<your-subdomain>.workers.dev/mcp"]
    }
  }
}
```

The first call opens a browser for the GitHub OAuth approval.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in values; .dev.vars is gitignored
bun run dev                      # bunx wrangler dev
bun run typecheck                # bunx tsc --noEmit
```

## Data backends

The server picks a backend at startup based on installed secrets:

- **No `LB_*` secrets** → `CsvDataSource`: an in-memory stub returning a few
  placeholder rows. Good for verifying the deploy and the OAuth lock end-to-end
  before wiring real data.
- **`LB_EMAIL` + `LB_PASSWORD` set** → `ScraperDataSource`: an authenticated HTTP
  client (plain `fetch` + a small cookie jar, no browser automation) against a
  budgeting web app. The included implementation targets
  [Liquid Budget](https://www.liquidbudget.com)'s web API.

> The `ScraperDataSource` talks to a third-party web app's private endpoints using
> **your own** login. It is experimental and unofficial — endpoints can change.
> Use it only against an account you own, and review the provider's terms. The
> `ENDPOINTS` map at the top of `src/data/scraper-source.ts` is where you patch
> any path that has drifted (mismatches surface in the error body).

Activate it:

```bash
bunx wrangler secret put LB_EMAIL
bunx wrangler secret put LB_PASSWORD
bunx wrangler deploy
```

MFA/TOTP is not yet supported; an account with MFA enabled throws a clear error
at login.

### Adding your own backend

1. Create `src/data/<name>-source.ts` exporting a class that `implements DataSource`.
2. Map the upstream shape into the domain types in `src/types.ts`
   (`Account`, `Envelope`, `Transaction`).
3. In `src/index.ts`, point the `dataSource` assignment at your new class.
4. Read-only sources should throw a clear error from `addTransaction` rather than
   silently no-op (see `CsvDataSource` for the pattern).

The MCP tool registrations never change — they bind to the interface.

## Auth internals

- The Worker's default export **is** an `OAuthProvider`. It intercepts every
  request, routes `/authorize` and `/callback` to `GitHubHandler`, and forwards
  authenticated `/mcp` traffic to `FinanceMcpAgent` with the auth context on
  `this.props`.
- `GitHubHandler` runs the approval dialog, redirects to GitHub, exchanges the
  code, and fetches `login` / `name` / `email` from the GitHub REST API (bare
  `fetch`, no Octokit).
- `init()` checks `ALLOWED_USERNAMES.has(this.props.login)` before registering
  any tool.

To use a different identity provider (Google, Cloudflare Access, …), swap
`src/github-handler.ts` for an equivalent and adjust `OAuthProvider`'s
`defaultHandler`. See the Cloudflare MCP authorization docs below.

## Envelope vs. Category

Kept deliberately distinct in `src/types.ts`:

- **Envelope** — forward-looking: *where is this dollar allocated to go*. A
  transaction draws from at most one.
- **Category** — backward-looking: *what kind of spend was this*. Useful for
  reporting and for transactions that don't draw from an envelope.

## Security notes

- No credentials live in this repo. All secrets are set via
  `bunx wrangler secret put` (production) or `.dev.vars` (local, gitignored).
- The `account_id` and KV namespace `id` in `wrangler.jsonc` are placeholders —
  fill in your own.
- The GitHub allowlist is the access boundary. An empty `ALLOWED_USERNAMES` locks
  everyone out.

## References

- Cloudflare remote MCP + GitHub OAuth demo:
  <https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth>
- Cloudflare MCP authorization docs:
  <https://developers.cloudflare.com/agents/model-context-protocol/authorization/>
- Cloudflare Agents SDK: <https://developers.cloudflare.com/agents/>
- MCP specification: <https://modelcontextprotocol.io/>

## License

[MIT](./LICENSE)
