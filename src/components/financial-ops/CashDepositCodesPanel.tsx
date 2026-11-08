/**
 * Cash Deposit Codes.
 *
 * Cash handed in is credited to a wallet only when Financial Ops enters the 4-digit code the depositor received and
 * re-confirms the amount. Everything on this screen is real data: the totals, the counts, the chart and the table come from
 * the database over the chosen time range (fin_ops_cash_codes_page / fin_ops_cash_codes_summary). There are no sample rows,
 * and a screen never says money moved unless the server confirmed it.
 *
 * Until migration 20261106140000 is applied, the screen falls back to the older list function (latest 200 deposits) and says
 * so on screen, instead of showing made-up figures.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, Banknote, BarChart3, Building2, Check, CheckCircle2, Clock, Info, Loader2, Mail, Radio, RefreshCw, Search,
  Smartphone, Ticket,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';
import { StartCashDepositDialog } from './StartCashDepositDialog';
import { Pager } from './FinopsKit';

export interface CashCodeRow {
  verification_id: string;
  deposit_request_id: string;
  depositor_name: string | null;
  wallet_holder_name?: string | null;
  cash_owner_name?: string | null;
  /** The phone of the wallet that is credited. It is NOT the phone of the person handing over cash. */
  wallet_holder_phone: string | null;
  amount: number | null;
  status: string;
  attempts: number | null;
  max_attempts: number | null;
  deposit_purpose: string | null;
  cash_location: 'cash_at_hand' | 'bank' | string | null;
  expires_at: string | null;
  created_at: string;
}

type Range = 'today' | '7d' | '30d' | 'all';
type Loc = 'all' | 'cash_at_hand' | 'bank';
type Tab = 'all' | 'awaiting' | 'verified' | 'cashflow';
type Summary = {
  deposits_total: number; verified_count: number; verified_total: number; awaiting_count: number;
  awaiting_live_count: number; awaiting_live_total: number; expired_count: number;
  by_day: { day: string; verified: number; awaiting: number }[];
};
type Loaded = { rows: CashCodeRow[]; total: number; summary: Summary; legacy: boolean; capped: boolean };

const PAGE_SIZE = 25;
const TZ = 'Africa/Kampala';
const DAY_MS = 86_400_000;

const RANGE_LABEL: Record<Range, string> = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };

const ugx = (n: number | null | undefined) => (n == null ? '—' : `UGX ${Math.round(n).toLocaleString('en-UG')}`);
const num = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-UG'));
const purposeLabel = (p: string | null) => (p === 'operational_float' ? 'Operational Float' : p === 'other' ? 'Other' : 'Personal Deposit');
const isBank = (loc: string | null) => loc === 'bank';

/** Start of the range in Uganda time. */
function rangeFrom(range: Range, now = Date.now()): Date | null {
  if (range === 'all') return null;
  if (range === '7d') return new Date(now - 7 * DAY_MS);
  if (range === '30d') return new Date(now - 30 * DAY_MS);
  const eat = new Date(now + 3 * 3_600_000);
  eat.setUTCHours(0, 0, 0, 0);
  return new Date(eat.getTime() - 3 * 3_600_000);
}

const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const timeOf = (iso: string, seconds = true) =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false });

const isLive = (r: CashCodeRow, now = Date.now()) => r.status === 'awaiting_code' && (!r.expires_at || new Date(r.expires_at).getTime() > now);
const isExpired = (r: CashCodeRow, now = Date.now()) =>
  r.status === 'expired' || (r.status === 'awaiting_code' && !!r.expires_at && new Date(r.expires_at).getTime() <= now);

/** The server's own words when a function call fails (an error status hides the message inside the response). */
async function functionError(error: unknown, fallback: string): Promise<string> {
  try {
    const ctx = (error as { context?: Response })?.context;
    if (ctx && typeof ctx.json === 'function') {
      const j = (await ctx.json()) as { message?: string; error?: string };
      return j?.message || j?.error || fallback;
    }
  } catch {
    /* fall through */
  }
  return (error as { message?: string })?.message || fallback;
}

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<RpcResult>)(fn, args);
const functionMissing = (e: { message: string; code?: string } | null) =>
  !!e && (e.code === 'PGRST202' || /could not find the function|does not exist|schema cache/i.test(e.message));

