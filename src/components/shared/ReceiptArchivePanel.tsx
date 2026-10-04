import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  Search, Loader2, X, Receipt as ReceiptIcon,
  ChevronLeft, ChevronRight, ExternalLink, Copy, Check, FileText, Archive,
  Image as ImageIcon, FileWarning, ShieldAlert,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { classifyProof } from '@/lib/payoutProof';
import { PayoutProofDialog, type ProofDialogRow } from '@/components/shared/PayoutProofDialog';
import { PayoutProofIntegrityPanel } from '@/components/shared/PayoutProofIntegrityPanel';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';

/**
 * Receipt Archive — CFO / Financial Ops surface for the platform-of-record
 * payout receipts. Every completed withdrawal_requests row with a
 * receipt_token is a permanent, retrievable receipt (public URL
 * https://welileapp.com/r/<token>). No external Gmail archive is used.
 */

type Row = {
  id: string;
  user_id: string | null;
  amount: number;
  status: string;
  payout_method: string | null;
  transaction_id: string | null;
  reason: string | null;
  created_at: string;
  processed_at: string | null;
  receipt_token: string | null;
  assigned_cashout_agent_id: string | null;
  dispatch_claimed_by: string | null;
  payout_proof: string | null;
  payout_proof_type: string | null;
  payout_proof_path: string | null;
  payout_proof_bucket: string | null;
  payout_proof_uploaded_at: string | null;
  payout_proof_uploaded_by: string | null;
  user_name?: string | null;
  user_phone?: string | null;
  agent_name?: string | null;
  agent_phone?: string | null;
  resolved_agent_profile_id?: string | null;
  uploaded_by_name?: string | null;
  /**
   * Who actually put up the cash for this payout, from
   * `merchant_out_of_pocket_advances` joined on `withdrawal_id`.
   *
   * A receipt says the customer was paid; it does NOT say the company funded
   * it. When a desk has no float the merchant fronts the payout from their own
   * phone, and the only trace is an advance row. Without these fields the
   * archive shows a completed cash-out with no hint that the money was the
   * merchant's, which is how a full day of self-funded payouts read as
   * ordinary company payouts.
   */
  float_covered?: number;
  /** Merchant's own cash fronted on the payout leg. */
  own_cash?: number;
  /** Merchant's own cash fronted on the telecom sending charge. */
  own_cash_telecom?: number;
  /** `needs_review` | `pending_reimbursement` | `rejected` | reimbursed. */
  own_cash_status?: string | null;
  own_cash_reimbursed?: boolean;
};

/** Advance-row shape needed to attribute a receipt's funding source. */
type OopRow = {
  withdrawal_id: string | null;
  kind: string;
  float_used: number | null;
  shortfall_amount: number | null;
  status: string | null;
  reimbursed_at: string | null;
};

const PAGE_SIZE = 25;
const RECEIPT_BASE_URL = 'https://welileapp.com/r/';

/**
 * Merchant's own cash behind one receipt — payout principal plus the telecom
 * sending charge they also covered. Excludes anything already refunded, so the
 * figure reads as "still out of pocket on this receipt".
 */
function ownCashTotal(r: Row): number {
  if (r.own_cash_reimbursed) return 0;
  return Number(r.own_cash ?? 0) + Number(r.own_cash_telecom ?? 0);
}

const STATUSES = [
  { v: 'all', label: 'All Statuses' },
  { v: 'completed', label: 'Completed' },
  { v: 'approved', label: 'Approved / Paid' },
  { v: 'fin_ops_approved', label: 'Fin-Ops Approved' },
  { v: 'rejected', label: 'Rejected' },
  { v: 'failed', label: 'Failed' },
];

const METHODS = [
  { v: 'all', label: 'Any Method' },
  { v: 'mtn_momo', label: 'MTN MoMo' },
  { v: 'airtel_money', label: 'Airtel Money' },
  { v: 'bank_transfer', label: 'Bank Transfer' },
  { v: 'cash', label: 'Cash' },
];

const PROOF_FILTERS = [
  { v: 'all', label: 'Any proof state' },
  { v: 'with', label: 'With proof' },
  { v: 'without', label: 'Missing proof' },
];

const statusTone = (s: string) => {
  const k = s.toLowerCase();
  if (['completed', 'approved', 'paid', 'fin_ops_approved'].includes(k))
    return 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30';
  if (['rejected', 'failed'].includes(k))
    return 'bg-destructive/10 text-destructive border-destructive/30';
  return 'bg-amber-500/10 text-amber-700 border-amber-500/30';
};

