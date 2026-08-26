import { useMemo } from 'react';
import { format, subDays } from 'date-fns';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import {
  Home,
  Building2,
  ShieldCheck,
  Banknote,
  DoorOpen,
  UserCheck,
  UserX,
  MapPin,
  Users,
  GitBranch,
  ChevronRight,
  TrendingUp,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { HubEntryCard } from '@/components/ops/HubEntryCard';
import { KPICard } from '../KPICard';
import { useLandlordOpsTotals } from '@/hooks/useLandlordOps';
import { useLandlordFundedStats } from '@/hooks/useLandlordFundedStats';
import { useLandlordOpsBadgeCounts } from '@/hooks/useLandlordOpsBadgeCounts';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import type { LandlordOpsViewKey } from './landlordOpsNav';

/**
 * Landing page for Landlord Ops → Classic.
 *
 * Read-only. Every figure comes from the queries Classic already runs
 * (`landlord-ops` totals action, `ops_landlord_funded_stats`, and the shared
 * backlog counters) and opens the existing view behind it. No new logic, no new
 * backend.
 */
export function LandlordOpsHome({ onNavigate }: { onNavigate: (view: LandlordOpsViewKey) => void }) {
  const { data: totalsData, isLoading: totalsLoading } = useLandlordOpsTotals();
  const totals = totalsData?.totals;
  const { pendingHouses, pendingLandlords, paidLandlords, isLoading: countsLoading } =
    useLandlordOpsBadgeCounts();

  // Last 14 days of funded landlords — same RPC the "Landlords Funded" tab uses.
  const dateFrom = useMemo(() => format(subDays(new Date(), 13), 'yyyy-MM-dd'), []);
  const dateTo = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);
  const { data: funded, isFetching: fundedLoading } = useLandlordFundedStats({ dateFrom, dateTo });

  const verified = totals?.verified ?? 0;
  const total = totals?.total ?? 0;
  const verifiedPct = total > 0 ? Math.min(100, Math.round((verified / total) * 100)) : 0;

  const trend = useMemo(
    () =>
      (funded?.daily ?? []).map((d) => ({
        day: format(new Date(d.day), 'd MMM'),
        landlords: d.landlords_funded,
        amount: d.total_funded,
      })),
    [funded],
  );

  const districts = useMemo(
    () =>
      (funded?.by_district ?? [])
        .slice(0, 6)
        .map((d) => ({ district: d.district || 'Unknown', landlords: d.landlords_funded })),
    [funded],
  );

  const stats: {
    label: string;
    value: string;
    hint: string;
    icon: typeof Home;
    view: LandlordOpsViewKey;
    tone: string;
  }[] = [
    {
      label: 'Landlords',
      value: total.toLocaleString('en-US'),
      hint: `${verified.toLocaleString('en-US')} verified · ${(totals?.pending ?? 0).toLocaleString('en-US')} pending`,
      icon: Building2,
      view: 'landlords',
      tone: 'bg-primary/10 text-primary',
    },
    {
      label: 'With tenants',
      value: (totals?.has_tenants ?? 0).toLocaleString('en-US'),
      hint: `${formatUGX(totals?.occupied_monthly_revenue ?? 0)}/mo`,
      icon: UserCheck,
      view: 'occupied',
      tone: 'bg-success/10 text-success',
    },
    {
      label: 'Without tenants',
      value: (totals?.no_tenants ?? 0).toLocaleString('en-US'),
      hint: `${formatUGX(totals?.empty_monthly_revenue ?? 0)}/mo not earning`,
      icon: DoorOpen,
      view: 'empty',
      tone: 'bg-destructive/10 text-destructive',
    },
    {
      label: 'Landlords paid',
      value: paidLandlords.toLocaleString('en-US'),
      hint: 'disbursements from tenant rent',
      icon: Banknote,
      view: 'landlords-paid',
      tone: 'bg-success/10 text-success',
    },
  ];

  const attention: {
    label: string;
    description: string;
    value: number;
    view: LandlordOpsViewKey;
    tone: string;
  }[] = [
    {
      label: 'Houses awaiting verification',
      description: 'Newly listed houses pending your review',
      value: pendingHouses,
      view: 'verify',
      tone: 'text-warning',
    },
    {
      label: 'Landlords awaiting verification',
      description: 'Registered landlords with an open verification request',
      value: pendingLandlords,
      view: 'landlords',
      tone: 'text-warning',
    },
    {
      label: 'Landlords not yet verified',
      description: `${totals?.rejected ?? 0} rejected · ${totals?.resubmitted ?? 0} resubmitted`,
      value: totals?.pending ?? 0,
      view: 'residence-verify',
      tone: 'text-muted-foreground',
    },
    {
      label: 'Houses with no landlord',
      description: 'Tenants to contact so their property gets listed',
      value: totals?.no_tenants ?? 0,
      view: 'no-landlord',
      tone: 'text-destructive',
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-bold tracking-tight">Landlord Operations</h2>
        <p className="text-xs text-muted-foreground">
          Live position across verification, houses and landlord payouts. Every figure below opens the
          tool behind it.
        </p>
      </div>

      {/* Awaiting verification hero + verified coverage */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <div className="rounded-xl bg-primary/15 p-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
              </div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Awaiting your verification
              </p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onNavigate('verify')}
                className="rounded-xl border bg-background p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
              >
                <div className="flex items-center gap-1.5">
                  <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Houses
                  </span>
                </div>
                <p className="mt-1 text-2xl font-bold leading-none tabular-nums">
                  {countsLoading ? '—' : pendingHouses.toLocaleString('en-US')}
                </p>
                <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                  {formatUGX(pendingHouses * 2000)} in bonuses
                </p>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('landlords')}
                className="rounded-xl border bg-background p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
              >
                <div className="flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Landlords
                  </span>
                </div>
                <p className="mt-1 text-2xl font-bold leading-none tabular-nums">
                  {countsLoading ? '—' : pendingLandlords.toLocaleString('en-US')}
                </p>
                <p className="mt-1 text-[10px] leading-snug text-muted-foreground">pending review</p>
              </button>
            </div>
            <div className="mt-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Verified landlords</span>
                <span className="font-semibold tabular-nums">{verifiedPct}%</span>
              </div>
              <Progress value={verifiedPct} className="mt-1.5 h-1.5" />
            </div>
          </CardContent>
        </Card>

        {/* KPI tiles */}
        <div className="grid grid-cols-2 gap-3 lg:col-span-2">
          {stats.map((s) => (
            <KPICard
              key={s.label}
              title={s.label}
              value={totalsLoading ? '—' : s.value}
              subtitle={s.hint}
              icon={s.icon}
              color={s.tone}
              loading={totalsLoading}
              onClick={() => onNavigate(s.view)}
            />
          ))}
        </div>
      </div>

      {/* Funded trend + district mix */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="h-4 w-4 text-primary" />
              Landlords funded · last 14 days
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            {fundedLoading && trend.length === 0 ? (
              <div className="h-48 animate-pulse rounded-lg bg-muted" />
            ) : trend.length === 0 ? (
              <p className="py-12 text-center text-xs text-muted-foreground">
                No landlords funded in this window
              </p>
            ) : (
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="landlordFundedFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                      formatter={(value: number, name) =>
                        name === 'amount' ? [formatUGX(value), 'Funded'] : [value, 'Landlords']
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="landlords"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      fill="url(#landlordFundedFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Landlords</p>
                <p className="text-sm font-bold tabular-nums">{funded?.summary?.landlords_funded ?? 0}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Funded</p>
                <p className="text-sm font-bold tabular-nums break-normal">{formatUGX(funded?.summary?.total_funded ?? 0)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Districts</p>
                <p className="text-sm font-bold tabular-nums">{funded?.summary?.districts_covered ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-primary" />
              Top districts funded
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            {districts.length === 0 ? (
              <p className="py-12 text-center text-xs text-muted-foreground">No district activity yet</p>
            ) : (
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={districts} layout="vertical" margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} stroke="hsl(var(--muted-foreground))" />
                    <YAxis
                      type="category"
                      dataKey="district"
                      width={78}
                      tick={{ fontSize: 10 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                    />
                    <Bar dataKey="landlords" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Needs attention */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Needs attention</CardTitle>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {attention.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => onNavigate(a.view)}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 sm:gap-3 sm:px-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold leading-snug break-words">{a.label}</p>
                <p className="text-[11px] leading-snug text-muted-foreground break-words line-clamp-2">
                  {a.description}
                </p>
              </div>
              <span className={cn('shrink-0 text-base font-bold tabular-nums', a.tone)}>
                {a.value.toLocaleString('en-US')}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </CardContent>
      </Card>

      {/* Quick actions */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HubEntryCard
          title="Verification Queue"
          description="Verify newly listed houses from the field"
          icon={ShieldCheck}
          onClick={() => onNavigate('verify')}
        />
        <HubEntryCard
          title="Rent Pipeline"
          description="Requests awaiting the Landlord Ops stage"
          icon={GitBranch}
          onClick={() => onNavigate('rent-pipeline-queue')}
        />
        <HubEntryCard
          title="Landlord Payout Review"
          description="Review landlord payouts before they are sent"
          icon={Banknote}
          onClick={() => onNavigate('payout-review')}
        />
        <HubEntryCard
          title="Houses by Landlord"
          description="Bind, swap or remove tenants and reassign agents"
          icon={Users}
          onClick={() => onNavigate('houses-by-landlord')}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onNavigate('no-landlord')}
          className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
        >
          <UserX className="h-3.5 w-3.5" /> No landlord listed
        </button>
        <button
          type="button"
          onClick={() => onNavigate('locations')}
          className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
        >
          <MapPin className="h-3.5 w-3.5" /> Browse locations
        </button>
        <button
          type="button"
          onClick={() => onNavigate('reports')}
          className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
        >
          <Banknote className="h-3.5 w-3.5" /> Reports &amp; exports
        </button>
      </div>
    </div>
  );
}
