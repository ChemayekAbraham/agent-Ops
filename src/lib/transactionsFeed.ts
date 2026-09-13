/**
 * transactionsFeed — single source of truth for the customer-facing
 * "Transaction History" feed (used by /transactions).
 *
 * Design rules:
 *  - ONE round trip per page (keyset pagination on transaction_date, no counts,
 *    no per-row lookups → no N+1).
 *  - Every filter (date window, service category, payment method) is pushed
 *    into the same PostgREST query, so paging never re-filters client side.
 *  - Presentation helpers (label, icon tone, method badge, masked number) live
 *    here so the list row and the detail sheet stay in sync (DRY).
 */
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Briefcase,
  CreditCard,
  FileText,
  Home,
  Percent,
  Receipt,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  applyCustomerWalletLedgerFilters,
  isCustomerWalletLedgerEntryVisible,
} from "@/lib/customerWalletHistory";
import { requisitionEntryLabel } from "@/lib/walletRequisitionLabel";

export const TX_PAGE_SIZE = 15;

export type TxDateFilter = "all" | "today" | "7d" | "30d";
export type TxServiceFilter =
  | "all"
  | "advance"
  | "deposit"
  | "withdraw"
  | "commission"
  | "payroll"
  | "requisition"
  | "transfer"
  | "rent"
  | "returns";
export type TxMethodFilter = "all" | "mobile_money" | "p2p" | "bank";

/**
 * Welile items — the fixed list a sender picks from on the transfer screen
 * (mirrors public.welile_transfer_items() server side). An item transfer is a
 * `wallet_transfer` ledger row whose description carries the item name, so the
 * item filter is a category + description match, never a new column.
 */
export const WELILE_ITEMS = [
  "Welile Rent",
  "Welile Bread",
  "Welile Chapati",
  "Welile Eggs",
  "Welile Fuel",
  "Welile Reward",
  "Welile Boda fees",
  "Welile tax",
] as const;

export type WelileItem = (typeof WELILE_ITEMS)[number];
export type TxItemFilter = "all" | WelileItem;

export const TX_ITEM_OPTIONS: { value: TxItemFilter; label: string }[] = [
  { value: "all", label: "All items" },
  ...WELILE_ITEMS.map((i) => ({ value: i as TxItemFilter, label: i })),
];

/** The Welile item an entry represents, or null when it isn't an item transfer. */
export function welileItemOf(row: {
  category: string;
  description: string | null;
}): WelileItem | null {
  if (row.category !== "wallet_transfer") return null;
  const haystack = (row.description ?? "").toLowerCase();
  return WELILE_ITEMS.find((i) => haystack.includes(i.toLowerCase())) ?? null;
}

export interface TxFeedRow {
  id: string;
  transaction_date: string;
  amount: number;
  direction: "cash_in" | "cash_out";
  category: string;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  source_table: string | null;
  classification?: string | null;
  source_id?: string | null;
  /**
   * Wallet balance immediately after this entry posted. Not fetched by
   * `fetchTxFeedPage` (a running balance is only coherent over the FULL,
   * unfiltered history — see WalletStatement's `balanceAfterById`, which
   * callers merge onto rows by `id` before rendering).
   */
  balanceAfter?: number | null;
  /**
   * For wallet_transfer rows: the person on the other side of the transfer
   * (the sender for a received item, the receiver for a sent one). Resolved
   * via the get_transfer_peers RPC, which only ever exposes the counterparty
   * of a transfer the caller personally took part in.
   */
  peer_name?: string | null;
  peer_avatar_url?: string | null;
}

export const TX_DATE_OPTIONS: { value: TxDateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export const TX_SERVICE_OPTIONS: { value: TxServiceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "advance", label: "Advance" },
  { value: "deposit", label: "Deposit" },
  { value: "withdraw", label: "Withdraw" },
  { value: "commission", label: "Commission" },
  { value: "payroll", label: "Payroll" },
  { value: "requisition", label: "Requisition" },
  { value: "transfer", label: "Transfer" },
  { value: "rent", label: "Rent" },
  { value: "returns", label: "Returns" },
];

export const TX_METHOD_OPTIONS: { value: TxMethodFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mobile_money", label: "Mobile Money" },
  { value: "p2p", label: "P2P" },
  { value: "bank", label: "Bank" },
];

