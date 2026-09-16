import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatUGX } from '@/lib/rentCalculations';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import {
  Users, CheckCircle2, Banknote, CalendarDays, Building, Trophy, AlertTriangle,
  TrendingUp, TrendingDown, Loader2, Wallet, Filter, CalendarIcon, X,
  ChevronLeft, ChevronRight, ChevronDown, Printer, FileDown,
} from 'lucide-react';
import {
  startOfDay, endOfDay, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  subDays, format, eachDayOfInterval, isSameDay,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { generateDailyCollectionReportPdf } from '@/lib/generateDailyCollectionReportPdf';
import { downloadPdfBlob } from '@/lib/generateTenantOpsExtractPdf';
import TenantAssignAgentDialog from '@/components/shared/TenantAssignAgentDialog';

type Mode = 'editable' | 'readonly';
type Range = 'today' | 'week' | 'month';

interface Props {
  mode: Mode;
  title?: string;
}

interface RentRequestRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  landlord_id: string | null;
  daily_repayment: number;
  rent_amount: number;
  total_repayment: number;
  amount_repaid: number;
  status: string;
  house_category: string | null;
}

interface CollectionRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  amount: number;
  payment_method: string;
  notes: string | null;
  created_at: string;
}

interface TenantTrackerRow {
  rentRequestId: string;
  date: string;
  tenantId: string;
  tenantName: string;
  agentId: string | null;
  agentName: string;
  property: string;
  expected: number;
  collected: number;
  balance: number;
  status: 'paid' | 'partial' | 'missed';
  paymentMethod: string;
  remarks: string;
}

const DONUT_COLORS = ['hsl(var(--primary))', 'hsl(var(--destructive))'];

function statusBadge(status: 'paid' | 'partial' | 'missed') {
  if (status === 'paid') return <Badge className="bg-success text-success-foreground hover:bg-success/90">Paid</Badge>;
  if (status === 'partial') return <Badge className="bg-warning text-warning-foreground hover:bg-warning/90">Partial</Badge>;
  return <Badge variant="destructive">Missed</Badge>;
}

function methodLabel(m: string) {
  const map: Record<string, string> = {
    cash: 'Cash',
    mobile_money: 'MoMo',
    mobile_money_mtn: 'MTN MoMo',
    mobile_money_airtel: 'Airtel Money',
    bank: 'Bank',
    wallet: 'Wallet',
  };
  return map[m] || (m ? m.replace(/_/g, ' ') : '—');
}

