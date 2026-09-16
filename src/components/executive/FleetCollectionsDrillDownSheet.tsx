import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ArrowLeft, ArrowUp, ArrowDown, ArrowUpDown, Loader2, Receipt, Search, X, Download, AlertTriangle, BarChart3, Scale } from 'lucide-react';
import { AmountBreakdownModal } from './AmountBreakdownModal';
import { BucketReconciliationPanel } from './BucketReconciliationPanel';
import { CollectionLedgerImpactPanel } from './CollectionLedgerImpactPanel';

type CollectionRow = {
  id: string;
  agent_id: string | null;
  tenant_id: string | null;
  amount: number;
  created_at: string;
  payment_method: string | null;
  momo_provider: string | null;
  momo_phone: string | null;
  momo_payer_name: string | null;
  momo_transaction_id: string | null;
  tracking_id: string | null;
  location_name: string | null;
  notes: string | null;
  rent_request_id: string | null;
};

async function fetchFleetCollections(opts: {
  start: Date;
  end: Date;
  agentId?: string | null;
}): Promise<CollectionRow[]> {
  const { start, end, agentId } = opts;
  const all: CollectionRow[] = [];
  const PAGE = 1000;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase
      .from('agent_collections')
      .select('id, agent_id, tenant_id, amount, created_at, payment_method, momo_provider, momo_phone, momo_payer_name, momo_transaction_id, tracking_id, location_name, notes, rent_request_id').is('reversed_at', null)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .gt('amount', 0)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (agentId) q = q.eq('agent_id', agentId);
    const { data, error } = await q;
    if (error) { console.error('[FleetDrillDown] page failed', error); break; }
    const rows = (data || []) as CollectionRow[];
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
    (data || []).forEach((p: any) => {
      map.set(p.id, p.full_name || p.phone || p.id.slice(0, 8));
    });
  }
  return map;
}

type SortKey = 'when' | 'amount' | 'agent' | 'tenant' | 'method';