/** Ledger categories grouped into the customer-facing "service" buckets. */
const SERVICE_CATEGORIES: Record<Exclude<TxServiceFilter, "all">, string[]> = {
  advance: ["agent_advance_credit", "debt_recovery"],
  deposit: ["wallet_deposit", "agent_float_deposit", "partner_funding", "share_capital"],
  withdraw: ["wallet_withdrawal", "agent_commission_withdrawal", "wallet_deduction"],
  commission: [
    "agent_commission_earned",
    "agent_commission_used_for_rent",
    "partner_commission",
  ],
  payroll: ["payroll_expense", "salary_payout"],
  // Requisition payouts aren't identified by category (see txService) — they
  // all share the generic `wallet_deposit` category, detected instead from
  // the description via requisitionEntryLabel().
  requisition: [],
  transfer: ["wallet_transfer"],
  rent: [
    "rent_disbursement",
    "rent_principal_collected",
    "tenant_repayment",
    "tenant_repayment_collected",
    "agent_repayment",
    "agent_float_used_for_rent",
    "access_fee_collected",
    "registration_fee_collected",
  ],
  returns: ["roi_wallet_credit", "roi_reinvestment", "interest_expense"],
};

const CATEGORY_TO_SERVICE = new Map<string, Exclude<TxServiceFilter, "all">>(
  Object.entries(SERVICE_CATEGORIES).flatMap(([service, cats]) =>
    cats.map((c) => [c, service as Exclude<TxServiceFilter, "all">] as const),
  ),
);

const CATEGORY_LABELS: Record<string, string> = {
  wallet_deposit: "Wallet Deposit",
  agent_float_deposit: "Float Deposit",
  partner_funding: "Partner Funding",
  share_capital: "Share Capital",
  wallet_withdrawal: "Withdrawal",
  agent_commission_withdrawal: "Commission Withdrawal",
  wallet_deduction: "Wallet Deduction",
  wallet_transfer: "Wallet Transfer",
  agent_advance_credit: "Advance",
  debt_recovery: "Advance Recovery",
  agent_commission_earned: "Commission",
  agent_commission_used_for_rent: "Commission Used For Rent",
  partner_commission: "Partner Commission",
  payroll_expense: "Payroll",
  salary_payout: "Payroll",
  rent_disbursement: "Rent Disbursement",
  rent_principal_collected: "Rent Collected",
  tenant_repayment: "Rent Repayment",
  tenant_repayment_collected: "Rent Repayment (Agent Collection)",
  agent_repayment: "Agent Repayment",
  agent_float_used_for_rent: "Float Used For Rent",
  access_fee_collected: "Access Fee",
  registration_fee_collected: "Registration Fee",
  roi_wallet_credit: "Returns Payout",
  roi_reinvestment: "Returns Reinvested",
  interest_expense: "Interest",
};

