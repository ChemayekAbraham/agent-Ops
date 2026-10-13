import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Smartphone, Wallet, PiggyBank, CalendarDays } from 'lucide-react';
import { toast } from 'sonner';
import DepositFlow from '@/components/payments/DepositFlow';
import { formatUGX } from '@/lib/rentCalculations';
import { smartphoneReducingSchedule } from '@/lib/smartphoneAdvance';

interface ScheduleRow {
  month_index: number; period_start: string; period_end: string;
  total_due: number; daily_deduction: number;
}
interface Journey {
  sale_id: string; item_name: string; brand?: string; model?: string;
  device_amount: number; months: number; total_repayable: number;
  outstanding: number; paid: number; daily_fixed: number;
  starts_on: string | null; grace_days?: number;
  schedule: ScheduleRow[];
  recent: { amount: number; item_name: string; created_at: string }[];
  has_portfolio: boolean;
  pledge: { mode: 'amount' | 'percent'; value: number; active: boolean } | null;
}

const kampalaToday = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

export function useSmartphoneJourney() {
  return useQuery({
    queryKey: ['my-smartphone-journey'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_my_smartphone_journey' as any);
      if (error) throw error;
      return (data as unknown as Journey) ?? null;
    },
    staleTime: 30_000,
  });
}

export function SmartphoneJourneyCard() {
  const qc = useQueryClient();
  const { data: j, isLoading } = useSmartphoneJourney();
  const [depositOpen, setDepositOpen] = useState(false);
  const [mode, setMode] = useState<'amount' | 'percent' | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  if (isLoading || !j) return null;

  let rows: ScheduleRow[] = j.schedule ?? [];
  if (!rows.length && j.months && j.device_amount) {
    rows = smartphoneReducingSchedule(j.device_amount, j.months, j.starts_on ?? undefined).rows.map((r) => ({
      month_index: r.monthIndex, period_start: r.periodStart, period_end: r.periodEnd,
      total_due: r.totalDue, daily_deduction: r.dailyDeduction,
    }));
  }
  const total = Number(j.total_repayable) || Number(j.paid) + Number(j.outstanding);
  const paid = Math.max(0, total - Number(j.outstanding));
  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
  const today = kampalaToday();
  const current = rows.find((r) => r.period_start <= today && r.period_end >= today) ?? rows[0];
  const inGrace = j.starts_on && j.starts_on > today;
  const monthly = current?.total_due ?? 0;
  const daily = current?.daily_deduction ?? j.daily_fixed ?? 0;

  const pledgeMode = mode ?? j.pledge?.mode ?? 'percent';
  const pledgeValue = value !== '' ? value : j.pledge ? String(j.pledge.value) : '';

  const savePledge = async (active: boolean) => {
    const v = Number(pledgeValue);
    if (active && (!v || v <= 0 || (pledgeMode === 'percent' && v > 100))) {
      toast.error(pledgeMode === 'percent' ? 'Enter a percentage from 1 to 100' : 'Enter an amount above 0');
      return;
    }
    setSaving(true);
    const { error } = await supabase.rpc('set_smartphone_roi_pledge' as any, {
      p_mode: pledgeMode, p_value: active ? v : (j.pledge?.value ?? 1), p_active: active,
    });
    setSaving(false);
    if (error) { toast.error('Could not save', { description: error.message }); return; }
    toast.success(active ? 'Saved. Your next monthly Returns will pay toward your phone.' : 'Turned off');
    setValue(''); setMode(null);
    qc.invalidateQueries({ queryKey: ['my-smartphone-journey'] });
  };

  return (
    <Card className="p-4 sm:p-6 space-y-5 rounded-2xl border-primary/30">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
          <Smartphone className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-lg font-bold">My phone repayment</h2>
          <p className="text-xs text-muted-foreground">{[j.brand, j.model].filter(Boolean).join(' ') || j.item_name}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Total to repay" value={formatUGX(total)} />
        <Stat label="Paid" value={formatUGX(paid)} tone="text-primary" />
        <Stat label="Still owed" value={formatUGX(Number(j.outstanding))} tone="text-destructive" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-muted p-3">
          <p className="text-xs text-muted-foreground">This month</p>
          <p className="text-xl font-bold">{formatUGX(monthly)}</p>
        </div>
        <div className="rounded-xl bg-muted p-3">
          <p className="text-xs text-muted-foreground">Every day</p>
          <p className="text-xl font-bold">{formatUGX(daily)}</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground -mt-3">
        {inGrace ? `Daily payments start on ${j.starts_on} (after your grace period). ` : ''}
        Your monthly and daily amounts go down each month.
      </p>

      <div className="flex items-center gap-4">
        <div className="h-28 w-28 shrink-0 relative">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={[{ v: paid }, { v: Math.max(0, total - paid) }]} dataKey="v" innerRadius={34} outerRadius={50} startAngle={90} endAngle={-270} stroke="none">
                <Cell fill="hsl(var(--primary))" />
                <Cell fill="hsl(var(--muted))" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <span className="absolute inset-0 flex items-center justify-center text-lg font-bold">{pct}%</span>
        </div>
        <div className="flex-1 space-y-2">
          <p className="text-sm font-semibold">Repayment progress</p>
          <Progress value={pct} className="h-3" />
          <p className="text-xs text-muted-foreground">{pct}% paid · {formatUGX(Number(j.outstanding))} to go</p>
        </div>
      </div>

      <div className="rounded-xl border p-3 space-y-2">
        <p className="text-sm font-semibold flex items-center gap-2"><Wallet className="h-4 w-4" /> Pay toward your phone</p>
        <p className="text-xs text-muted-foreground">Money you deposit is used for your daily phone payment.</p>
        <Button className="w-full" onClick={() => setDepositOpen(true)}>Deposit to my wallet</Button>
      </div>

      {j.has_portfolio && (
        <div className="rounded-xl border p-3 space-y-3">
          <p className="text-sm font-semibold flex items-center gap-2"><PiggyBank className="h-4 w-4" /> Use my monthly Returns</p>
          <p className="text-xs text-muted-foreground">
            When your monthly Returns reach your wallet, this part goes straight to your phone. We never take more than you still owe.
          </p>
          {j.pledge?.active && (
            <p className="text-sm font-medium text-primary">
              Now: {j.pledge.mode === 'percent' ? `${j.pledge.value}% of each Returns payment` : `${formatUGX(j.pledge.value)} from each Returns payment`}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant={pledgeMode === 'percent' ? 'default' : 'outline'} onClick={() => setMode('percent')}>Percentage</Button>
            <Button size="sm" variant={pledgeMode === 'amount' ? 'default' : 'outline'} onClick={() => setMode('amount')}>Fixed amount</Button>
          </div>
          <Input inputMode="numeric" placeholder={pledgeMode === 'percent' ? 'e.g. 50 (%)' : 'e.g. 100000 (UGX)'}
            value={pledgeValue} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))} />
          <div className="flex items-center gap-2">
            <Button className="flex-1" disabled={saving} onClick={() => savePledge(true)}>Save</Button>
            {j.pledge?.active && (
              <div className="flex items-center gap-2 text-xs">
                <Switch checked onCheckedChange={() => savePledge(false)} disabled={saving} /> On
              </div>
            )}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold flex items-center gap-2"><CalendarDays className="h-4 w-4" /> Month by month</p>
          <div className="rounded-xl border divide-y text-sm">
            {rows.map((r) => {
              const status = r.period_end < today ? 'Done' : r === current ? 'This month' : 'Coming';
              return (
                <div key={r.month_index} className={`flex items-center justify-between p-2 ${r === current ? 'bg-primary/5' : ''}`}>
                  <span>Month {r.month_index}</span>
                  <span className="text-right">
                    <span className="font-semibold">{formatUGX(r.total_due)}</span>
                    <span className="block text-xs text-muted-foreground">{formatUGX(r.daily_deduction)}/day · {status}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {j.recent?.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Recent payments</p>
          {j.recent.map((p, i) => (
            <div key={i} className="flex justify-between text-xs border-b py-1">
              <span>{new Date(p.created_at).toLocaleDateString()}{/Returns/.test(p.item_name) ? ' · From monthly Returns' : ''}</span>
              <span className="font-medium">{formatUGX(Number(p.amount))}</span>
            </div>
          ))}
        </div>
      )}

      <DepositFlow open={depositOpen} onOpenChange={(o) => { setDepositOpen(o); if (!o) qc.invalidateQueries({ queryKey: ['my-smartphone-journey'] }); }} />
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-muted p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold ${tone ?? ''}`}>{value}</p>
    </div>
  );
}
