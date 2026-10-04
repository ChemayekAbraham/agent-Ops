import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { ACTIVE_RENT_STATUSES } from '@/hooks/useAgentCapacityMap';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ArrowUp, ArrowDown, ArrowUpDown, Loader2, Scale, AlertCircle, Plus, Download, ArrowLeft, ChevronLeft, ChevronRight, ChevronDown, Search, X, Check, Eye, EyeOff, CheckCircle2, FileText, Crosshair } from 'lucide-react';
import { generateBucketReconDetailPdf } from '@/lib/bucketReconDetailPdf';
import { toast } from 'sonner';
import {
  matchTimelineShortcut,
  useTimelineShortcuts,
  formatShortcutKey,
} from '@/lib/timelineShortcutPrefs';
import { TimelineShortcutSettingsButton } from '@/components/executive/TimelineShortcutSettings';

// In-memory session stores for detail-view page size + scroll position.
// Survive tab switches, filter changes, and re-open of the same row within the session.
const detailPageSizeStore = new Map<string, number>();
const detailScrollStore = new Map<string, number>();
// User-selected "rows per page" per detail table (survives tab switches / filter changes).
const detailPageSizePrefStore = new Map<string, number>();
const DETAIL_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

function usePageSizePref(stateKey: string | undefined, fallback: number) {
  const [size, setSizeState] = useState<number>(() =>
    (stateKey && detailPageSizePrefStore.get(stateKey)) || fallback,
  );
  useEffect(() => {
    if (!stateKey) return;
    const saved = detailPageSizePrefStore.get(stateKey);
    setSizeState(saved && saved > 0 ? saved : fallback);
  }, [stateKey, fallback]);
  const setSize = (v: number) => {
    setSizeState(v);
    if (stateKey) detailPageSizePrefStore.set(stateKey, v);
  };
  return [size, setSize] as const;
}

function PageSizeSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      Rows
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-6 px-1 rounded-md text-[10px] font-semibold bg-background border border-border hover:bg-muted cursor-pointer"
        title="Rows per page"
      >
        {DETAIL_PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * Virtualized list rendered as a CSS grid so column widths align between the
 * sticky header row and the virtualized body rows. Keeps DOM node count low
 * (~15-30 row divs) regardless of `items.length`, so scrolling stays fast even
 * with tens of thousands of rows.
 */
function VirtualRows<T extends { id: string }>({
  items,
  rowHeight,
  gridTemplate,
  header,
  renderRow,
  emptyMessage,
  maxHeight = 480,
  scrollToIndex,
  scrollToDepKey,
}: {
  items: T[];
  rowHeight: number;
  gridTemplate: string;
  header: React.ReactNode;
  renderRow: (item: T, index: number) => React.ReactNode;
  emptyMessage?: string;
  maxHeight?: number;
  scrollToIndex?: number;
  scrollToDepKey?: string;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    getItemKey: (i) => items[i]?.id ?? i,
  });
  useEffect(() => {
    if (typeof scrollToIndex === 'number' && scrollToIndex >= 0 && scrollToIndex < items.length) {
      // Center the target row on next paint so layout has settled.
      requestAnimationFrame(() => virtualizer.scrollToIndex(scrollToIndex, { align: 'center' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToDepKey]);

  const totalSize = virtualizer.getTotalSize();
  const virtualRows = virtualizer.getVirtualItems();
  // Fit-to-content when list is short; otherwise cap at maxHeight and scroll.
  const bodyMaxHeight = Math.min(maxHeight, Math.max(rowHeight, totalSize));

  return (
    <div className="border border-border rounded-md overflow-hidden text-[11px]">
      <div
        className="bg-muted text-muted-foreground text-[9px] uppercase tracking-wide grid"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {header}
      </div>
      {items.length === 0 ? (
        <div className="px-2 py-3 text-center text-[11px] text-muted-foreground italic">
          {emptyMessage ?? 'No rows.'}
        </div>
      ) : (
        <div
          ref={parentRef}
          className="overflow-auto"
          style={{ maxHeight: bodyMaxHeight, contain: 'strict' }}
        >
          <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {virtualRows.map((v) => {
              const item = items[v.index];
              if (!item) return null;
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  className="grid border-b border-border last:border-b-0"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${v.start}px)`,
                    height: v.size,
                    gridTemplateColumns: gridTemplate,
                  }}
                >
                  {renderRow(item, v.index)}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
// Reviewed-status persistence — separate namespaces for Missing (plan ids) and Extra (collection ids).
const REVIEWED_LS_KEY = 'welile:recon-reviewed:v1';
type ReviewedStore = { missing: Record<string, number>; extra: Record<string, number> };
function readReviewedStore(): ReviewedStore {
  if (typeof window === 'undefined') return { missing: {}, extra: {} };
  try {
    const raw = window.localStorage.getItem(REVIEWED_LS_KEY);
    if (!raw) return { missing: {}, extra: {} };
    const parsed = JSON.parse(raw);
    return {
      missing: (parsed?.missing && typeof parsed.missing === 'object') ? parsed.missing : {},
      extra: (parsed?.extra && typeof parsed.extra === 'object') ? parsed.extra : {},
    };
  } catch {
    return { missing: {}, extra: {} };
  }
}
function writeReviewedStore(s: ReviewedStore) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(REVIEWED_LS_KEY, JSON.stringify(s)); } catch { /* quota — ignore */ }
}
function useReviewedSet(kind: 'missing' | 'extra'): {
  reviewed: Record<string, number>;
  isReviewed: (id: string) => boolean;
  toggle: (id: string) => void;
  clear: () => void;
} {
  const [reviewed, setReviewed] = useState<Record<string, number>>(() => readReviewedStore()[kind]);
  // Sync across tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== REVIEWED_LS_KEY) return;
      setReviewed(readReviewedStore()[kind]);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [kind]);
  const persist = useCallback((next: Record<string, number>) => {
    setReviewed(next);
    const store = readReviewedStore();
    store[kind] = next;
    writeReviewedStore(store);
  }, [kind]);
  const toggle = useCallback((id: string) => {
    const next = { ...reviewed };
    if (next[id]) delete next[id]; else next[id] = Date.now();
    persist(next);
  }, [reviewed, persist]);
  const isReviewed = useCallback((id: string) => Boolean(reviewed[id]), [reviewed]);
  const clear = useCallback(() => persist({}), [persist]);
  return { reviewed, isReviewed, toggle, clear };
}

type ActiveRent = {
  id: string;
  tenant_id: string | null;
  agent_id: string | null;
  daily_repayment: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  status: string | null;
};

type BucketCollection = {
  id: string;
  amount: number;
  created_at: string;
  agent_id: string | null;
  tenant_id: string | null;
  payment_method: string | null;
  rent_request_id: string | null;
};

async function fetchActiveRents(agentId?: string | null): Promise<ActiveRent[]> {
  const all: ActiveRent[] = [];
  const PAGE = 1000;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase
      .from('rent_requests')
      .select('id, tenant_id, agent_id, daily_repayment, total_repayment, amount_repaid, status')
      .in('status', ACTIVE_RENT_STATUSES)
      .not('agent_id', 'is', null)
      .gt('daily_repayment', 0)
      .range(from, from + PAGE - 1);
    if (agentId) q = q.eq('agent_id', agentId);
    const { data, error } = await q;
    if (error) { console.error('[Reconcile] rents page failed', error); break; }
    const rows = (data || []) as ActiveRent[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchBucketCollections(opts: { start: Date; end: Date; agentId?: string | null }): Promise<BucketCollection[]> {
  const all: BucketCollection[] = [];
  const PAGE = 1000;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase
      .from('agent_collections')
      .select('id, amount, created_at, agent_id, tenant_id, payment_method, rent_request_id').is('reversed_at', null)
      .gte('created_at', opts.start.toISOString())
      .lt('created_at', opts.end.toISOString())
      .gt('amount', 0)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (opts.agentId) q = q.eq('agent_id', opts.agentId);
    const { data, error } = await q;
    if (error) { console.error('[Reconcile] collections page failed', error); break; }
    const rows = (data || []) as BucketCollection[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const BATCH = 100;
  for (let i = 0; i < unique.length; i += BATCH) {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', unique.slice(i, i + BATCH));
    (data || []).forEach((p: { id: string; full_name?: string | null; phone?: string | null }) => {
      map.set(p.id, p.full_name || p.phone || p.id.slice(0, 8));
    });
  }
  return map;
}

type MissingRow = {
  rent_id: string;
  tenant_id: string | null;
  agent_id: string | null;
  daily: number;
  collected: number;
  variance: number;
  remaining_before: number;
};

type ExtraRow = {
  collection_id: string;
  when_ms: number;
  amount: number;
  extra_amount: number;
  agent_id: string | null;
  tenant_id: string | null;
  rent_request_id: string | null;
  method: string | null;
  reason: 'no_plan_link' | 'inactive_plan' | 'over_daily' | 'over_remaining';
  reason_label: string;
};

type MSort = 'variance' | 'daily' | 'collected' | 'tenant' | 'agent' | 'remaining';
type ESort = 'when' | 'amount' | 'extra' | 'tenant' | 'agent' | 'reason';

const REASON_LABELS: Record<ExtraRow['reason'], string> = {
  no_plan_link: 'Not linked to any rent plan',
  inactive_plan: 'Linked plan is closed / inactive',
  over_daily: 'Exceeds plan daily repayment',
  over_remaining: 'Exceeds plan remaining balance',
};

const fmtWhen = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

export function BucketReconciliationPanel({
  open,
  onOpenChange,
  start,
  end,
  agentId,
  agentName,
  bucketLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  start: Date;
  end: Date;
  agentId?: string | null;
  agentName?: string | null;
  bucketLabel?: string | null;
}) {
  const rangeKey = `${start.toISOString()}:${end.toISOString()}:${agentId || 'all'}`;

  const { data: rents = [], isLoading: rLoading } = useQuery({
    queryKey: ['recon-rents', agentId || 'all'],
    queryFn: () => fetchActiveRents(agentId),
    enabled: open,
    staleTime: 30_000,
  });
  const { data: collections = [], isLoading: cLoading } = useQuery({
    queryKey: ['recon-collections', rangeKey],
    queryFn: () => fetchBucketCollections({ start, end, agentId }),
    enabled: open,
    staleTime: 30_000,
  });

  const rentById = useMemo(() => {
    const m = new Map<string, ActiveRent>();
    for (const r of rents) m.set(r.id, r);
    return m;
  }, [rents]);

  // Bucket duration in days (min 1/24 for hour buckets, 1 for day buckets).
  const bucketDays = useMemo(() => {
    const ms = end.getTime() - start.getTime();
    return Math.max(1 / 48, ms / 86_400_000);
  }, [start, end]);

  // Sum collections per plan (for planned matches).
  const collectedByPlan = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of collections) {
      if (!c.rent_request_id) continue;
      m.set(c.rent_request_id, (m.get(c.rent_request_id) || 0) + (Number(c.amount) || 0));
    }
    return m;
  }, [collections]);

  const nameIds = useMemo(() => {
    const s = new Set<string>();
    rents.forEach((r) => { if (r.tenant_id) s.add(r.tenant_id); if (r.agent_id) s.add(r.agent_id); });
    collections.forEach((c) => { if (c.tenant_id) s.add(c.tenant_id); if (c.agent_id) s.add(c.agent_id); });
    return Array.from(s);
  }, [rents, collections]);
  const { data: names } = useQuery({
    queryKey: ['recon-names', rangeKey, nameIds.length],
    queryFn: () => fetchNames(nameIds),
    enabled: open && nameIds.length > 0,
    staleTime: 5 * 60_000,
  });
  const nameById = names || new Map<string, string>();

  // MISSING rows: active rents where collected in bucket < expected for bucket.
  const missingAll = useMemo<MissingRow[]>(() => {
    const out: MissingRow[] = [];
    for (const r of rents) {
      const daily = Number(r.daily_repayment) || 0;
      if (daily <= 0) continue;
      const totalDue = Number(r.total_repayment) || 0;
      const paidBefore = Number(r.amount_repaid) || 0;
      const remaining = Math.max(0, totalDue - paidBefore);
      if (remaining <= 0) continue;
      const expected = Math.min(remaining, daily * bucketDays);
      const collected = collectedByPlan.get(r.id) || 0;
      if (collected + 1 >= expected) continue; // fully covered (1 UGX rounding buffer)
      out.push({
        rent_id: r.id,
        tenant_id: r.tenant_id,
        agent_id: r.agent_id,
        daily: expected,
        collected,
        variance: expected - collected,
        remaining_before: remaining,
      });
    }
    return out;
  }, [rents, collectedByPlan, bucketDays]);

  // EXTRA rows: collections that don't map cleanly to an expected daily obligation.
  const extraAll = useMemo<ExtraRow[]>(() => {
    const out: ExtraRow[] = [];
    // Track cumulative collected per plan across the bucket (chronological).
    const cumByPlan = new Map<string, number>();
    // Iterate oldest first so cumulative math is right.
    const chrono = [...collections].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (const c of chrono) {
      const amt = Number(c.amount) || 0;
      const whenMs = new Date(c.created_at).getTime();
      const base = {
        collection_id: c.id,
        when_ms: whenMs,
        amount: amt,
        agent_id: c.agent_id,
        tenant_id: c.tenant_id,
        rent_request_id: c.rent_request_id,
        method: c.payment_method,
      };
      if (!c.rent_request_id) {
        out.push({ ...base, extra_amount: amt, reason: 'no_plan_link', reason_label: REASON_LABELS.no_plan_link });
        continue;
      }
      const plan = rentById.get(c.rent_request_id);
      if (!plan) {
        out.push({ ...base, extra_amount: amt, reason: 'inactive_plan', reason_label: REASON_LABELS.inactive_plan });
        continue;
      }
      const daily = Number(plan.daily_repayment) || 0;
      const remaining = Math.max(0, (Number(plan.total_repayment) || 0) - (Number(plan.amount_repaid) || 0));
      const expected = Math.min(remaining, daily * bucketDays);
      const already = cumByPlan.get(c.rent_request_id) || 0;
      const overDaily = Math.max(0, (already + amt) - expected);
      const overRemaining = Math.max(0, (already + amt) - remaining);
      cumByPlan.set(c.rent_request_id, already + amt);
      if (overRemaining > 0) {
        out.push({ ...base, extra_amount: overRemaining, reason: 'over_remaining', reason_label: REASON_LABELS.over_remaining });
      } else if (overDaily > 0) {
        out.push({ ...base, extra_amount: overDaily, reason: 'over_daily', reason_label: REASON_LABELS.over_daily });
      }
    }
    return out;
  }, [collections, rentById, bucketDays]);

  const totalExpected = useMemo(() => {
    let sum = 0;
    for (const r of rents) {
      const daily = Number(r.daily_repayment) || 0;
      if (daily <= 0) continue;
      const remaining = Math.max(0, (Number(r.total_repayment) || 0) - (Number(r.amount_repaid) || 0));
      if (remaining <= 0) continue;
      sum += Math.min(remaining, daily * bucketDays);
    }
    return sum;
  }, [rents, bucketDays]);
  const totalCollected = useMemo(() => collections.reduce((s, c) => s + (Number(c.amount) || 0), 0), [collections]);
  const missingTotal = missingAll.reduce((s, r) => s + r.variance, 0);
  const extraTotal = extraAll.reduce((s, r) => s + r.extra_amount, 0);
  const rate = totalExpected > 0 ? totalCollected / totalExpected : 0;

  // Sort state.
  const [tab, setTab] = useState<'missing' | 'extra'>('missing');
  const [selection, setSelection] = useState<{ kind: 'missing'; rentId: string } | { kind: 'extra'; collectionId: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Key identifies which view's scroll position we are saving/restoring.
  const scrollKey = useMemo(() => {
    if (!selection) return `list:${tab}`;
    return selection.kind === 'missing' ? `missing:${selection.rentId}` : `extra:${selection.collectionId}`;
  }, [selection, tab]);
  // Restore scroll position whenever the visible view changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = detailScrollStore.get(scrollKey) ?? 0;
    el.scrollTop = saved;
  }, [scrollKey]);

  // Reviewed-status tracking (persisted in localStorage; separate per kind).
  const missingReviewed = useReviewedSet('missing');
  const extraReviewed = useReviewedSet('extra');
  const [hideReviewed, setHideReviewed] = useState(false);

  // Close selection when switching tabs / bucket.
  const switchTab = (t: 'missing' | 'extra') => { setTab(t); setSelection(null); };

  // Chronological collections (used for detail views).
  const chrono = useMemo(
    () => [...collections].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [collections],
  );

  // Build the detail payload for the currently selected row.
  const detail = useMemo(() => {
    if (!selection) return null;
    const nameOf = (id: string | null) => (id && nameById.get(id)) || '';
    if (selection.kind === 'missing') {
      const m = missingAll.find((r) => r.rent_id === selection.rentId);
      if (!m) return null;
      const plan = rentById.get(m.rent_id);
      const dailyPlan = Number(plan?.daily_repayment) || 0;
      const totalDue = Number(plan?.total_repayment) || 0;
      const paidBefore = Number(plan?.amount_repaid) || 0;
      const remaining = Math.max(0, totalDue - paidBefore);
      const planCollections = chrono.filter((c) => c.rent_request_id === m.rent_id);
      const tenantOtherCollections = chrono.filter((c) => c.tenant_id && plan?.tenant_id && c.tenant_id === plan.tenant_id && c.rent_request_id !== m.rent_id);
      return { kind: 'missing' as const, m, plan, dailyPlan, totalDue, paidBefore, remaining, planCollections, tenantOtherCollections, nameOf };
    }
    const c = extraAll.find((r) => r.collection_id === selection.collectionId);
    if (!c) return null;
    const plan = c.rent_request_id ? rentById.get(c.rent_request_id) : undefined;
    const dailyPlan = Number(plan?.daily_repayment) || 0;
    const totalDue = Number(plan?.total_repayment) || 0;
    const paidBefore = Number(plan?.amount_repaid) || 0;
    const remaining = Math.max(0, totalDue - paidBefore);
    const expected = plan ? Math.min(remaining, dailyPlan * bucketDays) : 0;
    const timeline = plan
      ? chrono
          .filter((x) => x.rent_request_id === c.rent_request_id)
          .reduce<{ id: string; when: number; amount: number; cumulative: number; over_daily: number; over_remaining: number; isThis: boolean }[]>((acc, x) => {
            const prev = acc.length ? acc[acc.length - 1].cumulative : 0;
            const cumulative = prev + (Number(x.amount) || 0);
            acc.push({
              id: x.id,
              when: new Date(x.created_at).getTime(),
              amount: Number(x.amount) || 0,
              cumulative,
              over_daily: Math.max(0, cumulative - expected),
              over_remaining: Math.max(0, cumulative - remaining),
              isThis: x.id === c.collection_id,
            });
            return acc;
          }, [])
      : [];
    return { kind: 'extra' as const, c, plan, dailyPlan, totalDue, paidBefore, remaining, expected, timeline, nameOf };
  }, [selection, missingAll, extraAll, rentById, chrono, bucketDays, nameById]);
  const [mSort, setMSort] = useState<{ k: MSort; dir: 'asc' | 'desc' }>({ k: 'variance', dir: 'desc' });
  const [eSort, setESort] = useState<{ k: ESort; dir: 'asc' | 'desc' }>({ k: 'extra', dir: 'desc' });

  const missing = useMemo(() => {
    const dir = mSort.dir === 'asc' ? 1 : -1;
    const nameOf = (id: string | null) => (id && nameById.get(id)) || '';
    return [...missingAll].sort((a, b) => {
      let av: string | number = 0; let bv: string | number = 0;
      switch (mSort.k) {
        case 'variance': av = a.variance; bv = b.variance; break;
        case 'daily': av = a.daily; bv = b.daily; break;
        case 'collected': av = a.collected; bv = b.collected; break;
        case 'remaining': av = a.remaining_before; bv = b.remaining_before; break;
        case 'tenant': av = nameOf(a.tenant_id).toLowerCase(); bv = nameOf(b.tenant_id).toLowerCase(); break;
        case 'agent': av = nameOf(a.agent_id).toLowerCase(); bv = nameOf(b.agent_id).toLowerCase(); break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [missingAll, mSort, nameById]);

  const extras = useMemo(() => {
    const dir = eSort.dir === 'asc' ? 1 : -1;
    const nameOf = (id: string | null) => (id && nameById.get(id)) || '';
    return [...extraAll].sort((a, b) => {
      let av: string | number = 0; let bv: string | number = 0;
      switch (eSort.k) {
        case 'when': av = a.when_ms; bv = b.when_ms; break;
        case 'amount': av = a.amount; bv = b.amount; break;
        case 'extra': av = a.extra_amount; bv = b.extra_amount; break;
        case 'reason': av = a.reason; bv = b.reason; break;
        case 'tenant': av = nameOf(a.tenant_id).toLowerCase(); bv = nameOf(b.tenant_id).toLowerCase(); break;
        case 'agent': av = nameOf(a.agent_id).toLowerCase(); bv = nameOf(b.agent_id).toLowerCase(); break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [extraAll, eSort, nameById]);

  const toggleM = (k: MSort) => setMSort((s) => (s.k === k ? { k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { k, dir: 'desc' }));
  const toggleE = (k: ESort) => setESort((s) => (s.k === k ? { k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { k, dir: k === 'when' || k === 'amount' || k === 'extra' ? 'desc' : 'asc' }));
  const MI = ({ k }: { k: MSort }) => (mSort.k !== k ? <ArrowUpDown className="h-3 w-3 opacity-40" /> : mSort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />);
  const EI = ({ k }: { k: ESort }) => (eSort.k !== k ? <ArrowUpDown className="h-3 w-3 opacity-40" /> : eSort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />);

  const csvEscape = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const downloadCsv = () => {
    const nameOf = (id: string | null) => (id && nameById.get(id)) || '';
    const rows: (string | number)[][] = [];
    rows.push(['section', 'when_eat', 'tenant', 'tenant_id', 'agent', 'agent_id', 'rent_request_id', 'expected_ugx', 'collected_ugx', 'variance_ugx', 'method', 'reason']);
    for (const r of missing) rows.push(['missing', '', nameOf(r.tenant_id), r.tenant_id || '', nameOf(r.agent_id), r.agent_id || '', r.rent_id, Math.round(r.daily), Math.round(r.collected), Math.round(r.variance), '', 'underpaid_or_no_payment']);
    for (const r of extras) rows.push(['extra', fmtWhen(r.when_ms), nameOf(r.tenant_id), r.tenant_id || '', nameOf(r.agent_id), r.agent_id || '', r.rent_request_id || '', 0, Math.round(r.amount), Math.round(r.extra_amount), r.method || '', r.reason]);
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconciliation_${start.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loading = rLoading || cLoading;
  const bucketWhen = `${fmtWhen(start.getTime())} → ${fmtWhen(end.getTime())} EAT`;
  const scopeLabel = agentId ? `${agentName || 'Agent'} · ${bucketLabel || bucketWhen}` : (bucketLabel || bucketWhen);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[95vw] max-h-[92vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="p-4 pb-2 border-b border-border">
          <DialogTitle className="text-base inline-flex items-center gap-2">
            <Scale className="h-4 w-4" /> Bucket reconciliation
          </DialogTitle>
          <DialogDescription className="text-[11px]">{scopeLabel}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-4 pb-2 border-b border-border">
              <SummaryCard label="Expected" value={formatUGX(totalExpected)} accent="violet" />
              <SummaryCard label="Collected" value={formatUGX(totalCollected)} accent="primary" />
              <SummaryCard label="Missing" value={formatUGX(missingTotal)} sub={`${missingAll.length} plan${missingAll.length === 1 ? '' : 's'}`} accent="rose" />
              <SummaryCard label="Extra" value={formatUGX(extraTotal)} sub={`${extraAll.length} row${extraAll.length === 1 ? '' : 's'}`} accent="amber" />
            </div>

            <div className="px-4 py-2 border-b border-border flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">Fulfilment rate</span>
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div className={`h-full ${rate >= 0.9 ? 'bg-emerald-500' : rate >= 0.6 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${Math.min(100, rate * 100)}%` }} />
              </div>
              <span className="text-[11px] font-bold tabular-nums">{(rate * 100).toFixed(1)}%</span>
              <button
                type="button"
                onClick={downloadCsv}
                disabled={missingAll.length === 0 && extraAll.length === 0}
                className="h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-background border border-border hover:bg-muted disabled:opacity-40"
              >
                <Download className="h-3 w-3" /> CSV
              </button>
            </div>

            <div className="px-4 pt-2 border-b border-border flex items-center gap-1.5">
              <TabBtn active={tab === 'missing'} onClick={() => switchTab('missing')} icon={<AlertCircle className="h-3 w-3" />} label={`Missing (${missingAll.length})`} tone="rose" />
              <TabBtn active={tab === 'extra'} onClick={() => switchTab('extra')} icon={<Plus className="h-3 w-3" />} label={`Extra (${extraAll.length})`} tone="amber" />
              {(() => {
                const reviewedCount = tab === 'missing'
                  ? missing.filter((r) => missingReviewed.isReviewed(r.rent_id)).length
                  : extras.filter((r) => extraReviewed.isReviewed(r.collection_id)).length;
                const total = tab === 'missing' ? missing.length : extras.length;
                return (
                  <div className="ml-2 flex items-center gap-1.5">
                    <span
                      className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-800 border border-emerald-500/20"
                      title="Rows you have marked as reviewed in this tab"
                    >
                      <CheckCircle2 className="h-3 w-3" /> {reviewedCount}/{total} reviewed
                    </span>
                    <button
                      type="button"
                      onClick={() => setHideReviewed((v) => !v)}
                      className={`h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 border ${hideReviewed ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-background border-border hover:bg-muted'}`}
                      title={hideReviewed ? 'Currently hiding reviewed rows — click to show them again' : 'Hide rows already marked as reviewed'}
                    >
                      {hideReviewed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      {hideReviewed ? 'Reviewed hidden' : 'Hide reviewed'}
                    </button>
                  </div>
                );
              })()}
              {selection && (
                <button
                  type="button"
                  onClick={() => setSelection(null)}
                  className="ml-auto h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-background border border-border hover:bg-muted"
                >
                  <ArrowLeft className="h-3 w-3" /> Back to list
                </button>
              )}
            </div>

            <div
              ref={scrollRef}
              className="flex-1 overflow-auto"
              onScroll={(e) => { detailScrollStore.set(scrollKey, (e.target as HTMLDivElement).scrollTop); }}
            >
              {selection && detail ? (
                <ReconDetailView
                  detail={detail}
                  bucketDays={bucketDays}
                  bucketLabel={scopeLabel}
                  onOpenAnother={(sel) => setSelection(sel)}
                  isReviewed={
                    detail.kind === 'missing'
                      ? missingReviewed.isReviewed(detail.m.rent_id)
                      : extraReviewed.isReviewed(detail.c.collection_id)
                  }
                  onToggleReviewed={() =>
                    detail.kind === 'missing'
                      ? missingReviewed.toggle(detail.m.rent_id)
                      : extraReviewed.toggle(detail.c.collection_id)
                  }
                />
              ) : tab === 'missing' ? (
                (() => {
                  const missingVisible = hideReviewed
                    ? missing.filter((r) => !missingReviewed.isReviewed(r.rent_id))
                    : missing;
                  const visibleMissingTotal = missingVisible.reduce((s, r) => s + r.variance, 0);
                  return missing.length === 0 ? (
                  <p className="p-6 text-center text-[11px] text-muted-foreground">No underpayments — every active plan met its expected obligation in this bucket. 🎯</p>
                ) : missingVisible.length === 0 ? (
                  <p className="p-6 text-center text-[11px] text-muted-foreground">All {missing.length} underpaid plan{missing.length === 1 ? '' : 's'} in this bucket are marked as reviewed. Toggle “Reviewed hidden” to see them again.</p>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-muted text-muted-foreground z-10">
                      <tr>
                        <th className="w-8 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide" title="Reviewed">✓</th>
                        <TH onClick={() => toggleM('tenant')} align="left"><span className="inline-flex items-center gap-1">Tenant <MI k="tenant" /></span></TH>
                        <TH onClick={() => toggleM('agent')} align="left" hideMd><span className="inline-flex items-center gap-1">Agent <MI k="agent" /></span></TH>
                        <TH onClick={() => toggleM('daily')} align="right"><span className="inline-flex items-center gap-1 justify-end w-full">Expected <MI k="daily" /></span></TH>
                        <TH onClick={() => toggleM('collected')} align="right"><span className="inline-flex items-center gap-1 justify-end w-full">Collected <MI k="collected" /></span></TH>
                        <TH onClick={() => toggleM('variance')} align="right"><span className="inline-flex items-center gap-1 justify-end w-full">Variance <MI k="variance" /></span></TH>
                        <TH onClick={() => toggleM('remaining')} align="right" hideMd><span className="inline-flex items-center gap-1 justify-end w-full">Remaining <MI k="remaining" /></span></TH>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {missingVisible.map((r) => {
                        const reviewed = missingReviewed.isReviewed(r.rent_id);
                        return (
                        <tr
                          key={r.rent_id}
                          className={`hover:bg-rose-500/5 cursor-pointer ${reviewed ? 'bg-emerald-500/[0.04] text-muted-foreground line-through decoration-emerald-600/40' : ''}`}
                          onClick={() => setSelection({ kind: 'missing', rentId: r.rent_id })}
                          title="Open variance breakdown"
                        >
                          <td className="px-2 py-1.5 align-middle" onClick={(e) => { e.stopPropagation(); missingReviewed.toggle(r.rent_id); }}>
                            <button
                              type="button"
                              className={`h-4 w-4 inline-flex items-center justify-center rounded border ${reviewed ? 'bg-emerald-600 border-emerald-700 text-white' : 'bg-background border-border hover:border-emerald-500'}`}
                              title={reviewed ? 'Reviewed — click to unmark' : 'Mark as reviewed'}
                              aria-pressed={reviewed}
                            >
                              {reviewed && <Check className="h-3 w-3" />}
                            </button>
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="font-semibold text-foreground truncate max-w-[14rem] inline-flex items-center gap-1">
                              {(r.tenant_id && nameById.get(r.tenant_id)) || '(no tenant)'}
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            </div>
                            {r.tenant_id && <div className="text-[9px] font-mono text-muted-foreground">{r.tenant_id.slice(0, 8)} · plan {r.rent_id.slice(0, 8)}</div>}
                          </td>
                          <td className="px-2 py-1.5 hidden md:table-cell truncate max-w-[10rem]">{(r.agent_id && nameById.get(r.agent_id)) || '—'}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatUGX(Math.round(r.daily))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatUGX(Math.round(r.collected))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-bold text-rose-700">−{formatUGX(Math.round(r.variance))}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground hidden md:table-cell">{formatUGX(Math.round(r.remaining_before))}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="sticky bottom-0 bg-muted/80 backdrop-blur border-t border-border">
                      <tr>
                        <td className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide" colSpan={3}>
                          {hideReviewed ? `Missing total (visible ${missingVisible.length}/${missing.length})` : 'Missing total'}
                        </td>
                        <td />
                        <td />
                        <td className="px-2 py-1.5 text-right tabular-nums font-bold text-rose-700">
                          −{formatUGX(Math.round(hideReviewed ? visibleMissingTotal : missingTotal))}
                        </td>
                        <td className="hidden md:table-cell" />
                      </tr>
                    </tfoot>
                  </table>
                );
                })()
              ) : (
                (() => {
                  const extrasVisible = hideReviewed
                    ? extras.filter((r) => !extraReviewed.isReviewed(r.collection_id))
                    : extras;
                  const visibleExtraTotal = extrasVisible.reduce((s, r) => s + r.extra_amount, 0);
                  return extras.length === 0 ? (
                  <p className="p-6 text-center text-[11px] text-muted-foreground">No extras — every collection in this bucket maps cleanly to an active plan's expected daily amount. ✅</p>
                ) : extrasVisible.length === 0 ? (
                  <p className="p-6 text-center text-[11px] text-muted-foreground">All {extras.length} extra collection{extras.length === 1 ? '' : 's'} in this bucket are marked as reviewed. Toggle “Reviewed hidden” to see them again.</p>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-muted text-muted-foreground z-10">
                      <tr>
                        <th className="w-8 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide" title="Reviewed">✓</th>
                        <TH onClick={() => toggleE('when')} align="left"><span className="inline-flex items-center gap-1">When <EI k="when" /></span></TH>
                        <TH onClick={() => toggleE('tenant')} align="left"><span className="inline-flex items-center gap-1">Tenant <EI k="tenant" /></span></TH>
                        <TH onClick={() => toggleE('agent')} align="left" hideMd><span className="inline-flex items-center gap-1">Agent <EI k="agent" /></span></TH>
                        <TH onClick={() => toggleE('amount')} align="right"><span className="inline-flex items-center gap-1 justify-end w-full">Amount <EI k="amount" /></span></TH>
                        <TH onClick={() => toggleE('extra')} align="right"><span className="inline-flex items-center gap-1 justify-end w-full">Extra <EI k="extra" /></span></TH>
                        <TH onClick={() => toggleE('reason')} align="left"><span className="inline-flex items-center gap-1">Reason <EI k="reason" /></span></TH>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {extrasVisible.map((r) => {
                        const reviewed = extraReviewed.isReviewed(r.collection_id);
                        return (
                        <tr
                          key={r.collection_id}
                          className={`hover:bg-amber-500/5 cursor-pointer ${reviewed ? 'bg-emerald-500/[0.04] text-muted-foreground line-through decoration-emerald-600/40' : ''}`}
                          onClick={() => setSelection({ kind: 'extra', collectionId: r.collection_id })}
                          title="Open extra-collection breakdown"
                        >
                          <td className="px-2 py-1.5 align-middle" onClick={(e) => { e.stopPropagation(); extraReviewed.toggle(r.collection_id); }}>
                            <button
                              type="button"
                              className={`h-4 w-4 inline-flex items-center justify-center rounded border ${reviewed ? 'bg-emerald-600 border-emerald-700 text-white' : 'bg-background border-border hover:border-emerald-500'}`}
                              title={reviewed ? 'Reviewed — click to unmark' : 'Mark as reviewed'}
                              aria-pressed={reviewed}
                            >
                              {reviewed && <Check className="h-3 w-3" />}
                            </button>
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground">{fmtWhen(r.when_ms)}</td>
                          <td className="px-2 py-1.5">
                            <div className="font-semibold text-foreground truncate max-w-[12rem] inline-flex items-center gap-1">
                              {(r.tenant_id && nameById.get(r.tenant_id)) || '(no tenant)'}
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            </div>
                            {r.rent_request_id && <div className="text-[9px] font-mono text-muted-foreground">plan {r.rent_request_id.slice(0, 8)}</div>}
                          </td>
                          <td className="px-2 py-1.5 hidden md:table-cell truncate max-w-[10rem]">{(r.agent_id && nameById.get(r.agent_id)) || '—'}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatUGX(r.amount)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-bold text-amber-700">+{formatUGX(Math.round(r.extra_amount))}</td>
                          <td className="px-2 py-1.5">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-800 text-[9px] font-semibold">{r.reason_label}</span>
                            {r.method && <span className="ml-1 text-[9px] text-muted-foreground">· {r.method.replace(/_/g, ' ')}</span>}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="sticky bottom-0 bg-muted/80 backdrop-blur border-t border-border">
                      <tr>
                        <td className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide" colSpan={4}>
                          {hideReviewed ? `Extra total (visible ${extrasVisible.length}/${extras.length})` : 'Extra total'}
                        </td>
                        <td />
                        <td className="px-2 py-1.5 text-right tabular-nums font-bold text-amber-700">
                          +{formatUGX(Math.round(hideReviewed ? visibleExtraTotal : extraTotal))}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                );
                })()
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: 'violet' | 'primary' | 'rose' | 'amber' }) {
  const color = accent === 'violet' ? 'text-violet-700' : accent === 'primary' ? 'text-primary' : accent === 'rose' ? 'text-rose-700' : 'text-amber-700';
  return (
    <div className="rounded-lg border border-border bg-background p-2">
      <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function TH({ children, onClick, align, hideMd }: { children: React.ReactNode; onClick: () => void; align: 'left' | 'right'; hideMd?: boolean }) {
  return (
    <th
      className={`${align === 'right' ? 'text-right' : 'text-left'} font-bold uppercase tracking-wide px-2 py-1.5 text-[9px] ${hideMd ? 'hidden md:table-cell' : ''}`}
    >
      <button type="button" onClick={onClick} className="hover:text-foreground transition-colors">{children}</button>
    </th>
  );
}

function TabBtn({ active, onClick, icon, label, tone }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; tone: 'rose' | 'amber' }) {
  const activeClass = tone === 'rose' ? 'bg-rose-500/10 text-rose-800 border-rose-500/40' : 'bg-amber-500/10 text-amber-800 border-amber-500/40';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 px-2 rounded-t-md text-[10px] font-semibold inline-flex items-center gap-1 border-b-0 border ${active ? activeClass : 'bg-transparent text-muted-foreground border-transparent hover:text-foreground'}`}
    >
      {icon}{label}
    </button>
  );
}

type DetailPayload =
  | {
      kind: 'missing';
      m: MissingRow;
      plan: ActiveRent | undefined;
      dailyPlan: number;
      totalDue: number;
      paidBefore: number;
      remaining: number;
      planCollections: BucketCollection[];
      tenantOtherCollections: BucketCollection[];
      nameOf: (id: string | null) => string;
    }
  | {
      kind: 'extra';
      c: ExtraRow;
      plan: ActiveRent | undefined;
      dailyPlan: number;
      totalDue: number;
      paidBefore: number;
      remaining: number;
      expected: number;
      timeline: { id: string; when: number; amount: number; cumulative: number; over_daily: number; over_remaining: number; isThis: boolean }[];
      nameOf: (id: string | null) => string;
    };

function ReconDetailView({
  detail,
  bucketDays,
  bucketLabel,
  onOpenAnother,
  isReviewed,
  onToggleReviewed,
}: {
  detail: DetailPayload;
  bucketDays: number;
  bucketLabel: string;
  onOpenAnother: (sel: { kind: 'missing'; rentId: string } | { kind: 'extra'; collectionId: string }) => void;
  isReviewed: boolean;
  onToggleReviewed: () => void;
}) {
  // Local search/filter state — resets when switching detail rows (via key on wrapper below is not needed;
  // we intentionally keep filters stable while the operator drills through related rows).
  const [query, setQuery] = useState('');
  const [planQuery, setPlanQuery] = useState('');
  const [fromLocal, setFromLocal] = useState<string>(''); // datetime-local (EAT-ish)
  const [toLocal, setToLocal] = useState<string>('');
  const [stepsOpen, setStepsOpen] = useState<boolean>(true);

  const q = query.trim().toLowerCase();
  const pq = planQuery.trim().toLowerCase();
  // datetime-local strings are naive; treat them as EAT (UTC+3) → ms.
  const parseLocalAsEatMs = (s: string): number | null => {
    if (!s) return null;
    // s like "2026-07-20T14:30"
    const [d, t] = s.split('T');
    if (!d || !t) return null;
    const [y, mo, day] = d.split('-').map(Number);
    const [hh, mm] = t.split(':').map(Number);
    if (!y || !mo || !day) return null;
    // UTC ms for that wall time - 3h offset (EAT is UTC+3, no DST)
    return Date.UTC(y, mo - 1, day, hh || 0, mm || 0) - 3 * 3600 * 1000;
  };
  const fromMs = parseLocalAsEatMs(fromLocal);
  const toMs = parseLocalAsEatMs(toLocal);

  const matchCollection = (row: BucketCollection, nameOf: (id: string | null) => string): boolean => {
    const when = new Date(row.created_at).getTime();
    if (fromMs !== null && when < fromMs) return false;
    if (toMs !== null && when > toMs) return false;
    if (pq) {
      const planStr = (row.rent_request_id || '').toLowerCase();
      if (!planStr.includes(pq)) return false;
    }
    if (q) {
      const hay = [
        nameOf(row.tenant_id),
        nameOf(row.agent_id),
        row.tenant_id || '',
        row.agent_id || '',
        row.rent_request_id || '',
        row.payment_method || '',
        row.id,
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  const hasFilters = Boolean(q || pq || fromMs !== null || toMs !== null);
  const clearFilters = () => { setQuery(''); setPlanQuery(''); setFromLocal(''); setToLocal(''); };

  const csvEscape = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const triggerDownload = (rows: (string | number)[][], filename: string) => {
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  type TimelineRow = { id: string; when: number; amount: number; cumulative: number; over_daily: number; over_remaining: number; isThis: boolean };
  const downloadDetailCsv = (opts?: { filteredPlanCollections?: BucketCollection[]; filteredTenantOther?: BucketCollection[]; filteredTimeline?: TimelineRow[] }) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    if (detail.kind === 'missing') {
      const { m, plan, dailyPlan, totalDue, paidBefore, remaining, nameOf } = detail;
      const planCollections = opts?.filteredPlanCollections ?? detail.planCollections;
      const tenantOtherCollections = opts?.filteredTenantOther ?? detail.tenantOtherCollections;
      const rows: (string | number)[][] = [];
      rows.push(['section', 'field', 'value']);
      rows.push(['header', 'tenant', nameOf(m.tenant_id)]);
      rows.push(['header', 'tenant_id', m.tenant_id || '']);
      rows.push(['header', 'agent', nameOf(m.agent_id)]);
      rows.push(['header', 'agent_id', m.agent_id || '']);
      rows.push(['header', 'rent_request_id', m.rent_id]);
      rows.push(['header', 'plan_status', plan?.status || '']);
      if (hasFilters) {
        rows.push(['header', 'filter_text', q]);
        rows.push(['header', 'filter_plan', pq]);
        rows.push(['header', 'filter_from_eat', fromLocal]);
        rows.push(['header', 'filter_to_eat', toLocal]);
      }
      rows.push([]);
      rows.push(['math', 'label', 'value_ugx']);
      rows.push(['math', 'plan_daily_repayment', Math.round(dailyPlan)]);
      rows.push(['math', 'bucket_days', bucketDays.toFixed(6)]);
      rows.push(['math', 'daily_times_bucket', Math.round(dailyPlan * bucketDays)]);
      rows.push(['math', 'total_due', Math.round(totalDue)]);
      rows.push(['math', 'already_repaid_before_bucket', Math.round(paidBefore)]);
      rows.push(['math', 'remaining_balance', Math.round(remaining)]);
      rows.push(['math', 'expected_in_bucket', Math.round(m.daily)]);
      rows.push(['math', 'collected_in_bucket', Math.round(m.collected)]);
      rows.push(['math', 'variance', -Math.round(m.variance)]);
      rows.push([]);
      rows.push(['plan_collections', 'when_eat', 'agent', 'agent_id', 'method', 'amount_ugx', 'rent_request_id', 'collection_id']);
      for (const r of planCollections) {
        rows.push(['plan_collections', fmtWhen(new Date(r.created_at).getTime()), nameOf(r.agent_id), r.agent_id || '', r.payment_method || '', Math.round(Number(r.amount) || 0), r.rent_request_id || '', r.id]);
      }
      if (tenantOtherCollections.length) {
        rows.push([]);
        rows.push(['tenant_other_plans', 'when_eat', 'agent', 'agent_id', 'method', 'amount_ugx', 'rent_request_id', 'collection_id']);
        for (const r of tenantOtherCollections) {
          rows.push(['tenant_other_plans', fmtWhen(new Date(r.created_at).getTime()), nameOf(r.agent_id), r.agent_id || '', r.payment_method || '', Math.round(Number(r.amount) || 0), r.rent_request_id || '', r.id]);
        }
      }
      triggerDownload(rows, `recon_missing_${m.rent_id.slice(0, 8)}_${stamp}.csv`);
      return;
    }
    const { c, plan, dailyPlan, totalDue, paidBefore, remaining, expected, nameOf } = detail;
    const timeline = opts?.filteredTimeline ?? detail.timeline;
    const rows: (string | number)[][] = [];
    rows.push(['section', 'field', 'value']);
    rows.push(['header', 'collection_id', c.collection_id]);
    rows.push(['header', 'when_eat', fmtWhen(c.when_ms)]);
    rows.push(['header', 'amount_ugx', Math.round(c.amount)]);
    rows.push(['header', 'extra_amount_ugx', Math.round(c.extra_amount)]);
    rows.push(['header', 'reason', c.reason]);
    rows.push(['header', 'reason_label', c.reason_label]);
    rows.push(['header', 'tenant', nameOf(c.tenant_id)]);
    rows.push(['header', 'tenant_id', c.tenant_id || '']);
    rows.push(['header', 'agent', nameOf(c.agent_id)]);
    rows.push(['header', 'agent_id', c.agent_id || '']);
    rows.push(['header', 'method', c.method || '']);
    rows.push(['header', 'rent_request_id', c.rent_request_id || '']);
    if (hasFilters) {
      rows.push(['header', 'filter_text', q]);
      rows.push(['header', 'filter_plan', pq]);
      rows.push(['header', 'filter_from_eat', fromLocal]);
      rows.push(['header', 'filter_to_eat', toLocal]);
    }
    if (plan) {
      rows.push([]);
      rows.push(['math', 'label', 'value_ugx']);
      rows.push(['math', 'plan_status', plan.status || '']);
      rows.push(['math', 'plan_daily_repayment', Math.round(dailyPlan)]);
      rows.push(['math', 'bucket_days', bucketDays.toFixed(6)]);
      rows.push(['math', 'total_due', Math.round(totalDue)]);
      rows.push(['math', 'already_repaid_before_bucket', Math.round(paidBefore)]);
      rows.push(['math', 'remaining_balance', Math.round(remaining)]);
      rows.push(['math', 'expected_in_bucket', Math.round(expected)]);
      rows.push([]);
      rows.push(['timeline', 'when_eat', 'amount_ugx', 'cumulative_ugx', 'over_daily_ugx', 'over_remaining_ugx', 'is_this_row', 'collection_id']);
      for (const t of timeline) {
        rows.push(['timeline', fmtWhen(t.when), Math.round(t.amount), Math.round(t.cumulative), Math.round(t.over_daily), Math.round(t.over_remaining), t.isThis ? 'yes' : 'no', t.id]);
      }
    }
    triggerDownload(rows, `recon_extra_${c.collection_id.slice(0, 8)}_${stamp}.csv`);
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadDetailPdf = async (opts?: { filteredPlanCollections?: BucketCollection[]; filteredTenantOther?: BucketCollection[]; filteredTimeline?: TimelineRow[] }) => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const filterMeta = {
        bucketLabel,
        filterText: q || undefined,
        filterPlan: pq || undefined,
        filterFromEat: fromLocal || undefined,
        filterToEat: toLocal || undefined,
      };
      let blob: Blob;
      let filename: string;
      if (detail.kind === 'missing') {
        const { m, plan, dailyPlan, totalDue, paidBefore, remaining, nameOf } = detail;
        const planCollections = opts?.filteredPlanCollections ?? detail.planCollections;
        const tenantOtherCollections = opts?.filteredTenantOther ?? detail.tenantOtherCollections;
        blob = await generateBucketReconDetailPdf({
          kind: 'missing',
          tenantName: nameOf(m.tenant_id),
          tenantId: m.tenant_id ?? null,
          agentName: nameOf(m.agent_id),
          agentId: m.agent_id ?? null,
          rentRequestId: m.rent_id,
          planStatus: plan?.status || '',
          dailyPlan,
          bucketDays,
          totalDue,
          paidBefore,
          remaining,
          expectedInBucket: m.daily,
          collectedInBucket: m.collected,
          variance: m.variance,
          planCollections: planCollections.map((r) => ({
            whenEat: fmtWhen(new Date(r.created_at).getTime()),
            agent: nameOf(r.agent_id),
            method: r.payment_method || '',
            amount: Number(r.amount) || 0,
            collectionId: r.id,
          })),
          tenantOtherCollections: tenantOtherCollections.map((r) => ({
            whenEat: fmtWhen(new Date(r.created_at).getTime()),
            agent: nameOf(r.agent_id),
            method: r.payment_method || '',
            amount: Number(r.amount) || 0,
            rentRequestId: r.rent_request_id || '',
            collectionId: r.id,
          })),
        }, filterMeta);
        filename = `recon_missing_${m.rent_id.slice(0, 8)}_${stamp}.pdf`;
      } else {
        const { c, plan, dailyPlan, totalDue, paidBefore, remaining, expected, nameOf } = detail;
        const timeline = opts?.filteredTimeline ?? detail.timeline;
        blob = await generateBucketReconDetailPdf({
          kind: 'extra',
          collectionId: c.collection_id,
          whenEat: fmtWhen(c.when_ms),
          amount: c.amount,
          extraAmount: c.extra_amount,
          reasonLabel: c.reason_label,
          tenantName: nameOf(c.tenant_id),
          tenantId: c.tenant_id ?? null,
          agentName: nameOf(c.agent_id),
          agentId: c.agent_id ?? null,
          method: c.method || '',
          rentRequestId: c.rent_request_id ?? null,
          planStatus: plan?.status || undefined,
          dailyPlan: plan ? dailyPlan : undefined,
          bucketDays: plan ? bucketDays : undefined,
          totalDue: plan ? totalDue : undefined,
          paidBefore: plan ? paidBefore : undefined,
          remaining: plan ? remaining : undefined,
          expectedInBucket: plan ? expected : undefined,
          timeline: timeline.map((t) => ({
            whenEat: fmtWhen(t.when),
            amount: t.amount,
            cumulative: t.cumulative,
            overDaily: t.over_daily,
            overRemaining: t.over_remaining,
            isThis: t.isThis,
            collectionId: t.id,
          })),
        }, filterMeta);
        filename = `recon_extra_${c.collection_id.slice(0, 8)}_${stamp}.pdf`;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[bucket-recon] PDF export failed', err);
      toast.error('PDF export failed — try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  const filterBar = (
    <div className="rounded-md border border-border bg-muted/30 p-2 flex flex-wrap items-center gap-1.5">
      <div className="relative flex-1 min-w-[10rem]">
        <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tenant, agent, method, id…"
          className="w-full h-7 pl-6 pr-2 rounded-md text-[11px] bg-background border border-border focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <input
        value={planQuery}
        onChange={(e) => setPlanQuery(e.target.value)}
        placeholder="Plan id starts with…"
        className="h-7 px-2 rounded-md text-[11px] bg-background border border-border focus:outline-none focus:ring-1 focus:ring-primary w-[9rem]"
      />
      <label className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
        From
        <input type="datetime-local" value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} className="h-7 px-1 rounded-md text-[10px] bg-background border border-border" />
      </label>
      <label className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
        To
        <input type="datetime-local" value={toLocal} onChange={(e) => setToLocal(e.target.value)} className="h-7 px-1 rounded-md text-[10px] bg-background border border-border" />
      </label>
      {hasFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="h-7 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-background border border-border hover:bg-muted"
        >
          <X className="h-3 w-3" /> Clear
        </button>
      )}
    </div>
  );

  if (detail.kind === 'missing') {
    const { m, plan, dailyPlan, totalDue, paidBefore, remaining, planCollections, tenantOtherCollections, nameOf } = detail;
    const proration = bucketDays >= 0.999 ? '1 full day' : `${(bucketDays * 24).toFixed(2)} hours (${(bucketDays * 100 / 1).toFixed(1)}% of a day)`;
    const filteredPlanCollections = planCollections.filter((r) => matchCollection(r, nameOf));
    const filteredTenantOther = tenantOtherCollections.filter((r) => matchCollection(r, nameOf));
    return (
      <div className="p-4 space-y-4">
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-bold uppercase tracking-wide text-rose-800">Missing collection · variance breakdown</div>
            <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleReviewed}
              className={`h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 border ${isReviewed ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-background border-border hover:bg-muted'}`}
              title={isReviewed ? 'Reviewed — click to unmark this plan' : 'Mark this plan as reviewed'}
              aria-pressed={isReviewed}
            >
              {isReviewed ? <><CheckCircle2 className="h-3 w-3" /> Reviewed</> : <><Check className="h-3 w-3" /> Mark reviewed</>}
            </button>
            <button
              type="button"
              onClick={() => downloadDetailCsv({ filteredPlanCollections, filteredTenantOther })}
              className="h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-background border border-border hover:bg-muted"
              title={hasFilters ? 'Download the filtered variance breakdown as CSV' : 'Download this variance breakdown as CSV'}
            >
              <Download className="h-3 w-3" /> CSV{hasFilters ? ' (filtered)' : ''}
            </button>
            <button
              type="button"
              onClick={() => downloadDetailPdf({ filteredPlanCollections, filteredTenantOther })}
              disabled={pdfBusy}
              className="h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-rose-600 text-white border border-rose-700 hover:bg-rose-700 disabled:opacity-50"
              title={hasFilters ? 'Download the filtered variance breakdown as PDF' : 'Download this variance breakdown as PDF'}
            >
              {pdfBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />} PDF{hasFilters ? ' (filtered)' : ''}
            </button>
            </div>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <div className="text-base font-bold text-foreground truncate">{nameOf(m.tenant_id) || '(no tenant)'}</div>
            <div className="text-[10px] font-mono text-muted-foreground">{m.tenant_id?.slice(0, 8) || '—'}</div>
          </div>
          <div className="text-[10px] text-muted-foreground">Agent: <span className="text-foreground font-semibold">{nameOf(m.agent_id) || '—'}</span> · Plan <span className="font-mono">{m.rent_id.slice(0, 8)}</span> · Status <span className="font-semibold">{plan?.status || '—'}</span></div>
        </div>

        {filterBar}

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">Prorated obligation for this bucket</div>
          <table className="w-full text-[11px] border border-border rounded-md overflow-hidden">
            <tbody className="divide-y divide-border">
              <MathRow label="Plan daily repayment" value={formatUGX(dailyPlan)} />
              <MathRow label="Bucket length" value={proration} />
              <MathRow label="Daily × bucket length" value={formatUGX(Math.round(dailyPlan * bucketDays))} />
              <MathRow label="Total due on plan" value={formatUGX(totalDue)} />
              <MathRow label="Already repaid (before bucket)" value={formatUGX(paidBefore)} />
              <MathRow label="Remaining balance" value={formatUGX(remaining)} />
              <MathRow label="Expected in bucket = min(remaining, daily × bucket)" value={formatUGX(Math.round(m.daily))} accent="violet" bold />
              <MathRow label="Collected in bucket" value={formatUGX(Math.round(m.collected))} accent="primary" bold />
              <MathRow label="Variance = expected − collected" value={`−${formatUGX(Math.round(m.variance))}`} accent="rose" bold />
            </tbody>
          </table>
        </div>

        {/* Step-by-step expandable breakdown */}
        {(() => {
          const dailyXBucket = dailyPlan * bucketDays;
          const cappedByRemaining = dailyXBucket > remaining;
          const expectedAmt = m.daily;
          // Chronological allocation of collections against the expected amount.
          const chronoPlanColls = [...planCollections].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          );
          let running = 0;
          const allocation = chronoPlanColls.map((r) => {
            const amt = Number(r.amount) || 0;
            const need = Math.max(0, expectedAmt - running);
            const applied = Math.min(amt, need);
            const leftover = amt - applied;
            const before = running;
            running += applied;
            return { id: r.id, when: new Date(r.created_at).getTime(), amt, before, applied, leftover, after: running };
          });
          const shortfall = Math.max(0, expectedAmt - running);
          return (
            <div className="rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setStepsOpen((v) => !v)}
                className="w-full flex items-center justify-between px-2 py-1.5 bg-muted/40 hover:bg-muted transition-colors text-left"
                aria-expanded={stepsOpen}
              >
                <span className="text-[10px] font-bold uppercase tracking-wide text-foreground inline-flex items-center gap-1">
                  {stepsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Step-by-step calculation
                </span>
                <span className="text-[9px] text-muted-foreground">{allocation.length} collection{allocation.length === 1 ? '' : 's'} allocated · shortfall {formatUGX(Math.round(shortfall))}</span>
              </button>
              {stepsOpen && (
                <div className="p-3 space-y-3 bg-background">
                  <ol className="space-y-2 text-[11px]">
                    <Step n={1} title="Compute the raw daily obligation">
                      <div><span className="text-muted-foreground">Daily × bucket length</span> = {formatUGX(dailyPlan)} × {bucketDays.toFixed(4)} = <span className="font-bold tabular-nums">{formatUGX(Math.round(dailyXBucket))}</span></div>
                      <div className="text-[10px] text-muted-foreground">Bucket duration: {proration}.</div>
                    </Step>
                    <Step n={2} title="Cap by remaining balance">
                      <div><span className="text-muted-foreground">Remaining on plan</span> = total due {formatUGX(totalDue)} − already repaid {formatUGX(paidBefore)} = <span className="font-bold tabular-nums">{formatUGX(remaining)}</span></div>
                      <div className="mt-0.5">
                        <span className="text-muted-foreground">Expected = min(remaining, daily × bucket)</span> = min({formatUGX(remaining)}, {formatUGX(Math.round(dailyXBucket))}) = <span className="font-bold tabular-nums text-violet-700">{formatUGX(Math.round(expectedAmt))}</span>
                      </div>
                      {cappedByRemaining && (
                        <div className="mt-1 text-[10px] text-amber-700 font-semibold">Cap applied — the plan's remaining balance is smaller than the raw daily × bucket amount, so it caps the obligation.</div>
                      )}
                    </Step>
                    <Step n={3} title="Allocate collections against the expected amount">
                      {allocation.length === 0 ? (
                        <div className="text-[10px] text-muted-foreground italic">No collections were booked to this plan in the bucket — the entire expected amount is missing.</div>
                      ) : (
                        <div className="overflow-auto">
                          <table className="w-full text-[10px] border border-border rounded-md">
                            <thead className="bg-muted text-muted-foreground text-[9px] uppercase tracking-wide">
                              <tr>
                                <th className="text-left px-1.5 py-1">#</th>
                                <th className="text-left px-1.5 py-1">When (EAT)</th>
                                <th className="text-right px-1.5 py-1">Collection</th>
                                <th className="text-right px-1.5 py-1">Need before</th>
                                <th className="text-right px-1.5 py-1">Applied</th>
                                <th className="text-right px-1.5 py-1">Leftover (overpay)</th>
                                <th className="text-right px-1.5 py-1">Running covered</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {allocation.map((a, idx) => (
                                <tr key={a.id}>
                                  <td className="px-1.5 py-1 tabular-nums text-muted-foreground">{idx + 1}</td>
                                  <td className="px-1.5 py-1 whitespace-nowrap tabular-nums">{fmtWhen(a.when)}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums">{formatUGX(a.amt)}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums text-muted-foreground">{formatUGX(Math.round(Math.max(0, expectedAmt - a.before)))}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums font-semibold text-primary">{formatUGX(Math.round(a.applied))}</td>
                                  <td className={`px-1.5 py-1 text-right tabular-nums ${a.leftover > 0 ? 'text-amber-700 font-semibold' : 'text-muted-foreground'}`}>{a.leftover > 0 ? `+${formatUGX(Math.round(a.leftover))}` : '—'}</td>
                                  <td className="px-1.5 py-1 text-right tabular-nums font-bold">{formatUGX(Math.round(a.after))} <span className="text-[9px] text-muted-foreground">/ {formatUGX(Math.round(expectedAmt))}</span></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </Step>
                    <Step n={4} title="Resulting variance">
                      <div><span className="text-muted-foreground">Covered</span> = <span className="font-bold tabular-nums text-primary">{formatUGX(Math.round(running))}</span> · <span className="text-muted-foreground">Expected</span> = <span className="font-bold tabular-nums text-violet-700">{formatUGX(Math.round(expectedAmt))}</span></div>
                      <div className="mt-0.5"><span className="text-muted-foreground">Shortfall (variance)</span> = <span className="font-bold tabular-nums text-rose-700">−{formatUGX(Math.round(shortfall))}</span></div>
                      {allocation.some((a) => a.leftover > 0) && (
                        <div className="mt-1 text-[10px] text-amber-700">Note: some collections overpaid the expected amount; the excess is booked as `extra` on the Extra tab and does not reduce this variance.</div>
                      )}
                    </Step>
                  </ol>
                </div>
              )}
            </div>
          );
        })()}

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
            Collections linked to this plan in this bucket ({filteredPlanCollections.length}{hasFilters ? ` / ${planCollections.length}` : ''})
          </div>
          {planCollections.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic border border-dashed border-border rounded-md p-3">Zero collections — the plan received nothing in this window.</p>
          ) : filteredPlanCollections.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic border border-dashed border-border rounded-md p-3">No rows match the current filters.</p>
          ) : (
            <MiniCollectionTable rows={filteredPlanCollections} nameOf={nameOf} stateKey={`missing:${m.rent_id}:plan`} />
          )}
        </div>

        {tenantOtherCollections.length > 0 && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
              Same tenant paid on {tenantOtherCollections.length} other plan{tenantOtherCollections.length === 1 ? '' : 's'} in this bucket{hasFilters ? ` (${filteredTenantOther.length} match filters)` : ''}
            </div>
            <p className="text-[10px] text-muted-foreground mb-1 italic">Collections booked to a different `rent_request_id` for the same tenant — often the source of misattribution.</p>
            {filteredTenantOther.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic border border-dashed border-border rounded-md p-3">No rows match the current filters.</p>
            ) : (
              <MiniCollectionTable rows={filteredTenantOther} nameOf={nameOf} stateKey={`missing:${m.rent_id}:tenantOther`} />
            )}
          </div>
        )}
      </div>
    );
  }

  const { c, plan, dailyPlan, totalDue, paidBefore, remaining, expected, timeline, nameOf } = detail;
  // Timeline filter: apply text/plan/date filters against each timeline row (plus its underlying tenant/agent from the parent extra row).
  const filteredTimeline = timeline.filter((t) => {
    if (fromMs !== null && t.when < fromMs) return false;
    if (toMs !== null && t.when > toMs) return false;
    if (pq) {
      const planStr = (c.rent_request_id || '').toLowerCase();
      if (!planStr.includes(pq)) return false;
    }
    if (q) {
      const hay = [
        nameOf(c.tenant_id),
        nameOf(c.agent_id),
        c.tenant_id || '',
        c.agent_id || '',
        c.rent_request_id || '',
        c.method || '',
        t.id,
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return (
    <div className="p-4 space-y-4">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-wide text-amber-800">Extra collection · why flagged</div>
          <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleReviewed}
            className={`h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 border ${isReviewed ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-background border-border hover:bg-muted'}`}
            title={isReviewed ? 'Reviewed — click to unmark this collection' : 'Mark this collection as reviewed'}
            aria-pressed={isReviewed}
          >
            {isReviewed ? <><CheckCircle2 className="h-3 w-3" /> Reviewed</> : <><Check className="h-3 w-3" /> Mark reviewed</>}
          </button>
          <button
            type="button"
            onClick={() => downloadDetailCsv({ filteredTimeline })}
            className="h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-background border border-border hover:bg-muted"
            title={hasFilters ? 'Download the filtered extra-collection breakdown as CSV' : 'Download this extra-collection breakdown as CSV'}
          >
            <Download className="h-3 w-3" /> CSV{hasFilters ? ' (filtered)' : ''}
          </button>
          <button
            type="button"
            onClick={() => downloadDetailPdf({ filteredTimeline })}
            disabled={pdfBusy}
            className="h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-amber-600 text-white border border-amber-700 hover:bg-amber-700 disabled:opacity-50"
            title={hasFilters ? 'Download the filtered extra-collection breakdown as PDF' : 'Download this extra-collection breakdown as PDF'}
          >
            {pdfBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />} PDF{hasFilters ? ' (filtered)' : ''}
          </button>
          </div>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <div className="text-base font-bold text-foreground">{formatUGX(c.amount)}</div>
          <div className="text-[10px] text-muted-foreground">at {fmtWhen(c.when_ms)}</div>
        </div>
        <div className="text-[10px] text-muted-foreground">
          Tenant: <span className="text-foreground font-semibold">{nameOf(c.tenant_id) || '—'}</span> · Agent: <span className="text-foreground font-semibold">{nameOf(c.agent_id) || '—'}</span>
          {c.method && <> · Method: <span className="text-foreground font-semibold">{c.method.replace(/_/g, ' ')}</span></>}
        </div>
        <div className="mt-1">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-900 text-[10px] font-semibold">{c.reason_label}</span>
          <span className="ml-2 text-[10px] text-muted-foreground">Extra amount: <span className="font-bold text-amber-800">+{formatUGX(Math.round(c.extra_amount))}</span></span>
        </div>
      </div>

      {filterBar}

      {plan ? (
        <>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">Linked plan obligation</div>
            <table className="w-full text-[11px] border border-border rounded-md overflow-hidden">
              <tbody className="divide-y divide-border">
                <MathRow label="Plan" value={`${plan.id.slice(0, 8)} · ${plan.status || '—'}`} />
                <MathRow label="Plan daily repayment" value={formatUGX(dailyPlan)} />
                <MathRow label="Total due" value={formatUGX(totalDue)} />
                <MathRow label="Already repaid (before bucket)" value={formatUGX(paidBefore)} />
                <MathRow label="Remaining balance" value={formatUGX(remaining)} />
                <MathRow label="Expected in bucket" value={formatUGX(Math.round(expected))} accent="violet" bold />
              </tbody>
            </table>
          </div>

          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
              Cumulative timeline for this plan in the bucket ({filteredTimeline.length}{hasFilters ? ` / ${timeline.length}` : ''})
            </div>
            <TimelineTable rows={filteredTimeline} stateKey={`extra:${c.collection_id}:timeline`} />
            <p className="mt-1 text-[10px] text-muted-foreground italic">
              The row is flagged as extra because its cumulative pushes the plan over the {c.reason === 'over_remaining' ? 'remaining balance' : c.reason === 'over_daily' ? 'daily expected amount' : 'link/status check'} by <span className="font-bold text-amber-800">+{formatUGX(Math.round(c.extra_amount))}</span>.
            </p>
          </div>
        </>
      ) : (
        <div className="rounded-md border border-dashed border-border p-3 text-[11px] text-muted-foreground">
          {c.reason === 'no_plan_link'
            ? 'This collection was recorded without any `rent_request_id`, so it cannot be attributed to a plan obligation. Investigate whether it should be re-linked or refunded.'
            : 'The linked plan is not currently active (closed / cancelled / paid off), so no daily obligation exists for it in this bucket.'}
        </div>
      )}

      {/* Suggest jumping to the missing plan for the same tenant if any. */}
      {plan && (
        <button
          type="button"
          onClick={() => onOpenAnother({ kind: 'missing', rentId: plan.id })}
          className="text-[10px] font-semibold text-primary hover:underline"
        >
          → View this plan's variance in the Missing tab
        </button>
      )}
    </div>
  );
}

function MathRow({ label, value, accent, bold }: { label: string; value: string; accent?: 'violet' | 'primary' | 'rose'; bold?: boolean }) {
  const color = accent === 'violet' ? 'text-violet-700' : accent === 'primary' ? 'text-primary' : accent === 'rose' ? 'text-rose-700' : 'text-foreground';
  return (
    <tr>
      <td className="px-2 py-1.5 text-muted-foreground">{label}</td>
      <td className={`px-2 py-1.5 text-right tabular-nums ${bold ? 'font-bold' : ''} ${color}`}>{value}</td>
    </tr>
  );
}

type TimelineSortKey = 'when' | 'amount' | 'over_daily' | 'over_remaining';
function TimelineTable({ rows, stateKey }: { rows: { id: string; when: number; amount: number; cumulative: number; over_daily: number; over_remaining: number; isThis: boolean }[]; stateKey?: string }) {
  const [sort, setSort] = useState<{ k: TimelineSortKey; dir: 'asc' | 'desc' }>({ k: 'when', dir: 'asc' });
  const toggle = (k: TimelineSortKey) =>
    setSort((s) => (s.k === k ? { k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { k, dir: k === 'when' ? 'asc' : 'desc' }));
  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sort.k === 'when' ? a.when : sort.k === 'amount' ? a.amount : sort.k === 'over_daily' ? a.over_daily : a.over_remaining;
      const vb = sort.k === 'when' ? b.when : sort.k === 'amount' ? b.amount : sort.k === 'over_daily' ? b.over_daily : b.over_remaining;
      return (va - vb) * dir;
    });
  }, [rows, sort]);
  const [pageSize, setPageSize] = usePageSizePref(stateKey, DETAIL_PAGE_SIZE);
  const [visible, setVisibleState] = useState(() =>
    (stateKey && detailPageSizeStore.get(stateKey)) || pageSize,
  );
  // Re-sync when the stateKey identity changes (opening a different detail).
  useEffect(() => {
    if (!stateKey) return;
    const saved = detailPageSizeStore.get(stateKey);
    setVisibleState(saved && saved > 0 ? saved : pageSize);
  }, [stateKey, pageSize]);
  const setVisible = (updater: number | ((v: number) => number)) => {
    setVisibleState((prev) => {
      const next = typeof updater === 'function' ? (updater as (v: number) => number)(prev) : updater;
      if (stateKey) detailPageSizeStore.set(stateKey, next);
      return next;
    });
  };
  const onPageSizeChange = (n: number) => {
    setPageSize(n);
    setVisible(n);
  };
  // Flagged rows = the "this row" plus any row that breached daily/remaining caps.
  // These are the highlights the user can step through with Prev/Next.
  const flaggedIdxs = useMemo(
    () => sorted.reduce<number[]>((acc, r, i) => {
      if (r.isThis || r.over_daily > 0 || r.over_remaining > 0) acc.push(i);
      return acc;
    }, []),
    [sorted],
  );
  const thisIdx = sorted.findIndex((r) => r.isThis);
  // Cursor into flaggedIdxs; resets when the sort/filter changes the flagged set.
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (flaggedIdxs.length === 0) { setCursor(0); return; }
    const thisPos = thisIdx >= 0 ? flaggedIdxs.indexOf(thisIdx) : -1;
    setCursor(thisPos >= 0 ? thisPos : 0);
  }, [flaggedIdxs, thisIdx]);
  const activeFlaggedIdx = flaggedIdxs[cursor] ?? -1;
  // Tick that bumps whenever the user jumps so the virtualizer's scrollTo effect
  // re-fires even if sort/page haven't changed.
  const [jumpTick, setJumpTick] = useState(0);
  // Transient status label showing the last shortcut action and target row.
  const [jumpStatus, setJumpStatus] = useState<{ key: string; targetRow: number; at: number } | null>(null);
  useEffect(() => {
    if (!jumpStatus) return;
    const id = setTimeout(() => setJumpStatus(null), 2000);
    return () => clearTimeout(id);
  }, [jumpStatus]);
  // Always keep the current flagged row visible even if it would fall past the cutoff.
  const effectiveVisible = activeFlaggedIdx >= 0
    ? Math.max(visible, activeFlaggedIdx + 1)
    : (thisIdx >= 0 ? Math.max(visible, thisIdx + 1) : visible);
  const page = sorted.slice(0, effectiveVisible);
  const hasMore = sorted.length > effectiveVisible;
  const stepFlagged = (delta: 1 | -1, keyLabel: string) => {
    if (flaggedIdxs.length === 0) return;
    const next = (cursor + delta + flaggedIdxs.length) % flaggedIdxs.length;
    setCursor(next);
    const targetIdx = flaggedIdxs[next];
    if (targetIdx + 1 > effectiveVisible) setVisible(targetIdx + 1);
    setJumpTick((n) => n + 1);
    setJumpStatus({ key: keyLabel, targetRow: targetIdx + 1, at: Date.now() });
  };
  const jumpToFlagged = () => {
    if (activeFlaggedIdx < 0) return;
    if (activeFlaggedIdx + 1 > effectiveVisible) setVisible(activeFlaggedIdx + 1);
    setJumpTick((n) => n + 1);
    setJumpStatus({ key: 'J', targetRow: activeFlaggedIdx + 1, at: Date.now() });
  };
  const jumpToFlaggedEdge = (edge: 'first' | 'last', keyLabel: string) => {
    if (flaggedIdxs.length === 0) return;
    const pos = edge === 'first' ? 0 : flaggedIdxs.length - 1;
    setCursor(pos);
    const targetIdx = flaggedIdxs[pos];
    if (targetIdx + 1 > effectiveVisible) setVisible(targetIdx + 1);
    setJumpTick((n) => n + 1);
    setJumpStatus({ key: keyLabel, targetRow: targetIdx + 1, at: Date.now() });
  };
  // Keyboard shortcuts are user-customizable — bindings come from
  // localStorage-backed prefs (see TimelineShortcutSettings). Defaults:
  //   J → jump · N/] → next · P/[ → prev · Home → first · End → last
  // Ignored while the user is typing in an input/textarea/contentEditable.
  const shortcutPrefs = useTimelineShortcuts();
  useEffect(() => {
    if (flaggedIdxs.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      const action = matchTimelineShortcut(e.key, shortcutPrefs);
      if (!action) return;
      e.preventDefault();
      const label = formatShortcutKey(e.key);
      if (action === 'jump') jumpToFlagged();
      else if (action === 'next') stepFlagged(1, label);
      else if (action === 'prev') stepFlagged(-1, label);
      else if (action === 'first') jumpToFlaggedEdge('first', label);
      else if (action === 'last') jumpToFlaggedEdge('last', label);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flaggedIdxs, cursor, effectiveVisible, activeFlaggedIdx, shortcutPrefs]);
  const Icon = ({ k }: { k: TimelineSortKey }) =>
    sort.k !== k ? <ArrowUpDown className="h-3 w-3 opacity-40" /> : sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  const SortBtn = ({ k, label, align = 'left' }: { k: TimelineSortKey; label: string; align?: 'left' | 'right' }) => (
    <button
      type="button"
      onClick={() => toggle(k)}
      className={`inline-flex items-center gap-1 hover:text-foreground ${align === 'right' ? 'justify-end w-full' : ''}`}
    >
      {label} <Icon k={k} />
    </button>
  );
  return (
    <div className="space-y-1">
      <VirtualRows
        items={page}
        rowHeight={30}
        gridTemplate="minmax(140px,1.4fr) 110px 110px 110px 130px"
        header={(
          <>
            <div className="px-2 py-1.5 text-left"><SortBtn k="when" label="When (EAT)" /></div>
            <div className="px-2 py-1.5 text-right"><SortBtn k="amount" label="Amount" align="right" /></div>
            <div className="px-2 py-1.5 text-right">Cumulative</div>
            <div className="px-2 py-1.5 text-right"><SortBtn k="over_daily" label="Over daily" align="right" /></div>
            <div className="px-2 py-1.5 text-right"><SortBtn k="over_remaining" label="Over remaining" align="right" /></div>
          </>
        )}
        emptyMessage="No rows match the current filters."
        scrollToIndex={activeFlaggedIdx >= 0
          ? Math.min(activeFlaggedIdx, page.length - 1)
          : (thisIdx >= 0 ? Math.min(thisIdx, page.length - 1) : undefined)}
        scrollToDepKey={`${stateKey ?? ''}:${sort.k}:${sort.dir}:${page.length}:${activeFlaggedIdx}:${jumpTick}`}
        renderRow={(t, i) => {
          const isActive = i === activeFlaggedIdx;
          const bg = t.isThis
            ? (isActive ? 'bg-amber-500/25' : 'bg-amber-500/10')
            : (isActive ? 'bg-amber-500/15' : '');
          return (
            <div className={`contents ${t.isThis ? 'font-semibold' : ''}`}>
              <div className={`px-2 py-1.5 whitespace-nowrap tabular-nums ${bg}`}>
                {fmtWhen(t.when)}
                {t.isThis && <span className="ml-1 text-[9px] text-amber-700">← this row</span>}
                {isActive && !t.isThis && <span className="ml-1 text-[9px] text-amber-700">← flagged</span>}
              </div>
              <div className={`px-2 py-1.5 text-right tabular-nums ${bg}`}>{formatUGX(t.amount)}</div>
              <div className={`px-2 py-1.5 text-right tabular-nums ${bg}`}>{formatUGX(t.cumulative)}</div>
              <div className={`px-2 py-1.5 text-right tabular-nums ${bg} ${t.over_daily > 0 ? 'text-amber-700 font-bold' : 'text-muted-foreground'}`}>{t.over_daily > 0 ? `+${formatUGX(Math.round(t.over_daily))}` : '—'}</div>
              <div className={`px-2 py-1.5 text-right tabular-nums ${bg} ${t.over_remaining > 0 ? 'text-rose-700 font-bold' : 'text-muted-foreground'}`}>{t.over_remaining > 0 ? `+${formatUGX(Math.round(t.over_remaining))}` : '—'}</div>
            </div>
          );
        }}
      />
      {sorted.length > 0 && (
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground px-1 flex-wrap">
          <div className="flex items-center gap-2">
            <span>Showing {page.length} of {sorted.length}{thisIdx >= 0 && thisIdx + 1 > visible ? ' (expanded to include flagged row)' : ''}</span>
            <PageSizeSelect value={pageSize} onChange={onPageSizeChange} />
            <TimelineShortcutSettingsButton />
            {flaggedIdxs.length > 0 && (
              <div className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-800 overflow-hidden">
                <button
                  type="button"
                  onClick={() => jumpToFlaggedEdge('first', 'Home')}
                  disabled={flaggedIdxs.length < 2 || cursor === 0}
                  title="First flagged row (press Home)"
                  className="h-6 px-1 hover:bg-amber-500/20 disabled:opacity-40 disabled:hover:bg-transparent inline-flex items-center border-r border-amber-500/40"
                >
                  <ChevronLeft className="h-3 w-3" />
                  <ChevronLeft className="h-3 w-3 -ml-2" />
                </button>
                <button
                  type="button"
                  onClick={() => stepFlagged(-1, 'P')}
                  disabled={flaggedIdxs.length < 2}
                  title="Previous flagged row (press P or [)"
                  className="h-6 px-1.5 hover:bg-amber-500/20 disabled:opacity-40 disabled:hover:bg-transparent inline-flex items-center"
                >
                  <ChevronLeft className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={jumpToFlagged}
                  title="Scroll to the highlighted collection (press J)"
                  className="h-6 px-2 font-semibold hover:bg-amber-500/20 inline-flex items-center gap-1 border-x border-amber-500/40"
                >
                  <Crosshair className="h-3 w-3" />
                  <span className="tabular-nums">{cursor + 1} / {flaggedIdxs.length}</span>
                </button>
                <button
                  type="button"
                  onClick={() => stepFlagged(1, 'N')}
                  disabled={flaggedIdxs.length < 2}
                  title="Next flagged row (press N or ])"
                  className="h-6 px-1.5 hover:bg-amber-500/20 disabled:opacity-40 disabled:hover:bg-transparent inline-flex items-center"
                >
                  <ChevronRight className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => jumpToFlaggedEdge('last', 'End')}
                  disabled={flaggedIdxs.length < 2 || cursor === flaggedIdxs.length - 1}
                  title="Last flagged row (press End)"
                  className="h-6 px-1 hover:bg-amber-500/20 disabled:opacity-40 disabled:hover:bg-transparent inline-flex items-center border-l border-amber-500/40"
                >
                  <ChevronRight className="h-3 w-3" />
                  <ChevronRight className="h-3 w-3 -ml-2" />
                </button>
              </div>
            )}
            {jumpStatus && (
              <span
                key={jumpStatus.at}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-primary/10 text-primary text-[10px] font-semibold tabular-nums animate-pulse"
              >
                {jumpStatus.key} → row {jumpStatus.targetRow}
              </span>
            )}
          </div>
          {sorted.length > pageSize && (
            hasMore ? (
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setVisible((v) => v + pageSize)} className="h-6 px-2 rounded-md font-semibold bg-background border border-border hover:bg-muted">Load {Math.min(pageSize, sorted.length - effectiveVisible)} more</button>
                <button type="button" onClick={() => setVisible(sorted.length)} className="h-6 px-2 rounded-md font-semibold bg-background border border-border hover:bg-muted">Show all</button>
              </div>
            ) : (
              <button type="button" onClick={() => setVisible(pageSize)} className="h-6 px-2 rounded-md font-semibold bg-background border border-border hover:bg-muted">Collapse</button>
            )
          )}
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <div className="shrink-0 h-5 w-5 rounded-full bg-primary/10 text-primary text-[10px] font-bold inline-flex items-center justify-center">{n}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-bold text-foreground">{title}</div>
        <div className="mt-0.5 space-y-0.5">{children}</div>
      </div>
    </li>
  );
}

type MiniSortKey = 'when' | 'amount';
const DETAIL_PAGE_SIZE = 50;
function MiniCollectionTable({ rows, nameOf, stateKey }: { rows: BucketCollection[]; nameOf: (id: string | null) => string; stateKey?: string }) {
  const [sort, setSort] = useState<{ k: MiniSortKey; dir: 'asc' | 'desc' }>({ k: 'when', dir: 'asc' });
  const toggle = (k: MiniSortKey) =>
    setSort((s) => (s.k === k ? { k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { k, dir: k === 'amount' ? 'desc' : 'asc' }));
  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.k === 'amount') return ((Number(a.amount) || 0) - (Number(b.amount) || 0)) * dir;
      return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
    });
  }, [rows, sort]);
  const [pageSize, setPageSize] = usePageSizePref(stateKey, DETAIL_PAGE_SIZE);
  const [visible, setVisibleState] = useState(() =>
    (stateKey && detailPageSizeStore.get(stateKey)) || pageSize,
  );
  useEffect(() => {
    if (!stateKey) return;
    const saved = detailPageSizeStore.get(stateKey);
    setVisibleState(saved && saved > 0 ? saved : pageSize);
  }, [stateKey, pageSize]);
  const setVisible = (updater: number | ((v: number) => number)) => {
    setVisibleState((prev) => {
      const next = typeof updater === 'function' ? (updater as (v: number) => number)(prev) : updater;
      if (stateKey) detailPageSizeStore.set(stateKey, next);
      return next;
    });
  };
  const onPageSizeChange = (n: number) => {
    setPageSize(n);
    setVisible(n);
  };
  const page = sorted.slice(0, visible);
  const hasMore = sorted.length > visible;
  const Icon = ({ k }: { k: MiniSortKey }) =>
    sort.k !== k ? <ArrowUpDown className="h-3 w-3 opacity-40" /> : sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  return (
    <div className="space-y-1">
      <VirtualRows
        items={page}
        rowHeight={30}
        gridTemplate="140px minmax(120px,1.4fr) 110px 110px 90px"
        header={(
          <>
            <div className="px-2 py-1.5 text-left">
              <button type="button" onClick={() => toggle('when')} className="inline-flex items-center gap-1 hover:text-foreground">
                When (EAT) <Icon k="when" />
              </button>
            </div>
            <div className="px-2 py-1.5 text-left">Agent</div>
            <div className="px-2 py-1.5 text-left">Method</div>
            <div className="px-2 py-1.5 text-right">
              <button type="button" onClick={() => toggle('amount')} className="inline-flex items-center gap-1 justify-end w-full hover:text-foreground">
                Amount <Icon k="amount" />
              </button>
            </div>
            <div className="px-2 py-1.5 text-left">Plan</div>
          </>
        )}
        emptyMessage="No rows to display."
        renderRow={(r) => (
          <div className="contents">
            <div className="px-2 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground">{fmtWhen(new Date(r.created_at).getTime())}</div>
            <div className="px-2 py-1.5 truncate">{nameOf(r.agent_id) || '—'}</div>
            <div className="px-2 py-1.5 truncate">{(r.payment_method || '—').replace(/_/g, ' ')}</div>
            <div className="px-2 py-1.5 text-right tabular-nums font-semibold">{formatUGX(Number(r.amount) || 0)}</div>
            <div className="px-2 py-1.5 font-mono text-[9px] text-muted-foreground truncate">{r.rent_request_id?.slice(0, 8) || '—'}</div>
          </div>
        )}
      />
      {sorted.length > 0 && (
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground px-1 flex-wrap">
          <div className="flex items-center gap-2">
            <span>Showing {page.length} of {sorted.length}</span>
            <PageSizeSelect value={pageSize} onChange={onPageSizeChange} />
          </div>
          {sorted.length > pageSize && (
            hasMore ? (
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setVisible((v) => v + pageSize)} className="h-6 px-2 rounded-md font-semibold bg-background border border-border hover:bg-muted">Load {Math.min(pageSize, sorted.length - visible)} more</button>
                <button type="button" onClick={() => setVisible(sorted.length)} className="h-6 px-2 rounded-md font-semibold bg-background border border-border hover:bg-muted">Show all</button>
              </div>
            ) : (
              <button type="button" onClick={() => setVisible(pageSize)} className="h-6 px-2 rounded-md font-semibold bg-background border border-border hover:bg-muted">Collapse</button>
            )
          )}
        </div>
      )}
    </div>
  );
}