export function txLabel(row: TxFeedRow): string {
  // Overdue advance penalty accruals post as `agent_advance_credit` (they raise
  // the advance liability, not spendable cash) — label them for what they are so
  // the agent can see why the balance grew.
  if (
    row.category === "agent_advance_credit" &&
    (row.description ?? "").toLowerCase().includes("penalty interest")
  ) {
    return "Penalty Interest";
  }
  // Requisition payouts post their wallet leg as the generic `wallet_deposit`
  // category (see walletRequisitionLabel.ts for why) — recover the real
  // reason from the description before falling back to the category label.
  const requisitionLabel = requisitionEntryLabel(row.description);
  if (requisitionLabel) return requisitionLabel;
  return (
    CATEGORY_LABELS[row.category] ??

    row.category
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}

export function txService(row: TxFeedRow): Exclude<TxServiceFilter, "all"> | null {
  if (requisitionEntryLabel(row.description)) return "requisition";
  return CATEGORY_TO_SERVICE.get(row.category) ?? null;
}

export function txServiceLabel(row: TxFeedRow): string {
  const service = txService(row);
  const option = TX_SERVICE_OPTIONS.find((o) => o.value === service);
  return option?.label ?? "Other";
}

/** Service-specific icon (never the generic coins icon). */
const SERVICE_ICONS: Record<Exclude<TxServiceFilter, "all">, LucideIcon> = {
  advance: CreditCard,
  deposit: ArrowDownToLine,
  withdraw: ArrowUpFromLine,
  commission: Percent,
  payroll: Briefcase,
  requisition: FileText,
  transfer: ArrowLeftRight,
  rent: Home,
  returns: TrendingUp,
};

export function txIcon(row: TxFeedRow): LucideIcon {
  const service = txService(row);
  return (service && SERVICE_ICONS[service]) || Receipt;
}

/** Tailwind tone tokens — debits are always red, credits green. */
export function txTone(row: TxFeedRow): { amount: string; bubble: string; icon: string } {
  return row.direction === "cash_in"
    ? { amount: "text-success", bubble: "bg-success/10", icon: "text-success" }
    : { amount: "text-destructive", bubble: "bg-destructive/10", icon: "text-destructive" };
}


const MOMO_PATTERNS = ["mtn", "airtel", "momo", "mobile money"];

export function txMethod(row: TxFeedRow): TxMethodFilter {
  if (row.category === "wallet_transfer") return "p2p";
  const haystack = `${row.description ?? ""} ${row.reference_id ?? ""} ${row.source_table ?? ""}`.toLowerCase();
  if (haystack.includes("bank")) return "bank";
  if (MOMO_PATTERNS.some((p) => haystack.includes(p))) return "mobile_money";
  return "mobile_money";
}

export function txMethodLabel(row: TxFeedRow): string {
  const method = txMethod(row);
  if (method === "p2p") return "P2P";
  if (method === "bank") return "BANK";
  const haystack = `${row.description ?? ""} ${row.reference_id ?? ""}`.toLowerCase();
  if (haystack.includes("airtel")) return "AIRTEL MONEY";
  return "MTN MOMO";
}

/** Last 4 digits of any phone-like number found on the entry. */
export function txMaskedNumber(row: TxFeedRow): string | null {
  const haystack = `${row.description ?? ""} ${row.reference_id ?? ""}`;
  const match = haystack.match(/(\d{9,14})/);
  if (!match) return null;
  return `***${match[1].slice(-4)}`;
}

export function txCounterparty(row: TxFeedRow): string | null {
  return row.linked_party?.trim() || null;
}

function dateFloor(filter: TxDateFilter): string | null {
  if (filter === "all") return null;
  const now = new Date();
  if (filter === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return start.toISOString();
  }
  const days = filter === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

const METHOD_OR_FILTER: Record<Exclude<TxMethodFilter, "all">, string | null> = {
  p2p: null, // handled with an equality filter
  bank: "description.ilike.*bank*,reference_id.ilike.*bank*,source_table.ilike.*bank*",
  mobile_money:
    "description.ilike.*mtn*,description.ilike.*airtel*,description.ilike.*momo*,description.ilike.*mobile money*,reference_id.ilike.*mtn*,reference_id.ilike.*airtel*,source_table.eq.deposit_requests,source_table.eq.withdrawal_requests",
};

export interface TxFeedFilters {
  date: TxDateFilter;
  service: TxServiceFilter;
  method: TxMethodFilter;
  /** Welile item (Rent, Bread, …). Optional — defaults to every item. */
  item?: TxItemFilter;
}

export interface WelileItemTotal {
  item: WelileItem;
  inAmount: number;
  outAmount: number;
  count: number;
}

/**
 * Per-item money-in / money-out totals for the dashboard + statement summary.
 * One query over the caller's own wallet transfers (same visibility filters as
 * the feed), aggregated client side — no per-item round trip.
 */
export async function fetchWelileItemTotals(
  userId: string,
  date: TxDateFilter = "all",
): Promise<WelileItemTotal[]> {
  let query = applyCustomerWalletLedgerFilters(
    supabase
      .from("general_ledger")
      .select("id, transaction_date, amount, direction, category, description, reference_id, linked_party, source_table, source_id, classification")
      .eq("user_id", userId)
      .eq("category", "wallet_transfer")
      .in("ledger_scope", ["wallet", "bridge"]),
  ).order("transaction_date", { ascending: false });

  const floor = dateFloor(date);
  if (floor) query = query.gte("transaction_date", floor);

  const { data, error } = await query.limit(1000);
  if (error) throw error;

  const rows = ((data ?? []) as TxFeedRow[]).filter(isCustomerWalletLedgerEntryVisible);
  const totals = new Map<WelileItem, WelileItemTotal>(
    WELILE_ITEMS.map((i) => [i, { item: i, inAmount: 0, outAmount: 0, count: 0 }]),
  );
  for (const row of rows) {
    const item = welileItemOf(row);
    if (!item) continue;
    const bucket = totals.get(item)!;
    bucket.count += 1;
    if (row.direction === "cash_in") bucket.inAmount += Number(row.amount);
    else bucket.outAmount += Number(row.amount);
  }
  return [...totals.values()];
}

/**
 * Fetch one page (15 rows) of the feed.
 * `cursor` is the `transaction_date` of the last row already rendered —
 * keyset paging keeps every page a single indexed round trip.
 */
export async function fetchTxFeedPage(
  userId: string,
  filters: TxFeedFilters,
  cursor: string | null,
): Promise<{ rows: TxFeedRow[]; nextCursor: string | null }> {
  let query = applyCustomerWalletLedgerFilters(
    supabase
      .from("general_ledger")
      .select(
        "id, transaction_date, amount, direction, category, description, reference_id, linked_party, source_table, source_id, classification",
      )
      .eq("user_id", userId)
      .in("ledger_scope", ["wallet", "bridge"]),
  ).order("transaction_date", { ascending: false });

  const floor = dateFloor(filters.date);
  if (floor) query = query.gte("transaction_date", floor);

  if (filters.service !== "all") {
    query = query.in("category", SERVICE_CATEGORIES[filters.service]);
  }

  if (filters.method === "p2p") {
    query = query.eq("category", "wallet_transfer");
  } else if (filters.method !== "all") {
    const or = METHOD_OR_FILTER[filters.method];
    if (or) query = query.or(or);
  }

  if (cursor) query = query.lt("transaction_date", cursor);

  // One extra row acts as the "is there more?" probe — no count() scan.
  const { data, error } = await query.limit(TX_PAGE_SIZE + 1);
  if (error) throw error;

  const fetched = (data ?? []) as TxFeedRow[];
  const hasMore = fetched.length > TX_PAGE_SIZE;
  const pageRows = fetched.slice(0, TX_PAGE_SIZE);
  const rows = pageRows.filter(isCustomerWalletLedgerEntryVisible);
  const last = pageRows[pageRows.length - 1];

  // Enrich person-to-person transfers with the counterparty's name + photo so
  // the receiver sees WHO sent each item. Best-effort: the feed still renders
  // (name-only via linked_party) if the lookup fails.
  const transferRefs = [
    ...new Set(
      rows
        .filter((r) => r.category === "wallet_transfer" && r.reference_id)
        .map((r) => r.reference_id as string),
    ),
  ];
  if (transferRefs.length > 0) {
    try {
      const { data: peers } = await (supabase.rpc as any)("get_transfer_peers", {
        p_reference_ids: transferRefs,
      });
      const byRef = new Map<string, { peer_name: string; peer_avatar_url: string | null }>(
        ((peers ?? []) as any[]).map((p) => [p.reference_id as string, p]),
      );
      for (const r of rows) {
        const peer = r.reference_id ? byRef.get(r.reference_id) : undefined;
        if (peer) {
          r.peer_name = peer.peer_name;
          r.peer_avatar_url = peer.peer_avatar_url;
        }
      }
    } catch (e) {
      console.warn("[tx-feed] transfer peer lookup failed:", e);
    }
  }

  return { rows, nextCursor: hasMore && last ? last.transaction_date : null };
}

/** Group rows into day sections, preserving order. */
export function groupTxByDay(rows: TxFeedRow[]): { day: string; rows: TxFeedRow[] }[] {
  const out: { day: string; rows: TxFeedRow[] }[] = [];
  for (const row of rows) {
    const day = row.transaction_date.slice(0, 10);
    const tail = out[out.length - 1];
    if (tail && tail.day === day) tail.rows.push(row);
    else out.push({ day, rows: [row] });
  }
  return out;
}
