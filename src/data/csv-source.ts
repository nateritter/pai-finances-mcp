/**
 * CsvDataSource — read-only stub.
 *
 * The eventual wiring will read CSV exports from a local imports directory —
 * exports from a budgeting app, bank statements, or hand-maintained sheets.
 * For now this is an
 * in-memory placeholder so the MCP tool surface is exercisable end-to-end
 * without a real backend.
 *
 * addTransaction throws by design: this source is read-only. Writes belong
 * to the scraper / official-API source once that exists.
 */

import type { Account, Envelope, Transaction } from "../types";
import type {
  BalanceSummary,
  DataSource,
  ListTransactionsOpts,
} from "./source";

/** Thrown when a read-only data source receives a write call. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

const PLACEHOLDER_ACCOUNTS: Account[] = [
  {
    id: "acct_checking_primary",
    name: "Primary Checking",
    type: "checking",
    balance_cents: 482_350,
    currency: "USD",
  },
  {
    id: "acct_savings_emergency",
    name: "Emergency Savings",
    type: "savings",
    balance_cents: 1_200_000,
    currency: "USD",
  },
  {
    id: "acct_credit_visa",
    name: "Visa",
    type: "credit",
    balance_cents: -73_400,
    currency: "USD",
  },
];

const PLACEHOLDER_ENVELOPES: Envelope[] = [
  {
    id: "env_groceries",
    name: "Groceries",
    target_amount_cents: 80_000,
    balance_cents: 42_300,
    period: "monthly",
  },
  {
    id: "env_gas",
    name: "Gas",
    target_amount_cents: 20_000,
    balance_cents: 15_600,
    period: "monthly",
  },
  {
    id: "env_annual_insurance",
    name: "Annual Insurance",
    target_amount_cents: 240_000,
    balance_cents: 90_000,
    period: "annual",
  },
];

const PLACEHOLDER_TRANSACTIONS: Transaction[] = [
  {
    id: "txn_0001",
    date: "2026-05-24",
    amount_cents: -6_842,
    currency: "USD",
    description: "Trader Joe's #182",
    account_id: "acct_checking_primary",
    envelope_id: "env_groceries",
    category: "groceries",
  },
  {
    id: "txn_0002",
    date: "2026-05-23",
    amount_cents: -4_500,
    currency: "USD",
    description: "Shell — Coeur d'Alene",
    account_id: "acct_credit_visa",
    envelope_id: "env_gas",
    category: "fuel",
  },
  {
    id: "txn_0003",
    date: "2026-05-22",
    amount_cents: 250_000,
    currency: "USD",
    description: "Pickleheads payroll",
    account_id: "acct_checking_primary",
    category: "income",
    notes: "Bi-weekly direct deposit",
  },
];

export class CsvDataSource implements DataSource {
  private readonly accounts: Account[] = PLACEHOLDER_ACCOUNTS;
  private readonly envelopes: Envelope[] = PLACEHOLDER_ENVELOPES;
  private readonly transactions: Transaction[] = PLACEHOLDER_TRANSACTIONS;

  async listTransactions(opts: ListTransactionsOpts = {}): Promise<Transaction[]> {
    const { start, end, account_id, limit } = opts;
    let rows = this.transactions;

    if (account_id !== undefined) {
      rows = rows.filter((t) => t.account_id === account_id);
    }
    if (start !== undefined) {
      rows = rows.filter((t) => t.date >= start);
    }
    if (end !== undefined) {
      rows = rows.filter((t) => t.date <= end);
    }

    // Newest first — matches the convention every budgeting UI uses.
    rows = [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    if (limit !== undefined && limit > 0) {
      rows = rows.slice(0, limit);
    }
    return rows;
  }

  async listEnvelopes(): Promise<Envelope[]> {
    return this.envelopes;
  }

  async listAccounts(): Promise<Account[]> {
    return this.accounts;
  }

  async getBalanceSummary(): Promise<BalanceSummary> {
    const per_account = this.accounts.map((a) => ({
      account_id: a.id,
      balance_cents: a.balance_cents,
    }));
    const per_envelope = this.envelopes.map((e) => ({
      envelope_id: e.id,
      balance_cents: e.balance_cents,
    }));
    const total_balance_cents = per_account.reduce(
      (sum, row) => sum + row.balance_cents,
      0,
    );
    return { total_balance_cents, per_account, per_envelope };
  }

  async searchTransactions(query: string, limit?: number): Promise<Transaction[]> {
    const needle = query.toLowerCase();
    const matches = this.transactions.filter((t) => {
      const haystack = [
        t.description,
        t.category ?? "",
        t.notes ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
    const capped =
      limit !== undefined && limit > 0 ? matches.slice(0, limit) : matches;
    return capped;
  }

  async addTransaction(_t: Omit<Transaction, "id">): Promise<Transaction> {
    throw new NotImplementedError(
      "CsvDataSource is read-only. Wire ScraperDataSource or an official-API source before calling addTransaction.",
    );
  }
}
