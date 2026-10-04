import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KPICard } from '../KPICard';
import {
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  Building2, Clock, BadgeCheck, Banknote, XCircle, Percent, MapPin, Users, Loader2, Link2,
} from 'lucide-react';
import { format, subMonths, startOfMonth, isSameMonth, differenceInHours } from 'date-fns';
import { useServiceCentres, SC_STATUS_META, SERVICE_CENTRE_BONUS, type ServiceCentreStatus } from '@/hooks/useServiceCentres';
import { ServiceCentreRequestLinkDialog } from './ServiceCentreRequestLinkDialog';

const ugx = (n: number) => `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

/** Agent Ops → Service Centres → Overview: adoption, funnel, payout exposure. */
export function ServiceCentreOverview() {
  const { data: centres, isLoading } = useServiceCentres();
  const [linkOpen, setLinkOpen] = useState(false);

  const stats = useMemo(() => {
    const rows = centres || [];
    const by = (s: ServiceCentreStatus) => rows.filter((r) => r.status === s);
    const paid = by('paid');
    const verified = by('verified');
    const approved = by('approved');
    const pending = by('pending');
    const rejected = by('rejected');
    const live = [...paid, ...approved];
    const decided = rows.length - pending.length;

    // Average hours from submission to verification.
    const verifiedRows = rows.filter((r) => r.verified_at);
    const avgVerifyHours = verifiedRows.length
      ? verifiedRows.reduce((a, r) => a + differenceInHours(new Date(r.verified_at as string), new Date(r.created_at)), 0) / verifiedRows.length
      : 0;

    // 6-month submission trend.
    const months = Array.from({ length: 6 }, (_, i) => startOfMonth(subMonths(new Date(), 5 - i)));
    const trend = months.map((m) => ({
      month: format(m, 'MMM'),
      submitted: rows.filter((r) => isSameMonth(new Date(r.created_at), m)).length,
      live: rows.filter((r) => r.verified_at && isSameMonth(new Date(r.verified_at), m)).length,
    }));

    const statusMix = (['pending', 'verified', 'approved', 'paid', 'rejected'] as ServiceCentreStatus[])
      .map((s) => ({ name: SC_STATUS_META[s].label, value: by(s).length, fill: SC_STATUS_META[s].dot }))
      .filter((d) => d.value > 0);

    // Coverage: group by the free-text location description's first token.
    const areaMap: Record<string, number> = {};
    live.forEach((r) => {
      const area = (r.location_name || '').split(/[,\-–]/)[0].trim() || 'Unlabelled';
      areaMap[area] = (areaMap[area] || 0) + 1;
    });
    const coverage = Object.entries(areaMap)
      .map(([area, count]) => ({ area: area.length > 18 ? `${area.slice(0, 18)}…` : area, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const funnel = [
      { stage: 'Submitted', count: rows.length },
      { stage: 'Verified', count: verified.length + approved.length + paid.length },
      { stage: 'Approved', count: approved.length + paid.length },
      { stage: 'Paid', count: paid.length },
    ];

    return {
      total: rows.length,
      pending: pending.length,
      verified: verified.length,
      liveCount: live.length,
      rejected: rejected.length,
      uniqueAgents: new Set(rows.map((r) => r.agent_id)).size,
      approvalRate: decided ? Math.round(((decided - rejected.length) / decided) * 100) : 0,
      paidOut: paid.length * SERVICE_CENTRE_BONUS,
      liability: verified.length * SERVICE_CENTRE_BONUS,
      avgVerifyHours: Math.round(avgVerifyHours),
      trend, statusMix, coverage, funnel,
    };
  }, [centres]);

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Send an agent the request link with the setup amount they need.
        </p>
        <Button onClick={() => setLinkOpen(true)} className="gap-2">
          <Link2 className="h-4 w-4" />
          Generate request link
        </Button>
      </div>
      <ServiceCentreRequestLinkDialog open={linkOpen} onOpenChange={setLinkOpen} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard title="Service centres" value={stats.total} icon={Building2} subtitle={`${stats.uniqueAgents} distinct agents`} />
        <KPICard title="Live centres" value={stats.liveCount} icon={BadgeCheck} color="bg-emerald-500/10 text-emerald-600" subtitle="Verified & paid setups" />
        <KPICard title="Awaiting verification" value={stats.pending} icon={Clock} color="bg-amber-500/10 text-amber-600" subtitle="Agent Ops action needed" />
        <KPICard title="Awaiting payout" value={stats.verified} icon={Banknote} color="bg-blue-500/10 text-blue-600" subtitle={`${ugx(stats.liability)} committed`} />
        <KPICard title="Bonuses paid" value={ugx(stats.paidOut)} icon={Banknote} color="bg-emerald-600/10 text-emerald-700" subtitle={`@ ${ugx(SERVICE_CENTRE_BONUS)} per centre`} />
        <KPICard title="Approval rate" value={`${stats.approvalRate}%`} icon={Percent} subtitle={`${stats.rejected} rejected`} />
        <KPICard title="Avg. verification time" value={stats.avgVerifyHours ? `${stats.avgVerifyHours}h` : '—'} icon={Clock} subtitle="Submission → verified" />
        <KPICard title="Areas covered" value={stats.coverage.length} icon={MapPin} color="bg-violet-500/10 text-violet-600" subtitle="Distinct live locations" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Setup funnel</CardTitle></CardHeader>
          <CardContent className="h-64">
            {stats.total === 0 ? <EmptyChart /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.funnel} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} fontSize={11} />
                  <YAxis type="category" dataKey="stage" width={78} fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Status mix</CardTitle></CardHeader>
          <CardContent className="h-64">
            {stats.statusMix.length === 0 ? <EmptyChart /> : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={stats.statusMix} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={2}>
                    {stats.statusMix.map((d) => <Cell key={d.name} fill={d.fill} />)}
                  </Pie>
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Submissions vs verifications (6 months)</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.trend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="submitted" name="Submitted" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.2)" />
                <Area type="monotone" dataKey="live" name="Verified" stroke="hsl(160 84% 39%)" fill="hsl(160 84% 39% / 0.2)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Coverage by area (live centres)</CardTitle></CardHeader>
          <CardContent className="h-64">
            {stats.coverage.length === 0 ? <EmptyChart /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.coverage} margin={{ left: 0, right: 12, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="area" fontSize={10} angle={-25} textAnchor="end" interval={0} height={50} />
                  <YAxis allowDecimals={false} fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="count" name="Centres" fill="hsl(262 83% 58%)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm"><Users className="h-4 w-4 text-primary" />Adoption snapshot</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3 text-sm">
          <Stat label="Agents running a centre" value={String(stats.uniqueAgents)} />
          <Stat label="Rejected submissions" value={String(stats.rejected)} icon={<XCircle className="h-3.5 w-3.5 text-destructive" />} />
          <Stat label="Outstanding payout liability" value={ugx(stats.liability)} />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground flex items-center gap-1">{icon}{label}</p>
      <p className="text-lg font-bold mt-0.5">{value}</p>
    </div>
  );
}

function EmptyChart() {
  return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No data yet</div>;
}
