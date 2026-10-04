import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import {
  Search, User, Wallet, TrendingUp, History, FileText, Download, X,
  Phone, Mail, MapPin, ShieldCheck, Snowflake, Loader2, PiggyBank, CalendarClock,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { downloadCsv } from '@/lib/csvExport';
import { type XlsxSheet } from '@/lib/xlsxExport';
import { generatePartnerFinancialStatementPdf } from '@/lib/partnerFinancialStatementPdf';

import { cn } from '@/lib/utils';

/* ─────────────── types (shape of get_partner_360) ─────────────── */

interface SearchRow {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  funder_reference: string | null;
  joined_at: string | null;
  portfolio_count: number;
  active_count: number;
  total_principal: number;
  total_returns: number;
  last_portfolio_at: string | null;
}

type Row = Record<string, any>;

interface Partner360 {
  profile: Row | null;
  agreement: Row | null;
  totals: Row | null;
  status_breakdown: Row[];
  portfolios: Row[];
  ledger: Row[];
  topups: Row[];
  pending_portfolios: Row[];
  redemptions: Row[];
  renewals: Row[];
  requests: Row[];
  withdrawals: Row[];
  changes: Row[];
}

/* ─────────────── small shared presentational bits (DRY) ─────────────── */

const fmtDate = (v: string | null | undefined, withTime = false) => {
  if (!v) return '—';
  try { return format(new Date(v), withTime ? 'dd MMM yyyy HH:mm' : 'dd MMM yyyy'); } catch { return '—'; }
};

const money = (v: any) => formatUGX(Number(v) || 0);

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-bold tabular-nums">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Field({ icon: Icon, label, value }: { icon?: any; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="break-words text-xs font-medium">{value || '—'}</p>
      </div>
    </div>
  );
}

interface Col { key: string; label: string; render?: (r: Row) => string; align?: 'right'; wrap?: boolean }

