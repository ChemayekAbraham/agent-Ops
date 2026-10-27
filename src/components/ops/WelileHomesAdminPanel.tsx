import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { advanceWelileHomesFloat, WH_REASON_ILIKE } from '@/lib/welileHomesFloat';
import {
  Building2, Loader2, Search, Users, Banknote, TrendingUp, Clock,
  RefreshCw, Download, Wallet, Coins, Activity, Home,
  Smartphone, UserCheck, X, CheckCircle2, ArrowRight, ArrowUpRight,
  Filter, Info, ShieldCheck, Sparkles, AlertCircle, ChevronRight, ChevronDown, ChevronUp, Phone,
  LayoutDashboard, ArrowLeft, Calendar, ClipboardList, Inbox, Trash2, History, UserPlus, FileText, MoreHorizontal,
  BarChart3, XCircle
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { WelileHomesMobileBottomNav } from './WelileHomesMobileBottomNav';
import { AgentProfile360Sheet } from '@/components/executive/AgentProfile360Sheet';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  CartesianGrid,
  Legend as RechartsLegend,
  Cell,
} from 'recharts';

export type WelileTab = 'overview' | 'applications' | 'landlords' | 'all';
export type SubscriptionFilter = 'all' | 'float' | 'wallet' | 'smartphone' | 'high_outstanding';

export interface AttachedTenant {
  id: string;
  name: string;
  phone: string;
  agentName: string;
  monthlyRent: number;
  receivableTotal: number;
  outstandingBalance: number;
  repaidAmount: number;
  repaidRatio: number;
  agentCommission: number;
  ourProfit: number;
  payoutDay: number;
  usesWallet: boolean;
  hasSmartphone: boolean;
}

export interface LandlordBreakdownItem {
  name: string;
  tenantsCount: number;
  walletCount: number;
  floatCount: number;
  monthlyRevenue: number;
  totalReceivable: number;
  totalOutstanding: number;
  totalRepaid: number;
  agentCommission: number;
  monthlyCommission: number;
  ourProfit: number;
  monthlyProfit: number;
  payoutDays: number[];
  tenants: AttachedTenant[];
}

type DrillMetric =
  | 'tenants'
  | 'agents'
  | 'landlords'
  | 'monthly_pipeline'
  | 'receivable'
  | 'collections'
  | 'revenue'
  | 'payouts';

interface Row {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  monthly_rent: number;
  receivable_total: number;
  outstanding_balance: number;
  payout_day: number;
  landlord_uses_wallet: boolean;
  landlord_name: string | null;
  landlord_phone?: string | null;
  next_due_date: string | null;
  has_smartphone?: boolean;
  created_at?: string;
  tenant_name?: string;
  tenant_phone?: string;
  tenant_verified?: boolean;
  agent_name?: string;
  agent_phone?: string;
  source_type?: 'welile_homes' | 'general';
  subscription_status?: string;
  // Set only by the CFO server disbursement (wh_cfo_disburse_float). Not selected until
  // the Welile Homes float migration is applied, so it is undefined (never 'funded') before then.
  funding_status?: string;
}

export interface FloatRequestItem {
  id: string;
  agent_id: string;
  agent_name?: string;
  agent_phone?: string;
  requested_amount: number;
  reason: string | null;
  expected_recipient_phone: string | null;
  status: string;
  created_at: string;
  approved_at?: string | null;
}

export interface MonthlyDueRow {
  id: string;
  period_month: string;
  amount_due: number;
  amount_collected?: number | null;
  collection_status: string;
  payout_status: string;
  updated_at?: string;
}

type FilterCategory = 'all' | 'float' | 'wallet' | 'high_outstanding' | 'smartphone';

interface KpiTileProps {
  title: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  onClick?: () => void;
  loading?: boolean;
}

function KpiTile({ title, value, icon: Icon, accent, subtitle, badge, onClick, loading }: KpiTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group text-left rounded-xl sm:rounded-2xl border border-border/60 bg-card p-3 sm:p-4 w-full',
        'shadow-2xs hover:shadow-md hover:border-primary/50 transition-all',
        'flex flex-col justify-between gap-1.5 sm:gap-2 min-h-[106px] sm:min-h-[116px] relative overflow-hidden',
        onClick ? 'cursor-pointer active:scale-[0.98] hover:bg-muted/20' : ''
      )}
    >
      <div className="flex items-start justify-between gap-2 w-full">
        <div className={cn('h-7 w-7 sm:h-8 sm:w-8 rounded-lg sm:rounded-xl flex items-center justify-center shrink-0 shadow-2xs group-hover:scale-110 transition-transform duration-200', accent)}>
          <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-white" />
        </div>
        <div className="flex items-center gap-1">
          {badge}
          <div className="opacity-0 group-hover:opacity-100 transition-opacity text-primary -mr-0.5 hidden sm:block">
            <ArrowUpRight className="h-3.5 w-3.5" />
          </div>
        </div>
      </div>
      <div className="w-full min-w-0">
        <p className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground uppercase tracking-wider truncate">{title}</p>
        {loading ? (
          <Skeleton className="h-5 sm:h-6 w-20 sm:w-24 my-1" />
        ) : (
          <p className="text-sm sm:text-xl lg:text-2xl font-bold text-foreground leading-tight tabular-nums mt-0.5 truncate">{value}</p>
        )}
        {subtitle && !loading && (
          <p className="text-[9px] sm:text-[10px] text-muted-foreground truncate tabular-nums mt-0.5 sm:mt-1">{subtitle}</p>
        )}
      </div>
      <div className="w-full flex items-center justify-between text-[9px] sm:text-[10px] text-primary/80 font-medium pt-1 sm:pt-1.5 border-t border-border/30 opacity-70 group-hover:opacity-100 transition-opacity">
        <span className="flex items-center gap-1 font-semibold truncate">
          Inspect breakdown
        </span>
        <ArrowRight className="h-2.5 w-2.5 sm:h-3 sm:w-3 group-hover:translate-x-1 transition-transform shrink-0" />
      </div>
    </button>
  );
}