export default function DailyCollectionMonitoringDashboard({ mode, title }: Props) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [range, setRange] = useState<Range>('today');
  const [day, setDay] = useState<Date>(new Date());
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [propertyFilter, setPropertyFilter] = useState<string>('all');
  // Missed-payments interval filter (0 = off, otherwise lookback days)
  const [missedWindow, setMissedWindow] = useState<number>(0);
  // Minimum missed-days threshold within the window (1 = at least one missed day)
  const [missedMin, setMissedMin] = useState<number>(1);
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordRow, setRecordRow] = useState<TenantTrackerRow | null>(null);
  const [recordAmount, setRecordAmount] = useState('');
  const [recordMethod, setRecordMethod] = useState<string>('cash');
  const [recordRemarks, setRecordRemarks] = useState('');
  const [trackerPage, setTrackerPage] = useState(1);
  const expandedStorageKey = `dailyCollection:${mode}:expandedTenants`;
  const [expandedTenants, setExpandedTenants] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = window.sessionStorage.getItem(expandedStorageKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        expandedStorageKey,
        JSON.stringify(Array.from(expandedTenants)),
      );
    } catch {
      /* storage unavailable */
    }
  }, [expandedTenants, expandedStorageKey]);
  const TRACKER_PAGE_SIZE = 10;
  const [submitting, setSubmitting] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignRow, setAssignRow] = useState<TenantTrackerRow | null>(null);

  // Range -> [from, to]
  const [rangeFrom, rangeTo] = useMemo(() => {
    if (range === 'today') return [startOfDay(day), endOfDay(day)];
    if (range === 'week') return [startOfWeek(day, { weekStartsOn: 1 }), endOfWeek(day, { weekStartsOn: 1 })];
    return [startOfMonth(day), endOfMonth(day)];
  }, [range, day]);

  const monthFrom = startOfMonth(day);
  const monthTo = endOfMonth(day);
  const prevDay = subDays(day, 1);
  const [prevFrom, prevTo] = [startOfDay(prevDay), endOfDay(prevDay)];

  // ---- Active rent_requests (the universe of "expected daily payment")
  const { data: rentReqs, isLoading: loadingReqs } = useQuery({
    queryKey: ['daily-collection-rent-requests'],
    queryFn: async () => {
      const PAGE = 1000;
      // Authoritative population: the platform's daily-eligibility rule (funded /
      // repaying, still owing, not paused, not "not paying"). Same source as the
      // agent daily targets and the Tenant Ops counters.
      const eligible = new Set<string>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('v_tenant_daily_eligibility')
          .select('rent_request_id')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        (data || []).forEach((r: any) => eligible.add(r.rent_request_id));
        if (!data || data.length < PAGE) break;
      }
      const all: RentRequestRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('rent_requests')
          .select('id, tenant_id, agent_id, landlord_id, daily_repayment, rent_amount, total_repayment, amount_repaid, status, house_category, created_at')
          .in('status', ['funded', 'disbursed', 'repaying'])
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = (data || []) as RentRequestRow[];
        all.push(...rows.filter(r => eligible.has(r.id)));
        if (rows.length < PAGE) break;
      }
      return all;
    },
    staleTime: 60_000,
  });

  // ---- Pinned daily bill for the selected day (`agent_expected_day_plans`).
  // This is the SAME frozen figure the Collections Command Center and the Agent
  // Ops "Today, as it stands" panel bill. Expected must never be re-derived from
  // `rent_requests.daily_repayment` here: that re-derivation reads far above the
  // bill (it counts plans the bill excludes) and made this page disagree with
  // Agent Ops. Days before pinning began have no rows — those fall back below.
  const { data: pinnedExpected } = useQuery({
    queryKey: ['daily-collection-pinned-expected', format(day, 'yyyy-MM-dd')],
    queryFn: async () => {
      const PAGE = 1000;
      const map = new Map<string, number>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('agent_expected_day_plans')
          .select('rent_request_id, expected_ugx')
          .eq('day', format(day, 'yyyy-MM-dd'))
          .range(from, from + PAGE - 1);
        if (error) throw error;
        (data || []).forEach((r: any) => {
          map.set(r.rent_request_id, (map.get(r.rent_request_id) || 0) + (Number(r.expected_ugx) || 0));
        });
        if (!data || data.length < PAGE) break;
      }
      return map;
    },
    staleTime: 60_000,
  });

  // ---- Collections in selected range
  const { data: collections, isLoading: loadingCollections, refetch: refetchCollections } = useQuery({
    queryKey: ['daily-collection-collections', rangeFrom.toISOString(), rangeTo.toISOString()],
    queryFn: async () => {
      const PAGE = 1000;
      const all: CollectionRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('agent_collections')
          .select('id, tenant_id, agent_id, amount, payment_method, notes, created_at').is('reversed_at', null)
          .gte('created_at', rangeFrom.toISOString())
          .lte('created_at', rangeTo.toISOString())
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = (data || []) as CollectionRow[];
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      return all;
    },
    staleTime: 30_000,
  });

  // ---- Comparison: yesterday collections sum (for today card delta)
  const { data: prevCollections } = useQuery({
    queryKey: ['daily-collection-prev', prevFrom.toISOString()],
    queryFn: async () => {
      const PAGE = 1000;
      const all: { amount: number; tenant_id: string }[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('agent_collections')
          .select('amount, tenant_id').is('reversed_at', null)
          .gte('created_at', prevFrom.toISOString())
          .lte('created_at', prevTo.toISOString())
          .range(from, from + PAGE - 1);
        if (error) throw error;
        all.push(...((data || []) as any[]));
        if (!data || data.length < PAGE) break;
      }
      return all;
    },
    staleTime: 60_000,
  });

  // ---- Month collections (for month KPI + trend)
  const { data: monthCollections } = useQuery({
    queryKey: ['daily-collection-month', monthFrom.toISOString()],
    queryFn: async () => {
      const PAGE = 1000;
      const all: { amount: number; created_at: string }[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('agent_collections')
          .select('amount, created_at').is('reversed_at', null)
          .gte('created_at', monthFrom.toISOString())
          .lte('created_at', monthTo.toISOString())
          .range(from, from + PAGE - 1);
        if (error) throw error;
        all.push(...((data || []) as any[]));
        if (!data || data.length < PAGE) break;
      }
      return all;
    },
    staleTime: 60_000,
  });

  // ---- All-time totals: total paid + total outstanding (active rent plans only)
  const { data: allTimeStats } = useQuery({
    queryKey: ['daily-collection-alltime'],
    queryFn: async () => {
      const PAGE = 1000;
      const rows: any[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('rent_requests')
          .select('amount_repaid, total_repayment, rent_amount, status')
          .in('status', ['funded', 'disbursed', 'repaying', 'fully_repaid'])
          .range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...((data || []) as any[]));
        if (!data || data.length < PAGE) break;
      }
      const totalPaid = rows.reduce((s, r) => s + Number(r.amount_repaid || 0), 0);
      // Outstanding = sum of (total_repayment - amount_repaid) across still-active plans
      const totalOutstanding = rows
        .filter(r => r.status !== 'fully_repaid')
        .reduce((s, r) => s + Math.max(0, Number(r.total_repayment || 0) - Number(r.amount_repaid || 0)), 0);
      // Total rent the company has disbursed to landlords on behalf of tenants (all time)
      const totalDisbursed = rows.reduce((s, r) => s + Number(r.rent_amount || 0), 0);
      return { totalPaid, totalOutstanding, totalDisbursed };
    },
    staleTime: 5 * 60_000,
  });

  // ---- Tenants onboarded today (referrals created within range)
  const { data: onboardedToday } = useQuery({
    queryKey: ['daily-collection-onboarded', rangeFrom.toISOString()],
    queryFn: async () => {
      const { count: today } = await supabase
        .from('rent_requests')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', rangeFrom.toISOString())
        .lte('created_at', rangeTo.toISOString());
      const { count: yest } = await supabase
        .from('rent_requests')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', prevFrom.toISOString())
        .lte('created_at', prevTo.toISOString());
      return { today: today || 0, yest: yest || 0 };
    },
    staleTime: 60_000,
  });

  // Resolve agent + tenant + landlord names.
  // IMPORTANT: only depend on rent requests here. The tracker rows (and the
  // exported reports) resolve names exclusively from rent_request ids, which are
  // range-independent. Mixing in collection ids made this set — and the profiles
  // query key — change every time the range (Today/Weekly/Monthly) switched,
  // briefly emptying the profiles map and rendering tenant names as "Unknown".
  const ids = useMemo(() => {
    const set = new Set<string>();
    (rentReqs || []).forEach(r => {
      set.add(r.tenant_id);
      if (r.agent_id) set.add(r.agent_id);
      if (r.landlord_id) set.add(r.landlord_id);
    });
    return Array.from(set);
  }, [rentReqs]);

  const { data: profiles } = useQuery({
    queryKey: ['daily-collection-profiles', ids.slice().sort().join(',')],
    enabled: ids.length > 0,
    queryFn: async () => {
      const map = new Map<string, any>();
      const CHUNK = 50;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', batch);
        if (error) throw error;
        (data || []).forEach((p: any) => map.set(p.id, p));
      }
      return map;
    },
    staleTime: 5 * 60_000,
  });

  // Build the tracker rows: one row per active rent_request for the selected day
  const trackerRows: TenantTrackerRow[] = useMemo(() => {
    if (!rentReqs) return [];
    // For "today" range, treat date as `day`. For week/month, expected is per-day * days_in_range — but we
    // keep the tracker focused on a single day to match the user's mock; range affects KPIs/charts.
    const target = day;
    const collectionsByTenant = new Map<string, CollectionRow[]>();
    (collections || []).forEach(c => {
      // count only collections on the target day for the row's "Collected" column
      if (!isSameDay(new Date(c.created_at), target)) return;
      const arr = collectionsByTenant.get(c.tenant_id) || [];
      arr.push(c);
      collectionsByTenant.set(c.tenant_id, arr);
    });

    const targetEnd = endOfDay(target);
    // When the day is pinned, the bill defines the population as well as the
    // amount: a plan absent from the bill is not billed that day.
    const pinned = pinnedExpected && pinnedExpected.size > 0 ? pinnedExpected : null;
    const activeForDay = (rentReqs || []).filter((r: any) => {
      if (pinned) return pinned.has(r.id) || collectionsByTenant.has(r.tenant_id);
      // Only include rent requests that already existed on/before the selected day.
      if (!r.created_at) return true;
      return new Date(r.created_at) <= targetEnd;
    });
    const rows: TenantTrackerRow[] = activeForDay.map(r => {
      const tenantName = profiles?.get(r.tenant_id)?.full_name || 'Unknown';
      const agentName = r.agent_id ? (profiles?.get(r.agent_id)?.full_name || '—') : '—';
      const landlordName = r.landlord_id ? (profiles?.get(r.landlord_id)?.full_name || '') : '';
      const property = [r.house_category, landlordName].filter(Boolean).join(' / ') || '—';
      const expected = pinned
        ? Number(pinned.get(r.id) || 0)
        : Number(r.daily_repayment || 0);
      const tenantCollections = collectionsByTenant.get(r.tenant_id) || [];
      const collected = tenantCollections.reduce((s, c) => s + Number(c.amount || 0), 0);
      const balance = Math.max(0, expected - collected);
      const status: TenantTrackerRow['status'] =
        collected <= 0 ? 'missed' : balance <= 0 ? 'paid' : 'partial';
      const last = tenantCollections[tenantCollections.length - 1];
      return {
        rentRequestId: r.id,
        date: format(target, 'dd MMM yyyy'),
        tenantId: r.tenant_id,
        tenantName,
        agentId: r.agent_id,
        agentName,
        property,
        expected,
        collected,
        balance,
        status,
        paymentMethod: last ? methodLabel(last.payment_method) : '—',
        remarks: last?.notes || (status === 'paid' ? 'Paid in full' : status === 'partial' ? 'Part payment' : 'Not paid'),
      };
    });
    return rows;
  }, [rentReqs, collections, profiles, day, pinnedExpected]);

  // ---- Missed payments lookback window — computed server-side in one RPC call
  const asOfKey = format(day, 'yyyy-MM-dd');
  const { data: missedDaysRpc } = useQuery({
    queryKey: ['daily-collection-missed-days-rpc', missedWindow, asOfKey],
    enabled: missedWindow > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_missed_days', {
        p_window_days: missedWindow,
        p_as_of: asOfKey,
      });
      if (error) throw error;
      return (data || []) as { tenant_id: string; missed_days: number }[];
    },
  });

  const missedDaysByTenant = useMemo(() => {
    const map = new Map<string, number>();
    if (!missedWindow) return map;
    (missedDaysRpc || []).forEach(r => {
      if (r.missed_days > 0) map.set(r.tenant_id, r.missed_days);
    });
    return map;
  }, [missedWindow, missedDaysRpc]);

  // Exact missed dates per tenant (for the expandable list / tooltip)
  const { data: missedDatesRpc } = useQuery({
    queryKey: ['daily-collection-missed-dates-rpc', missedWindow, asOfKey],
    enabled: missedWindow > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_missed_dates', {
        p_window_days: missedWindow,
        p_as_of: asOfKey,
      });
      if (error) throw error;
      return (data || []) as { tenant_id: string; missed_dates: string[] }[];
    },
  });

  const missedDatesByTenant = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!missedWindow) return map;
    (missedDatesRpc || []).forEach(r => {
      if (Array.isArray(r.missed_dates) && r.missed_dates.length > 0) {
        map.set(r.tenant_id, r.missed_dates);
      }
    });
    return map;
  }, [missedWindow, missedDatesRpc]);

  // Apply filters
  const filteredRows = useMemo(() => {
    return trackerRows.filter(r => {
      if (agentFilter !== 'all' && r.agentId !== agentFilter) return false;
      if (propertyFilter !== 'all' && r.property !== propertyFilter) return false;
      if (missedWindow > 0) {
        const m = missedDaysByTenant.get(r.tenantId) || 0;
        if (m < Math.min(missedMin, missedWindow)) return false;
      }
      return true;
    });
  }, [trackerRows, agentFilter, propertyFilter, missedWindow, missedMin, missedDaysByTenant]);

  // Daily totals
  const totals = useMemo(() => {
    const expected = filteredRows.reduce((s, r) => s + r.expected, 0);
    const collected = filteredRows.reduce((s, r) => s + r.collected, 0);
    const outstanding = Math.max(0, expected - collected);
    return { expected, collected, outstanding };
  }, [filteredRows]);

  // Pagination for tracker table
  const trackerTotalPages = Math.max(1, Math.ceil(filteredRows.length / TRACKER_PAGE_SIZE));
  const trackerCurrentPage = Math.min(trackerPage, trackerTotalPages);
  const pagedRows = useMemo(
    () => filteredRows.slice((trackerCurrentPage - 1) * TRACKER_PAGE_SIZE, trackerCurrentPage * TRACKER_PAGE_SIZE),
    [filteredRows, trackerCurrentPage]
  );
  // Reset to first page whenever filters/date/range change
  useEffect(() => { setTrackerPage(1); }, [agentFilter, propertyFilter, day, range, missedWindow, missedMin]);

  // KPIs
  const collectionToday = (collections || []).reduce((s, c) => s + Number(c.amount || 0), 0);
  const collectionPrev = (prevCollections || []).reduce((s, c) => s + Number(c.amount || 0), 0);
  const collectionMonth = (monthCollections || []).reduce((s, c) => s + Number(c.amount || 0), 0);
  const tenantsPaid = new Set(
    (collections || []).filter(c => isSameDay(new Date(c.created_at), day)).map(c => c.tenant_id)
  ).size;
  const tenantsPaidPrev = new Set((prevCollections || []).map(c => c.tenant_id)).size;

  // Agent summary
  const agentSummary = useMemo(() => {
    const byAgent = new Map<string, {
      agentId: string; name: string; tenants: Set<string>; tenantsPaid: Set<string>;
      expected: number; collected: number;
    }>();
    for (const r of filteredRows) {
      const key = r.agentId || 'unassigned';
      const existing = byAgent.get(key) || {
        agentId: key, name: r.agentName === '—' ? 'Unassigned' : r.agentName,
        tenants: new Set<string>(), tenantsPaid: new Set<string>(),
        expected: 0, collected: 0,
      };
      existing.tenants.add(r.tenantId);
      if (r.collected > 0) existing.tenantsPaid.add(r.tenantId);
      existing.expected += r.expected;
      existing.collected += r.collected;
      byAgent.set(key, existing);
    }
    return Array.from(byAgent.values()).map(a => {
      const rate = a.expected > 0 ? Math.round((a.collected / a.expected) * 100) : 0;
      return {
        ...a,
        tenantCount: a.tenants.size,
        paidCount: a.tenantsPaid.size,
        balance: Math.max(0, a.expected - a.collected),
        rate,
        status: rate >= 70 ? 'good' as const : 'at_risk' as const,
      };
    }).sort((a, b) => b.collected - a.collected);
  }, [filteredRows]);

  const topAgent = agentSummary[0];
  const bottomAgent = agentSummary.length > 1 ? agentSummary[agentSummary.length - 1] : undefined;

  // Donut data
  const donutData = [
    { name: 'Collected', value: totals.collected },
    { name: 'Outstanding', value: totals.outstanding },
  ];
  const collectedPct = totals.expected > 0 ? Math.round((totals.collected / totals.expected) * 100) : 0;

  // Monthly trend (cumulative)
  const monthTrend = useMemo(() => {
    const days = eachDayOfInterval({ start: monthFrom, end: monthTo });
    let cum = 0;
    return days.map(d => {
      const sumDay = (monthCollections || []).filter(c => isSameDay(new Date(c.created_at), d))
        .reduce((s, c) => s + Number(c.amount || 0), 0);
      cum += sumDay;
      return { date: format(d, 'dd MMM'), value: cum };
    });
  }, [monthCollections, monthFrom, monthTo]);

  // Unique values for filters
  const agentOptions = useMemo(() => {
    const m = new Map<string, string>();
    trackerRows.forEach(r => { if (r.agentId) m.set(r.agentId, r.agentName); });
    return Array.from(m.entries());
  }, [trackerRows]);

  const propertyOptions = useMemo(() => {
    const set = new Set<string>();
    trackerRows.forEach(r => { if (r.property && r.property !== '—') set.add(r.property); });
    return Array.from(set);
  }, [trackerRows]);

  const isLoading = loadingReqs || loadingCollections;

  // Record payment (Tenant Ops only)
  const openRecord = (row: TenantTrackerRow) => {
    setRecordRow(row);
    setRecordAmount(String(Math.max(0, row.balance || row.expected)));
    setRecordMethod('cash');
    setRecordRemarks('');
    setRecordOpen(true);
  };

  const submitRecord = async () => {
    if (!recordRow) return;
    const amt = Number(recordAmount);
    if (!amt || amt <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (!user?.id) {
      toast.error('Not authenticated');
      return;
    }
    setSubmitting(true);
    try {
      // Tenant Ops staff records on behalf — agent_id = the tenant's assigned agent if known,
      // otherwise the staff user's id (so the row stays valid). We log a remark to make it auditable.
      const agentId = recordRow.agentId || user.id;
      const { error } = await supabase.from('agent_collections').insert({
        agent_id: agentId,
        tenant_id: recordRow.tenantId,
        amount: amt,
        payment_method: recordMethod,
        notes: `[Tenant Ops entry by ${user.email || user.id}] ${recordRemarks}`.trim(),
        float_before: 0,
        float_after: 0,
      } as any);
      if (error) throw error;
      toast.success('Payment recorded');
      setRecordOpen(false);
      await refetchCollections();
      queryClient.invalidateQueries({ queryKey: ['daily-collection-prev'] });
      queryClient.invalidateQueries({ queryKey: ['daily-collection-month'] });
    } catch (e: any) {
      toast.error(e.message || 'Failed to record payment');
    } finally {
      setSubmitting(false);
    }
  };

  const delta = (cur: number, prev: number) => {
    const diff = cur - prev;
    const sign = diff > 0 ? '+' : '';
    return { text: `${sign}${formatUGX(diff)} vs yesterday`, positive: diff >= 0 };
  };
  const deltaCount = (cur: number, prev: number) => {
    const diff = cur - prev;
    const sign = diff > 0 ? '+' : '';
    return { text: `${sign}${diff} vs yesterday`, positive: diff >= 0 };
  };

  return (
    <div className="space-y-4">
      {title && (
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <CalendarDays className="h-4.5 w-4.5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">{title}</h1>
            <p className="text-[11px] text-muted-foreground">Track daily collections from tenants — UGX</p>
          </div>
        </div>
      )}

      {/* Range + day controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
          <TabsList className="h-8">
            <TabsTrigger value="today" className="text-xs px-2.5">Today</TabsTrigger>
            <TabsTrigger value="week" className="text-xs px-2.5">Weekly</TabsTrigger>
            <TabsTrigger value="month" className="text-xs px-2.5">Monthly</TabsTrigger>
          </TabsList>
        </Tabs>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <CalendarIcon className="h-3.5 w-3.5" />
              {format(day, 'dd MMM yyyy')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar mode="single" selected={day} onSelect={(d) => d && setDay(d)} initialFocus className="p-3 pointer-events-auto" />
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 ml-auto"
          onClick={() => {
            try {
              const blob = generateDailyCollectionReportPdf({
                day,
                kpis: {
                  onboardedToday: onboardedToday?.today || 0,
                  onboardedDelta: (onboardedToday?.today || 0) - (onboardedToday?.yest || 0),
                  tenantsPaid,
                  tenantsPaidDelta: tenantsPaid - tenantsPaidPrev,
                  collectionToday,
                  collectionDelta: collectionToday - collectionPrev,
                  collectionMonth,
                  totalRentPaidAllTime: allTimeStats?.totalPaid || 0,
                  totalOutstandingAllTenants: allTimeStats?.totalOutstanding || 0,
                },
                rows: filteredRows.map(r => ({
                  date: r.date,
                  agentName: r.agentName,
                  tenantName: r.tenantName,
                  property: r.property,
                  expected: r.expected,
                  collected: r.collected,
                  balance: r.balance,
                  status: r.status,
                  paymentMethod: r.paymentMethod,
                  remarks: r.remarks,
                  missedDays: missedDaysByTenant.get(r.tenantId) || 0,
                })),
                totals,
                agentSummary: agentSummary.map(a => ({
                  name: a.name,
                  tenantCount: a.tenantCount,
                  paidCount: a.paidCount,
                  expected: a.expected,
                  collected: a.collected,
                  balance: a.balance,
                  rate: a.rate,
                  status: a.status,
                })),
                donut: {
                  collected: totals.collected,
                  outstanding: totals.outstanding,
                  collectedPct,
                },
                monthly: monthTrend,
                top: topAgent ? { name: topAgent.name, rate: topAgent.rate } : undefined,
                bottom: bottomAgent ? { name: bottomAgent.name, rate: bottomAgent.rate } : undefined,
                missedWindow,
              });
              downloadPdfBlob(blob, `daily-collection-${format(day, 'yyyy-MM-dd')}.pdf`);
              toast.success('Report downloaded');
            } catch (e: any) {
              toast.error(e?.message || 'Failed to generate report');
            }
          }}
        >
          <Printer className="h-3.5 w-3.5" /> Print Report
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => {
            try {
              const esc = (v: string | number) => {
                const s = String(v ?? '');
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
              };
              const header = [
                '#', 'Date', 'Agent', 'Tenant', 'Property', 'Expected (UGX)',
                'Collected (UGX)', 'Balance (UGX)', 'Status',
                ...(missedWindow > 0 ? [`Missed (last ${missedWindow}d)`, `Window (days)`] : []),
                'Method', 'Remarks',
              ];
              const lines = [header.map(esc).join(',')];
              filteredRows.forEach((r, i) => {
                const cols: (string | number)[] = [
                  i + 1, r.date, r.agentName, r.tenantName, r.property,
                  Math.round(r.expected), Math.round(r.collected), Math.round(r.balance),
                  r.status,
                ];
                if (missedWindow > 0) {
                  cols.push(missedDaysByTenant.get(r.tenantId) || 0, missedWindow);
                }
                cols.push(r.paymentMethod, r.remarks);
                lines.push(cols.map(esc).join(','));
              });
              // Totals row
              const totalsCols: (string | number)[] = [
                '', 'TOTALS', '', '', '',
                Math.round(totals.expected), Math.round(totals.collected), Math.round(totals.outstanding), '',
              ];
              if (missedWindow > 0) totalsCols.push('', '');
              totalsCols.push('', '');
              lines.push(totalsCols.map(esc).join(','));

              const csv = '\uFEFF' + lines.join('\n');
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `daily-collection-${format(day, 'yyyy-MM-dd')}${missedWindow > 0 ? `-missed-${missedWindow}d` : ''}.csv`;
              a.click();
              URL.revokeObjectURL(url);
              toast.success('CSV downloaded');
            } catch (e: any) {
              toast.error(e?.message || 'Failed to export CSV');
            }
          }}
        >
          <FileDown className="h-3.5 w-3.5" /> Export CSV
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2.5">
        <KpiCard
          label="Tenants Onboarded (Today)"
          value={String(onboardedToday?.today ?? 0)}
          delta={deltaCount(onboardedToday?.today || 0, onboardedToday?.yest || 0)}
          icon={Users}
          color="text-primary bg-primary/10"
        />
        <KpiCard
          label="Tenants Paid For (Today)"
          value={String(tenantsPaid)}
          delta={deltaCount(tenantsPaid, tenantsPaidPrev)}
          icon={CheckCircle2}
          color="text-success bg-success/10"
        />
        <KpiCard
          label="Collection Today (UGX)"
          value={formatUGX(collectionToday)}
          delta={delta(collectionToday, collectionPrev)}
          icon={Banknote}
          color="text-primary bg-primary/10"
        />
        <KpiCard
          label="Collection This Month"
          value={formatUGX(collectionMonth)}
          icon={CalendarDays}
          color="text-warning bg-warning/10"
          subtitle="MTD Collection"
        />
        <KpiCard
          label="Total Rent Paid (All Time)"
          value={formatUGX(allTimeStats?.totalPaid || 0)}
          icon={Building}
          color="text-primary bg-primary/10"
          subtitle="Total to date"
        />
        <KpiCard
          label="Total Outstanding (All Tenants)"
          value={formatUGX(allTimeStats?.totalOutstanding || 0)}
          icon={AlertTriangle}
          color="text-destructive bg-destructive/10"
          subtitle="Across active rent plans"
        />
        <KpiCard
          label="Total Disbursed to Landlords (All Time)"
          value={formatUGX(allTimeStats?.totalDisbursed || 0)}
          icon={Wallet}
          color="text-warning bg-warning/10"
          subtitle="Rent paid out by company"
        />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Filter className="h-3.5 w-3.5" /> Filters:
          </div>
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="h-8 w-[180px] text-xs"><SelectValue placeholder="Agent" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              {agentOptions.map(([id, name]) => (
                <SelectItem key={id} value={id}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={propertyFilter} onValueChange={setPropertyFilter}>
            <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue placeholder="Property / Landlord" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Properties</SelectItem>
              {propertyOptions.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(missedWindow)}
            onValueChange={(v) => setMissedWindow(Number(v))}
          >
            <SelectTrigger className="h-8 w-[200px] text-xs">
              <SelectValue placeholder="Missed payments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">All tenants (no missed filter)</SelectItem>
              <SelectItem value="3">Missed in last 3 days</SelectItem>
              <SelectItem value="5">Missed in last 5 days</SelectItem>
              <SelectItem value="7">Missed in last 7 days</SelectItem>
              <SelectItem value="14">Missed in last 14 days</SelectItem>
              <SelectItem value="30">Missed in last 30 days</SelectItem>
            </SelectContent>
          </Select>
          {missedWindow > 0 && (
            <Select
              value={String(Math.min(missedMin, missedWindow))}
              onValueChange={(v) => setMissedMin(Number(v))}
            >
              <SelectTrigger className="h-8 w-[170px] text-xs">
                <SelectValue placeholder="Min missed days" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: missedWindow }, (_, i) => i + 1).map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    At least {n} missed day{n > 1 ? 's' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {(agentFilter !== 'all' || propertyFilter !== 'all' || missedWindow > 0) && (
            <Button size="sm" variant="ghost" className="h-8" onClick={() => { setAgentFilter('all'); setPropertyFilter('all'); setMissedWindow(0); setMissedMin(1); }}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          )}
          <div className="ml-auto text-[11px] text-muted-foreground">
            {filteredRows.length} {missedWindow > 0 ? `tenants missed ≥${Math.min(missedMin, missedWindow)} day${Math.min(missedMin, missedWindow) > 1 ? 's' : ''} in last ${missedWindow}` : 'active rent plans'}
          </div>
        </CardContent>
      </Card>

      {/* Tracker Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" /> Tenant Daily Collection Tracker — {format(day, 'dd MMM yyyy')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
          ) : filteredRows.length === 0 ? (
            <p className="text-center py-10 text-sm text-muted-foreground">No active rent plans match the filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">#</TableHead>
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Agent</TableHead>
                    <TableHead className="text-xs">Tenant</TableHead>
                    <TableHead className="text-xs">Property / Landlord</TableHead>
                    <TableHead className="text-xs text-right">Expected</TableHead>
                    <TableHead className="text-xs text-right">Collected</TableHead>
                    <TableHead className="text-xs text-right">Balance</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    {missedWindow > 0 && (
                      <TableHead className="text-xs text-right">Missed (last {missedWindow}d)</TableHead>
                    )}
                    <TableHead className="text-xs">Method</TableHead>
                    <TableHead className="text-xs">Remarks</TableHead>
                    {mode === 'editable' && <TableHead className="text-xs">Action</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                 {pagedRows.map((r, i) => {
                    const missedCount = missedWindow > 0 ? (missedDaysByTenant.get(r.tenantId) || 0) : 0;
                    const missedDates = missedWindow > 0 ? (missedDatesByTenant.get(r.tenantId) || []) : [];
                    const isExpanded = expandedTenants.has(r.tenantId);
                    const totalCols = 11 + (missedWindow > 0 ? 1 : 0) + (mode === 'editable' ? 1 : 0);
                    return (
                    <React.Fragment key={r.rentRequestId}>
                    <TableRow>
                      <TableCell className="text-xs">{(trackerCurrentPage - 1) * TRACKER_PAGE_SIZE + i + 1}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{r.date}</TableCell>
                      <TableCell className="text-xs">
                        {mode === 'editable' ? (
                          <button
                            type="button"
                            className="text-primary hover:underline text-left"
                            onClick={() => { setAssignRow(r); setAssignOpen(true); }}
                            title="Link an agent to this tenant"
                          >
                            {r.agentName && r.agentName !== '—' ? r.agentName : 'Link agent'}
                          </button>
                        ) : r.agentName}
                      </TableCell>
                      <TableCell className="text-xs font-medium">
                        {mode === 'editable' ? (
                          <button
                            type="button"
                            className="text-primary hover:underline text-left"
                            onClick={() => { setAssignRow(r); setAssignOpen(true); }}
                            title="Assign agent / link property"
                          >
                            {r.tenantName}
                          </button>
                        ) : r.tenantName}
                      </TableCell>
                      <TableCell className="text-xs">{r.property}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatUGX(r.expected)}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">{formatUGX(r.collected)}</TableCell>
                      <TableCell className={cn('text-xs text-right tabular-nums', r.balance > 0 && 'text-destructive font-semibold')}>{formatUGX(r.balance)}</TableCell>
                      <TableCell>{statusBadge(r.status)}</TableCell>
                      {missedWindow > 0 && (
                        <TableCell className="text-xs text-right">
                          {missedCount === 0 ? (
                            <Badge variant="outline" className="tabular-nums">
                              0 / {missedWindow}
                            </Badge>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedTenants(prev => {
                                  const next = new Set(prev);
                                  if (next.has(r.tenantId)) next.delete(r.tenantId); else next.add(r.tenantId);
                                  return next;
                                });
                              }}
                              title={isExpanded ? 'Hide missed dates' : 'Show missed dates'}
                              className="inline-flex items-center gap-1"
                            >
                              {isExpanded
                                ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                              <Badge variant="destructive" className="tabular-nums cursor-pointer hover:opacity-90">
                                {missedCount} / {missedWindow}
                              </Badge>
                            </button>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="text-xs">{r.paymentMethod}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate" title={r.remarks}>{r.remarks}</TableCell>
                      {mode === 'editable' && (
                        <TableCell>
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openRecord(r)}>
                            <Wallet className="h-3 w-3 mr-1" /> Record
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                    {missedWindow > 0 && isExpanded && missedCount > 0 && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={totalCols} className="py-3">
                          <div className="px-2">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-xs font-semibold">
                                Missed dates — {r.tenantName}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {missedCount} of last {missedWindow} day{missedWindow > 1 ? 's' : ''}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {missedDates.map((d) => {
                                const dt = new Date(d);
                                return (
                                  <Badge
                                    key={d}
                                    variant="outline"
                                    className="text-[11px] tabular-nums border-destructive/40 text-destructive"
                                  >
                                    {format(dt, 'EEE, dd MMM yyyy')}
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    </React.Fragment>
                    );
                  })}
                  {/* Daily totals row */}
                  <TableRow className="bg-muted/40 font-bold">
                    <TableCell colSpan={5} className="text-xs uppercase text-primary">Daily Totals</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{formatUGX(totals.expected)}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{formatUGX(totals.collected)}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-destructive">{formatUGX(totals.outstanding)}</TableCell>
                    <TableCell colSpan={(mode === 'editable' ? 4 : 3) + (missedWindow > 0 ? 1 : 0)}></TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
          {filteredRows.length > TRACKER_PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <span className="text-[11px] text-muted-foreground">
                Showing {(trackerCurrentPage - 1) * TRACKER_PAGE_SIZE + 1}–{Math.min(trackerCurrentPage * TRACKER_PAGE_SIZE, filteredRows.length)} of {filteredRows.length}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => setTrackerPage(p => Math.max(1, p - 1))}
                  disabled={trackerCurrentPage === 1}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="text-[11px] font-medium text-foreground tabular-nums px-2">
                  Page {trackerCurrentPage} of {trackerTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => setTrackerPage(p => Math.min(trackerTotalPages, p + 1))}
                  disabled={trackerCurrentPage === trackerTotalPages}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Agent summary + Donut */}
      <div className={cn('grid grid-cols-1 gap-3', mode !== 'editable' && 'lg:grid-cols-2')}>
        {mode !== 'editable' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" /> Agent Daily Collection Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {agentSummary.length === 0 ? (
              <p className="text-center py-8 text-sm text-muted-foreground">No agent data.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Agent</TableHead>
                      <TableHead className="text-xs text-right">Onb.</TableHead>
                      <TableHead className="text-xs text-right">Paid</TableHead>
                      <TableHead className="text-xs text-right">Expected</TableHead>
                      <TableHead className="text-xs text-right">Collected</TableHead>
                      <TableHead className="text-xs text-right">Balance</TableHead>
                      <TableHead className="text-xs text-right">Rate</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agentSummary.map(a => (
                      <TableRow key={a.agentId}>
                        <TableCell className="text-xs font-medium">{a.name}</TableCell>
                        <TableCell className="text-xs text-right">{a.tenantCount}</TableCell>
                        <TableCell className="text-xs text-right">{a.paidCount}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{formatUGX(a.expected)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{formatUGX(a.collected)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums text-destructive">{formatUGX(a.balance)}</TableCell>
                        <TableCell className="text-xs text-right font-bold">{a.rate}%</TableCell>
                        <TableCell>
                          {a.status === 'good'
                            ? <Badge className="bg-success text-success-foreground hover:bg-success/90">Good</Badge>
                            : <Badge className="bg-warning text-warning-foreground hover:bg-warning/90">At Risk</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" /> Collection Overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            {totals.expected === 0 ? (
              <p className="text-center py-10 text-sm text-muted-foreground">No expectations for this day.</p>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={donutData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                        {donutData.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i]} />)}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatUGX(v)} contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
                      <Legend iconType="circle" iconSize={8} formatter={(v: string) => <span className="text-xs">{v}</span>} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2 shrink-0">
                  <div className="text-3xl font-extrabold text-primary">{collectedPct}%</div>
                  <div className="text-[11px] text-muted-foreground">Collection Rate</div>
                  <div className="pt-2 space-y-1">
                    <div className="text-xs"><span className="inline-block w-2 h-2 rounded-full bg-primary mr-1.5" />Collected: <span className="font-semibold">{formatUGX(totals.collected)}</span></div>
                    <div className="text-xs"><span className="inline-block w-2 h-2 rounded-full bg-destructive mr-1.5" />Outstanding: <span className="font-semibold">{formatUGX(totals.outstanding)}</span></div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trend + Top/Bottom */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" /> Monthly Collection Trend ({format(day, 'MMM yyyy')})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={monthTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                <Tooltip formatter={(v: number) => formatUGX(v)} contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }} />
                <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Trophy className="h-4 w-4 text-warning" /> Top & Bottom Agents
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topAgent ? (
              <div className="p-3 rounded-xl border border-success/30 bg-success/5">
                <div className="flex items-center gap-2 text-xs font-semibold text-success mb-1">
                  <Trophy className="h-3.5 w-3.5" /> TOP PERFORMER
                </div>
                <p className="text-base font-bold">{topAgent.name}</p>
                <p className="text-2xl font-extrabold text-success">{topAgent.rate}%</p>
                <p className="text-[11px] text-muted-foreground">Collection Rate</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No agents yet.</p>
            )}
            {bottomAgent && bottomAgent.agentId !== topAgent?.agentId ? (
              <div className="p-3 rounded-xl border border-destructive/30 bg-destructive/5">
                <div className="flex items-center gap-2 text-xs font-semibold text-destructive mb-1">
                  <TrendingDown className="h-3.5 w-3.5" /> NEEDS IMPROVEMENT
                </div>
                <p className="text-base font-bold">{bottomAgent.name}</p>
                <p className="text-2xl font-extrabold text-destructive">{bottomAgent.rate}%</p>
                <p className="text-[11px] text-muted-foreground">Collection Rate</p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {mode === 'readonly' && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground p-2 rounded-lg bg-muted/30 border">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          You are viewing in read-only mode. Only Tenant Ops staff can record payments here.
        </div>
      )}

      {/* Record payment dialog */}
      <Dialog open={recordOpen} onOpenChange={setRecordOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment — {recordRow?.tenantName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2 rounded-lg bg-muted/40">
                <p className="text-muted-foreground">Expected</p>
                <p className="font-bold">{formatUGX(recordRow?.expected || 0)}</p>
              </div>
              <div className="p-2 rounded-lg bg-muted/40">
                <p className="text-muted-foreground">Outstanding</p>
                <p className="font-bold text-destructive">{formatUGX(recordRow?.balance || 0)}</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Amount (UGX)</Label>
              <Input type="number" inputMode="numeric" value={recordAmount} onChange={(e) => setRecordAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Payment Method</Label>
              <Select value={recordMethod} onValueChange={setRecordMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="mobile_money_mtn">MTN MoMo</SelectItem>
                  <SelectItem value="mobile_money_airtel">Airtel Money</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Remarks</Label>
              <Input value={recordRemarks} onChange={(e) => setRecordRemarks(e.target.value)} placeholder="e.g. Part payment, follow up tomorrow" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecordOpen(false)} disabled={submitting}>Cancel</Button>
            <Button onClick={submitRecord} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Record Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TenantAssignAgentDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        rentRequestId={assignRow?.rentRequestId || null}
        tenantId={assignRow?.tenantId || null}
        tenantName={assignRow?.tenantName || ''}
        currentAgentId={assignRow?.agentId || null}
        onSaved={() => { refetchCollections(); queryClient.invalidateQueries({ queryKey: ['daily-collection-rent-requests'] }); }}
      />
    </div>
  );
}

function KpiCard({ label, value, delta, icon: Icon, color, subtitle }: {
  label: string; value: string; delta?: { text: string; positive: boolean };
  icon: any; color: string; subtitle?: string;
}) {
  return (
    <Card className="border min-w-0">
      <CardContent className="p-3">
        <div className={cn('h-8 w-8 rounded-lg flex items-center justify-center mb-1.5', color)}>
          <Icon className="h-4 w-4" />
        </div>
        <p className="text-base sm:text-lg font-bold leading-tight truncate">{value}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{label}</p>
        {delta && (
          <p className={cn('text-[10px] mt-0.5 font-medium', delta.positive ? 'text-success' : 'text-destructive')}>
            {delta.text}
          </p>
        )}
        {subtitle && !delta && <p className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}