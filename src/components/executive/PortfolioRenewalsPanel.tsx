import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { RefreshCw, RotateCcw, Bot, User, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

type Row = {
  id: string;
  portfolio_id: string;
  reason: string;
  source: string | null;
  is_auto: boolean;
  created_at: string;
  old_maturity_date: string | null;
  new_maturity_date: string | null;
  old_status: string | null;
  new_duration_months: number;
  old_total_roi_earned: number;
  reversed_at: string | null;
  reversal_reason: string | null;
  portfolio?: { portfolio_code: string; account_name: string; investment_amount: number; status: string } | null;
};

const fmtUGX = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

export function PortfolioRenewalsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'active' | 'reversed'>('all');
  const [target, setTarget] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ['portfolio-renewals-log'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('portfolio_renewals')
        .select('id, portfolio_id, reason, source, is_auto, created_at, old_maturity_date, new_maturity_date, old_status, new_duration_months, old_total_roi_earned, reversed_at, reversal_reason')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;

      const ids = Array.from(new Set((data || []).map((r: any) => r.portfolio_id)));
      const { data: ports } = await supabase
        .from('investor_portfolios')
        .select('id, portfolio_code, account_name, investment_amount, status')
        .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
      const map = new Map((ports || []).map((p: any) => [p.id, p]));
      return (data || []).map((r: any) => ({ ...r, portfolio: map.get(r.portfolio_id) || null })) as Row[];
    },
    staleTime: 15000,
  });

  const visible = rows.filter(r =>
    filter === 'all' ? true : filter === 'reversed' ? !!r.reversed_at : !r.reversed_at);

  const runAutoRenew = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.rpc('auto_renew_due_portfolios', { p_limit: 500 });
      if (error) throw error;
      const res: any = data;
      toast({
        title: 'Auto-renewal run complete',
        description: `${res?.renewed ?? 0} renewed · ${res?.skipped ?? 0} already done today · ${res?.failed ?? 0} failed`,
      });
      queryClient.invalidateQueries({ queryKey: ['exec-partner-portfolios'] });
      refetch();
    } catch (e: any) {
      toast({ title: 'Auto-renewal failed', description: e.message, variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  };

  const doReverse = async () => {
    if (!target) return;
    if (reason.trim().length < 10) {
      toast({ title: 'Reason too short', description: 'Give at least 10 characters explaining the reversal.', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc('reverse_portfolio_renewal', {
        p_renewal_id: target.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      toast({ title: 'Renewal reversed', description: 'Portfolio restored to its state before the renewal.' });
      setTarget(null);
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['exec-partner-portfolios'] });
      refetch();
    } catch (e: any) {
      const msg = String(e.message || '');
      const friendly =
        msg.includes('not_latest_renewal') ? 'A newer renewal exists for this portfolio. Reverse that one first.'
        : msg.includes('already_reversed') ? 'This renewal has already been reversed.'
        : msg.includes('not_authorized') ? 'Your role cannot reverse renewals.'
        : msg;
      toast({ title: "Couldn't reverse", description: friendly, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          {(['all', 'active', 'reversed'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium capitalize transition-colors',
                filter === f ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
              )}
            >
              {f === 'active' ? 'In effect' : f}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" className="gap-1.5 text-xs" disabled={running} onClick={runAutoRenew}>
            <Bot className="h-3.5 w-3.5" /> {running ? 'Running…' : 'Run auto-renewal now'}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading renewals…</p>
      ) : visible.length === 0 ? (
        <Card><CardContent className="p-6 text-center text-xs text-muted-foreground">No renewals recorded yet.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {visible.map(r => (
            <Card key={r.id} className={cn(r.reversed_at && 'opacity-70 border-destructive/30')}>
              <CardContent className="p-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold truncate">
                      {r.portfolio?.account_name || 'Portfolio'}{' '}
                      <span className="text-muted-foreground font-normal">{r.portfolio?.portfolio_code || ''}</span>
                    </p>
                    <Badge variant={r.is_auto ? 'default' : 'secondary'} className="text-[10px] gap-1">
                      {r.is_auto ? <><Bot className="h-3 w-3" /> Automatic</> : <><User className="h-3 w-3" /> Manual</>}
                    </Badge>
                    {r.reversed_at && <Badge variant="destructive" className="text-[10px]">Reversed</Badge>}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {r.old_maturity_date || '—'} → <span className="font-medium text-foreground">{r.new_maturity_date || '—'}</span>
                    {' '}· {r.new_duration_months} months · was {r.old_status || 'unknown'}
                    {r.portfolio ? ` · ${fmtUGX(r.portfolio.investment_amount)}` : ''}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{r.reason}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {format(new Date(r.created_at), 'dd MMM yyyy HH:mm')}
                    {r.reversed_at && ` · reversed ${format(new Date(r.reversed_at), 'dd MMM yyyy HH:mm')} — ${r.reversal_reason}`}
                  </p>
                </div>
                {!r.reversed_at && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs shrink-0"
                    onClick={() => { setTarget(r); setReason(''); }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Reverse
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!target} onOpenChange={(v) => { if (!v) { setTarget(null); setReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Reverse this renewal</DialogTitle>
            <DialogDescription>
              The portfolio goes back to exactly what it was before: previous start date, maturity date,
              next payout date, duration, returns earned and status. The log entry stays, marked reversed.
            </DialogDescription>
          </DialogHeader>
          {target && (
            <div className="rounded-lg bg-muted/40 p-3 text-xs space-y-1">
              <p><span className="text-muted-foreground">Portfolio:</span> {target.portfolio?.account_name} {target.portfolio?.portfolio_code}</p>
              <p><span className="text-muted-foreground">Maturity will return to:</span> {target.old_maturity_date || '—'}</p>
              <p><span className="text-muted-foreground">Status will return to:</span> {target.old_status || 'matured'}</p>
              <p><span className="text-muted-foreground">Returns earned restored to:</span> {fmtUGX(target.old_total_roi_earned)}</p>
            </div>
          )}
          <Textarea
            placeholder="Reason for reversing (minimum 10 characters)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={doReverse} disabled={busy || reason.trim().length < 10}>
              {busy ? 'Reversing…' : 'Reverse renewal'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
