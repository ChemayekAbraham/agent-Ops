import { useMemo, useState } from 'react';
import { format, subDays, startOfMonth, startOfDay, endOfDay, eachDayOfInterval, differenceInCalendarDays } from 'date-fns';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  PieChart, Pie, Cell, BarChart,
} from 'recharts';
import {
  Users, UserPlus, Clock, CheckCircle2, XCircle, Banknote, FileCheck, AlertTriangle,
  TrendingUp, TrendingDown, Wallet, Landmark, Search, X, CalendarIcon, Download, FileText,
  ArrowUpDown, ChevronLeft, ChevronRight, MapPin, RefreshCw, Printer, History, Loader2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { KPICard } from '../KPICard';
import { LandlordAgreementHistory } from '@/components/landlord/agreement';
import { downloadCsv } from '@/lib/csvExport';
import { downloadXlsx } from '@/lib/xlsxExport';
import {
  generatePipelineHubReportPdf, downloadPipelineReportBlob, printPipelineReportBlob, PipelineReportSection,
} from '@/lib/pipelineHubReportPdf';
import { useAuth } from '@/hooks/useAuth';
import { useRentRequestLifecycle } from '@/hooks/useRentRequestLifecycle';
import {
  useTenantPipelineHubData, PIPELINE_STATUS_GROUPS, STATUS_LABELS, PipelineRequestRow,
} from '@/hooks/useTenantPipelineHubData';

/**
 * Tenant Operations → Pipeline Status Hub.
 *
 * A centralised VISIBILITY / ANALYTICS / REPORTING workspace over the rent
 * request pipeline that already exists. It performs no approvals and creates
 * no new statuses — every figure is read from rent_requests, agent_collections
 * and agent_landlord_payouts.
 */

const ugx = (n: number) => `UGX ${Math.round(n || 0).toLocaleString()}`;
const shortUgx = (n: number) => {
  const v = Math.round(n || 0);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1_000)}K`;
  return String(v);
};

type DateBasis = 'created_at' | 'approved_at' | 'funded_at' | 'disbursed_at' | 'rejected_at';

const DATE_BASIS_LABEL: Record<DateBasis, string> = {
  created_at: 'Date applied',
  approved_at: 'Date approved',
  funded_at: 'Date funded',
  disbursed_at: 'Date disbursed',
  rejected_at: 'Date rejected',
};

/** Lifecycle flags that exist as timestamps rather than statuses. */
type LifecycleFlag = 'all' | 'returned' | 'resubmitted';
const FLAG_LABEL: Record<LifecycleFlag, string> = {
  all: 'Any history',
  returned: 'Returned for correction',
  resubmitted: 'Resubmitted by agent',
};

const PRESETS: { key: string; label: string; make: () => { from: Date; to: Date } }[] = [
  { key: 'today', label: 'Today', make: () => ({ from: startOfDay(new Date()), to: endOfDay(new Date()) }) },
  { key: '7d', label: 'Last 7 days', make: () => ({ from: startOfDay(subDays(new Date(), 6)), to: endOfDay(new Date()) }) },
  { key: '30d', label: 'Last 30 days', make: () => ({ from: startOfDay(subDays(new Date(), 29)), to: endOfDay(new Date()) }) },
  { key: 'mtd', label: 'This month', make: () => ({ from: startOfMonth(new Date()), to: endOfDay(new Date()) }) },
  { key: '90d', label: 'Last 90 days', make: () => ({ from: startOfDay(subDays(new Date(), 89)), to: endOfDay(new Date()) }) },
];

const PIE_COLORS = ['#f59e0b', '#3b82f6', '#0ea5e9', '#22c55e', '#a855f7', '#10b981', '#ef4444', '#f43f5e', '#64748b'];

const inRange = (iso: string | null | undefined, from: Date, to: Date) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= from.getTime() && t <= to.getTime();
};

const pct = (current: number, previous: number): number | null => {
  if (!previous) return current ? 100 : null;
  return ((current - previous) / previous) * 100;
};

interface Props {
  onOpenTenant?: (tenantId: string, tenantName: string) => void;
  /** Optional lifecycle group to preselect when the hub is deep-linked from
   *  the Classic "Pipeline status" tiles. Must be a PIPELINE_STATUS_GROUPS key. */
  initialStatusKey?: string;
}

export function PipelineStatusHub({ onOpenTenant, initialStatusKey }: Props) {
  const { data, isLoading, isFetching, refetch, error } = useTenantPipelineHubData();
  const { user, role } = useAuth();

  const [presetKey, setPresetKey] = useState('today');
  const [range, setRange] = useState<{ from: Date; to: Date }>(() => PRESETS[0].make());
  const [dateBasis, setDateBasis] = useState<DateBasis>('created_at');
  const [statusKey, setStatusKey] = useState(() =>
    initialStatusKey && PIPELINE_STATUS_GROUPS.some((g) => g.key === initialStatusKey)
      ? initialStatusKey
      : 'all',
  );
  const [search, setSearch] = useState('');
  const [district, setDistrict] = useState('all');
  const [agent, setAgent] = useState('all');
  const [amountBand, setAmountBand] = useState('all');
  const [flag, setFlag] = useState<LifecycleFlag>('all');
  const [sortKey, setSortKey] = useState<'date' | 'tenant' | 'amount' | 'outstanding' | 'status'>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<'overview' | 'tenants' | 'financials' | 'reports'>('overview');
  const [detail, setDetail] = useState<PipelineRequestRow | null>(null);
  const [reportType, setReportType] = useState('full');
  const [exporting, setExporting] = useState(false);

  const PER_PAGE = 25;

  const requests = data?.requests ?? [];
  const collections = data?.collections ?? [];
  const payouts = data?.payouts ?? [];

  const applyPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    setPresetKey(key);
    setRange(p.make());
    setPage(0);
  };

  const rangeDays = Math.max(1, differenceInCalendarDays(range.to, range.from) + 1);
  const prevRange = useMemo(() => {
    const to = endOfDay(subDays(range.from, 1));
    const from = startOfDay(subDays(range.from, rangeDays));
    return { from, to };
  }, [range.from, rangeDays]);

  const statusGroup = PIPELINE_STATUS_GROUPS.find((g) => g.key === statusKey) ?? PIPELINE_STATUS_GROUPS[0];

  const districts = useMemo(
    () => [...new Set(requests.map((r) => r.district).filter((d) => d && d !== '—'))].sort(),
    [requests],
  );
  const agents = useMemo(() => {
    const map = new Map<string, string>();
    requests.forEach((r) => { if (r.agent_id) map.set(r.agent_id, r.agent_name); });
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [requests]);

  /** Rows scoped by the current date range + every active filter. */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = requests.filter((r) => inRange(r[dateBasis], range.from, range.to));
    if (statusGroup.statuses.length) rows = rows.filter((r) => statusGroup.statuses.includes(r.status));
    if (district !== 'all') rows = rows.filter((r) => r.district === district);
    if (agent !== 'all') rows = rows.filter((r) => r.agent_id === agent);
    if (flag === 'returned') rows = rows.filter((r) => !!r.returned_at);
    if (flag === 'resubmitted') rows = rows.filter((r) => !!r.resubmitted_at);
    if (amountBand !== 'all') {
      rows = rows.filter((r) => {
        if (amountBand === 'lt300') return r.rent_amount < 300_000;
        if (amountBand === '300to1m') return r.rent_amount >= 300_000 && r.rent_amount < 1_000_000;
        if (amountBand === 'gte1m') return r.rent_amount >= 1_000_000;
        if (amountBand === 'outstanding') return r.outstanding > 0;
        return true;
      });
    }
    if (q) rows = rows.filter((r) => r.search_text.includes(q));

    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case 'tenant': return a.tenant_name.localeCompare(b.tenant_name) * dir;
        case 'amount': return (a.rent_amount - b.rent_amount) * dir;
        case 'outstanding': return (a.outstanding - b.outstanding) * dir;
        case 'status': return a.status.localeCompare(b.status) * dir;
        default: {
          const av = new Date(a[dateBasis] || 0).getTime();
          const bv = new Date(b[dateBasis] || 0).getTime();
          return (av - bv) * dir;
        }
      }
    });
  }, [requests, dateBasis, range, statusGroup, district, agent, flag, amountBand, search, sortKey, sortDir]);

  /**
   * Chip counts must obey the SAME date range and non-status filters as the
   * table, otherwise a chip can advertise a number the table never shows.
   */
  const chipBase = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = requests.filter((r) => inRange(r[dateBasis], range.from, range.to));
    if (district !== 'all') rows = rows.filter((r) => r.district === district);
    if (agent !== 'all') rows = rows.filter((r) => r.agent_id === agent);
    if (flag === 'returned') rows = rows.filter((r) => !!r.returned_at);
    if (flag === 'resubmitted') rows = rows.filter((r) => !!r.resubmitted_at);
    if (amountBand !== 'all') {
      rows = rows.filter((r) => {
        if (amountBand === 'lt300') return r.rent_amount < 300_000;
        if (amountBand === '300to1m') return r.rent_amount >= 300_000 && r.rent_amount < 1_000_000;
        if (amountBand === 'gte1m') return r.rent_amount >= 1_000_000;
        if (amountBand === 'outstanding') return r.outstanding > 0;
        return true;
      });
    }
    if (q) rows = rows.filter((r) => r.search_text.includes(q));
    return rows;
  }, [requests, dateBasis, range, district, agent, flag, amountBand, search]);

  const pageRows = filtered.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));

  /** Location/agent filter predicate reused for collections & payouts. */
  const requestById = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests]);
  const tenantScope = useMemo(() => new Set(filtered.map((r) => r.tenant_id).filter(Boolean) as string[]), [filtered]);
  const scopeUnfiltered = district === 'all' && agent === 'all' && !search.trim() && statusKey === 'all' && amountBand === 'all';

  const collectionsInRange = useMemo(
    () => collections.filter((c) =>
      inRange(c.created_at, range.from, range.to) &&
      (scopeUnfiltered || (c.tenant_id ? tenantScope.has(c.tenant_id) : false)),
    ),
    [collections, range, scopeUnfiltered, tenantScope],
  );
  const collectionsPrev = useMemo(
    () => collections.filter((c) =>
      inRange(c.created_at, prevRange.from, prevRange.to) &&
      (scopeUnfiltered || (c.tenant_id ? tenantScope.has(c.tenant_id) : false)),
    ),
    [collections, prevRange, scopeUnfiltered, tenantScope],
  );
  const payoutsInRange = useMemo(
    () => payouts.filter((p) =>
      inRange(p.created_at, range.from, range.to) &&
      (scopeUnfiltered || (p.tenant_id ? tenantScope.has(p.tenant_id) : false)),
    ),
    [payouts, range, scopeUnfiltered, tenantScope],
  );
  const payoutsPrev = useMemo(
    () => payouts.filter((p) =>
      inRange(p.created_at, prevRange.from, prevRange.to) &&
      (scopeUnfiltered || (p.tenant_id ? tenantScope.has(p.tenant_id) : false)),
    ),
    [payouts, prevRange, scopeUnfiltered, tenantScope],
  );

  /** Lifecycle counts for a window (date-aware, from real timestamps). */
  const windowStats = (from: Date, to: Date) => {
    const applied = requests.filter((r) => inRange(r.created_at, from, to));
    const approved = requests.filter((r) => inRange(r.approved_at, from, to));
    const rejected = requests.filter((r) => inRange(r.rejected_at, from, to));
    const funded = requests.filter((r) => inRange(r.funded_at, from, to));
    const disbursed = requests.filter((r) => inRange(r.disbursed_at, from, to));
    const newTenants = new Set(approved.map((r) => r.tenant_id).filter(Boolean));
    return {
      applied: applied.length,
      approved: approved.length,
      rejected: rejected.length,
      funded: funded.length,
      disbursed: disbursed.length,
      newTenants: newTenants.size,
      fundedValue: funded.reduce((s, r) => s + r.rent_amount, 0),
      appliedValue: applied.reduce((s, r) => s + r.rent_amount, 0),
    };
  };

  const cur = useMemo(() => windowStats(range.from, range.to), [requests, range]);
  const prev = useMemo(() => windowStats(prevRange.from, prevRange.to), [requests, prevRange]);

  const collectedTotal = collectionsInRange.reduce((s, c) => s + c.amount, 0);
  const collectedPrevTotal = collectionsPrev.reduce((s, c) => s + c.amount, 0);
  const payoutTotal = payoutsInRange.reduce((s, p) => s + p.amount, 0);
  const payoutPrevTotal = payoutsPrev.reduce((s, p) => s + p.amount, 0);

  const activeTodayIds = useMemo(() => {
    const t0 = startOfDay(new Date()).getTime();
    return new Set(
      collections
        .filter((c) => new Date(c.created_at).getTime() >= t0 && c.tenant_id)
        .map((c) => c.tenant_id as string),
    );
  }, [collections]);

  const payingTenantsInRange = new Set(collectionsInRange.map((c) => c.tenant_id).filter(Boolean) as string[]);

  /** Live status snapshot (current state of the book, not date-scoped). */
  const snapshot = useMemo(() => {
    const count = (keys: string[]) => requests.filter((r) => keys.includes(r.status)).length;
    return {
      pending: count(['pending', 'service_center_review']),
      inPipeline: count(['agent_ops_approved', 'tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved']),
      funded: count(['funded', 'disbursed']),
      repaying: count(['repaying']),
      completed: count(['fully_repaid', 'completed']),
      defaulted: count(['defaulted']),
      rejected: count(['rejected']),
      cancelled: count(['cancelled', 'deleted_by_agent']),
    };
  }, [requests]);

  /** Receivables / payables from the active book (all live plans). */
  const book = useMemo(() => {
    const live = requests.filter((r) => ['funded', 'disbursed', 'repaying'].includes(r.status));
    const expected = live.reduce((s, r) => s + r.total_repayment, 0);
    const repaid = live.reduce((s, r) => s + r.amount_repaid, 0);
    const outstanding = live.reduce((s, r) => s + r.outstanding, 0);
    const dailyExpected = live.reduce((s, r) => s + r.daily_repayment, 0);
    const defaulted = requests.filter((r) => r.status === 'defaulted');
    return {
      live: live.length,
      expected,
      repaid,
      outstanding,
      dailyExpected,
      expectedInRange: dailyExpected * rangeDays,
      defaultedOutstanding: defaulted.reduce((s, r) => s + r.outstanding, 0),
      recovery: expected ? (repaid / expected) * 100 : 0,
    };
  }, [requests, rangeDays]);

  /** Daily activity series for the selected range. */
  const daily = useMemo(() => {
    const days = eachDayOfInterval({ start: range.from, end: range.to }).slice(-120);
    const key = (d: Date) => format(d, 'yyyy-MM-dd');
    const bucket = new Map(days.map((d) => [key(d), {
      day: format(d, days.length > 45 ? 'dd/MM' : 'dd MMM'),
      applied: 0, approved: 0, rejected: 0, funded: 0, collected: 0, paidOut: 0,
    }]));
    const bump = (iso: string | null, field: 'applied' | 'approved' | 'rejected' | 'funded', amt = 1) => {
      if (!iso) return;
      const b = bucket.get(format(new Date(iso), 'yyyy-MM-dd'));
      if (b) (b as any)[field] += amt;
    };
    requests.forEach((r) => {
      if (inRange(r.created_at, range.from, range.to)) bump(r.created_at, 'applied');
      if (inRange(r.approved_at, range.from, range.to)) bump(r.approved_at, 'approved');
      if (inRange(r.rejected_at, range.from, range.to)) bump(r.rejected_at, 'rejected');
      if (inRange(r.funded_at, range.from, range.to)) bump(r.funded_at, 'funded');
    });
    collectionsInRange.forEach((c) => {
      const b = bucket.get(format(new Date(c.created_at), 'yyyy-MM-dd'));
      if (b) b.collected += c.amount;
    });
    payoutsInRange.forEach((p) => {
      const b = bucket.get(format(new Date(p.created_at), 'yyyy-MM-dd'));
      if (b) b.paidOut += p.amount;
    });
    return [...bucket.values()];
  }, [requests, collectionsInRange, payoutsInRange, range]);

  const statusDistribution = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((r) => map.set(r.status, (map.get(r.status) || 0) + 1));
    return [...map.entries()]
      .map(([status, value]) => ({ name: STATUS_LABELS[status] || status, value }))
      .sort((a, b) => b.value - a.value);
  }, [filtered]);

  /** Per-agent performance over the filtered set + in-range collections. */
  const agentPerformance = useMemo(() => {
    const map = new Map<string, {
      agent: string; applied: number; approved: number; rejected: number; funded: number;
      rentValue: number; outstanding: number; collected: number;
    }>();
    const get = (id: string, name: string) => {
      if (!map.has(id)) map.set(id, { agent: name, applied: 0, approved: 0, rejected: 0, funded: 0, rentValue: 0, outstanding: 0, collected: 0 });
      return map.get(id)!;
    };
    filtered.forEach((r) => {
      const e = get(r.agent_id || 'unassigned', r.agent_name);
      e.applied += 1;
      e.rentValue += r.rent_amount;
      e.outstanding += r.outstanding;
      if (inRange(r.approved_at, range.from, range.to)) e.approved += 1;
      if (inRange(r.rejected_at, range.from, range.to)) e.rejected += 1;
      if (inRange(r.funded_at, range.from, range.to)) e.funded += 1;
    });
    collectionsInRange.forEach((c) => {
      if (!c.agent_id) return;
      const name = requests.find((r) => r.agent_id === c.agent_id)?.agent_name || 'Agent';
      get(c.agent_id, name).collected += c.amount;
    });
    return [...map.values()].sort((a, b) => b.collected - a.collected || b.applied - a.applied);
  }, [filtered, collectionsInRange, range, requests]);

  /** Landlord relationships / payables view. */
  const landlordRows = useMemo(() => {
    const map = new Map<string, { landlord: string; phone: string; tenants: Set<string>; requests: number; rentValue: number; outstanding: number; paidOut: number }>();
    filtered.forEach((r) => {
      const id = r.landlord_id || 'unknown';
      if (!map.has(id)) map.set(id, { landlord: r.landlord_name, phone: r.landlord_phone, tenants: new Set(), requests: 0, rentValue: 0, outstanding: 0, paidOut: 0 });
      const e = map.get(id)!;
      e.requests += 1;
      e.rentValue += r.rent_amount;
      e.outstanding += r.outstanding;
      if (r.tenant_id) e.tenants.add(r.tenant_id);
    });
    payoutsInRange.forEach((p) => {
      const id = p.landlord_id || 'unknown';
      if (!map.has(id)) map.set(id, { landlord: p.landlord_name || '—', phone: '—', tenants: new Set(), requests: 0, rentValue: 0, outstanding: 0, paidOut: 0 });
      map.get(id)!.paidOut += p.amount;
    });
    return [...map.values()].sort((a, b) => b.paidOut - a.paidOut || b.rentValue - a.rentValue);
  }, [filtered, payoutsInRange]);

  const districtRows = useMemo(() => {
    const map = new Map<string, { district: string; requests: number; rentValue: number; outstanding: number; tenants: Set<string> }>();
    filtered.forEach((r) => {
      const d = r.district || '—';
      if (!map.has(d)) map.set(d, { district: d, requests: 0, rentValue: 0, outstanding: 0, tenants: new Set() });
      const e = map.get(d)!;
      e.requests += 1;
      e.rentValue += r.rent_amount;
      e.outstanding += r.outstanding;
      if (r.tenant_id) e.tenants.add(r.tenant_id);
    });
    return [...map.values()].sort((a, b) => b.requests - a.requests);
  }, [filtered]);

  const resetFilters = () => {
    setSearch(''); setDistrict('all'); setAgent('all'); setAmountBand('all'); setStatusKey('all'); setFlag('all'); setPage(0);
  };

  const activeFilterCount = [search.trim() ? 1 : 0, district !== 'all' ? 1 : 0, agent !== 'all' ? 1 : 0, amountBand !== 'all' ? 1 : 0, statusKey !== 'all' ? 1 : 0, flag !== 'all' ? 1 : 0]
    .reduce((a, b) => a + b, 0);

  // ---------------------------------------------------------------- exports
  const filterSummary = [
    { label: 'Status', value: statusGroup.label },
    { label: 'Date basis', value: DATE_BASIS_LABEL[dateBasis] },
    { label: 'District', value: district === 'all' ? 'All districts' : district },
    { label: 'Agent', value: agent === 'all' ? 'All agents' : (agents.find(([id]) => id === agent)?.[1] ?? agent) },
    { label: 'Amount', value: amountBand === 'all' ? 'Any' : amountBand === 'outstanding' ? 'With outstanding' : amountBand },
    { label: 'History', value: FLAG_LABEL[flag] },
    { label: 'Search', value: search.trim() || '—' },
  ];

  const actorLabel = user?.email || 'Signed-in operator';
  const reportAudit = (exportFormat: string) => ({
    generatedBy: actorLabel,
    role: role || null,
    exportFormat,
    records: filtered.length,
    dateBasis: DATE_BASIS_LABEL[dateBasis],
    sources: 'rent_requests (lifecycle + status), agent_collections (tenant receipts), agent_landlord_payouts + general_ledger rent_disbursement legs (landlord payments), audit_logs (lifecycle history)',
  });

  /** Audit header rows prepended to CSV / Excel so every file self-identifies. */
  const auditPreamble = (exportFormat: string): (string | number)[][] => [
    ['Report', 'Tenant Pipeline Report', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['Generated by', actorLabel, 'Role', role || '—', 'Generated at', format(new Date(), 'dd MMM yyyy HH:mm:ss'), 'Format', exportFormat, '', '', '', '', '', '', ''],
    ['Period', `${format(range.from, 'dd MMM yyyy')} – ${format(range.to, 'dd MMM yyyy')}`, 'Measured on', DATE_BASIS_LABEL[dateBasis], 'Records', filtered.length, '', '', '', '', '', '', '', '', ''],
    ['Filters', filterSummary.map((f) => `${f.label}: ${f.value}`).join(' | '), '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];

  const tableHeaders = [
    'Tenant', 'Phone', 'Status', 'Agent', 'Landlord', 'House', 'District',
    'Applied', 'Approved', 'Funded', 'Rent (UGX)', 'Daily (UGX)', 'Total repayment (UGX)', 'Repaid (UGX)', 'Outstanding (UGX)',
  ];
  const tableRows = () => filtered.map((r) => [
    r.tenant_name, r.tenant_phone, STATUS_LABELS[r.status] || r.status, r.agent_name, r.landlord_name,
    r.house_title, r.district,
    r.created_at ? format(new Date(r.created_at), 'dd MMM yyyy') : '',
    r.approved_at ? format(new Date(r.approved_at), 'dd MMM yyyy') : '',
    r.funded_at ? format(new Date(r.funded_at), 'dd MMM yyyy') : '',
    Math.round(r.rent_amount), Math.round(r.daily_repayment), Math.round(r.total_repayment),
    Math.round(r.amount_repaid), Math.round(r.outstanding),
  ]);

  const reportSections = (): PipelineReportSection[] => {
    const sections: PipelineReportSection[] = [];
    const wantAll = reportType === 'full';

    if (wantAll || reportType === 'status') {
      sections.push({
        title: 'Status distribution',
        note: 'Counts of rent requests in the filtered set, by their current pipeline status.',
        headers: ['Status', 'Requests', 'Share'],
        rows: statusDistribution.map((s) => [s.name, s.value, `${((s.value / Math.max(1, filtered.length)) * 100).toFixed(1)}%`]),
        widths: [3, 1, 1],
      });
    }
    if (wantAll || reportType === 'receivables') {
      sections.push({
        title: 'Receivables — money expected from tenants',
        note: 'Live plans (funded, disbursed, repaying) across the whole book, plus collections recorded in this period.',
        headers: ['Metric', 'Value'],
        rows: [
          ['Live rent plans', book.live],
          ['Total repayment expected', ugx(book.expected)],
          ['Collected to date', ugx(book.repaid)],
          ['Outstanding receivable', ugx(book.outstanding)],
          ['Daily expected across live plans', ugx(book.dailyExpected)],
          ['Expected in this period', ugx(book.expectedInRange)],
          ['Collected in this period', ugx(collectedTotal)],
          ['Collection rate vs expected (period)', `${book.expectedInRange ? ((collectedTotal / book.expectedInRange) * 100).toFixed(1) : '0.0'}%`],
          ['Recovery rate (book)', `${book.recovery.toFixed(1)}%`],
          ['Outstanding on defaulted plans', ugx(book.defaultedOutstanding)],
        ],
        widths: [2, 1],
      });
    }
    if (wantAll || reportType === 'payables') {
      sections.push({
        title: 'Payables — landlord relationships & payouts',
        note: 'Landlord payouts recorded in this period, alongside the rent value routed through each landlord in the filtered set.',
        headers: ['Landlord', 'Phone', 'Tenants', 'Requests', 'Rent value', 'Tenant outstanding', 'Paid out (period)'],
        rows: landlordRows.slice(0, 80).map((l) => [
          l.landlord, l.phone, l.tenants.size, l.requests, ugx(l.rentValue), ugx(l.outstanding), ugx(l.paidOut),
        ]),
        widths: [2.2, 1.2, 0.8, 0.8, 1.2, 1.3, 1.3],
      });
    }
    if (wantAll || reportType === 'agents') {
      sections.push({
        title: 'Agent performance',
        note: 'Per-agent activity for the selected period and filters.',
        headers: ['Agent', 'Requests', 'Approved', 'Rejected', 'Funded', 'Rent value', 'Outstanding', 'Collected (period)'],
        rows: agentPerformance.slice(0, 80).map((a) => [
          a.agent, a.applied, a.approved, a.rejected, a.funded, ugx(a.rentValue), ugx(a.outstanding), ugx(a.collected),
        ]),
        widths: [2, 0.9, 0.9, 0.9, 0.9, 1.2, 1.2, 1.3],
      });
    }
    if (wantAll || reportType === 'locations') {
      sections.push({
        title: 'District performance',
        headers: ['District', 'Requests', 'Tenants', 'Rent value', 'Outstanding'],
        rows: districtRows.slice(0, 60).map((d) => [d.district, d.requests, d.tenants.size, ugx(d.rentValue), ugx(d.outstanding)]),
        widths: [2, 1, 1, 1.4, 1.4],
      });
    }
    if (wantAll || reportType === 'daily') {
      sections.push({
        title: 'Daily activity',
        note: 'Applications, approvals, rejections, fundings, collections and landlord payouts per day.',
        headers: ['Day', 'Applied', 'Approved', 'Rejected', 'Funded', 'Collected', 'Paid to landlords'],
        rows: daily.map((d) => [d.day, d.applied, d.approved, d.rejected, d.funded, ugx(d.collected), ugx(d.paidOut)]),
        widths: [1.2, 1, 1, 1, 1, 1.4, 1.6],
      });
    }
    if (wantAll || reportType === 'tenants') {
      sections.push({
        title: `Tenant pipeline — ${statusGroup.label} (${filtered.length} records)`,
        headers: ['Tenant', 'Phone', 'Status', 'Agent', 'Landlord', 'District', DATE_BASIS_LABEL[dateBasis], 'Rent', 'Daily', 'Repaid', 'Outstanding'],
        rows: filtered.slice(0, 600).map((r) => [
          r.tenant_name, r.tenant_phone, STATUS_LABELS[r.status] || r.status, r.agent_name, r.landlord_name, r.district,
          r[dateBasis] ? format(new Date(r[dateBasis] as string), 'dd MMM yyyy') : '—',
          ugx(r.rent_amount), ugx(r.daily_repayment), ugx(r.amount_repaid), ugx(r.outstanding),
        ]),
        widths: [1.7, 1.2, 1.2, 1.4, 1.4, 1, 1.1, 1.1, 0.9, 1, 1.1],
      });
    }
    return sections;
  };

  const buildPdf = (exportFormat: string) =>
    generatePipelineHubReportPdf({
        title: 'Tenant Pipeline Report',
        subtitle: 'Operational and financial view of the rent-request pipeline. Figures reflect the filters and date range applied on screen.',
        range,
        filters: filterSummary,
        audit: reportAudit(exportFormat),
        kpis: [
          { label: 'Applications received', value: String(cur.applied), hint: `Prev ${prev.applied}` },
          { label: 'New tenants added', value: String(cur.newTenants), hint: 'Approved in period' },
          { label: 'Approved', value: String(cur.approved), hint: `Prev ${prev.approved}` },
          { label: 'Rejected', value: String(cur.rejected), hint: `Prev ${prev.rejected}` },
          { label: 'Funded', value: String(cur.funded), hint: ugx(cur.fundedValue) },
          { label: 'Collected (period)', value: ugx(collectedTotal), hint: `Prev ${ugx(collectedPrevTotal)}` },
          { label: 'Paid to landlords', value: ugx(payoutTotal), hint: `Prev ${ugx(payoutPrevTotal)}` },
          { label: 'Outstanding receivable', value: ugx(book.outstanding), hint: `${book.live} live plans` },
          { label: 'Tenants paying (period)', value: String(payingTenantsInRange.size), hint: `${activeTodayIds.size} paid today` },
          { label: 'Records in view', value: String(filtered.length), hint: statusGroup.label },
        ],
        sections: reportSections(),
    });

  const handlePdf = () => {
    setExporting(true);
    try {
      const blob = buildPdf('PDF');
      downloadPipelineReportBlob(blob, `tenant-pipeline-${reportType}-${format(range.from, 'yyyyMMdd')}-${format(range.to, 'yyyyMMdd')}.pdf`);
      toast.success('Report generated');
    } catch (e: any) {
      toast.error(e?.message || 'Could not generate the report');
    } finally {
      setExporting(false);
    }
  };

  const handlePrint = () => {
    setExporting(true);
    try {
      const opened = printPipelineReportBlob(buildPdf('Print'));
      if (opened) toast.success('Report opened — use your browser print dialog');
      else toast.error('Your browser blocked the print window. Allow pop-ups and try again.');
    } catch (e: any) {
      toast.error(e?.message || 'Could not prepare the printable report');
    } finally {
      setExporting(false);
    }
  };

  const handleCsv = () => {
    downloadCsv(
      `tenant-pipeline-${format(range.from, 'yyyyMMdd')}-${format(range.to, 'yyyyMMdd')}.csv`,
      tableHeaders,
      [...auditPreamble('CSV'), ...tableRows()],
    );
    toast.success('CSV exported');
  };
  const handleXlsx = async () => {
    setExporting(true);
    try {
      await downloadXlsx(
        `tenant-pipeline-${format(range.from, 'yyyyMMdd')}-${format(range.to, 'yyyyMMdd')}.xlsx`,
        tableHeaders,
        [...auditPreamble('Excel'), ...tableRows()],
        'Pipeline',
      );
      toast.success('Excel exported');
    } catch (e: any) {
      toast.error(e?.message || 'Excel export failed');
    } finally {
      setExporting(false);
    }
  };

  // ------------------------------------------------------------------- UI
  const Delta = ({ value }: { value: number | null }) => {
    if (value === null) return <span className="text-muted-foreground">—</span>;
    const up = value >= 0;
    return (
      <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium', up ? 'text-emerald-600' : 'text-rose-600')}>
        {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
        {Math.abs(value).toFixed(0)}%
      </span>
    );
  };

  const StatTile = ({ label, value, delta, hint }: { label: string; value: string; delta?: number | null; hint?: string }) => (
    <div className="rounded-xl border border-border bg-card p-3 min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p className="text-lg font-bold text-foreground mt-0.5 break-words">{value}</p>
      <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
        {delta !== undefined && <Delta value={delta ?? null} />}
        {hint && <span className="text-[10px] text-muted-foreground truncate">{hint}</span>}
      </div>
    </div>
  );

  if (error) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="p-6 text-center space-y-3">
          <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
          <p className="text-sm text-muted-foreground">Could not load the pipeline data.</p>
          <Button size="sm" onClick={() => refetch()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4 w-full min-w-0">
      {/* ---------------- Header + date range ---------------- */}
      <Card className="overflow-hidden">
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-bold text-foreground">Pipeline Status Hub</h2>
              <p className="text-xs text-muted-foreground">
                Everything about tenants and their rent requests — statuses, agents, landlords, locations and money — in one place.
              </p>
            </div>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={presetKey === p.key ? 'default' : 'outline'}
                className="h-7 px-2.5 text-[11px]"
                onClick={() => applyPreset(p.key)}
              >
                {p.label}
              </Button>
            ))}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 px-2.5 text-[11px] gap-1.5">
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {format(range.from, 'dd MMM')} – {format(range.to, 'dd MMM yyyy')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 max-w-[95vw]" align="start">
                <Calendar
                  mode="range"
                  selected={{ from: range.from, to: range.to }}
                  onSelect={(v: any) => {
                    if (v?.from) {
                      setPresetKey('custom');
                      setRange({ from: startOfDay(v.from), to: endOfDay(v.to || v.from) });
                      setPage(0);
                    }
                  }}
                  numberOfMonths={1}
                  className="pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
            <Select value={dateBasis} onValueChange={(v) => { setDateBasis(v as DateBasis); setPage(0); }}>
              <SelectTrigger className="h-7 w-[140px] text-[11px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(DATE_BASIS_LABEL) as DateBasis[]).map((k) => (
                  <SelectItem key={k} value={k} className="text-xs">{DATE_BASIS_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[10px] text-muted-foreground">
              vs {format(prevRange.from, 'dd MMM')} – {format(prevRange.to, 'dd MMM')}
            </span>
          </div>

          {/* Status navigation */}
          <div className="-mx-1 overflow-x-auto pb-1">
            <div className="flex items-center gap-1.5 px-1 min-w-max">
              {PIPELINE_STATUS_GROUPS.map((g) => {
                const count = g.statuses.length
                  ? chipBase.filter((r) => g.statuses.includes(r.status)).length
                  : chipBase.length;
                return (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => { setStatusKey(g.key); setPage(0); }}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium whitespace-nowrap transition-colors min-h-[32px]',
                      statusKey === g.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted',
                    )}
                  >
                    {g.label}
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-semibold">{count}</Badge>
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Chip counts follow the selected period and filters, so they always match the table and every export.
          </p>
        </CardContent>
      </Card>

      {/* ---------------- Tabs ---------------- */}
      <div className="-mx-1 overflow-x-auto">
        <div className="flex items-center gap-1.5 px-1 min-w-max">
          {([
            { k: 'overview', l: 'Overview' },
            { k: 'tenants', l: 'Tenants' },
            { k: 'financials', l: 'Financials' },
            { k: 'reports', l: 'Reports & exports' },
          ] as const).map((t) => (
            <Button
              key={t.k}
              size="sm"
              variant={tab === t.k ? 'default' : 'outline'}
              className="h-8 text-xs"
              onClick={() => setTab(t.k)}
            >
              {t.l}
            </Button>
          ))}
        </div>
      </div>

      {/* ---------------- Filters ---------------- */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search tenant, phone, agent, landlord, house, district…"
                className="h-9 pl-8 pr-8 text-xs"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 sm:flex gap-2">
              <Select value={district} onValueChange={(v) => { setDistrict(v); setPage(0); }}>
                <SelectTrigger className="h-9 sm:w-[150px] text-xs"><SelectValue placeholder="District" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="all" className="text-xs">All districts</SelectItem>
                  {districts.map((d) => <SelectItem key={d} value={d} className="text-xs">{d}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={agent} onValueChange={(v) => { setAgent(v); setPage(0); }}>
                <SelectTrigger className="h-9 sm:w-[160px] text-xs"><SelectValue placeholder="Agent" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="all" className="text-xs">All agents</SelectItem>
                  {agents.map(([id, name]) => <SelectItem key={id} value={id} className="text-xs">{name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={amountBand} onValueChange={(v) => { setAmountBand(v); setPage(0); }}>
                <SelectTrigger className="h-9 sm:w-[150px] text-xs"><SelectValue placeholder="Amount" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">Any amount</SelectItem>
                  <SelectItem value="lt300" className="text-xs">Rent under 300K</SelectItem>
                  <SelectItem value="300to1m" className="text-xs">Rent 300K – 1M</SelectItem>
                  <SelectItem value="gte1m" className="text-xs">Rent 1M+</SelectItem>
                  <SelectItem value="outstanding" className="text-xs">Has outstanding</SelectItem>
                </SelectContent>
              </Select>
              <Select value={flag} onValueChange={(v) => { setFlag(v as LifecycleFlag); setPage(0); }}>
                <SelectTrigger className="h-9 sm:w-[170px] text-xs"><SelectValue placeholder="History" /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(FLAG_LABEL) as LifecycleFlag[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">{FLAG_LABEL[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeFilterCount > 0 && (
                <Button variant="ghost" size="sm" className="h-9 text-xs gap-1" onClick={resetFilters}>
                  <X className="h-3.5 w-3.5" /> Reset
                </Button>
              )}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {isLoading ? 'Loading…' : `${filtered.length.toLocaleString()} request${filtered.length === 1 ? '' : 's'} match the current view`}
            {activeFilterCount > 0 && ` · ${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} active`}
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      ) : (
        <>
          {/* ---------------- Overview ---------------- */}
          {tab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                <StatTile label="Applications received" value={String(cur.applied)} delta={pct(cur.applied, prev.applied)} hint={`prev ${prev.applied}`} />
                <StatTile label="New tenants added" value={String(cur.newTenants)} delta={pct(cur.newTenants, prev.newTenants)} hint="approved in period" />
                <StatTile label="Approved" value={String(cur.approved)} delta={pct(cur.approved, prev.approved)} hint={`prev ${prev.approved}`} />
                <StatTile label="Rejected" value={String(cur.rejected)} delta={pct(cur.rejected, prev.rejected)} hint={`prev ${prev.rejected}`} />
                <StatTile label="Funded" value={String(cur.funded)} delta={pct(cur.funded, prev.funded)} hint={ugx(cur.fundedValue)} />
                <StatTile label="Active tenants today" value={String(activeTodayIds.size)} hint="paid rent today" />
                <StatTile label="Tenants paying (period)" value={String(payingTenantsInRange.size)} hint={`${collectionsInRange.length} payments`} />
                <StatTile label="Collected" value={ugx(collectedTotal)} delta={pct(collectedTotal, collectedPrevTotal)} hint="in period" />
                <StatTile label="Paid to landlords" value={ugx(payoutTotal)} delta={pct(payoutTotal, payoutPrevTotal)} hint="in period" />
                <StatTile label="Outstanding receivable" value={ugx(book.outstanding)} hint={`${book.live} live plans`} />
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <KPICard title="Pending" value={snapshot.pending} icon={Clock} color="bg-amber-500/10 text-amber-600" subtitle="current book" onClick={() => { setStatusKey('pending'); setTab('tenants'); }} />
                <KPICard title="In pipeline" value={snapshot.inPipeline} icon={FileCheck} color="bg-blue-500/10 text-blue-600" subtitle="current book" onClick={() => { setStatusKey('in_pipeline'); setTab('tenants'); }} />
                <KPICard title="Funded" value={snapshot.funded} icon={Banknote} color="bg-green-500/10 text-green-600" subtitle="current book" onClick={() => { setStatusKey('funded'); setTab('tenants'); }} />
                <KPICard title="Repaying" value={snapshot.repaying} icon={Users} color="bg-purple-500/10 text-purple-600" subtitle="current book" onClick={() => { setStatusKey('repaying'); setTab('tenants'); }} />
                <KPICard title="Completed" value={snapshot.completed} icon={CheckCircle2} color="bg-emerald-500/10 text-emerald-600" subtitle="current book" onClick={() => { setStatusKey('completed'); setTab('tenants'); }} />
                <KPICard title="Defaulted" value={snapshot.defaulted} icon={AlertTriangle} color="bg-destructive/10 text-destructive" subtitle="current book" onClick={() => { setStatusKey('defaulted'); setTab('tenants'); }} />
                <KPICard title="Rejected" value={snapshot.rejected} icon={XCircle} color="bg-rose-500/10 text-rose-600" subtitle="current book" onClick={() => { setStatusKey('rejected'); setTab('tenants'); }} />
                <KPICard title="Cancelled / withdrawn" value={snapshot.cancelled} icon={X} color="bg-slate-500/10 text-muted-foreground" subtitle="current book" onClick={() => { setStatusKey('cancelled'); setTab('tenants'); }} />
              </div>

              <Card>
                <CardContent className="p-3">
                  <p className="text-xs font-semibold mb-2">Daily pipeline activity</p>
                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={daily} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                        <Tooltip contentStyle={{ fontSize: 11 }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar dataKey="applied" name="Applied" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="approved" name="Approved" fill="#22c55e" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="rejected" name="Rejected" fill="#ef4444" radius={[2, 2, 0, 0]} />
                        <Line type="monotone" dataKey="funded" name="Funded" stroke="#a855f7" strokeWidth={2} dot={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <Card>
                  <CardContent className="p-3">
                    <p className="text-xs font-semibold mb-2">Status distribution (filtered)</p>
                    <div className="h-56 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={statusDistribution} dataKey="value" nameKey="name" outerRadius="75%" label={false}>
                            {statusDistribution.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                          </Pie>
                          <Tooltip contentStyle={{ fontSize: 11 }} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-3">
                    <p className="text-xs font-semibold mb-2">Top agents by collections (period)</p>
                    <div className="h-56 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={agentPerformance.slice(0, 8)} layout="vertical" margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => shortUgx(v)} />
                          <YAxis type="category" dataKey="agent" width={92} tick={{ fontSize: 9 }} />
                          <Tooltip formatter={(v: any) => ugx(Number(v))} contentStyle={{ fontSize: 11 }} />
                          <Bar dataKey="collected" name="Collected" fill="#10b981" radius={[0, 3, 3, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardContent className="p-0">
                  <p className="text-xs font-semibold p-3 pb-2">Reported by agent (period &amp; filters)</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[640px]">
                      <thead className="bg-muted/50">
                        <tr className="text-left text-[11px] text-muted-foreground">
                          <th className="p-2 font-medium">Agent</th>
                          <th className="p-2 font-medium text-right">Requests</th>
                          <th className="p-2 font-medium text-right">Approved</th>
                          <th className="p-2 font-medium text-right">Rejected</th>
                          <th className="p-2 font-medium text-right">Funded</th>
                          <th className="p-2 font-medium text-right">Outstanding</th>
                          <th className="p-2 font-medium text-right">Collected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agentPerformance.slice(0, 15).map((a) => (
                          <tr key={a.agent} className="border-t border-border">
                            <td className="p-2 font-medium truncate max-w-[160px]">{a.agent}</td>
                            <td className="p-2 text-right">{a.applied}</td>
                            <td className="p-2 text-right text-emerald-600">{a.approved}</td>
                            <td className="p-2 text-right text-rose-600">{a.rejected}</td>
                            <td className="p-2 text-right">{a.funded}</td>
                            <td className="p-2 text-right">{ugx(a.outstanding)}</td>
                            <td className="p-2 text-right font-semibold">{ugx(a.collected)}</td>
                          </tr>
                        ))}
                        {!agentPerformance.length && (
                          <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">No agent activity in this period.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* ---------------- Tenants ---------------- */}
          {tab === 'tenants' && (
            <Card>
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <p className="text-xs font-semibold">
                    {statusGroup.label} · {filtered.length.toLocaleString()} records
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Select value={`${sortKey}:${sortDir}`} onValueChange={(v) => { const [k, d] = v.split(':'); setSortKey(k as any); setSortDir(d as any); }}>
                      <SelectTrigger className="h-8 w-[168px] text-[11px]">
                        <ArrowUpDown className="h-3 w-3 mr-1" /><SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="date:desc" className="text-xs">Newest first</SelectItem>
                        <SelectItem value="date:asc" className="text-xs">Oldest first</SelectItem>
                        <SelectItem value="tenant:asc" className="text-xs">Tenant A–Z</SelectItem>
                        <SelectItem value="amount:desc" className="text-xs">Highest rent</SelectItem>
                        <SelectItem value="outstanding:desc" className="text-xs">Highest outstanding</SelectItem>
                        <SelectItem value="status:asc" className="text-xs">Status</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" className="h-8 text-[11px] gap-1" onClick={handleCsv}>
                      <Download className="h-3.5 w-3.5" /> CSV
                    </Button>
                  </div>
                </div>

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-xs min-w-[900px]">
                    <thead className="bg-muted/50">
                      <tr className="text-left text-[11px] text-muted-foreground">
                        <th className="p-2 font-medium">Tenant</th>
                        <th className="p-2 font-medium">Status</th>
                        <th className="p-2 font-medium">Agent</th>
                        <th className="p-2 font-medium">Landlord</th>
                        <th className="p-2 font-medium">District</th>
                        <th className="p-2 font-medium">{DATE_BASIS_LABEL[dateBasis]}</th>
                        <th className="p-2 font-medium text-right">Rent</th>
                        <th className="p-2 font-medium text-right">Repaid</th>
                        <th className="p-2 font-medium text-right">Outstanding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((r) => (
                        <tr key={r.id} className="border-t border-border hover:bg-muted/40 cursor-pointer" onClick={() => setDetail(r)}>
                          <td className="p-2">
                            <p className="font-medium truncate max-w-[170px]">{r.tenant_name}</p>
                            <p className="text-[10px] text-muted-foreground">{r.tenant_phone}</p>
                          </td>
                          <td className="p-2"><Badge variant="secondary" className="text-[10px]">{STATUS_LABELS[r.status] || r.status}</Badge></td>
                          <td className="p-2 truncate max-w-[130px]">{r.agent_name}</td>
                          <td className="p-2 truncate max-w-[130px]">{r.landlord_name}</td>
                          <td className="p-2 truncate max-w-[110px]">{r.district}</td>
                          <td className="p-2 whitespace-nowrap">{r[dateBasis] ? format(new Date(r[dateBasis] as string), 'dd MMM yyyy') : '—'}</td>
                          <td className="p-2 text-right whitespace-nowrap">{ugx(r.rent_amount)}</td>
                          <td className="p-2 text-right whitespace-nowrap text-emerald-600">{ugx(r.amount_repaid)}</td>
                          <td className="p-2 text-right whitespace-nowrap font-semibold">{ugx(r.outstanding)}</td>
                        </tr>
                      ))}
                      {!pageRows.length && (
                        <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">No requests match this view. Try widening the date range or clearing filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="md:hidden divide-y divide-border">
                  {pageRows.map((r) => (
                    <button key={r.id} type="button" onClick={() => setDetail(r)} className="w-full text-left p-3 active:bg-muted/50">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{r.tenant_name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{r.tenant_phone} · {r.district}</p>
                        </div>
                        <Badge variant="secondary" className="text-[10px] shrink-0">{STATUS_LABELS[r.status] || r.status}</Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-2">
                        <div><p className="text-[10px] text-muted-foreground">Rent</p><p className="text-[11px] font-medium">{ugx(r.rent_amount)}</p></div>
                        <div><p className="text-[10px] text-muted-foreground">Repaid</p><p className="text-[11px] font-medium text-emerald-600">{ugx(r.amount_repaid)}</p></div>
                        <div><p className="text-[10px] text-muted-foreground">Outstanding</p><p className="text-[11px] font-medium">{ugx(r.outstanding)}</p></div>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1.5 truncate">
                        {r.agent_name} · {r.landlord_name} · {r[dateBasis] ? format(new Date(r[dateBasis] as string), 'dd MMM yyyy') : '—'}
                      </p>
                    </button>
                  ))}
                  {!pageRows.length && <p className="p-6 text-center text-xs text-muted-foreground">No requests match this view.</p>}
                </div>

                {filtered.length > PER_PAGE && (
                  <div className="flex items-center justify-between gap-2 p-3 border-t border-border">
                    <p className="text-[11px] text-muted-foreground">Page {page + 1} of {totalPages}</p>
                    <div className="flex items-center gap-1.5">
                      <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} aria-label="Next page">
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ---------------- Financials ---------------- */}
          {tab === 'financials' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <KPICard title="Collected (period)" value={ugx(collectedTotal)} icon={Wallet} color="bg-emerald-500/10 text-emerald-600" subtitle={`${collectionsInRange.length} payments`} />
                <KPICard title="Expected (period)" value={ugx(book.expectedInRange)} icon={FileCheck} color="bg-blue-500/10 text-blue-600" subtitle={`${ugx(book.dailyExpected)}/day`} />
                <KPICard title="Outstanding receivable" value={ugx(book.outstanding)} icon={Clock} color="bg-amber-500/10 text-amber-600" subtitle={`${book.live} live plans`} />
                <KPICard title="Paid to landlords" value={ugx(payoutTotal)} icon={Landmark} color="bg-purple-500/10 text-purple-600" subtitle={`${payoutsInRange.length} payouts`} />
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <StatTile label="Collection rate (period)" value={`${book.expectedInRange ? ((collectedTotal / book.expectedInRange) * 100).toFixed(1) : '0.0'}%`} hint="collected ÷ expected" />
                <StatTile label="Recovery rate (book)" value={`${book.recovery.toFixed(1)}%`} hint="repaid ÷ total repayment" />
                <StatTile label="Defaulted outstanding" value={ugx(book.defaultedOutstanding)} hint="on defaulted plans" />
                <StatTile label="Rent value funded (period)" value={ugx(cur.fundedValue)} delta={pct(cur.fundedValue, prev.fundedValue)} hint={`${cur.funded} plans`} />
              </div>

              <Card>
                <CardContent className="p-3">
                  <p className="text-xs font-semibold mb-2">Money in vs money out (daily)</p>
                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={daily} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => shortUgx(v)} />
                        <Tooltip formatter={(v: any) => ugx(Number(v))} contentStyle={{ fontSize: 11 }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar dataKey="collected" name="Collected from tenants" fill="#10b981" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="paidOut" name="Paid to landlords" fill="#8b5cf6" radius={[2, 2, 0, 0]} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <Card>
                  <CardContent className="p-0">
                    <p className="text-xs font-semibold p-3 pb-2">Payables — landlords</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs min-w-[520px]">
                        <thead className="bg-muted/50">
                          <tr className="text-left text-[11px] text-muted-foreground">
                            <th className="p-2 font-medium">Landlord</th>
                            <th className="p-2 font-medium text-right">Tenants</th>
                            <th className="p-2 font-medium text-right">Rent value</th>
                            <th className="p-2 font-medium text-right">Paid (period)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {landlordRows.slice(0, 12).map((l, i) => (
                            <tr key={`${l.landlord}-${i}`} className="border-t border-border">
                              <td className="p-2 truncate max-w-[150px]">{l.landlord}</td>
                              <td className="p-2 text-right">{l.tenants.size}</td>
                              <td className="p-2 text-right">{ugx(l.rentValue)}</td>
                              <td className="p-2 text-right font-semibold">{ugx(l.paidOut)}</td>
                            </tr>
                          ))}
                          {!landlordRows.length && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No landlord activity.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-0">
                    <p className="text-xs font-semibold p-3 pb-2">Receivables by district</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs min-w-[520px]">
                        <thead className="bg-muted/50">
                          <tr className="text-left text-[11px] text-muted-foreground">
                            <th className="p-2 font-medium">District</th>
                            <th className="p-2 font-medium text-right">Requests</th>
                            <th className="p-2 font-medium text-right">Tenants</th>
                            <th className="p-2 font-medium text-right">Outstanding</th>
                          </tr>
                        </thead>
                        <tbody>
                          {districtRows.slice(0, 12).map((d) => (
                            <tr key={d.district} className="border-t border-border">
                              <td className="p-2 truncate max-w-[150px]"><MapPin className="h-3 w-3 inline mr-1 text-muted-foreground" />{d.district}</td>
                              <td className="p-2 text-right">{d.requests}</td>
                              <td className="p-2 text-right">{d.tenants.size}</td>
                              <td className="p-2 text-right font-semibold">{ugx(d.outstanding)}</td>
                            </tr>
                          ))}
                          {!districtRows.length && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No district data.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* ---------------- Reports ---------------- */}
          {tab === 'reports' && (
            <Card>
              <CardContent className="p-3 sm:p-4 space-y-3">
                <div>
                  <p className="text-sm font-semibold">Reports &amp; exports</p>
                  <p className="text-xs text-muted-foreground">
                    Every report uses exactly the filters and date range applied above, so on-screen and exported figures always agree.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Select value={reportType} onValueChange={setReportType}>
                    <SelectTrigger className="h-9 sm:w-[260px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full" className="text-xs">Combined — full tenant pipeline</SelectItem>
                      <SelectItem value="tenants" className="text-xs">Tenant pipeline list</SelectItem>
                      <SelectItem value="status" className="text-xs">Status distribution</SelectItem>
                      <SelectItem value="receivables" className="text-xs">Receivables &amp; collections</SelectItem>
                      <SelectItem value="payables" className="text-xs">Payables &amp; landlord relationships</SelectItem>
                      <SelectItem value="agents" className="text-xs">Agent performance</SelectItem>
                      <SelectItem value="locations" className="text-xs">District performance</SelectItem>
                      <SelectItem value="daily" className="text-xs">Date-based performance</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-9 gap-1.5 text-xs" onClick={handlePdf} disabled={exporting}>
                      <FileText className="h-3.5 w-3.5" /> PDF
                    </Button>
                    <Button size="sm" variant="outline" className="h-9 gap-1.5 text-xs" onClick={handleCsv}>
                      <Download className="h-3.5 w-3.5" /> CSV
                    </Button>
                    <Button size="sm" variant="outline" className="h-9 gap-1.5 text-xs" onClick={handleXlsx} disabled={exporting}>
                      <Download className="h-3.5 w-3.5" /> Excel
                    </Button>
                    <Button size="sm" variant="outline" className="h-9 gap-1.5 text-xs" onClick={handlePrint} disabled={exporting}>
                      <Printer className="h-3.5 w-3.5" /> Print
                    </Button>
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card p-3 text-[11px] space-y-0.5">
                  <p className="font-semibold text-foreground">Audit trail stamped on every output</p>
                  <p className="text-muted-foreground">
                    Generated by {actorLabel}{role ? ` (${role})` : ''} · {format(new Date(), 'dd MMM yyyy, HH:mm')} ·
                    {' '}period {format(range.from, 'dd MMM yyyy')} – {format(range.to, 'dd MMM yyyy')} measured on {DATE_BASIS_LABEL[dateBasis].toLowerCase()} ·
                    {' '}{filtered.length.toLocaleString()} records · filters listed in full on the report header.
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-[11px] text-muted-foreground space-y-1">
                  <p><strong className="text-foreground">In this report:</strong> {statusGroup.label} · {filtered.length.toLocaleString()} requests · {DATE_BASIS_LABEL[dateBasis].toLowerCase()} between {format(range.from, 'dd MMM yyyy')} and {format(range.to, 'dd MMM yyyy')}.</p>
                  <p>Collected {ugx(collectedTotal)} · Paid to landlords {ugx(payoutTotal)} · Outstanding receivable {ugx(book.outstanding)}.</p>
                  <p>CSV and Excel export the tenant list with full financial columns; PDF adds the summary, charted tables and the section chosen above.</p>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ---------------- Detail sheet ---------------- */}
      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-base">{detail?.tenant_name}</SheetTitle>
          </SheetHeader>
          {detail && (
            <div className="mt-3 space-y-3 text-xs">
              <Badge variant="secondary">{STATUS_LABELS[detail.status] || detail.status}</Badge>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['Phone', detail.tenant_phone],
                  ['Agent', detail.agent_name],
                  ['Landlord', detail.landlord_name],
                  ['Landlord phone', detail.landlord_phone],
                  ['House', detail.house_title],
                  ['Address', detail.house_address],
                  ['District', detail.district],
                  ['Village', detail.village],
                  ['Applied', detail.created_at ? format(new Date(detail.created_at), 'dd MMM yyyy') : '—'],
                  ['Approved', detail.approved_at ? format(new Date(detail.approved_at), 'dd MMM yyyy') : '—'],
                  ['Funded', detail.funded_at ? format(new Date(detail.funded_at), 'dd MMM yyyy') : '—'],
                  ['Rejected', detail.rejected_at ? format(new Date(detail.rejected_at), 'dd MMM yyyy') : '—'],
                ].map(([k, v]) => (
                  <div key={k as string} className="min-w-0">
                    <p className="text-[10px] text-muted-foreground">{k}</p>
                    <p className="font-medium break-words">{v || '—'}</p>
                  </div>
                ))}
              </div>
              {detail.landlord_id && (
                <LandlordAgreementHistory
                  landlordId={detail.landlord_id}
                  landlordName={detail.landlord_name || 'Landlord'}
                  landlordPhone={detail.landlord_phone || ''}
                  propertyAddress={detail.house_address}
                  canAdd={false}
                />
              )}
              <div className="rounded-lg border border-border p-3 space-y-1.5">
                <p className="text-[11px] font-semibold">Financials</p>
                {[
                  ['Rent amount', ugx(detail.rent_amount)],
                  ['Daily repayment', ugx(detail.daily_repayment)],
                  ['Duration', detail.duration_days ? `${detail.duration_days} days` : '—'],
                  ['Total repayment', ugx(detail.total_repayment)],
                  ['Repaid', ugx(detail.amount_repaid)],
                  ['Outstanding', ugx(detail.outstanding)],
                  ['Access fee', ugx(detail.access_fee)],
                  ['Request fee', ugx(detail.request_fee)],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{k}</span>
                    <span className="font-medium">{v}</span>
                  </div>
                ))}
              </div>
              {detail.rejected_reason && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                  <p className="text-[11px] font-semibold text-destructive">Rejection reason</p>
                  <p className="text-[11px] mt-0.5">{detail.rejected_reason}</p>
                  {detail.rejected_at_stage && <p className="text-[10px] text-muted-foreground mt-1">Stage: {detail.rejected_at_stage}</p>}
                </div>
              )}
              <LifecycleTimeline request={detail} />
              {onOpenTenant && detail.tenant_id && (
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => { onOpenTenant(detail.tenant_id as string, detail.tenant_name); setDetail(null); }}
                >
                  Open full tenant profile
                </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default PipelineStatusHub;

/**
 * Read-only lifecycle timeline for one rent request: the request's own stage
 * timestamps merged with the existing audit log and service-centre events.
 */
function LifecycleTimeline({ request }: { request: PipelineRequestRow }) {
  const { data: events, isLoading } = useRentRequestLifecycle(request.id);

  const stamps: { at: string; label: string }[] = [
    ['Created / applied', request.created_at],
    ['Returned for correction', request.returned_at],
    ['Resubmitted by agent', request.resubmitted_at],
    ['Approved', request.approved_at],
    ['Funded', request.funded_at],
    ['Disbursed', request.disbursed_at],
    ['Rejected', request.rejected_at],
  ]
    .filter(([, at]) => !!at)
    .map(([label, at]) => ({ label: label as string, at: at as string }));

  const merged = [
    ...stamps.map((s) => ({ id: `stamp-${s.label}`, at: s.at, label: s.label, actor: 'Record timestamp', detail: null as string | null })),
    ...(events ?? []).map((e) => ({ id: e.id, at: e.at, label: e.label, actor: e.actor, detail: e.detail ?? null })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[11px] font-semibold flex items-center gap-1.5">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        Lifecycle history
        {isLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </p>
      <div className="mt-2 space-y-2">
        {merged.map((e) => (
          <div key={e.id} className="flex gap-2">
            <div className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium break-words">{e.label}</p>
              <p className="text-[10px] text-muted-foreground">
                {format(new Date(e.at), 'dd MMM yyyy, HH:mm')} · {e.actor}
              </p>
              {e.detail && <p className="text-[10px] text-muted-foreground break-words mt-0.5">“{e.detail}”</p>}
            </div>
          </div>
        ))}
        {!merged.length && !isLoading && (
          <p className="text-[11px] text-muted-foreground">No recorded history for this request yet.</p>
        )}
      </div>
    </div>
  );
}