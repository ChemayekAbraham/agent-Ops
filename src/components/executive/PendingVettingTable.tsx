import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { Check, X, RefreshCw, ShieldCheck, Clock, Users, Wallet, Search, Loader2 } from 'lucide-react';
import { CommitmentLines } from './pending-vetting/CommitmentLines';

type Kind = 'self_support' | 'agent_funder';

interface UnifiedRow {
  key: string;
  kind: Kind;
  /** Portfolio row ids */
  portfolio_id?: string;
  portfolio_code?: string;
  /** Assignment id for agent-registered funders */
  assignment_id?: string;
  name: string;
  contact: string;
  amount: number;
  detail: string;
  tenants: number;
  term_months: number | null;
  registered_by: string | null;
  reason: string | null;
  created_at: string;
  waiting_days: number;
}

function KpiTile({ icon, label, value, tone = 'default' }: {
  icon: React.ReactNode; label: string; value: string; tone?: 'default' | 'warn';
}) {
  return (
    <Card className="border-border/60">
      <CardContent className="p-3.5 flex items-center gap-3">
        <div className={'h-9 w-9 shrink-0 rounded-full flex items-center justify-center '
          + (tone === 'warn' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary')}>
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

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/**
 * One vetting table for everything waiting on Partner Ops:
 * partner self-support portfolios and agent-registered funder approvals.
 * Rows are clickable — the side panel carries the full record plus the actions.
 */
export function PendingVettingTable() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const [search, setSearch] = useState('');
  const [openRow, setOpenRow] = useState<UnifiedRow | null>(null);
  const [rejectRow, setRejectRow] = useState<UnifiedRow | null>(null);
  const [reason, setReason] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const portfolios = useQuery({
    queryKey: ['partner-ops-pending-portfolios'],
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_pending_portfolios' as any);
      if (error) throw error;
      return (data as any[]) || [];
    },
  });

  const funders = useQuery({
    queryKey: ['pending-funder-approvals'],
    staleTime: 15_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('proxy_agent_assignments')
        .select('id, agent_id, beneficiary_id, reason, created_at')
        .eq('approval_status', 'pending')
        .eq('beneficiary_role', 'supporter')
        .order('created_at', { ascending: true });
      if (error) throw error;
      const base = rows || [];
      if (base.length === 0) return [] as any[];
      const ids = Array.from(new Set(base.flatMap(r => [r.agent_id, r.beneficiary_id]).filter(Boolean)));
      const { data: profiles } = await supabase
        .from('profiles').select('id, full_name, phone').in('id', ids);
      const pMap = new Map((profiles || []).map(p => [p.id, p]));
      const { data: ports } = await supabase
        .from('investor_portfolios')
        .select('investor_id, investment_amount')
        .in('investor_id', base.map(r => r.beneficiary_id))
        .eq('status', 'active');
      const amountMap = new Map<string, number>();
      (ports || []).forEach(p => {
        amountMap.set(p.investor_id, (amountMap.get(p.investor_id) || 0) + (Number(p.investment_amount) || 0));
      });
      return base.map(r => ({
        ...r,
        beneficiary: pMap.get(r.beneficiary_id) || null,
        agent: pMap.get(r.agent_id) || null,
        amount: amountMap.get(r.beneficiary_id) || 0,
      }));
    },
  });

  const allRows = useMemo<UnifiedRow[]>(() => {
    const now = Date.now();
    const a: UnifiedRow[] = (portfolios.data || []).map((r: any) => ({
      key: `p:${r.pending_id}`,
      kind: 'self_support',
      portfolio_id: r.portfolio_id,
      portfolio_code: r.portfolio_code,
      name: r.funder_name || r.funder_email || 'Partner',
      contact: r.funder_phone || r.funder_email || '—',
      amount: Number(r.amount) || 0,
      detail: r.source === 'self_managed' ? 'Supporting tenants directly'
        : r.source === 'self_managed_house' ? 'Supporting a house'
        : r.source === 'self_managed_house_topup' ? 'Adding houses to a house portfolio'
        : 'Rent pool',
      tenants: Number(r.lines_count) || 0,
      term_months: Number(r.term_months) || null,
      registered_by: null,
      reason: null,
      created_at: r.created_at,
      waiting_days: Number(r.waiting_days) || 0,
    }));
    const b: UnifiedRow[] = (funders.data || []).map((r: any) => ({
      key: `f:${r.id}`,
      kind: 'agent_funder',
      assignment_id: r.id,
      name: r.beneficiary?.full_name || 'Unknown funder',
      contact: r.beneficiary?.phone || '—',
      amount: Number(r.amount) || 0,
      detail: 'Agent-registered funder',
      tenants: 0,
      term_months: null,
      registered_by: r.agent?.full_name || null,
      reason: r.reason || null,
      created_at: r.created_at,
      waiting_days: Math.max(0, Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000)),
    }));
    return [...a, ...b].sort((x, y) => y.waiting_days - x.waiting_days);
  }, [portfolios.data, funders.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows
      .filter(r => filter === 'all' || r.kind === filter)
      .filter(r => !q || [r.name, r.contact, r.portfolio_code, r.registered_by]
        .filter(Boolean).some(v => String(v).toLowerCase().includes(q)));
  }, [allRows, filter, search]);

  const totals = useMemo(() => ({
    count: allRows.length,
    amount: allRows.reduce((s, r) => s + r.amount, 0),
    tenants: allRows.reduce((s, r) => s + r.tenants, 0),
    stale: allRows.filter(r => r.waiting_days > 2).length,
  }), [allRows]);

  const isLoading = portfolios.isLoading || funders.isLoading;
  const isFetching = portfolios.isFetching || funders.isFetching;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['partner-ops-pending-portfolios'] });
    qc.invalidateQueries({ queryKey: ['pending-funder-approvals'] });
    qc.invalidateQueries({ queryKey: ['partner-ops-pending-portfolio-summary'] });
    qc.invalidateQueries({ queryKey: ['invited-portfolios'] });
  };

  const approve = async (row: UnifiedRow) => {
    setBusyKey(row.key);
    try {
      if (row.kind === 'self_support') {
        const { data: res, error } = await invokeEdgeFunction('approve-pending-portfolio', {
          body: { portfolio_id: row.portfolio_id },
          silent: true,
        });
        if (error || (res as any)?.error) throw new Error((res as any)?.error || error?.message || 'Approval failed');
        toast.success(`Portfolio ${row.portfolio_code} verified and funded`);
      } else {
        const { data: assignment, error: fetchError } = await supabase
          .from('proxy_agent_assignments')
          .select('id, approval_status, beneficiary_id, agent_id')
          .eq('id', row.assignment_id!)
          .maybeSingle();
        if (fetchError) throw fetchError;
        if (!assignment) throw new Error('Registration not found');
        if (assignment.approval_status === 'approved') throw new Error('This funder has already been approved.');
        const { data: updated, error } = await supabase
          .from('proxy_agent_assignments')
          .update({
            approval_status: 'approved',
            is_active: true,
            approved_by: user?.id,
            approved_at: new Date().toISOString(),
          })
          .eq('id', row.assignment_id!)
          .eq('approval_status', 'pending')
          .select('id');
        if (error) throw error;
        if (!updated || updated.length === 0) {
          throw new Error('Approval was not saved — your role does not have permission to approve funders.');
        }
        await supabase.from('audit_logs').insert({
          user_id: user?.id,
          action_type: 'approve_proxy_funder',
          table_name: 'proxy_agent_assignments',
          record_id: row.assignment_id!,
          metadata: { beneficiary_name: row.name, agent_name: row.registered_by },
        });
        toast.success(`${row.name} approved`);
      }
      setOpenRow(null);
      invalidate();
    } catch (e: any) {
      toast.error(e.message || 'Approval failed');
      invalidate();
    } finally {
      setBusyKey(null);
    }
  };

  const reject = async () => {
    if (!rejectRow) return;
    if (reason.trim().length < 10) { toast.error('Give a reason of at least 10 characters'); return; }
    setBusyKey(rejectRow.key);
    try {
      if (rejectRow.kind === 'self_support') {
        const { error } = await supabase.rpc('reject_pending_portfolio' as any, {
          p_portfolio_id: rejectRow.portfolio_id,
          p_reason: reason.trim(),
        });
        if (error) throw error;
        toast.success('Portfolio rejected and capital released');
      } else {
        const { error } = await supabase
          .from('proxy_agent_assignments')
          .update({
            approval_status: 'rejected',
            is_active: false,
            approved_by: user?.id,
            approved_at: new Date().toISOString(),
            rejection_reason: reason.trim(),
          })
          .eq('id', rejectRow.assignment_id!);
        if (error) throw error;
        await supabase.from('audit_logs').insert({
          user_id: user?.id,
          action_type: 'reject_proxy_funder',
          table_name: 'proxy_agent_assignments',
          record_id: rejectRow.assignment_id!,
          metadata: { beneficiary_name: rejectRow.name, rejection_reason: reason.trim() },
        });
        toast.success('Funder registration rejected');
      }
      setRejectRow(null);
      setReason('');
      setOpenRow(null);
      invalidate();
    } catch (e: any) {
      toast.error(e.message || 'Rejection failed');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-black text-foreground">Pending vetting</h3>
            <p className="text-xs text-muted-foreground">
              Every partner portfolio and agent-registered funder waiting for verification. Tap a row to review it.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={isFetching}
          onClick={() => { portfolios.refetch(); funders.refetch(); }}
        >
          <RefreshCw className={'h-3.5 w-3.5' + (isFetching ? ' animate-spin' : '')} /> Refresh
        </Button>
      </div>

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

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as any)}>
          <TabsList className="h-9">
            <TabsTrigger value="all" className="text-xs">All ({allRows.length})</TabsTrigger>
            <TabsTrigger value="self_support" className="text-xs">
              Self support ({allRows.filter(r => r.kind === 'self_support').length})
            </TabsTrigger>
            <TabsTrigger value="agent_funder" className="text-xs">
              Agent funders ({allRows.filter(r => r.kind === 'agent_funder').length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, email, portfolio code or agent"
            className="pl-9 h-9 text-sm"
          />
        </div>
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the vetting queue…
        </p>
      ) : rows.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center space-y-1">
            <ShieldCheck className="h-6 w-6 mx-auto text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">Nothing to vet</p>
            <p className="text-xs text-muted-foreground">New submissions land here for verification.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {rows.map(row => (
            <Card
              key={row.key}
              onClick={() => setOpenRow(row)}
              className="cursor-pointer hover:border-primary/40 hover:bg-accent/40 transition-colors"
            >
              <CardContent className="p-3.5 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-foreground truncate">{row.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {[row.portfolio_code, row.contact].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <Badge variant={row.waiting_days > 2 ? 'destructive' : 'outline'} className="text-[10px] shrink-0">
                    {row.waiting_days}d
                  </Badge>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary" className="text-[10px] whitespace-nowrap">{row.detail}</Badge>
                  <p className="text-xs font-black tabular-nums text-foreground">{formatUGX(row.amount)}</p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
                  <div>
                    <span className="block text-[9px] uppercase tracking-wide">Tenants</span>
                    <span className="font-medium text-foreground">
                      {row.kind === 'self_support' ? row.tenants : '—'}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="block text-[9px] uppercase tracking-wide">Submitted</span>
                    <span className="font-medium text-foreground whitespace-nowrap">{dayLabel(row.created_at)}</span>
                  </div>
                </div>

                {row.registered_by && (
                  <p className="text-[10px] text-muted-foreground truncate">
                    Registered by <span className="font-medium text-foreground">{row.registered_by}</span>
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Row detail */}
      <Sheet open={!!openRow} onOpenChange={(o) => { if (!o) setOpenRow(null); }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {openRow && (
            <>
              <SheetHeader className="text-left">
                <SheetTitle className="text-base">{openRow.name}</SheetTitle>
                <SheetDescription className="text-xs">
                  {[openRow.detail, openRow.portfolio_code].filter(Boolean).join(' · ')}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border/60 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Capital</p>
                    <p className="text-sm font-black tabular-nums">{formatUGX(openRow.amount)}</p>
                  </div>
                  <div className="rounded-lg border border-border/60 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Term</p>
                    <p className="text-sm font-black">
                      {openRow.term_months ? `${openRow.term_months} months` : '—'}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/60 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Contact</p>
                    <p className="text-xs font-semibold break-all">{openRow.contact}</p>
                  </div>
                  <div className="rounded-lg border border-border/60 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Submitted</p>
                    <p className="text-xs font-semibold">{dayLabel(openRow.created_at)}</p>
                    <p className="text-[10px] text-muted-foreground">Waiting {openRow.waiting_days}d</p>
                  </div>
                </div>

                {openRow.registered_by && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Registered by</p>
                    <p className="text-xs font-semibold">{openRow.registered_by}</p>
                  </div>
                )}

                {openRow.reason && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Reason given</p>
                    <p className="text-xs">{openRow.reason}</p>
                  </div>
                )}

                {openRow.kind === 'self_support' && openRow.portfolio_id && (
                  <div className="space-y-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      What this partner is supporting
                    </p>
                    <CommitmentLines portfolioId={openRow.portfolio_id} />
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button
                    size="sm"
                    className="flex-1 gap-1.5"
                    disabled={busyKey === openRow.key}
                    onClick={() => approve(openRow)}
                  >
                    <Check className="h-3.5 w-3.5" />
                    {busyKey === openRow.key ? 'Working…' : 'Verify & approve'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1.5 text-destructive border-destructive/40 hover:bg-destructive/10"
                    disabled={busyKey === openRow.key}
                    onClick={() => { setRejectRow(openRow); setReason(''); }}
                  >
                    <X className="h-3.5 w-3.5" /> Reject
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={!!rejectRow} onOpenChange={(o) => { if (!o) { setRejectRow(null); setReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this submission</DialogTitle>
            <DialogDescription>
              {rejectRow?.kind === 'self_support'
                ? "The portfolio is cancelled, reserved rent plans return to the queue and the partner's money stays in their wallet."
                : 'The agent-registered funder will be declined and the agent notified.'}
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
            <Button variant="destructive" onClick={reject} disabled={reason.trim().length < 10 || !!busyKey}>
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}