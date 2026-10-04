import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Users,
  Wallet,
  DollarSign,
  AlertCircle,
  TrendingUp,
  Search,
  SlidersHorizontal,
  Plus,
  CreditCard,
  MessageSquare,
  Eye,
  Phone,
  Building2,
  CheckCircle2,
  Shield,
  MoreVertical,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import LandlordAddTenantDialog from './LandlordAddTenantDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import UserReviewsSection from '@/components/reviews/UserReviewsSection';

interface TenantRow {
  id: string;
  tenant_id: string;
  property_address: string;
  monthly_rent: number;
  tenant_name: string;
  tenant_phone: string;
  avatar_url: string | null;
  // derived
  balance: number;
  totalRepayment: number;
  amountRepaid: number;
  hasActiveCycle: boolean;
  payStatus: 'paid_up' | 'owing' | 'due_soon' | 'overdue';
  riskLevel: 'low' | 'medium' | 'high';
  reliability: 'pays_on_time' | 'usually_late' | 'frequently_late';
  lastPayment: string | null;
  dueDate: string | null;
  daysDelta: number | null;
}

const STATUS_META: Record<TenantRow['payStatus'], { label: string; cls: string; dot: string }> = {
  paid_up:  { label: 'Paid Up',  cls: 'bg-emerald-100 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  owing:    { label: 'Owing',    cls: 'bg-rose-100 text-rose-700 border-rose-200',          dot: 'bg-rose-500' },
  due_soon: { label: 'Due Soon', cls: 'bg-amber-100 text-amber-700 border-amber-200',       dot: 'bg-amber-500' },
  overdue:  { label: 'Overdue',  cls: 'bg-rose-100 text-rose-700 border-rose-200',          dot: 'bg-rose-500' },
};

const RISK_META: Record<TenantRow['riskLevel'], { label: string; cls: string }> = {
  low:    { label: 'Low Risk',    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  medium: { label: 'Medium Risk', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  high:   { label: 'High Risk',   cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};

const RELIABILITY_META: Record<TenantRow['reliability'], { label: string; cls: string }> = {
  pays_on_time:    { label: 'Pays on time',    cls: 'bg-emerald-50 text-emerald-700' },
  usually_late:    { label: 'Usually late',    cls: 'bg-amber-50 text-amber-700' },
  frequently_late: { label: 'Frequently late', cls: 'bg-rose-50 text-rose-700' },
};

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
}

function avatarColor(name: string) {
  const palette = [
    'bg-violet-200 text-violet-700',
    'bg-rose-200 text-rose-700',
    'bg-emerald-200 text-emerald-700',
    'bg-amber-200 text-amber-700',
    'bg-sky-200 text-sky-700',
  ];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  iconBg,
  iconColor,
  valueClass = '',
  subClass = 'text-muted-foreground',
}: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  iconBg: string;
  iconColor: string;
  valueClass?: string;
  subClass?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`h-11 w-11 rounded-xl ${iconBg} flex items-center justify-center shrink-0`}>
          <Icon className={`h-5 w-5 ${iconColor}`} />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`text-xl font-bold leading-tight ${valueClass}`}>{value}</p>
          {sub && <p className={`text-[11px] mt-0.5 ${subClass}`}>{sub}</p>}
        </div>
      </div>
    </div>
  );
}