/** Totals and the per-day series computed from rows, used only when the server functions are not installed yet. */
function summarize(rows: CashCodeRow[]): Summary {
  const now = Date.now();
  const byDay = new Map<string, { verified: number; awaiting: number }>();
  for (const r of rows) {
    const day = new Date(r.created_at).toLocaleDateString('en-CA', { timeZone: TZ });
    const d = byDay.get(day) ?? { verified: 0, awaiting: 0 };
    if (r.status === 'verified') d.verified += r.amount ?? 0;
    if (isLive(r, now)) d.awaiting += r.amount ?? 0;
    byDay.set(day, d);
  }
  return {
    deposits_total: rows.length,
    verified_count: rows.filter((r) => r.status === 'verified').length,
    verified_total: rows.filter((r) => r.status === 'verified').reduce((s, r) => s + (r.amount ?? 0), 0),
    awaiting_count: rows.filter((r) => r.status === 'awaiting_code').length,
    awaiting_live_count: rows.filter((r) => isLive(r, now)).length,
    awaiting_live_total: rows.filter((r) => isLive(r, now)).reduce((s, r) => s + (r.amount ?? 0), 0),
    expired_count: rows.filter((r) => isExpired(r, now)).length,
    by_day: Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })),
  };
}

async function fetchCodes(p: { range: Range; tab: Tab; loc: Loc; search: string; page: number }): Promise<Loaded> {
  const chartRange: Range = p.tab === 'cashflow' && p.range === 'today' ? '7d' : p.range;
  const from = rangeFrom(p.tab === 'cashflow' ? chartRange : p.range);

  const sumRes = await rpc('fin_ops_cash_codes_summary', { p_from: from?.toISOString() ?? null, p_to: null });
  const pageRes =
    p.tab === 'cashflow'
      ? null
      : await rpc('fin_ops_cash_codes_page', {
          p_from: from?.toISOString() ?? null,
          p_to: null,
          p_status: p.tab === 'awaiting' ? 'awaiting' : p.tab === 'verified' ? 'verified' : null,
          p_location: p.loc === 'all' ? null : p.loc,
          p_search: p.search || null,
          p_limit: PAGE_SIZE,
          p_offset: p.page * PAGE_SIZE,
        });

  if (functionMissing(sumRes.error) || functionMissing(pageRes?.error ?? null)) {
    // Older database: the latest 200 deposits, filtered here. Said so on screen.
    const legacy = await rpc('fin_ops_recent_cash_codes', { p_limit: 200 });
    if (legacy.error) throw new Error(legacy.error.message);
    const all = ((legacy.data ?? []) as (Omit<CashCodeRow, 'wallet_holder_phone'> & { depositor_phone?: string | null })[]).map((r) => ({
      ...r,
      wallet_holder_phone: r.depositor_phone ?? null,
    })) as CashCodeRow[];
    const inRange = all.filter((r) => !from || new Date(r.created_at) >= from);
    const q = p.search.trim().toLowerCase();
    const filtered = inRange.filter((r) => {
      if (p.tab === 'awaiting' && r.status !== 'awaiting_code') return false;
      if (p.tab === 'verified' && r.status !== 'verified') return false;
      if (p.loc !== 'all' && (r.cash_location ?? 'cash_at_hand') !== p.loc) return false;
      if (q && !`${r.depositor_name ?? ''} ${r.wallet_holder_phone ?? ''} ${r.amount ?? ''} ${purposeLabel(r.deposit_purpose)}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return {
      rows: filtered.slice(p.page * PAGE_SIZE, (p.page + 1) * PAGE_SIZE),
      total: filtered.length,
      summary: summarize(inRange),
      legacy: true,
      capped: all.length >= 200,
    };
  }

  if (sumRes.error) throw new Error(sumRes.error.message);
  if (pageRes?.error) throw new Error(pageRes.error.message);
  const pageRows = ((pageRes?.data ?? []) as (CashCodeRow & { total_count?: number })[]);
  return {
    rows: pageRows,
    total: Number(pageRows[0]?.total_count ?? 0),
    summary: sumRes.data as Summary,
    legacy: false,
    capped: false,
  };
}

function Countdown({ expiresAt }: { expiresAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!expiresAt) return null;
  const s = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  if (s <= 0) return <span className="text-sm font-bold text-[#D92D20]">Expired</span>;
  return <span className="text-sm text-foreground/80 tabular-nums">Expires in {String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

/** Four single-digit boxes for the 4-digit receipt code. */
function CodeBoxes({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(4, ' ').slice(0, 4).split('');
  const set = (i: number, d: string) => {
    const next = digits.slice();
    next[i] = d || ' ';
    onChange(next.join('').replace(/ /g, ''));
  };
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          value={d === ' ' ? '' : d}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          aria-label={`${label}, digit ${i + 1}`}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(-1);
            set(i, v);
            if (v && i < 3) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i].trim() && i > 0) refs.current[i - 1]?.focus();
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);
            if (t) { e.preventDefault(); onChange(t); refs.current[Math.min(t.length, 3)]?.focus(); }
          }}
          className="h-10 w-9 rounded-lg border border-slate-300 bg-background text-center text-base font-bold tabular-nums outline-none focus:border-[#6D2EE8] focus:ring-2 focus:ring-[#B79BF2] sm:w-10"
        />
      ))}
    </div>
  );
}

function StatusChip({ r }: { r: CashCodeRow }) {
  if (r.status === 'verified') return <span className="inline-flex rounded-lg bg-[#C9EFD5] px-3 py-1 text-sm font-bold text-[#0B6630] dark:bg-emerald-500/30 dark:text-emerald-100">Verified</span>;
  if (r.status === 'awaiting_code')
    return (
      <div>
        <span className="inline-flex rounded-lg bg-[#FFE49A] px-3 py-1 text-sm font-bold text-[#6B4200] dark:bg-amber-400/30 dark:text-amber-100">Awaiting code</span>
        <div className="mt-1"><Countdown expiresAt={r.expires_at} /></div>
      </div>
    );
  return <span className="inline-flex rounded-lg bg-slate-200 px-3 py-1 text-sm font-bold capitalize text-slate-700 dark:bg-slate-700 dark:text-slate-100">{r.status.replace(/_/g, ' ')}</span>;
}

function LocationChip({ loc }: { loc: string | null }) {
  const bank = isBank(loc);
  const Icon = bank ? Building2 : Banknote;
  return (
    <span className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-background px-3 py-1.5 text-sm font-semibold text-foreground">
      <Icon className="h-4 w-4 text-slate-600" strokeWidth={1.75} aria-hidden="true" /> {bank ? 'Banked' : 'Cash at hand'}
    </span>
  );
}

export function CashDepositCodesPanel({ onClose }: { fullScreen?: boolean; onClose?: () => void } = {}) {
  const { toast } = useToast();
  const autoRefresh = useFinOpsAutoRefresh();
  const [tab, setTab] = useState<Tab>('all');
  const [loc, setLoc] = useState<Loc>('all');
  const [range, setRange] = useState<Range>('today');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [confirmRow, setConfirmRow] = useState<CashCodeRow | null>(null);
  const [openRow, setOpenRow] = useState<CashCodeRow | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const query = useQuery({
    queryKey: ['cash-deposit-codes', range, tab, loc, search, page],
    queryFn: () => fetchCodes({ range, tab, loc, search, page }),
    refetchInterval: autoRefresh ? 15_000 : false,
    retry: false,
    placeholderData: (prev) => prev,
  });
  const refetch = query.refetch;
  const data = query.data;
  const summary = data?.summary;
  const denied = query.isError && /not_authorized/i.test((query.error as Error)?.message ?? '');

  const setTabAndReset = (t: Tab) => { setTab(t); setPage(0); };

  // ---- Actions. Each one reports what the server said, never what we hoped for. ----
  const credit = useCallback(async (row: CashCodeRow) => {
    const code = (codes[row.verification_id] ?? '').replace(/\D/g, '');
    setBusy(row.verification_id);
    try {
      const { data: res, error } = await supabase.functions.invoke('cash-deposit-verify-code', {
        body: { deposit_request_id: row.deposit_request_id, code, on_behalf: true },
      });
      if (error) throw new Error(await functionError(error, 'The deposit was not credited.'));
      const failure = (res as { error?: string; message?: string } | null)?.error;
      if (failure) throw new Error((res as { message?: string }).message || failure);
      toast({ title: 'Deposit credited', description: `${ugx(row.amount)} credited to ${row.wallet_holder_name || row.depositor_name || 'the wallet'}.` });
      setCodes((c) => ({ ...c, [row.verification_id]: '' }));
    } catch (e) {
      toast({ title: 'Not credited', description: e instanceof Error ? e.message : 'The deposit was not credited.', variant: 'destructive' });
    } finally {
      setBusy(null);
      void refetch();
    }
  }, [codes, refetch, toast]);

  const askToCredit = (row: CashCodeRow) => {
    if ((codes[row.verification_id] ?? '').length < 4) {
      toast({ title: 'Enter the 4-digit code', description: 'Type the code the depositor received.', variant: 'destructive' });
      return;
    }
    setConfirmRow(row);
  };

  const moveCash = async (row: CashCodeRow) => {
    const next = isBank(row.cash_location) ? 'cash_at_hand' : 'bank';
    setBusy(row.verification_id);
    const { error } = await rpc('fin_ops_set_cash_location', { p_deposit_request_id: row.deposit_request_id, p_location: next });
    setBusy(null);
    if (error) {
      toast({ title: 'Location not changed', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: next === 'bank' ? 'Marked as banked' : 'Marked as cash at hand', description: `${ugx(row.amount)} location updated.` });
    void refetch();
  };

  const resend = async (row: CashCodeRow, channel: 'sms' | 'email') => {
    setBusy(row.verification_id);
    try {
      const { data: res, error } = await supabase.functions.invoke('finops-cash-deposit-resend', {
        body: { verification_id: row.verification_id, send_email: channel === 'email' },
      });
      if (error) throw new Error(await functionError(error, 'A new code could not be sent.'));
      const failure = (res as { error?: string; message?: string } | null)?.error;
      if (failure) throw new Error((res as { message?: string }).message || failure);
      toast({ title: 'New code sent', description: `Delivered by ${channel.toUpperCase()}.` });
      void refetch();
    } catch (e) {
      toast({ title: 'Code not sent', description: e instanceof Error ? e.message : 'A new code could not be sent.', variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const chart = useMemo(
    () => (summary?.by_day ?? []).map((d) => ({ label: new Date(`${d.day}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), verified: d.verified, awaiting: d.awaiting })),
    [summary],
  );

  if (denied) return null;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'all', label: 'All', count: summary?.deposits_total },
    { key: 'awaiting', label: 'Awaiting', count: summary?.awaiting_count },
    { key: 'verified', label: 'Verified', count: summary?.verified_count },
    { key: 'cashflow', label: 'Cashflow' },
  ];
  const chipOn = 'bg-primary text-primary-foreground shadow-sm';
  const chipOff = 'border border-slate-300 bg-card text-foreground hover:border-[#B79BF2]';
  const rows = data?.rows ?? [];
  const sinceUpdate = query.dataUpdatedAt ? Math.max(0, Math.round((now - query.dataUpdatedAt) / 1000)) : null;

  const codeCell = (r: CashCodeRow) =>
    isLive(r, now) ? (
      <div className="flex flex-wrap items-center gap-2">
        <CodeBoxes value={codes[r.verification_id] ?? ''} onChange={(v) => setCodes((c) => ({ ...c, [r.verification_id]: v }))} label={`Code for ${r.depositor_name ?? 'deposit'}`} />
        <Button size="sm" className="min-h-[40px] rounded-lg px-3 font-bold" disabled={(codes[r.verification_id] ?? '').length < 4 || busy === r.verification_id} onClick={() => askToCredit(r)}>
          {busy === r.verification_id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null} Credit wallet
        </Button>
      </div>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  const phoneCell = (r: CashCodeRow) => (
    <div className="font-mono text-sm text-foreground">
      {r.wallet_holder_phone || '—'}
      {r.cash_owner_name && r.wallet_holder_name && r.cash_owner_name !== r.wallet_holder_name && (
        <div className="font-sans text-xs text-muted-foreground">Wallet: {r.wallet_holder_name}</div>
      )}
    </div>
  );

  const depositor = (r: CashCodeRow) => (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#E6DAFF] text-sm font-extrabold text-[#5A1FD0] dark:bg-violet-500/30 dark:text-violet-100">
        {(r.depositor_name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('')}
      </span>
      <div className="min-w-0">
        <p className="truncate text-base font-bold text-foreground">{r.depositor_name || 'Unknown'}</p>
        <p className="text-sm text-muted-foreground">{purposeLabel(r.deposit_purpose)}</p>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-none space-y-4">
      <StartCashDepositDialog open={startOpen} onOpenChange={setStartOpen} onIssued={() => void refetch()} />

      {onClose && (
        <button type="button" onClick={onClose} className="inline-flex min-h-[44px] items-center gap-2 text-sm font-semibold text-[#5A1FD0] hover:underline dark:text-violet-300 sm:min-h-0">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to Overview
        </button>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[#D2BFFA] bg-[#EFE8FF] text-[#6D2EE8] dark:bg-violet-500/20">
            <Banknote className="h-7 w-7" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-3xl font-black tracking-tight text-foreground">Cash Deposit Codes</h1>
            <p className="text-sm text-muted-foreground">Manage cash deposit ranges, verify codes and track cash inflows.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => void refetch()} disabled={query.isFetching} className="h-11 w-11 rounded-xl p-0" aria-label="Refresh">
            {query.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          <Button onClick={() => setStartOpen(true)} className="h-11 gap-2 rounded-xl px-5 text-sm font-bold">
            <Ticket className="h-4 w-4" aria-hidden="true" /> Start deposit
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border">
        <div role="tablist" aria-label="Deposit views" className="flex items-center gap-6 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTabAndReset(t.key)}
              className={`-mb-px flex min-h-[44px] items-center gap-2 border-b-[3px] pb-1 text-base font-bold transition-colors ${tab === t.key ? 'border-[#6D2EE8] text-[#5A1FD0] dark:text-violet-300' : 'border-transparent text-foreground/80 hover:text-foreground'}`}
            >
              {t.label}
              {t.count != null && <span className={`rounded-full px-2.5 py-0.5 text-xs font-extrabold tabular-nums ${tab === t.key ? 'bg-[#E6DAFF] text-[#5A1FD0]' : 'bg-muted text-muted-foreground'}`}>{t.count}</span>}
            </button>
          ))}
        </div>
        <p className="hidden items-center gap-3 pb-2 text-xs text-muted-foreground md:flex" aria-live="polite">
          <span className="flex items-center gap-1.5 font-semibold text-foreground"><Radio className={`h-3.5 w-3.5 ${autoRefresh ? 'animate-pulse text-emerald-600' : 'text-slate-400'}`} aria-hidden="true" /> {autoRefresh ? 'Live' : 'Paused'}{sinceUpdate != null ? ` · ${sinceUpdate}s` : ''}</span>
          {query.dataUpdatedAt ? <span>Updated {timeOf(new Date(query.dataUpdatedAt).toISOString())} EAT</span> : null}
          {autoRefresh && <span className="border-l border-border pl-3">Refreshes every 15 seconds</span>}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-2">
          {([['all', 'All cash'], ['cash_at_hand', 'Cash at hand'], ['bank', 'Cash banked']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => { setLoc(k); setPage(0); }} aria-pressed={loc === k} className={`min-h-[40px] rounded-full px-4 text-sm font-semibold transition ${loc === k ? chipOn : chipOff}`}>{l}</button>
          ))}
          <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
          {([['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => { setRange(k); setPage(0); }} aria-pressed={range === k} className={`min-h-[40px] rounded-full px-4 text-sm font-semibold transition ${range === k ? chipOn : chipOff}`}>{l}</button>
          ))}
        </div>
        <div className="relative w-full shrink-0 lg:w-80">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search depositor, phone or amount" aria-label="Search deposits" className="h-11 rounded-full border-slate-300 bg-card pl-10 text-sm" />
        </div>
      </div>

      {data?.legacy && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-[#F0B53F] bg-[#FFF1CF] px-4 py-2.5 text-sm text-foreground dark:bg-amber-400/15">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B26A00]" aria-hidden="true" />
          <span>Showing the latest 200 deposits only{data.capped ? '' : ' (all there are)'}. Totals, counts and the chart cover these deposits, not the whole range. The full-range totals switch on when the database update (20261106140000) is applied.</span>
        </p>
      )}

      {/* Totals for the range */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-[#D2BFFA] bg-[#EFE8FF] text-[#6D2EE8]"><CheckCircle2 className="h-7 w-7" strokeWidth={1.75} aria-hidden="true" /></span>
          <div>
            <p className="text-sm font-semibold text-foreground">Verified cash</p>
            <p className="text-3xl font-black tabular-nums tracking-tight text-foreground">{summary ? ugx(summary.verified_total) : '—'}</p>
            <p className="text-sm text-muted-foreground">{RANGE_LABEL[tab === 'cashflow' && range === 'today' ? '7d' : range]} · {summary?.verified_count ?? 0} verified deposit{summary?.verified_count === 1 ? '' : 's'}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-[#D2BFFA] bg-[#EFE8FF] text-[#6D2EE8]"><Clock className="h-7 w-7" strokeWidth={1.75} aria-hidden="true" /></span>
          <div>
            <p className="text-sm font-semibold text-foreground">Awaiting code</p>
            <p className="text-3xl font-black tabular-nums tracking-tight text-foreground">{summary ? ugx(summary.awaiting_live_total) : '—'}</p>
            <p className="text-sm text-muted-foreground">{summary?.awaiting_live_count ?? 0} active · expired excluded</p>
          </div>
        </div>
      </div>

      {query.isError && !denied && (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <p className="font-semibold">The deposits could not be loaded</p>
          <p>{(query.error as Error)?.message}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void refetch()}>Try again</Button>
        </div>
      )}

      {tab === 'cashflow' ? (
        <section className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-sm" aria-label="Cashflow over time">
          <div className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-[#6D2EE8]" aria-hidden="true" /><h2 className="text-lg font-bold text-foreground">Cashflow over time</h2><span className="ml-2 rounded-full bg-muted px-3 py-0.5 text-xs font-bold text-muted-foreground">{RANGE_LABEL[range === 'today' ? '7d' : range]}</span></div>
          {query.isLoading ? (
            <Skeleton className="h-72 w-full rounded-xl" />
          ) : chart.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No cash deposits in this period.</p>
          ) : (
            <div className="h-[300px] w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} width={56} tickFormatter={(v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`)} />
                  <Tooltip formatter={(v: number) => ugx(Number(v))} contentStyle={{ fontSize: 13, borderRadius: 12 }} />
                  <Bar dataKey="verified" name="Verified" fill="#5A1FD0" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="awaiting" name="Awaiting (live)" fill="#F0B53F" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm" aria-label="Deposits">
          {/* Wide screens: table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[60rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3.5">Date &amp; time</th>
                  <th className="px-4 py-3.5">Depositor</th>
                  <th className="px-4 py-3.5" title="The phone of the wallet that is credited">Wallet phone</th>
                  <th className="px-4 py-3.5 text-right">Amount (UGX)</th>
                  <th className="px-4 py-3.5">Code</th>
                  <th className="px-4 py-3.5">Status</th>
                  <th className="px-4 py-3.5">Location</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {query.isLoading && Array.from({ length: 5 }).map((_, i) => (<tr key={i}><td colSpan={8} className="px-5 py-4"><Skeleton className="h-10 w-full" /></td></tr>))}
                {rows.map((r) => (
                  <tr key={r.verification_id} className="align-middle hover:bg-muted/30">
                    <td className="whitespace-nowrap px-5 py-3.5"><p className="text-base font-bold text-foreground">{dateOf(r.created_at)}</p><p className="font-mono text-sm text-muted-foreground">{timeOf(r.created_at)}</p></td>
                    <td className="px-4 py-3.5">{depositor(r)}</td>
                    <td className="px-4 py-3.5">{phoneCell(r)}</td>
                    <td className="whitespace-nowrap px-4 py-3.5 text-right text-lg font-extrabold tabular-nums text-foreground">{num(r.amount)}</td>
                    <td className="px-4 py-3.5">{codeCell(r)}</td>
                    <td className="whitespace-nowrap px-4 py-3.5"><StatusChip r={r} /></td>
                    <td className="whitespace-nowrap px-4 py-3.5"><LocationChip loc={r.cash_location} /></td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-right"><Button variant="outline" className="min-h-[40px] rounded-xl px-5 font-bold" onClick={() => setOpenRow(r)}>View</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones: one card per deposit */}
          <ul className="divide-y divide-border md:hidden">
            {rows.map((r) => (
              <li key={r.verification_id} className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  {depositor(r)}
                  <p className="shrink-0 text-lg font-extrabold tabular-nums text-foreground">{num(r.amount)}</p>
                </div>
                <p className="text-sm text-muted-foreground">{dateOf(r.created_at)} · {timeOf(r.created_at, false)} EAT · <span className="font-mono">{r.wallet_holder_phone || '—'}</span></p>
                <div className="flex flex-wrap items-center gap-2"><StatusChip r={r} /><LocationChip loc={r.cash_location} /></div>
                {isLive(r, now) && codeCell(r)}
                <Button variant="outline" className="min-h-[44px] w-full rounded-xl font-bold" onClick={() => setOpenRow(r)}>View</Button>
              </li>
            ))}
          </ul>

          {!query.isLoading && rows.length === 0 && !query.isError && (
            <div className="px-5 py-14 text-center">
              <Banknote className="mx-auto mb-2 h-8 w-8 text-[#6D2EE8]" strokeWidth={1.75} aria-hidden="true" />
              <p className="text-sm font-semibold text-foreground">No cash deposits match these filters</p>
              <p className="text-sm text-muted-foreground">{RANGE_LABEL[range]}{loc !== 'all' ? `, ${loc === 'bank' ? 'banked' : 'cash at hand'}` : ''}{search ? `, “${search}”` : ''}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-5 py-3 text-sm text-foreground">
            <p>{(data?.total ?? 0).toLocaleString()} deposit{data?.total === 1 ? '' : 's'} · {RANGE_LABEL[range]}</p>
            <p>Awaiting: {summary?.awaiting_live_count ?? 0} active · {summary?.expired_count ?? 0} expired</p>
          </div>
          {(data?.total ?? 0) > PAGE_SIZE && (
            <div className="border-t border-border px-4 py-2"><Pager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} noun="deposits" /></div>
          )}
        </section>
      )}

      <p className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-[#EFE8FF] px-5 py-3.5 text-sm font-semibold text-foreground dark:bg-violet-500/15">
        <span className="flex items-center gap-3"><Info className="h-5 w-5 shrink-0 text-[#6D2EE8]" strokeWidth={1.75} aria-hidden="true" /> Count the physical cash before crediting. You will confirm the amount before the wallet is credited.</span>
        <span className="font-normal italic text-foreground/80 sm:border-l sm:border-[#B79BF2] sm:pl-6">Expired deposits are excluded from the active awaiting total.</span>
      </p>

      {/* Double-check before crediting */}
      <Dialog open={confirmRow !== null} onOpenChange={(o) => { if (!o && busy === null) setConfirmRow(null); }}>
        <DialogContent className="rounded-2xl p-6 sm:max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2 text-lg font-bold"><CheckCircle2 className="h-5 w-5 text-[#6D2EE8]" aria-hidden="true" /> Double-check before crediting</DialogTitle></DialogHeader>
          {confirmRow && (
            <div className="space-y-4 pt-1">
              <div className="rounded-xl border-2 border-[#6D2EE8] bg-[#F1EAFF] p-5 text-center dark:bg-violet-500/20">
                <p className="text-xs font-bold uppercase tracking-wider text-foreground">Cash received. Count it again</p>
                <p className="mt-1 text-4xl font-black tabular-nums text-[#5A1FD0] dark:text-violet-200">{ugx(confirmRow.amount)}</p>
              </div>
              <dl className="space-y-2 rounded-xl border border-border bg-muted/20 p-4 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Depositor</dt><dd className="font-bold text-foreground">{confirmRow.depositor_name || 'Unknown'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Credited to wallet</dt><dd className="font-semibold text-foreground">{confirmRow.wallet_holder_name || '—'} <span className="font-mono text-xs">{confirmRow.wallet_holder_phone}</span></dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Code entered</dt><dd className="font-mono font-bold tracking-widest text-foreground">{codes[confirmRow.verification_id] ?? ''}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Purpose</dt><dd className="font-semibold text-foreground">{purposeLabel(confirmRow.deposit_purpose)}</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground">Confirm the cash in your hand matches the amount above. This credits the wallet and cannot be undone here.</p>
              <div className="flex gap-2">
                <Button variant="outline" className="h-11 flex-1 rounded-xl" disabled={busy !== null} onClick={() => setConfirmRow(null)}>Go back</Button>
                <Button className="h-11 flex-1 gap-1.5 rounded-xl font-bold" disabled={busy !== null} onClick={async () => { const r = confirmRow; await credit(r); setConfirmRow(null); }}>
                  {busy === confirmRow.verification_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Yes, amount is correct
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Deposit details */}
      <Dialog open={openRow !== null} onOpenChange={(o) => !o && setOpenRow(null)}>
        <DialogContent className="rounded-2xl p-6 sm:max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2 text-lg font-bold"><Banknote className="h-5 w-5 text-[#6D2EE8]" aria-hidden="true" /> Cash Deposit Details</DialogTitle></DialogHeader>
          {openRow && (
            <div className="space-y-4 pt-1">
              <dl className="space-y-2 rounded-xl border border-border bg-muted/20 p-4 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Depositor</dt><dd className="font-bold text-foreground">{openRow.depositor_name || 'Unknown'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Credited to wallet</dt><dd className="text-right font-semibold text-foreground">{openRow.wallet_holder_name || '—'}<br /><span className="font-mono text-xs">{openRow.wallet_holder_phone || '—'}</span></dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Amount</dt><dd className="font-bold tabular-nums text-foreground">{ugx(openRow.amount)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Purpose</dt><dd className="font-semibold text-foreground">{purposeLabel(openRow.deposit_purpose)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Location</dt><dd className="font-semibold text-foreground">{isBank(openRow.cash_location) ? 'Banked' : 'Cash at hand'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Started</dt><dd className="font-semibold text-foreground">{dateOf(openRow.created_at)} · {timeOf(openRow.created_at)} EAT</dd></div>
              </dl>
              {isLive(openRow, now) && (
                <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between"><span className="text-sm font-bold text-foreground">Enter the 4-digit code</span><Countdown expiresAt={openRow.expires_at} /></div>
                  <div className="flex flex-wrap items-center gap-3">
                    <CodeBoxes value={codes[openRow.verification_id] ?? ''} onChange={(v) => setCodes((c) => ({ ...c, [openRow.verification_id]: v }))} label="Deposit code" />
                    <Button className="min-h-[44px] rounded-xl px-5 font-bold" disabled={(codes[openRow.verification_id] ?? '').length < 4} onClick={() => { const r = openRow; setOpenRow(null); askToCredit(r); }}>Credit</Button>
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2">
                {openRow.status === 'awaiting_code' && (
                  <div className="flex gap-2">
                    <Button variant="outline" className="min-h-[44px] flex-1 gap-1.5 rounded-xl font-semibold" disabled={busy === openRow.verification_id} onClick={() => void resend(openRow, 'sms')}><Smartphone className="h-4 w-4" aria-hidden="true" /> Resend SMS</Button>
                    <Button variant="outline" className="min-h-[44px] flex-1 gap-1.5 rounded-xl font-semibold" disabled={busy === openRow.verification_id} onClick={() => void resend(openRow, 'email')}><Mail className="h-4 w-4" aria-hidden="true" /> Resend Email</Button>
                  </div>
                )}
                <Button variant="outline" className="min-h-[44px] gap-1.5 rounded-xl font-semibold" disabled={busy === openRow.verification_id} onClick={async () => { const r = openRow; await moveCash(r); setOpenRow(null); }}>
                  <Building2 className="h-4 w-4" aria-hidden="true" /> {isBank(openRow.cash_location) ? 'Move to cash at hand' : 'Mark as banked'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