export function ReceiptArchivePanel() {
  const { toast } = useToast();

  // Committed filter state
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [status, setStatus] = useState('completed');
  const [method, setMethod] = useState('all');
  const [proofFilter, setProofFilter] = useState('all');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [committedAmounts, setCommittedAmounts] = useState<{ min: number | null; max: number | null }>({ min: null, max: null });
  const [committedDates, setCommittedDates] = useState<{ from: string; to: string }>({ from: '', to: '' });

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [proofRow, setProofRow] = useState<ProofDialogRow | null>(null);
  const [drillAgentId, setDrillAgentId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let q = supabase
        .from('withdrawal_requests')
        .select(
          'id,user_id,amount,status,payout_method,transaction_id,reason,created_at,processed_at,receipt_token,assigned_cashout_agent_id,dispatch_claimed_by,payout_proof,payout_proof_type,payout_proof_path,payout_proof_bucket,payout_proof_uploaded_at,payout_proof_uploaded_by',
          { count: 'exact' },
        )
        .not('receipt_token', 'is', null)
        .order('processed_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (status !== 'all') q = q.eq('status', status);
      if (method !== 'all') q = q.eq('payout_method', method);
      if (proofFilter === 'with') q = q.not('payout_proof', 'is', null);
      if (proofFilter === 'without') q = q.is('payout_proof', null);
      if (committedAmounts.min !== null) q = q.gte('amount', committedAmounts.min);
      if (committedAmounts.max !== null) q = q.lte('amount', committedAmounts.max);
      if (committedDates.from) q = q.gte('created_at', committedDates.from);
      if (committedDates.to) q = q.lte('created_at', `${committedDates.to}T23:59:59`);

      const term = committedSearch.trim();
      if (term) {
        // Match receipt token, transaction id, or reason free-text
        q = q.or(
          `receipt_token.ilike.%${term}%,transaction_id.ilike.%${term}%,reason.ilike.%${term}%,id.eq.${/^[0-9a-f-]{36}$/i.test(term) ? term : '00000000-0000-0000-0000-000000000000'}`,
        );
      }

      q = q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const { data, error: qErr, count } = await q;
      if (qErr) throw qErr;

      const base = (data ?? []) as Row[];
      setTotal(count ?? 0);

      // Hydrate profile names/phones for user + agent.
      // dispatch_claimed_by is already profiles.id (set at claim time, never
      // cleared). assigned_cashout_agent_id is cashout_agents.id and must be
      // translated via cashout_agents.agent_id before it maps to a profile —
      // mixing the two id spaces in one .in() lookup is why the Merchant
      // Agent column always showed "—".
      const ids = new Set<string>();
      const cashoutAgentIds = new Set<string>();
      base.forEach((r) => {
        if (r.user_id) ids.add(r.user_id);
        if (r.payout_proof_uploaded_by) ids.add(r.payout_proof_uploaded_by);
        if (r.dispatch_claimed_by) ids.add(r.dispatch_claimed_by);
        else if (r.assigned_cashout_agent_id) cashoutAgentIds.add(r.assigned_cashout_agent_id);
      });

      const cashoutAgentToProfile: Record<string, string> = {};
      if (cashoutAgentIds.size > 0) {
        const { data: cashoutAgents } = await supabase
          .from('cashout_agents')
          .select('id, agent_id')
          .in('id', Array.from(cashoutAgentIds));
        (cashoutAgents ?? []).forEach((ca: any) => {
          cashoutAgentToProfile[ca.id] = ca.agent_id;
          if (ca.agent_id) ids.add(ca.agent_id);
        });
      }

      let profilesById: Record<string, { full_name: string | null; phone: string | null }> = {};
      if (ids.size > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', Array.from(ids));
        profilesById = Object.fromEntries(
          (profs ?? []).map((p: any) => [p.id, { full_name: p.full_name, phone: p.phone }]),
        );
      }

      // Funding source per receipt. One withdrawal can carry two advance legs
      // (`payout` for the principal, `telecom` for the sending charge), so they
      // are folded per withdrawal_id rather than assumed one-to-one.
      const oopByWithdrawal: Record<
        string,
        Pick<Row, 'float_covered' | 'own_cash' | 'own_cash_telecom' | 'own_cash_status' | 'own_cash_reimbursed'>
      > = {};
      if (base.length > 0) {
        const { data: oop } = await supabase
          .from('merchant_out_of_pocket_advances')
          .select('withdrawal_id, kind, float_used, shortfall_amount, status, reimbursed_at')
          .in('withdrawal_id', base.map((r) => r.id));
        ((oop ?? []) as OopRow[]).forEach((o) => {
          const wid = o.withdrawal_id;
          if (!wid) return;
          const entry = (oopByWithdrawal[wid] ??= {
            float_covered: 0,
            own_cash: 0,
            own_cash_telecom: 0,
            own_cash_status: null,
            own_cash_reimbursed: false,
          });
          const shortfall = Number(o.shortfall_amount ?? 0);
          if (o.kind === 'telecom') {
            entry.own_cash_telecom = (entry.own_cash_telecom ?? 0) + shortfall;
          } else {
            entry.own_cash = (entry.own_cash ?? 0) + shortfall;
            entry.float_covered = (entry.float_covered ?? 0) + Number(o.float_used ?? 0);
          }
          // The payout leg carries the status that matters; a telecom-only row
          // still sets it so a charge-only claim is not left unlabelled.
          if (o.kind !== 'telecom' || !entry.own_cash_status) {
            entry.own_cash_status = o.status ?? null;
          }
          if (o.reimbursed_at) entry.own_cash_reimbursed = true;
        });
      }

      // Client-side phone/name search — after primary DB query, so counts stay honest
      let hydrated = base.map((r) => {
        const agentId =
          r.dispatch_claimed_by ||
          (r.assigned_cashout_agent_id
            ? cashoutAgentToProfile[r.assigned_cashout_agent_id] ?? null
            : null);
        return {
          ...r,
          user_name: r.user_id ? profilesById[r.user_id]?.full_name ?? null : null,
          user_phone: r.user_id ? profilesById[r.user_id]?.phone ?? null : null,
          resolved_agent_profile_id: agentId,
          agent_name: agentId ? profilesById[agentId]?.full_name ?? null : null,
          agent_phone: agentId ? profilesById[agentId]?.phone ?? null : null,
          uploaded_by_name: r.payout_proof_uploaded_by
            ? profilesById[r.payout_proof_uploaded_by]?.full_name ?? null
            : null,
          ...(oopByWithdrawal[r.id] ?? {}),
        };
      });

      if (term) {
        const tLower = term.toLowerCase();
        const isPhoneish = /^\+?\d[\d\s-]{2,}$/.test(term);
        if (isPhoneish) {
          hydrated = hydrated.filter(
            (r) =>
              (r.user_phone ?? '').includes(term) ||
              (r.agent_phone ?? '').includes(term),
          );
        } else if (!/^[0-9a-f-]{36}$/i.test(term) && !/^[a-z0-9]{20,}$/i.test(term)) {
          // Free-text name search on top of DB filter
          hydrated = hydrated.filter(
            (r) =>
              (r.user_name ?? '').toLowerCase().includes(tLower) ||
              (r.agent_name ?? '').toLowerCase().includes(tLower) ||
              (r.transaction_id ?? '').toLowerCase().includes(tLower) ||
              (r.receipt_token ?? '').toLowerCase().includes(tLower) ||
              (r.reason ?? '').toLowerCase().includes(tLower),
          );
        }
      }

      setRows(hydrated);
    } catch (e: any) {
      setError(e?.message || 'Failed to load receipts');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [status, method, proofFilter, committedAmounts, committedDates, committedSearch, page]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const applyFilters = () => {
    setCommittedSearch(search);
    setCommittedAmounts({
      min: amountMin.trim() ? Number(amountMin.replace(/,/g, '')) : null,
      max: amountMax.trim() ? Number(amountMax.replace(/,/g, '')) : null,
    });
    setCommittedDates({ from: dateFrom, to: dateTo });
    setPage(0);
  };

  const clearFilters = () => {
    setSearch(''); setCommittedSearch('');
    setStatus('completed'); setMethod('all');
    setProofFilter('all');
    setAmountMin(''); setAmountMax('');
    setDateFrom(''); setDateTo('');
    setCommittedAmounts({ min: null, max: null });
    setCommittedDates({ from: '', to: '' });
    setPage(0);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Scoped to the visible page only — the archive pages server-side, so a
  // platform-wide figure would need its own aggregate and must not be implied
  // here. `unconfirmed` is the part still gated on the merchant attesting.
  const pageOwnCash = useMemo(() => {
    let sum = 0;
    let count = 0;
    let unconfirmed = 0;
    rows.forEach((r) => {
      const own = ownCashTotal(r);
      if (own <= 0) return;
      sum += own;
      count += 1;
      if (r.own_cash_status === 'needs_review') unconfirmed += own;
    });
    return { total: sum, count, unconfirmed };
  }, [rows]);

  const copyLink = async (token: string, id: string) => {
    const url = `${RECEIPT_BASE_URL}${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      toast({ title: 'Receipt link copied', description: url });
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600);
    } catch {
      toast({ title: 'Copy failed', description: url, variant: 'destructive' });
    }
  };

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (committedSearch) n++;
    if (status !== 'completed') n++;
    if (method !== 'all') n++;
    if (proofFilter !== 'all') n++;
    if (committedAmounts.min !== null || committedAmounts.max !== null) n++;
    if (committedDates.from || committedDates.to) n++;
    return n;
  }, [committedSearch, status, method, proofFilter, committedAmounts, committedDates]);

  return (
    <div className="space-y-4">
    <PayoutProofIntegrityPanel />
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <CardTitle className="text-lg font-bold flex items-center gap-2">
              <Archive className="h-5 w-5 text-primary" />
              Receipt Archive
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Permanent record of every payout receipt. Welile is the source of truth.
              Every row opens at{' '}
              <span className="font-mono">welileapp.com/r/&lt;token&gt;</span>.
            </p>
          </div>
          <Badge variant="outline" className="text-xs shrink-0">
            {total.toLocaleString()} receipt{total === 1 ? '' : 's'}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div className="relative sm:col-span-2 lg:col-span-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search receipt token, transaction ID, phone, name or reason…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
              className="pl-9 pr-9"
            />
            {search && (
              <button
                type="button"
                onClick={() => { setSearch(''); if (committedSearch) { setCommittedSearch(''); setPage(0); } }}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md hover:bg-muted flex items-center justify-center"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0); }}>
            <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={method} onValueChange={(v) => { setMethod(v); setPage(0); }}>
            <SelectTrigger><SelectValue placeholder="Payment method" /></SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => (
                <SelectItem key={m.v} value={m.v}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={proofFilter} onValueChange={(v) => { setProofFilter(v); setPage(0); }}>
            <SelectTrigger><SelectValue placeholder="Proof of payment" /></SelectTrigger>
            <SelectContent>
              {PROOF_FILTERS.map((p) => (
                <SelectItem key={p.v} value={p.v}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="grid grid-cols-2 gap-2">
            <Input
              inputMode="numeric"
              placeholder="Min UGX"
              value={amountMin}
              onChange={(e) => setAmountMin(e.target.value.replace(/[^\d,]/g, ''))}
            />
            <Input
              inputMode="numeric"
              placeholder="Max UGX"
              value={amountMax}
              onChange={(e) => setAmountMax(e.target.value.replace(/[^\d,]/g, ''))}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>

          <div className="flex gap-2">
            <Button onClick={applyFilters} className="flex-1">
              <Search className="h-4 w-4 mr-1.5" /> Apply
            </Button>
            {activeFilterCount > 0 && (
              <Button variant="outline" onClick={clearFilters}>
                <X className="h-4 w-4 mr-1.5" /> Clear
              </Button>
            )}
          </div>
        </div>

        {/* Results */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-sm text-muted-foreground">
            <ReceiptIcon className="h-10 w-10 mx-auto mb-3 opacity-40" />
            No receipts match your filters.
          </div>
        ) : (
          <>
          {pageOwnCash.total > 0 && (
            <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              <span className="font-semibold text-warning">
                {formatUGX(pageOwnCash.total)}
              </span>{' '}
              on this page was fronted by merchant agents from their own cash, across{' '}
              {pageOwnCash.count} {pageOwnCash.count === 1 ? 'receipt' : 'receipts'}
              {pageOwnCash.unconfirmed > 0 && (
                <> — {formatUGX(pageOwnCash.unconfirmed)} not yet supported by the books</>
              )}
              .
            </div>
          )}
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm min-w-[1000px]">
              <thead className="border-b bg-muted/40">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Receipt</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">User</th>
                  <th className="px-3 py-2 font-semibold">Merchant Agent</th>
                  <th className="px-3 py-2 font-semibold text-right">Amount</th>
                  <th className="px-3 py-2 font-semibold">Funded by</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Proof</th>
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const ts = r.processed_at || r.created_at;
                  const token = r.receipt_token || '';
                  const receiptUrl = `${RECEIPT_BASE_URL}${token}`;
                  const receiptId = token
                    ? `RCPT-${token.slice(0, 8).toUpperCase()}`
                    : r.id.slice(0, 8).toUpperCase();
                  const reasonType = (r.reason || '').toLowerCase();
                  const typeLabel = reasonType.includes('landlord')
                    ? 'Landlord Payout'
                    : reasonType.includes('portfolio') || reasonType.includes('roi') || reasonType.includes('return')
                    ? 'ROI / Returns'
                    : reasonType.includes('advance')
                    ? 'Credit Draw'
                    : 'Wallet Cash-Out';
                  const proofState = classifyProof(r);
                  return (
                    <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2 font-mono text-[11px]">
                        <div className="font-semibold">{receiptId}</div>
                        <div className="text-muted-foreground truncate max-w-[140px]" title={r.transaction_id ?? ''}>
                          {r.transaction_id || '—'}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{typeLabel}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium truncate max-w-[160px]">{r.user_name || '—'}</div>
                        <div className="text-[11px] text-muted-foreground">{r.user_phone || ''}</div>
                      </td>
                      <td className="px-3 py-2">
                        {r.resolved_agent_profile_id && r.agent_name ? (
                          <button
                            type="button"
                            onClick={() => setDrillAgentId(r.resolved_agent_profile_id!)}
                            className="font-medium truncate max-w-[160px] text-left text-primary hover:underline"
                            title="Open merchant agent profile"
                          >
                            {r.agent_name}
                          </button>
                        ) : (
                          <div className="font-medium truncate max-w-[160px]">{r.agent_name || '—'}</div>
                        )}
                        <div className="text-[11px] text-muted-foreground">{r.agent_phone || ''}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums whitespace-nowrap">
                        {formatUGX(Number(r.amount || 0))}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {ownCashTotal(r) > 0 ? (
                          <>
                            <div className="text-[11px] font-semibold text-warning">
                              Merchant&apos;s own cash
                            </div>
                            <div className="font-mono text-[11px] tabular-nums">
                              {formatUGX(ownCashTotal(r))}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {r.own_cash_reimbursed
                                ? 'refunded'
                                : r.own_cash_status === 'pending_reimbursement'
                                  ? 'recorded — we owe them this'
                                  : r.own_cash_status === 'needs_review'
                                    ? 'filed — books not yet corroborated'
                                    : r.own_cash_status === 'rejected'
                                      ? 'settled outside the system'
                                      : 'unclassified'}
                              {Number(r.float_covered ?? 0) > 0 &&
                                ` · float covered ${formatUGX(Number(r.float_covered))}`}
                            </div>
                          </>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">Company float</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={`text-[10px] font-semibold ${statusTone(r.status)}`}>
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        {proofState === 'attached' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[10px] gap-1"
                            onClick={() => setProofRow(r as ProofDialogRow)}
                            title="View proof of payment"
                          >
                            <ImageIcon className="h-3.5 w-3.5" /> View
                          </Button>
                        ) : proofState === 'legacy' ? (
                          <button
                            type="button"
                            onClick={() => setProofRow(r as ProofDialogRow)}
                            className="inline-flex items-center gap-1 text-[10px] text-amber-700"
                            title="Legacy text-only reference"
                          >
                            <FileWarning className="h-3.5 w-3.5" /> Legacy
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <ShieldAlert className="h-3.5 w-3.5" /> None
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="tabular-nums">{format(new Date(ts), 'MMM d, yyyy')}</div>
                        <div className="text-[10px] text-muted-foreground tabular-nums">
                          {format(new Date(ts), 'HH:mm')}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 justify-end">
                          {token && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                onClick={() => window.open(receiptUrl, '_blank', 'noopener,noreferrer')}
                                title="Open receipt page"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2"
                                onClick={() => copyLink(token, r.id)}
                                title="Copy public link"
                              >
                                {copiedId === r.id ? (
                                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </>
                          )}
                          {!token && (
                            <span className="text-[10px] text-muted-foreground italic px-1">
                              no token
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-2 border-t">
            <div className="text-xs text-muted-foreground">
              Page {page + 1} of {totalPages} · {total.toLocaleString()} total
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0 || loading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages - 1 || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-[11px] text-muted-foreground flex items-start gap-2">
          <FileText className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
          <span>
            Every receipt link is the canonical record. It appears in the user SMS,
            merchant-agent SMS, primary customer email and this dashboard —
            one URL, no external Gmail archive.
          </span>
        </div>
      </CardContent>
    </Card>
    <PayoutProofDialog
      row={proofRow}
      open={!!proofRow}
      onOpenChange={(v) => { if (!v) setProofRow(null); }}
    />
    <UserDrilldownDrawer
      open={!!drillAgentId}
      onOpenChange={(v) => { if (!v) setDrillAgentId(null); }}
      agentId={drillAgentId}
      defaultTab="agent"
    />
    </div>
  );
}

export default ReceiptArchivePanel;