/**
 * Partner Ops → Proxy Agents → Commissions
 *
 * Pending proxy-agent portfolio commissions: 2% when a partner's portfolio is
 * created/activated, 1% on an approved top-up. Nothing is paid automatically
 * unless Partner Ops flips the automatic switch. Approving posts the payout to
 * the proxy agent's wallet and books the company side as a marketing expense.
 *
 * One RPC feeds the whole screen (rows + totals + switch state) — no N+1.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/currency';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Percent, Wallet, Megaphone, RefreshCw } from 'lucide-react';

type QueueStatus = 'pending' | 'paid' | 'rejected';

interface CommissionRow {
  id: string;
  kind: 'portfolio_creation' | 'portfolio_topup';
  status: QueueStatus;
  agent_id: string;
  agent_name: string | null;
  partner_id: string;
  partner_name: string | null;
  base_amount: number;
  rate: number;
  amount: number;
  source_table: string;
  source_id: string;
  auto_approved: boolean;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  ledger_group_id: string | null;
  created_at: string;
}

interface QueuePayload {
  auto_approve: boolean;
  totals: {
    pending_count: number;
    pending_amount: number;
    paid_count: number;
    paid_amount: number;
    rejected_count: number;
    creation_pending_amount: number;
    topup_pending_amount: number;
  };
  rows: CommissionRow[];
}

const KIND_LABEL: Record<CommissionRow['kind'], string> = {
  portfolio_creation: 'Portfolio created · 2%',
  portfolio_topup: 'Top-up · 1%',
};

export function ProxyCommissionsQueue() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<QueueStatus | 'all'>('pending');
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState<CommissionRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data, isLoading, isRefetching, refetch } = useQuery({
    queryKey: ['proxy-commission-queue', status],
    queryFn: async (): Promise<QueuePayload> => {
      const { data, error } = await supabase.rpc('get_proxy_commission_queue' as never, {
        p_status: status,
        p_limit: 300,
      } as never);
      if (error) throw error;
      return data as unknown as QueuePayload;
    },
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    const list = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) =>
      [r.agent_name, r.partner_name, r.kind].some((v) => (v || '').toLowerCase().includes(q)));
  }, [data?.rows, search]);

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('approve_proxy_commission' as never, { p_id: id } as never);
      if (error) throw error;
      return data as Record<string, unknown>;
    },
    onSuccess: (res) => {
      if ((res as { status?: string })?.status === 'paid') {
        toast.success('Commission approved and paid as a marketing expense');
      } else {
        toast.warning(`Not paid: ${(res as { reason?: string })?.reason ?? 'already decided'}`);
      }
      qc.invalidateQueries({ queryKey: ['proxy-commission-queue'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reject = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc('reject_proxy_commission' as never, {
        p_id: id, p_reason: reason,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Commission rejected');
      setRejectTarget(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['proxy-commission-queue'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleAuto = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase.rpc('set_proxy_commission_auto_approve' as never, {
        p_enabled: enabled,
      } as never);
      if (error) throw error;
      return enabled;
    },
    onSuccess: (enabled) => {
      toast.success(enabled
        ? 'Automatic approval on — new commissions pay immediately'
        : 'Automatic approval off — commissions wait for Partner Ops');
      qc.invalidateQueries({ queryKey: ['proxy-commission-queue'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const totals = data?.totals;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Percent className="h-5 w-5 text-primary" />
              Proxy Agent Commissions
            </CardTitle>
            <CardDescription>
              2% when a managed partner's portfolio is created, 1% on an approved top-up.
              Partner Operations approves each one; approved commissions post as a marketing expense.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
            <RefreshCw className={`h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 p-4">
            <div className="space-y-1">
              <Label htmlFor="auto-approve" className="font-medium">Automatic approval</Label>
              <p className="text-xs text-muted-foreground">
                Off by default — every commission waits here. Turn on to pay new commissions instantly.
              </p>
            </div>
            <Switch
              id="auto-approve"
              checked={!!data?.auto_approve}
              disabled={isLoading || toggleAuto.isPending}
              onCheckedChange={(v) => toggleAuto.mutate(v)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Pending" value={formatUGX(totals?.pending_amount ?? 0)} caption={`${totals?.pending_count ?? 0} entr${(totals?.pending_count ?? 0) === 1 ? 'y' : 'ies'}`} icon={<Wallet className="h-4 w-4" />} />
            <Stat label="Pending · portfolios (2%)" value={formatUGX(totals?.creation_pending_amount ?? 0)} />
            <Stat label="Pending · top-ups (1%)" value={formatUGX(totals?.topup_pending_amount ?? 0)} />
            <Stat label="Paid to date" value={formatUGX(totals?.paid_amount ?? 0)} caption={`${totals?.paid_count ?? 0} paid · ${totals?.rejected_count ?? 0} rejected`} icon={<Megaphone className="h-4 w-4" />} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={status} onValueChange={(v) => setStatus(v as QueueStatus | 'all')}>
              <TabsList>
                <TabsTrigger value="pending">Pending</TabsTrigger>
                <TabsTrigger value="paid">Paid</TabsTrigger>
                <TabsTrigger value="rejected">Rejected</TabsTrigger>
                <TabsTrigger value="all">All</TabsTrigger>
              </TabsList>
            </Tabs>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search proxy agent or partner"
              className="max-w-xs"
            />
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No {status === 'all' ? '' : status} commissions.
            </p>
          ) : (
            <div className="space-y-3">
              {rows.map((r) => (
                <div key={r.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.agent_name || 'Unnamed proxy agent'}</span>
                        <Badge variant="outline">{KIND_LABEL[r.kind]}</Badge>
                        <StatusBadge status={r.status} />
                        {r.auto_approved && <Badge variant="secondary">Automatic</Badge>}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Partner: {r.partner_name || 'Unknown partner'} · base {formatUGX(Number(r.base_amount))} ·
                        rate {(Number(r.rate) * 100).toFixed(2)}%
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Raised {new Date(r.created_at).toLocaleString()}
                        {r.decided_at && ` · decided ${new Date(r.decided_at).toLocaleString()}`}
                        {r.decided_by_name && ` by ${r.decided_by_name}`}
                      </p>
                      {r.decision_note && (
                        <p className="text-xs italic text-muted-foreground">Note: {r.decision_note}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className="text-lg font-semibold">{formatUGX(Number(r.amount))}</span>
                      {r.status === 'pending' && (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => approve.mutate(r.id)}
                            disabled={approve.isPending}
                          >
                            <CheckCircle2 className="mr-1 h-4 w-4" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => { setRejectTarget(r); setRejectReason(''); }}
                          >
                            <XCircle className="mr-1 h-4 w-4" /> Reject
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this commission</DialogTitle>
            <DialogDescription>
              {rejectTarget && `${formatUGX(Number(rejectTarget.amount))} to ${rejectTarget.agent_name || 'this proxy agent'}.`}
              {' '}A written reason of at least 10 characters is required and is kept on the record.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Why is this commission not payable?"
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 10 || reject.isPending}
              onClick={() => rejectTarget && reject.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
            >
              Reject commission
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, caption, icon }: { label: string; value: string; caption?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {caption && <div className="text-xs text-muted-foreground">{caption}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: QueueStatus }) {
  if (status === 'paid') return <Badge className="bg-emerald-600 text-emerald-50">Paid</Badge>;
  if (status === 'rejected') return <Badge variant="destructive">Rejected</Badge>;
  return <Badge variant="secondary">Pending</Badge>;
}

export default ProxyCommissionsQueue;
