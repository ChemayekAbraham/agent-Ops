import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { CommitmentLines } from './pending-vetting/CommitmentLines';
import {
  Check, X, RefreshCw, ShieldCheck, Clock, Users, Wallet,
  ChevronDown, ChevronUp, Search,
} from 'lucide-react';

interface PendingRow {
  pending_id: string;
  portfolio_id: string;
  portfolio_code: string;
  funder_id: string;
  funder_name: string | null;
  funder_email: string | null;
  funder_phone: string | null;
  amount: number;
  source: string;
  term_months: number;
  lines_count: number;
  created_at: string;
  waiting_days: number;
}

function KpiTile({
  icon, label, value, tone = 'default',
}: { icon: React.ReactNode; label: string; value: string; tone?: 'default' | 'warn' }) {
  return (
    <Card className="border-border/60">
      <CardContent className="p-3.5 flex items-center gap-3">
        <div
          className={
            'h-9 w-9 shrink-0 rounded-full flex items-center justify-center ' +
            (tone === 'warn' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary')
          }
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-base font-black text-foreground tabular-nums truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// Tenant/house detail for a self-support commitment comes from the shared
// component so both vetting surfaces render the same dynamic lines.


export function PendingPortfoliosQueue() {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectRow, setRejectRow] = useState<PendingRow | null>(null);
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['partner-ops-pending-portfolios'],
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_pending_portfolios' as any);
      if (error) throw error;
      return ((data as any[]) || []) as PendingRow[];
    },
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = data || [];
    if (!q) return all;
    return all.filter(r =>
      [r.funder_name, r.funder_email, r.funder_phone, r.portfolio_code]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(q))
    );
  }, [data, search]);

  const totals = useMemo(() => {
    const all = data || [];
    return {
      count: all.length,
      amount: all.reduce((s, r) => s + (Number(r.amount) || 0), 0),
      tenants: all.reduce((s, r) => s + (Number(r.lines_count) || 0), 0),
      stale: all.filter(r => r.waiting_days > 2).length,
    };
  }, [data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['partner-ops-pending-portfolios'] });
    qc.invalidateQueries({ queryKey: ['partner-ops-pending-portfolio-summary'] });
    qc.invalidateQueries({ queryKey: ['invited-portfolios'] });
  };

  const approve = async (row: PendingRow) => {
    setBusyId(row.pending_id);
    // Route through the edge function so the confirmation email is dispatched
    // (self-managed portfolios get the dedicated deployment template).
    const { data: res, error } = await invokeEdgeFunction('approve-pending-portfolio', {
      silent: true,
      body: { portfolio_id: row.portfolio_id },
    });
    setBusyId(null);
    if (error || (res as any)?.error) {
      toast.error((res as any)?.error || error?.message || 'Approval failed');
      return;
    }
    toast.success(`Portfolio ${row.portfolio_code} verified and funded`);
    invalidate();
  };

  const reject = async () => {
    if (!rejectRow) return;
    if (reason.trim().length < 10) { toast.error('Give a reason of at least 10 characters'); return; }
    setBusyId(rejectRow.pending_id);
    const { error } = await supabase.rpc('reject_pending_portfolio' as any, {
      p_portfolio_id: rejectRow.portfolio_id,
      p_reason: reason.trim(),
    });
    setBusyId(null);
    if (error) { toast.error(error.message); return; }
    toast.success('Portfolio rejected and capital released');
    setRejectRow(null);
    setReason('');
    invalidate();
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-black text-foreground">Pending portfolios</h3>
            <p className="text-xs text-muted-foreground">
              Vet every portfolio a partner created — including partners supporting tenants directly — before their capital is deployed.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5" disabled={isFetching}>
          <RefreshCw className={'h-3.5 w-3.5' + (isFetching ? ' animate-spin' : '')} /> Refresh
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={<Clock className="h-4 w-4" />} label="Awaiting vetting" value={String(totals.count)} />
        <KpiTile icon={<Wallet className="h-4 w-4" />} label="Capital held" value={formatUGX(totals.amount)} />
        <KpiTile icon={<Users className="h-4 w-4" />} label="Tenants covered" value={String(totals.tenants)} />
        <KpiTile
          icon={<Clock className="h-4 w-4" />}
          label="Waiting over 2 days"
          value={String(totals.stale)}
          tone={totals.stale > 0 ? 'warn' : 'default'}
        />
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search partner name, phone, email or portfolio code"
          className="pl-9 h-9 text-sm"
        />
      </div>

      {isError && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-semibold text-destructive">
            Pending queue failed to load: {(error as Error).message}
          </p>
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading pending portfolios…</p>}

      {!isLoading && !isError && rows.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center space-y-1">
            <ShieldCheck className="h-6 w-6 mx-auto text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">Nothing to vet</p>
            <p className="text-xs text-muted-foreground">New partner portfolios will land here for verification.</p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map(row => {
          const isSelf = row.source === 'self_managed';
          const open = expanded === row.pending_id;
          const busy = busyId === row.pending_id;
          return (
            <Card key={row.pending_id} className="border-border/60 overflow-hidden">
              <div className={'h-1 w-full ' + (row.waiting_days > 2 ? 'bg-destructive/70' : 'bg-primary/60')} />
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground truncate">
                      {row.funder_name || row.funder_email || 'Partner'}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {row.portfolio_code} · {row.funder_phone || row.funder_email || '—'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-base font-black text-foreground tabular-nums">{formatUGX(Number(row.amount))}</p>
                    <p className="text-[10px] text-muted-foreground">{row.term_months} month term</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="text-[10px]">
                    {isSelf ? 'Supporting tenants directly' : 'Rent pool'}
                  </Badge>
                  {isSelf && (
                    <Badge variant="outline" className="text-[10px]">
                      {row.lines_count} tenant{row.lines_count === 1 ? '' : 's'}
                    </Badge>
                  )}
                  <Badge variant={row.waiting_days > 2 ? 'destructive' : 'outline'} className="text-[10px]">
                    Waiting {row.waiting_days}d
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    Created {new Date(row.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </span>
                </div>

                {isSelf && (
                  <div className="space-y-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 gap-1 text-xs"
                      onClick={() => setExpanded(open ? null : row.pending_id)}
                    >
                      {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {open ? 'Hide detail' : 'Review what this partner is supporting'}
                    </Button>
                    {open && <CommitmentLines portfolioId={row.portfolio_id} />}
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button size="sm" className="flex-1 gap-1.5" disabled={busy} onClick={() => approve(row)}>
                    <Check className="h-3.5 w-3.5" /> {busy ? 'Working…' : 'Verify & fund'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1.5 text-destructive border-destructive/40 hover:bg-destructive/10"
                    disabled={busy}
                    onClick={() => { setRejectRow(row); setReason(''); }}
                  >
                    <X className="h-3.5 w-3.5" /> Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={!!rejectRow} onOpenChange={(o) => { if (!o) { setRejectRow(null); setReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this portfolio</DialogTitle>
            <DialogDescription>
              The portfolio is cancelled, any reserved rent plans return to the queue and the funder's money stays in their wallet.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being rejected? (minimum 10 characters)"
            rows={4}
          />
          <p className="text-[11px] text-muted-foreground">{reason.trim().length}/10 characters</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectRow(null); setReason(''); }}>Cancel</Button>
            <Button variant="destructive" onClick={reject} disabled={reason.trim().length < 10 || !!busyId}>
              Reject portfolio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
