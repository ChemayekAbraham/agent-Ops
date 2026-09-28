import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ChevronRight, Radio } from 'lucide-react';

const GROUPS: Record<string, string> = {
  roi_wallet_credit: 'Supporter returns',
  roi_payout: 'Supporter returns',
  wallet_deposit: 'Deposits',
  wallet_transfer: 'Wallet transfers in',
  bucket_reclass_in: 'Float moved to withdrawable',
  agent_commission: 'Commissions',
  agent_commission_earned: 'Commissions',
  partner_commission: 'Commissions',
  proxy_investment_commission: 'Commissions',
  agent_investment_commission: 'Commissions',
  agent_advance_credit: 'Agent advances',
  system_balance_correction: 'Corrections',
};
const label = (c: string) =>
  GROUPS[c] ??
  (c.includes('bonus') ? 'Bonuses'
    : c.includes('salary') || c.includes('payroll') ? 'Salary & payroll'
    : c.includes('correction') ? 'Corrections'
    : c.includes('commission') ? 'Commissions'
    : 'Other');

type Row = { category: string; total: number; credits: number };

export function WithdrawableCreditsLivePanel() {
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['cfo-withdrawable-credits-today'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_withdrawable_credits_today');
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    refetchInterval: live ? false : 30000,
  });
  const timer = useRef<number | null>(null);
  const refetch = q.refetch;

  useEffect(() => {
    const ch = supabase
      .channel('cfo-withdrawable-credits')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'general_ledger' }, () => {
        if (timer.current) return;
        timer.current = window.setTimeout(() => { timer.current = null; refetch(); }, 5000);
      })
      .subscribe((s) => setLive(s === 'SUBSCRIBED'));
    return () => { if (timer.current) clearTimeout(timer.current); supabase.removeChannel(ch); };
  }, [refetch]);

  const grouped = new Map<string, { total: number; credits: number }>();
  (q.data ?? []).forEach((r) => {
    const k = label(r.category);
    const g = grouped.get(k) ?? { total: 0, credits: 0 };
    g.total += Number(r.total); g.credits += Number(r.credits);
    grouped.set(k, g);
  });
  const rows = [...grouped.entries()].sort((a, b) => b[1].total - a[1].total);
  const total = rows.reduce((s, [, g]) => s + g.total, 0);
  const count = rows.reduce((s, [, g]) => s + g.credits, 0);

  const breakdown = (
    <div className="divide-y rounded-md border">
      {rows.length === 0 && <p className="p-3 text-sm text-muted-foreground">{q.isLoading ? 'Loading…' : 'No credits yet today.'}</p>}
      {rows.map(([k, g]) => (
        <div key={k} className="flex items-center justify-between gap-2 p-2 text-sm">
          <span className="min-w-0 truncate">{k} <span className="text-xs text-muted-foreground">({g.credits})</span></span>
          <span className="font-medium">{formatUGX(g.total)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <Card
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
        className="cursor-pointer transition-colors hover:border-primary/40 hover:bg-muted/40"
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span>Withdrawable credits today</span>
            <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <Radio className={`h-3 w-3 ${live ? 'text-primary animate-pulse' : ''}`} />
              {live ? 'Live' : 'Auto-refresh'} · updated {q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toLocaleTimeString() : '—'}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {q.error ? <p className="text-sm text-destructive">Could not load credits.</p> : (
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-2xl font-bold">{formatUGX(total)}</p>
                <p className="text-xs text-muted-foreground">{count.toLocaleString()} credits since midnight (Kampala)</p>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                View breakdown <ChevronRight className="h-3 w-3" />
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Withdrawable credits today</DialogTitle>
            <DialogDescription>
              {formatUGX(total)} · {count.toLocaleString()} credits since midnight (Kampala)
            </DialogDescription>
          </DialogHeader>
          {q.error ? <p className="text-sm text-destructive">Could not load credits.</p> : breakdown}
        </DialogContent>
      </Dialog>
    </>
  );
}
