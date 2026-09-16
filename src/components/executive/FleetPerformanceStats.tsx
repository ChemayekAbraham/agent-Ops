import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { ACTIVE_RENT_STATUSES } from '@/hooks/useAgentCapacityMap';
import {
  Target, Banknote, Percent, Loader2, ArrowUpDown, ArrowUp, ArrowDown,
  Search, Share2, ChevronDown, ChevronLeft, ChevronRight, X, Download, Receipt,
  Info, AlertTriangle, Eye, SlidersHorizontal, ShieldCheck, CheckCircle2,
  RotateCcw, Check,
} from 'lucide-react';
import { CalendarRange } from 'lucide-react';
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useQualifyingAgentIds } from '@/hooks/useQualifyingAgentIds';
import { useQueryClient } from '@tanstack/react-query';
import { LastUpdatedChip } from './LastUpdatedChip';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { FleetCollectionsDrillDownSheet } from './FleetCollectionsDrillDownSheet';
import { ExpectedContributorsSheet } from './ExpectedContributorsSheet';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';

type PeriodKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'this_month' | 'last_month' | 'all' | 'custom';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last week' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'all', label: 'All time' },
];

/** Earliest date used as the lower bound for the "All time" range. */
const ALL_TIME_START = new Date(2023, 0, 1);

const STORAGE_KEY = 'fleet-perf-range';

/** Safely read a string from localStorage. */
function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

/** Safely write a string to localStorage. */
function writeStorage(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

/** Parse a persisted sort value like "when:desc" into key + direction. */
function parsePersistedSort<T extends string>(raw: string | null, validKeys: readonly T[], defaultKey: T, defaultDir: 'asc' | 'desc') {
  if (!raw) return { key: defaultKey, dir: defaultDir };
  const [k, d] = raw.split(':');
  const key = validKeys.includes(k as T) ? (k as T) : defaultKey;
  const dir = d === 'asc' || d === 'desc' ? d : defaultDir;
  return { key, dir };
}

type SortCriterion<T extends string> = { key: T; dir: 'asc' | 'desc' };

/** Parse a persisted multi-sort value like "when:desc,amount:desc" into an ordered array. */
function parsePersistedMultiSort<T extends string>(raw: string | null, validKeys: readonly T[], defaultKey: T, defaultDir: 'asc' | 'desc'): SortCriterion<T>[] {
  if (!raw) return [{ key: defaultKey, dir: defaultDir }];
  const parsed = raw
    .split(',')
    .map((part) => {
      const [k, d] = part.trim().split(':');
      const key = validKeys.includes(k as T) ? (k as T) : null;
      const dir = d === 'asc' || d === 'desc' ? d : defaultDir;
      return key ? { key, dir } : null;
    })
    .filter((x): x is SortCriterion<T> => !!x);
  return parsed.length > 0 ? parsed : [{ key: defaultKey, dir: defaultDir }];
}

function serializeMultiSort<T extends string>(sorts: SortCriterion<T>[]) {
  return sorts.map((s) => `${s.key}:${s.dir}`).join(',');
}

/** Returns true when two multi-sort arrays are equivalent. */
function sortsEqual<T extends string>(a: SortCriterion<T>[], b: SortCriterion<T>[]) {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.key === b[i].key && s.dir === b[i].dir);
}

type TrendGranularity = 'hour' | 'day' | 'month';

function granularityFor(days: number): TrendGranularity {
  if (days <= 1) return 'hour';
  if (days <= 92) return 'day';
  return 'month';
}

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

