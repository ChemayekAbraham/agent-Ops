import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ArrowLeft, TrendingUp, AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX, getRiskLevel, calculateCompoundProjection, calculateRegistrationFee, MONTHLY_RATE, calculateAccessFeeSimple } from '@/lib/agentAdvanceCalculations';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { useState } from 'react';
import CFOAdvanceTopupDialog from '@/components/cfo/CFOAdvanceTopupDialog';

export default function AgentAdvanceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [topupOpen, setTopupOpen] = useState(false);

  const { data: advance, isLoading, refetch } = useQuery({
    queryKey: ['agent-advance', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('*, profiles!agent_advances_agent_id_fkey(full_name, phone)')
        .eq('id', id!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  const { data: ledger = [] } = useQuery({
    queryKey: ['agent-advance-ledger', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_ledger')
        .select('*')
        .eq('advance_id', id!)
        .order('date', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!id,
  });

  const { data: topups = [], refetch: refetchTopups } = useQuery({
    queryKey: ['agent-advance-topups', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_topups')
        .select('*, profiles!agent_advance_topups_topped_up_by_fkey(full_name)')
        .eq('advance_id', id!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!id,
  });

  if (isLoading) return <div className="min-h-screen bg-background flex items-center justify-center text-muted-foreground">Loading...</div>;
  if (!advance) return <div className="min-h-screen bg-background flex items-center justify-center text-muted-foreground">Advance not found</div>;

  const risk = getRiskLevel(advance);
  const principal = Number(advance.principal);
  const rate = advance.monthly_rate != null ? Number(advance.monthly_rate) : MONTHLY_RATE;
  const regFee = Number(advance.registration_fee) || calculateRegistrationFee(principal);
  const accessFee = advance.access_fee != null ? Number(advance.access_fee) : calculateAccessFeeSimple(principal, advance.cycle_days, rate);
  const totalPayable = principal + accessFee + regFee;
  const dailyPmt = Number(advance.daily_installment) || Number(advance.installment_amount) || Math.ceil(totalPayable / advance.cycle_days);
  const projection = calculateCompoundProjection(principal, advance.cycle_days, rate);

  // Chart data from ledger or projection
  const chartData = ledger.length > 0
    ? ledger.map((l: any) => ({ date: l.date, balance: Number(l.closing_balance) }))
    : projection.map((p) => ({ date: `Day ${p.day}`, balance: p.closingBalance }));

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/agent-advances')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-bold">{advance.profiles?.full_name || 'Agent'}</h1>
            <p className="text-xs text-muted-foreground">{advance.profiles?.phone}</p>
          </div>
          <div className={`h-4 w-4 rounded-full ${risk === 'green' ? 'bg-green-500' : risk === 'yellow' ? 'bg-amber-500' : 'bg-red-500'}`} />
          <Badge variant={advance.status === 'active' ? 'default' : advance.status === 'completed' ? 'secondary' : 'destructive'}>
            {advance.status}
          </Badge>
          {advance.status === 'active' && (
            <Button size="sm" variant="outline" onClick={() => setTopupOpen(true)} className="gap-1">
              <Plus className="h-3 w-3" /> Top-Up
            </Button>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-4 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card><CardContent className="p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-1">Principal</p>
            <p className="text-xl font-black">{formatUGX(advance.principal)}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-1">Access Fee</p>
            <p className="text-xl font-black text-amber-600">{formatUGX(accessFee)}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-1">Reg. Fee</p>
            <p className="text-xl font-black text-purple-600">{formatUGX(regFee)}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-1">Total Payable</p>
            <p className="text-xl font-black text-red-600">{formatUGX(totalPayable)}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-1">Outstanding</p>
            <p className="text-xl font-black text-amber-600">{formatUGX(advance.outstanding_balance)}</p>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-1">Daily Payment</p>
            <p className="text-xl font-black text-green-600">{formatUGX(dailyPmt)}</p>
          </CardContent></Card>
        </div>

        {/* Balance Trend Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Balance Trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-[10px]" tick={{ fontSize: 10 }} />
                <YAxis className="text-[10px]" tick={{ fontSize: 10 }} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v: number) => formatUGX(v)} />
                <Area type="monotone" dataKey="balance" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.1)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Daily Ledger */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Daily Repayment Ledger</CardTitle>
          </CardHeader>
          <CardContent>
            {ledger.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No ledger entries yet. Entries are created daily by the deduction engine.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground text-xs uppercase tracking-wider">
                      <th className="pb-2 pr-3">Date</th>
                      <th className="pb-2 pr-3">Opening</th>
                      <th className="pb-2 pr-3">Interest</th>
                      <th className="pb-2 pr-3">Deducted</th>
                      <th className="pb-2 pr-3">Closing</th>
                      <th className="pb-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((entry: any) => (
                      <tr key={entry.id} className="border-b border-border/30">
                        <td className="py-2 pr-3 text-muted-foreground">{entry.date}</td>
                        <td className="py-2 pr-3">{formatUGX(entry.opening_balance)}</td>
                        <td className="py-2 pr-3 text-amber-600">+{formatUGX(entry.interest_accrued)}</td>
                        <td className="py-2 pr-3 text-green-600">-{formatUGX(entry.amount_deducted)}</td>
                        <td className="py-2 pr-3 font-semibold">{formatUGX(entry.closing_balance)}</td>
                        <td className="py-2">
                          <Badge variant={entry.deduction_status === 'full' ? 'secondary' : entry.deduction_status === 'partial' ? 'outline' : 'destructive'} className="text-[10px]">
                            {entry.deduction_status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top-Up History */}
        {topups.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Top-Up History</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {topups.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                    <div className="pr-3">
                      <p className="font-medium">{formatUGX(t.amount)}</p>
                      <p className="text-xs text-muted-foreground">By {t.profiles?.full_name || 'Manager'}</p>
                      {t.reason && <p className="text-xs text-muted-foreground mt-0.5 italic">"{t.reason}"</p>}
                    </div>
                    <p className="text-xs text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Compound Projection */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              {advance.cycle_days}-Day Compound Projection ({Math.round(rate * 100)}%/month)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-muted-foreground uppercase tracking-wider">
                    <th className="pb-2 pr-2">Day</th>
                    <th className="pb-2 pr-2">Opening</th>
                    <th className="pb-2 pr-2">Interest</th>
                    <th className="pb-2">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {projection.map((p) => (
                    <tr key={p.day} className="border-b border-border/20">
                      <td className="py-1 pr-2">{p.day}</td>
                      <td className="py-1 pr-2">{formatUGX(p.openingBalance)}</td>
                      <td className="py-1 pr-2 text-amber-600">+{formatUGX(p.interestAccrued)}</td>
                      <td className="py-1 font-semibold">{formatUGX(p.closingBalance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <CFOAdvanceTopupDialog
        open={topupOpen}
        onOpenChange={setTopupOpen}
        advance={advance}
        onSuccess={() => { refetch(); refetchTopups(); }}
      />
    </div>
  );
}