/** One table renderer reused by every tab — keeps markup and export logic DRY. */
function DataTable({ cols, rows, empty, onRowClick, pageSize = 10 }: { cols: Col[]; rows: Row[]; empty: string; onRowClick?: (r: Row) => void; pageSize?: number }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, totalPages - 1);
  useEffect(() => { setPage(0); }, [rows]);

  if (!rows.length) {
    return <p className="py-8 text-center text-xs text-muted-foreground">{empty}</p>;
  }

  const start = current * pageSize;
  const visible = rows.slice(start, start + pageSize);

  return (
    <div className="w-full min-w-0 space-y-2">
      <div className="w-full max-w-full overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="bg-muted/50">
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={cn('px-3 py-2 text-left font-semibold whitespace-nowrap', c.align === 'right' && 'text-right')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.map((r, i) => (
              <tr
                key={r.id || `${start + i}`}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cn('hover:bg-muted/30', onRowClick && 'cursor-pointer')}
              >
                {cols.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'px-3 py-2',
                      c.wrap ? 'max-w-[220px] whitespace-normal break-words align-top' : 'whitespace-nowrap',
                      c.align === 'right' && 'text-right tabular-nums',
                    )}
                  >
                    {c.render ? c.render(r) : (r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            Showing {start + 1}–{Math.min(start + pageSize, rows.length)} of {rows.length}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </Button>
            <span className="px-1">Page {current + 1} of {totalPages}</span>
            <Button
              type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]"
              disabled={current >= totalPages - 1}
              onClick={() => setPage(current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}



const toSheet = (name: string, cols: Col[], rows: Row[]): XlsxSheet => ({
  name,
  headers: cols.map((c) => c.label),
  rows: rows.map((r) => cols.map((c) => (c.render ? c.render(r) : (r[c.key] ?? '')))),
});

/* ─────────────── column definitions (single source for UI + export) ─────────────── */

const PORTFOLIO_COLS: Col[] = [
  { key: 'portfolio_code', label: 'Code' },
  { key: 'account_name', label: 'Nickname' },
  { key: 'status', label: 'Status' },
  { key: 'investment_amount', label: 'Principal', align: 'right', render: (r) => money(r.investment_amount) },
  { key: 'roi_percentage', label: 'Rate %', align: 'right', render: (r) => `${Number(r.roi_percentage) || 0}%` },
  { key: 'total_roi_earned', label: 'Returns earned', align: 'right', render: (r) => money(r.total_roi_earned) },
  { key: 'duration_months', label: 'Term (months)', align: 'right', render: (r) => String(r.duration_months ?? '—') },
  { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
  { key: 'next_roi_date', label: 'Next payout', render: (r) => fmtDate(r.next_roi_date) },
  { key: 'maturity_date', label: 'Maturity', render: (r) => fmtDate(r.maturity_date) },
  { key: 'agent_name', label: 'Proxy agent', render: (r) => r.agent_name || '—' },
];

const LEDGER_COLS: Col[] = [
  { key: 'transaction_date', label: 'Date', render: (r) => fmtDate(r.transaction_date, true) },
  { key: 'category', label: 'Category' },
  { key: 'direction', label: 'Direction' },
  { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
  { key: 'wallet_bucket', label: 'Bucket', render: (r) => r.wallet_bucket || '—' },
  { key: 'description', label: 'Description', render: (r) => r.description || '—' },
  { key: 'reference_id', label: 'Reference', render: (r) => r.reference_id || '—' },
];

const TOPUP_COLS: Col[] = [
  { key: 'created_at', label: 'Requested', render: (r) => fmtDate(r.created_at, true) },
  { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
  { key: 'before_amount', label: 'Before', align: 'right', render: (r) => r.before_amount == null ? '—' : money(r.before_amount) },
  { key: 'after_amount', label: 'After', align: 'right', render: (r) => r.after_amount == null ? '—' : money(r.after_amount) },
  { key: 'prorata_amount', label: 'Pro-rata', align: 'right', render: (r) => money(r.prorata_amount) },
  { key: 'status', label: 'Status' },
  { key: 'effective_at', label: 'Effective', render: (r) => fmtDate(r.effective_at) },
  { key: 'reviewed_at', label: 'Reviewed', render: (r) => fmtDate(r.reviewed_at, true) },
  { key: 'review_notes', label: 'Notes', render: (r) => r.review_notes || r.rejection_reason || '—' },
];

const PENDING_COLS: Col[] = [
  { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at, true) },
  { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
  { key: 'status', label: 'Status' },
  { key: 'source', label: 'Source', render: (r) => r.source || '—' },
  { key: 'term_months', label: 'Term', align: 'right', render: (r) => String(r.term_months ?? '—') },
  { key: 'review_reason', label: 'Review note', render: (r) => r.review_reason || '—' },
];

const REQUEST_COLS: Col[] = [
  { key: 'created_at', label: 'Requested', render: (r) => fmtDate(r.created_at, true) },
  { key: 'portfolio_code', label: 'Portfolio' },
  { key: 'request_type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'redemption_scope', label: 'Scope', render: (r) => r.redemption_scope || '—' },
  { key: 'redemption_amount', label: 'Amount', align: 'right', render: (r) => money(r.redemption_amount) },
  { key: 'maturity_date', label: 'Maturity', render: (r) => fmtDate(r.maturity_date) },
  { key: 'processed_at', label: 'Processed', render: (r) => fmtDate(r.processed_at, true) },
];

const REDEMPTION_COLS: Col[] = [
  { key: 'created_at', label: 'Date', render: (r) => fmtDate(r.created_at, true) },
  { key: 'portfolio_code', label: 'Portfolio' },
  { key: 'scope', label: 'Scope' },
  { key: 'redeemed_amount', label: 'Redeemed', align: 'right', render: (r) => money(r.redeemed_amount) },
  { key: 'old_principal', label: 'Old principal', align: 'right', render: (r) => money(r.old_principal) },
  { key: 'remaining_principal', label: 'Remaining', align: 'right', render: (r) => money(r.remaining_principal) },
  { key: 'new_status', label: 'New status', render: (r) => r.new_status || '—' },
];

const RENEWAL_COLS: Col[] = [
  { key: 'created_at', label: 'Date', render: (r) => fmtDate(r.created_at, true) },
  { key: 'portfolio_code', label: 'Portfolio' },
  { key: 'source', label: 'Source', render: (r) => (r.is_auto ? 'Automatic' : r.source || 'Manual') },
  { key: 'old_maturity_date', label: 'Old maturity', render: (r) => fmtDate(r.old_maturity_date) },
  { key: 'new_maturity_date', label: 'New maturity', render: (r) => fmtDate(r.new_maturity_date) },
  { key: 'old_investment_amount', label: 'Principal before', align: 'right', render: (r) => money(r.old_investment_amount) },
  { key: 'top_up_amount', label: 'Top-up applied', align: 'right', render: (r) => money(r.top_up_amount) },
  { key: 'reason', label: 'Reason', render: (r) => r.reason || '—' },
];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Reason text with raw identifiers stripped out so Ops read a human sentence. */
const cleanReason = (r: Row) => {
  const raw = String(r.reason || '');
  if (!raw) return '—';
  return raw
    .replace(/\[Proxy initiated by agent[^\]]*\]/gi, '')
    .replace(/\|\s*Route:\s*portfolio\s*/gi, '| Portfolio ')
    .replace(UUID_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s|•-]+|[\s|•-]+$/g, '')
    .trim() || '—';
};

const proxyAgentLabel = (r: Row) => r.proxy_agent_name || (r.proxy_agent_id ? 'Unnamed agent' : '—');

const WITHDRAWAL_COLS: Col[] = [
  { key: 'created_at', label: 'Requested', render: (r) => fmtDate(r.created_at, true) },
  { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
  { key: 'status', label: 'Status' },
  { key: 'payout_method', label: 'Method', render: (r) => r.payout_method || '—' },
  { key: 'proxy_agent_name', label: 'Proxy agent', render: proxyAgentLabel },
  { key: 'reason', label: 'Purpose', render: cleanReason, wrap: true },
  { key: 'processed_at', label: 'Processed', render: (r) => fmtDate(r.processed_at, true) },
];


/**
 * Derives a money before/after pair for an audit row even when the audit
 * record only carries one side of the movement. Everything is computed
 * relative to whichever figure exists (principal, capital, delta, roi amount)
 * so the columns stop rendering a bare "—".
 */
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function changeAmounts(r: Row): { before: number | null; after: number | null; delta: number | null } {
  const m: Record<string, unknown> = (r.metadata as Record<string, unknown>) || {};
  const ov: Record<string, unknown> = (r.old_values as Record<string, unknown>) || {};
  const nv: Record<string, unknown> = (r.new_values as Record<string, unknown>) || {};

  let before =
    num(ov.investment_amount) ?? num(ov.amount) ??
    num(m.previous_capital) ?? num(m.current_capital) ?? num(m.wallet_balance_before) ??
    num(m.previous_principal) ?? num(m.old_principal) ?? num(m.principal_before);
  let after =
    num(nv.investment_amount) ?? num(nv.amount) ??
    num(m.new_capital) ?? num(m.wallet_balance_after) ?? num(m.new_principal) ?? num(m.principal_after);
  let delta =
    num(m.total_merged) ?? num(m.amount) ?? num(m.roi_amount) ?? num(m.topup_amount) ?? num(m.change_amount);

  if (delta == null && before != null && after != null) delta = after - before;
  if (before == null && after != null && delta != null) before = after - delta;
  if (after == null && before != null && delta != null) after = before + delta;

  return { before, after, delta };
}

/**
 * Portfolio payment-detail edits are recorded in `metadata.changes` as
 * { field: { from, to } }. Amount movement already has its own columns, so this
 * renders the non-amount plan/payment terms that were touched (rate, payout
 * mode, term, payout day, next payout date, status, nickname, proxy agent).
 */
const DETAIL_FIELD_LABELS: Record<string, string> = {
  roi_percentage: 'Rate',
  roi_mode: 'Payout mode',
  duration_months: 'Term (months)',
  payout_day: 'Payout day',
  next_roi_date: 'Next payout',
  maturity_date: 'Maturity',
  status: 'Status',
  account_name: 'Nickname',
  nickname: 'Nickname',
  agent_id: 'Proxy agent',
  agent_name: 'Proxy agent',
  payment_method: 'Payment method',
  payout_method: 'Payout method',
  bank_name: 'Bank',
  payout_account_name: 'Account name',
  account_number: 'Account number',
  bank_account_number: 'Account number',
  mobile_money_number: 'Mobile money number',
  momo_number: 'Mobile money number',
  momo_provider: 'Mobile money provider',
  payout_phone: 'Payout phone',
  created_at: 'Start date',
  kind: 'Portfolio kind',
};

/** Fields that describe WHERE the partner is actually paid (not just the mode). */
const PAYOUT_DESTINATION_FIELDS = [
  'payment_method', 'payout_method', 'bank_name', 'account_name',
  'account_number', 'bank_account_number', 'mobile_money_number',
  'momo_number', 'momo_provider', 'payout_phone',
];

/** Renders "Bank: Stanbic → Centenary · Account number: 123 → 456" for payout details only. */
function payoutDestinationChange(r: Row): string {
  const m: Record<string, any> = (r.metadata as Record<string, any>) || {};
  const changes: Record<string, any> = m.changes && typeof m.changes === 'object' ? m.changes : {};
  const ov: Record<string, any> = (r.old_values as Record<string, any>) || {};
  const nv: Record<string, any> = (r.new_values as Record<string, any>) || {};
  const parts: string[] = [];

  for (const field of PAYOUT_DESTINATION_FIELDS) {
    const pair = changes[field];
    const from = pair && typeof pair === 'object' ? (pair as any).from : ov[field];
    const to = pair && typeof pair === 'object' ? (pair as any).to : nv[field];
    if (from == null && to == null) continue;
    if (String(from ?? '') === String(to ?? '')) continue;
    const label = DETAIL_FIELD_LABELS[field] || field.replace(/_/g, ' ');
    parts.push(`${label}: ${prettyDetailValue(field, from)} → ${prettyDetailValue(field, to)}`);
  }

  // No change recorded — fall back to the destination currently on record, so the
  // officer still sees how this partner is paid.
  if (!parts.length) {
    const current: string[] = [];
    for (const field of PAYOUT_DESTINATION_FIELDS) {
      const v = nv[field] ?? m[field];
      if (v == null || v === '') continue;
      const label = DETAIL_FIELD_LABELS[field] || field.replace(/_/g, ' ');
      current.push(`${label}: ${prettyDetailValue(field, v)}`);
    }
    return current.length ? current.join(' · ') : '—';
  }

  return parts.join(' · ');
}

const prettyDetailValue = (field: string, v: unknown): string => {
  if (v == null || v === '') return '—';
  if (field === 'roi_percentage') return `${Number(v) || 0}%`;
  if (['next_roi_date', 'maturity_date', 'created_at'].includes(field)) return fmtDate(String(v));
  return String(v).replace(/_/g, ' ');
};

function changeDetails(r: Row): string {
  const m: Record<string, any> = (r.metadata as Record<string, any>) || {};
  const changes: Record<string, any> = m.changes && typeof m.changes === 'object' ? m.changes : {};
  const parts: string[] = [];

  for (const [field, pair] of Object.entries(changes)) {
    if (field === 'investment_amount' || field === 'amount') continue; // shown in amount columns
    if (PAYOUT_DESTINATION_FIELDS.includes(field)) continue; // shown in the payout destination column
    if (!pair || typeof pair !== 'object') continue;
    const from = (pair as any).from;
    const to = (pair as any).to;
    const same = String(from ?? '') === String(to ?? '')
      || (['next_roi_date', 'maturity_date', 'created_at'].includes(field)
        && from && to && new Date(from).getTime() === new Date(to).getTime());
    if (same) continue;
    const label = DETAIL_FIELD_LABELS[field] || field.replace(/_/g, ' ');
    parts.push(`${label}: ${prettyDetailValue(field, from)} → ${prettyDetailValue(field, to)}`);
  }

  return parts.length ? parts.join(' · ') : '—';
}

const portfolioLabel = (r: Row): string => {
  const m: Record<string, any> = (r.metadata as Record<string, any>) || {};
  return m.portfolio_code || m.portfolio_id || r.record_id || '—';
};

const CHANGE_COLS: Col[] = [
  { key: 'created_at', label: 'When', render: (r) => fmtDate(r.created_at, true) },
  { key: 'action', label: 'Action', render: (r) => r.action || r.action_type || '—' },
  { key: 'table_name', label: 'Record' },
  { key: 'portfolio', label: 'Portfolio', render: portfolioLabel },
  { key: 'actor_name', label: 'Actor', render: (r) => r.actor_name || '—' },
  { key: 'payment_details', label: 'Payment details changed', wrap: true, render: changeDetails },
  { key: 'payout_destination', label: 'Payout details (bank / mobile money)', wrap: true, render: payoutDestinationChange },
  { key: 'reason', label: 'Reason', wrap: true, render: (r) => {
    const raw = String(r.reason || (r.metadata as any)?.reason || (r.metadata as any)?.notes || '').replace(/_/g, ' ').trim();
    if (!raw) return '—';
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  } },
  { key: 'old_values', label: 'Before', align: 'right', render: (r) => {
    const { before } = changeAmounts(r);
    return before == null ? '—' : money(before);
  } },
  { key: 'change_amount', label: 'Change', align: 'right', render: (r) => {
    const { delta } = changeAmounts(r);
    if (delta == null) return '—';
    return `${delta > 0 ? '+' : delta < 0 ? '-' : ''}${money(Math.abs(delta))}`;
  } },
  { key: 'new_values', label: 'After', align: 'right', render: (r) => {
    const { after } = changeAmounts(r);
    return after == null ? '—' : money(after);
  } },
];


/* ─────────────── main panel ─────────────── */

export function PartnerProfile360() {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<SearchRow | null>(null);
  const [pfSearch, setPfSearch] = useState('');
  const [pfStatus, setPfStatus] = useState<string>('all');
  const [openPortfolio, setOpenPortfolio] = useState<Row | null>(null);
  const [wdSearch, setWdSearch] = useState('');
  const [wdStatus, setWdStatus] = useState<string>('all');
  const [openWithdrawal, setOpenWithdrawal] = useState<Row | null>(null);



  // Debounce keystrokes so typing never fans out into a request per character.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);

  const { data: results = [], isFetching: searching } = useQuery({
    queryKey: ['partner-360-search', debounced],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_search_partners' as any, {
        p_search: debounced || null,
        p_limit: 25,
      });
      if (error) throw error;
      return (data || []) as SearchRow[];
    },
    staleTime: 60_000,
  });

  // One round trip returns the entire partner record set.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['partner-360', selected?.user_id],
    enabled: !!selected?.user_id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_partner_360' as any, { p_user_id: selected!.user_id });
      if (error) throw error;
      return data as unknown as Partner360;
    },
    staleTime: 30_000,
  });

  const p = data?.profile || null;
  const totals = data?.totals || null;
  const partnerLabel = p?.full_name || selected?.full_name || 'Partner';

  // Legacy and manager-created top-ups are recorded in the portfolio audit trail,
  // while the newer self-managed flow writes partner_self_topups. Keep one view
  // without adding another request or hiding either source.
  const topups = useMemo(() => {
    if (!data) return [];
    const selfTopups = data.topups || [];
    const topupCreationActions = new Set([
      'manager_portfolio_topup',
      'manager_portfolio_topup_instant',
      'manager_portfolio_topup_pending',
    ]);
    const auditTopups = (data.changes || [])
      .filter((r) => topupCreationActions.has(String(r.action_type || r.action || '').toLowerCase()))
      .map((r) => {
        const metadata = r.metadata || {};
        const before = metadata.previous_capital ?? metadata.current_capital ?? null;
        const amount = metadata.total_merged ?? metadata.amount ?? (
          before != null && metadata.new_capital != null ? Number(metadata.new_capital) - Number(before) : null
        );
        const after = metadata.new_capital ?? (
          before != null && amount != null ? Number(before) + Number(amount) : null
        );
        return {
          id: `audit-${r.id}`,
          created_at: r.created_at,
          amount,
          before_amount: before,
          after_amount: after,
          prorata_amount: null,
          status: metadata.status || (String(r.action_type || '').includes('pending') ? 'pending' : 'recorded'),
          effective_at: r.created_at,
          reviewed_at: null,
          review_notes: metadata.reason || metadata.notes || r.reason,
        };
      });
    return [...selfTopups, ...auditTopups].sort((a, b) =>
      new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );
  }, [data]);

  const sections: { name: string; cols: Col[]; rows: Row[] }[] = useMemo(() => data ? [
    { name: 'Portfolios', cols: PORTFOLIO_COLS, rows: data.portfolios || [] },
    { name: 'Financial History', cols: LEDGER_COLS, rows: data.ledger || [] },
    { name: 'Top-Ups', cols: TOPUP_COLS, rows: topups },
    { name: 'Pending Portfolios', cols: PENDING_COLS, rows: data.pending_portfolios || [] },
    { name: 'Requests', cols: REQUEST_COLS, rows: data.requests || [] },
    { name: 'Redemptions', cols: REDEMPTION_COLS, rows: data.redemptions || [] },
    { name: 'Renewals', cols: RENEWAL_COLS, rows: data.renewals || [] },
    { name: 'Withdrawals', cols: WITHDRAWAL_COLS, rows: data.withdrawals || [] },
    { name: 'Change Log', cols: CHANGE_COLS, rows: data.changes || [] },
  ] : [], [data, topups]);

  const allPortfolios = data?.portfolios || [];

  const portfolioStatuses = useMemo(
    () => Array.from(new Set(allPortfolios.map((r) => String(r.status || '')).filter(Boolean))).sort(),
    [allPortfolios],
  );

  const filteredPortfolios = useMemo(() => {
    const q = pfSearch.trim().toLowerCase();
    return allPortfolios.filter((r) => {
      if (pfStatus !== 'all' && String(r.status || '') !== pfStatus) return false;
      if (!q) return true;
      return [r.portfolio_code, r.account_name, r.status, r.agent_name, r.investment_amount]
        .some((v) => String(v ?? '').toLowerCase().includes(q));
    });
  }, [allPortfolios, pfSearch, pfStatus]);

  const allWithdrawals = data?.withdrawals || [];

  const withdrawalStatuses = useMemo(
    () => Array.from(new Set(allWithdrawals.map((r) => String(r.status || '')).filter(Boolean))).sort(),
    [allWithdrawals],
  );

  const filteredWithdrawals = useMemo(() => {
    const q = wdSearch.trim().toLowerCase();
    return allWithdrawals.filter((r) => {
      if (wdStatus !== 'all' && String(r.status || '') !== wdStatus) return false;
      if (!q) return true;
      return [r.status, r.payout_method, r.proxy_agent_name, r.payout_code, r.amount, cleanReason(r)]
        .some((v) => String(v ?? '').toLowerCase().includes(q));
    });
  }, [allWithdrawals, wdSearch, wdStatus]);




  /**
   * Full partner financial statement as PDF: profile + position summary +
   * ONE consolidated table with a row per portfolio. Per-portfolio activity
   * (top-ups, renewals, capital payouts) is aggregated from the authoritative
   * records that carry a portfolio link — nothing is inferred or invented, and
   * any column that is empty for every portfolio is dropped from the table.
   */
  const exportStatementPdf = async () => {
    if (!data) return;
    const stamp = format(new Date(), 'yyyy-MM-dd');

    const portfolios = data.portfolios || [];

    /**
     * Returns activity lives on PLATFORM-scope ledger legs, while get_partner_360
     * only returns wallet-scope legs — which is why compounded (reinvested)
     * returns were missing from the statement entirely. Fetch them explicitly.
     */
    let returnsLegs: Row[] = [];
    if (selected?.user_id) {
      const { data: legs } = await supabase
        .from('general_ledger')
        .select('id, transaction_date, created_at, amount, category, description, reference_id')
        .eq('user_id', selected?.user_id)
        .in('category', ['roi_reinvestment', 'roi_payout', 'roi_wallet_credit', 'roi_accrued'])
        .order('transaction_date', { ascending: true })
        .limit(500);
      returnsLegs = legs || [];
    }
    /**
     * Attribute each returns leg to a portfolio: by portfolio code named in the
     * narration, else to the sole portfolio when the partner has exactly one.
     * Anything not attributable stays out — never guessed.
     */
    const returnsByPortfolio = new Map<string, { reinvested: number; paid: number; cycles: number; latest: string | null }>();
    const soleCode = portfolios.length === 1 ? String(portfolios[0].portfolio_code || '') : '';
    for (const l of returnsLegs) {
      const narration = String(l.description || '');
      const code = portfolios
        .map((p) => String(p.portfolio_code || ''))
        .find((c) => c && narration.includes(c)) || soleCode;
      if (!code) continue;
      const b = returnsByPortfolio.get(code) || { reinvested: 0, paid: 0, cycles: 0, latest: null };
      const amt = Number(l.amount) || 0;
      if (String(l.category) === 'roi_reinvestment') b.reinvested += amt; else b.paid += amt;
      b.cycles += 1;
      const when = l.transaction_date || l.created_at;
      if (when && (!b.latest || new Date(when) > new Date(b.latest))) b.latest = when;
      returnsByPortfolio.set(code, b);
    }
    const reinvested = returnsLegs
      .filter((l) => String(l.category) === 'roi_reinvestment')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const paidOut = returnsLegs
      .filter((l) => String(l.category) !== 'roi_reinvestment')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0);



    // Portfolio-linked activity. Top-ups only exist as portfolio audit rows
    // (record_id = portfolio id) plus renewal top-ups; partner_self_topups
    // carry no portfolio link, so they are never attributed to a portfolio.
    const auditTopupActions = new Set([
      'manager_portfolio_topup',
      'manager_portfolio_topup_instant',
    ]);
    const topupByPortfolio = new Map<string, { count: number; total: number }>();
    for (const c of data.changes || []) {
      const action = String(c.action_type || c.action || '').toLowerCase();
      if (!auditTopupActions.has(action)) continue;
      const pid = String(c.record_id || '');
      if (!pid) continue;
      const { delta } = changeAmounts(c);
      const bucket = topupByPortfolio.get(pid) || { count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += delta && delta > 0 ? delta : 0;
      topupByPortfolio.set(pid, bucket);
    }

    const renewalByPortfolio = new Map<string, { count: number; latest: string | null; topups: number }>();
    for (const r of data.renewals || []) {
      if (r.reversed_at) continue;
      const pid = String(r.portfolio_id || '');
      if (!pid) continue;
      const bucket = renewalByPortfolio.get(pid) || { count: 0, latest: null, topups: 0 };
      bucket.count += 1;
      bucket.topups += Number(r.top_up_amount) || 0;
      if (!bucket.latest || new Date(r.created_at) > new Date(bucket.latest)) bucket.latest = r.created_at;
      renewalByPortfolio.set(pid, bucket);
    }

    // Capital paid out is only attributable per portfolio through redemptions.
    const payoutByCode = new Map<string, { count: number; total: number; latest: string | null }>();
    for (const r of data.redemptions || []) {
      const code = String(r.portfolio_code || '');
      if (!code) continue;
      const bucket = payoutByCode.get(code) || { count: 0, total: 0, latest: null };
      bucket.count += 1;
      bucket.total += Number(r.redeemed_amount) || 0;
      if (!bucket.latest || new Date(r.created_at) > new Date(bucket.latest)) bucket.latest = r.created_at;
      payoutByCode.set(code, bucket);
    }

    const statementCols: { label: string; align?: 'right'; value: (r: Row) => string }[] = [
      { label: 'Portfolio', value: (r) => r.portfolio_code || '' },
      { label: 'Nickname', value: (r) => r.account_name || '' },
      { label: 'Status', value: (r) => r.status || '' },
      { label: 'Contribution date', value: (r) => (r.created_at ? fmtDate(r.created_at) : '') },
      { label: 'Principal', align: 'right', value: (r) => (r.investment_amount == null ? '' : money(r.investment_amount)) },
      { label: 'Rate (Returns)', align: 'right', value: (r) => (r.roi_percentage == null ? '' : `${Number(r.roi_percentage)}% monthly`) },
      {
        label: 'Computed monthly return',
        align: 'right',
        value: (r) => {
          const principal = Number(r.investment_amount) || 0;
          const rate = Number(r.roi_percentage) || 0;
          if (!principal || !rate) return '';
          return money((principal * rate) / 100);
        },
      },
      {
        label: 'Returns earned',
        align: 'right',
        value: (r) => {
          const a = returnsByPortfolio.get(String(r.portfolio_code || ''));
          const total = (a?.reinvested || 0) + (a?.paid || 0) || Number(r.total_roi_earned) || 0;
          return total ? money(total) : '';
        },
      },
      {
        label: 'Returns reinvested',
        align: 'right',
        value: (r) => {
          const a = returnsByPortfolio.get(String(r.portfolio_code || ''));
          return a?.reinvested ? money(a.reinvested) : '';
        },
      },
      {
        label: 'Returns paid out',
        align: 'right',
        value: (r) => {
          const a = returnsByPortfolio.get(String(r.portfolio_code || ''));
          return a?.paid ? money(a.paid) : '';
        },
      },
      {
        label: 'Return cycles',
        align: 'right',
        value: (r) => {
          const a = returnsByPortfolio.get(String(r.portfolio_code || ''));
          return a?.cycles ? String(a.cycles) : '';
        },
      },
      {
        label: 'Last return',
        value: (r) => {
          const a = returnsByPortfolio.get(String(r.portfolio_code || ''));
          return a?.latest ? fmtDate(a.latest) : '';
        },
      },

      { label: 'Term (months)', align: 'right', value: (r) => (r.duration_months == null ? '' : String(r.duration_months)) },
      { label: 'Maturity', value: (r) => (r.maturity_date ? fmtDate(r.maturity_date) : '') },
      { label: 'Next payout', value: (r) => (r.next_roi_date ? fmtDate(r.next_roi_date) : '') },
      { label: 'Proxy agent', value: (r) => r.agent_name || '' },
      {
        label: 'Top-ups',
        align: 'right',
        value: (r) => {
          const a = topupByPortfolio.get(String(r.id)) || { count: 0, total: 0 };
          const renewalTopups = renewalByPortfolio.get(String(r.id))?.topups || 0;
          const total = a.total + renewalTopups;
          if (!a.count && !renewalTopups) return '';
          return `${a.count || (renewalTopups ? 1 : 0)} × ${money(total)}`;
        },
      },
      {
        label: 'Payouts (capital)',
        align: 'right',
        value: (r) => {
          const a = payoutByCode.get(String(r.portfolio_code || ''));
          if (!a || !a.count) return '';
          return `${a.count} × ${money(a.total)}`;
        },
      },
      {
        label: 'Last payout',
        value: (r) => {
          const a = payoutByCode.get(String(r.portfolio_code || ''));
          return a?.latest ? fmtDate(a.latest) : '';
        },
      },
      {
        label: 'Renewals',
        align: 'right',
        value: (r) => {
          const a = renewalByPortfolio.get(String(r.id));
          return a?.count ? String(a.count) : '';
        },
      },
      {
        label: 'Last renewal',
        value: (r) => {
          const a = renewalByPortfolio.get(String(r.id));
          return a?.latest ? fmtDate(a.latest) : '';
        },
      },
      { label: 'Verified', value: (r) => (r.cfo_verified_at ? fmtDate(r.cfo_verified_at) : r.cfo_verified ? 'Yes' : '') },
    ];

    const matrix = portfolios.map((r) => statementCols.map((c) => c.value(r)));
    // Drop any column with no data at all so the statement never shows blanks.
    const keep = statementCols
      .map((_, i) => i)
      .filter((i) => matrix.some((row) => row[i] !== ''));

    const pdfSections = [{
      name: 'Portfolio breakdown',
      headers: keep.map((i) => statementCols[i].label),
      rows: matrix.map((row) => keep.map((i) => row[i])),
      rightAlign: keep.reduce<number[]>((acc, i, idx) => (statementCols[i].align === 'right' ? [...acc, idx] : acc), []),
    }];






    const blob = await generatePartnerFinancialStatementPdf({
      partner: partnerLabel,
      profile: [
        ['Partner', partnerLabel],
        ['Phone', p?.phone || '—'],
        ['Email', p?.email || '—'],
        ['Partner reference', p?.funder_reference || '—'],
        ['National ID', p?.national_id || '—'],
        ['Joined', fmtDate(p?.created_at)],
        ['Location', [p?.village, p?.parish, p?.district, p?.region, p?.country].filter(Boolean).join(', ') || '—'],
        ['Mobile money', [p?.mobile_money_provider, p?.mobile_money_number, p?.mobile_money_name].filter(Boolean).join(' • ') || '—'],
        ['Occupation', p?.occupation || '—'],
      ],
      totals: [
        ['Portfolios', String(totals?.portfolio_count ?? 0)],
        ['Active portfolios', String(totals?.active_count ?? 0)],
        ['Total principal', money(totals?.total_principal)],
        ['Active principal', money(totals?.active_principal)],
        ['Total returns', money(reinvested + paidOut || totals?.total_returns)],
        ...(reinvested ? [['Returns reinvested (compounded)', money(reinvested)] as [string, string]] : []),
        ...(paidOut ? [['Returns paid out', money(paidOut)] as [string, string]] : []),

        ['First support', fmtDate(totals?.first_portfolio_at)],
        ['Latest support', fmtDate(totals?.last_portfolio_at)],
      ],
      agreement: data.agreement ? [
        ['Reference', data.agreement.reference || '—'],
        ['Status', data.agreement.status || '—'],
        ['Agreement date', fmtDate(data.agreement.agreement_date)],
        ['Payout mode', data.agreement.payout_mode || '—'],
        ['Bank', [data.agreement.bank_name, data.agreement.bank_account_number, data.agreement.bank_account_name].filter(Boolean).join(' • ') || '—'],
        ['Mobile money', [data.agreement.momo_provider, data.agreement.momo_number, data.agreement.momo_name].filter(Boolean).join(' • ') || '—'],
      ] : undefined,
      sections: pdfSections,
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Partner_Financial_Statement_${(partnerLabel || 'partner').replace(/\s+/g, '-')}_${stamp}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };


  const exportSection = (s: { name: string; cols: Col[]; rows: Row[] }) => {
    downloadCsv(
      `${(partnerLabel || 'partner').replace(/\s+/g, '_')}_${s.name.replace(/\s+/g, '_')}_${format(new Date(), 'yyyy-MM-dd')}.csv`,
      s.cols.map((c) => c.label),
      s.rows.map((r) => s.cols.map((c) => (c.render ? c.render(r) : (r[c.key] ?? '')))),
    );
  };

  const sectionByName = (name: string) => sections.find((s) => s.name === name) || { name, cols: [], rows: [] };

  const TabPanel = ({ name, empty }: { name: string; empty: string }) => {
    const s = sectionByName(name);
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold">{s.name} <span className="text-muted-foreground">({s.rows.length})</span></p>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]" disabled={!s.rows.length} onClick={() => exportSection(s)}>
            <Download className="h-3 w-3" /> CSV
          </Button>
        </div>
        <DataTable cols={s.cols} rows={s.rows} empty={empty} />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* ═══ SEARCH ═══ */}
      <Card>
        <CardContent className="space-y-3 p-3 sm:p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search a partner by name, phone, email or partner reference"
              className="pl-9 pr-9"
              autoComplete="off"
            />
            {term && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setTerm('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-accent"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <ScrollArea className="max-h-56">
            <div className="space-y-1">
              {searching && !results.length && <Skeleton className="h-12 w-full" />}
              {!searching && !results.length && (
                <p className="py-4 text-center text-xs text-muted-foreground">No partners match that search.</p>
              )}
              {results.map((r) => (
                <button
                  key={r.user_id}
                  type="button"
                  onClick={() => setSelected(r)}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-2 rounded-lg border p-2.5 text-left transition-colors',
                    selected?.user_id === r.user_id ? 'border-primary bg-primary/5' : 'hover:bg-accent',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold">{r.full_name || 'Unnamed partner'}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {[r.phone, r.email, r.funder_reference].filter(Boolean).join(' • ') || '—'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-bold tabular-nums">{money(r.total_principal)}</p>
                    <p className="text-[10px] text-muted-foreground">{r.portfolio_count} portfolios • {r.active_count} active</p>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* ═══ DETAIL ═══ */}
      {!selected && (
        <Card>
          <CardContent className="p-10 text-center">
            <User className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm font-semibold">Select a partner</p>
            <p className="text-xs text-muted-foreground">Search above to open a full partner record — bio data, support, financial history and changes.</p>
          </CardContent>
        </Card>
      )}

      {selected && isError && (
        <Card><CardContent className="p-6 text-center text-xs text-destructive">
          Could not load this partner: {(error as any)?.message || 'unknown error'}
        </CardContent></Card>
      )}

      {selected && isLoading && (
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      )}

      {selected && data && (
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* left: profile card */}
          <div className="space-y-3">
            <Card className="overflow-hidden">
              <div className="bg-primary/10 p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/20 text-sm font-bold text-primary">
                    {(partnerLabel || 'P').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{partnerLabel}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{p?.funder_reference || 'No partner reference'}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {p?.verified && <Badge variant="secondary" className="gap-1 text-[10px]"><ShieldCheck className="h-3 w-3" /> Verified</Badge>}
                  {p?.is_frozen && <Badge variant="destructive" className="gap-1 text-[10px]"><Snowflake className="h-3 w-3" /> Frozen</Badge>}
                </div>
              </div>
              <CardContent className="p-4 pt-3">
                <Field icon={Phone} label="Phone" value={p?.phone} />
                <Field icon={Mail} label="Email" value={p?.email} />
                <Field icon={FileText} label="National ID" value={p?.national_id} />
                <Field icon={MapPin} label="Location" value={[p?.village, p?.parish, p?.district, p?.region, p?.country].filter(Boolean).join(', ')} />
                <Field icon={Wallet} label="Mobile money" value={[p?.mobile_money_provider, p?.mobile_money_number, p?.mobile_money_name].filter(Boolean).join(' • ')} />
                <Field icon={CalendarClock} label="Joined" value={fmtDate(p?.created_at)} />
                <Field icon={History} label="Last active" value={fmtDate(p?.last_active_at, true)} />
                <Field icon={User} label="Referred by" value={p?.referrer_name} />
                <Field icon={FileText} label="Occupation" value={p?.occupation} />
              </CardContent>
            </Card>

            {data.agreement && (
              <Card>
                <CardHeader className="p-4 pb-2"><CardTitle className="text-xs">Partnership Agreement</CardTitle></CardHeader>
                <CardContent className="p-4 pt-0">
                  <Field label="Reference" value={data.agreement.reference} />
                  <Field label="Status" value={data.agreement.status} />
                  <Field label="Agreement date" value={fmtDate(data.agreement.agreement_date)} />
                  <Field label="Payout mode" value={data.agreement.payout_mode} />
                  <Field label="Bank" value={[data.agreement.bank_name, data.agreement.bank_account_number, data.agreement.bank_account_name].filter(Boolean).join(' • ')} />
                  <Field label="Mobile money" value={[data.agreement.momo_provider, data.agreement.momo_number, data.agreement.momo_name].filter(Boolean).join(' • ')} />
                  <Field label="Next of kin" value={[data.agreement.kin_name, data.agreement.kin_contact].filter(Boolean).join(' • ')} />
                </CardContent>
              </Card>
            )}

            <Button className="w-full gap-2" size="sm" onClick={exportStatementPdf}>
              <Download className="h-3.5 w-3.5" /> Export full financial statement (PDF)
            </Button>

          </div>

          {/* right: tabs */}
          <Card>
            <CardContent className="p-3 sm:p-4">
              <Tabs defaultValue="support">
                <div className="-mx-1 overflow-x-auto pb-2">
                  <TabsList className="w-max">
                    <TabsTrigger value="support" className="text-[11px]">Support</TabsTrigger>
                    <TabsTrigger value="portfolios" className="text-[11px]">Portfolios</TabsTrigger>
                    <TabsTrigger value="financial" className="text-[11px]">Financial history</TabsTrigger>
                    <TabsTrigger value="topups" className="text-[11px]">Top-ups</TabsTrigger>
                    <TabsTrigger value="maturities" className="text-[11px]">Maturities</TabsTrigger>
                    <TabsTrigger value="withdrawals" className="text-[11px]">Withdrawals</TabsTrigger>
                    <TabsTrigger value="changes" className="text-[11px]">Changes</TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="support" className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Metric label="Portfolios" value={String(totals?.portfolio_count ?? 0)} hint={`${totals?.active_count ?? 0} active`} />
                    <Metric label="Total principal" value={money(totals?.total_principal)} />
                    <Metric label="Active principal" value={money(totals?.active_principal)} />
                    <Metric label="Returns earned" value={money(totals?.total_returns)} />
                    <Metric label="First support" value={fmtDate(totals?.first_portfolio_at)} />
                    <Metric label="Latest support" value={fmtDate(totals?.last_portfolio_at)} />
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-semibold">Portfolio breakdown by status</p>
                    <DataTable
                      cols={[
                        { key: 'status', label: 'Status' },
                        { key: 'count', label: 'Portfolios', align: 'right', render: (r) => String(r.count) },
                        { key: 'principal', label: 'Principal', align: 'right', render: (r) => money(r.principal) },
                      ]}
                      rows={data.status_breakdown || []}
                      empty="No portfolios recorded for this partner."
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Metric label="Top-up records" value={String(topups.length)} />
                    <Metric label="Pending portfolios" value={String((data.pending_portfolios || []).length)} />
                    <Metric label="Withdrawals" value={String((data.withdrawals || []).length)} />
                  </div>
                </TabsContent>

                <TabsContent value="portfolios" className="mt-3 space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={pfSearch}
                        onChange={(e) => setPfSearch(e.target.value)}
                        placeholder="Search portfolio code, nickname, agent or amount"
                        className="h-9 pl-9 pr-8 text-xs"
                        autoComplete="off"
                      />
                      {pfSearch && (
                        <button
                          type="button"
                          aria-label="Clear portfolio search"
                          onClick={() => setPfSearch('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-accent"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
                        {['all', ...portfolioStatuses].map((s) => (
                          <Button
                            key={s}
                            type="button"
                            size="sm"
                            variant={pfStatus === s ? 'default' : 'outline'}
                            className="h-7 shrink-0 text-[11px] capitalize"
                            onClick={() => setPfStatus(s)}
                          >
                            {s === 'all' ? 'All' : s}
                          </Button>
                        ))}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 gap-1.5 text-[11px]"
                        disabled={!filteredPortfolios.length}
                        onClick={() => exportSection({ name: 'Portfolios', cols: PORTFOLIO_COLS, rows: filteredPortfolios })}
                      >
                        <Download className="h-3 w-3" /> CSV
                      </Button>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Showing {filteredPortfolios.length} of {allPortfolios.length} portfolios — tap a row to open its full detail.
                  </p>
                  <DataTable
                    cols={PORTFOLIO_COLS}
                    rows={filteredPortfolios}
                    empty="No portfolios match this search."
                    onRowClick={(r) => setOpenPortfolio(r)}
                  />
                </TabsContent>


                <TabsContent value="financial" className="mt-3 space-y-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Metric label="Money in" value={money((data.ledger || []).filter((l) => l.direction === 'cash_in').reduce((s, l) => s + Number(l.amount || 0), 0))} />
                    <Metric label="Money out" value={money((data.ledger || []).filter((l) => l.direction === 'cash_out').reduce((s, l) => s + Number(l.amount || 0), 0))} />
                    <Metric label="Entries" value={String((data.ledger || []).length)} hint="latest 300" />
                    <Metric label="Returns paid" value={money((data.ledger || []).filter((l) => String(l.category || '').startsWith('roi_')).reduce((s, l) => s + Number(l.amount || 0), 0))} />
                  </div>
                  <TabPanel name="Financial History" empty="No wallet movements recorded." />
                  <TabPanel name="Pending Portfolios" empty="No pending portfolio commitments." />
                </TabsContent>

                <TabsContent value="topups" className="mt-3">
                  <TabPanel name="Top-Ups" empty="No top-ups recorded." />
                </TabsContent>

                <TabsContent value="maturities" className="mt-3 space-y-4">
                  <TabPanel name="Requests" empty="No maturity or redemption requests." />
                  <TabPanel name="Redemptions" empty="No redemptions recorded." />
                  <TabPanel name="Renewals" empty="No renewals recorded." />
                </TabsContent>

                <TabsContent value="withdrawals" className="mt-3 space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={wdSearch}
                        onChange={(e) => setWdSearch(e.target.value)}
                        placeholder="Search amount, status, method, proxy agent or purpose"
                        className="h-9 pl-9 pr-8 text-xs"
                        autoComplete="off"
                      />
                      {wdSearch && (
                        <button
                          type="button"
                          aria-label="Clear withdrawal search"
                          onClick={() => setWdSearch('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-accent"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
                        {['all', ...withdrawalStatuses].map((s) => (
                          <Button
                            key={s}
                            type="button"
                            size="sm"
                            variant={wdStatus === s ? 'default' : 'outline'}
                            className="h-7 shrink-0 text-[11px] capitalize"
                            onClick={() => setWdStatus(s)}
                          >
                            {s === 'all' ? 'All' : s}
                          </Button>
                        ))}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 gap-1.5 text-[11px]"
                        disabled={!filteredWithdrawals.length}
                        onClick={() => exportSection({ name: 'Withdrawals', cols: WITHDRAWAL_COLS, rows: filteredWithdrawals })}
                      >
                        <Download className="h-3 w-3" /> CSV
                      </Button>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Showing {filteredWithdrawals.length} of {allWithdrawals.length} withdrawals — tap a row to open its full detail.
                  </p>
                  <DataTable
                    cols={WITHDRAWAL_COLS}
                    rows={filteredWithdrawals}
                    empty="No withdrawals match this search."
                    onRowClick={(r) => setOpenWithdrawal(r)}
                  />
                </TabsContent>


                <TabsContent value="changes" className="mt-3">
                  <TabPanel name="Change Log" empty="No recorded changes for this partner." />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ═══ PORTFOLIO DETAIL ═══ */}
      <Dialog open={!!openPortfolio} onOpenChange={(o) => !o && setOpenPortfolio(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              <PiggyBank className="h-4 w-4 text-primary" />
              {openPortfolio?.portfolio_code || 'Portfolio'}
              {openPortfolio?.status && <Badge variant="secondary" className="text-[10px] capitalize">{openPortfolio.status}</Badge>}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {openPortfolio?.account_name || 'No nickname'} • {partnerLabel}
            </DialogDescription>
          </DialogHeader>

          {openPortfolio && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Metric label="Principal" value={money(openPortfolio.investment_amount)} />
                <Metric label="Rate" value={`${Number(openPortfolio.roi_percentage) || 0}%`} hint="monthly returns rate" />
                <Metric label="Returns earned" value={money(openPortfolio.total_roi_earned)} />
                <Metric label="Term" value={`${openPortfolio.duration_months ?? '—'} months`} />
                <Metric label="Next payout" value={fmtDate(openPortfolio.next_roi_date)} />
                <Metric label="Maturity" value={fmtDate(openPortfolio.maturity_date)} />
              </div>

              <div className="rounded-lg border p-3">
                <p className="mb-1 text-xs font-semibold">Portfolio details</p>
                <div className="grid gap-x-4 sm:grid-cols-2">
                  <Field icon={FileText} label="Portfolio code" value={openPortfolio.portfolio_code} />
                  <Field icon={User} label="Proxy agent" value={openPortfolio.agent_name} />
                  <Field icon={CalendarClock} label="Created" value={fmtDate(openPortfolio.created_at, true)} />
                  <Field icon={CalendarClock} label="Last updated" value={fmtDate(openPortfolio.updated_at, true)} />
                  <Field icon={TrendingUp} label="Status" value={openPortfolio.status} />
                  <Field icon={Wallet} label="Payout mode" value={openPortfolio.payout_mode || data?.agreement?.payout_mode} />
                </div>
              </div>

              {[
                { name: 'Top-Ups', cols: TOPUP_COLS, rows: (data?.topups || []).filter((r) => r.portfolio_id === openPortfolio.id), empty: 'No top-ups on this portfolio.' },
                { name: 'Requests', cols: REQUEST_COLS, rows: (data?.requests || []).filter((r) => r.portfolio_id === openPortfolio.id || r.portfolio_code === openPortfolio.portfolio_code), empty: 'No requests on this portfolio.' },
                { name: 'Redemptions', cols: REDEMPTION_COLS, rows: (data?.redemptions || []).filter((r) => r.portfolio_id === openPortfolio.id || r.portfolio_code === openPortfolio.portfolio_code), empty: 'No redemptions on this portfolio.' },
                { name: 'Renewals', cols: RENEWAL_COLS, rows: (data?.renewals || []).filter((r) => r.portfolio_id === openPortfolio.id || r.portfolio_code === openPortfolio.portfolio_code), empty: 'No renewals on this portfolio.' },
              ].map((s) => (
                <div key={s.name} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">{s.name} <span className="text-muted-foreground">({s.rows.length})</span></p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-[11px]"
                      disabled={!s.rows.length}
                      onClick={() => exportSection({ name: `${openPortfolio.portfolio_code}_${s.name}`, cols: s.cols, rows: s.rows })}
                    >
                      <Download className="h-3 w-3" /> CSV
                    </Button>
                  </div>
                  <DataTable cols={s.cols} rows={s.rows} empty={s.empty} />
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ═══ WITHDRAWAL DETAIL ═══ */}
      <Dialog open={!!openWithdrawal} onOpenChange={(o) => !o && setOpenWithdrawal(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-sm">
              <Wallet className="h-4 w-4 text-primary" />
              {money(openWithdrawal?.amount)}
              {openWithdrawal?.status && <Badge variant="secondary" className="text-[10px] capitalize">{String(openWithdrawal.status).replace(/_/g, ' ')}</Badge>}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {partnerLabel} • requested {fmtDate(openWithdrawal?.created_at, true)}
            </DialogDescription>
          </DialogHeader>

          {openWithdrawal && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Metric label="Amount" value={money(openWithdrawal.amount)} />
                <Metric label="Method" value={String(openWithdrawal.payout_method || '—').replace(/_/g, ' ')} />
                <Metric label="Status" value={String(openWithdrawal.status || '—').replace(/_/g, ' ')} />
                <Metric label="Requested" value={fmtDate(openWithdrawal.created_at, true)} />
                <Metric label="Processed" value={fmtDate(openWithdrawal.processed_at, true)} />
                <Metric label="Settlement" value={String(openWithdrawal.settlement_state || '—').replace(/_/g, ' ')} />
              </div>

              <div className="rounded-lg border p-3">
                <p className="mb-1 text-xs font-semibold">Who handled it</p>
                <div className="grid gap-x-4 sm:grid-cols-2">
                  <Field icon={User} label="Proxy agent" value={proxyAgentLabel(openWithdrawal)} />
                  <Field icon={Phone} label="Proxy agent phone" value={openWithdrawal.proxy_agent_phone} />
                  <Field icon={ShieldCheck} label="Processed by" value={openWithdrawal.processed_by_name} />
                  <Field icon={TrendingUp} label="Priority" value={openWithdrawal.priority_level} />
                </div>
              </div>

              <div className="rounded-lg border p-3">
                <p className="mb-1 text-xs font-semibold">Payout destination</p>
                <div className="grid gap-x-4 sm:grid-cols-2">
                  <Field icon={Wallet} label="Mobile money" value={[openWithdrawal.mobile_money_provider, openWithdrawal.mobile_money_number, openWithdrawal.mobile_money_name].filter(Boolean).join(' • ')} />
                  <Field icon={Wallet} label="Bank" value={[openWithdrawal.bank_name, openWithdrawal.bank_account_number, openWithdrawal.bank_account_name].filter(Boolean).join(' • ')} />
                  <Field icon={FileText} label="Payout code" value={openWithdrawal.payout_code} />
                  <Field icon={FileText} label="Finance reference" value={openWithdrawal.fin_ops_reference} />
                  <Field icon={FileText} label="Transaction ID" value={openWithdrawal.transaction_id} />
                  <Field icon={User} label="Linked party" value={openWithdrawal.linked_party} />
                </div>
              </div>

              <div className="rounded-lg border p-3">
                <p className="mb-1 text-xs font-semibold">Purpose &amp; notes</p>
                <Field icon={FileText} label="Purpose" value={cleanReason(openWithdrawal)} />
                <Field icon={FileText} label="Full recorded reason" value={openWithdrawal.reason} />
                {openWithdrawal.rejection_reason && (
                  <Field icon={X} label="Rejection reason" value={openWithdrawal.rejection_reason} />
                )}
                <Field icon={CalendarClock} label="Last updated" value={fmtDate(openWithdrawal.updated_at, true)} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>



  );
}

export default PartnerProfile360;