/** Build a board-ready, color-coded HTML report (cover page + breakdown) and open the print/share dialog. */
function shareAsPdf(opts: {
  periodLabel: string;
  days: number;
  start: Date;
  end: Date;
  totalExpected: number;
  totalCollected: number;
  rate: number;
  rows: { id: string; name: string; expected: number; collected: number; rate: number }[];
}) {
  const { periodLabel, days, start, end, totalExpected, totalCollected, rate, rows } = opts;
  const toneFor = (r: number) => (r >= 100 ? '#059669' : r >= 80 ? '#059669' : r >= 50 ? '#d97706' : '#dc2626');
  const verdict = rate >= 100 ? 'Exceeding target' : rate >= 80 ? 'On track' : rate >= 50 ? 'Needs a push' : 'Falling behind';
  const generated = new Date().toLocaleString();
  const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  // end is exclusive; show the last covered day for human reading
  const lastDay = new Date(end.getTime() - 1);
  const rangeLabel = days <= 1 ? fmtDate(start) : `${fmtDate(start)} – ${fmtDate(lastDay)}`;
  const shortfall = Math.max(0, totalExpected - totalCollected);
  const topName = rows[0]?.name || '—';
  const rowsHtml = rows
    .map((r, i) => {
      const c = toneFor(r.rate);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
      const overLabel = r.rate > 100 ? ` ↑${r.rate - 100}% over` : '';
      return `<tr>
        <td class="rank">${medal || i + 1}</td>
        <td class="name">${(r.name || '').replace(/</g, '&lt;')}</td>
        <td class="num">${formatUGX(r.expected)}</td>
        <td class="num strong">${formatUGX(r.collected)}</td>
        <td class="rate" style="color:${c}">
          <span class="dot" style="background:${c}"></span>${r.rate}%${overLabel}
        </td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Fleet Performance · ${periodLabel}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 28px; }
      h1 { font-size: 24px; margin: 0 0 2px; }
      .sub { color: #6b7280; font-size: 13px; margin: 0 0 18px; }
      .cards { display: flex; gap: 12px; margin-bottom: 18px; }
      .card { flex: 1; border: 1px solid #e5e7eb; border-radius: 14px; padding: 14px 16px; }
      .card .lbl { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; font-weight: 700; }
      .card .val { font-size: 26px; font-weight: 800; margin-top: 4px; }
      .verdict { display: inline-block; padding: 6px 14px; border-radius: 999px; font-weight: 800; font-size: 15px; color: #fff; margin-bottom: 18px; }
      .barwrap { height: 14px; background: #f1f5f9; border-radius: 999px; overflow: hidden; margin: 10px 0 22px; }
      .bar { height: 100%; border-radius: 999px; }
      table { width: 100%; border-collapse: collapse; font-size: 15px; }
      th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 8px 10px; }
      th.num, th.rate { text-align: right; }
      td { padding: 11px 10px; border-bottom: 1px solid #f1f5f9; }
      td.rank { font-weight: 800; width: 44px; font-size: 17px; }
      td.name { font-weight: 700; }
      td.num { text-align: right; font-variant-numeric: tabular-nums; }
      td.num.strong { font-weight: 800; }
      td.rate { text-align: right; font-weight: 800; font-variant-numeric: tabular-nums; }
      .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
      tr:nth-child(even) td { background: #fafafa; }
      .foot { margin-top: 20px; color: #9ca3af; font-size: 11px; }
      @media print { body { padding: 0; } }
      /* Cover page */
      .cover { min-height: 92vh; display: flex; flex-direction: column; justify-content: center; padding: 8vh 6vw; page-break-after: always; }
      .brand { font-size: 13px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; color: #2563eb; margin-bottom: 14px; }
      .cover h1 { font-size: 46px; line-height: 1.05; margin: 0 0 10px; }
      .cover .period { font-size: 20px; font-weight: 700; color: #111827; margin: 0 0 4px; }
      .cover .periodsub { font-size: 14px; color: #6b7280; margin: 0 0 28px; }
      .cover .verdict { font-size: 18px; }
      .keytotals { display: flex; gap: 16px; margin-top: 8px; }
      .keytotals .card { background: #fafafa; }
      .keytotals .card .val { font-size: 30px; }
      .cover .gen { margin-top: auto; padding-top: 30px; color: #9ca3af; font-size: 12px; }
      .section-title { font-size: 18px; font-weight: 800; margin: 0 0 14px; }
    </style></head><body>
    <!-- Cover page -->
    <section class="cover">
      <div class="brand">Welile · Executive Report</div>
      <h1>Fleet Performance<br/>Collection Report</h1>
      <p class="period">${periodLabel}</p>
      <p class="periodsub">Reporting period: ${rangeLabel} · ${days} day${days === 1 ? '' : 's'} · ${rows.length} agent${rows.length === 1 ? '' : 's'}</p>
      <div class="verdict" style="background:${toneFor(rate)}">${verdict} — ${rate}% collected</div>
      <div class="keytotals">
        <div class="card"><div class="lbl">Expected</div><div class="val" style="color:#7c3aed">${formatUGX(totalExpected)}</div></div>
        <div class="card"><div class="lbl">Collected</div><div class="val" style="color:#2563eb">${formatUGX(totalCollected)}</div></div>
        <div class="card"><div class="lbl">Shortfall</div><div class="val" style="color:${shortfall > 0 ? '#dc2626' : '#059669'}">${formatUGX(shortfall)}</div></div>
        <div class="card"><div class="lbl">Top agent</div><div class="val" style="font-size:18px;color:#111827">${topName.replace(/</g, '&lt;')}</div></div>
      </div>
      <p class="gen">Generated ${generated}</p>
    </section>

    <!-- Detail page -->
    <h1>Fleet Performance</h1>
    <p class="sub">${periodLabel} · ${rangeLabel} · ${rows.length} agent${rows.length === 1 ? '' : 's'}</p>
    <div class="cards">
      <div class="card"><div class="lbl">Expected</div><div class="val" style="color:#7c3aed">${formatUGX(totalExpected)}</div></div>
      <div class="card"><div class="lbl">Collected</div><div class="val" style="color:#2563eb">${formatUGX(totalCollected)}</div></div>
      <div class="card"><div class="lbl">Collection rate</div><div class="val" style="color:${toneFor(rate)}">${rate}%</div></div>
    </div>
    <div class="barwrap"><div class="bar" style="width:${Math.min(rate, 100)}%;background:${toneFor(rate)}"></div></div>
    <p class="section-title">Agent-by-agent breakdown</p>
    <table>
      <thead><tr><th>#</th><th>Agent</th><th class="num">Expected</th><th class="num">Collected</th><th class="rate">Rate</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:24px">No agent activity in this period.</td></tr>'}</tbody>
    </table>
    <p class="foot">Welile · Agent rent collection report</p>
    <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 250); };</script>
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Build a print-ready PDF of the trend chart data (per hour / day / month) and open the print dialog. */
function shareTrendAsPdf(opts: {
  periodLabel: string;
  granLabel: string;
  rangeLabel: string;
  rows: { label: string; collected: number; expected: number }[];
}) {
  const { periodLabel, granLabel, rangeLabel, rows } = opts;
  const generated = new Date().toLocaleString();
  const totalExpected = rows.reduce((s, r) => s + r.expected, 0);
  const totalCollected = rows.reduce((s, r) => s + r.collected, 0);
  const overallRate = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : 0;
  const maxVal = Math.max(1, ...rows.map((r) => Math.max(r.collected, r.expected)));
  const toneFor = (r: number) => (r >= 100 ? '#059669' : r >= 50 ? '#d97706' : '#dc2626');
  const rowsHtml = rows
    .map((r) => {
      const rate = r.expected > 0 ? Math.round((r.collected / r.expected) * 100) : 0;
      const c = toneFor(rate);
      const w = Math.round((r.collected / maxVal) * 100);
      const overLabel = rate > 100 ? ` ↑${rate - 100}%` : '';
      return `<tr>
        <td class="lbl">${(r.label || '').replace(/</g, '&lt;')}</td>
        <td class="num">${formatUGX(r.expected)}</td>
        <td class="num strong">${formatUGX(r.collected)}</td>
        <td class="barcell"><div class="minibar"><div class="minifill" style="width:${w}%;background:${c}"></div></div></td>
        <td class="rate" style="color:${c}">${rate}%${overLabel}</td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Collection Trend · ${granLabel}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 28px; }
      .brand { font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: #2563eb; margin-bottom: 8px; }
      h1 { font-size: 24px; margin: 0 0 2px; }
      .sub { color: #6b7280; font-size: 13px; margin: 0 0 18px; }
      .cards { display: flex; gap: 12px; margin-bottom: 18px; }
      .card { flex: 1; border: 1px solid #e5e7eb; border-radius: 14px; padding: 14px 16px; }
      .card .lbl { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; font-weight: 700; }
      .card .val { font-size: 24px; font-weight: 800; margin-top: 4px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 8px 10px; }
      th.num, th.rate { text-align: right; }
      td { padding: 9px 10px; border-bottom: 1px solid #f1f5f9; }
      td.lbl { font-weight: 700; white-space: nowrap; }
      td.num { text-align: right; font-variant-numeric: tabular-nums; }
      td.num.strong { font-weight: 800; }
      td.rate { text-align: right; font-weight: 800; font-variant-numeric: tabular-nums; }
      td.barcell { width: 28%; }
      .minibar { height: 8px; background: #f1f5f9; border-radius: 999px; overflow: hidden; }
      .minifill { height: 100%; border-radius: 999px; }
      tr:nth-child(even) td { background: #fafafa; }
      .foot { margin-top: 20px; color: #9ca3af; font-size: 11px; }
      @media print { body { padding: 0; } }
    </style></head><body>
    <div class="brand">Welile · Executive Report</div>
    <h1>Collection Trend — ${granLabel}</h1>
    <p class="sub">${periodLabel} · ${rangeLabel} · ${rows.length} interval${rows.length === 1 ? '' : 's'}</p>
    <div class="cards">
      <div class="card"><div class="lbl">Expected</div><div class="val" style="color:#7c3aed">${formatUGX(totalExpected)}</div></div>
      <div class="card"><div class="lbl">Collected</div><div class="val" style="color:#2563eb">${formatUGX(totalCollected)}</div></div>
      <div class="card"><div class="lbl">Collection rate</div><div class="val" style="color:${toneFor(overallRate)}">${overallRate}%</div></div>
    </div>
    <table>
      <thead><tr><th>${granLabel}</th><th class="num">Expected</th><th class="num">Collected</th><th>Flow</th><th class="rate">Rate</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:24px">No collection activity in this period.</td></tr>'}</tbody>
    </table>
    <p class="foot">Welile · Collection trend report · Generated ${generated}</p>
    <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 250); };</script>
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Resolve a period to [start, end) and the number of calendar days it spans. */
function resolvePeriod(key: PeriodKey): { start: Date; end: Date; days: number } {
  const now = new Date();
  const today = startOfDay(now);
  switch (key) {
    case 'today':
      return { start: today, end: now, days: 1 };
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      return { start: y, end: today, days: 1 };
    }
    case 'last7': {
      const s = new Date(today); s.setDate(s.getDate() - 6);
      return { start: s, end: now, days: 7 };
    }
    case 'last30': {
      const s = new Date(today); s.setDate(s.getDate() - 29);
      return { start: s, end: now, days: 30 };
    }
    case 'this_month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const days = Math.floor((today.getTime() - s.getTime()) / 86_400_000) + 1;
      return { start: s, end: now, days };
    }
    case 'last_month': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 1);
      const days = Math.round((e.getTime() - s.getTime()) / 86_400_000);
      return { start: s, end: e, days };
    }
    case 'all': {
      const s = startOfDay(ALL_TIME_START);
      const days = Math.max(1, Math.round((now.getTime() - s.getTime()) / 86_400_000));
      return { start: s, end: now, days };
    }
    default:
      return { start: today, end: now, days: 1 };
  }
}

/**
 * Expected collection per agent for a range, read from the PINNED daily bill
 * (`agent_expected_day_plans`) — the same source the Collections Command Center
 * uses. It must never be re-derived live from `rent_requests.daily_repayment`:
 * that re-derivation counts plans the bill excludes and read ~238% of the bill,
 * which is why Fleet Performance and the Command Center disagreed.
 *
 * Returns both the per-agent total for the range and a per-day fleet total so
 * the trend chart bills each day with that day's own frozen figure.
 */
function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchExpectedByAgent(
  start: Date,
  end: Date,
): Promise<{ byAgent: Record<string, number>; byDay: Record<string, number> }> {
  const byAgent: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  const PAGE = 1000;
  const from_ = isoDay(start);
  const to_ = isoDay(new Date(end.getTime() - 1));
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('agent_expected_day_plans')
      .select('agent_id, expected_ugx, day')
      .gte('day', from_)
      .lte('day', to_)
      .range(from, from + PAGE - 1);
    if (error) { console.error('[FleetPerformanceStats] expected page failed', error); break; }
    const rows = data || [];
    rows.forEach((r: any) => {
      const amt = Number(r.expected_ugx) || 0;
      if (r.agent_id) byAgent[r.agent_id] = (byAgent[r.agent_id] || 0) + amt;
      if (r.day) byDay[r.day] = (byDay[r.day] || 0) + amt;
    });
    if (rows.length < PAGE) break;
  }
  return { byAgent, byDay };
}


/**
 * Collected per agent for a period.
 *
 * Source of truth: `agent_collections` (canonical daily-capacity source —
 * every tenant-payment RPC and edge fn, including `agent_allocate_tenant_payment`,
 * writes a row here). Reading directly from it gives us real-time,
 * agent-tagged totals without needing a rent_request join, and keeps
 * "Collected" perfectly aligned with the per-agent capacity page.
 */
/**
 * Set of rent_request_ids that were CFO-funded via landlord float
 * (i.e. `agent_landlord_float_allocations` exists for that rent_request).
 * These allocations are excluded from "Collected" because the landlord was
 * paid from CFO-disbursed landlord float, not from a fresh field collection.
 */
export async function fetchLandlordFloatRentRequestIds(rentRequestIds: string[]): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (rentRequestIds.length === 0) return excluded;
  const BATCH = 200;
  for (let i = 0; i < rentRequestIds.length; i += BATCH) {
    const chunk = rentRequestIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('agent_landlord_float_allocations')
      .select('rent_request_id')
      .in('rent_request_id', chunk);
    if (error) { console.error('[FleetPerformanceStats] llf allocations lookup failed', error); continue; }
    (data || []).forEach((r: any) => { if (r.rent_request_id) excluded.add(r.rent_request_id); });
  }
  return excluded;
}

export async function fetchCollectedByAgent(start: Date, end: Date): Promise<Record<string, number>> {
  const PAGE = 1000;
  let from = 0;
  const rows: Array<{ agent_id: string; amount: number; rent_request_id: string | null }> = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('agent_collections')
      .select('agent_id, amount, rent_request_id').is('reversed_at', null)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .gt('amount', 0)
      // "Collected" is defined strictly as float allocations produced by
      // `agent_allocate_tenant_payment` (agent uses operational float to
      // reduce a tenant's outstanding balance). That RPC stamps
      // `tracking_id = 'AGT-<txn-group>'`; everything else (legacy cash
      // captures, ALLOC-*, TPAY-*, WEL-TXN-*) is excluded.
      .like('tracking_id', 'AGT-%')
      .range(from, from + PAGE - 1);
    if (error) { console.error('[FleetPerformanceStats] agent_collections page failed', error); break; }
    const page = data || [];
    page.forEach((r: any) => {
      if (!r.agent_id) return;
      rows.push({ agent_id: r.agent_id, amount: Number(r.amount) || 0, rent_request_id: r.rent_request_id ?? null });
    });
    if (page.length < PAGE) break;
    from += PAGE;
  }
  // Exclude "landlord float allocations" — rent_requests whose landlord was
  // paid from CFO-disbursed landlord float (i.e. an `agent_landlord_float_allocations`
  // row exists for that rent_request). Those are pool repayments, not
  // fresh field collections.
  const rrIds = Array.from(new Set(rows.map((r) => r.rent_request_id).filter((x): x is string => !!x)));
  const excluded = await fetchLandlordFloatRentRequestIds(rrIds);
  const byAgent: Record<string, number> = {};
  rows.forEach((r) => {
    if (r.rent_request_id && excluded.has(r.rent_request_id)) return;
    byAgent[r.agent_id] = (byAgent[r.agent_id] || 0) + r.amount;
  });
  return byAgent;
}