export function WelileHomesAdminPanel({ onBack }: { onBack?: () => void } = {}) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [activeTab, setActiveTab] = useState<WelileTab>('overview');
  const [subFilter, setSubFilter] = useState<SubscriptionFilter>('all');

  const openSubscriptions = (filter: SubscriptionFilter = 'all') => {
    setSubFilter(filter);
    setActiveTab('all');
  };
  const [stats, setStats] = useState({ collectedThisMonth: 0, welileNet: 0, pendingPayouts: 0 });
  const [activeDrill, setActiveDrill] = useState<DrillMetric | null>(null);
  const [drillSearch, setDrillSearch] = useState('');
  const [expandedLandlords, setExpandedLandlords] = useState<Record<string, boolean>>({});
  const [railChartMetric, setRailChartMetric] = useState<'volume' | 'landlords'>('volume');

  // Applications tab states
  const [appSearch, setAppSearch] = useState('');
  const [forwardingId, setForwardingId] = useState<string | null>(null);
  const [forwardingGroupId, setForwardingGroupId] = useState<string | null>(null);
  const [forwardingSelected, setForwardingSelected] = useState(false);
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);
  const [floatRequests, setFloatRequests] = useState<FloatRequestItem[]>([]);
  const [selectedAppTenantIds, setSelectedAppTenantIds] = useState<Set<string>>(new Set());
  const [appStatusFilter, setAppStatusFilter] = useState<'all' | 'declined'>('all');
  const [expandedAppLandlords, setExpandedAppLandlords] = useState<Record<string, boolean>>({});
  const [expandedEnrolledLandlords, setExpandedEnrolledLandlords] = useState<Record<string, boolean>>({});

  // Applications decline dialog states
  const [declineDialogOpen, setDeclineDialogOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('Declined by Agent Operations');
  const [declineTarget, setDeclineTarget] = useState<{
    title: string;
    description: string;
    tenantIds: string[];
    agentIds: string[];
    landlordName?: string;
  } | null>(null);
  const [declining, setDeclining] = useState(false);

  // Applications action dialog states
  const [historySub, setHistorySub] = useState<Row | null>(null);
  const [historyDues, setHistoryDues] = useState<MonthlyDueRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [verifySub, setVerifySub] = useState<Row | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [deleteSub, setDeleteSub] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [previewLandlord, setPreviewLandlord] = useState<LandlordBreakdownItem | null>(null);

  const toggleLandlord = (name: string) => {
    setExpandedLandlords((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const expandAllLandlords = () => {
    const next: Record<string, boolean> = {};
    enrolledLandlordsBreakdown.forEach((l) => { next[l.name] = true; });
    setExpandedLandlords(next);
  };

  const collapseAllLandlords = () => {
    setExpandedLandlords({});
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('welile_homes_subscriptions')
        .select('id, tenant_id, agent_id, monthly_rent, receivable_total, outstanding_balance, payout_day, landlord_uses_wallet, landlord_name, landlord_phone, next_due_date, has_smartphone, created_at, subscription_status')
        .eq('mode', 'agent_collection')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const list = (data ?? []) as Row[];
      const ids = Array.from(new Set([...list.map((r) => r.tenant_id), ...list.map((r) => r.agent_id).filter(Boolean) as string[]]));
      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id, full_name, phone, verified').in('id', ids);
        const profileList = (profs ?? []) as unknown as { id: string; full_name: string | null; phone: string | null; verified?: boolean | null }[];
        const map = new Map(profileList.map((p) => [p.id, p]));
        list.forEach((r) => {
          r.source_type = 'welile_homes';
          const tProf = map.get(r.tenant_id);
          r.tenant_name = tProf?.full_name ?? 'Tenant';
          r.tenant_phone = tProf?.phone ?? '';
          r.tenant_verified = !!tProf?.verified;
          const aProf = r.agent_id ? map.get(r.agent_id) : undefined;
          r.agent_name = aProf?.full_name ?? (r.agent_id ? 'Agent' : '—');
          r.agent_phone = aProf?.phone ?? '';
        });
      }
      setRows(list);

      // Load Float Requests from agents
      try {
        const { data: fReqs } = await supabase
          .from('float_requests')
          .select('id, agent_id, requested_amount, reason, expected_recipient_phone, status, created_at, approved_at')
          // Welile Homes requests only; Merchant float requests belong to the Merchant panel.
          .ilike('reason', WH_REASON_ILIKE)
          .order('created_at', { ascending: false })
          .limit(100);

        if (fReqs && fReqs.length > 0) {
          const fAgentIds = Array.from(new Set(fReqs.map((f) => f.agent_id).filter(Boolean)));
          const { data: fProfs } = await supabase.from('profiles').select('id, full_name, phone').in('id', fAgentIds);
          const fMap = new Map((fProfs ?? []).map((p: { id: string; full_name: string | null; phone: string | null }) => [p.id, p]));
          setFloatRequests(fReqs.map((f: FloatRequestItem) => ({
            ...f,
            agent_name: fMap.get(f.agent_id)?.full_name ?? 'Agent',
            agent_phone: fMap.get(f.agent_id)?.phone ?? '',
          })));
        } else {
          setFloatRequests([]);
        }
      } catch (fErr) {
        console.warn('Float requests fetch warning:', fErr);
      }

      const monthStart = new Date();
      monthStart.setDate(1);
      const { data: dues } = await supabase
        .from('welile_homes_monthly_dues')
        .select('amount_collected, welile_net, landlord_net, collection_status, payout_status, period_month');
      let collectedThisMonth = 0, welileNet = 0, pendingPayouts = 0;
      const mKey = monthStart.toISOString().slice(0, 7);
      const duesList = (dues ?? []) as unknown as {
        amount_collected: number | null;
        welile_net: number | null;
        landlord_net: number | null;
        collection_status: string | null;
        payout_status: string | null;
        period_month: string | null;
      }[];
      duesList.forEach((d) => {
        if (String(d.period_month).slice(0, 7) === mKey) collectedThisMonth += Number(d.amount_collected) || 0;
        if (d.collection_status === 'collected') welileNet += Number(d.welile_net) || 0;
        if (d.collection_status === 'collected' && d.payout_status === 'unpaid') pendingPayouts += Number(d.landlord_net) || 0;
      });
      setStats({ collectedThisMonth, welileNet, pendingPayouts });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Failed to load Welile Homes: ' + msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Calculations for Agent Ops Overview metrics
  const totalReceivable = useMemo(() => rows.reduce((a, r) => a + (Number(r.receivable_total) || 0), 0), [rows]);
  const monthlyRentTotal = useMemo(() => rows.reduce((a, r) => a + (Number(r.monthly_rent) || 0), 0), [rows]);
  const totalOutstanding = useMemo(() => rows.reduce((a, r) => a + (Number(r.outstanding_balance) || 0), 0), [rows]);
  const totalRepaid = Math.max(0, totalReceivable - totalOutstanding);
  const collectionRate = totalReceivable > 0 ? (totalRepaid / totalReceivable) * 100 : 0;

  const uniqueAgentCount = useMemo(() => new Set(rows.map((r) => r.agent_id).filter(Boolean)).size, [rows]);
  const uniqueLandlordCount = useMemo(() => new Set(rows.map((r) => (r.landlord_name || '').trim().toLowerCase()).filter(Boolean)).size, [rows]);
  const walletLandlordsCount = useMemo(() => rows.filter((r) => r.landlord_uses_wallet).length, [rows]);
  const floatLandlordsCount = useMemo(() => rows.filter((r) => !r.landlord_uses_wallet).length, [rows]);
  const smartphoneCount = useMemo(() => rows.filter((r) => r.has_smartphone).length, [rows]);
  const highBalanceCount = useMemo(() => rows.filter((r) => r.outstanding_balance > r.monthly_rent * 6).length, [rows]);

  const payoutCycles = useMemo(() => {
    const map = new Map<number, { day: number; count: number; monthlyTotal: number; walletCount: number; floatCount: number }>();
    rows.forEach((r) => {
      const day = r.payout_day || 1;
      const existing = map.get(day) || { day, count: 0, monthlyTotal: 0, walletCount: 0, floatCount: 0 };
      existing.count += 1;
      existing.monthlyTotal += Number(r.monthly_rent) || 0;
      if (r.landlord_uses_wallet) existing.walletCount += 1;
      else existing.floatCount += 1;
      map.set(day, existing);
    });
    return Array.from(map.values()).sort((a, b) => a.day - b.day);
  }, [rows]);

  const walletVolume = useMemo(() => {
    return rows.filter((r) => r.landlord_uses_wallet).reduce((acc, r) => acc + (Number(r.monthly_rent) || 0), 0);
  }, [rows]);

  const floatVolume = useMemo(() => {
    return rows.filter((r) => !r.landlord_uses_wallet).reduce((acc, r) => acc + (Number(r.monthly_rent) || 0), 0);
  }, [rows]);

  const settlementRailsChartData = useMemo(() => {
    const totalVol = walletVolume + floatVolume;
    const totalLandlords = walletLandlordsCount + floatLandlordsCount;

    return [
      {
        channel: 'Welile Wallet Direct Rails',
        shortName: 'Welile Wallet',
        volume: walletVolume,
        landlords: walletLandlordsCount,
        volumePercent: totalVol > 0 ? (walletVolume / totalVol) * 100 : 0,
        landlordsPercent: totalLandlords > 0 ? (walletLandlordsCount / totalLandlords) * 100 : 0,
        fill: 'hsl(var(--primary))',
        mode: '100% Automated · Ledger',
        type: 'wallet' as const,
      },
      {
        channel: 'Agent Float Cash Distribution',
        shortName: 'Agent Float',
        volume: floatVolume,
        landlords: floatLandlordsCount,
        volumePercent: totalVol > 0 ? (floatVolume / totalVol) * 100 : 0,
        landlordsPercent: totalLandlords > 0 ? (floatLandlordsCount / totalLandlords) * 100 : 0,
        fill: '#f59e0b',
        mode: 'Field Cash · Float Delivery',
        type: 'float' as const,
      },
    ];
  }, [walletVolume, floatVolume, walletLandlordsCount, floatLandlordsCount]);

  const healthBands = useMemo(() => {
    let nearCompletion = 0;
    let nearCompletionAmount = 0;
    let midTerm = 0;
    let midTermAmount = 0;
    let highBalance = 0;
    let highBalanceAmount = 0;

    rows.forEach((r) => {
      const rent = Number(r.monthly_rent) || 0;
      const bal = Number(r.outstanding_balance) || 0;
      if (bal <= rent * 3) {
        nearCompletion += 1;
        nearCompletionAmount += bal;
      } else if (bal <= rent * 6) {
        midTerm += 1;
        midTermAmount += bal;
      } else {
        highBalance += 1;
        highBalanceAmount += bal;
      }
    });

    return {
      nearCompletion,
      nearCompletionAmount,
      midTerm,
      midTermAmount,
      highBalance,
      highBalanceAmount,
    };
  }, [rows]);

  const agentsBreakdown = useMemo(() => {
    const map = new Map<string, { id: string; name: string; tenantsCount: number; rentTotal: number; receivableTotal: number; outstandingTotal: number }>();
    rows.forEach((r) => {
      const key = r.agent_id || 'unassigned';
      const name = r.agent_name || (r.agent_id ? 'Agent' : 'Unassigned');
      const existing = map.get(key) || {
        id: key,
        name,
        tenantsCount: 0,
        rentTotal: 0,
        receivableTotal: 0,
        outstandingTotal: 0,
      };
      existing.tenantsCount += 1;
      existing.rentTotal += Number(r.monthly_rent) || 0;
      existing.receivableTotal += Number(r.receivable_total) || 0;
      existing.outstandingTotal += Number(r.outstanding_balance) || 0;
      map.set(key, existing);
    });
    return Array.from(map.values()).sort((a, b) => b.rentTotal - a.rentTotal);
  }, [rows]);

  // Active non-cancelled subscription rows & breakdown
  const activeRows = useMemo(() => rows.filter((r) => r.subscription_status !== 'cancelled'), [rows]);
  const declinedTenantsCount = useMemo(() => rows.filter((r) => r.subscription_status === 'cancelled').length, [rows]);

  const buildLandlordBreakdown = (source: Row[]): LandlordBreakdownItem[] => {
    const map = new Map<string, LandlordBreakdownItem>();
    source.forEach((r) => {
      const key = (r.landlord_name || 'Direct / Unassigned Landlord').trim();
      const existing = map.get(key) || {
        name: key,
        tenantsCount: 0,
        walletCount: 0,
        floatCount: 0,
        monthlyRevenue: 0,
        totalReceivable: 0,
        totalOutstanding: 0,
        totalRepaid: 0,
        agentCommission: 0,
        monthlyCommission: 0,
        ourProfit: 0,
        monthlyProfit: 0,
        payoutDays: [],
        tenants: [],
      };

      const rent = Number(r.monthly_rent) || 0;
      const rec = Number(r.receivable_total) || 0;
      const out = Number(r.outstanding_balance) || 0;
      const repaid = Math.max(0, rec - out);
      const ratio = rec > 0 ? (repaid / rec) * 100 : 0;
      const agentComm = Math.round(rec * 0.02);
      const profit = Math.round(rec * 0.08);

      existing.tenantsCount += 1;
      if (r.landlord_uses_wallet) existing.walletCount += 1;
      else existing.floatCount += 1;

      existing.monthlyRevenue += rent;
      existing.totalReceivable += rec;
      existing.totalOutstanding += out;
      existing.totalRepaid += repaid;
      existing.agentCommission += agentComm;
      existing.monthlyCommission += Math.round(rent * 0.02);
      existing.ourProfit += profit;
      existing.monthlyProfit += Math.round(rent * 0.08);

      if (r.payout_day && !existing.payoutDays.includes(r.payout_day)) {
        existing.payoutDays.push(r.payout_day);
      }

      existing.tenants.push({
        id: r.id,
        name: r.tenant_name || 'Unnamed Tenant',
        phone: r.tenant_phone || '',
        agentName: r.agent_name || 'Agent',
        monthlyRent: rent,
        receivableTotal: rec,
        outstandingBalance: out,
        repaidAmount: repaid,
        repaidRatio: ratio,
        agentCommission: agentComm,
        ourProfit: profit,
        payoutDay: r.payout_day || 1,
        usesWallet: !!r.landlord_uses_wallet,
        hasSmartphone: !!r.has_smartphone,
      });

      map.set(key, existing);
    });
    return Array.from(map.values()).sort((a, b) => b.totalReceivable - a.totalReceivable);
  };

  // Every landlord on file (overview drill-downs).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const landlordsBreakdown = useMemo(() => buildLandlordBreakdown(activeRows), [activeRows]);

  // Enrolled = active (non-cancelled) subscriptions. This is NOT proof of CFO funding: that link
  // (funding_status set by wh_cfo_disburse_float) is pending migration, so no funding is claimed here.
  const enrolledRows = activeRows;
  const enrolledLandlordsBreakdown = landlordsBreakdown;
  const enrolledOutstanding = useMemo(() => enrolledRows.reduce((a, r) => a + (Number(r.outstanding_balance) || 0), 0), [enrolledRows]);

  const totalLandlordRevenue = useMemo(() => enrolledLandlordsBreakdown.reduce((s, l) => s + l.monthlyRevenue, 0), [enrolledLandlordsBreakdown]);
  const totalLandlordReceivables = useMemo(() => enrolledLandlordsBreakdown.reduce((s, l) => s + l.totalReceivable, 0), [enrolledLandlordsBreakdown]);
  const totalLandlordAgentCommission = useMemo(() => enrolledLandlordsBreakdown.reduce((s, l) => s + l.agentCommission, 0), [enrolledLandlordsBreakdown]);
  const monthlyLandlordAgentCommission = useMemo(() => enrolledLandlordsBreakdown.reduce((s, l) => s + l.monthlyCommission, 0), [enrolledLandlordsBreakdown]);
  const totalLandlordProfit = useMemo(() => enrolledLandlordsBreakdown.reduce((s, l) => s + l.ourProfit, 0), [enrolledLandlordsBreakdown]);
  const monthlyLandlordProfit = useMemo(() => enrolledLandlordsBreakdown.reduce((s, l) => s + l.monthlyProfit, 0), [enrolledLandlordsBreakdown]);

  // Chart Data for Capital Recovery & Aging Exposure Distribution
  const receivablesDistributionChartData = useMemo(() => [
    {
      category: 'Repaid',
      label: 'Collected Capital (Repaid)',
      amount: totalRepaid,
      percent: totalReceivable > 0 ? (totalRepaid / totalReceivable) * 100 : 0,
      accounts: rows.filter((r) => (Number(r.receivable_total) - Number(r.outstanding_balance)) > 0).length,
      fill: '#10b981',
      status: 'Recovered',
    },
    {
      category: '<3 Months',
      label: 'Near Completion (<3 Mo)',
      amount: healthBands.nearCompletionAmount,
      percent: totalReceivable > 0 ? (healthBands.nearCompletionAmount / totalReceivable) * 100 : 0,
      accounts: healthBands.nearCompletion,
      fill: '#06b6d4',
      status: 'Low Risk',
    },
    {
      category: '3-6 Months',
      label: 'Mid-Cycle (3-6 Mo)',
      amount: healthBands.midTermAmount,
      percent: totalReceivable > 0 ? (healthBands.midTermAmount / totalReceivable) * 100 : 0,
      accounts: healthBands.midTerm,
      fill: '#3b82f6',
      status: 'Standard',
    },
    {
      category: '>6 Months',
      label: 'High Exposure (>6 Mo)',
      amount: healthBands.highBalanceAmount,
      percent: totalReceivable > 0 ? (healthBands.highBalanceAmount / totalReceivable) * 100 : 0,
      accounts: healthBands.highBalance,
      fill: '#f43f5e',
      status: 'High Exposure',
    },
  ], [totalRepaid, totalReceivable, healthBands, rows]);

  // Applications calculations & grouping
  const totalFloatRequired = useMemo(() => activeRows.reduce((s, r) => s + (Number(r.monthly_rent) || 0), 0), [activeRows]);
  const unverifiedTenantsCount = useMemo(() => activeRows.filter((r) => !r.tenant_verified).length, [activeRows]);
  const pendingFloatRequestsCount = useMemo(() => floatRequests.filter((f) => f.status === 'pending').length, [floatRequests]);

  const applicationsByLandlord = useMemo(() => {
    const map = new Map<string, {
      key: string;
      landlordName: string;
      landlordPhone: string;
      agentId: string | null;
      agentName: string;
      agentPhone: string;
      totalFloat: number;
      totalOutstanding: number;
      tenants: Row[];
    }>();

    rows.forEach((r) => {
      // Filter by app search query if typed
      if (appSearch) {
        const s = appSearch.toLowerCase();
        const matches =
          r.tenant_name?.toLowerCase().includes(s) ||
          r.tenant_phone?.toLowerCase().includes(s) ||
          r.landlord_name?.toLowerCase().includes(s) ||
          r.landlord_phone?.toLowerCase().includes(s) ||
          r.agent_name?.toLowerCase().includes(s);
        if (!matches) return;
      }

      // Filter active vs declined
      if (appStatusFilter === 'declined') {
        if (r.subscription_status !== 'cancelled') return;
      } else {
        if (r.subscription_status === 'cancelled') return;
      }

      const name = (r.landlord_name || 'Unassigned Landlord').trim();
      const phone = r.landlord_phone || '';
      const key = `${name.toLowerCase()}|${phone}`;
      let item = map.get(key);
      if (!item) {
        item = {
          key,
          landlordName: name,
          landlordPhone: phone,
          agentId: r.agent_id || null,
          agentName: r.agent_name || 'Agent',
          agentPhone: r.agent_phone || '',
          totalFloat: 0,
          totalOutstanding: 0,
          tenants: [],
        };
        map.set(key, item);
      }
      item.tenants.push(r);
      item.totalFloat += Number(r.monthly_rent) || 0;
      item.totalOutstanding += Number(r.outstanding_balance) || 0;
    });

    return Array.from(map.values()).sort((a, b) => b.totalFloat - a.totalFloat);
  }, [rows, appSearch, appStatusFilter]);

  const selectedAppTenants = useMemo(() => {
    return rows.filter((r) => selectedAppTenantIds.has(r.id));
  }, [rows, selectedAppTenantIds]);

  const selectedAppTotalFloat = useMemo(() => {
    return selectedAppTenants.reduce((sum, r) => sum + (Number(r.monthly_rent) || 0), 0);
  }, [selectedAppTenants]);

  const selectedAppLandlordNames = useMemo(() => {
    return Array.from(new Set(selectedAppTenants.map((r) => (r.landlord_name || 'Unassigned').trim())));
  }, [selectedAppTenants]);

  const toggleLandlordSelect = (tenants: Row[]) => {
    const allSelected = tenants.every((t) => selectedAppTenantIds.has(t.id));
    const next = new Set(selectedAppTenantIds);
    if (allSelected) {
      tenants.forEach((t) => next.delete(t.id));
    } else {
      tenants.forEach((t) => next.add(t.id));
    }
    setSelectedAppTenantIds(next);
  };

  const toggleTenantSelect = (id: string) => {
    const next = new Set(selectedAppTenantIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedAppTenantIds(next);
  };

  const exportSelectedApplications = () => {
    const list = selectedAppTenants.length > 0 ? selectedAppTenants : rows;
    if (!list.length) {
      toast.error('No applications to export');
      return;
    }
    const headers = ['Tenant Name', 'Tenant Phone', 'Landlord Name', 'Landlord Phone', 'Agent Name', 'Monthly Rent', 'Outstanding Balance', 'Payout Day', 'Verified', 'Channel'];
    const csvLines = list.map((r) => [
      `"${r.tenant_name || ''}"`,
      `"${r.tenant_phone || ''}"`,
      `"${r.landlord_name || ''}"`,
      `"${r.landlord_phone || ''}"`,
      `"${r.agent_name || ''}"`,
      r.monthly_rent,
      r.outstanding_balance,
      r.payout_day,
      r.tenant_verified ? 'Verified' : 'Unverified',
      r.landlord_uses_wallet ? 'Welile Wallet' : 'Agent Float',
    ].join(','));
    const csv = [headers.join(','), ...csvLines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `welile_homes_agent_applications_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`Exported ${list.length} application(s)`);
  };

  // Reject a float request with a note. Tenants stay enrolled, so the agent can request again
  // through the new flow (which records exactly which tenants the request covers).
  const [rejectReq, setRejectReq] = useState<FloatRequestItem | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectingReq, setRejectingReq] = useState(false);

  const openRejectRequest = (req: FloatRequestItem) => {
    setRejectReq(req);
    setRejectNote('Please request again from your Welile Homes screen so the tenants are linked to the request.');
  };

  const confirmRejectRequest = async () => {
    if (!rejectReq) return;
    setRejectingReq(true);
    try {
      await advanceWelileHomesFloat({
        requestId: rejectReq.id,
        expectedStatus: rejectReq.status,
        action: 'reject',
        note: rejectNote,
      });
      toast.success(`Float request from ${rejectReq.agent_name || 'agent'} rejected. Tenants stay enrolled.`);
      setRejectReq(null);
      await load();
    } catch (err: unknown) {
      toast.error('Could not reject request: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRejectingReq(false);
    }
  };

  const forwardToTenantOps = async (requestId: string) => {
    const req = floatRequests.find((f) => f.id === requestId);
    if (!req) return;
    setForwardingId(requestId);
    try {
      await advanceWelileHomesFloat({ requestId, expectedStatus: req.status, action: 'approve' });
      toast.success('Approved by Agent Ops & forwarded to Tenant Ops desk for tenant verification');
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Failed to forward request: ' + msg);
    } finally {
      setForwardingId(null);
    }
  };

  // Approve the agent's own pending Welile Homes request(s). Agent Ops never creates a request
  // on the agent's behalf: the request must come from the agent, carrying its tenant links.
  const approvePendingForAgents = async (agentIds: string[]): Promise<{ approved: number; missing: string[] }> => {
    let approved = 0;
    const missing: string[] = [];
    for (const aid of agentIds) {
      const pending = floatRequests.filter((f) => f.agent_id === aid && f.status === 'pending');
      if (pending.length === 0) {
        missing.push(aid);
        continue;
      }
      for (const req of pending) {
        await advanceWelileHomesFloat({ requestId: req.id, expectedStatus: 'pending', action: 'approve' });
        approved += 1;
      }
    }
    return { approved, missing };
  };

  const forwardGroupToTenantOps = async (group: {
    key: string;
    landlordName: string;
    agentId: string | null;
    agentName?: string;
    tenants: Row[];
    totalFloat: number;
  }) => {
    setForwardingGroupId(group.key);
    try {
      if (!group.agentId) {
        toast.error('Cannot forward: No agent ID linked to this application');
        return;
      }
      const { approved } = await approvePendingForAgents([group.agentId]);
      if (approved === 0) {
        toast.error(
          `${group.agentName || 'The agent'} has not requested float for these tenants yet. ` +
            'The agent must send the request from their Welile Homes screen.'
        );
        return;
      }
      toast.success(`Float request for ${group.landlordName} approved & forwarded to Tenant Ops`);
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Failed to forward to Tenant Ops: ' + msg);
    } finally {
      setForwardingGroupId(null);
    }
  };

  const forwardSelectedToTenantOps = async () => {
    if (selectedAppTenants.length === 0) return;
    setForwardingSelected(true);
    try {
      const agentIds = Array.from(
        new Set(selectedAppTenants.map((t) => t.agent_id).filter(Boolean) as string[])
      );
      const { approved, missing } = await approvePendingForAgents(agentIds);
      if (approved > 0) {
        toast.success(`Approved ${approved} float request(s) & forwarded to Tenant Ops`);
      }
      if (missing.length > 0) {
        toast.error(
          `${missing.length} agent(s) have not requested float yet. They must send the request from their Welile Homes screen.`
        );
      }
      setSelectedAppTenantIds(new Set());
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Failed to forward: ' + msg);
    } finally {
      setForwardingSelected(false);
    }
  };

  const handleDeclineGroup = (group: {
    key: string;
    landlordName: string;
    agentId: string | null;
    tenants: Row[];
    totalFloat: number;
  }) => {
    setDeclineReason('Declined by Agent Operations');
    setDeclineTarget({
      title: `Decline application for ${group.landlordName}?`,
      description: `This will decline ${group.tenants.length} tenant application(s) under ${group.landlordName} totaling ${formatUGX(group.totalFloat)}.`,
      tenantIds: group.tenants.map((t) => t.id),
      agentIds: group.agentId ? [group.agentId] : [],
      landlordName: group.landlordName,
    });
    setDeclineDialogOpen(true);
  };

  const handleDeclineTenant = (tenant: Row) => {
    setDeclineReason('Declined by Agent Operations');
    setDeclineTarget({
      title: `Decline application for ${tenant.tenant_name}?`,
      description: `This will decline ${tenant.tenant_name}'s application (rent: ${formatUGX(tenant.monthly_rent)}) under ${tenant.landlord_name || 'Landlord'}.`,
      tenantIds: [tenant.id],
      agentIds: tenant.agent_id ? [tenant.agent_id] : [],
      landlordName: tenant.landlord_name || undefined,
    });
    setDeclineDialogOpen(true);
  };

  const handleDeclineSelected = () => {
    if (selectedAppTenants.length === 0) return;
    const agentIds = Array.from(
      new Set(selectedAppTenants.map((t) => t.agent_id).filter(Boolean) as string[])
    );
    const totalAmount = selectedAppTenants.reduce(
      (sum, r) => sum + (Number(r.monthly_rent) || 0),
      0
    );
    const landlordsCount = new Set(
      selectedAppTenants.map((t) => t.landlord_name || 'Landlord')
    ).size;

    setDeclineReason('Declined by Agent Operations');
    setDeclineTarget({
      title: `Decline ${selectedAppTenants.length} selected application(s)?`,
      description: `This will decline ${selectedAppTenants.length} tenant application(s) across ${landlordsCount} landlord(s) totaling ${formatUGX(totalAmount)}.`,
      tenantIds: selectedAppTenants.map((t) => t.id),
      agentIds,
    });
    setDeclineDialogOpen(true);
  };

  const confirmDecline = async () => {
    if (!declineTarget || declineTarget.tenantIds.length === 0) return;
    setDeclining(true);
    try {
      const reason = declineReason.trim() || 'Declined by Agent Operations';

      // 1. Mark subscription(s) as cancelled/declined
      const { error: subErr } = await supabase
        .from('welile_homes_subscriptions')
        .update({
          subscription_status: 'cancelled',
          notes: `Declined by Agent Ops: ${reason}`,
          updated_at: new Date().toISOString(),
        })
        .in('id', declineTarget.tenantIds);

      if (subErr) throw subErr;

      // 2. Reject these agents' pending Welile Homes float requests (never Merchant ones).
      const toReject = floatRequests.filter(
        (f) => f.status === 'pending' && declineTarget.agentIds.includes(f.agent_id)
      );
      for (const req of toReject) {
        try {
          await advanceWelileHomesFloat({
            requestId: req.id,
            expectedStatus: 'pending',
            action: 'reject',
            note: reason.length >= 5 ? reason : `Declined by Agent Ops: ${reason}`,
          });
        } catch (floatErr) {
          console.warn('Float request reject warning:', floatErr);
        }
      }

      toast.success(
        `Declined ${declineTarget.tenantIds.length} application(s)${
          declineTarget.landlordName ? ` for ${declineTarget.landlordName}` : ''
        }`
      );

      // Clean up selection and dialog
      setSelectedAppTenantIds((prev) => {
        const next = new Set(prev);
        declineTarget.tenantIds.forEach((id) => next.delete(id));
        return next;
      });
      setDeclineDialogOpen(false);
      setDeclineTarget(null);
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Failed to decline application: ' + msg);
    } finally {
      setDeclining(false);
    }
  };

  useEffect(() => {
    if (!historySub) {
      setHistoryDues([]);
      return;
    }
    let active = true;
    setLoadingHistory(true);
    supabase
      .from('welile_homes_monthly_dues')
      .select('id, period_month, amount_due, amount_collected, collection_status, payout_status, updated_at')
      .eq('subscription_id', historySub.id)
      .order('period_month', { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        setLoadingHistory(false);
        if (!error && data) {
          setHistoryDues(data);
        }
      });
    return () => { active = false; };
  }, [historySub]);

  const handleVerifyDirect = async () => {
    if (!verifySub) return;
    setVerifying(true);
    try {
      const { error } = await supabase.rpc('welile_home_mark_tenant_verified', {
        p_subscription_id: verifySub.id,
      });
      if (error) throw error;
      toast.success(`Tenant ${verifySub.tenant_name} marked as verified`);
      setVerifySub(null);
      load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Verification failed: ' + msg);
    } finally {
      setVerifying(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteSub) return;
    setDeleting(true);
    try {
      const { error } = await (supabase.rpc as unknown as (fn: string, args: { p_subscription_id: string }) => Promise<{ error: Error | null }>)(
        'delete_welile_home_subscription',
        { p_subscription_id: deleteSub.id }
      );
      if (error) throw error;
      toast.success(`Application for ${deleteSub.tenant_name} deleted`);
      setDeleteSub(null);
      load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Delete failed: ' + msg);
    } finally {
      setDeleting(false);
    }
  };

  // Tabs definition - 4 primary tabs
  const tabs = useMemo(() => [
    { id: 'overview' as const, label: 'Overview', badge: 'Live Book', icon: LayoutDashboard },
    {
      id: 'applications' as const,
      label: 'Rent Float Applications',
      count: activeRows.length,
      icon: ClipboardList,
    },
    { id: 'landlords' as const, label: 'Enrolled Portfolios', count: enrolledLandlordsBreakdown.length, icon: Home },
    {
      id: 'all' as const,
      label: 'Subscriptions',
      count: rows.length,
      icon: Users,
    },
  ], [rows.length, enrolledLandlordsBreakdown.length, pendingFloatRequestsCount]);

  // Filtering
  const filtered = useMemo(() => {
    return rows.filter((r) => {
      // Sub filter
      if (subFilter === 'float' && r.landlord_uses_wallet) return false;
      if (subFilter === 'wallet' && !r.landlord_uses_wallet) return false;
      if (subFilter === 'smartphone' && !r.has_smartphone) return false;
      if (subFilter === 'high_outstanding' && r.outstanding_balance <= r.monthly_rent * 6) return false;

      // Search text filter
      if (!q) return true;
      const s = q.toLowerCase();
      return (
        r.tenant_name?.toLowerCase().includes(s) ||
        r.tenant_phone?.toLowerCase().includes(s) ||
        r.agent_name?.toLowerCase().includes(s) ||
        r.landlord_name?.toLowerCase().includes(s)
      );
    });
  }, [rows, subFilter, q]);

  // CSV Export
  const exportToCSV = () => {
    if (!rows.length) {
      toast.error('No data to export');
      return;
    }
    const headers = ['Tenant Name', 'Tenant Phone', 'Agent', 'Monthly Rent', 'Receivable (x12)', 'Outstanding Balance', 'Payout Day', 'Landlord Destination', 'Landlord Name'];
    const csvRows = rows.map((r) => [
      `"${r.tenant_name || ''}"`,
      `"${r.tenant_phone || ''}"`,
      `"${r.agent_name || ''}"`,
      r.monthly_rent,
      r.receivable_total,
      r.outstanding_balance,
      r.payout_day,
      r.landlord_uses_wallet ? 'Welile Wallet' : 'Agent Float',
      `"${r.landlord_name || ''}"`,
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...csvRows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `welile_homes_overview_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Welile Homes report exported');
  };

  // Filtered Landlords list
  const filteredLandlords = useMemo(() => {
    if (!q) return enrolledLandlordsBreakdown;
    const s = q.toLowerCase();
    return enrolledLandlordsBreakdown.filter((l) => {
      if (l.name.toLowerCase().includes(s)) return true;
      return l.tenants.some((t) =>
        t.name.toLowerCase().includes(s) ||
        t.phone.toLowerCase().includes(s) ||
        t.agentName.toLowerCase().includes(s)
      );
    });
  }, [enrolledLandlordsBreakdown, q]);

  // Landlord Portfolio CSV Export
  const exportLandlordsCSV = () => {
    if (!enrolledLandlordsBreakdown.length) {
      toast.error('No landlords data to export');
      return;
    }
    const headers = ['Landlord Name', 'Attached Tenants Count', 'Tenant Names', 'Monthly Revenue', '12-Month Receivables', 'Outstanding Balance', 'Agent Commission (2%)', 'Our Profit (8%)', 'Payout Days', 'Settlement Channel'];
    const csvRows = enrolledLandlordsBreakdown.map((l) => [
      `"${l.name}"`,
      l.tenantsCount,
      `"${l.tenants.map((t) => t.name).join('; ')}"`,
      l.monthlyRevenue,
      l.totalReceivable,
      l.totalOutstanding,
      l.agentCommission,
      l.ourProfit,
      `"${l.payoutDays.join(', ')}"`,
      l.walletCount > 0 ? (l.floatCount > 0 ? 'Mixed (Wallet + Float)' : 'Welile Wallet') : 'Agent Float',
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...csvRows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `welile_homes_landlords_profit_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Landlords Profitability report exported');
  };

  return (
    <div className="space-y-4 sm:space-y-5 pb-24 md:pb-8">
      {/* Sticky Top Tab Bar with Overview as first tab (Desktop/Tablet only, mobile uses bottom nav) */}
      <div className="hidden md:flex sticky top-0 z-20 px-0 py-2 bg-background/95 backdrop-blur-md border-b border-border/50 items-center gap-2">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar scroll-smooth flex-1 min-w-0">
          {tabs.map((t) => {
            const isSelected = activeTab === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  'shrink-0 text-xs px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-full font-medium transition-all select-none flex items-center gap-1.5 sm:gap-2',
                  isSelected
                    ? 'bg-primary text-primary-foreground shadow-sm ring-2 ring-primary/20'
                    : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground border border-border/50'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="whitespace-nowrap">{t.label}</span>
                {t.badge && (
                  <span className={cn('text-[9px] uppercase px-1.5 py-0.2 rounded-full font-bold tracking-wider', isSelected ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-primary/10 text-primary')}>
                    {t.badge}
                  </span>
                )}
                {typeof t.count === 'number' && (
                  <span className={cn('text-[10px] px-1.5 py-0.2 rounded-full font-bold', isSelected ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-background text-muted-foreground')}>
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {onBack && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground shrink-0 cursor-pointer gap-1.5 border border-border/50 rounded-full"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Exit to Ops</span>
          </Button>
        )}
      </div>

      {/* OVERVIEW TAB CONTENT */}
      {activeTab === 'overview' ? (
        <>
          {/* Row A: Network & Scale KPIs */}
          <div>
            <div className="flex items-center justify-between mb-2 px-0.5">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Network & Rent Capacity
              </h3>
              <span className="text-[11px] text-muted-foreground hidden sm:inline">Active Portfolio Snapshot</span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
              <KpiTile
                title="Enrolled Tenants"
                value={loading ? '...' : String(rows.length)}
                subtitle={`${smartphoneCount} self-managed · ${rows.length - smartphoneCount} agent-allocated`}
                icon={Users}
                accent="bg-primary"
                onClick={() => { setActiveDrill('tenants'); setDrillSearch(''); }}
                badge={
                  <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary border-primary/20">
                    Live Book
                  </Badge>
                }
                loading={loading}
              />
              <KpiTile
                title="Active Agents"
                value={loading ? '...' : String(uniqueAgentCount)}
                subtitle="Managing Welile Homes tenants"
                icon={Activity}
                accent="bg-emerald-600"
                onClick={() => { setActiveDrill('agents'); setDrillSearch(''); }}
                badge={
                  <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">
                    Allocating
                  </Badge>
                }
                loading={loading}
              />
              <KpiTile
                title="Active Landlords"
                value={loading ? '...' : String(uniqueLandlordCount)}
                subtitle={`${walletLandlordsCount} Welile wallet · ${floatLandlordsCount} Agent float`}
                icon={Home}
                accent="bg-sky-600"
                onClick={() => { setActiveDrill('landlords'); setDrillSearch(''); }}
                badge={
                  <Badge variant="secondary" className="text-[10px] bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20">
                    On File
                  </Badge>
                }
                loading={loading}
              />
              <KpiTile
                title="Monthly Rent Pipeline"
                value={loading ? '...' : formatUGX(monthlyRentTotal)}
                subtitle={`Annualized: ${formatUGX(monthlyRentTotal * 12)}`}
                icon={TrendingUp}
                accent="bg-indigo-600"
                onClick={() => { setActiveDrill('monthly_pipeline'); setDrillSearch(''); }}
                badge={
                  <Badge variant="secondary" className="text-[10px] bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20">
                    Per Month
                  </Badge>
                }
                loading={loading}
              />
            </div>
          </div>

          {/* Row B: Financial & Collections KPIs */}
          <div>
            <div className="flex items-center justify-between mb-2 px-0.5">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Collections & Revenue Performance
              </h3>
              <span className="text-[11px] text-muted-foreground hidden sm:inline">General Ledger Flow</span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
              <KpiTile
                title="Total Booked Receivable"
                value={loading ? '...' : formatUGX(totalReceivable)}
                subtitle="12-month advance receivables recognized"
                icon={Banknote}
                accent="bg-blue-600"
                onClick={() => { setActiveDrill('receivable'); setDrillSearch(''); }}
                badge={
                  <Badge variant="secondary" className="text-[10px] bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20">
                    Booked
                  </Badge>
                }
                loading={loading}
              />
              <KpiTile
                title="Collections (MTD)"
                value={loading ? '...' : formatUGX(stats.collectedThisMonth)}
                subtitle="Cash collected this month"
                icon={Wallet}
                accent="bg-emerald-700"
                onClick={() => { setActiveDrill('collections'); setDrillSearch(''); }}
                badge={
                  <Badge variant="secondary" className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">
                    MTD Cash
                  </Badge>
                }
                loading={loading}
              />
              <KpiTile
                title="Welile Net Revenue (8%)"
                value={loading ? '...' : formatUGX(stats.welileNet)}
                subtitle="Platform commission from collected rent"
                icon={Coins}
                accent="bg-fuchsia-600"
                onClick={() => { setActiveDrill('revenue'); setDrillSearch(''); }}
                badge={
                  <Badge variant="secondary" className="text-[10px] bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/20">
                    8% Net
                  </Badge>
                }
                loading={loading}
              />
              <KpiTile
                title="Pending Landlord Payouts"
                value={loading ? '...' : formatUGX(stats.pendingPayouts)}
                subtitle={stats.pendingPayouts > 0 ? "Ready for batch disbursement" : "All payouts settled"}
                icon={Clock}
                accent="bg-amber-600"
                onClick={() => { setActiveDrill('payouts'); setDrillSearch(''); }}
                badge={
                  stats.pendingPayouts > 0 ? (
                    <Badge variant="secondary" className="text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 animate-pulse">
                      Action Due
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">
                      Settled
                    </Badge>
                  )
                }
                loading={loading}
              />
            </div>
          </div>

          {/* Portfolio Progress & Breakdown Card with Capital Distribution Graph */}
          <Card className="rounded-2xl border-border/60 p-3.5 sm:p-5 shadow-2xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
              <div>
                <h4 className="text-xs sm:text-sm font-bold text-foreground">Receivables Repayment & Distribution Coverage</h4>
                <p className="text-[11px] sm:text-xs text-muted-foreground">
                  {formatUGX(totalRepaid)} collected of {formatUGX(totalReceivable)} booked advance receivables ({collectionRate.toFixed(1)}% recovery rate)
                </p>
              </div>
              <div className="flex items-center gap-3 text-[11px] sm:text-xs text-muted-foreground flex-wrap">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shrink-0" />
                  Repaid ({formatUGX(totalRepaid)})
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500 shrink-0" />
                  Outstanding ({formatUGX(totalOutstanding)})
                </span>
              </div>
            </div>

            {/* Interactive Capital Distribution Graph */}
            <div className="w-full pt-1 pb-1">
              <div className="h-[155px] sm:h-[165px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={receivablesDistributionChartData}
                    margin={{ top: 5, right: 25, left: 10, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} opacity={0.2} />
                    <XAxis
                      type="number"
                      domain={[0, 'dataMax']}
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v) => v >= 1000000 ? `${(v / 1000000).toFixed(0)}M` : `${Math.round(v / 1000)}k`}
                    />
                    <YAxis
                      type="category"
                      dataKey="category"
                      tick={{ fontSize: 11, fontWeight: 500 }}
                      width={80}
                    />
                    <RechartsTooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const item = payload[0].payload as (typeof receivablesDistributionChartData)[number];
                        return (
                          <div className="rounded-xl border border-border/80 bg-background/95 backdrop-blur-md p-2.5 shadow-lg text-xs space-y-1 z-50">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-bold text-foreground">{item.label}</span>
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0" style={{ borderColor: item.fill, color: item.fill }}>
                                {item.status}
                              </Badge>
                            </div>
                            <div className="flex items-center justify-between gap-4 pt-1 border-t border-border/50 text-[11px]">
                              <span className="text-muted-foreground">Booked Capital:</span>
                              <span className="font-bold text-foreground tabular-nums">{formatUGX(item.amount)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4 text-[11px]">
                              <span className="text-muted-foreground">Portfolio Share:</span>
                              <span className="font-semibold text-foreground tabular-nums">{item.percent.toFixed(1)}%</span>
                            </div>
                            <div className="flex items-center justify-between gap-4 text-[11px]">
                              <span className="text-muted-foreground">Active Accounts:</span>
                              <span className="font-semibold text-foreground tabular-nums">{item.accounts} tenants</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="amount" radius={[0, 6, 6, 0]} barSize={16}>
                      {receivablesDistributionChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 pt-3 mt-1 sm:pt-4 border-t border-border/40 text-xs">
              <div>
                <span className="text-muted-foreground block text-[10px] sm:text-[11px]">Avg. Rent Per Tenant</span>
                <span className="font-bold text-foreground text-xs sm:text-sm">
                  {rows.length > 0 ? formatUGX(Math.round(monthlyRentTotal / rows.length)) : 'UGX 0'}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px] sm:text-[11px]">Landlord Wallet Rate</span>
                <span className="font-bold text-foreground text-xs sm:text-sm">
                  {rows.length > 0 ? `${Math.round((walletLandlordsCount / rows.length) * 100)}%` : '0%'}
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">({walletLandlordsCount})</span>
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px] sm:text-[11px]">Agent Float Rate</span>
                <span className="font-bold text-foreground text-xs sm:text-sm">
                  {rows.length > 0 ? `${Math.round((floatLandlordsCount / rows.length) * 100)}%` : '0%'}
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">({floatLandlordsCount})</span>
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px] sm:text-[11px]">Smartphone Share</span>
                <span className="font-bold text-foreground text-xs sm:text-sm">
                  {rows.length > 0 ? `${Math.round((smartphoneCount / rows.length) * 100)}%` : '0%'}
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">({smartphoneCount})</span>
                </span>
              </div>
            </div>
          </Card>

          {/* Payout Cycles Schedule */}
          <div>
            <div className="flex items-center justify-between mb-2.5 px-0.5">
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Scheduled Landlord Payout Cycles
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  Monthly cash disbursements grouped by calendar payout days
                </p>
              </div>
              <Badge variant="outline" className="text-[10px]">
                {payoutCycles.length} Active Cycles
              </Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
              {payoutCycles.map((cycle) => (
                <div
                  key={cycle.day}
                  className="rounded-2xl border border-border/60 bg-card p-3.5 sm:p-4 shadow-2xs hover:border-primary/40 transition-all flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold text-xs">
                        {cycle.day}
                      </div>
                      <div>
                        <span className="text-xs font-bold text-foreground">Day {cycle.day} of Month</span>
                        <span className="block text-[10px] text-muted-foreground">{cycle.count} Landlords</span>
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-[10px] font-semibold">
                      {cycle.count} subs
                    </Badge>
                  </div>
                  <div className="pt-2 border-t border-border/40 space-y-1">
                    <div className="flex justify-between items-baseline text-xs">
                      <span className="text-[11px] text-muted-foreground">Disbursement:</span>
                      <span className="font-bold text-foreground tabular-nums">{formatUGX(cycle.monthlyTotal)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>Channels:</span>
                      <span className="font-medium text-foreground">
                        {cycle.walletCount} Wallet · {cycle.floatCount} Float
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Settlement Rails & Channel Velocity Comparison Graph */}
          <div className="rounded-2xl border border-border/70 bg-card p-4 sm:p-5 shadow-2xs space-y-4">
            {/* Header with Title and Toggle */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/50">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <BarChart3 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground">
                    Settlement Rails & Channel Velocity
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    Automated Welile Wallet credits versus field agent cash float allocations
                  </p>
                </div>
              </div>

              {/* Metric Toggle Buttons */}
              <div className="flex items-center gap-1 bg-muted/60 p-1 rounded-xl border border-border/40 shrink-0 self-start sm:self-center">
                <button
                  type="button"
                  onClick={() => setRailChartMetric('volume')}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5',
                    railChartMetric === 'volume'
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Banknote className="h-3.5 w-3.5" />
                  <span>Monthly Volume (UGX)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRailChartMetric('landlords')}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5',
                    railChartMetric === 'landlords'
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Users className="h-3.5 w-3.5" />
                  <span>Property Owners</span>
                </button>
              </div>
            </div>

            {/* The Graph */}
            <div className="w-full pt-1">
              <div className="h-[160px] sm:h-[175px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={settlementRailsChartData}
                    margin={{ top: 5, right: 35, left: 10, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} opacity={0.2} />
                    <XAxis
                      type="number"
                      domain={[0, 'dataMax']}
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v) =>
                        railChartMetric === 'volume'
                          ? (v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : `${Math.round(v / 1000)}k`)
                          : `${v}`
                      }
                    />
                    <YAxis
                      type="category"
                      dataKey="shortName"
                      tick={{ fontSize: 11, fontWeight: 600 }}
                      width={95}
                    />
                    <RechartsTooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as (typeof settlementRailsChartData)[number];
                        return (
                          <div className="rounded-xl border border-border/80 bg-background/95 backdrop-blur-md p-3 shadow-lg text-xs space-y-1.5 z-50 min-w-[210px]">
                            <div className="flex items-center justify-between gap-2 pb-1 border-b border-border/50">
                              <span className="font-bold text-foreground">{d.channel}</span>
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0" style={{ borderColor: d.fill, color: d.fill }}>
                                {d.mode}
                              </Badge>
                            </div>
                            <div className="flex items-center justify-between gap-4 text-[11px]">
                              <span className="text-muted-foreground">Monthly Payout Volume:</span>
                              <span className="font-bold text-foreground tabular-nums">{formatUGX(d.volume)} ({d.volumePercent.toFixed(1)}%)</span>
                            </div>
                            <div className="flex items-center justify-between gap-4 text-[11px]">
                              <span className="text-muted-foreground">Property Owners:</span>
                              <span className="font-bold text-foreground tabular-nums">{d.landlords} landlords ({d.landlordsPercent.toFixed(1)}%)</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar
                      dataKey={railChartMetric === 'volume' ? 'volume' : 'landlords'}
                      radius={[0, 8, 8, 0]}
                      barSize={24}
                    >
                      {settlementRailsChartData.map((entry, index) => (
                        <Cell key={`rail-${index}`} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Split interactive summary cards below the chart */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              {/* Welile Wallet Rail Link Card */}
              <div className="p-3 sm:p-3.5 rounded-xl border border-primary/30 bg-primary/5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-9 w-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-xs">
                    <Wallet className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-foreground truncate">Welile Wallet Rails</span>
                      <Badge className="bg-primary text-primary-foreground text-[9px] px-1.5 py-0">
                        {rows.length > 0 ? `${Math.round((walletLandlordsCount / rows.length) * 100)}%` : '0%'}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      <strong className="text-foreground">{formatUGX(walletVolume)}</strong> · {walletLandlordsCount} property owners
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openSubscriptions('wallet')}
                  className="text-xs font-semibold h-8 rounded-lg border-primary/30 hover:bg-primary/10 hover:text-primary shrink-0 cursor-pointer gap-1"
                >
                  <span>View ({walletLandlordsCount})</span>
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </div>

              {/* Agent Float Rail Link Card */}
              <div className="p-3 sm:p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-9 w-9 rounded-xl bg-amber-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                    <Banknote className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-foreground truncate">Agent Float Distribution</span>
                      <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/10 text-[9px] px-1.5 py-0">
                        {rows.length > 0 ? `${Math.round((floatLandlordsCount / rows.length) * 100)}%` : '0%'}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      <strong className="text-foreground">{formatUGX(floatVolume)}</strong> · {floatLandlordsCount} property owners
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openSubscriptions('float')}
                  className="text-xs font-semibold h-8 rounded-lg border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-400 shrink-0 cursor-pointer gap-1"
                >
                  <span>View ({floatLandlordsCount})</span>
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>


          {/* Category Directory Hub */}

          <div>
            <div className="flex items-center justify-between mb-2.5 px-0.5">
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Subscriptions Directory Categories
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  Click any category to open its full tenant records, search filters, and export
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-2.5">
              <button
                type="button"
                onClick={() => setActiveTab('landlords')}
                className="text-left p-3 rounded-xl border border-primary/40 bg-primary/5 hover:bg-primary/10 transition-all flex flex-col justify-between min-h-[90px] cursor-pointer group shadow-2xs"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="h-7 w-7 rounded-lg bg-primary/20 text-primary flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Home className="h-4 w-4" />
                  </div>
                  <Badge className="bg-primary text-primary-foreground text-[10px] font-bold">{enrolledLandlordsBreakdown.length}</Badge>
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground group-hover:text-primary transition-colors">Enrolled Portfolios</p>
                  <p className="text-[10px] text-muted-foreground">Enrolled landlords & attached units →</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => openSubscriptions('all')}
                className="text-left p-3 rounded-xl border border-border/70 bg-card hover:bg-muted/40 hover:border-primary/50 transition-all flex flex-col justify-between min-h-[90px] cursor-pointer group shadow-2xs"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Users className="h-4 w-4" />
                  </div>
                  <Badge variant="secondary" className="text-[10px] font-bold">{rows.length}</Badge>
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground group-hover:text-primary transition-colors">All Subscriptions</p>
                  <p className="text-[10px] text-muted-foreground">Full active book →</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => openSubscriptions('float')}
                className="text-left p-3 rounded-xl border border-border/70 bg-card hover:bg-muted/40 hover:border-amber-500/50 transition-all flex flex-col justify-between min-h-[90px] cursor-pointer group shadow-2xs"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="h-7 w-7 rounded-lg bg-amber-500/10 text-amber-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Banknote className="h-4 w-4" />
                  </div>
                  <Badge variant="secondary" className="text-[10px] font-bold">{floatLandlordsCount}</Badge>
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground group-hover:text-amber-600 transition-colors">Agent Float</p>
                  <p className="text-[10px] text-muted-foreground">Cash allocations →</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => openSubscriptions('wallet')}
                className="text-left p-3 rounded-xl border border-border/70 bg-card hover:bg-muted/40 hover:border-primary/50 transition-all flex flex-col justify-between min-h-[90px] cursor-pointer group shadow-2xs"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Wallet className="h-4 w-4" />
                  </div>
                  <Badge variant="secondary" className="text-[10px] font-bold">{walletLandlordsCount}</Badge>
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground group-hover:text-primary transition-colors">Welile Wallet</p>
                  <p className="text-[10px] text-muted-foreground">Direct automated →</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => openSubscriptions('smartphone')}
                className="text-left p-3 rounded-xl border border-border/70 bg-card hover:bg-muted/40 hover:border-emerald-500/50 transition-all flex flex-col justify-between min-h-[90px] cursor-pointer group shadow-2xs"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="h-7 w-7 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Smartphone className="h-4 w-4" />
                  </div>
                  <Badge variant="secondary" className="text-[10px] font-bold">{smartphoneCount}</Badge>
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground group-hover:text-emerald-600 transition-colors">Smartphone App</p>
                  <p className="text-[10px] text-muted-foreground">Self-managed →</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => openSubscriptions('high_outstanding')}
                className="text-left p-3 rounded-xl border border-border/70 bg-card hover:bg-muted/40 hover:border-rose-500/50 transition-all flex flex-col justify-between min-h-[90px] cursor-pointer group shadow-2xs col-span-2 sm:col-span-1"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="h-7 w-7 rounded-lg bg-rose-500/10 text-rose-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Clock className="h-4 w-4" />
                  </div>
                  <Badge variant="secondary" className="text-[10px] font-bold text-rose-600">{highBalanceCount}</Badge>
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground group-hover:text-rose-600 transition-colors">High Balance (&gt;6M)</p>
                  <p className="text-[10px] text-muted-foreground">Attention queue →</p>
                </div>
              </button>
            </div>
          </div>
        </>
      ) : activeTab === 'applications' ? (
        <div className="space-y-4">
          {/* Applications Intake Banner */}
          <div className="p-4 sm:p-5 rounded-2xl border border-primary/40 bg-gradient-to-br from-primary/10 via-card to-card shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 sm:h-12 sm:w-12 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-md">
                  <ClipboardList className="h-5 w-5 sm:h-6 sm:w-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm sm:text-lg font-bold text-foreground">
                      Agent Applications Intake
                    </h3>
                    <Badge className="bg-primary text-primary-foreground text-[10px]">
                      {rows.length} Total Submissions
                    </Badge>
                    {pendingFloatRequestsCount > 0 && (
                      <Badge variant="destructive" className="text-[10px] animate-pulse">
                        {pendingFloatRequestsCount} Float Requests Due
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Live landlord and tenant applications enrolled via the Agent Dashboard, KYC verification, and advance float requests
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap self-start sm:self-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportSelectedApplications}
                  className="text-xs font-semibold gap-1.5 rounded-xl border-border/80 h-9 px-3 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Export CSV</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={load}
                  disabled={loading}
                  className="text-xs font-semibold gap-1.5 rounded-xl border-border/80 h-9 px-3 cursor-pointer"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                  <span>Refresh</span>
                </Button>
              </div>
            </div>

            {/* 4 Summary KPI Tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 pt-3 border-t border-border/50">
              <div className="p-3 rounded-xl bg-background/60 border border-border/40">
                <span className="text-[10px] sm:text-[11px] text-muted-foreground block font-medium">Total Applications</span>
                <span className="text-base sm:text-lg font-bold text-foreground tabular-nums">
                  {rows.length}
                </span>
                <span className="text-[10px] text-muted-foreground block">
                  Across {applicationsByLandlord.length} landlords
                </span>
              </div>
              <div className="p-3 rounded-xl bg-background/60 border border-border/40">
                <span className="text-[10px] sm:text-[11px] text-muted-foreground block font-medium">Total Float Required</span>
                <span className="text-base sm:text-lg font-bold text-primary tabular-nums">
                  {formatUGX(totalFloatRequired)}
                </span>
                <span className="text-[10px] text-muted-foreground block">
                  1-Month payout requirement
                </span>
              </div>
              <div className="p-3 rounded-xl bg-background/60 border border-border/40">
                <span className="text-[10px] sm:text-[11px] text-muted-foreground block font-medium">Landlord Portfolios</span>
                <span className="text-base sm:text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                  {applicationsByLandlord.length}
                </span>
                <span className="text-[10px] text-muted-foreground block">
                  Grouped rent float portfolios
                </span>
              </div>
              <div className="p-3 rounded-xl bg-background/60 border border-border/40">
                <span className="text-[10px] sm:text-[11px] text-muted-foreground block font-medium">Total Tenant Units</span>
                <span className="text-base sm:text-lg font-bold text-foreground tabular-nums">
                  {activeRows.length}
                </span>
                <span className="text-[10px] text-muted-foreground block">
                  Enrolled under landlords
                </span>
              </div>
            </div>
          </div>

          {/* Unified Filters and Search */}
          <div className="bg-card p-3 sm:p-4 rounded-2xl border border-border/60 shadow-2xs space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              {/* Status filter pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                <button
                  type="button"
                  onClick={() => setAppStatusFilter('all')}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-[11px] font-medium transition-all cursor-pointer shrink-0",
                    appStatusFilter === 'all'
                      ? "bg-foreground text-background font-bold shadow-xs"
                      : "bg-muted text-muted-foreground hover:text-foreground border border-border/40"
                  )}
                >
                  All Applications ({activeRows.length})
                </button>
                {declinedTenantsCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setAppStatusFilter('declined')}
                    className={cn(
                      "px-3 py-1.5 rounded-full text-[11px] font-medium transition-all cursor-pointer flex items-center gap-1 shrink-0",
                      appStatusFilter === 'declined'
                        ? "bg-destructive text-destructive-foreground font-bold shadow-xs"
                        : "bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/20"
                    )}
                  >
                    <XCircle className="h-3 w-3" />
                    Declined ({declinedTenantsCount})
                  </button>
                )}
              </div>

              {/* Search Box */}
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  value={appSearch}
                  onChange={(e) => setAppSearch(e.target.value)}
                  placeholder="Search tenant, phone, landlord, agent..."
                  className="pl-8 h-9 text-xs rounded-xl bg-background border-border/80"
                />
                {appSearch && (
                  <button
                    type="button"
                    onClick={() => setAppSearch('')}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* FLOAT REQUESTS AWAITING AGENT OPS */}
          {floatRequests.some((f) => f.status === 'pending') && (
            <Card className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3 sm:p-4 space-y-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Banknote className="h-4 w-4 text-amber-600" />
                <h4 className="text-sm font-bold text-foreground">Float Requests Awaiting Agent Ops</h4>
                <Badge className="bg-amber-600 text-white text-[10px]">
                  {floatRequests.filter((f) => f.status === 'pending').length}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Rejecting a request keeps its tenants enrolled. The agent then sends a new request from their
                Welile Homes screen, which links the exact tenants it covers.
              </p>
              <div className="space-y-2">
                {floatRequests
                  .filter((f) => f.status === 'pending')
                  .map((req) => (
                    <div
                      key={req.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-xl bg-card border border-border/60"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs sm:text-sm font-bold text-foreground">{req.agent_name || 'Agent'}</span>
                          {req.agent_phone && (
                            <span className="text-[11px] text-muted-foreground">({req.agent_phone})</span>
                          )}
                          <span className="text-xs font-bold text-primary tabular-nums">
                            {formatUGX(Number(req.requested_amount) || 0)}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">
                          {req.reason || 'Welile Homes landlord float'}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          Requested {new Date(req.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                        <Button
                          size="sm"
                          onClick={() => forwardToTenantOps(req.id)}
                          disabled={forwardingId === req.id || rejectingReq}
                          className="h-8 px-3 text-xs font-semibold gap-1.5 cursor-pointer"
                        >
                          {forwardingId === req.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ArrowRight className="h-3.5 w-3.5" />
                          )}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openRejectRequest(req)}
                          disabled={forwardingId === req.id || rejectingReq}
                          className="h-8 px-3 text-xs font-semibold gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive cursor-pointer"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Reject with note
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            </Card>
          )}

          {/* RENT FLOAT APPLICATIONS CARDS */}
          <div className="space-y-3">

              {applicationsByLandlord.length === 0 ? (
                <Card className="rounded-2xl p-8 text-center border-dashed border-border/60">
                  <p className="text-sm font-semibold text-foreground">No applications match your filter</p>
                  <p className="text-xs text-muted-foreground mt-1">Try clearing your search query or selecting "All".</p>
                </Card>
              ) : (
                applicationsByLandlord.map((group) => {
                  const isAllSelected = group.tenants.length > 0 && group.tenants.every((t) => selectedAppTenantIds.has(t.id));
                  const isSomeSelected = group.tenants.some((t) => selectedAppTenantIds.has(t.id)) && !isAllSelected;
                  const isExpanded = !!expandedAppLandlords[group.key];

                  return (
                    <Card
                      key={group.key}
                      className="rounded-2xl border border-border/70 bg-card overflow-hidden shadow-2xs hover:border-primary/40 transition-all"
                    >
                      {/* Landlord Card Header */}
                      <div
                        onClick={() => {
                          setExpandedAppLandlords((prev) => ({ ...prev, [group.key]: !prev[group.key] }));
                        }}
                        className="p-3.5 sm:p-4 flex items-center justify-between gap-3 cursor-pointer select-none bg-muted/20 hover:bg-muted/30 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={isAllSelected ? true : isSomeSelected ? 'indeterminate' : false}
                              onCheckedChange={() => toggleLandlordSelect(group.tenants)}
                              className="h-4 w-4 rounded data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                            />
                          </div>
                          <div className="h-8 w-8 sm:h-9 sm:w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                            <Home className="h-4 w-4 sm:h-4.5 sm:w-4.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs sm:text-sm font-bold text-foreground truncate">
                                {group.landlordName}
                              </span>
                              {group.landlordPhone && (
                                <span className="text-[11px] text-muted-foreground font-normal">
                                  ({group.landlordPhone})
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (group.agentId) setProfileAgentId(group.agentId);
                                  else toast.info(`Agent: ${group.agentName} (no ID linked)`);
                                }}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 transition-all cursor-pointer"
                                title="Click to inspect Agent 360 Performance across products"
                              >
                                <Sparkles className="h-3 w-3 text-amber-500" />
                                <span>Agent: {group.agentName}</span>
                                <span className="text-[9px] font-bold uppercase tracking-wider bg-primary/20 px-1 rounded ml-0.5">360°</span>
                              </button>
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal border-purple-500/30 text-purple-600 bg-purple-500/10">
                                Welile Homes
                              </Badge>
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {group.tenants.length} {group.tenants.length === 1 ? 'tenant' : 'tenants'} · Total float: <span className="font-semibold text-foreground">{formatUGX(group.totalFloat)}</span>
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <Badge className="bg-primary/10 text-primary hover:bg-primary/20 border-primary/20 font-bold text-xs px-2.5 py-0.5">
                            {formatUGX(group.totalFloat)}
                          </Badge>

                          <Button
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              forwardGroupToTenantOps(group);
                            }}
                            disabled={forwardingGroupId === group.key || declining}
                            className="h-8 px-2.5 sm:px-3 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold gap-1.5 shadow-xs cursor-pointer"
                          >
                            {forwardingGroupId === group.key ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ArrowRight className="h-3.5 w-3.5" />
                            )}
                            <span className="hidden sm:inline">Approve & Forward to Tenant Ops</span>
                            <span className="sm:hidden">Forward</span>
                          </Button>

                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeclineGroup(group);
                            }}
                            disabled={forwardingGroupId === group.key || declining}
                            className="h-8 px-2.5 sm:px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive font-semibold gap-1.5 shadow-xs cursor-pointer"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span>Decline</span>
                          </Button>

                          <div className="text-muted-foreground">
                            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </div>
                        </div>
                      </div>

                      {/* Attached Tenant Applications */}
                      {isExpanded && (
                        <div className="p-3 sm:p-4 pt-2 sm:pt-2 space-y-2.5 bg-muted/5 border-t border-border/40">
                          {group.tenants.map((t) => {
                            const isSelected = selectedAppTenantIds.has(t.id);
                            return (
                              <div
                                key={t.id}
                                className={cn(
                                  "rounded-2xl border p-3.5 sm:p-4 transition-all",
                                  isSelected
                                    ? "border-primary/60 bg-primary/10 shadow-xs"
                                    : "border-primary/25 bg-primary/5 hover:bg-primary/8"
                                )}
                              >
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3">
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <Checkbox
                                      checked={isSelected}
                                      onCheckedChange={() => toggleTenantSelect(t.id)}
                                      className="h-4 w-4 rounded data-[state=checked]:bg-primary data-[state=checked]:border-primary shrink-0"
                                    />
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-xs sm:text-sm font-bold text-foreground uppercase tracking-wide">
                                          {t.tenant_name}
                                        </span>
                                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                          {t.landlord_uses_wallet ? 'Welile Wallet' : 'Agent Float'}
                                        </Badge>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => setHistorySub(t)}
                                        className="text-[11px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 mt-0.5 cursor-pointer text-left"
                                      >
                                        <span>{t.tenant_phone || 'No phone'}</span>
                                        <span>· Tap for payment history</span>
                                      </button>
                                    </div>
                                  </div>
                                </div>

                                {/* 3 Metric Columns: Rent, Outstanding, Payout Day */}
                                <div className="grid grid-cols-3 gap-2 py-2.5 border-y border-border/40 text-xs">
                                  <div>
                                    <span className="text-[10px] text-muted-foreground block">Rent</span>
                                    <span className="font-bold text-foreground text-xs sm:text-sm tabular-nums">
                                      {formatUGX(t.monthly_rent)}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-[10px] text-muted-foreground block">Outstanding</span>
                                    <span className="font-bold text-amber-600 dark:text-amber-400 text-xs sm:text-sm tabular-nums">
                                      {formatUGX(t.outstanding_balance)}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-[10px] text-muted-foreground block">Payout day</span>
                                    <span className="font-bold text-foreground text-xs sm:text-sm tabular-nums">
                                      {t.payout_day}
                                    </span>
                                  </div>
                                </div>

                                {/* Action Buttons: Edit, Allocate, Delete (+ History, Verify OTP) */}
                                <div className="flex items-center justify-between gap-2 pt-2.5 flex-wrap">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setHistorySub(t)}
                                      className="h-8 px-2.5 text-xs rounded-xl border-border/60 hover:border-primary/40 gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
                                    >
                                      <Clock className="h-3.5 w-3.5" />
                                      <span>History</span>
                                    </Button>
                                  </div>

                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => handleDeclineTenant(t)}
                                      disabled={declining}
                                      className="h-8 px-2.5 text-xs rounded-xl border-destructive/40 text-destructive hover:bg-destructive/10 gap-1 cursor-pointer font-semibold"
                                    >
                                      <XCircle className="h-3.5 w-3.5" />
                                      <span>Decline</span>
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setDeleteSub(t)}
                                      className="h-8 px-2.5 text-xs rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10 gap-1 cursor-pointer"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                      <span>Delete</span>
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </Card>
                  );
                })
              )}
            </div>

          {/* Sticky Floating Action Bar for Selected Applications */}
          {selectedAppTenantIds.size > 0 && (
            <div className="sticky bottom-0 -mx-3 -mb-4 bg-background/95 backdrop-blur-md border-t border-border/80 p-3 sm:p-4 shadow-xl z-30 rounded-t-2xl">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    <span className="font-semibold text-foreground">
                      {selectedAppLandlordNames.length} {selectedAppLandlordNames.length === 1 ? 'landlord' : 'landlords'} · {selectedAppTenantIds.size} {selectedAppTenantIds.size === 1 ? 'tenant' : 'tenants'}
                    </span>
                  </div>
                  <p className="text-sm sm:text-base font-bold text-foreground truncate">
                    Total Float: <span className="text-primary font-extrabold">{formatUGX(selectedAppTotalFloat)}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedAppTenantIds(new Set())}
                    className="text-xs h-9 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    Clear
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportSelectedApplications}
                    className="h-9 px-3 text-xs font-semibold gap-1.5 border-border/80 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Export Selected</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDeclineSelected}
                    disabled={declining}
                    className="h-9 px-3 text-xs font-semibold gap-1.5 border-rose-300 dark:border-rose-900/60 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    <span>Decline Selected ({selectedAppTenantIds.size})</span>
                  </Button>
                  <Button
                    size="sm"
                    onClick={forwardSelectedToTenantOps}
                    disabled={forwardingSelected}
                    className="h-9 px-3.5 text-xs font-bold gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground shadow-xs cursor-pointer"
                  >
                    {forwardingSelected ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5" />
                    )}
                    <span>Approve Selected & Forward to Tenant Ops</span>
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : activeTab === 'landlords' ? (
        <div className="space-y-4">
          {/* Executive Profitability Banner */}
          <div className="p-4 sm:p-5 rounded-2xl border border-primary/40 bg-gradient-to-br from-primary/10 via-card to-card shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 sm:h-12 sm:w-12 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-md">
                  <Home className="h-5 w-5 sm:h-6 sm:w-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm sm:text-lg font-bold text-foreground">
                      Enrolled Landlord Portfolios
                    </h3>
                    <Badge className="bg-primary text-primary-foreground text-[10px] font-bold">
                      {enrolledLandlordsBreakdown.length} Enrolled Landlords
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Landlords with active Welile Homes tenant enrolments. Funding status is not shown here yet.
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveTab('overview')}
                className="hidden md:inline-flex text-xs text-primary shrink-0 self-start sm:self-auto h-8 px-2.5 cursor-pointer"
              >
                ← Back to Overview
              </Button>
            </div>

            {/* 5 Grand Metric Tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3 pt-3 border-t border-border/50">
              <div className="p-3 rounded-xl bg-background/60 border border-border/50">
                <span className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                  Total Monthly Revenue
                </span>
                <p className="text-base sm:text-xl font-bold text-foreground tabular-nums mt-0.5">
                  {formatUGX(totalLandlordRevenue)}
                </p>
                <span className="text-[10px] text-muted-foreground">across {enrolledRows.length} enrolled tenant units</span>
              </div>

              <div className="p-3 rounded-xl bg-background/60 border border-border/50">
                <span className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                  Booked Receivables (×12)
                </span>
                <p className="text-base sm:text-xl font-bold text-foreground tabular-nums mt-0.5">
                  {formatUGX(totalLandlordReceivables)}
                </p>
                <span className="text-[10px] text-muted-foreground">12-month advance rent principal</span>
              </div>

              <div className="p-3 rounded-xl bg-background/60 border border-border/50">
                <span className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                  Outstanding Balance
                </span>
                <p className="text-base sm:text-xl font-bold text-amber-600 dark:text-amber-400 tabular-nums mt-0.5">
                  {formatUGX(enrolledOutstanding)}
                </p>
                <span className="text-[10px] text-muted-foreground">in active daily tenant collections</span>
              </div>

              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] sm:text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
                    Agent Commission (2%)
                  </span>
                  <Badge className="hidden sm:inline-flex bg-amber-600 text-white text-[9px] px-1 py-0 h-3.5 shrink-0">
                    Field Earnings
                  </Badge>
                </div>
                <p className="text-base sm:text-xl font-bold text-amber-700 dark:text-amber-300 tabular-nums mt-0.5">
                  {formatUGX(totalLandlordAgentCommission)}
                </p>
                <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                  +{formatUGX(monthlyLandlordAgentCommission)}/month recurring
                </span>
              </div>

              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 col-span-2 sm:col-span-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] sm:text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">
                    Our Net Profit (8%)
                  </span>
                  <Badge className="hidden sm:inline-flex bg-emerald-600 text-white text-[9px] px-1 py-0 h-3.5 shrink-0">
                    Platform Margin
                  </Badge>
                </div>
                <p className="text-base sm:text-xl font-bold text-emerald-700 dark:text-emerald-300 tabular-nums mt-0.5">
                  {formatUGX(totalLandlordProfit)}
                </p>
                <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                  +{formatUGX(monthlyLandlordProfit)}/month recurring
                </span>
              </div>
            </div>
          </div>

          {/* Search & Actions Bar for Landlords */}
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-2.5 sm:items-center justify-between">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search landlords, attached tenants, or agents..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8 pr-8 h-9 sm:h-10 text-xs bg-card border-border/70 rounded-xl shadow-2xs w-full"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => setQ('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={exportLandlordsCSV}
                className="h-9 sm:h-10 gap-1.5 rounded-xl border-border/70 text-xs font-medium"
              >
                <Download className="h-3.5 w-3.5" /> <span>Export CSV</span>
              </Button>
            </div>
          </div>

          {/* Landlords Cards List with Attached Tenants */}
          <div className="space-y-3">
            {filteredLandlords.length === 0 ? (
              <div className="p-8 text-center bg-card rounded-2xl border border-border/60">
                <Home className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm font-semibold text-foreground">
                  {q ? 'No landlords found' : 'No enrolled portfolios yet'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 max-w-md mx-auto">
                  {q
                    ? `No landlord or tenant matches "${q}".`
                    : 'Landlords appear here once tenants are enrolled under them.'}
                </p>
                {q && (
                  <Button variant="ghost" size="sm" onClick={() => setQ('')} className="mt-3 text-xs text-primary">
                    Clear search
                  </Button>
                )}
              </div>
            ) : (
              filteredLandlords.map((l, index) => {
                const isAlternate = index % 2 === 1;
                const isExpanded = !!expandedEnrolledLandlords[l.name]; // Default to collapsed
                return (
                  <Card
                    key={l.name}
                    onClick={() => setPreviewLandlord(l)}
                    className={cn(
                      "rounded-2xl overflow-hidden transition-all border-2 shadow-xs cursor-pointer hover:border-primary/50 hover:shadow-md",
                      isAlternate
                        ? "bg-slate-50/70 dark:bg-slate-900/60 border-slate-300/80 dark:border-slate-700/80 hover:bg-slate-100/80 dark:hover:bg-slate-900/90"
                        : "bg-card border-slate-200 dark:border-border hover:bg-muted/30"
                    )}
                  >
                    <div className="p-3.5 sm:p-4 select-none space-y-3">
                      {/* Landlord Identity Header */}
                      <div className="flex items-center justify-between gap-3 group">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary font-bold text-xs flex items-center justify-center shrink-0 border border-primary/20 group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                            <Home className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="font-bold text-sm sm:text-base text-foreground truncate group-hover:text-primary transition-colors">
                                {l.name}
                              </h4>
                              <Badge variant="secondary" className="text-[10px] font-semibold">
                                {l.tenantsCount} {l.tenantsCount === 1 ? 'Tenant' : 'Tenants'}
                              </Badge>
                              {l.walletCount > 0 && (
                                <Badge variant="outline" className="text-[9px] border-primary/30 text-primary bg-primary/5 py-0 font-medium">
                                  <Wallet className="h-2.5 w-2.5 mr-0.5 inline" /> Welile Wallet
                                </Badge>
                              )}
                              {l.floatCount > 0 && (
                                <Badge variant="secondary" className="text-[9px] py-0 text-muted-foreground font-medium">
                                  <Banknote className="h-2.5 w-2.5 mr-0.5 inline text-muted-foreground" /> Agent Float
                                </Badge>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              Scheduled Payout: <span className="font-semibold text-foreground">Day {l.payoutDays.join(', ') || '5'} of month</span>
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedEnrolledLandlords((prev) => ({
                                ...prev,
                                [l.name]: !prev[l.name],
                              }));
                            }}
                            className="h-8 w-8 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                            title={isExpanded ? "Collapse inline list" : "Expand inline list"}
                          >
                            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>

                      {/* Financial Metrics Strip */}
                      <div className="pt-2.5 border-t border-border/60 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div className="p-2 sm:p-2.5 rounded-xl bg-background/80 dark:bg-background/40 border border-border/70 flex flex-col justify-between">
                          <span className="text-[10px] text-muted-foreground uppercase font-semibold">Total Revenue</span>
                          <span className="font-bold text-foreground tabular-nums text-xs sm:text-sm mt-0.5">
                            {formatUGX(l.monthlyRevenue)} <span className="text-[10px] text-muted-foreground font-normal">/mo</span>
                          </span>
                        </div>

                        <div className="p-2 sm:p-2.5 rounded-xl bg-background/80 dark:bg-background/40 border border-border/70 flex flex-col justify-between">
                          <span className="text-[10px] text-muted-foreground uppercase font-semibold">Receivables (×12)</span>
                          <span className="font-bold text-foreground tabular-nums text-xs sm:text-sm mt-0.5">
                            {formatUGX(l.totalReceivable)}
                          </span>
                        </div>

                        <div className="p-2 sm:p-2.5 rounded-xl bg-background/80 dark:bg-background/40 border border-border/70 flex flex-col justify-between">
                          <span className="text-[10px] text-muted-foreground uppercase font-semibold">Agent 2%</span>
                          <span className="font-bold text-foreground tabular-nums text-xs sm:text-sm mt-0.5">
                            +{formatUGX(l.agentCommission)}
                          </span>
                        </div>

                        <div className="p-2 sm:p-2.5 rounded-xl bg-primary/10 border border-primary/30 flex flex-col justify-between">
                          <span className="text-[10px] text-primary uppercase font-bold">Our Profit (8%)</span>
                          <span className="font-bold text-primary tabular-nums text-xs sm:text-sm mt-0.5">
                            +{formatUGX(l.ourProfit)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Attached Tenants Direct View */}
                    {isExpanded && (
                      <div onClick={(e) => e.stopPropagation()} className="border-t border-border/70 p-3 sm:p-4 bg-muted/20 space-y-2.5 cursor-default">
                        <div className="flex items-center justify-between text-xs pb-1">
                          <span className="font-bold text-foreground flex items-center gap-1.5">
                            <Users className="h-3.5 w-3.5 text-primary" />
                            Attached Tenants ({l.tenants.length})
                          </span>
                          <span className="text-[11px] text-muted-foreground">Active lease contracts under this landlord</span>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                          {l.tenants.map((t) => {
                            const fullRow = rows.find((r) => r.id === t.id);
                            return (
                              <div
                                key={t.id}
                                className="p-3 rounded-xl border border-border/70 bg-card shadow-2xs space-y-2.5"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="font-bold text-xs sm:text-sm text-foreground uppercase tracking-wide truncate">
                                        {t.name}
                                      </span>
                                      <Badge variant="outline" className="text-[9px] py-0 px-1 border-border/80">
                                        Day {t.payoutDay}
                                      </Badge>
                                      <Badge variant="secondary" className="text-[9px] py-0 px-1">
                                        {t.usesWallet ? 'Wallet' : 'Agent Float'}
                                      </Badge>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                                      {t.phone || 'No phone'}
                                    </p>
                                    {t.agentName && (
                                      <div className="flex items-center gap-1.5 mt-1">
                                        <span className="text-[10.5px] text-muted-foreground">Agent:</span>
                                        <button
                                          type="button"
                                          onClick={() => fullRow?.agent_id && setProfileAgentId(fullRow.agent_id)}
                                          className="text-[10.5px] font-semibold text-primary hover:underline flex items-center gap-1 cursor-pointer"
                                        >
                                          <span>{t.agentName}</span>
                                          <Badge className="bg-primary/10 text-primary border-primary/20 text-[8.5px] px-1 py-0 font-bold">
                                            360°
                                          </Badge>
                                        </button>
                                      </div>
                                    )}
                                  </div>

                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => fullRow && setHistorySub(fullRow)}
                                    className="h-7 px-2.5 text-[10.5px] rounded-lg border-border/70 hover:border-primary/40 gap-1 text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
                                  >
                                    <Clock className="h-3 w-3" />
                                    <span>History</span>
                                  </Button>
                                </div>

                                {/* Financial figures */}
                                <div className="grid grid-cols-3 gap-1.5 pt-2 border-t border-border/40 text-[11px]">
                                  <div>
                                    <span className="text-[9.5px] text-muted-foreground block">Monthly Rent</span>
                                    <span className="font-bold text-foreground tabular-nums">
                                      {formatUGX(t.monthlyRent)}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-[9.5px] text-muted-foreground block">Repaid</span>
                                    <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                                      {formatUGX(t.repaidAmount)}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-[9.5px] text-muted-foreground block">Outstanding</span>
                                    <span className="font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                                      {formatUGX(t.outstandingBalance)}
                                    </span>
                                  </div>
                                </div>

                                {/* Recovery Progress Bar */}
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between text-[9.5px] text-muted-foreground">
                                    <span>Capital Recovery</span>
                                    <span className="font-semibold text-foreground">{Math.round(t.repaidRatio)}%</span>
                                  </div>
                                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                    <div
                                      className="h-full bg-emerald-500 rounded-full transition-all"
                                      style={{ width: `${Math.min(100, Math.max(0, t.repaidRatio))}%` }}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })
            )}
          </div>
        </div>
      ) : (
        /* ALL SUBSCRIPTIONS VIEW WITH INTERACTIVE FILTERS */
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              All Subscriptions Directory
            </span>
            <span className="text-[11px] text-muted-foreground">
              Showing {filtered.length} of {rows.length} subscriptions
            </span>
          </div>
          {/* SUBSCRIPTIONS BANNER */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:p-4 rounded-2xl border border-border/70 bg-card shadow-2xs">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                {subFilter === 'float' && <Banknote className="h-5 w-5 text-amber-600" />}
                {subFilter === 'wallet' && <Wallet className="h-5 w-5 text-primary" />}
                {subFilter === 'smartphone' && <Smartphone className="h-5 w-5 text-emerald-600" />}
                {subFilter === 'high_outstanding' && <Clock className="h-5 w-5 text-rose-600" />}
                {subFilter === 'all' && <Users className="h-5 w-5 text-primary" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm sm:text-base font-bold text-foreground">
                    {subFilter === 'all' && 'All Active Subscriptions'}
                    {subFilter === 'float' && 'Agent Float Subscriptions'}
                    {subFilter === 'wallet' && 'Welile Wallet Subscriptions'}
                    {subFilter === 'smartphone' && 'Smartphone Self-Managed Subscriptions'}
                    {subFilter === 'high_outstanding' && 'High Outstanding Balances (>6M)'}
                  </h3>
                  <Badge variant="secondary" className="text-[10px]">
                    {subFilter === 'all' ? `${filtered.length} Subscriptions` : `${filtered.length} of ${rows.length}`}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {subFilter === 'all' && 'Complete active 12-month advance tenant subscription portfolio.'}
                  {subFilter === 'float' && 'Subscriptions where landlords receive payout via agent float disbursement.'}
                  {subFilter === 'wallet' && 'Subscriptions where landlords receive direct automated Welile Wallet transfers.'}
                  {subFilter === 'smartphone' && 'Tenants managing their repayments independently via smartphone app.'}
                  {subFilter === 'high_outstanding' && 'Subscriptions with remaining balance higher than 6 months of rent.'}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveTab('overview')}
              className="hidden md:inline-flex text-xs text-primary shrink-0 self-start sm:self-auto h-8 px-2.5 cursor-pointer"
            >
              ← Back to Overview
            </Button>
          </div>

          {/* Interactive Category Filter Pills */}
          <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar py-0.5">
            <button
              type="button"
              onClick={() => setSubFilter('all')}
              className={cn(
                'h-8 sm:h-9 px-3 rounded-xl text-xs font-semibold shrink-0 transition-all flex items-center gap-1.5 cursor-pointer',
                subFilter === 'all'
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'bg-card hover:bg-muted/60 text-muted-foreground hover:text-foreground border border-border/70'
              )}
            >
              <Users className="h-3.5 w-3.5" />
              <span>All</span>
              <Badge
                variant="secondary"
                className={cn('text-[9px] px-1 py-0 font-bold', subFilter === 'all' ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground')}
              >
                {rows.length}
              </Badge>
            </button>

            <button
              type="button"
              onClick={() => setSubFilter('float')}
              className={cn(
                'h-8 sm:h-9 px-3 rounded-xl text-xs font-semibold shrink-0 transition-all flex items-center gap-1.5 cursor-pointer',
                subFilter === 'float'
                  ? 'bg-amber-600 text-white shadow-xs'
                  : 'bg-card hover:bg-muted/60 text-muted-foreground hover:text-foreground border border-border/70'
              )}
            >
              <Banknote className="h-3.5 w-3.5 text-amber-500" />
              <span>Agent Float</span>
              <Badge
                variant="secondary"
                className={cn('text-[9px] px-1 py-0 font-bold', subFilter === 'float' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground')}
              >
                {floatLandlordsCount}
              </Badge>
            </button>

            <button
              type="button"
              onClick={() => setSubFilter('wallet')}
              className={cn(
                'h-8 sm:h-9 px-3 rounded-xl text-xs font-semibold shrink-0 transition-all flex items-center gap-1.5 cursor-pointer',
                subFilter === 'wallet'
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'bg-card hover:bg-muted/60 text-muted-foreground hover:text-foreground border border-border/70'
              )}
            >
              <Wallet className="h-3.5 w-3.5" />
              <span>Welile Wallet</span>
              <Badge
                variant="secondary"
                className={cn('text-[9px] px-1 py-0 font-bold', subFilter === 'wallet' ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground')}
              >
                {walletLandlordsCount}
              </Badge>
            </button>

            <button
              type="button"
              onClick={() => setSubFilter('smartphone')}
              className={cn(
                'h-8 sm:h-9 px-3 rounded-xl text-xs font-semibold shrink-0 transition-all flex items-center gap-1.5 cursor-pointer',
                subFilter === 'smartphone'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'bg-card hover:bg-muted/60 text-muted-foreground hover:text-foreground border border-border/70'
              )}
            >
              <Smartphone className="h-3.5 w-3.5 text-emerald-500" />
              <span>Has Smartphone</span>
              <Badge
                variant="secondary"
                className={cn('text-[9px] px-1 py-0 font-bold', subFilter === 'smartphone' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground')}
              >
                {smartphoneCount}
              </Badge>
            </button>

            <button
              type="button"
              onClick={() => setSubFilter('high_outstanding')}
              className={cn(
                'h-8 sm:h-9 px-3 rounded-xl text-xs font-semibold shrink-0 transition-all flex items-center gap-1.5 cursor-pointer',
                subFilter === 'high_outstanding'
                  ? 'bg-rose-600 text-white shadow-xs'
                  : 'bg-card hover:bg-muted/60 text-muted-foreground hover:text-foreground border border-border/70'
              )}
            >
              <Clock className="h-3.5 w-3.5 text-rose-500" />
              <span>High Balance (&gt;6M)</span>
              <Badge
                variant="secondary"
                className={cn('text-[9px] px-1 py-0 font-bold', subFilter === 'high_outstanding' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground')}
              >
                {highBalanceCount}
              </Badge>
            </button>

            {subFilter !== 'all' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSubFilter('all')}
                className="h-8 text-xs text-primary hover:bg-primary/10 gap-1 px-2.5 shrink-0"
              >
                <span>Reset to All</span>
              </Button>
            )}
          </div>

          {/* Search & Actions Bar */}
          <div className="space-y-3">

        <div className="flex flex-col sm:flex-row gap-2 sm:gap-2.5 sm:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by tenant name, phone, agent, or landlord..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8 pr-8 h-9 sm:h-10 text-xs bg-card border-border/70 rounded-xl shadow-2xs w-full"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={exportToCSV}
              className="flex-1 sm:flex-initial h-9 sm:h-10 gap-1.5 rounded-xl border-border/70 text-xs font-medium"
            >
              <Download className="h-3.5 w-3.5" /> <span>Export CSV</span>
            </Button>

            <Button
              variant="outline"
              size="icon"
              onClick={load}
              disabled={loading}
              className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl border-border/70 shrink-0"
              title="Refresh data"
            >
              <RefreshCw className={cn('h-3.5 w-3.5 sm:h-4 sm:w-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>
      </div>

      {/* MOBILE CARDS VIEW (Clean responsive native cards for small screens) */}
      <div className="block md:hidden space-y-2.5">
        {loading ? (
          <div className="p-8 text-center bg-card rounded-2xl border border-border/60">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary mb-2" />
            <p className="text-xs text-muted-foreground">Loading subscriptions...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center bg-card rounded-2xl border border-border/60">
            <Building2 className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm font-semibold text-foreground">No subscriptions found</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {q ? `No match for "${q}".` : 'No subscriptions in this view.'}
            </p>
            {q && (
              <Button variant="ghost" size="sm" onClick={() => setQ('')} className="mt-3 text-xs text-primary">
                Clear search
              </Button>
            )}
          </div>
        ) : (
          filtered.map((r) => {
            const repaidRatio = r.receivable_total > 0
              ? Math.min(100, Math.max(0, ((r.receivable_total - r.outstanding_balance) / r.receivable_total) * 100))
              : 0;

            return (
              <div key={r.id} className="p-3.5 rounded-2xl border border-border/60 bg-card shadow-2xs space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs shrink-0">
                      {(r.tenant_name || 'T').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-xs text-foreground truncate">{r.tenant_name}</p>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1 font-mono">
                        {r.tenant_phone || 'No phone'}
                        {r.has_smartphone && (
                          <span className="text-[9px] text-emerald-600 bg-emerald-500/10 px-1 py-0.2 rounded font-sans">
                            Smartphone
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  {r.landlord_uses_wallet ? (
                    <Badge className="text-[9px] bg-primary/10 text-primary border-primary/30 shrink-0">
                      <Wallet className="h-2.5 w-2.5 mr-1" /> Wallet
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[9px] shrink-0">
                      <Banknote className="h-2.5 w-2.5 mr-1 text-amber-600" /> Float
                    </Badge>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-border/40">
                  <div>
                    <span className="text-[10px] text-muted-foreground block">Monthly Rent</span>
                    <span className="font-bold text-foreground">{formatUGX(r.monthly_rent)}/mo</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground block">Outstanding</span>
                    <span className="font-bold text-amber-600">{formatUGX(r.outstanding_balance)}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Receivable: {formatUGX(r.receivable_total)}</span>
                    <span className="font-semibold text-foreground">{repaidRatio.toFixed(0)}% paid</span>
                  </div>
                  <Progress value={repaidRatio} className="h-1.5 bg-muted rounded-full" />
                </div>

                <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/30">
                  <span className="truncate max-w-[140px] flex items-center gap-1">
                    <UserCheck className="h-3 w-3 text-muted-foreground shrink-0" /> {r.agent_name}
                  </span>
                  <span className="shrink-0 font-medium">Day {r.payout_day} payout</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* DESKTOP TABLE VIEW (Full table for tablet and desktop) */}
      <Card className="rounded-2xl border-border/60 overflow-hidden shadow-2xs hidden md:block">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40 border-b border-border/60">
                  <TableHead className="text-xs font-semibold">Tenant</TableHead>
                  <TableHead className="text-xs font-semibold">Assigned Agent</TableHead>
                  <TableHead className="text-xs font-semibold">Monthly Rent</TableHead>
                  <TableHead className="text-xs font-semibold">Receivable (×12)</TableHead>
                  <TableHead className="text-xs font-semibold">Outstanding Balance</TableHead>
                  <TableHead className="text-xs font-semibold">Payout Schedule</TableHead>
                  <TableHead className="text-xs font-semibold">Landlord Settlement</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary mb-2" />
                      <p className="text-xs text-muted-foreground">Loading Welile Homes operations data...</p>
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12">
                      <Building2 className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-foreground">No Welile Homes subscriptions found</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {q ? `No match for "${q}" in this category.` : 'No tenants matching the selected criteria.'}
                      </p>
                      {q && (
                        <Button variant="ghost" size="sm" onClick={() => setQ('')} className="mt-3 text-xs text-primary">
                          Clear search
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((r) => {
                    const repaidRatio = r.receivable_total > 0
                      ? Math.min(100, Math.max(0, ((r.receivable_total - r.outstanding_balance) / r.receivable_total) * 100))
                      : 0;

                    return (
                      <TableRow key={r.id} className="hover:bg-muted/30 transition-colors">
                        {/* Tenant */}
                        <TableCell className="py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs shrink-0">
                              {(r.tenant_name || 'T').charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-foreground truncate text-xs sm:text-sm">{r.tenant_name}</p>
                              <p className="text-[11px] text-muted-foreground flex items-center gap-1 font-mono">
                                {r.tenant_phone || 'No phone'}
                                {r.has_smartphone && (
                                  <span title="Has smartphone"><Smartphone className="h-3 w-3 text-emerald-600 inline ml-0.5" /></span>
                                )}
                              </p>
                            </div>
                          </div>
                        </TableCell>

                        {/* Agent */}
                        <TableCell className="text-xs font-medium">
                          <div className="flex items-center gap-1.5">
                            <UserCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="truncate">{r.agent_name}</span>
                          </div>
                        </TableCell>

                        {/* Monthly Rent */}
                        <TableCell className="font-bold text-xs tabular-nums">
                          {formatUGX(r.monthly_rent)}
                          <span className="block text-[10px] font-normal text-muted-foreground">/ month</span>
                        </TableCell>

                        {/* Receivable total */}
                        <TableCell className="text-xs tabular-nums text-muted-foreground">
                          {formatUGX(r.receivable_total)}
                        </TableCell>

                        {/* Outstanding Balance */}
                        <TableCell className="py-3">
                          <div className="space-y-1 min-w-[120px]">
                            <div className="flex items-center justify-between text-xs tabular-nums">
                              <span className="font-bold text-amber-600 dark:text-amber-500">
                                {formatUGX(r.outstanding_balance)}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-medium">
                                {repaidRatio.toFixed(0)}% paid
                              </span>
                            </div>
                            <Progress value={repaidRatio} className="h-1.5 bg-muted" />
                          </div>
                        </TableCell>

                        {/* Payout Day */}
                        <TableCell>
                          <Badge variant="outline" className="text-[11px] font-medium border-border/80 bg-background/50">
                            Day {r.payout_day} of month
                          </Badge>
                        </TableCell>

                        {/* Landlord Settlement */}
                        <TableCell>
                          {r.landlord_uses_wallet ? (
                            <Badge className="text-[10px] bg-primary/10 text-primary border-primary/30 font-medium hover:bg-primary/15">
                              <Wallet className="h-3 w-3 mr-1" /> Welile Wallet
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px] font-medium bg-muted/80 text-foreground border border-border/60">
                              <Banknote className="h-3 w-3 mr-1 text-amber-600" />
                              Agent float{r.landlord_name ? ` · ${r.landlord_name}` : ''}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
        </div>
      )}

      {/* Drill-down Dialog for KPI Cards */}
      <Dialog open={activeDrill !== null} onOpenChange={(open) => !open && setActiveDrill(null)}>
        <DialogContent className="max-w-2xl sm:max-w-3xl max-h-[90vh] flex flex-col p-0 overflow-hidden border-border/80 shadow-2xl">
          {/* Header */}
          <div className="p-5 border-b border-border/60 bg-muted/20">
            {activeDrill === 'tenants' && (
              <div className="flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-sm">
                  <Users className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">Enrolled Tenants Directory</DialogTitle>
                    <Badge className="bg-primary text-primary-foreground text-[10px]">
                      {rows.length} Active Subscriptions
                    </Badge>
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-1">
                    Welile advances 12 full months of rent to property owners upfront. Tenants repay Welile daily in small mobile money or agent float payments over 365 days.
                  </DialogDescription>
                </div>
              </div>
            )}

            {activeDrill === 'agents' && (
              <div className="flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <Activity className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">Active Welile Agents</DialogTitle>
                    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-[10px]">
                      {uniqueAgentCount} Certified Agents
                    </Badge>
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-1">
                    Agents who onboarded and manage Welile Homes tenants. Agents disburse float to landlords and coordinate daily repayments, earning a 2% commission from the rent pool.
                  </DialogDescription>
                </div>
              </div>
            )}

            {activeDrill === 'landlords' && (
              <div className="flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-2xl bg-sky-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <Home className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">Registered Landlords</DialogTitle>
                    <Badge className="bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30 text-[10px]">
                      {uniqueLandlordCount} Property Owners
                    </Badge>
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-1">
                    Property owners receiving guaranteed monthly rent disbursements. Payouts are made either via automated Welile Wallet transfer or agent float on the tenant's scheduled payout day.
                  </DialogDescription>
                </div>
              </div>
            )}

            {activeDrill === 'monthly_pipeline' && (
              <div className="flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <TrendingUp className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">Monthly Rent Pipeline & Fee Distribution</DialogTitle>
                    <Badge className="bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30 text-[10px]">
                      {formatUGX(monthlyRentTotal)} / Month
                    </Badge>
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-1">
                    The gross monthly rent volume committed across active subscriptions. Rent is partitioned into guaranteed landlord rent and the regulatory platform fee pool (Returns + Commission + Platform Fee).
                  </DialogDescription>
                </div>
              </div>
            )}

            {activeDrill === 'receivable' && (
              <div className="flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-2xl bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <Banknote className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">12-Month Advance Booked Receivables</DialogTitle>
                    <Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30 text-[10px]">
                      {formatUGX(totalReceivable)} Booked
                    </Badge>
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-1">
                    Upon subscription onboarding, 12 months of rent is recognized as an advance receivable. Daily repayments amortize this balance over 365 days until full recovery.
                  </DialogDescription>
                </div>
              </div>
            )}

            {activeDrill === 'collections' && (
              <div className="flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-2xl bg-emerald-700 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <Wallet className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">Month-To-Date (MTD) Collections</DialogTitle>
                    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-[10px]">
                      {formatUGX(stats.collectedThisMonth)} Cash Inflow
                    </Badge>
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-1">
                    Actual cash collected from tenant daily repayments during the current calendar month. Recorded in the general ledger and automatically funds upcoming landlord payouts.
                  </DialogDescription>
                </div>
              </div>
            )}

            {activeDrill === 'revenue' && (
              <div className="flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-2xl bg-fuchsia-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <Coins className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">Welile Net Platform Revenue (8%)</DialogTitle>
                    <Badge className="bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/30 text-[10px]">
                      8% Platform Fee
                    </Badge>
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-1">
                    Welile retains 8% of all collected rent as its primary platform fee (from the 10% fee pool; 2% goes to agent commissions). This funds operations, KYC verification, and payout processing.
                  </DialogDescription>
                </div>
              </div>
            )}

            {activeDrill === 'payouts' && (
              <div className="flex items-start gap-3.5">
                <div className="h-10 w-10 rounded-2xl bg-amber-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <Clock className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">Automated Landlord Payouts Queue</DialogTitle>
                    {stats.pendingPayouts > 0 ? (
                      <Badge variant="destructive" className="text-[10px]">
                        {formatUGX(stats.pendingPayouts)} Action Due
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] text-emerald-700 bg-emerald-500/10">
                        All Payouts Settled
                      </Badge>
                    )}
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-1">
                    Rent collected from tenants due for disbursement to property owners. Payouts can be triggered automatically on scheduled payout days or manually on-demand.
                  </DialogDescription>
                </div>
              </div>
            )}
          </div>

          {/* Quick Stats Chips */}
          <div className="p-4 bg-muted/10 border-b border-border/50 grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
            {activeDrill === 'tenants' && (
              <>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Total Tenants</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{rows.length}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Monthly Rent</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(monthlyRentTotal)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Self-Managed</span>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">{smartphoneCount} smartphone</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Agent-Assisted</span>
                  <p className="text-base font-bold text-amber-600 mt-0.5">{rows.length - smartphoneCount} feature phone</p>
                </div>
              </>
            )}

            {activeDrill === 'agents' && (
              <>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Active Agents</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{uniqueAgentCount}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Tenants Managed</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{rows.length}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Rent Managed</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(monthlyRentTotal)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Agent Commission (2%)</span>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">{formatUGX(monthlyRentTotal * 0.02)}</p>
                </div>
              </>
            )}

            {activeDrill === 'landlords' && (
              <>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Total Landlords</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{uniqueLandlordCount}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Welile Wallet</span>
                  <p className="text-base font-bold text-primary mt-0.5">{walletLandlordsCount} properties</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Agent Float</span>
                  <p className="text-base font-bold text-amber-600 mt-0.5">{floatLandlordsCount} properties</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Monthly Landlord Net (90%)</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(monthlyRentTotal * 0.90)}</p>
                </div>
              </>
            )}

            {activeDrill === 'monthly_pipeline' && (
              <>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Monthly Rent</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(monthlyRentTotal)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Landlord Net (90%)</span>
                  <p className="text-base font-bold text-sky-600 mt-0.5">{formatUGX(monthlyRentTotal * 0.90)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Welile Net (8%)</span>
                  <p className="text-base font-bold text-fuchsia-600 mt-0.5">{formatUGX(monthlyRentTotal * 0.08)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Agent Comm (2%)</span>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">{formatUGX(monthlyRentTotal * 0.02)}</p>
                </div>
              </>
            )}

            {activeDrill === 'receivable' && (
              <>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Total Booked (12M)</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(totalReceivable)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Repaid to Date</span>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">{formatUGX(totalRepaid)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Outstanding</span>
                  <p className="text-base font-bold text-amber-600 mt-0.5">{formatUGX(totalOutstanding)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Recovery Rate</span>
                  <p className="text-base font-bold text-primary mt-0.5">{collectionRate.toFixed(1)}%</p>
                </div>
              </>
            )}

            {activeDrill === 'collections' && (
              <>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Collected MTD</span>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">{formatUGX(stats.collectedThisMonth)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Monthly Pipeline</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(monthlyRentTotal)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Platform Fee Earned</span>
                  <p className="text-base font-bold text-fuchsia-600 mt-0.5">{formatUGX(stats.welileNet)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Realization</span>
                  <p className="text-base font-bold text-primary mt-0.5">
                    {monthlyRentTotal > 0 ? `${((stats.collectedThisMonth / monthlyRentTotal) * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
              </>
            )}

            {activeDrill === 'revenue' && (
              <>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Platform Fee Rate</span>
                  <p className="text-base font-bold text-fuchsia-600 mt-0.5">8.0% Net</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">MTD Net Earned</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(stats.welileNet)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Monthly Target</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(monthlyRentTotal * 0.08)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Annual Projected</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{formatUGX(monthlyRentTotal * 0.08 * 12)}</p>
                </div>
              </>
            )}

            {activeDrill === 'payouts' && (
              <>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Pending Amount</span>
                  <p className="text-base font-bold text-amber-600 mt-0.5">{formatUGX(stats.pendingPayouts)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Total Landlords</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{uniqueLandlordCount}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Settlement Channels</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{walletLandlordsCount} Wallet / {floatLandlordsCount} Float</p>
                </div>
                <div className="p-2.5 rounded-xl bg-card border border-border/50">
                  <span className="text-[10px] text-muted-foreground uppercase font-semibold">Status</span>
                  <p className="text-base font-bold text-primary mt-0.5">
                    {stats.pendingPayouts > 0 ? 'Disbursement Due' : 'Up to Date'}
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Drilldown Content / Searchable Lists */}
          <div className="p-4 sm:p-5 overflow-y-auto max-h-[48vh] space-y-3">
            {/* Search within modal if list is long */}
            {(activeDrill === 'tenants' || activeDrill === 'agents' || activeDrill === 'landlords') && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder={`Search in ${activeDrill}...`}
                  value={drillSearch}
                  onChange={(e) => setDrillSearch(e.target.value)}
                  className="pl-8 h-9 text-xs rounded-xl bg-card border-border/60"
                />
              </div>
            )}

            {/* Drilldown 1: Tenants List */}
            {activeDrill === 'tenants' && (
              <div className="space-y-2">
                {rows
                  .filter((r) => {
                    if (!drillSearch) return true;
                    const s = drillSearch.toLowerCase();
                    return (
                      r.tenant_name?.toLowerCase().includes(s) ||
                      r.tenant_phone?.toLowerCase().includes(s) ||
                      r.agent_name?.toLowerCase().includes(s) ||
                      r.landlord_name?.toLowerCase().includes(s)
                    );
                  })
                  .map((t) => (
                    <div
                      key={t.id}
                      className="p-3 rounded-xl border border-border/60 bg-card hover:border-primary/40 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="h-8 w-8 rounded-full bg-primary/10 text-primary font-bold text-xs flex items-center justify-center shrink-0">
                          {(t.tenant_name || 'T').charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-xs text-foreground truncate">{t.tenant_name}</p>
                          <p className="text-[11px] text-muted-foreground flex items-center gap-1 font-mono">
                            {t.tenant_phone || 'No phone'}
                            {t.has_smartphone && (
                              <span className="text-[10px] text-emerald-600 bg-emerald-500/10 px-1 py-0.2 rounded font-sans">
                                Smartphone
                              </span>
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 sm:gap-4 flex-wrap text-xs">
                        <div>
                          <span className="text-[10px] text-muted-foreground block">Monthly Rent</span>
                          <span className="font-bold text-foreground">{formatUGX(t.monthly_rent)}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-muted-foreground block">Outstanding</span>
                          <span className="font-bold text-amber-600">{formatUGX(t.outstanding_balance)}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-muted-foreground block">Agent</span>
                          <span className="text-muted-foreground truncate max-w-[90px] block">{t.agent_name}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setQ(t.tenant_name || '');
                            setActiveTab('all');
                            setActiveDrill(null);
                          }}
                          className="h-7 text-[11px] gap-1 rounded-lg shrink-0"
                        >
                          <Filter className="h-3 w-3" /> Filter Table
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {/* Drilldown 2: Agents List */}
            {activeDrill === 'agents' && (
              <div className="space-y-2">
                {agentsBreakdown
                  .filter((a) => !drillSearch || a.name.toLowerCase().includes(drillSearch.toLowerCase()))
                  .map((a) => (
                    <div
                      key={a.id}
                      className="p-3 rounded-xl border border-border/60 bg-card hover:border-emerald-500/40 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-bold text-xs flex items-center justify-center shrink-0">
                          <UserCheck className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-xs sm:text-sm text-foreground truncate">{a.name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            Managing <span className="font-semibold text-foreground">{a.tenantsCount}</span> tenant subscriptions
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 flex-wrap text-xs">
                        <div>
                          <span className="text-[10px] text-muted-foreground block">Rent Volume Managed</span>
                          <span className="font-bold text-foreground">{formatUGX(a.rentTotal)}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-muted-foreground block">Receivable Book</span>
                          <span className="font-bold text-muted-foreground">{formatUGX(a.receivableTotal)}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setQ(a.name);
                            setActiveTab('all');
                            setActiveDrill(null);
                          }}
                          className="h-8 text-[11px] gap-1 rounded-lg shrink-0 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
                        >
                          <Filter className="h-3 w-3" /> View Tenants ({a.tenantsCount})
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {/* Drilldown 3: Landlords List */}
            {activeDrill === 'landlords' && (
              <div className="space-y-2">
                {landlordsBreakdown
                  .filter((l) => !drillSearch || l.name.toLowerCase().includes(drillSearch.toLowerCase()))
                  .map((l) => (
                    <div
                      key={l.name}
                      className="p-3 rounded-xl border border-border/60 bg-card hover:border-sky-500/40 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="h-9 w-9 rounded-xl bg-sky-500/10 text-sky-700 dark:text-sky-400 font-bold text-xs flex items-center justify-center shrink-0">
                          <Home className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="font-semibold text-xs sm:text-sm text-foreground truncate">{l.name}</p>
                            {l.walletCount > 0 && (
                              <Badge className="text-[9px] bg-primary/10 text-primary border-primary/20 py-0">
                                <Wallet className="h-2.5 w-2.5 mr-0.5 inline" /> Welile Wallet
                              </Badge>
                            )}
                            {l.floatCount > 0 && (
                              <Badge variant="secondary" className="text-[9px] py-0">
                                <Banknote className="h-2.5 w-2.5 mr-0.5 inline text-amber-600" /> Agent Float
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            Payout Day: <span className="font-semibold text-foreground">Day {l.payoutDays.join(', ') || 'N/A'}</span> · {l.tenantsCount} property unit(s)
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 sm:gap-4 flex-wrap text-xs">
                        <div>
                          <span className="text-[10px] text-muted-foreground block">Monthly Revenue</span>
                          <span className="font-bold text-foreground tabular-nums">{formatUGX(l.monthlyRevenue)}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-muted-foreground block">Receivables (×12)</span>
                          <span className="font-bold text-foreground tabular-nums">{formatUGX(l.totalReceivable)}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold block">Our Profit (8%)</span>
                          <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">+{formatUGX(l.ourProfit)}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setQ(l.name);
                            setActiveTab('landlords');
                            setActiveDrill(null);
                          }}
                          className="h-8 text-[11px] gap-1 rounded-lg shrink-0 border-sky-500/30 text-sky-700 dark:text-sky-400 hover:bg-sky-500/10 cursor-pointer"
                        >
                          <Users className="h-3 w-3" /> View Attached Tenants ({l.tenantsCount})
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {/* Drilldown 4: Monthly Rent Pipeline */}
            {activeDrill === 'monthly_pipeline' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-card border border-border/70 space-y-3">
                  <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Four-Part Rent Flow Waterfall (Regulatory Model)
                  </h4>
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-muted/40">
                      <span className="font-medium text-foreground">Gross Monthly Rent</span>
                      <span className="font-bold text-foreground">{formatUGX(monthlyRentTotal)} (100%)</span>
                    </div>
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-sky-500/10 text-sky-900 dark:text-sky-300">
                      <span className="font-medium flex items-center gap-1.5">
                        <Home className="h-3.5 w-3.5 text-sky-600" /> Landlord Guaranteed Net Payout (90%)
                      </span>
                      <span className="font-bold">{formatUGX(monthlyRentTotal * 0.90)}</span>
                    </div>
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-fuchsia-500/10 text-fuchsia-900 dark:text-fuchsia-300">
                      <span className="font-medium flex items-center gap-1.5">
                        <Coins className="h-3.5 w-3.5 text-fuchsia-600" /> Welile Platform Fee (8%)
                      </span>
                      <span className="font-bold">{formatUGX(monthlyRentTotal * 0.08)}</span>
                    </div>
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-emerald-500/10 text-emerald-900 dark:text-emerald-300">
                      <span className="font-medium flex items-center gap-1.5">
                        <Activity className="h-3.5 w-3.5 text-emerald-600" /> Agent Allocation Commission (2%)
                      </span>
                      <span className="font-bold">{formatUGX(monthlyRentTotal * 0.02)}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <h5 className="text-xs font-bold text-muted-foreground uppercase mb-2">
                    Top Rent Pipeline Subscriptions
                  </h5>
                  <div className="space-y-1.5">
                    {rows.slice(0, 5).map((r) => (
                      <div key={r.id} className="p-2.5 rounded-xl bg-muted/20 border border-border/40 flex items-center justify-between text-xs">
                        <div>
                          <p className="font-semibold text-foreground">{r.tenant_name}</p>
                          <p className="text-[10px] text-muted-foreground">{r.landlord_name || 'Landlord'}</p>
                        </div>
                        <span className="font-bold text-foreground">{formatUGX(r.monthly_rent)}/mo</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Drilldown 5: Total Booked Receivable */}
            {activeDrill === 'receivable' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-card border border-border/70 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                        12-Month Advance Amortization
                      </h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {formatUGX(totalRepaid)} repaid of {formatUGX(totalReceivable)} recognized
                      </p>
                    </div>
                    <Badge className="bg-primary text-primary-foreground font-bold text-xs">
                      {collectionRate.toFixed(1)}% Collected
                    </Badge>
                  </div>
                  <Progress value={collectionRate} className="h-2 rounded-full" />
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      openSubscriptions('high_outstanding');
                      setActiveDrill(null);
                    }}
                    className="flex-1 text-xs gap-1.5 h-9"
                  >
                    <Clock className="h-3.5 w-3.5 text-amber-600" />
                    Filter High Outstanding ({highBalanceCount})
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      openSubscriptions('all');
                      setActiveDrill(null);
                    }}
                    className="flex-1 text-xs gap-1.5 h-9"
                  >
                    <Users className="h-3.5 w-3.5 text-primary" />
                    View All Subscriptions ({rows.length})
                  </Button>
                </div>
              </div>
            )}

            {/* Drilldown 6: Collections MTD */}
            {activeDrill === 'collections' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-card border border-border/70 space-y-3">
                  <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Current Month Collection Realization
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Cash collected across Welile Homes daily tenant repayments during this month. Daily repayments automatically credit each tenant's receivable ledger and replenish the landlord settlement reserve.
                  </p>
                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <div className="p-3 rounded-xl bg-muted/40">
                      <span className="text-[10px] text-muted-foreground uppercase block font-semibold">Cash Collected MTD</span>
                      <span className="text-lg font-bold text-emerald-600">{formatUGX(stats.collectedThisMonth)}</span>
                    </div>
                    <div className="p-3 rounded-xl bg-muted/40">
                      <span className="text-[10px] text-muted-foreground uppercase block font-semibold">Target Monthly Bill</span>
                      <span className="text-lg font-bold text-foreground">{formatUGX(monthlyRentTotal)}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Drilldown 7: Welile Net Revenue */}
            {activeDrill === 'revenue' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-card border border-border/70 space-y-3">
                  <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                    Platform Revenue Recognition
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Welile retains 8% of all collected rent as recognized platform operating income. The remaining 2% from the 10% fee pool is credited directly to certified agents who manage the tenant's daily collection.
                  </p>
                  <div className="space-y-2 pt-1 text-xs">
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-muted/30">
                      <span>Platform Fee (Welile Net)</span>
                      <span className="font-bold text-fuchsia-600">8.0%</span>
                    </div>
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-muted/30">
                      <span>Agent Commission</span>
                      <span className="font-bold text-emerald-600">2.0%</span>
                    </div>
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-muted/30">
                      <span>Landlord Net Payout</span>
                      <span className="font-bold text-sky-600">90.0%</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Drilldown 8: Pending Landlord Payouts */}
            {activeDrill === 'payouts' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-card border border-border/70 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">
                        Pending Payout Disbursement
                      </h4>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {stats.pendingPayouts > 0
                          ? `${formatUGX(stats.pendingPayouts)} due for automated batch disbursement.`
                          : 'All landlord payouts are up to date!'}
                      </p>
                    </div>
                    {stats.pendingPayouts > 0 && (
                      <Badge variant="destructive" className="animate-pulse text-xs">
                        Action Due
                      </Badge>
                    )}
                  </div>

                  <div className="p-3 rounded-xl bg-muted/40 border border-border/60 text-xs text-muted-foreground">
                    <p className="flex items-center gap-1.5 font-medium text-foreground">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      Automated Daily Settlement
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed">
                      Landlord payouts are processed automatically on each landlord's scheduled cycle day (Day 5, 10, 15, 20, 25, 28) via the platform daily settlement cron.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Modal Footer */}
          <DialogFooter className="p-4 border-t border-border/60 bg-muted/20 sm:justify-between flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              Welile Homes Operations · Live Ledger Sync
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActiveDrill(null)}
              className="text-xs h-8"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Action Dialog: Payment History */}
      <Dialog open={!!historySub} onOpenChange={(open) => { if (!open) setHistorySub(null); }}>
        <DialogContent className="max-w-lg rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="p-4 sm:p-5 border-b border-border/60 bg-muted/20">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Clock className="h-4.5 w-4.5" />
              </div>
              <div>
                <DialogTitle className="text-sm sm:text-base font-bold text-foreground">
                  Payment History: {historySub?.tenant_name}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  {historySub?.tenant_phone || 'No phone'} · Landlord: {historySub?.landlord_name || 'Unassigned'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="p-4 sm:p-5 space-y-3 max-h-[60vh] overflow-y-auto">
            <div className="grid grid-cols-3 gap-2 p-3 rounded-xl bg-muted/30 border border-border/50 text-xs">
              <div>
                <span className="text-[10px] text-muted-foreground block">Monthly Rent</span>
                <span className="font-bold text-foreground tabular-nums">{historySub ? formatUGX(historySub.monthly_rent) : '—'}</span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground block">Outstanding</span>
                <span className="font-bold text-amber-600 dark:text-amber-400 tabular-nums">{historySub ? formatUGX(historySub.outstanding_balance) : '—'}</span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground block">Payout Day</span>
                <span className="font-bold text-foreground tabular-nums">{historySub?.payout_day}</span>
              </div>
            </div>

            <div className="pt-2">
              <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Monthly Dues & Payout Timeline</h5>
              {loadingHistory ? (
                <div className="p-6 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span>Loading ledger records...</span>
                </div>
              ) : historyDues.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground border border-dashed rounded-xl">
                  No monthly dues recorded for this subscription yet.
                </div>
              ) : (
                <div className="divide-y divide-border/40 rounded-xl border border-border/60 overflow-hidden">
                  {historyDues.map((d: MonthlyDueRow) => (
                    <div key={d.id} className="p-2.5 sm:p-3 flex items-center justify-between gap-3 text-xs bg-card hover:bg-muted/20">
                      <div>
                        <span className="font-bold text-foreground block">{d.period_month}</span>
                        <span className="text-[10px] text-muted-foreground">Due: {formatUGX(d.amount_due)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          className={cn(
                            "text-[10px] px-1.5 py-0 font-medium",
                            d.collection_status === 'collected'
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
                              : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"
                          )}
                        >
                          {d.collection_status === 'collected' ? 'Collected' : 'Pending'}
                        </Badge>
                        <Badge
                          variant="secondary"
                          className={cn(
                            "text-[10px] px-1.5 py-0 font-medium",
                            d.payout_status === 'paid'
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
                              : "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20"
                          )}
                        >
                          {d.payout_status === 'paid' ? 'Paid to Landlord' : 'Unpaid Payout'}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="p-3 border-t border-border/60 bg-muted/10">
            <Button variant="outline" size="sm" onClick={() => setHistorySub(null)} className="h-8 text-xs cursor-pointer">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* Action Dialog: Verify Tenant Phone */}
      <Dialog open={!!verifySub} onOpenChange={(open) => { if (!open) setVerifySub(null); }}>
        <DialogContent className="max-w-md rounded-2xl p-5 space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              Verify Tenant Phone
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Confirm KYC verification for {verifySub?.tenant_name} ({verifySub?.tenant_phone || 'No phone'}).
            </DialogDescription>
          </DialogHeader>

          <div className="p-3 rounded-xl bg-muted/30 border border-border/50 text-xs space-y-2">
            <p className="text-foreground">
              Verifying this tenant activates full advance coverage and confirms the agent enrollment terms.
            </p>
            <p className="text-[11px] text-muted-foreground">
              Tenant Phone: <span className="font-semibold text-foreground">{verifySub?.tenant_phone || '—'}</span>
            </p>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVerifySub(null)}
              disabled={verifying}
              className="h-8 text-xs cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleVerifyDirect}
              disabled={verifying}
              className="h-8 text-xs bg-emerald-600 text-white hover:bg-emerald-700 font-semibold gap-1.5 cursor-pointer shadow-xs"
            >
              {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              <span>Mark as Verified</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Action Dialog: Delete Application Confirmation */}
      <Dialog open={!!deleteSub} onOpenChange={(open) => { if (!open) setDeleteSub(null); }}>
        <DialogContent className="max-w-md rounded-2xl p-5 space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-destructive flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Delete Tenant Application
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Are you sure you want to remove <span className="font-bold text-foreground">{deleteSub?.tenant_name}</span>? This will permanently delete the subscription from Welile Homes.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteSub(null)}
              disabled={deleting}
              className="h-8 text-xs cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleting}
              className="h-8 text-xs font-semibold gap-1.5 cursor-pointer shadow-xs"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              <span>Confirm Delete</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Action Dialog: Reject Float Request (tenants stay enrolled) */}
      <Dialog open={!!rejectReq} onOpenChange={(open) => { if (!open && !rejectingReq) setRejectReq(null); }}>
        <DialogContent className="max-w-md rounded-2xl p-5 space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-rose-600 dark:text-rose-400 flex items-center gap-2">
              <XCircle className="h-5 w-5" />
              Reject float request
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {rejectReq?.agent_name || 'Agent'} · {formatUGX(Number(rejectReq?.requested_amount) || 0)}.
              The tenants stay enrolled; only this request is closed. The agent sees your note.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="wh-reject-note" className="text-[11px] font-semibold text-muted-foreground">
              Note to the agent
            </Label>
            <Textarea
              id="wh-reject-note"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              className="text-xs rounded-xl"
            />
            {rejectNote.trim().length < 5 && (
              <p className="text-[10px] text-destructive">Add a note of at least 5 characters.</p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRejectReq(null)}
              disabled={rejectingReq}
              className="h-8 text-xs cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={confirmRejectRequest}
              disabled={rejectingReq || rejectNote.trim().length < 5}
              className="h-8 text-xs font-semibold gap-1.5 cursor-pointer"
            >
              {rejectingReq ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Action Dialog: Decline Application(s) */}
      <Dialog open={declineDialogOpen} onOpenChange={(open) => { if (!open) setDeclineDialogOpen(false); }}>
        <DialogContent className="max-w-md rounded-2xl p-5 space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-rose-600 dark:text-rose-400 flex items-center gap-2">
              <XCircle className="h-5 w-5" />
              {declineTarget?.title ?? 'Decline application'}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {declineTarget?.description}{' '}
              This will mark the application as cancelled and reject any associated float requests.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-foreground">Reason for declining (optional)</Label>
            <Textarea
              placeholder="e.g. Ineligible landlord details, unverified tenant phone number, high risk..."
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              className="text-xs resize-none h-20"
            />
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeclineDialogOpen(false)}
              disabled={declining}
              className="h-8 text-xs cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={confirmDecline}
              disabled={declining}
              className="h-8 text-xs font-semibold gap-1.5 cursor-pointer shadow-xs bg-rose-600 hover:bg-rose-700 text-white"
            >
              {declining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
              <span>Confirm Decline</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Landlord Full Details Clean Preview Window */}
      <Dialog open={!!previewLandlord} onOpenChange={(open) => { if (!open) setPreviewLandlord(null); }}>
        <DialogContent className="w-[95vw] sm:max-w-3xl lg:max-w-4xl max-h-[88vh] overflow-y-auto rounded-2xl sm:rounded-3xl p-0 border border-border/80 shadow-2xl">
          {previewLandlord && (
            <div>
              {/* Header Banner */}
              <div className="p-3 sm:p-4 bg-gradient-to-br from-primary/10 via-card to-card border-b border-border/70 sticky top-0 z-10 backdrop-blur-md">
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-primary text-primary-foreground font-bold flex items-center justify-center shrink-0 shadow-sm">
                      <Home className="h-4 w-4 sm:h-5 sm:w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                        <DialogTitle className="text-sm sm:text-base font-bold text-foreground truncate">
                          {previewLandlord.name}
                        </DialogTitle>
                        <Badge variant="secondary" className="text-[10px] sm:text-xs font-semibold py-0 px-1.5">
                          {previewLandlord.tenantsCount} {previewLandlord.tenantsCount === 1 ? 'Tenant' : 'Tenants'}
                        </Badge>
                        {previewLandlord.walletCount > 0 && (
                          <Badge variant="outline" className="text-[10px] sm:text-xs border-primary/30 text-primary bg-primary/5 py-0 px-1.5 font-medium">
                            <Wallet className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-1 inline" /> Welile Wallet
                          </Badge>
                        )}
                        {previewLandlord.floatCount > 0 && (
                          <Badge variant="secondary" className="text-[10px] sm:text-xs py-0 px-1.5 text-muted-foreground font-medium">
                            <Banknote className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-1 inline text-muted-foreground" /> Agent Float
                          </Badge>
                        )}
                      </div>
                      <DialogDescription className="text-[11px] sm:text-xs text-muted-foreground mt-0.5">
                        Scheduled Payout: <span className="font-semibold text-foreground">Day {previewLandlord.payoutDays.join(', ') || '5'} of month</span> · Portfolio &amp; tenant contracts
                      </DialogDescription>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-3 sm:p-4 space-y-3.5">
                {/* 4 Compact Financial Metric Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="p-2 sm:p-2.5 rounded-xl bg-muted/60 dark:bg-muted/40 border border-border/70 flex flex-col justify-between">
                    <span className="text-[9.5px] text-muted-foreground uppercase font-semibold tracking-tight">Monthly Revenue</span>
                    <p className="text-xs sm:text-sm font-bold text-foreground tabular-nums mt-0.5 truncate">
                      {formatUGX(previewLandlord.monthlyRevenue)}
                    </p>
                    <span className="text-[9.5px] text-muted-foreground truncate">/mo booked</span>
                  </div>

                  <div className="p-2 sm:p-2.5 rounded-xl bg-muted/60 dark:bg-muted/40 border border-border/70 flex flex-col justify-between">
                    <span className="text-[9.5px] text-muted-foreground uppercase font-semibold tracking-tight">12-Mo Receivable</span>
                    <p className="text-xs sm:text-sm font-bold text-foreground tabular-nums mt-0.5 truncate">
                      {formatUGX(previewLandlord.totalReceivable)}
                    </p>
                    <span className="text-[9.5px] text-muted-foreground truncate">annual portfolio</span>
                  </div>

                  <div className="p-2 sm:p-2.5 rounded-xl bg-muted/60 dark:bg-muted/40 border border-border/70 flex flex-col justify-between">
                    <span className="text-[9.5px] text-muted-foreground uppercase font-semibold tracking-tight">Agent 2% Commission</span>
                    <p className="text-xs sm:text-sm font-bold text-foreground tabular-nums mt-0.5 truncate">
                      +{formatUGX(previewLandlord.agentCommission)}
                    </p>
                    <span className="text-[9.5px] text-muted-foreground truncate">+{formatUGX(previewLandlord.monthlyCommission)}/mo</span>
                  </div>

                  <div className="p-2 sm:p-2.5 rounded-xl bg-primary/10 border border-primary/30 flex flex-col justify-between">
                    <span className="text-[9.5px] text-primary uppercase font-bold tracking-tight">Our Net Profit (8%)</span>
                    <p className="text-xs sm:text-sm font-bold text-primary tabular-nums mt-0.5 truncate">
                      +{formatUGX(previewLandlord.ourProfit)}
                    </p>
                    <span className="text-[9.5px] text-primary/80 font-medium truncate">+{formatUGX(previewLandlord.monthlyProfit)}/mo</span>
                  </div>
                </div>

                {/* Attached Tenants Table / List */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11px] sm:text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-primary" />
                      Attached Tenants ({previewLandlord.tenants.length})
                    </span>
                    <span className="text-[10px] sm:text-[11px] text-muted-foreground">
                      8% platform fee · 2% field commission
                    </span>
                  </div>

                  {/* Desktop Table View (Compact to fit without horizontal overflow) */}
                  <div className="hidden sm:block overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <Table className="text-[11px]">
                      <TableHeader className="bg-muted/40">
                        <TableRow className="border-border/60">
                          <TableHead className="font-semibold text-foreground py-1.5 px-2.5">Tenant</TableHead>
                          <TableHead className="font-semibold text-foreground py-1.5 px-2">Agent</TableHead>
                          <TableHead className="font-semibold text-foreground py-1.5 px-2">Monthly Rent</TableHead>
                          <TableHead className="font-semibold text-foreground py-1.5 px-2">12-Mo Rec.</TableHead>
                          <TableHead className="font-semibold text-foreground py-1.5 px-2">Outstanding</TableHead>
                          <TableHead className="font-semibold text-foreground py-1.5 px-2">Agent 2%</TableHead>
                          <TableHead className="font-semibold text-foreground py-1.5 px-2">Our Profit (8%)</TableHead>
                          <TableHead className="font-semibold text-foreground py-1.5 px-2.5">Channel</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {previewLandlord.tenants.map((t) => (
                          <TableRow key={t.id} className="border-border/40 hover:bg-muted/20">
                            <TableCell className="font-medium py-1.5 px-2.5">
                              <div>
                                <div className="font-bold text-foreground">{t.name}</div>
                                <div className="text-[9.5px] text-muted-foreground font-mono">{t.phone}</div>
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 px-2">
                              <div className="text-foreground text-[11px] truncate max-w-[120px]">{t.agentName}</div>
                            </TableCell>
                            <TableCell className="py-1.5 px-2">
                              <div className="font-bold tabular-nums text-foreground">{formatUGX(t.monthlyRent)}</div>
                              <span className="text-[9.5px] text-muted-foreground">/mo</span>
                            </TableCell>
                            <TableCell className="py-1.5 px-2">
                              <div className="tabular-nums font-medium text-foreground">{formatUGX(t.receivableTotal)}</div>
                            </TableCell>
                            <TableCell className="py-1.5 px-2">
                              <div className="space-y-1 min-w-[85px]">
                                <div className="flex justify-between text-[9.5px]">
                                  <span className="font-bold text-foreground">{formatUGX(t.outstandingBalance)}</span>
                                  <span className="text-muted-foreground">{t.repaidRatio.toFixed(0)}%</span>
                                </div>
                                <Progress value={t.repaidRatio} className="h-1 bg-muted" />
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 px-2">
                              <div className="font-bold tabular-nums text-foreground">
                                +{formatUGX(t.agentCommission)}
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 px-2">
                              <div className="font-bold tabular-nums text-primary">
                                +{formatUGX(t.ourProfit)}
                              </div>
                            </TableCell>
                            <TableCell className="py-1.5 px-2.5">
                              {t.usesWallet ? (
                                <Badge variant="outline" className="text-[9px] py-0 px-1 border-primary/30 text-primary">Wallet</Badge>
                              ) : (
                                <Badge variant="secondary" className="text-[9px] py-0 px-1">Float</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Mobile Cards View */}
                  <div className="block sm:hidden space-y-2">
                    {previewLandlord.tenants.map((t) => (
                      <div key={t.id} className="p-2.5 rounded-xl border border-border/70 bg-card space-y-1.5 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-bold text-foreground text-xs">{t.name}</p>
                            <p className="text-[10px] text-muted-foreground">{t.phone} · Agent: {t.agentName}</p>
                          </div>
                          <div className="text-right">
                            <span className="font-bold text-foreground text-xs">{formatUGX(t.monthlyRent)}</span>
                            <span className="block text-[9px] text-muted-foreground">/mo</span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between pt-1 border-t border-border/40 text-[10.5px]">
                          <span className="text-muted-foreground">12-Mo Rec.:</span>
                          <span className="font-semibold text-foreground tabular-nums">{formatUGX(t.receivableTotal)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[10.5px]">
                          <span className="text-muted-foreground font-medium">Agent 2%:</span>
                          <span className="font-bold text-foreground tabular-nums">+{formatUGX(t.agentCommission)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[10.5px]">
                          <span className="text-primary font-bold">Our Profit (8%):</span>
                          <span className="font-bold text-primary tabular-nums">+{formatUGX(t.ourProfit)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <DialogFooter className="p-2.5 sm:p-3 border-t border-border/70 bg-muted/20 flex flex-row items-center justify-between gap-2 sticky bottom-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportLandlordsCSV}
                  className="h-7 text-xs font-semibold gap-1.5 rounded-xl border-border/70 cursor-pointer"
                >
                  <Download className="h-3 w-3" /> Export CSV
                </Button>
                <Button
                  size="sm"
                  onClick={() => setPreviewLandlord(null)}
                  className="h-7 text-xs font-semibold rounded-xl bg-primary text-primary-foreground cursor-pointer px-3"
                >
                  Close
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Mobile Bottom Navigation for Welile Homes */}
      <WelileHomesMobileBottomNav
        active={activeTab}
        onChange={setActiveTab}
        counts={{
          applications: rows.length,
          landlords: enrolledLandlordsBreakdown.length,
          all: rows.length,
        }}
      />

      {/* Agent 360 Performance & Eligibility Drawer */}
      <AgentProfile360Sheet
        agentId={profileAgentId}
        onOpenChange={(open) => {
          if (!open) setProfileAgentId(null);
        }}
      />
    </div>
  );
}