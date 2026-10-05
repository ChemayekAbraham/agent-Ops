import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, FileDown, FileSpreadsheet, RefreshCw, TrendingUp, Users, HandCoins, Trophy } from 'lucide-react';
import { format, subDays, startOfMonth } from 'date-fns';
import { downloadAuditPdf } from '@/lib/pdfAuditReport';
import { SectionReportExport } from '@/components/reports/DailyRepaymentsSectionReports';


const formatUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`;
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

type CollectionRow = {
  id: string;
  created_at: string;
  amount: number | null;
  payment_method: string | null;
  tracking_id: string | null;
  momo_transaction_id: string | null;
  notes: string | null;
  float_before: number | null;
  float_after: number | null;
  agent_id: string | null;
  tenant_id: string | null;
  rent_request_id: string | null;
};

export type ReportMode = 'tenant' | 'agent';

interface Props {
  mode: ReportMode;
}

function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

function toCsv(headers: string[], rows: (string | number)[][]) {
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
}

export function DailyRentReport({ mode }: Props) {
  const qc = useQueryClient();
  const [date, setDate] = useState<string>(todayIso());
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [tenantFilter, setTenantFilter] = useState<string>('all');
  const [landlordFilter, setLandlordFilter] = useState<string>('all');
  const [propertyFilter, setPropertyFilter] = useState<string>('all');
  const [methodFilter, setMethodFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  // ---- Load agent_collections for the selected day ----
  const { data: rawCollections = [], isLoading, refetch } = useQuery({
    queryKey: ['daily-rent-report', date],
    queryFn: async () => {
      const from = new Date(`${date}T00:00:00`).toISOString();
      const to = new Date(`${date}T23:59:59.999`).toISOString();
      const { data, error } = await supabase
        .from('agent_collections')
        .select('id, created_at, amount, payment_method, tracking_id, momo_transaction_id, notes, float_before, float_after, agent_id, tenant_id, rent_request_id').is('reversed_at', null)
        .gte('created_at', from)
        .lte('created_at', to)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as CollectionRow[];
    },
    staleTime: 30_000,
  });

  // ---- Realtime: refetch on any new agent_collections row today ----
  useEffect(() => {
    const ch = supabase
      .channel(`daily-rent-report-${date}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_collections' }, () => {
        qc.invalidateQueries({ queryKey: ['daily-rent-report', date] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [date, qc]);

  // ---- Enrichment: tenants / agents / rent_requests / landlords ----
  const tenantIds = useMemo(() => [...new Set(rawCollections.map(r => r.tenant_id).filter(Boolean) as string[])], [rawCollections]);
  const agentIds = useMemo(() => [...new Set(rawCollections.map(r => r.agent_id).filter(Boolean) as string[])], [rawCollections]);
  const rentReqIds = useMemo(() => [...new Set(rawCollections.map(r => r.rent_request_id).filter(Boolean) as string[])], [rawCollections]);

  const { data: profileMap = {} } = useQuery({
    queryKey: ['daily-rent-profiles', tenantIds.sort().join(','), agentIds.sort().join(',')],
    enabled: tenantIds.length + agentIds.length > 0,
    queryFn: async () => {
      const ids = [...new Set([...tenantIds, ...agentIds])];
      const map: Record<string, { full_name: string | null; phone: string | null }> = {};
      const BATCH = 100;
      for (let i = 0; i < ids.length; i += BATCH) {
        const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids.slice(i, i + BATCH));
        (data ?? []).forEach((p: any) => { map[p.id] = { full_name: p.full_name, phone: p.phone }; });
      }
      return map;
    },
    staleTime: 5 * 60_000,
  });

  const { data: rentReqMap = {} } = useQuery({
    queryKey: ['daily-rent-rentreqs', rentReqIds.sort().join(',')],
    enabled: rentReqIds.length > 0,
    queryFn: async () => {
      const map: Record<string, any> = {};
      const BATCH = 100;
      for (let i = 0; i < rentReqIds.length; i += BATCH) {
        const { data } = await supabase
          .from('rent_requests')
          .select('id, landlord_id, house_listing_id, rent_amount, total_repayment, amount_repaid')
          .in('id', rentReqIds.slice(i, i + BATCH));
        (data ?? []).forEach((r: any) => { map[r.id] = r; });
      }
      return map;
    },
    staleTime: 5 * 60_000,
  });

  const landlordIds = useMemo(
    () => [...new Set(Object.values(rentReqMap).map((r: any) => r.landlord_id).filter(Boolean) as string[])],
    [rentReqMap],
  );
  const listingIds = useMemo(
    () => [...new Set(Object.values(rentReqMap).map((r: any) => r.house_listing_id).filter(Boolean) as string[])],
    [rentReqMap],
  );

  const { data: landlordMap = {} } = useQuery({
    queryKey: ['daily-rent-landlords', landlordIds.sort().join(',')],
    enabled: landlordIds.length > 0,
    queryFn: async () => {
      const map: Record<string, string> = {};
      const { data } = await supabase.from('landlords').select('id, full_name').in('id', landlordIds);
      (data ?? []).forEach((l: any) => { map[l.id] = l.full_name; });
      return map;
    },
    staleTime: 5 * 60_000,
  });

  const { data: listingMap = {} } = useQuery({
    queryKey: ['daily-rent-listings', listingIds.sort().join(',')],
    enabled: listingIds.length > 0,
    queryFn: async () => {
      const map: Record<string, string> = {};
      const { data } = await supabase.from('house_listings').select('id, title, address').in('id', listingIds);
      (data ?? []).forEach((h: any) => { map[h.id] = h.title || h.address || h.id.slice(0, 6); });
      return map;
    },
    staleTime: 5 * 60_000,
  });

  // ---- Build enriched rows ----
  type EnrichedRow = CollectionRow & {
    tenant_name: string;
    tenant_phone: string;
    agent_name: string;
    landlord_name: string;
    property: string;
    status: 'successful' | 'pending' | 'failed';
    commission: number;
    outstanding: number;
  };

  const enriched: EnrichedRow[] = useMemo(() => rawCollections.map(r => {
    const rr = r.rent_request_id ? rentReqMap[r.rent_request_id] : null;
    const status: EnrichedRow['status'] =
      r.amount && Number(r.amount) > 0 ? 'successful' : (Number(r.amount) === 0 ? 'pending' : 'failed');
    return {
      ...r,
      tenant_name: profileMap[r.tenant_id ?? '']?.full_name || '—',
      tenant_phone: profileMap[r.tenant_id ?? '']?.phone || '—',
      agent_name: profileMap[r.agent_id ?? '']?.full_name || '—',
      landlord_name: rr?.landlord_id ? landlordMap[rr.landlord_id] || '—' : '—',
      property: rr?.house_listing_id ? listingMap[rr.house_listing_id] || '—' : '—',
      status,
      commission: Math.round((Number(r.amount) || 0) * 0.1),
      outstanding: Math.max(0, (Number(rr?.total_repayment) || 0) - (Number(rr?.amount_repaid) || 0)),
    };
  }), [rawCollections, profileMap, rentReqMap, landlordMap, listingMap]);

  // ---- Distinct filter options ----
  const distinct = (fn: (r: EnrichedRow) => string, label: (r: EnrichedRow) => string) => {
    const seen = new Map<string, string>();
    enriched.forEach(r => { const v = fn(r); if (v && v !== '—') seen.set(v, label(r)); });
    return [...seen.entries()].map(([v, l]) => ({ value: v, label: l }));
  };
  const agentOptions = distinct(r => r.agent_id ?? '', r => r.agent_name);
  const tenantOptions = distinct(r => r.tenant_id ?? '', r => r.tenant_name);
  const landlordOptions = distinct(r => r.landlord_name, r => r.landlord_name);
  const propertyOptions = distinct(r => r.property, r => r.property);
  const methodOptions = distinct(r => r.payment_method ?? '', r => r.payment_method ?? '—');

  // ---- Apply filters ----
  const filtered = useMemo(() => enriched.filter(r => {
    if (agentFilter !== 'all' && r.agent_id !== agentFilter) return false;
    if (tenantFilter !== 'all' && r.tenant_id !== tenantFilter) return false;
    if (landlordFilter !== 'all' && r.landlord_name !== landlordFilter) return false;
    if (propertyFilter !== 'all' && r.property !== propertyFilter) return false;
    if (methodFilter !== 'all' && r.payment_method !== methodFilter) return false;
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const hay = `${r.tenant_name} ${r.tenant_phone} ${r.agent_name} ${r.landlord_name} ${r.property} ${r.tracking_id ?? ''} ${r.momo_transaction_id ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [enriched, agentFilter, tenantFilter, landlordFilter, propertyFilter, methodFilter, statusFilter, search]);

  // ---- Aggregates ----
  const totals = useMemo(() => {
    let sum = 0, count = 0, successful = 0, pending = 0, failed = 0, commission = 0, outstanding = 0;
    const seenReq = new Set<string>();
    filtered.forEach(r => {
      sum += Number(r.amount) || 0;
      count += 1;
      if (r.status === 'successful') successful += 1;
      else if (r.status === 'pending') pending += 1;
      else failed += 1;
      commission += r.commission;
      // sum outstanding once per rent_request to avoid double counting
      const key = r.rent_request_id ?? `t:${r.tenant_id}`;
      if (key && !seenReq.has(key)) {
        seenReq.add(key);
        outstanding += r.outstanding || 0;
      }
    });
    return { sum, count, successful, pending, failed, commission, outstanding, avg: count ? sum / count : 0 };
  }, [filtered]);

  // ---- Agent performance ranking ----
  const agentRanking = useMemo(() => {
    const byAgent = new Map<string, { agent_id: string; agent_name: string; count: number; total: number; commission: number; successful: number; failed: number; pending: number }>();
    filtered.forEach(r => {
      const id = r.agent_id ?? 'unknown';
      const cur = byAgent.get(id) ?? { agent_id: id, agent_name: r.agent_name, count: 0, total: 0, commission: 0, successful: 0, failed: 0, pending: 0 };
      cur.count += 1;
      cur.total += Number(r.amount) || 0;
      cur.commission += r.commission;
      if (r.status === 'successful') cur.successful += 1;
      else if (r.status === 'pending') cur.pending += 1;
      else cur.failed += 1;
      byAgent.set(id, cur);
    });
    return [...byAgent.values()].sort((a, b) => b.total - a.total);
  }, [filtered]);

  const activeAgents = agentRanking.length;
  const avgPerAgent = activeAgents ? totals.sum / activeAgents : 0;
  const highest = agentRanking[0]?.total ?? 0;
  const lowest = agentRanking.length ? agentRanking[agentRanking.length - 1].total : 0;

  // ---- Charts (scoped per section below, after rowsFor is defined) ----

  const byMethod = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach(r => { const k = r.payment_method ?? 'unknown'; map[k] = (map[k] ?? 0) + (Number(r.amount) || 0); });
    return Object.entries(map).map(([method, amount]) => ({ method, amount }));
  }, [filtered]);

  const byProperty = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach(r => { const k = r.property; map[k] = (map[k] ?? 0) + (Number(r.amount) || 0); });
    return Object.entries(map).map(([property, amount]) => ({ property, amount })).sort((a, b) => b.amount - a.amount).slice(0, 10);
  }, [filtered]);

  // ---- Exports ----
  const headers = mode === 'tenant'
    ? ['Tx ID', 'Time', 'Tenant', 'Phone', 'Property', 'Landlord', 'Agent', 'Amount (UGX)', 'Outstanding (UGX)', 'Balance Before', 'Balance After', 'Method', 'Status', 'Receipt']
    : ['Time', 'Agent', 'Agent ID', 'Tenant', 'Property', 'Landlord', 'Amount (UGX)', 'Commission (UGX)', 'Method', 'Status', 'Receipt'];

  const bodyRows = useMemo(() => filtered.map(r => mode === 'tenant'
    ? [
        r.id.slice(0, 8),
        format(new Date(r.created_at), 'HH:mm:ss'),
        r.tenant_name, r.tenant_phone, r.property, r.landlord_name, r.agent_name,
        Number(r.amount) || 0,
        r.outstanding,
        Number(r.float_before) || 0,
        Number(r.float_after) || 0,
        r.payment_method ?? '—', r.status,
        r.tracking_id ?? r.momo_transaction_id ?? '—',
      ]
    : [
        format(new Date(r.created_at), 'HH:mm:ss'),
        r.agent_name, (r.agent_id ?? '').slice(0, 8), r.tenant_name, r.property, r.landlord_name,
        Number(r.amount) || 0, r.commission,
        r.payment_method ?? '—', r.status,
        r.tracking_id ?? r.momo_transaction_id ?? '—',
      ]),
    [filtered, mode],
  );
  const statusColIndex = headers.findIndex(h => h === 'Status');

  const filterSummary = () => [
    `Date: ${date}`,
    ...(agentFilter !== 'all' ? [`Agent: ${agentOptions.find(o => o.value === agentFilter)?.label ?? agentFilter}`] : []),
    ...(tenantFilter !== 'all' ? [`Tenant: ${tenantOptions.find(o => o.value === tenantFilter)?.label ?? tenantFilter}`] : []),
    ...(landlordFilter !== 'all' ? [`Landlord: ${landlordFilter}`] : []),
    ...(propertyFilter !== 'all' ? [`Property: ${propertyFilter}`] : []),
    ...(methodFilter !== 'all' ? [`Method: ${methodFilter}`] : []),
    ...(statusFilter !== 'all' ? [`Status: ${statusFilter}`] : []),
    ...(search.trim() ? [`Search: ${search}`] : []),
  ];

  const exportCsv = () => {
    const csv = toCsv(headers, bodyRows as any);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-${mode === 'tenant' ? 'repayments' : 'collections'}-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPdf = async () => {
    await downloadAuditPdf(
      `daily-${mode === 'tenant' ? 'repayments' : 'collections'}-${date}.pdf`,
      headers,
      bodyRows as any,
      {
        title: mode === 'tenant'
          ? `Daily Rent Repayments — ${date}`
          : `Daily Rent Collections — ${date}`,
        subtitle: mode === 'tenant'
          ? 'Ledger-confirmed tenant repayments'
          : 'Ledger-confirmed agent collections',
        filters: filterSummary(),
        footerLabel: mode === 'tenant' ? 'Welile · Tenant Ops' : 'Welile · Agent Ops',
        kpis: mode === 'tenant'
          ? [
              { label: 'Total Repaid', value: formatUGX(totals.sum), hint: `${totals.count} transactions`, accent: [16, 122, 87] },
              { label: 'Total Outstanding', value: formatUGX(totals.outstanding), hint: 'still owed by tenants', accent: [190, 44, 44] },
              { label: 'Average Payment', value: formatUGX(Math.round(totals.avg)), hint: 'per transaction', accent: [88, 28, 135] },
              { label: 'Successful', value: String(totals.successful), hint: `${totals.count ? Math.round((totals.successful / totals.count) * 100) : 0}% success rate`, accent: [16, 122, 87] },
              { label: 'Pending', value: String(totals.pending), hint: 'awaiting confirmation', accent: [202, 138, 4] },
              { label: 'Failed', value: String(totals.failed), hint: 'requires review', accent: [190, 44, 44] },
              { label: 'Unique Tenants', value: String(new Set(filtered.map(r => r.tenant_id)).size), hint: 'active today', accent: [30, 64, 175] },
            ]
          : [
              { label: 'Total Collected', value: formatUGX(totals.sum), hint: `${totals.count} transactions`, accent: [16, 122, 87] },
              { label: 'Total Commission', value: formatUGX(totals.commission), hint: 'earned by agents', accent: [146, 52, 234] },
              { label: 'Active Agents', value: String(activeAgents), hint: `avg ${formatUGX(Math.round(avgPerAgent))} each`, accent: [88, 28, 135] },
              { label: 'Top Agent', value: formatUGX(highest), hint: agentRanking[0]?.agent_name ?? '—', accent: [16, 122, 87] },
              { label: 'Successful', value: String(totals.successful), hint: `${totals.count ? Math.round((totals.successful / totals.count) * 100) : 0}% success rate`, accent: [16, 122, 87] },
              { label: 'Pending / Failed', value: `${totals.pending} / ${totals.failed}`, hint: 'need attention', accent: [202, 138, 4] },
            ],
      },
    );
  };

  // ══════════════════════════════════════════════════════════════════════════
  // Per-section reporting. Each section can narrow its own window inside the
  // period already loaded (no extra queries), and exports exactly the filtered
  // rows shown on screen — CSV, Excel and PDF share one payload builder.
  // ══════════════════════════════════════════════════════════════════════════
  const modeWord = mode === 'tenant' ? 'Repayments' : 'Collections';
  const fileBase = mode === 'tenant' ? 'daily-repayments' : 'daily-collections';
  const periodLabel = (f: string, t: string) => (f === t ? f : `${f} to ${t}`);

  // Loaded window bounds, normalised so a swapped From/To still bounds the
  // per-section date pickers correctly.
  const periodFrom = date <= dateTo ? date : dateTo;
  const periodTo = date <= dateTo ? dateTo : date;

  const rangeFor = (key: string) => secRange[key] ?? { from: date, to: dateTo };
  const setRange = (key: string, next: { from: string; to: string }) =>
    setSecRange(prev => ({ ...prev, [key]: next }));
  const rowsFor = (key: string) => {
    const { from, to } = rangeFor(key);
    if (from === date && to === dateTo) return filtered;
    return filtered.filter(r => {
      const d = format(new Date(r.created_at), 'yyyy-MM-dd');
      return d >= from && d <= to;
    });
  };

  // ── Section-scoped views ───────────────────────────────────────────────────
  // Each chart / table renders the SAME rows its own export writes, so a section
  // date picker visibly narrows the section and the exported file matches the
  // screen exactly. Aggregation functions and data sources are unchanged.
  const hourRows = rowsFor('hour');
  const methodRows = rowsFor('method');
  const propertyRows = rowsFor('property');
  const txRows = rowsFor('transactions');
  const agentRows = rowsFor('agents');

  const byHour = aggByHour(hourRows);
  const byMethod = aggByMethod(methodRows);
  const byProperty = aggByProperty(propertyRows);
  const txTotals = aggTotals(txRows);
  const agentTable = aggAgents(agentRows);

  const txBodyRows = useMemo(() => txRows.map(r => (mode === 'tenant'
    ? [
        r.id.slice(0, 8),
        format(new Date(r.created_at), 'HH:mm:ss'),
        r.tenant_name, r.tenant_phone, r.property, r.landlord_name, r.agent_name,
        Number(r.amount) || 0,
        r.outstanding,
        Number(r.float_before) || 0,
        Number(r.float_after) || 0,
        r.payment_method ?? '—', r.status,
        r.tracking_id ?? r.momo_transaction_id ?? '—',
      ]
    : [
        format(new Date(r.created_at), 'HH:mm:ss'),
        r.agent_name, (r.agent_id ?? '').slice(0, 8), r.tenant_name, r.property, r.landlord_name,
        Number(r.amount) || 0, r.commission,
        r.payment_method ?? '—', r.status,
        r.tracking_id ?? r.momo_transaction_id ?? '—',
      ])), [txRows, mode]);

  // ── Top summary cards: scopeable to a day or a sub-period ──────────────────
  // The cards read the SAME rows as the "Summary" section report (key 'summary'),
  // so whatever the cards show is exactly what the Summary export contains.
  // Charts, tables and the page-level exports keep their existing scope — none of
  // their calculations or data sources change.
  const clampDay = (d: string) => (d < date ? date : d > dateTo ? dateTo : d);
  const cardPresets: { key: string; label: string; from: string; to: string }[] = [
    { key: 'period', label: 'Whole period', from: date, to: dateTo },
    { key: 'today', label: 'Today', from: clampDay(todayIso()), to: clampDay(todayIso()) },
    {
      key: 'yesterday',
      label: 'Yesterday',
      from: clampDay(format(subDays(new Date(), 1), 'yyyy-MM-dd')),
      to: clampDay(format(subDays(new Date(), 1), 'yyyy-MM-dd')),
    },
    {
      key: '7d',
      label: 'Last 7 days',
      from: clampDay(format(subDays(new Date(), 6), 'yyyy-MM-dd')),
      to: clampDay(todayIso()),
    },
    {
      key: 'mtd',
      label: 'Month to date',
      from: clampDay(format(startOfMonth(new Date()), 'yyyy-MM-dd')),
      to: clampDay(todayIso()),
    },
  ];
  const cardScope = rangeFor('summary');
  const activeCardPreset = cardPresets.find(p => p.from === cardScope.from && p.to === cardScope.to)?.key ?? 'custom';
  const cardRows = rowsFor('summary');
  const cardTotals = aggTotals(cardRows);
  const cardAgents = aggAgents(cardRows);
  const cardActiveAgents = cardAgents.length;
  const cardAvgPerAgent = cardActiveAgents ? cardTotals.sum / cardActiveAgents : 0;
  const cardHighest = cardAgents[0]?.total ?? 0;
  const cardLowest = cardAgents.length ? cardAgents[cardAgents.length - 1].total : 0;



  const summarySheet = (rows: EnrichedRow[]) => {
    const t = aggTotals(rows);
    const agents = aggAgents(rows);
    const base: (string | number)[][] = [
      [`Total Rent ${mode === 'tenant' ? 'Repaid' : 'Collected'} (UGX)`, Math.round(t.sum)],
      ['Transactions', t.count],
      ['Successful', t.successful],
      ['Pending', t.pending],
      ['Failed', t.failed],
      ['Average per Transaction (UGX)', Math.round(t.avg)],
      ['Unique Tenants', new Set(rows.map(r => r.tenant_id)).size],
    ];
    if (mode === 'tenant') {
      base.splice(1, 0, ['Total Outstanding (UGX)', Math.round(t.outstanding)]);
    } else {
      base.push(['Total Commission (UGX)', Math.round(t.commission)]);
      base.push(['Active Agents', agents.length]);
      base.push(['Avg per Agent (UGX)', agents.length ? Math.round(t.sum / agents.length) : 0]);
      base.push(['Highest Agent (UGX)', Math.round(agents[0]?.total ?? 0)]);
      base.push(['Lowest Agent (UGX)', Math.round(agents.length ? agents[agents.length - 1].total : 0)]);
    }
    return { headers: ['Metric', 'Value'], rows: base };
  };

  const hourSheet = (rows: EnrichedRow[]) => ({
    headers: ['Hour', `Amount ${modeWord} (UGX)`, 'Transactions'],
    rows: aggByHour(rows).map(h => [
      `${h.hour}:00`,
      Math.round(h.amount),
      rows.filter(r => format(new Date(r.created_at), 'HH') === h.hour).length,
    ]) as (string | number)[][],
  });

  const methodSheet = (rows: EnrichedRow[]) => {
    const agg = aggByMethod(rows);
    const total = agg.reduce((s, m) => s + m.amount, 0);
    return {
      headers: ['Payment Method', 'Amount (UGX)', 'Transactions', 'Share %'],
      rows: agg.map(m => [
        m.method,
        Math.round(m.amount),
        rows.filter(r => (r.payment_method ?? 'unknown') === m.method).length,
        total ? Number(((m.amount / total) * 100).toFixed(1)) : 0,
      ]) as (string | number)[][],
    };
  };

  const propertySheet = (rows: EnrichedRow[]) => ({
    headers: ['Property', 'Landlord', 'Amount (UGX)', 'Transactions'],
    rows: aggByProperty(rows, 1000).map(p => {
      const rs = rows.filter(r => r.property === p.property);
      return [p.property, rs[0]?.landlord_name ?? '—', Math.round(p.amount), rs.length];
    }) as (string | number)[][],
  });

  const transactionsSheet = (rows: EnrichedRow[]) => ({
    headers,
    rows: rows.map(r => (mode === 'tenant'
      ? [
          r.id.slice(0, 8),
          format(new Date(r.created_at), 'yyyy-MM-dd HH:mm:ss'),
          r.tenant_name, r.tenant_phone, r.property, r.landlord_name, r.agent_name,
          Number(r.amount) || 0, r.outstanding,
          Number(r.float_before) || 0, Number(r.float_after) || 0,
          r.payment_method ?? '—', r.status,
          r.tracking_id ?? r.momo_transaction_id ?? '—',
        ]
      : [
          format(new Date(r.created_at), 'yyyy-MM-dd HH:mm:ss'),
          r.agent_name, (r.agent_id ?? '').slice(0, 8), r.tenant_name, r.property, r.landlord_name,
          Number(r.amount) || 0, r.commission,
          r.payment_method ?? '—', r.status,
          r.tracking_id ?? r.momo_transaction_id ?? '—',
        ])) as (string | number)[][],
  });

  const agentSheet = (rows: EnrichedRow[]) => ({
    headers: ['Agent', 'Agent ID', 'Collections', 'Total (UGX)', 'Commission (UGX)', 'Avg Size (UGX)', 'Successful', 'Failed', 'Pending', 'Success Rate %'],
    rows: aggAgents(rows).map(a => [
      a.agent_name, a.agent_id.slice(0, 8), a.count, Math.round(a.total), Math.round(a.commission),
      a.count ? Math.round(a.total / a.count) : 0, a.successful, a.failed, a.pending,
      a.count ? Number(((a.successful / a.count) * 100).toFixed(1)) : 0,
    ]) as (string | number)[][],
  });

  const sectionMeta: Record<string, { title: string; build: (rows: EnrichedRow[]) => { headers: string[]; rows: (string | number)[][] } }> = {
    summary: { title: `${modeWord} Summary`, build: summarySheet },
    hour: { title: `${modeWord} by Hour`, build: hourSheet },
    method: { title: 'By Payment Method', build: methodSheet },
    property: { title: 'Properties', build: propertySheet },
    transactions: { title: `Daily ${modeWord}`, build: transactionsSheet },
    agents: { title: 'Agent Performance', build: agentSheet },
  };

  const sectionFilters = (key: string) => {
    const { from, to } = rangeFor(key);
    return [`Section period: ${periodLabel(from, to)}`, ...filterSummary().slice(1)];
  };

  const exportSectionCsv = (key: string) => {
    const rows = rowsFor(key);
    const { headers: h, rows: r } = sectionMeta[key].build(rows);
    const { from, to } = rangeFor(key);
    downloadCsv(`${fileBase}-${key}-${periodLabel(from, to).replace(/ /g, '')}.csv`, h, r);
  };

  const exportSectionXlsx = async (key: string) => {
    const rows = rowsFor(key);
    const { headers: h, rows: r } = sectionMeta[key].build(rows);
    const { from, to } = rangeFor(key);
    await downloadXlsx(
      `${fileBase}-${key}-${periodLabel(from, to).replace(/ /g, '')}.xlsx`,
      h, r, sectionMeta[key].title,
    );
  };

  const exportSectionPdf = async (key: string) => {
    const rows = rowsFor(key);
    const { headers: h, rows: r } = sectionMeta[key].build(rows);
    const t = aggTotals(rows);
    const { from, to } = rangeFor(key);
    await downloadAuditPdf(
      `${fileBase}-${key}-${periodLabel(from, to).replace(/ /g, '')}.pdf`,
      h, r as any,
      {
        title: `${sectionMeta[key].title} — ${periodLabel(from, to)}`,
        subtitle: mode === 'tenant' ? 'Tenant Ops · Daily Repayments' : 'Agent Ops · Daily Collections',
        filters: sectionFilters(key),
        footerLabel: mode === 'tenant' ? 'Welile · Tenant Ops' : 'Welile · Agent Ops',
        kpis: [
          { label: `Total ${mode === 'tenant' ? 'Repaid' : 'Collected'}`, value: formatUGX(t.sum), hint: `${t.count} transactions`, accent: [16, 122, 87] },
          { label: 'Successful', value: String(t.successful), hint: `${t.count ? Math.round((t.successful / t.count) * 100) : 0}% success rate`, accent: [16, 122, 87] },
          { label: 'Pending / Failed', value: `${t.pending} / ${t.failed}`, hint: 'need attention', accent: [202, 138, 4] },
          { label: 'Average', value: formatUGX(Math.round(t.avg)), hint: 'per transaction', accent: [88, 28, 135] },
        ],
      },
    );
  };

  // ---- Comprehensive report: every section of the page in one file ----
  const comprehensiveSheets = () => {
    const rows = rowsFor('comprehensive');
    const { from, to } = rangeFor('comprehensive');
    const sheets = [
      { name: 'Report Info', headers: ['Field', 'Value'], rows: [
        ['Report', `Daily ${modeWord} — comprehensive`],
        ['Period', periodLabel(from, to)],
        ['Generated', format(new Date(), 'yyyy-MM-dd HH:mm:ss')],
        ...filterSummary().slice(1).map(f => ['Filter', f]),
        ['Rows included', rows.length],
      ] as (string | number)[][] },
      { name: 'Summary', ...summarySheet(rows) },
      { name: 'By Hour', ...hourSheet(rows) },
      { name: 'By Method', ...methodSheet(rows) },
      { name: 'Properties', ...propertySheet(rows) },
      { name: 'Transactions', ...transactionsSheet(rows) },
      { name: 'Agent Performance', ...agentSheet(rows) },
    ];
    return { sheets, rows, from, to };
  };

  const exportComprehensiveXlsx = async () => {
    const { sheets, from, to } = comprehensiveSheets();
    await downloadXlsxWorkbook(`${fileBase}-comprehensive-${periodLabel(from, to).replace(/ /g, '')}.xlsx`, sheets);
  };

  const exportComprehensiveCsv = () => {
    const { sheets, from, to } = comprehensiveSheets();
    // One CSV, each section stacked with its own header block.
    const lines: (string | number)[][] = [];
    sheets.forEach(s => {
      lines.push([`== ${s.name} ==`]);
      lines.push(s.headers as any);
      s.rows.forEach(r => lines.push(r));
      lines.push([]);
    });
    downloadCsv(
      `${fileBase}-comprehensive-${periodLabel(from, to).replace(/ /g, '')}.csv`,
      ['Daily ' + modeWord + ' — comprehensive report'],
      lines,
    );
  };

  const exportComprehensivePdf = async () => {
    const { rows, from, to } = comprehensiveSheets();
    const t = aggTotals(rows);
    const agents = aggAgents(rows);
    const sec = summarySheet(rows);
    const body: (string | number)[][] = [
      ...sec.rows.map(r => ['Summary', String(r[0]), r[1]]),
      ...hourSheet(rows).rows.filter(r => Number(r[1]) > 0).map(r => ['By Hour', String(r[0]), r[1]]),
      ...methodSheet(rows).rows.map(r => ['By Method', String(r[0]), r[1]]),
      ...propertySheet(rows).rows.slice(0, 25).map(r => ['Property', String(r[0]), r[2]]),
      ...agentSheet(rows).rows.map(r => ['Agent', String(r[0]), r[3]]),
    ];
    await downloadAuditPdf(
      `${fileBase}-comprehensive-${periodLabel(from, to).replace(/ /g, '')}.pdf`,
      ['Section', 'Item', 'Amount / Value'],
      body as any,
      {
        title: `Daily ${modeWord} — Comprehensive Report`,
        subtitle: `Period ${periodLabel(from, to)} · ${rows.length} transactions`,
        filters: sectionFilters('comprehensive'),
        footerLabel: mode === 'tenant' ? 'Welile · Tenant Ops' : 'Welile · Agent Ops',
        kpis: [
          { label: `Total ${mode === 'tenant' ? 'Repaid' : 'Collected'}`, value: formatUGX(t.sum), hint: `${t.count} transactions`, accent: [16, 122, 87] },
          { label: 'Total Outstanding', value: formatUGX(t.outstanding), hint: 'still owed by tenants', accent: [190, 44, 44] },
          { label: 'Commission', value: formatUGX(t.commission), hint: 'agent earnings', accent: [146, 52, 234] },
          { label: 'Active Agents', value: String(agents.length), hint: `top ${formatUGX(Math.round(agents[0]?.total ?? 0))}`, accent: [88, 28, 135] },
          { label: 'Successful', value: String(t.successful), hint: `${t.count ? Math.round((t.successful / t.count) * 100) : 0}% success rate`, accent: [16, 122, 87] },
          { label: 'Pending / Failed', value: `${t.pending} / ${t.failed}`, hint: 'requires review', accent: [202, 138, 4] },
        ],
      },
    );
  };

  const bar = (key: string, title: string, extra?: string) => (
    <SectionReportBar
      title={title}
      from={rangeFor(key).from}
      to={rangeFor(key).to}
      minDate={periodFrom}
      maxDate={periodTo}
      onFromChange={v => setRange(key, { ...rangeFor(key), from: v })}
      onToChange={v => setRange(key, { ...rangeFor(key), to: v })}
      onReset={() => setRange(key, { from: date, to: dateTo })}
      onCsv={() => exportSectionCsv(key)}
      onXlsx={() => exportSectionXlsx(key)}
      onPdf={() => exportSectionPdf(key)}
      disabled={!rowsFor(key).length}
      extra={extra}
    />
  );


  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card className="p-3 grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-2">
        <div className="space-y-1 min-w-0">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From</label>
          <Input type="date" value={date} onChange={e => { setDate(e.target.value); setSecRange({}); }} className="h-9 w-full sm:w-40" />
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">To</label>
          <Input type="date" value={dateTo} min={date} onChange={e => { setDateTo(e.target.value); setSecRange({}); }} className="h-9 w-full sm:w-40" />
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Agent</label>
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="h-9 w-full sm:w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All agents</SelectItem>{agentOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tenant</label>
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            <SelectTrigger className="h-9 w-full sm:w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All tenants</SelectItem>{tenantOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Landlord</label>
          <Select value={landlordFilter} onValueChange={setLandlordFilter}>
            <SelectTrigger className="h-9 w-full sm:w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem>{landlordOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Property</label>
          <Select value={propertyFilter} onValueChange={setPropertyFilter}>
            <SelectTrigger className="h-9 w-full sm:w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem>{propertyOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Method</label>
          <Select value={methodFilter} onValueChange={setMethodFilter}>
            <SelectTrigger className="h-9 w-full sm:w-32"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem>{methodOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-0">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Status</label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-full sm:w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="successful">Successful</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 col-span-2 min-w-0 sm:min-w-[180px] sm:flex-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Search</label>
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, phone, receipt…" className="h-9" />
        </div>
        <div className="col-span-2 flex flex-wrap gap-1.5 sm:ml-auto">
          <Button size="sm" variant="outline" onClick={() => refetch()} className="h-9 gap-1.5"><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!filtered.length} className="h-9 gap-1.5"><FileSpreadsheet className="h-3.5 w-3.5" />CSV</Button>
          <Button size="sm" variant="outline" onClick={exportPdf} disabled={!filtered.length} className="h-9 gap-1.5"><FileDown className="h-3.5 w-3.5" />PDF</Button>
          <SectionReportExport section="comprehensive" mode={mode} pageDate={date} variant="prominent" />
        </div>
      </Card>

      {/* Summary cards — scope selector (day / period) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Cards period
        </span>
        {cardPresets.map(p => (
          <Button
            key={p.key}
            size="sm"
            variant={activeCardPreset === p.key ? 'default' : 'outline'}
            onClick={() => setRange('summary', { from: p.from, to: p.to })}
            className="h-7 px-2.5 text-[11px]"
          >
            {p.label}
          </Button>
        ))}
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={cardScope.from}
            min={periodFrom}
            max={periodTo}
            onChange={e => setRange('summary', { ...cardScope, from: e.target.value })}
            className="h-7 w-[130px] text-[11px]"
            aria-label="Cards period from"
          />
          <span className="text-[10px] text-muted-foreground">to</span>
          <Input
            type="date"
            value={cardScope.to}
            min={periodFrom}
            max={periodTo}
            onChange={e => setRange('summary', { ...cardScope, to: e.target.value })}
            className="h-7 w-[130px] text-[11px]"
            aria-label="Cards period to"
          />
        </div>
        <Badge variant="secondary" className="text-[10px]">
          {periodLabel(cardScope.from, cardScope.to)} · {cardRows.length} rows
        </Badge>
      </div>

      {/* Summary cards */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</div>
        <SectionReportExport section="summary" mode={mode} pageDate={date} />
      </div>

      {mode === 'tenant' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-2">
          <SummaryCard label="Total Rent Repaid" value={formatUGX(cardTotals.sum)} icon={HandCoins} tone="bg-emerald-500/10 text-emerald-700" />
          <SummaryCard label="Total Outstanding" value={formatUGX(cardTotals.outstanding)} tone="bg-rose-500/10 text-rose-700" />
          <SummaryCard label="Repayments" value={String(cardTotals.count)} icon={TrendingUp} />
          <SummaryCard label="Average" value={formatUGX(Math.round(cardTotals.avg))} />
          <SummaryCard label="Successful" value={String(cardTotals.successful)} tone="bg-emerald-500/10 text-emerald-700" />
          <SummaryCard label="Failed" value={String(cardTotals.failed)} tone="bg-rose-500/10 text-rose-700" />
          <SummaryCard label="Pending" value={String(cardTotals.pending)} tone="bg-amber-500/10 text-amber-700" />
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          <SummaryCard label="Total Collected" value={formatUGX(cardTotals.sum)} icon={HandCoins} tone="bg-emerald-500/10 text-emerald-700" />
          <SummaryCard label="Collections" value={String(cardTotals.count)} icon={TrendingUp} />
          <SummaryCard label="Active Agents" value={String(cardActiveAgents)} icon={Users} />
          <SummaryCard label="Avg per Agent" value={formatUGX(Math.round(cardAvgPerAgent))} />
          <SummaryCard label="Highest" value={formatUGX(cardHighest)} icon={Trophy} tone="bg-amber-500/10 text-amber-700" />
          <SummaryCard label="Lowest" value={formatUGX(cardLowest)} />
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold">{mode === 'tenant' ? 'Repayments' : 'Collections'} by Hour</div>
            <SectionReportExport section="hourly" mode={mode} pageDate={date} />
          </div>

          <div className="h-52">
            <ResponsiveContainer>
              <BarChart data={byHour}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="hour" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : String(v)} />
                <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold">By Payment Method</div>
            <SectionReportExport section="method" mode={mode} pageDate={date} />
          </div>

          <div className="h-52">
            <ResponsiveContainer>
              <BarChart data={byMethod}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="method" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : String(v)} />
                <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold">Top Properties</div>
            <SectionReportExport section="property" mode={mode} pageDate={date} />
          </div>

          <div className="h-52">
            <ResponsiveContainer>
              <BarChart data={byProperty} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : String(v)} />
                <YAxis type="category" dataKey="property" tick={{ fontSize: 9 }} width={90} />
                <Tooltip formatter={(v: any) => formatUGX(Number(v))} />
                <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Table */}
      {(() => null)()}
      <Card className="p-0 overflow-hidden">
        <div className="p-3 border-b flex items-center justify-between">
          <div className="text-sm font-semibold">
            {mode === 'tenant' ? 'Daily Repayments' : 'Daily Collections'} · {txRows.length} rows
          </div>
          <div className="flex items-center gap-2">
            {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <SectionReportExport section="transactions" mode={mode} pageDate={date} />
          </div>

        </div>
        <div className="overflow-x-auto max-h-[560px]">
          <table className="w-full text-xs">
            <thead className="bg-muted sticky top-0 z-10">
              <tr>
                {headers.map(h => <th key={h} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {txRows.length === 0 && (
                <tr><td colSpan={headers.length} className="px-3 py-6 text-center text-muted-foreground">No rows for this period.</td></tr>
              )}
              {txRows.map((r, rowIdx) => (
                <tr key={r.id} className="border-t hover:bg-muted/40">
                  {(txBodyRows[rowIdx] ?? []).map((cell, i) => (
                    <td key={i} className="px-2 py-1.5 whitespace-nowrap">
                      {i === statusColIndex ? (
                        <Badge variant={r.status === 'successful' ? 'default' : r.status === 'pending' ? 'secondary' : 'destructive'} className="text-[10px]">{r.status}</Badge>
                      ) : typeof cell === 'number' ? (cell as number).toLocaleString() : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {txRows.length > 0 && (
              <tfoot className="bg-muted/60 font-semibold">
                <tr>
                  <td colSpan={headers.length - 1} className="px-2 py-1.5 text-right">Total</td>
                  <td className="px-2 py-1.5">{formatUGX(txTotals.sum)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {/* Agent performance (agent mode only) */}
      {mode === 'agent' && (
        <Card className="p-0 overflow-hidden">
          <div className="p-3 border-b flex items-center justify-between">
            <div className="text-sm font-semibold">Agent Performance — sorted by amount</div>
            <SectionReportExport section="agents" mode={mode} pageDate={date} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted">
                <tr>
                  {['Agent', 'Collections', 'Total', 'Commission', 'Avg Size', 'Successful', 'Failed', 'Pending', 'Success Rate'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {agentTable.map(a => {
                  const rate = a.count ? (a.successful / a.count) * 100 : 0;
                  return (
                    <tr key={a.agent_id} className="border-t">
                      <td className="px-2 py-1.5">{a.agent_name}</td>
                      <td className="px-2 py-1.5">{a.count}</td>
                      <td className="px-2 py-1.5">{formatUGX(a.total)}</td>
                      <td className="px-2 py-1.5">{formatUGX(a.commission)}</td>
                      <td className="px-2 py-1.5">{formatUGX(a.count ? Math.round(a.total / a.count) : 0)}</td>
                      <td className="px-2 py-1.5">{a.successful}</td>
                      <td className="px-2 py-1.5">{a.failed}</td>
                      <td className="px-2 py-1.5">{a.pending}</td>
                      <td className="px-2 py-1.5">{rate.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Totals footer */}
      <Card className="p-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div><div className="text-muted-foreground">Total Rent {mode === 'tenant' ? 'Repaid' : 'Collected'}</div><div className="text-lg font-bold">{formatUGX(totals.sum)}</div></div>
          <div><div className="text-muted-foreground">Successful</div><div className="text-lg font-bold text-emerald-700">{totals.successful}</div></div>
          <div><div className="text-muted-foreground">Failed</div><div className="text-lg font-bold text-rose-700">{totals.failed}</div></div>
          <div><div className="text-muted-foreground">Pending</div><div className="text-lg font-bold text-amber-700">{totals.pending}</div></div>
        </div>
      </Card>

      {/* Comprehensive report — every section of this page in one file */}
      <Card className="p-0 overflow-hidden">
        <div className="p-3 border-b">
          <div className="text-sm font-semibold">Comprehensive Report — whole page</div>
          <div className="text-[11px] text-muted-foreground">
            Summary, hourly, payment methods, properties, transactions and agent performance for the
            selected period and filters. Excel exports one sheet per section.
          </div>
        </div>
        <SectionReportBar
          title="Comprehensive"
          from={rangeFor('comprehensive').from}
          to={rangeFor('comprehensive').to}
          minDate={periodFrom}
          maxDate={periodTo}
          onFromChange={v => setRange('comprehensive', { ...rangeFor('comprehensive'), from: v })}
          onToChange={v => setRange('comprehensive', { ...rangeFor('comprehensive'), to: v })}
          onReset={() => setRange('comprehensive', { from: date, to: dateTo })}
          onCsv={exportComprehensiveCsv}
          onXlsx={exportComprehensiveXlsx}
          onPdf={exportComprehensivePdf}
          disabled={!rowsFor('comprehensive').length}
          extra={`${rowsFor('comprehensive').length} rows`}
        />
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, icon: Icon, tone }: { label: string; value: string; icon?: any; tone?: string }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2">
        {Icon && <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${tone ?? 'bg-primary/10 text-primary'}`}><Icon className="h-4 w-4" /></div>}
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="text-sm font-bold truncate">{value}</div>
        </div>
      </div>
    </Card>
  );
}