export default function MyTenantsSection() {
  const { user } = useAuth();
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [reviewTenant, setReviewTenant] = useState<TenantRow | null>(null);

  // filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [riskFilter, setRiskFilter] = useState<string>('all');
  const [propertyFilter, setPropertyFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<string>('recent');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  useEffect(() => {
    if (user) fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function fetch() {
    if (!user) return;
    setLoading(true);

    const { data: profile } = await supabase
      .from('profiles')
      .select('phone')
      .eq('id', user.id)
      .single();
    if (!profile) {
      setLoading(false);
      return;
    }

    const { data: landlordEntries } = await supabase
      .from('landlords')
      .select('id, tenant_id, property_address, monthly_rent')
      .eq('phone', profile.phone);

    const entries = (landlordEntries || []).filter((e) => e.tenant_id);
    if (entries.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    const tenantIds = [...new Set(entries.map((e) => e.tenant_id as string))];

    const [profilesRes, rentRes] = await Promise.all([
      supabase.from('profiles').select('id, full_name, phone, avatar_url').in('id', tenantIds),
      supabase
        .from('rent_requests')
        .select(
          'tenant_id, rent_amount, total_repayment, amount_repaid, status, disbursed_at, duration_days, updated_at, created_at',
        )
        .in('tenant_id', tenantIds)
        .or(`landlord_id.eq.${user.id},landlord_phone.eq.${profile.phone}`),
    ]);

    const profMap = new Map((profilesRes.data || []).map((p) => [p.id, p]));
    const rentByTenant = new Map<string, any[]>();
    for (const rr of rentRes.data || []) {
      const arr = rentByTenant.get(rr.tenant_id) || [];
      arr.push(rr);
      rentByTenant.set(rr.tenant_id, arr);
    }

    const today = Date.now();

    const built: TenantRow[] = entries.map((e) => {
      const p = profMap.get(e.tenant_id as string);
      const cycles = rentByTenant.get(e.tenant_id as string) || [];
      const active = cycles.find((c) =>
        ['funded', 'disbursed', 'repaying', 'approved', 'active'].includes(c.status),
      );
      const totalRepayment = Number(active?.total_repayment ?? e.monthly_rent ?? 0);
      const amountRepaid = Number(active?.amount_repaid ?? 0);
      const balance = Math.max(0, totalRepayment - amountRepaid);
      const startMs = active?.disbursed_at ? new Date(active.disbursed_at).getTime() : null;
      const dueDate =
        startMs && active?.duration_days
          ? new Date(startMs + Number(active.duration_days) * 86400000).toISOString()
          : null;
      const daysDelta = dueDate
        ? Math.round((new Date(dueDate).getTime() - today) / 86400000)
        : null;

      let payStatus: TenantRow['payStatus'] = 'paid_up';
      if (balance > 0 && daysDelta !== null) {
        if (daysDelta < 0) payStatus = 'overdue';
        else if (daysDelta <= 7) payStatus = 'due_soon';
        else payStatus = 'owing';
      } else if (balance > 0) {
        payStatus = 'owing';
      }

      const pct = totalRepayment > 0 ? amountRepaid / totalRepayment : 1;
      const riskLevel: TenantRow['riskLevel'] =
        payStatus === 'overdue' ? 'high' : payStatus === 'due_soon' ? 'medium' : 'low';
      const reliability: TenantRow['reliability'] =
        pct >= 0.95 ? 'pays_on_time' : pct >= 0.6 ? 'usually_late' : 'frequently_late';

      const lastPayment = cycles
        .map((c) => c.updated_at)
        .filter(Boolean)
        .sort()
        .pop() || null;

      return {
        id: e.id,
        tenant_id: e.tenant_id as string,
        property_address: e.property_address,
        monthly_rent: Number(e.monthly_rent || 0),
        tenant_name: p?.full_name || 'Unknown Tenant',
        tenant_phone: p?.phone || '',
        avatar_url: p?.avatar_url || null,
        balance,
        totalRepayment,
        amountRepaid,
        hasActiveCycle: !!active,
        payStatus,
        riskLevel,
        reliability,
        lastPayment,
        dueDate,
        daysDelta,
      };
    });

    setRows(built);
    setLoading(false);
  }

  const properties = useMemo(
    () => Array.from(new Set(rows.map((r) => r.property_address).filter(Boolean))),
    [rows],
  );

  const filtered = useMemo(() => {
    let list = rows.slice();
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.tenant_name.toLowerCase().includes(s) ||
          r.tenant_phone.toLowerCase().includes(s) ||
          r.property_address.toLowerCase().includes(s),
      );
    }
    if (statusFilter !== 'all') list = list.filter((r) => r.payStatus === statusFilter);
    if (riskFilter !== 'all') list = list.filter((r) => r.riskLevel === riskFilter);
    if (propertyFilter !== 'all') list = list.filter((r) => r.property_address === propertyFilter);
    switch (sortBy) {
      case 'balance_desc':
        list.sort((a, b) => b.balance - a.balance);
        break;
      case 'name':
        list.sort((a, b) => a.tenant_name.localeCompare(b.tenant_name));
        break;
      case 'due':
        list.sort((a, b) => (a.daysDelta ?? 9999) - (b.daysDelta ?? 9999));
        break;
      default:
        break;
    }
    return list;
  }, [rows, search, statusFilter, riskFilter, propertyFilter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  // stats
  const stats = useMemo(() => {
    const total = rows.length;
    const owing = rows.filter((r) => r.balance > 0).length;
    const overdueRows = rows.filter((r) => r.payStatus === 'overdue');
    const overdueAmount = overdueRows.reduce((s, r) => s + r.balance, 0);
    const collected = rows.reduce((s, r) => s + r.amountRepaid, 0);
    const occupancy = total > 0 ? Math.round((rows.filter((r) => r.hasActiveCycle).length / total) * 100) : 0;
    return { total, owing, overdueAmount, overdueCount: overdueRows.length, collected, occupancy };
  }, [rows]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-14 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">My Tenants</h2>
        </div>
        <Button onClick={() => setShowAdd(true)} className="gap-2 rounded-xl dark:text-white">
          <Plus className="h-4 w-4" />
          Add Tenant
        </Button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          icon={Users}
          label="Total Tenants"
          value={String(stats.total)}
          sub="All tenants"
          iconBg="bg-violet-100"
          iconColor="text-violet-600"
        />
        <StatCard
          icon={Wallet}
          label="Owing"
          value={String(stats.owing)}
          sub="Tenants owing"
          iconBg="bg-amber-100"
          iconColor="text-amber-600"
          subClass="text-rose-600 font-medium"
        />
        <StatCard
          icon={DollarSign}
          label="Collected This Month"
          value={formatUGX(stats.collected)}
          sub="Lifetime collected"
          iconBg="bg-emerald-100"
          iconColor="text-emerald-600"
        />
        <StatCard
          icon={AlertCircle}
          label="Overdue Amount"
          value={formatUGX(stats.overdueAmount)}
          sub={`From ${stats.overdueCount} tenants`}
          iconBg="bg-amber-100"
          iconColor="text-amber-600"
          subClass="text-amber-600 font-medium"
        />
        <StatCard
          icon={TrendingUp}
          label="Occupancy Rate"
          value={`${stats.occupancy}%`}
          sub="Active cycles"
          iconBg="bg-sky-100"
          iconColor="text-sky-600"
          subClass="text-emerald-600 font-medium"
        />
      </div>

      {/* Filters */}
      <Card className="rounded-2xl border-border/60">
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search tenant, phone, property..."
              className="pl-9 h-10 rounded-xl bg-muted/40 border-transparent"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[140px] h-10 rounded-xl">
              <div className="text-left">
                <p className="text-[10px] text-muted-foreground leading-none">Status</p>
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="paid_up">Paid Up</SelectItem>
              <SelectItem value="owing">Owing</SelectItem>
              <SelectItem value="due_soon">Due Soon</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
            </SelectContent>
          </Select>
          <Select value={riskFilter} onValueChange={(v) => { setRiskFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[140px] h-10 rounded-xl">
              <div className="text-left">
                <p className="text-[10px] text-muted-foreground leading-none">Risk Level</p>
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
          <Select value={propertyFilter} onValueChange={(v) => { setPropertyFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[180px] h-10 rounded-xl">
              <div className="text-left">
                <p className="text-[10px] text-muted-foreground leading-none">Property</p>
                <SelectValue placeholder="All Properties" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Properties</SelectItem>
              {properties.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-[170px] h-10 rounded-xl">
              <div className="text-left">
                <p className="text-[10px] text-muted-foreground leading-none">Sort By</p>
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Recently Added</SelectItem>
              <SelectItem value="balance_desc">Balance (High → Low)</SelectItem>
              <SelectItem value="due">Due Date</SelectItem>
              <SelectItem value="name">Name (A → Z)</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" className="gap-2 h-10 rounded-xl">
            <SlidersHorizontal className="h-4 w-4" />
            Filter
          </Button>
        </CardContent>
      </Card>

      {/* List */}
      <div className="space-y-3">
        {pageRows.length === 0 ? (
          <Card className="rounded-2xl border-dashed">
            <CardContent className="py-12 text-center text-muted-foreground">
              No tenants match these filters.
            </CardContent>
          </Card>
        ) : (
          pageRows.map((r, idx) => {
            const status = STATUS_META[r.payStatus];
            const risk = RISK_META[r.riskLevel];
            const rel = RELIABILITY_META[r.reliability];
            const pct = r.totalRepayment > 0 ? Math.min(100, Math.round((r.amountRepaid / r.totalRepayment) * 100)) : 100;
            const progressColor =
              pct >= 100 ? 'bg-emerald-500' : r.payStatus === 'overdue' ? 'bg-rose-500' : r.payStatus === 'due_soon' ? 'bg-amber-500' : 'bg-rose-400';

            return (
              <motion.div
                key={r.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.03 }}
              >
                <Card className="rounded-2xl border border-border/60 hover:shadow-md transition-shadow">
                  <CardContent className="p-4">
                    <div className="grid grid-cols-12 gap-4 items-center">
                      {/* Tenant */}
                      <div className="col-span-12 md:col-span-3 flex items-center gap-3 min-w-0">
                        <div className="relative">
                          <Avatar className={`h-12 w-12 ${avatarColor(r.tenant_name)}`}>
                            <AvatarImage src={r.avatar_url || undefined} />
                            <AvatarFallback className={avatarColor(r.tenant_name)}>
                              {initials(r.tenant_name)}
                            </AvatarFallback>
                          </Avatar>
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background ${status.dot}`}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold truncate">{r.tenant_name}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                            <Phone className="h-3 w-3" />
                            {r.tenant_phone}
                          </p>
                          <span className={`inline-block mt-1 px-2 py-0.5 rounded-md text-[10px] font-medium ${rel.cls}`}>
                            {rel.label}
                          </span>
                        </div>
                      </div>

                      {/* Property */}
                      <div className="col-span-6 md:col-span-2 min-w-0">
                        <div className="flex items-start gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{r.property_address}</p>
                            {r.dueDate && (
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                Lease ends:{' '}
                                {new Date(r.dueDate).toLocaleDateString('en-GB', {
                                  day: 'numeric',
                                  month: 'short',
                                  year: 'numeric',
                                })}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Balance */}
                      <div className="col-span-6 md:col-span-2">
                        <p className="text-[10px] text-muted-foreground">Balance</p>
                        <p
                          className={`font-bold ${
                            r.balance > 0 ? 'text-rose-600' : 'text-emerald-600'
                          }`}
                        >
                          {formatUGX(r.balance)}
                        </p>
                        {r.lastPayment && r.balance === 0 && (
                          <>
                            <p className="text-[10px] text-muted-foreground mt-1">Last Payment</p>
                            <p className="text-xs">
                              {new Date(r.lastPayment).toLocaleDateString('en-GB', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              })}
                            </p>
                          </>
                        )}
                        {r.dueDate && r.balance > 0 && (
                          <>
                            <p className="text-[10px] text-muted-foreground mt-1">Due Date</p>
                            <p
                              className={`text-xs font-medium ${
                                r.payStatus === 'overdue' ? 'text-rose-600' : ''
                              }`}
                            >
                              {new Date(r.dueDate).toLocaleDateString('en-GB', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              })}
                            </p>
                          </>
                        )}
                      </div>

                      {/* Progress */}
                      <div className="col-span-12 md:col-span-2">
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="font-medium">
                            {formatUGX(r.amountRepaid)} / {formatUGX(r.totalRepayment)}
                          </span>
                          <span className="font-semibold">{pct}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={`h-full ${progressColor}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p
                          className={`text-[11px] mt-1 ${
                            pct >= 100
                              ? 'text-emerald-600'
                              : r.payStatus === 'overdue'
                              ? 'text-rose-600'
                              : r.payStatus === 'due_soon'
                              ? 'text-amber-600'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {pct >= 100
                            ? 'Paid in full'
                            : r.daysDelta === null
                            ? '—'
                            : r.daysDelta < 0
                            ? `Overdue by ${Math.abs(r.daysDelta)} days`
                            : `Due in ${r.daysDelta} days`}
                        </p>
                      </div>

                      {/* Badges */}
                      <div className="col-span-6 md:col-span-1 flex flex-col gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium ${status.cls}`}
                        >
                          {r.payStatus === 'paid_up' ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : (
                            <AlertCircle className="h-3 w-3" />
                          )}
                          {status.label}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium ${risk.cls}`}
                        >
                          <Shield className="h-3 w-3" />
                          {risk.label}
                        </span>
                      </div>

                      {/* Actions */}
                      <div className="col-span-6 md:col-span-2 flex flex-col gap-1.5">
                        <Button size="sm" className="gap-1.5 h-8 rounded-lg">
                          <CreditCard className="h-3.5 w-3.5" />
                          Collect Payment
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 h-8 rounded-lg"
                          onClick={() => {
                            if (r.tenant_phone) {
                              window.open(
                                `https://wa.me/${r.tenant_phone.replace(/\D/g, '')}`,
                                '_blank',
                              );
                            }
                          }}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          Message
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 h-8 rounded-lg"
                          onClick={() => setReviewTenant(r)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                          View Details
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-2">
          <span>
            Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, filtered.length)} of{' '}
            {filtered.length} tenants
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0 rounded-lg"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              ‹
            </Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .slice(0, 5)
              .map((n) => (
                <Button
                  key={n}
                  variant={n === page ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 w-8 p-0 rounded-lg"
                  onClick={() => setPage(n)}
                >
                  {n}
                </Button>
              ))}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0 rounded-lg"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              ›
            </Button>
          </div>
        </div>
      )}

      <LandlordAddTenantDialog
        open={showAdd}
        onOpenChange={setShowAdd}
        onSuccess={fetch}
      />

      <Dialog open={!!reviewTenant} onOpenChange={(o) => !o && setReviewTenant(null)}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">
              {reviewTenant?.tenant_name || 'Tenant'} — Details
            </DialogTitle>
          </DialogHeader>
          {reviewTenant && (
            <UserReviewsSection
              userId={reviewTenant.tenant_id}
              userName={reviewTenant.tenant_name}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