export function FleetCollectionsDrillDownSheet({
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
  /** Optional label like "Wed 22:00" shown in the header when drilling a trend bar. */
  bucketLabel?: string | null;
}) {
  const rangeKey = `${start.toISOString()}:${end.toISOString()}:${agentId || 'all'}`;
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['fleet-drill-collections', rangeKey],
    queryFn: () => fetchFleetCollections({ start, end, agentId }),
    enabled: open,
    staleTime: 30_000,
  });

  const nameIds = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => {
      if (r.agent_id) s.add(r.agent_id);
      if (r.tenant_id) s.add(r.tenant_id);
    });
    return Array.from(s);
  }, [rows]);

  const { data: names } = useQuery({
    queryKey: ['fleet-drill-names', rangeKey, nameIds.length],
    queryFn: () => fetchNames(nameIds),
    enabled: open && nameIds.length > 0,
    staleTime: 5 * 60_000,
  });
  const nameById = names || new Map<string, string>();

  const [query, setQuery] = useState('');
  const [method, setMethod] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('when');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [reconOpen, setReconOpen] = useState(false);

  // ============= Anomaly detection =============
  const flagsById = useMemo(() => {
    const map = new Map<string, { code: string; severity: 'high' | 'medium'; label: string; why: string }[]>();
    if (rows.length === 0) return map;

    // Precompute agent-level stats
    const byAgent = new Map<string, CollectionRow[]>();
    rows.forEach((r) => {
      const k = r.agent_id || '__none__';
      if (!byAgent.has(k)) byAgent.set(k, []);
      byAgent.get(k)!.push(r);
    });
    const agentMedian = new Map<string, number>();
    const agentDayTotals = new Map<string, Map<string, number>>(); // agent -> dayKey -> total
    const agentDayCounts = new Map<string, Map<string, number>>();
    byAgent.forEach((list, agent) => {
      const amounts = list.map((r) => Number(r.amount) || 0).sort((a, b) => a - b);
      const mid = amounts[Math.floor(amounts.length / 2)] || 0;
      agentMedian.set(agent, mid);
      const dayTotals = new Map<string, number>();
      const dayCounts = new Map<string, number>();
      list.forEach((r) => {
        const d = new Date(r.created_at);
        // Kampala calendar day
        const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
        dayTotals.set(dayKey, (dayTotals.get(dayKey) || 0) + (Number(r.amount) || 0));
        dayCounts.set(dayKey, (dayCounts.get(dayKey) || 0) + 1);
      });
      agentDayTotals.set(agent, dayTotals);
      agentDayCounts.set(agent, dayCounts);
    });

    // Sorted by time for burst / repeated-window scans
    const byAgentSorted = new Map<string, CollectionRow[]>();
    byAgent.forEach((list, k) => {
      byAgentSorted.set(k, [...list].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));
    });
    const byTenantSorted = new Map<string, CollectionRow[]>();
    rows.forEach((r) => {
      const k = r.tenant_id || '__none__';
      if (!byTenantSorted.has(k)) byTenantSorted.set(k, []);
      byTenantSorted.get(k)!.push(r);
    });
    byTenantSorted.forEach((list) => list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));

    const push = (id: string, f: { code: string; severity: 'high' | 'medium'; label: string; why: string }) => {
      if (!map.has(id)) map.set(id, []);
      const arr = map.get(id)!;
      if (!arr.some((x) => x.code === f.code)) arr.push(f);
    };

    const KAMPALA_HOUR = (iso: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', hour: '2-digit', hour12: false }).format(new Date(iso)));
    const kampalaDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      const agentKey = r.agent_id || '__none__';

      if (amt >= 500_000) {
        push(r.id, { code: 'OVERSIZED_ABSOLUTE', severity: amt >= 1_000_000 ? 'high' : 'medium', label: 'Oversized', why: `Single collection of ${formatUGX(amt)} — ≥ UGX 500,000 threshold.` });
      }
      const med = agentMedian.get(agentKey) || 0;
      if (med > 0 && amt >= 100_000 && amt >= med * 3) {
        push(r.id, { code: 'OVERSIZED_AGENT', severity: amt >= med * 5 ? 'high' : 'medium', label: 'Outlier vs agent', why: `${formatUGX(amt)} is ${(amt / med).toFixed(1)}× this agent's median collection (${formatUGX(med)}).` });
      }
      if (amt >= 1_000_000 && amt % 100_000 === 0) {
        push(r.id, { code: 'ROUND_LARGE', severity: 'medium', label: 'Round large amount', why: `Suspiciously round large sum (${formatUGX(amt)} — multiple of 100,000).` });
      }

      // Late-night collection (22:00–04:59 EAT)
      const hr = KAMPALA_HOUR(r.created_at);
      if (hr >= 22 || hr < 5) {
        push(r.id, { code: 'LATE_NIGHT', severity: 'medium', label: 'Late-night', why: `Posted at ${hr.toString().padStart(2, '0')}:xx EAT — outside normal collection hours (05:00–22:00).` });
      }

      // Tenant repeated within a 60-minute window (≥3 including this)
      const tList = byTenantSorted.get(r.tenant_id || '__none__') || [];
      if (r.tenant_id && tList.length >= 3) {
        const t = new Date(r.created_at).getTime();
        const within = tList.filter((x) => Math.abs(new Date(x.created_at).getTime() - t) <= 60 * 60_000);
        if (within.length >= 3) {
          push(r.id, { code: 'TENANT_REPEATED', severity: within.length >= 5 ? 'high' : 'medium', label: 'Tenant burst', why: `${within.length} collections for the same tenant within a 60-minute window (${formatUGX(within.reduce((s, x) => s + (Number(x.amount) || 0), 0))} total).` });
        }
      }

      // Agent burst: ≥5 collections in a 10-minute window
      const aList = byAgentSorted.get(agentKey) || [];
      if (r.agent_id && aList.length >= 5) {
        const t = new Date(r.created_at).getTime();
        const within = aList.filter((x) => Math.abs(new Date(x.created_at).getTime() - t) <= 10 * 60_000);
        if (within.length >= 5) {
          push(r.id, { code: 'AGENT_BURST', severity: within.length >= 10 ? 'high' : 'medium', label: 'Agent burst', why: `Agent posted ${within.length} collections within a 10-minute window (${formatUGX(within.reduce((s, x) => s + (Number(x.amount) || 0), 0))} total).` });
        }
      }

      // Daily concentration: single row ≥60% of that agent's day
      if (r.agent_id) {
        const dk = kampalaDay(r.created_at);
        const dayTotal = agentDayTotals.get(agentKey)?.get(dk) || 0;
        const dayCount = agentDayCounts.get(agentKey)?.get(dk) || 0;
        if (dayCount >= 3 && dayTotal > 0 && amt / dayTotal >= 0.6 && amt >= 100_000) {
          push(r.id, { code: 'AGENT_DAY_CONCENTRATION', severity: 'medium', label: 'Day concentration', why: `This single row is ${Math.round((amt / dayTotal) * 100)}% of the agent's day-total (${formatUGX(dayTotal)} across ${dayCount} rows on ${dk}).` });
        }
      }
    }
    return map;
  }, [rows]);

  const flagCounts = useMemo(() => {
    let flagged = 0, high = 0;
    flagsById.forEach((fs) => {
      flagged += 1;
      if (fs.some((f) => f.severity === 'high')) high += 1;
    });
    return { flagged, high };
  }, [flagsById]);

  const methodOptions = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => { if (r.payment_method) s.add(r.payment_method); });
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (method !== 'all' && (r.payment_method || '') !== method) return false;
      if (onlyFlagged && !flagsById.has(r.id)) return false;
      if (!q) return true;
      const agent = (r.agent_id && nameById.get(r.agent_id)) || '';
      const tenant = (r.tenant_id && nameById.get(r.tenant_id)) || '';
      const hay = `${agent} ${tenant} ${r.agent_id || ''} ${r.tenant_id || ''} ${r.id} ${r.momo_phone || ''} ${r.momo_payer_name || ''} ${r.tracking_id || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, method, nameById, onlyFlagged, flagsById]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let av: string | number = 0, bv: string | number = 0;
      if (sortKey === 'when') { av = new Date(a.created_at).getTime(); bv = new Date(b.created_at).getTime(); }
      else if (sortKey === 'amount') { av = Number(a.amount) || 0; bv = Number(b.amount) || 0; }
      else if (sortKey === 'method') { av = (a.payment_method || '').toLowerCase(); bv = (b.payment_method || '').toLowerCase(); }
      else if (sortKey === 'agent') { av = ((a.agent_id && nameById.get(a.agent_id)) || '').toLowerCase(); bv = ((b.agent_id && nameById.get(b.agent_id)) || '').toLowerCase(); }
      else if (sortKey === 'tenant') { av = ((a.tenant_id && nameById.get(a.tenant_id)) || '').toLowerCase(); bv = ((b.tenant_id && nameById.get(b.tenant_id)) || '').toLowerCase(); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [filtered, sortKey, sortDir, nameById]);

  const total = filtered.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);
  const filtersActive = query.trim() !== '' || method !== 'all' || onlyFlagged;

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'amount' || k === 'when' ? 'desc' : 'asc'); }
  };
  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const fmtWhen = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Kampala',
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));

  const rangeLabelStr = `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }).format(start)} → ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }).format(end)}`;

  const csvEscape = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const downloadCsv = () => {
    const header = ['When (EAT)', 'Agent', 'Agent ID', 'Tenant', 'Tenant ID', 'Amount UGX', 'Method', 'MoMo phone', 'MoMo payer', 'Tracking ID', 'Location', 'Notes', 'Record ID'];
    const body = sorted.map((r) => [
      fmtWhen(r.created_at),
      (r.agent_id && nameById.get(r.agent_id)) || '',
      r.agent_id || '',
      (r.tenant_id && nameById.get(r.tenant_id)) || '',
      r.tenant_id || '',
      Number(r.amount) || 0,
      (r.payment_method || '').replace(/_/g, ' '),
      r.momo_phone || '',
      r.momo_payer_name || '',
      r.tracking_id || '',
      r.location_name || '',
      r.notes || '',
      r.id,
    ]);
    const csv = [header, ...body].map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fleet_collections_${start.toISOString().slice(0,10)}_to_${new Date(end.getTime()-1).toISOString().slice(0,10)}${agentId ? `_agent_${agentId.slice(0,8)}` : ''}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) setSelectedId(null); onOpenChange(v); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        {selected ? (
          <>
            <SheetHeader>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground mb-1"
              >
                <ArrowLeft className="h-3 w-3" /> Back to records
              </button>
              <SheetTitle className="text-base">Collection record</SheetTitle>
              <SheetDescription className="text-[11px]">
                Read-only view of the underlying <code>agent_collections</code> row.
              </SheetDescription>
            </SheetHeader>
            <div className="mt-4 grid gap-2">
              <Field label="Amount" value={formatUGX(Number(selected.amount) || 0)} accent />
              <Field label="Payment method" value={(selected.payment_method || '—').replace(/_/g, ' ')} />
              <Field label="Collected at (Africa/Kampala)" value={fmtWhen(selected.created_at)} />
              <Field label="Collected at (UTC)" value={new Date(selected.created_at).toISOString()} mono />
              <Field label="Agent" value={(selected.agent_id && nameById.get(selected.agent_id)) || '—'} />
              <Field label="Agent ID" value={selected.agent_id || '—'} mono />
              <Field label="Tenant" value={(selected.tenant_id && nameById.get(selected.tenant_id)) || '—'} />
              <Field label="Tenant ID" value={selected.tenant_id || '—'} mono />
              {selected.momo_provider && <Field label="MoMo provider" value={selected.momo_provider} />}
              {selected.momo_phone && <Field label="MoMo phone" value={selected.momo_phone} />}
              {selected.momo_payer_name && <Field label="MoMo payer name" value={selected.momo_payer_name} />}
              {selected.momo_transaction_id && <Field label="MoMo transaction ID" value={selected.momo_transaction_id} mono />}
              {selected.tracking_id && <Field label="Tracking ID" value={selected.tracking_id} mono />}
              {selected.location_name && <Field label="Location" value={selected.location_name} />}
              {selected.rent_request_id && <Field label="Rent request ID" value={selected.rent_request_id} mono />}
              {selected.notes && <Field label="Notes" value={selected.notes} />}
              <Field label="Record ID" value={selected.id} mono />
            </div>
            {(() => {
              const fs = flagsById.get(selected.id) || [];
              if (!fs.length) return null;
              const hasHigh = fs.some((f) => f.severity === 'high');
              return (
                <div className={`mt-4 rounded-lg border p-3 ${hasHigh ? 'bg-rose-500/5 border-rose-500/30' : 'bg-amber-500/5 border-amber-500/30'}`}>
                  <p className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide mb-1.5 ${hasHigh ? 'text-rose-700' : 'text-amber-800'}`}>
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {fs.length} anomaly flag{fs.length === 1 ? '' : 's'}
                  </p>
                  <ul className="space-y-1">
                    {fs.map((f) => (
                      <li key={f.code} className="flex items-start gap-2 text-[11px]">
                        <span className={`mt-[3px] inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${f.severity === 'high' ? 'bg-rose-600' : 'bg-amber-500'}`} />
                        <span>
                          <span className={`font-bold ${f.severity === 'high' ? 'text-rose-700' : 'text-amber-800'}`}>{f.label}</span>
                          <span className="text-foreground"> — {f.why}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            <CollectionLedgerImpactPanel
              collectionId={selected.id}
              agentId={selected.agent_id}
              tenantId={selected.tenant_id}
              agentName={(selected.agent_id && nameById.get(selected.agent_id)) || null}
              tenantName={(selected.tenant_id && nameById.get(selected.tenant_id)) || null}
            />
          </>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="text-base inline-flex items-center gap-2">
                <Receipt className="h-4 w-4" />
                {agentId ? `${agentName || 'Agent'} · Collections` : 'Fleet collections'}
                {bucketLabel ? ` · ${bucketLabel}` : ''}
              </SheetTitle>
              <SheetDescription className="text-[11px]">
                {rangeLabelStr}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-md border border-border bg-muted/30 p-2">
                <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Rows</p>
                <p className="mt-0.5 tabular-nums font-bold">{filtered.length.toLocaleString()}{filtersActive ? ` / ${rows.length.toLocaleString()}` : ''}</p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-2">
                <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Total UGX</p>
                <p className="mt-0.5 tabular-nums font-bold text-primary">{formatUGX(total)}</p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-2">
                <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Avg / row</p>
                <p className="mt-0.5 tabular-nums font-bold">{filtered.length ? formatUGX(Math.round(total / filtered.length)) : '—'}</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <div className="relative flex-1 min-w-[10rem]">
                <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search agent, tenant, phone, tracking id…"
                  className="w-full h-7 pl-6 pr-2 rounded-md border border-border bg-background text-[11px] outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="h-7 rounded-md border border-border bg-background text-[11px] px-1.5"
              >
                <option value="all">All methods</option>
                {methodOptions.map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setOnlyFlagged((v) => !v)}
                disabled={flagCounts.flagged === 0}
                title={flagCounts.flagged === 0 ? 'No anomalies detected in this range' : 'Show only rows with anomaly flags'}
                className={`h-7 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 border transition-colors disabled:opacity-40 ${onlyFlagged ? 'bg-amber-500/10 text-amber-800 border-amber-500/40' : 'bg-background text-foreground border-border hover:bg-muted'}`}
              >
                <AlertTriangle className="h-3 w-3" />
                Flagged {flagCounts.flagged > 0 ? `(${flagCounts.flagged}${flagCounts.high ? ` · ${flagCounts.high} high` : ''})` : ''}
              </button>
              {filtersActive && (
                <button
                  type="button"
                  onClick={() => { setQuery(''); setMethod('all'); }}
                  className="h-7 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 text-muted-foreground hover:bg-muted"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
              <button
                type="button"
                onClick={downloadCsv}
                disabled={isLoading || sorted.length === 0}
                className="h-7 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-muted text-foreground hover:bg-muted/70 transition-colors disabled:opacity-40"
              >
                <Download className="h-3 w-3" /> CSV
              </button>
              <button
                type="button"
                onClick={() => setBreakdownOpen(true)}
                disabled={isLoading || sorted.length === 0}
                title="Break the filtered total into per-tenant, per-method, per-hour sub-amounts"
                className="h-7 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-primary/10 text-primary border border-primary/30 hover:bg-primary/15 transition-colors disabled:opacity-40"
              >
                <BarChart3 className="h-3 w-3" /> Breakdown
              </button>
              <button
                type="button"
                onClick={() => setReconOpen(true)}
                disabled={isLoading}
                title="Reconcile Expected vs Collected for this bucket and list the missing/extra collections driving the variance"
                className="h-7 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-violet-500/10 text-violet-800 border border-violet-500/30 hover:bg-violet-500/15 transition-colors disabled:opacity-40"
              >
                <Scale className="h-3 w-3" /> Reconcile
              </button>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : sorted.length === 0 ? (
              <p className="mt-6 text-center text-[11px] text-muted-foreground">No collection records match.</p>
            ) : (
              <div className="mt-3 rounded-md border border-border overflow-hidden">
                <div className="max-h-[65vh] overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-muted text-muted-foreground">
                      <tr>
                        <th className="w-6 px-1.5 py-1.5" />
                        {([
                          { k: 'when' as const, label: 'When', align: 'left' },
                          { k: 'agent' as const, label: 'Agent', align: 'left' },
                          { k: 'tenant' as const, label: 'Tenant', align: 'left' },
                          { k: 'method' as const, label: 'Method', align: 'left', hide: true },
                          { k: 'amount' as const, label: 'Amount', align: 'right' },
                        ]).map((h) => (
                          <th
                            key={h.k}
                            className={`${h.align === 'right' ? 'text-right' : 'text-left'} font-bold uppercase tracking-wide px-2 py-1.5 text-[9px] ${h.hide ? 'hidden sm:table-cell' : ''}`}
                          >
                            <button
                              type="button"
                              onClick={() => toggleSort(h.k)}
                              className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                            >
                              {h.label} <SortIcon k={h.k} />
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {sorted.map((r) => {
                        const fs = flagsById.get(r.id) || [];
                        const highest: 'high' | 'medium' | null = fs.some((f) => f.severity === 'high') ? 'high' : fs.length ? 'medium' : null;
                        const tip = fs.length
                          ? `Anomaly flags:\n• ${fs.map((f) => `${f.label}: ${f.why}`).join('\n• ')}`
                          : '';
                        return (
                        <tr
                          key={r.id}
                          onClick={() => setSelectedId(r.id)}
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(r.id); } }}
                          className={`cursor-pointer outline-none ${highest === 'high' ? 'bg-rose-500/5 hover:bg-rose-500/10' : highest === 'medium' ? 'bg-amber-500/5 hover:bg-amber-500/10' : 'hover:bg-primary/5'}`}
                          title="View record details"
                        >
                          <td className="px-1.5 py-1.5 align-middle">
                            {highest && (
                              <span title={tip} className={`inline-flex items-center justify-center h-4 w-4 rounded-full ${highest === 'high' ? 'bg-rose-500/15 text-rose-700' : 'bg-amber-500/15 text-amber-700'}`}>
                                <AlertTriangle className="h-2.5 w-2.5" />
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{fmtWhen(r.created_at)}</td>
                          <td className="px-2 py-1.5 truncate max-w-[9rem]">{(r.agent_id && nameById.get(r.agent_id)) || '—'}</td>
                          <td className="px-2 py-1.5 truncate max-w-[9rem]">{(r.tenant_id && nameById.get(r.tenant_id)) || '—'}</td>
                          <td className="px-2 py-1.5 text-muted-foreground hidden sm:table-cell">{(r.payment_method || '—').replace(/_/g, ' ')}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-primary">{formatUGX(Number(r.amount) || 0)}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="sticky bottom-0 bg-muted/80 backdrop-blur border-t border-border">
                      <tr>
                        <td className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide" colSpan={5}>
                          {filtersActive ? 'Filtered total' : 'Total'} · {filtered.length} row{filtered.length === 1 ? '' : 's'}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-bold text-primary">{formatUGX(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </SheetContent>
      <AmountBreakdownModal
        open={breakdownOpen}
        onOpenChange={setBreakdownOpen}
        title={agentId ? `${agentName || 'Agent'} · Collections breakdown` : 'Fleet collections breakdown'}
        rows={filtered.map((r) => ({
          id: r.id,
          amount: Number(r.amount) || 0,
          created_at: r.created_at,
          agent_id: r.agent_id,
          tenant_id: r.tenant_id,
          payment_method: r.payment_method,
          rent_request_id: r.rent_request_id,
          momo_provider: r.momo_provider,
        }))}
        nameFor={(id) => nameById.get(id) || null}
        initialDimension={agentId ? 'tenant' : 'agent'}
      />
      <BucketReconciliationPanel
        open={reconOpen}
        onOpenChange={setReconOpen}
        start={start}
        end={end}
        agentId={agentId}
        agentName={agentName}
        bucketLabel={bucketLabel}
      />
    </Sheet>
  );
}

function Field({ label, value, mono = false, accent = false }: { label: string; value: string; mono?: boolean; accent?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
      <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 break-all text-[12px] ${accent ? 'font-bold text-primary' : 'text-foreground'} ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </p>
    </div>
  );
}

export default FleetCollectionsDrillDownSheet;