async function fetchAgentNames(agentIds: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const BATCH = 100;
  for (let i = 0; i < agentIds.length; i += BATCH) {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', agentIds.slice(i, i + BATCH));
    (data || []).forEach((p: any) => { names[p.id] = p.full_name || p.id.slice(0, 8); });
  }
  return names;
}

/** Local YYYY-MM-DD key for a date. */
function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local hour bucket key, e.g. 2026-06-11T14. */
function hourKey(d: Date) {
  return `${dayKey(d)}T${String(d.getHours()).padStart(2, '0')}`;
}

/** Local month bucket key, e.g. 2026-06. */
function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function bucketKeyFor(d: Date, gran: TrendGranularity) {
  return gran === 'hour' ? hourKey(d) : gran === 'month' ? monthKey(d) : dayKey(d);
}

/** Collected total per time bucket (hour/day/month) across the whole fleet within [start, end). */
export async function fetchCollectedBuckets(start: Date, end: Date, gran: TrendGranularity): Promise<Record<string, number>> {
  const PAGE = 1000;
  let from = 0;
  const rows: Array<{ amount: number; created_at: string; rent_request_id: string | null }> = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('agent_collections')
      .select('amount, created_at, rent_request_id').is('reversed_at', null)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .gt('amount', 0)
      // Strict float-allocation definition — see fetchCollectedByAgent.
      .like('tracking_id', 'AGT-%')
      .range(from, from + PAGE - 1);
    if (error) { console.error('[FleetPerformanceStats] bucket agent_collections page failed', error); break; }
    const page = data || [];
    page.forEach((r: any) => {
      if (!r.created_at) return;
      rows.push({ amount: Number(r.amount) || 0, created_at: r.created_at, rent_request_id: r.rent_request_id ?? null });
    });
    if (page.length < PAGE) break;
    from += PAGE;
  }
  const rrIds = Array.from(new Set(rows.map((r) => r.rent_request_id).filter((x): x is string => !!x)));
  const excluded = await fetchLandlordFloatRentRequestIds(rrIds);
  const byBucket: Record<string, number> = {};
  rows.forEach((r) => {
    if (r.rent_request_id && excluded.has(r.rent_request_id)) return;
    const k = bucketKeyFor(new Date(r.created_at), gran);
    byBucket[k] = (byBucket[k] || 0) + r.amount;
  });
  return byBucket;
}

