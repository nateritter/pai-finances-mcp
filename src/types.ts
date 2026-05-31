/**
 * Domain types for the PAI envelope-budgeting MCP server.
 *
 * Money is always integer cents to avoid floating-point drift across
 * additions, transfers, and reconciliations. Display layers convert to
 * decimal at the edge.
 *
 * Envelope vs. Category is a deliberate split:
 *   - Envelope is forward-looking: "where is this dollar allocated to go".
 *   - Category is backward-looking: "what kind of spend was this".
 * A given transaction can carry both — the envelope it draws from and the
 * descriptive category it gets tagged with for reporting.
 */

/** A real-world account that holds money. */
export interface Account {
  /** Stable opaque id. UUID or app-native id, depending on the data source. */
  id: string;
  /** Human-readable label, e.g. "Chase Checking". */
  name: string;
  /** Account kind. Drives signing conventions for credit vs. debit balances. */
  type: "checking" | "savings" | "credit" | "cash";
  /** Current balance in integer cents. Credit accounts use negative for debt owed. */
  balance_cents: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
}

/** A budgeting bucket — a forward-looking allocation target. */
export interface Envelope {
  /** Stable opaque id. */
  id: string;
  /** Human-readable label, e.g. "Groceries". */
  name: string;
  /** Target fill amount for one period, integer cents. */
  target_amount_cents: number;
  /** Current balance available in this envelope, integer cents. */
  balance_cents: number;
  /** Refill cadence the target applies to. */
  period: "weekly" | "monthly" | "annual";
}

/** A single money movement against an account, optionally tagged to an envelope. */
export interface Transaction {
  /** Stable opaque id. */
  id: string;
  /** ISO-8601 date or datetime string. Source-of-truth for ordering. */
  date: string;
  /** Signed amount in integer cents. Negative = outflow, positive = inflow. */
  amount_cents: number;
  /** ISO 4217 currency code. Should match the source account in practice. */
  currency: string;
  /** Free-text payee / memo as reported by the bank or the user. */
  description: string;
  /** Account this transaction posted against. */
  account_id: string;
  /** Optional envelope this draws from. Absent for unallocated transactions. */
  envelope_id?: string;
  /** Optional descriptive tag for reporting. Distinct from envelope. */
  category?: string;
  /** Optional free-text annotation. */
  notes?: string;
}
