/**
 * DataSource is the plug-in seam that isolates the MCP tool surface from
 * the underlying budgeting backend. The MCP layer talks only to this
 * interface; concrete implementations (CSV stub today, reverse-engineered
 * scraper or official API tomorrow) can be swapped without touching the
 * tool registrations.
 */

import type { Account, Envelope, Transaction } from "../types";

/** Filter / pagination options for transaction listings. */
export interface ListTransactionsOpts {
  /** Inclusive lower-bound ISO-8601 date. */
  start?: string;
  /** Inclusive upper-bound ISO-8601 date. */
  end?: string;
  /** Restrict to a single account. */
  account_id?: string;
  /** Hard cap on returned rows; implementations should default to a sane page size. */
  limit?: number;
}

/** Snapshot view returned by getBalanceSummary. */
export interface BalanceSummary {
  /** Sum across all accounts, integer cents. */
  total_balance_cents: number;
  /** Per-account breakdown. */
  per_account: Array<{
    account_id: string;
    balance_cents: number;
  }>;
  /** Per-envelope breakdown. */
  per_envelope: Array<{
    envelope_id: string;
    balance_cents: number;
  }>;
}

/**
 * The contract every data backend must satisfy. Read methods are required;
 * write methods may throw on read-only sources (e.g. the CSV stub).
 */
export interface DataSource {
  /** List transactions, optionally filtered and capped. */
  listTransactions(opts?: ListTransactionsOpts): Promise<Transaction[]>;

  /** List every configured envelope with current balances. */
  listEnvelopes(): Promise<Envelope[]>;

  /** List every configured account with current balances. */
  listAccounts(): Promise<Account[]>;

  /** Aggregated balance view across accounts and envelopes. */
  getBalanceSummary(): Promise<BalanceSummary>;

  /** Substring / fuzzy search across transaction descriptions and notes. */
  searchTransactions(query: string, limit?: number): Promise<Transaction[]>;

  /**
   * Insert a new transaction. Implementations should assign the id and
   * return the persisted record. Read-only sources should throw.
   */
  addTransaction(t: Omit<Transaction, "id">): Promise<Transaction>;
}
