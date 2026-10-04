import type { ToolContext } from "@lovable.dev/mcp-js";
import { supabaseForUser } from "./supabase";
import {
  applyCustomerWalletLedgerFilters,
  isCustomerWalletLedgerEntryVisible,
} from "./walletHistory";

export interface StatementRow {
  date: string;
  category: string;
  direction: string;
  bucket: string;
  amount: number;
  description: string;
}

export interface Statement {
  currency: "UGX";
  from: string | null;
  to: string | null;
  rows: StatementRow[];
  total_in: number;
  total_out: number;
  net_movement: number;
  closing_withdrawable: number;
  truncated: boolean;
}

export function ugx(n: number): string {
  return `UGX ${Math.round(n).toLocaleString("en-US")}`;
}

/** Validate an optional YYYY-MM-DD input. Returns undefined when absent. */
function isoDay(value: string | undefined, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date "${value}" — use YYYY-MM-DD.`);
  return endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
}

export async function buildStatement(
  ctx: ToolContext,
  opts: { from?: string; to?: string; limit?: number },
): Promise<Statement> {
  const supabase = supabaseForUser(ctx);
  const userId = ctx.getUserId();
  const take = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const fromTs = isoDay(opts.from, false);
  const toTs = isoDay(opts.to, true);

  let query = applyCustomerWalletLedgerFilters(
    supabase
      .from("general_ledger")
      .select("created_at, category, direction, amount, description, wallet_bucket, classification, source_table")
      .eq("user_id", userId)
      .eq("ledger_scope", "wallet"),
  );
  if (fromTs) query = query.gte("created_at", fromTs);
  if (toTs) query = query.lte("created_at", toTs);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(take + 1);
  if (error) throw new Error(error.message);

  const visible = (data ?? []).filter(isCustomerWalletLedgerEntryVisible);
  const truncated = visible.length > take;
  const rows: StatementRow[] = visible.slice(0, take).map((r) => ({
    date: new Date(r.created_at as string).toISOString().slice(0, 10),
    category: String(r.category ?? ""),
    direction: String(r.direction ?? ""),
    bucket: String(r.wallet_bucket ?? ""),
    amount: Number(r.amount ?? 0),
    description: String(r.description ?? ""),
  }));

  const total_in = rows.filter((r) => r.direction === "cash_in").reduce((s, r) => s + r.amount, 0);
  const total_out = rows.filter((r) => r.direction === "cash_out").reduce((s, r) => s + r.amount, 0);

  const { data: available } = await supabase.rpc("get_user_available_balance", { p_user_id: userId });

  return {
    currency: "UGX",
    from: opts.from ?? null,
    to: opts.to ?? null,
    rows,
    total_in,
    total_out,
    net_movement: total_in - total_out,
    closing_withdrawable: Number(available ?? 0),
    truncated,
  };
}

export function statementTitle(s: Statement): string {
  const range = s.from || s.to ? `${s.from ?? "start"} to ${s.to ?? "today"}` : "all recorded activity";
  return `Welile wallet statement (${range})`;
}