export function FleetPerformanceStats({
  detailed = true,
  autoRefreshMs = 0,
}: { detailed?: boolean; autoRefreshMs?: number } = {}) {
  const { agentIds: qualifyingIds, isReady: qualifyingReady } = useQualifyingAgentIds();
  const [searchParams, setSearchParams] = useSearchParams();
  // Restore last-used range. URL parameters (?period, ?from, ?to) take precedence
  // over localStorage so shared/bookmarked links reproduce the exact same view.
  const restored = useMemo(() => {
    const urlPeriod = searchParams.get('period') as PeriodKey | null;
    const urlFrom = searchParams.get('from');
    const urlTo = searchParams.get('to');
    const validPeriods: PeriodKey[] = ['today', 'yesterday', 'last7', 'last30', 'this_month', 'last_month', 'all', 'custom'];
    if (urlPeriod && validPeriods.includes(urlPeriod)) {
      return { period: urlPeriod, from: urlFrom || undefined, to: urlTo || undefined };
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as { period?: PeriodKey; from?: string; to?: string };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [period, setPeriod] = useState<PeriodKey>(restored?.period || 'today');
  const [sort, setSort] = useState<{ key: 'expected' | 'collected' | 'rate'; dir: 'asc' | 'desc' }>({ key: 'collected', dir: 'desc' });
  const [search, setSearch] = useState('');
  const [customRange, setCustomRange] = useState<DateRange | undefined>(
    restored?.from
      ? { from: new Date(restored.from), to: restored.to ? new Date(restored.to) : undefined }
      : undefined,
  );
  const [rangeOpen, setRangeOpen] = useState(false);
  const isMobile = useIsMobile();
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(() => searchParams.get('breakdown'));

  // Sync the expanded drill-down agent to the URL (?breakdown=<agentId>) so the
  // exact same view can be shared or bookmarked.
  const breakdownParam = searchParams.get('breakdown');
  useEffect(() => {
    if (expandedId === breakdownParam) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (expandedId) next.set('breakdown', expandedId);
        else next.delete('breakdown');
        return next;
      },
      { replace: true },
    );
  }, [expandedId, breakdownParam, setSearchParams]);


  // "Verify totals" reconciler: independently re-fetches agent_collections in the range
  // and compares row-count + fleet total + per-agent totals against the cached KPI.
  type VerifyResult = {
    at: number;
    rows: number;
    fleetSum: number;
    perAgent: Record<string, number>;
    kpiCollected: number;
    error?: string;
  };
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  // Alerts panel — flag agents whose collection rate falls below a threshold.
  const ALERT_STORAGE_KEY = 'fleet-perf-alerts';
  const restoredAlerts = useMemo(() => {
    try {
      const raw = localStorage.getItem(ALERT_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as { threshold?: number; minExpected?: number };
    } catch { return null; }
  }, []);
  const [alertThreshold, setAlertThreshold] = useState<number>(restoredAlerts?.threshold ?? 50);
  const [alertMinExpected, setAlertMinExpected] = useState<number>(restoredAlerts?.minExpected ?? 10_000);
  const [alertsOpen, setAlertsOpen] = useState<boolean>(true);
  const [alertConfigOpen, setAlertConfigOpen] = useState<boolean>(false);

  // Drill-down state — every clickable number opens the appropriate sheet.
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillAgentId, setDrillAgentId] = useState<string | null>(null);
  const [drillAgentName, setDrillAgentName] = useState<string | null>(null);
  const [drillBucket, setDrillBucket] = useState<{ start: Date; end: Date; label: string } | null>(null);
  const [expectedOpen, setExpectedOpen] = useState(false);
  const [expectedAgentId, setExpectedAgentId] = useState<string | null>(null);
  const [expectedAgentName, setExpectedAgentName] = useState<string | null>(null);

  const openDrill = (opts: { agentId?: string | null; agentName?: string | null; bucket?: { start: Date; end: Date; label: string } | null } = {}) => {
    setDrillAgentId(opts.agentId ?? null);
    setDrillAgentName(opts.agentName ?? null);
    setDrillBucket(opts.bucket ?? null);
    setDrillOpen(true);
  };
  const openExpected = (opts: { agentId?: string | null; agentName?: string | null } = {}) => {
    setExpectedAgentId(opts.agentId ?? null);
    setExpectedAgentName(opts.agentName ?? null);
    setExpectedOpen(true);
  };

  useEffect(() => {
    try {
      localStorage.setItem(
        ALERT_STORAGE_KEY,
        JSON.stringify({ threshold: alertThreshold, minExpected: alertMinExpected }),
      );
    } catch { /* ignore */ }
  }, [alertThreshold, alertMinExpected]);

  // Persist the selected range whenever it changes.
  useEffect(() => {
    try {
      const payload: { period: PeriodKey; from?: string; to?: string } = { period };
      if (period === 'custom' && customRange?.from) {
        payload.from = customRange.from.toISOString();
        if (customRange.to) payload.to = customRange.to.toISOString();
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore storage failures */
    }
  }, [period, customRange]);

  // Mirror the selected range to the URL so it can be shared/bookmarked and
  // survives full reloads exactly as viewed.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (period === 'today') {
          next.delete('period');
          next.delete('from');
          next.delete('to');
        } else {
          next.set('period', period);
          if (period === 'custom' && customRange?.from) {
            next.set('from', customRange.from.toISOString());
            if (customRange.to) next.set('to', customRange.to.toISOString());
            else next.delete('to');
          } else {
            next.delete('from');
            next.delete('to');
          }
        }
        return next;
      },
      { replace: true },
    );
  }, [period, customRange, setSearchParams]);

  const { start, end, days } = useMemo(() => {
    if (period === 'custom' && customRange?.from) {
      const s = startOfDay(customRange.from);
      const e = new Date(startOfDay(customRange.to || customRange.from));
      e.setDate(e.getDate() + 1); // make end exclusive of the day after the last selected day
      const d = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000));
      return { start: s, end: e, days: d };
    }
    return resolvePeriod(period);
  }, [period, customRange]);

  // Stable key fragment so custom-range queries refetch when the range changes.
  const rangeKey = period === 'custom' ? `custom:${start.toISOString()}:${end.toISOString()}` : period;

  const granularity = granularityFor(days);

  const queryClient = useQueryClient();
  const { data: expectedData, isLoading: expLoading, dataUpdatedAt: expUpdatedAt, isFetching: expFetching } = useQuery({
    queryKey: ['fleet-perf-expected-by-agent', rangeKey],
    queryFn: () => fetchExpectedByAgent(start, end),
    staleTime: 60_000,
    refetchInterval: autoRefreshMs || false,
    refetchIntervalInBackground: false,
  });
  const expectedByAgent = expectedData?.byAgent ?? {};
  const expectedByDay = expectedData?.byDay ?? {};


  const { data: collectedByAgent = {}, isLoading: colLoading, dataUpdatedAt: colUpdatedAt, isFetching: colFetching } = useQuery({
    queryKey: ['fleet-perf-collected-by-agent', rangeKey],
    queryFn: () => fetchCollectedByAgent(start, end),
    staleTime: 30_000,
    refetchInterval: autoRefreshMs || false,
    refetchIntervalInBackground: false,
  });

  const { data: collectedBuckets = {}, isFetching: bucketFetching } = useQuery({
    queryKey: ['fleet-perf-collected-buckets', rangeKey, granularity],
    queryFn: () => fetchCollectedBuckets(start, end, granularity),
    staleTime: 30_000,
    refetchInterval: autoRefreshMs || false,
    refetchIntervalInBackground: false,
  });

  /**
   * Shared source of truth with the Performance page (Collections Command Center):
   * the same `get_agent_collections_command_center` RPC, called with this page's
   * selected range. The EXPECTED / COLLECTED / COLLECTION RATE cards read from
   * here so both pages always show identical real-time totals.
   */
  const commandBucket = days <= 1 ? 'hour' : days <= 62 ? 'day' : 'month';
  const { data: commandCenter } = useQuery({
    queryKey: ['agent-collections-command-center', start.toISOString(), end.toISOString(), commandBucket],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_command_center', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_bucket: commandBucket,
      });
      if (error) throw error;
      return data as unknown as {
        totals: { collected: number };
        agents: { agent_id: string; expected: number; collected: number }[];
      };
    },
    refetchInterval: 60_000,
    staleTime: 20_000,
  });


  const agentIds = useMemo(() => {
    const set = new Set<string>([...Object.keys(expectedByAgent), ...Object.keys(collectedByAgent)]);
    return Array.from(set).sort();
  }, [expectedByAgent, collectedByAgent]);

  const { data: names = {} } = useQuery({
    queryKey: ['fleet-perf-agent-names', agentIds],
    queryFn: () => fetchAgentNames(agentIds),
    enabled: agentIds.length > 0,
    staleTime: 5 * 60_000,
  });

  const rawRows = useMemo(() => {
    return agentIds
      .map((id) => {
        const expected = (expectedByAgent[id] || 0) * days;
        const collected = collectedByAgent[id] || 0;
        const rate = expected > 0 ? Math.round((collected / expected) * 100) : 0;
        return { id, name: names[id] || id.slice(0, 8), expected, collected, rate };
      })
      .filter((r) => r.expected > 0 || r.collected > 0)
      // Only qualifying agents (behaviour-based definition) — consistent
      // with every other agent list in the dashboard.
      .filter((r) => !qualifyingReady || qualifyingIds.has(r.id));
  }, [agentIds, expectedByAgent, collectedByAgent, names, days, qualifyingIds, qualifyingReady]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rawRows;
    return rawRows.filter((r) =>
      r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)
    );
  }, [rawRows, search]);

  const rows = useMemo(() => {
    const { key, dir } = sort;
    const sorted = [...filteredRows].sort((a, b) => {
      let cmp = 0;
      if (key === 'expected') cmp = a.expected - b.expected;
      else if (key === 'collected') cmp = a.collected - b.collected;
      else cmp = a.rate - b.rate;
      return dir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [filteredRows, sort]);

  // If the URL names an agent on another page, jump to that page once rows load.
  useEffect(() => {
    if (!expandedId || rows.length === 0) return;
    const idx = rows.findIndex((r) => r.id === expandedId);
    if (idx >= 0) setPage(Math.floor(idx / PAGE_SIZE));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId, rows]);

  const loading = expLoading || colLoading;
  // KPI totals come from the Command Center RPC (shared with the Performance page)
  // and fall back to the locally computed row sums until the RPC resolves.
  const localExpected = rows.reduce((s, r) => s + r.expected, 0);
  const localCollected = rows.reduce((s, r) => s + r.collected, 0);
  const totalExpected = commandCenter
    ? (commandCenter.agents || []).reduce((s, a) => s + (Number(a.expected) || 0), 0)
    : localExpected;
  const totalCollected = commandCenter
    ? Number(commandCenter.totals?.collected ?? 0)
    : localCollected;
  const rate = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : 0;

  const rateTone = rate >= 100 ? 'text-emerald-600' : rate >= 80 ? 'text-emerald-600' : rate >= 50 ? 'text-amber-600' : 'text-destructive';
  const barTone = rate >= 100 ? 'bg-emerald-500' : rate >= 80 ? 'bg-emerald-500' : rate >= 50 ? 'bg-amber-500' : 'bg-destructive';

  // Pagination for the agent-by-agent breakdown.
  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

  // Alerts: agents with meaningful expected but rate below threshold, worst gap first.
  const alertRows = useMemo(() => {
    return rawRows
      .filter((r) => r.expected >= alertMinExpected && r.rate < alertThreshold)
      .map((r) => ({ ...r, gap: Math.max(0, r.expected - r.collected) }))
      .sort((a, b) => b.gap - a.gap);
  }, [rawRows, alertThreshold, alertMinExpected]);

  // Anchor for the agent-by-agent breakdown table so KPI cards can scroll to it.
  const breakdownRef = useRef<HTMLDivElement | null>(null);

  /**
   * KPI card click: sort the breakdown by the clicked metric (highest first,
   * toggling to lowest first on a repeat click) and scroll the table into view.
   */
  const focusMetric = (key: 'expected' | 'collected' | 'rate') => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
    setPage(0);
    requestAnimationFrame(() => {
      breakdownRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  /** Which KPI card has its inline agent accordion open. */
  const [kpiPanel, setKpiPanel] = useState<'expected' | 'collected' | null>(null);

  /** Agents with expected rent due in this window, biggest first. */
  const expectedPanelRows = useMemo(
    () => filteredRows.filter((r) => r.expected > 0).sort((a, b) => b.expected - a.expected),
    [filteredRows],
  );

  /** Agents that actually collected in this window, biggest first. */
  const collectedPanelRows = useMemo(
    () => filteredRows.filter((r) => r.collected > 0).sort((a, b) => b.collected - a.collected),
    [filteredRows],
  );

  /** Toggle the inline accordion under a KPI card and sort the breakdown to match. */
  const toggleKpiPanel = (key: 'expected' | 'collected') => {
    setKpiPanel((prev) => (prev === key ? null : key));
    setSort({ key, dir: 'desc' });
    setPage(0);
  };


  // Jump to a specific agent row in the breakdown table, expand it, and scroll it into view.
  const focusAgent = (id: string) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx >= 0) setPage(Math.floor(idx / PAGE_SIZE));
    setExpandedId(id);
    requestAnimationFrame(() => {
      const el = document.getElementById(`fleet-row-${id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  // Independent recount: pages through agent_collections in the range and returns
  // per-agent totals + fleet sum + row count. Used by the "Verify totals" control
  // to reconcile the KPI against the raw table for the exact same window.
  const runVerifyTotals = async () => {
    setVerifying(true);
    const perAgent: Record<string, number> = {};
    let fleetSum = 0;
    let rowCount = 0;
    let errMsg: string | undefined;
    try {
      const PAGE = 1000;
      let fromIdx = 0;
      const raw: Array<{ agent_id: string; amount: number; rent_request_id: string | null }> = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from('agent_collections')
          .select('agent_id, amount, rent_request_id, tracking_id').is('reversed_at', null)
          .gte('created_at', start.toISOString())
          .lt('created_at', end.toISOString())
          .gt('amount', 0)
          .like('tracking_id', 'AGT-%')
          .range(fromIdx, fromIdx + PAGE - 1);
        if (error) { errMsg = error.message; break; }
        const chunk = data || [];
        for (const r of chunk as any[]) {
          raw.push({
            agent_id: r.agent_id,
            amount: Number(r.amount) || 0,
            rent_request_id: r.rent_request_id ?? null,
          });
        }
        if (chunk.length < PAGE) break;
        fromIdx += PAGE;
      }
      // Exclude CFO-funded landlord-float allocations to match the KPI definition.
      const rrIds = Array.from(new Set(raw.map((r) => r.rent_request_id).filter((x): x is string => !!x)));
      const excluded = await fetchLandlordFloatRentRequestIds(rrIds);
      for (const r of raw) {
        if (r.rent_request_id && excluded.has(r.rent_request_id)) continue;
        fleetSum += r.amount;
        rowCount += 1;
        if (r.agent_id) perAgent[r.agent_id] = (perAgent[r.agent_id] || 0) + r.amount;
      }
    } catch (e: any) {
      errMsg = e?.message || 'Verify failed';
    }
    setVerifyResult({
      at: Date.now(),
      rows: rowCount,
      fleetSum,
      perAgent,
      kpiCollected: totalCollected,
      error: errMsg,
    });
    setVerifying(false);
    setVerifyOpen(true);
  };

  // Per-agent deltas between the independent recount and the KPI's cached map.
  const verifyDeltas = useMemo(() => {
    if (!verifyResult) return [] as { id: string; name: string; kpi: number; live: number; delta: number }[];
    const ids = new Set<string>([
      ...Object.keys(verifyResult.perAgent),
      ...Object.keys(collectedByAgent),
    ]);
    const list: { id: string; name: string; kpi: number; live: number; delta: number }[] = [];
    ids.forEach((id) => {
      const kpi = collectedByAgent[id] || 0;
      const live = verifyResult.perAgent[id] || 0;
      const delta = live - kpi;
      if (Math.abs(delta) >= 1) {
        list.push({ id, name: names[id] || id.slice(0, 8), kpi, live, delta });
      }
    });
    return list.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [verifyResult, collectedByAgent, names]);

  // Reset to first page whenever the result set changes.
  useEffect(() => {
    setPage(0);
  }, [search, sort, rangeKey]);

  // Daily expected target across the whole fleet (constant per day).
  const expectedPerDay = useMemo(
    () => Object.values(expectedByAgent).reduce((s, v) => s + (Number(v) || 0), 0),
    [expectedByAgent],
  );

  // Trend series of collected vs expected, bucketed by hour / day / month.
  const trendData = useMemo(() => {
    const out: { label: string; collected: number; expected: number; bucketStart: number; bucketEnd: number }[] = [];
    const endMs = end.getTime();
    if (granularity === 'hour') {
      const cursor = new Date(start);
      cursor.setMinutes(0, 0, 0);
      const expectedPerHour = expectedPerDay / 24;
      while (cursor.getTime() < endMs) {
        const k = hourKey(cursor);
        const bs = new Date(cursor);
        const be = new Date(cursor); be.setHours(be.getHours() + 1);
        out.push({ label: format(cursor, 'h a'), collected: collectedBuckets[k] || 0, expected: expectedPerHour, bucketStart: Math.max(bs.getTime(), start.getTime()), bucketEnd: Math.min(be.getTime(), endMs) });
        cursor.setHours(cursor.getHours() + 1);
      }
    } else if (granularity === 'month') {
      const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cursor.getTime() < endMs) {
        const k = monthKey(cursor);
        const bucketStart = Math.max(cursor.getTime(), start.getTime());
        const nextMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
        const bucketEnd = Math.min(nextMonth.getTime(), endMs);
        const dCount = Math.max(1, Math.round((bucketEnd - bucketStart) / 86_400_000));
        out.push({ label: format(cursor, 'MMM yy'), collected: collectedBuckets[k] || 0, expected: expectedPerDay * dCount, bucketStart, bucketEnd });
        cursor.setMonth(cursor.getMonth() + 1);
      }
    } else {
      const cursor = startOfDay(start);
      while (cursor.getTime() < endMs) {
        const k = dayKey(cursor);
        const bs = new Date(cursor);
        const be = new Date(cursor); be.setDate(be.getDate() + 1);
        out.push({ label: format(cursor, 'MMM d'), collected: collectedBuckets[k] || 0, expected: expectedPerDay, bucketStart: Math.max(bs.getTime(), start.getTime()), bucketEnd: Math.min(be.getTime(), endMs) });
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return out;
  }, [start, end, granularity, collectedBuckets, expectedPerDay]);

  const trendTitle =
    granularity === 'hour' ? 'Collection trend · hourly flow vs target'
      : granularity === 'month' ? 'Collection trend · monthly flow vs target'
      : 'Collection trend · daily flow vs target';

  const granLabel = granularity === 'hour' ? 'Hour' : granularity === 'month' ? 'Month' : 'Day';
  const trendRangeLabel = (() => {
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const lastDay = new Date(end.getTime() - 1);
    return days <= 1 ? fmt(start) : `${fmt(start)} – ${fmt(lastDay)}`;
  })();
  const exportTrendPdf = () =>
    shareTrendAsPdf({
      periodLabel: period === 'custom' ? 'Custom range' : PERIODS.find((p) => p.key === period)?.label || '',
      granLabel,
      rangeLabel: trendRangeLabel,
      rows: trendData,
    });

  return (
    <div className="mt-3 rounded-xl border border-border bg-background/60 p-3">
      <div className="flex flex-col gap-2 mb-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              Fleet performance · Expected vs Collected
            </p>
            <LastUpdatedChip
              updatedAt={Math.min(
                expUpdatedAt || Date.now(),
                colUpdatedAt || Date.now(),
              )}
              isFetching={expFetching || colFetching || bucketFetching}
              onRefresh={() => {
                queryClient.invalidateQueries({ queryKey: ['fleet-perf-expected-by-agent'] });
                queryClient.invalidateQueries({ queryKey: ['fleet-perf-collected-by-agent'] });
                queryClient.invalidateQueries({ queryKey: ['fleet-perf-collected-buckets'] });
              }}
              className="mt-1"
            />
          </div>
          <button
            type="button"
            onClick={() =>
              shareAsPdf({
                periodLabel:
                  period === 'custom'
                    ? 'Custom range'
                    : PERIODS.find((p) => p.key === period)?.label || '',
                days,
                start,
                end,
                totalExpected,
                totalCollected,
                rate,
                rows,
              })
            }
            disabled={loading || rows.length === 0}
            className="h-7 px-2.5 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-40 shrink-0 sm:hidden"
          >
            <Share2 className="h-3.5 w-3.5" />
            PDF
          </button>
        </div>
        {/* Mobile period selector: compact folded dropdown */}
        <div className="flex sm:hidden items-center gap-1.5 w-full justify-between">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="h-8 px-2.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 border border-border/70 bg-card text-foreground shadow-xs active:scale-95 transition-all"
              >
                <CalendarRange className="h-3.5 w-3.5 text-primary" />
                <span className="truncate max-w-[140px]">
                  {period === 'custom'
                    ? (customRange?.from ? `${format(customRange.from, 'MMM d')}${customRange.to ? ` – ${format(customRange.to, 'MMM d')}` : ''}` : 'Custom range')
                    : PERIODS.find((p) => p.key === period)?.label || 'Period'}
                </span>
                <ChevronDown className="h-3 w-3 text-muted-foreground opacity-70 ml-0.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48 p-1 z-50 bg-popover border border-border shadow-md">
              {PERIODS.map((p) => (
                <DropdownMenuItem
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className={cn(
                    'text-xs py-2 px-2.5 cursor-pointer flex items-center justify-between rounded-md transition-colors',
                    period === p.key ? 'bg-primary/10 text-primary font-semibold' : 'text-foreground hover:bg-accent/50'
                  )}
                >
                  <span>{p.label}</span>
                  {period === p.key && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                onClick={() => setPeriod('custom')}
                className={`h-8 px-2.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1 transition-all ${
                  period === 'custom'
                    ? 'bg-primary text-primary-foreground shadow-xs'
                    : 'bg-muted/70 text-muted-foreground hover:bg-muted'
                }`}
              >
                <CalendarRange className="h-3.5 w-3.5" />
                <span>{period === 'custom' && customRange?.from ? `${format(customRange.from, 'MMM d')}` : 'Pick dates'}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] p-0 z-50 bg-popover border border-border shadow-md" align="end">
              <Calendar
                mode="range"
                selected={customRange}
                onSelect={(r) => {
                  setCustomRange(r);
                  if (r?.from) setPeriod('custom');
                  if (r?.from && r?.to) setRangeOpen(false);
                }}
                numberOfMonths={1}
                disabled={{ after: new Date() }}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>
        </div>

        {/* Desktop Period selector: full horizontal buttons strip */}
        <div className="hidden sm:flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() =>
              shareAsPdf({
                periodLabel:
                  period === 'custom'
                    ? 'Custom range'
                    : PERIODS.find((p) => p.key === period)?.label || '',
                days,
                start,
                end,
                totalExpected,
                totalCollected,
                rate,
                rows,
              })
            }
            disabled={loading || rows.length === 0}
            className="h-7 px-2.5 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-40 shrink-0"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share PDF
          </button>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod(p.key)}
              className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                period === p.key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/70'
              }`}
            >
              {p.label}
            </button>
          ))}
          <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${
                  period === 'custom'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                <CalendarRange className="h-3.5 w-3.5" />
                {period === 'custom' && customRange?.from
                  ? `${format(customRange.from, 'MMM d')}${customRange.to ? ` – ${format(customRange.to, 'MMM d')}` : ''}`
                  : 'Custom range'}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] p-0" align="end">
              <Calendar
                mode="range"
                selected={customRange}
                onSelect={(r) => {
                  setCustomRange(r);
                  if (r?.from) setPeriod('custom');
                  if (r?.from && r?.to) setRangeOpen(false);
                }}
                numberOfMonths={isMobile ? 1 : 2}
                disabled={{ after: new Date() }}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
            <Stat
              icon={<Target className="h-3 w-3 sm:h-3.5 sm:w-3.5" />}
              label="Expected"
              value={formatUGX(totalExpected)}
              tone="text-violet-600"
              onClick={() => toggleKpiPanel('expected')}
              clickHint="Show the agents with expected rent due in this period"
              active={kpiPanel === 'expected'}
              secondaryLabel="Rent plans"
              onSecondary={() => openExpected()}
            />
            <Stat
              icon={<Banknote className="h-3 w-3 sm:h-3.5 sm:w-3.5" />}
              label="Collected"
              value={formatUGX(totalCollected)}
              tone="text-primary"
              info="Field collections only: agent_collections rows stamped AGT-* by agent_allocate_tenant_payment, excluding rent_requests where CFO landlord float paid the tenant."
              formula={{
                equation: "Collected = agent_collections (AGT-*) − rent_requests funded from agent_landlord_float_allocations",
                components: [
                  { label: 'Included', description: "Agent used their operational wallet float to knock down a tenant's outstanding balance." },
                  { label: 'Excluded', description: 'CFO-funded landlord-float allocations — the landlord was paid from CFO-disbursed float, so this is pool repayment, not a fresh collection.' },
                ],
                footnote: 'Legacy tracking_ids (ALLOC-*, TPAY-*, WEL-TXN-*, null) are also excluded.',
              }}
              onClick={() => toggleKpiPanel('collected')}
              clickHint="Show the active collecting agents and their collection rates"
              active={kpiPanel === 'collected'}
              secondaryLabel="Records"
              onSecondary={() => openDrill()}
            />
            <Stat
              icon={<Percent className="h-3 w-3 sm:h-3.5 sm:w-3.5" />}
              label="% Rate"
              value={`${rate}%`}
              tone={rateTone}
              onClick={() => focusMetric('rate')}
              clickHint="Sort the agent breakdown below by collection rate"
              active={sort.key === 'rate'}
            />
          </div>

          {/* Inline accordion folded under the Expected / Collected KPI cards. */}
          {kpiPanel && (
            <KpiAgentAccordion
              variant={kpiPanel}
              rows={kpiPanel === 'expected' ? expectedPanelRows : collectedPanelRows}
              onClose={() => setKpiPanel(null)}
              onSelectAgent={focusAgent}
            />
          )}

          <div className="mt-2.5 h-2 w-full rounded-full bg-muted overflow-hidden">
            <div className={`h-full ${barTone} transition-all`} style={{ width: `${Math.min(rate, 100)}%` }} />
          </div>

          {/* Agent performance breakdown — exact expected / collected / rate per agent
              plus a drill-down of that agent's tenant payments. */}
          <div ref={breakdownRef} className="mt-4 scroll-mt-4 rounded-lg border border-border bg-card">
            <div className="flex flex-col gap-2 border-b border-border p-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Agent performance breakdown · {rows.length} agent{rows.length === 1 ? '' : 's'}
              </p>
              <div className="relative sm:w-56">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agent"
                  className="h-7 w-full rounded-lg border border-border bg-background pl-7 pr-6 text-[11px] outline-none focus:border-primary"
                />
                {search && (
                  <button
                    type="button"
                    aria-label="Clear agent search"
                    onClick={() => setSearch('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>


            {rows.length === 0 ? (
              <p className="p-3 text-[11px] text-muted-foreground">No agent activity for this period.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-border text-[10px] uppercase tracking-wide">
                        <th className="p-2 text-left font-semibold text-muted-foreground">Agent</th>
                        <th className="p-2 text-right font-semibold">
                          <SortHeader label="Expected" sortKey="expected" sort={sort} onChange={setSort} align="right" />
                        </th>
                        <th className="p-2 text-right font-semibold">
                          <SortHeader label="Collected" sortKey="collected" sort={sort} onChange={setSort} align="right" />
                        </th>
                        <th className="p-2 text-right font-semibold">
                          <SortHeader label="Rate" sortKey="rate" sort={sort} onChange={setSort} align="right" />
                        </th>
                        <th className="w-8 p-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((r, i) => {
                        const open = expandedId === r.id;
                        const tone = r.rate >= 80 ? 'text-emerald-600' : r.rate >= 50 ? 'text-amber-600' : 'text-destructive';
                        return (
                          <Fragment key={r.id}>
                            <tr
                              id={`fleet-row-${r.id}`}
                              onClick={() => setExpandedId(open ? null : r.id)}
                              className="cursor-pointer border-b border-border/60 hover:bg-muted/50"
                            >
                              <td className="p-2">
                                <span className="text-muted-foreground mr-1">{pageStart + i + 1}.</span>
                                <span className="font-semibold">{r.name}</span>
                              </td>
                              <td className="p-2 text-right font-mono text-violet-600">{formatUGX(r.expected)}</td>
                              <td className="p-2 text-right font-mono text-primary">{formatUGX(r.collected)}</td>
                              <td className={`p-2 text-right font-bold ${tone}`}>{r.rate}%</td>
                              <td className="p-2 text-right text-muted-foreground">
                                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
                              </td>
                            </tr>
                            {open && (
                              <tr className="border-b border-border/60 bg-muted/20">
                                <td colSpan={5} className="p-2">
                                  <AgentCollectionsBreakdown
                                    agentId={r.id}
                                    agentName={r.name}
                                    start={start}
                                    end={end}
                                    expectedCollected={r.collected}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center justify-between gap-2 border-t border-border p-2">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={safePage === 0}
                      className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[10px] font-semibold disabled:opacity-40"
                    >
                      <ChevronLeft className="h-3 w-3" /> Prev
                    </button>
                    <span className="text-[10px] text-muted-foreground">
                      Page {safePage + 1} of {totalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={safePage >= totalPages - 1}
                      className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[10px] font-semibold disabled:opacity-40"
                    >
                      Next <ChevronRight className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
      <FleetCollectionsDrillDownSheet
        open={drillOpen}
        onOpenChange={setDrillOpen}
        start={drillBucket?.start ?? start}
        end={drillBucket?.end ?? end}
        agentId={drillAgentId}
        agentName={drillAgentName}
        bucketLabel={drillBucket?.label ?? null}
      />
      <ExpectedContributorsSheet
        open={expectedOpen}
        onOpenChange={setExpectedOpen}
        days={days}
        agentId={expectedAgentId}
        agentName={expectedAgentName}
      />
    </div>
  );
}

/**
 * Inline accordion body folded under the Expected / Collected KPI cards.
 * Expected: agents with rent due. Collected: active collecting agents with
 * their calculated collection rate (collected / expected * 100).
 */
function KpiAgentAccordion({
  variant,
  rows,
  onClose,
  onSelectAgent,
}: {
  variant: 'expected' | 'collected';
  rows: { id: string; name: string; expected: number; collected: number; rate: number }[];
  onClose: () => void;
  onSelectAgent: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, 10);
  const total = rows.reduce((s, r) => s + (variant === 'expected' ? r.expected : r.collected), 0);

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/20">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
          {variant === 'expected'
            ? `Agents with expected rent · ${rows.length}`
            : `Active collecting agents · ${rows.length}`}
          <span className="ml-2 font-mono normal-case text-foreground">{formatUGX(total)}</span>
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Collapse agent list"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="p-3 text-[11px] text-muted-foreground">
          {variant === 'expected' ? 'No agent has expected rent in this period.' : 'No agent collected in this period.'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="p-2 text-left font-semibold">Agent</th>
                  <th className="p-2 text-right font-semibold">Expected</th>
                  <th className="p-2 text-right font-semibold">Collected</th>
                  <th className="p-2 text-right font-semibold">Rate</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const tone = r.rate >= 80 ? 'text-emerald-600' : r.rate >= 50 ? 'text-amber-600' : 'text-destructive';
                  return (
                    <tr
                      key={r.id}
                      onClick={() => onSelectAgent(r.id)}
                      className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-muted/50"
                    >
                      <td className="p-2">
                        <span className="mr-1 text-muted-foreground">{i + 1}.</span>
                        <span className="font-semibold">{r.name}</span>
                      </td>
                      <td className="p-2 text-right font-mono text-violet-600">{formatUGX(r.expected)}</td>
                      <td className="p-2 text-right font-mono text-primary">{formatUGX(r.collected)}</td>
                      <td className={`p-2 text-right font-bold ${tone}`}>{r.expected > 0 ? `${r.rate}%` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > 10 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="w-full border-t border-border/60 p-2 text-[10px] font-semibold text-primary hover:bg-muted/40"
            >
              {showAll ? 'Show top 10' : `Show all ${rows.length} agents`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
  info,
  formula,
  onClick,
  clickHint,
  active,
  secondaryLabel,
  onSecondary,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
  info?: string;
  formula?: {
    equation: string;
    components: { label: string; description: string }[];
    footnote?: string;
  };
  onClick?: () => void;
  clickHint?: string;
  /** Highlights the card when the breakdown is currently sorted by this metric. */
  active?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? clickHint : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={`rounded-lg border bg-card p-2 sm:p-2.5 flex flex-col justify-between min-h-[76px] ${onClick ? 'cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors active:scale-[0.98]' : ''} ${active ? 'border-primary ring-1 ring-primary/30' : 'border-border'}`}
    >
      <div>
        <div className={`flex items-center gap-1 text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider ${tone} leading-tight`}>
          <span className="shrink-0">{icon}</span>
          <span className="truncate">{label}</span>
          {info && !formula && (
            <UiTooltipProvider delayDuration={100}>
              <UiTooltip>
                <UiTooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${label} data source`}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-primary shrink-0"
                  >
                    <Info className="h-3 w-3" />
                  </button>
                </UiTooltipTrigger>
                <UiTooltipContent side="top" className="max-w-[16rem] text-[11px] leading-snug">
                  {info}
                </UiTooltipContent>
              </UiTooltip>
            </UiTooltipProvider>
          )}
          {formula && (
            <UiTooltipProvider delayDuration={100}>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${label} formula`}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-primary shrink-0"
                  >
                    <Info className="h-3 w-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="center" className="w-72 p-3 text-xs">
                  <p className="font-mono font-semibold text-foreground">{formula.equation}</p>
                  <div className="mt-2 space-y-2">
                    {formula.components.map((c, i) => (
                      <div key={i} className="rounded-md bg-muted/60 p-2">
                        <p className="font-semibold text-foreground">{c.label}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">{c.description}</p>
                      </div>
                    ))}
                  </div>
                  {formula.footnote && (
                    <p className="mt-2 text-[10px] text-muted-foreground leading-snug border-t border-border pt-2">
                      {formula.footnote}
                    </p>
                  )}
                </PopoverContent>
              </Popover>
            </UiTooltipProvider>
          )}
        </div>
        <div
          className={`mt-1 text-[11px] sm:text-sm font-bold tabular-nums text-foreground leading-tight break-words ${onClick ? 'underline decoration-dotted decoration-muted-foreground/40 underline-offset-2' : ''}`}
        >
          {value}
        </div>
      </div>
      {secondaryLabel && onSecondary && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSecondary(); }}
          className="mt-1 text-[9px] sm:text-[10px] font-medium text-muted-foreground hover:text-primary transition-colors text-left truncate underline decoration-dotted"
        >
          {secondaryLabel}
        </button>
      )}
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onChange,
  align = 'left',
}: {
  label: string;
  sortKey: 'expected' | 'collected' | 'rate';
  sort: { key: 'expected' | 'collected' | 'rate'; dir: 'asc' | 'desc' };
  onChange: (s: { key: 'expected' | 'collected' | 'rate'; dir: 'asc' | 'desc' }) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={() => {
        if (active) {
          onChange({ key: sortKey, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
        } else {
          onChange({ key: sortKey, dir: 'desc' });
        }
      }}
      className={`flex w-full items-center gap-1 select-none ${align === 'right' ? 'justify-end' : 'justify-start'} text-muted-foreground hover:text-foreground transition-colors`}
    >
      <span>{label}</span>
      <Icon className="h-3 w-3 opacity-70" />
    </button>
  );
}

export default FleetPerformanceStats;

type CollectionRecord = {
  id: string;
  tenant_id: string | null;
  amount: number;
  created_at: string;
  payment_method: string | null;
};

async function fetchAgentCollectionRecords(agentId: string, start: Date, end: Date) {
  const all: CollectionRecord[] = [];
  const PAGE = 1000;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('agent_collections')
      .select('id, tenant_id, amount, created_at, payment_method').is('reversed_at', null)
      .eq('agent_id', agentId)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .gt('amount', 0)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[AgentCollectionsBreakdown] page failed', error); break; }
    const rows = (data || []) as CollectionRecord[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  const tenantIds = Array.from(new Set(all.map((r) => r.tenant_id).filter(Boolean))) as string[];
  const nameById = new Map<string, string>();
  const BATCH = 100;
  for (let i = 0; i < tenantIds.length; i += BATCH) {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', tenantIds.slice(i, i + BATCH));
    (data || []).forEach((p: any) => {
      nameById.set(p.id, p.full_name || p.phone || 'Tenant');
    });
  }
  return { rows: all, nameById };
}

function csvEscape(v: string | number) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function AgentCollectionsBreakdown({
  agentId,
  agentName,
  start,
  end,
  expectedCollected,
}: {
  agentId: string;
  agentName: string;
  start: Date;
  end: Date;
  /** The "Collected" figure shown for this agent in the parent row — used for reconciliation. */
  expectedCollected: number;
}) {
  const rangeKey = `${start.toISOString()}:${end.toISOString()}`;
  const { data, isLoading } = useQuery({
    queryKey: ['fleet-perf-agent-records', agentId, rangeKey],
    queryFn: () => fetchAgentCollectionRecords(agentId, start, end),
    staleTime: 30_000,
  });

  const rows = data?.rows || [];
  const nameById = data?.nameById || new Map<string, string>();
  const [searchParams, setSearchParams] = useSearchParams();

  // Filters: free-text search (tenant name / id / record id) + payment method +
  // minimum amount. Applied client-side against the already-loaded record set.
  // URL params (?bd-q, ?bd-method, ?bd-min) take precedence over per-agent
  // localStorage so shared/bookmarked links reproduce the exact same view.
  const FILTER_STORAGE_KEY = `fleet-perf-filters:${agentId}`;
  const restoredFilters = useMemo(() => {
    const urlQ = searchParams.get('bd-q');
    const urlMethod = searchParams.get('bd-method');
    const urlMin = searchParams.get('bd-min');
    if (urlQ !== null || urlMethod !== null || urlMin !== null) {
      return {
        query: urlQ || '',
        methodFilter: urlMethod || 'all',
        minAmount: urlMin || '',
      };
    }
    try {
      const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as { query?: string; methodFilter?: string; minAmount?: string };
    } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  const [query, setQuery] = useState(restoredFilters?.query ?? '');
  const [methodFilter, setMethodFilter] = useState<string>(restoredFilters?.methodFilter ?? 'all');
  const [minAmount, setMinAmount] = useState<string>(restoredFilters?.minAmount ?? '');

  // Persist filter choices to localStorage (per-agent) and mirror to the URL so
  // reloading, sharing, or bookmarking restores the exact drill-down view.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        FILTER_STORAGE_KEY,
        JSON.stringify({ query, methodFilter, minAmount }),
      );
    } catch { /* ignore */ }
  }, [FILTER_STORAGE_KEY, query, methodFilter, minAmount]);

  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (query.trim()) next.set('bd-q', query); else next.delete('bd-q');
        if (methodFilter && methodFilter !== 'all') next.set('bd-method', methodFilter); else next.delete('bd-method');
        if (minAmount && Number(minAmount) > 0) next.set('bd-min', minAmount); else next.delete('bd-min');
        return next;
      },
      { replace: true },
    );
  }, [query, methodFilter, minAmount, setSearchParams]);
  type SortKey = 'when' | 'tenant' | 'method' | 'amount';
  const SORT_KEYS: readonly SortKey[] = ['when', 'tenant', 'method', 'amount'];
  const DEFAULT_SORTS: SortCriterion<SortKey>[] = [{ key: 'when', dir: 'desc' }];
  // Shared across all agents so switching drill-downs preserves the same ordering.
  const sortStorageKey = 'fleet-perf-sort';
  const SORT_URL_KEY = 'breakdown-sort';
  const sortUrlValue = searchParams.get(SORT_URL_KEY);
  const initialSorts = useMemo(() => {
    // URL takes precedence over localStorage so shared/bookmarked links reproduce exactly.
    if (sortUrlValue) return parsePersistedMultiSort<SortKey>(sortUrlValue, SORT_KEYS, 'when', 'desc');
    return parsePersistedMultiSort<SortKey>(readStorage(sortStorageKey), SORT_KEYS, 'when', 'desc');
  }, [sortUrlValue, sortStorageKey]);
  const [sorts, setSorts] = useState<SortCriterion<SortKey>[]>(initialSorts);

  // Persist sort choices to localStorage and the URL whenever they change.
  useEffect(() => {
    writeStorage(sortStorageKey, serializeMultiSort(sorts));
  }, [sortStorageKey, sorts]);

  useEffect(() => {
    const serialized = serializeMultiSort(sorts);
    setSearchParams(
      (prev) => {
        const current = prev.get(SORT_URL_KEY);
        // When sort matches the default, keep the URL clean by removing the parameter.
        if (sortsEqual(sorts, DEFAULT_SORTS)) {
          if (current === null) return prev;
          const next = new URLSearchParams(prev);
          next.delete(SORT_URL_KEY);
          return next;
        }
        if (current === serialized) return prev;
        const next = new URLSearchParams(prev);
        next.set(SORT_URL_KEY, serialized);
        return next;
      },
      { replace: true },
    );
  }, [sorts, setSearchParams, SORT_URL_KEY]);

  const defaultDirFor = (k: SortKey): 'asc' | 'desc' =>
    k === 'amount' || k === 'when' ? 'desc' : 'asc';

  const toggleSort = (k: SortKey, multi: boolean) => {
    setSorts((prev) => {
      const idx = prev.findIndex((s) => s.key === k);
      if (!multi) {
        // Single click: make this the sole sort column (toggle if already sole primary).
        if (prev.length === 1 && prev[0].key === k) {
          return [{ key: k, dir: prev[0].dir === 'asc' ? 'desc' : 'asc' }];
        }
        return [{ key: k, dir: defaultDirFor(k) }];
      }
      // Shift+click cycle: add → flip direction → remove, while preserving priority of other columns.
      if (idx === -1) {
        return [...prev, { key: k, dir: defaultDirFor(k) }];
      }
      const current = prev[idx];
      if (current.dir === defaultDirFor(k)) {
        const next = [...prev];
        next[idx] = { key: k, dir: current.dir === 'asc' ? 'desc' : 'asc' };
        return next;
      }
      return prev.filter((_, i) => i !== idx);
    });
  };

  const resetSort = () => {
    setSorts(DEFAULT_SORTS);
    // Clear persisted sort so future visits start from the default order.
    try { window.localStorage.removeItem(sortStorageKey); } catch { /* ignore */ }
  };

  const methodOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.payment_method) set.add(r.payment_method); });
    return Array.from(set).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = Number(minAmount) || 0;
    return rows.filter((r) => {
      if (methodFilter !== 'all' && (r.payment_method || '') !== methodFilter) return false;
      if (min > 0 && (Number(r.amount) || 0) < min) return false;
      if (q) {
        const tenant = ((r.tenant_id && nameById.get(r.tenant_id)) || '').toLowerCase();
        const hay = `${tenant} ${r.tenant_id || ''} ${r.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, nameById, query, methodFilter, minAmount]);

  const sortedRows = useMemo(() => {
    const arr = [...filteredRows];
    arr.sort((a, b) => {
      for (const s of sorts) {
        const dir = s.dir === 'asc' ? 1 : -1;
        let av: string | number = 0;
        let bv: string | number = 0;
        if (s.key === 'when') { av = new Date(a.created_at).getTime(); bv = new Date(b.created_at).getTime(); }
        else if (s.key === 'amount') { av = Number(a.amount) || 0; bv = Number(b.amount) || 0; }
        else if (s.key === 'method') { av = (a.payment_method || '').toLowerCase(); bv = (b.payment_method || '').toLowerCase(); }
        else if (s.key === 'tenant') {
          av = ((a.tenant_id && nameById.get(a.tenant_id)) || '').toLowerCase();
          bv = ((b.tenant_id && nameById.get(b.tenant_id)) || '').toLowerCase();
        }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
      }
      return 0;
    });
    return arr;
  }, [filteredRows, sorts, nameById]);

  const total = filteredRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const rawTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const reconDelta = rawTotal - (Number(expectedCollected) || 0);
  const reconOk = Math.abs(reconDelta) < 1;

  // Per-method subtotals across the currently filtered rows.
  const methodSubtotals = useMemo(() => {
    const m = new Map<string, { count: number; sum: number }>();
    filteredRows.forEach((r) => {
      const key = r.payment_method || 'unspecified';
      const cur = m.get(key) || { count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += Number(r.amount) || 0;
      m.set(key, cur);
    });
    return Array.from(m.entries())
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.sum - a.sum);
  }, [filteredRows]);
  const filtersActive = query.trim() !== '' || methodFilter !== 'all' || (Number(minAmount) || 0) > 0;
  const clearFilters = () => { setQuery(''); setMethodFilter('all'); setMinAmount(''); };

  // Read-only detail drawer for a single agent_collections row.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) || null,
    [rows, selectedId],
  );
  const selectedTenant = selected?.tenant_id ? nameById.get(selected.tenant_id) || null : null;

  const sortOrderLabel = useMemo(() => {
    if (sorts.length === 0) return 'unsorted';
    return sorts
      .map((s, i) => `${i + 1}. ${s.key} ${s.dir === 'asc' ? '↑' : '↓'}`)
      .join(' · ');
  }, [sorts]);

  const downloadCsv = () => {
    const s = start.toISOString().slice(0, 10);
    const e = new Date(end.getTime() - 1).toISOString().slice(0, 10);
    const min = Number(minAmount) || 0;
    // Metadata preamble so the downloaded CSV self-documents the view it came from.
    const meta: (string | number)[][] = [
      ['Welile — Agent collections export'],
      ['Agent', agentName],
      ['Agent ID', agentId],
      ['Date range (Africa/Kampala)', `${s} to ${e}`],
      ['Search (tenant name/ID)', query.trim() || '(none)'],
      ['Payment method filter', methodFilter === 'all' ? 'All methods' : methodFilter.replace(/_/g, ' ')],
      ['Minimum amount (UGX)', min > 0 ? min : '(none)'],
      ['Sort order', sortOrderLabel],
      ['Rows exported', sortedRows.length],
      ['Total (UGX)', total],
      ['Generated at', new Date().toISOString()],
      [],
    ];
    const header = ['Date (Africa/Kampala)', 'Tenant', 'Tenant ID', 'Amount UGX', 'Payment method', 'Record ID'];
    // Export rows in the same order shown in the sorted drill-down table.
    const body = sortedRows.map((r) => [
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Kampala',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }).format(new Date(r.created_at)),
      (r.tenant_id && nameById.get(r.tenant_id)) || '',
      r.tenant_id || '',
      Number(r.amount) || 0,
      (r.payment_method || '').replace(/_/g, ' '),
      r.id,
    ]);
    const csv = [...meta, header, ...body]
      .map((r) => r.map(csvEscape).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix = filtersActive ? '_filtered' : '';
    a.download = `collections_${agentName.replace(/\s+/g, '_')}_${s}_to_${e}${suffix}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-3 rounded-md border border-border bg-card">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
          <Receipt className="h-3 w-3" /> Underlying records ·{' '}
          {filtersActive ? `${filteredRows.length} of ${rows.length}` : rows.length} ·{' '}
          {formatUGX(total)}
        </p>
        <button
          type="button"
          onClick={downloadCsv}
          disabled={isLoading || sortedRows.length === 0}
          className="h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-muted text-foreground hover:bg-muted/70 transition-colors disabled:opacity-40"
          title={
            filtersActive
              ? `Download CSV of the currently filtered rows in ${sortOrderLabel} order (filters, search and sort recorded in the file)`
              : `Download CSV of all rows in the selected date range, sorted by ${sortOrderLabel}`
          }
        >
          <Download className="h-3 w-3" />
          {filtersActive ? 'CSV (filtered)' : 'CSV'}
        </button>
      </div>
      {!isLoading && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 border-b border-border bg-muted/30">
          <div className="relative flex-1 min-w-[10rem]">
            <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" aria-hidden />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tenant name or ID…"
              className="w-full h-6 pl-6 pr-2 rounded-md border border-border bg-background text-[11px] outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value)}
            className="h-6 rounded-md border border-border bg-background text-[11px] px-1.5"
            aria-label="Filter by payment method"
          >
            <option value="all">All methods</option>
            {methodOptions.map((m) => (
              <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value)}
            placeholder="Min UGX"
            className="h-6 w-[6.5rem] rounded-md border border-border bg-background text-[11px] px-1.5 tabular-nums"
          />
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="h-6 px-1.5 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 text-muted-foreground hover:bg-muted"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>
      )}
      {!isLoading && rows.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-[9px] text-muted-foreground bg-muted/20 border-b border-border">
          <span className="inline-flex items-center gap-1">
            <SlidersHorizontal className="h-2.5 w-2.5" />
            Click a column to sort. Shift+click to add or remove a secondary sort level.
          </span>
          <button
            type="button"
            onClick={resetSort}
            disabled={sortsEqual(sorts, DEFAULT_SORTS)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none transition-colors"
            aria-label="Reset sort to default ordering"
            title="Reset sort to default ordering (newest first)"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Reset sort
          </button>
        </div>
      )}
      {isLoading ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
          No collection records for this range.
        </p>
      ) : filteredRows.length === 0 ? (
        <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
          No records match the current filters.
        </p>
      ) : (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                {([
                  { k: 'when' as const, label: 'When', align: 'left', cls: '' },
                  { k: 'tenant' as const, label: 'Tenant', align: 'left', cls: '' },
                  { k: 'method' as const, label: 'Method', align: 'left', cls: 'hidden sm:table-cell' },
                  { k: 'amount' as const, label: 'Amount', align: 'right', cls: '' },
                ]).map((h) => {
                  const sortIdx = sorts.findIndex((s) => s.key === h.k);
                  const active = sortIdx !== -1;
                  const s = active ? sorts[sortIdx] : null;
                  const priority = active ? sortIdx + 1 : null;
                  const ariaSort = active ? (s?.dir === 'asc' ? 'ascending' : 'descending') : 'none';
                  const ariaLabel = active
                    ? `${h.label} sorted ${s?.dir === 'asc' ? 'ascending' : 'descending'}${sorts.length > 1 ? `, sort priority ${priority}` : ''}. Click to change; Shift+click to add or remove a secondary sort.`
                    : `${h.label}. Click to sort; Shift+click to add or remove a secondary sort.`;
                  const SortIcon = active
                    ? s?.dir === 'asc'
                      ? ArrowUp
                      : ArrowDown
                    : ArrowUpDown;
                  return (
                    <th
                      key={h.k}
                      aria-sort={ariaSort}
                      className={`${h.align === 'right' ? 'text-right' : 'text-left'} font-bold uppercase tracking-wide px-2 py-1.5 text-[9px] ${h.cls}`}
                    >
                      <button
                        type="button"
                        onClick={(e) => toggleSort(h.k, e.shiftKey)}
                        className={`inline-flex items-center gap-1.5 hover:text-foreground transition-colors ${active ? 'text-foreground' : ''}`}
                        aria-label={ariaLabel}
                        title={ariaLabel}
                      >
                        {h.label}
                        <span className={`inline-flex items-center gap-0.5 ${active ? 'opacity-100' : 'opacity-40'}`}>
                          <SortIcon className="h-3 w-3" aria-hidden="true" />
                          {priority !== null && sorts.length > 1 && (
                            <span className="ml-0.5 inline-flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-primary/10 px-1 text-[7px] font-bold tabular-nums">
                              {priority}
                            </span>
                          )}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedRows.map((r) => {
                const when = new Intl.DateTimeFormat('en-GB', {
                  timeZone: 'Africa/Kampala',
                  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
                }).format(new Date(r.created_at));
                const tenant = (r.tenant_id && nameById.get(r.tenant_id)) || 'Unknown tenant';
                return (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className="cursor-pointer hover:bg-primary/5 focus:bg-primary/10 outline-none"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(r.id); }
                    }}
                    title="View record details"
                  >
                    <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{when}</td>
                    <td className="px-2 py-1.5 truncate max-w-[10rem]">{tenant}</td>
                    <td className="px-2 py-1.5 text-muted-foreground hidden sm:table-cell">
                      {(r.payment_method || '—').replace(/_/g, ' ')}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-primary">
                      {formatUGX(Number(r.amount) || 0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="sticky bottom-0 bg-muted/80 backdrop-blur border-t border-border">
              {methodSubtotals.length > 1 && methodSubtotals.map((s) => (
                <tr key={`sub-${s.method}`} className="text-muted-foreground">
                  <td className="px-2 py-1 text-[9px] uppercase tracking-wide" colSpan={2}>
                    Subtotal · {s.method.replace(/_/g, ' ')}
                  </td>
                  <td className="px-2 py-1 text-[10px] tabular-nums hidden sm:table-cell">{s.count}</td>
                  <td className="px-2 py-1 text-right tabular-nums font-semibold">{formatUGX(s.sum)}</td>
                </tr>
              ))}
              <tr className="text-foreground">
                <td className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide" colSpan={2}>
                  {filtersActive ? 'Filtered total' : 'Total'} · {filteredRows.length} row{filteredRows.length === 1 ? '' : 's'}
                </td>
                <td className="px-2 py-1.5 hidden sm:table-cell" />
                <td className="px-2 py-1.5 text-right tabular-nums font-bold text-primary">{formatUGX(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {!isLoading && rows.length > 0 && (
        <div
          className={`flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 border-t text-[10px] ${
            reconOk
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300'
          }`}
          title="Compares the sum of all underlying agent_collections rows in this date range to the 'Collected' figure shown for the agent."
        >
          <span className="font-semibold uppercase tracking-wide">
            {reconOk ? 'Reconciled' : 'Drift'} vs Collected
          </span>
          <span className="tabular-nums">
            Σ records {formatUGX(rawTotal)} · Collected {formatUGX(Number(expectedCollected) || 0)}
            {!reconOk && (
              <>
                {' '}· Δ {reconDelta > 0 ? '+' : ''}{formatUGX(reconDelta)}
              </>
            )}
          </span>
        </div>
      )}
      <Sheet open={!!selected} onOpenChange={(v) => { if (!v) setSelectedId(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="text-base">Collection record</SheetTitle>
                <SheetDescription className="text-[11px]">
                  Read-only view of the underlying <code>agent_collections</code> row.
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-3">
                <DetailStat label="Amount" value={formatUGX(Number(selected.amount) || 0)} accent />
                <DetailStat
                  label="Payment method"
                  value={(selected.payment_method || '—').replace(/_/g, ' ')}
                />
                <DetailStat
                  label="Collected at (Africa/Kampala)"
                  value={new Intl.DateTimeFormat('en-GB', {
                    timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short',
                  }).format(new Date(selected.created_at))}
                />
                <DetailStat
                  label="Collected at (UTC)"
                  value={new Date(selected.created_at).toISOString()}
                  mono
                />
                <DetailStat label="Tenant" value={selectedTenant || 'Unknown tenant'} />
                <DetailStat label="Tenant ID" value={selected.tenant_id || '—'} mono />
                <DetailStat label="Agent" value={agentName} />
                <DetailStat label="Agent ID" value={agentId} mono />
                <DetailStat label="Record ID" value={selected.id} mono />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DetailStat({
  label,
  value,
  mono = false,
  accent = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
      <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 break-all text-[12px] ${accent ? 'font-bold text-primary' : 'text-foreground'} ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </p>
    </div>
  );
}
