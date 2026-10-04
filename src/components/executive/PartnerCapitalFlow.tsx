import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DollarSign, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, LineChart, Line, BarChart, Bar, Legend, CartesianGrid } from 'recharts';
import { format, subDays, startOfDay, startOfMonth, addMonths, isBefore } from 'date-fns';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useState } from 'react';
import { ProjectedReturnsChart, PartnerPortfolioTable, HORIZON_PRESETS, type Horizon } from './PartnerPortfolioProjections';

export function PartnerCapitalFlow() {
  const [horizon, setHorizon] = useState<Horizon>(HORIZON_PRESETS.find(p => p.days === 180)!);
  const { data } = useQuery({
    queryKey: ['partner-capital-flow'],
    queryFn: async () => {
      const [{ data: portfolios }, { data: withdrawals }, { data: roiPayments }, { data: notes }] = await Promise.all([
        supabase.from('investor_portfolios')
          .select('investment_amount, total_roi_earned, status, created_at')
          .in('status', ['active', 'matured', 'pending_approval']),
        supabase.from('investment_withdrawal_requests')
          .select('amount, status, created_at, user_id')
          .order('created_at', { ascending: false })
          .limit(500),
        supabase.from('supporter_roi_payments')
          .select('roi_amount, due_date, status')
          .order('payment_date', { ascending: false })
          .limit(500),
        supabase.from('promissory_notes')
          .select('amount, total_collected, status, next_deduction_date, created_at')
          .limit(2000),
      ]);

      const totalDeployed = (portfolios || []).filter(p => p.status === 'active').reduce((s, p) => s + (p.investment_amount || 0), 0);
      const totalROIPaid = (roiPayments || []).filter(p => p.status === 'paid').reduce((s, p) => s + (p.roi_amount || 0), 0);
      const pendingWithdrawals = (withdrawals || []).filter(w => w.status === 'pending' || w.status === 'approved').reduce((s, w) => s + (w.amount || 0), 0);
      const completedWithdrawals = (withdrawals || []).filter(w => w.status === 'completed' || w.status === 'disbursed').reduce((s, w) => s + (w.amount || 0), 0);

      // Last 14 days capital inflow trend
      const days14 = Array.from({ length: 14 }, (_, i) => {
        const day = startOfDay(subDays(new Date(), 13 - i));
        const dayStr = format(day, 'yyyy-MM-dd') as string;
        const inflow = (portfolios || [])
          .filter(p => p.created_at && format(new Date(p.created_at), 'yyyy-MM-dd') === dayStr)
          .reduce((s, p) => s + (p.investment_amount || 0), 0);
        const outflow = (withdrawals || [])
          .filter(w => w.created_at && format(new Date(w.created_at), 'yyyy-MM-dd') === dayStr)
          .reduce((s, w) => s + (w.amount || 0), 0);
        return { day: format(day, 'dd MMM'), inflow, outflow, net: inflow - outflow };
      });

      // Net direction
      const recentNet = days14.slice(-7).reduce((s, d) => s + d.net, 0);

      // Money vs Time — cumulative deployed capital vs cumulative outflow (90 days)
      const start90 = startOfDay(subDays(new Date(), 89));
      const openingIn = (portfolios || [])
        .filter(p => p.created_at && isBefore(new Date(p.created_at), start90))
        .reduce((s, p) => s + (p.investment_amount || 0), 0);
      const openingOut = (withdrawals || [])
        .filter(w => w.created_at && isBefore(new Date(w.created_at), start90))
        .reduce((s, w) => s + (w.amount || 0), 0);
      let cumIn = openingIn;
      let cumOut = openingOut;
      const moneyVsTime = Array.from({ length: 90 }, (_, i) => {
        const day = startOfDay(subDays(new Date(), 89 - i));
        const dayStr = format(day, 'yyyy-MM-dd');
        cumIn += (portfolios || [])
          .filter(p => p.created_at && format(new Date(p.created_at), 'yyyy-MM-dd') === dayStr)
          .reduce((s, p) => s + (p.investment_amount || 0), 0);
        cumOut += (withdrawals || [])
          .filter(w => w.created_at && format(new Date(w.created_at), 'yyyy-MM-dd') === dayStr)
          .reduce((s, w) => s + (w.amount || 0), 0);
        return { day: format(day, 'dd MMM'), capitalIn: cumIn, capitalOut: cumOut, netCapital: cumIn - cumOut };
      });

      // Promissory notes expected — outstanding commitments by expected collection month
      const outstanding = (n: any) => Math.max(0, (n.amount || 0) - (n.total_collected || 0));
      const activeNotes = (notes || []).filter(n => ['activated', 'pending', 'approved'].includes(String(n.status)));
      const months = Array.from({ length: 6 }, (_, i) => startOfMonth(addMonths(new Date(), i)));
      const promissoryExpected = months.map((m, idx) => {
        const key = format(m, 'yyyy-MM');
        const inMonth = (d: string | null) => d && format(new Date(d), 'yyyy-MM') === key;
        const activated = activeNotes.filter(n => n.status === 'activated' && inMonth(n.next_deduction_date)).reduce((s, n) => s + outstanding(n), 0);
        const pending = activeNotes.filter(n => n.status !== 'activated' && inMonth(n.next_deduction_date)).reduce((s, n) => s + outstanding(n), 0);
        // Unscheduled notes (no next deduction date) surface in the first bucket
        const unscheduled = idx === 0
          ? activeNotes.filter(n => !n.next_deduction_date).reduce((s, n) => s + outstanding(n), 0)
          : 0;
        return { month: format(m, 'MMM yy'), activated, pending: pending + unscheduled };
      });
      const promissoryTotalExpected = activeNotes.reduce((s, n) => s + outstanding(n), 0);
      const promissoryCollected = activeNotes.reduce((s, n) => s + (n.total_collected || 0), 0);

      return {
        totalDeployed, totalROIPaid, pendingWithdrawals, completedWithdrawals,
        trend: days14, netDirection: recentNet >= 0 ? 'positive' : 'negative', recentNet,
        moneyVsTime, promissoryExpected, promissoryTotalExpected, promissoryCollected,
        promissoryCount: activeNotes.length,
      };
    },
    staleTime: 600000,
  });

  const fmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toLocaleString();

  if (!data) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-primary" />
          Capital Flow
          <Badge variant="outline" className={`ml-auto text-[10px] ${data.netDirection === 'positive' ? 'text-green-600 border-green-300' : 'text-red-600 border-red-300'}`}>
            {data.netDirection === 'positive' ? <ArrowUpRight className="h-3 w-3 mr-0.5" /> : <ArrowDownRight className="h-3 w-3 mr-0.5" />}
            7d Net: {fmt(Math.abs(data.recentNet))}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs defaultValue="position">
          <TabsList className="grid w-full grid-cols-4 h-8">
            <TabsTrigger value="position" className="text-[10px]">Position</TabsTrigger>
            <TabsTrigger value="flow" className="text-[10px]">Flow</TabsTrigger>
            <TabsTrigger value="forward" className="text-[10px]">Forward</TabsTrigger>
            <TabsTrigger value="partners" className="text-[10px]">Partners</TabsTrigger>
          </TabsList>

          <TabsContent value="position" className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-green-500/10 p-2.5">
            <p className="text-[10px] text-muted-foreground">Deployed Capital</p>
            <p className="text-lg font-bold text-green-600">{fmt(data.totalDeployed)}</p>
          </div>
          <div className="rounded-lg bg-blue-500/10 p-2.5">
            <p className="text-[10px] text-muted-foreground">Total ROI Paid</p>
            <p className="text-lg font-bold text-blue-600">{fmt(data.totalROIPaid)}</p>
          </div>
          <div className="rounded-lg bg-amber-500/10 p-2.5">
            <p className="text-[10px] text-muted-foreground">Pending Withdrawals</p>
            <p className="text-lg font-bold text-amber-600">{fmt(data.pendingWithdrawals)}</p>
          </div>
          <div className="rounded-lg bg-muted p-2.5">
            <p className="text-[10px] text-muted-foreground">Completed Exits</p>
            <p className="text-lg font-bold text-foreground">{fmt(data.completedWithdrawals)}</p>
          </div>
        </div>
          </TabsContent>

          <TabsContent value="flow" className="mt-3 space-y-3">
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">14-Day Capital Movement</p>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={data.trend}>
              <XAxis dataKey="day" tick={{ fontSize: 9 }} />
              <YAxis hide />
              <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => fmt(v)} />
              <Area type="monotone" dataKey="inflow" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.15)" strokeWidth={1.5} />
              <Area type="monotone" dataKey="outflow" stroke="hsl(0 84% 60%)" fill="hsl(0 84% 60% / 0.1)" strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 text-[9px] text-muted-foreground mt-1">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-primary" />Inflow</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />Outflow</span>
          </div>
        </div>

        <div className="border-t pt-3">
          <p className="text-[10px] text-muted-foreground mb-1">Money vs Time — Cumulative Capital (90 days, UGX)</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={data.moneyVsTime}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="day" tick={{ fontSize: 9 }} interval={14} />
              <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => fmt(v)} width={38} />
              <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => `UGX ${fmt(v)}`} />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              <Line type="monotone" dataKey="capitalIn" name="Capital In" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="capitalOut" name="Capital Out" stroke="hsl(0 84% 60%)" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="netCapital" name="Net Capital" stroke="hsl(142 71% 45%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
          </TabsContent>

          <TabsContent value="forward" className="mt-3 space-y-4">
        <ProjectedReturnsChart horizon={horizon} onHorizonChange={setHorizon} />

        <div className="border-t pt-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] text-muted-foreground">Promissory Notes Expected (next 6 months, UGX)</p>
            <Badge variant="outline" className="text-[9px]">
              {data.promissoryCount} notes · {fmt(data.promissoryTotalExpected)} expected
            </Badge>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={data.promissoryExpected}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="month" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => fmt(v)} width={38} />
              <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => `UGX ${fmt(v)}`} />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              <Bar dataKey="activated" name="Activated" stackId="p" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} />
              <Bar dataKey="pending" name="Awaiting Activation" stackId="p" fill="hsl(38 92% 50%)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-[9px] text-muted-foreground mt-1">
            Collected to date: UGX {fmt(data.promissoryCollected)}
          </p>
        </div>
          </TabsContent>

          <TabsContent value="partners" className="mt-3">
            <PartnerPortfolioTable horizon={horizon} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
