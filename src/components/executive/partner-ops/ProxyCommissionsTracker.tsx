/**
 * Partner Ops → Proxy Agents → Commissions
 *
 * Tracking only. Proxy-agent portfolio commissions are paid automatically the
 * moment they are earned (2% when a managed partner's portfolio is created,
 * 1% on a top-up). This screen records what each commission was for, which
 * portfolio produced it, how much was earned, when it was paid, and which
 * proxy agent and partner it belongs to.
 *
 * One RPC feeds the whole screen (rows + totals + paging) — no N+1, no writes.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { Percent, Wallet, Megaphone, RefreshCw, Zap, Loader2, CheckCircle2, Send } from 'lucide-react';


type KindFilter = 'all' | 'portfolio_creation' | 'portfolio_topup';
type PeriodFilter = 'all' | '7d' | '30d' | '90d';

interface TrackerRow {
  id: string;
  kind: 'portfolio_creation' | 'portfolio_topup';
  kind_label: string;
  rate: number;
  status: 'pending' | 'paid' | 'rejected';
  auto_approved: boolean;
  portfolio_id: string | null;
  portfolio_code: string | null;
  portfolio_amount: number | null;
  base_amount: number;
  commission_amount: number;
  paid_at: string | null;
  earned_at: string;
  agent_id: string;
  agent_name: string | null;
  partner_id: string;
  partner_name: string | null;
  source_table: string;
  source_id: string;
  ledger_group_id: string | null;
}

interface TrackerPayload {
  rows: TrackerRow[];
  total_count: number;
  totals: {
    paid_count: number;
    paid_amount: number;
    creation_paid_amount: number;
    topup_paid_amount: number;
    pending_count: number;
    pending_amount: number;
    rejected_count: number;
    portfolio_volume: number;
  };
}

const PAGE_SIZE = 25;

function periodStart(period: PeriodFilter): string | null {
  if (period === 'all') return null;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function ProxyCommissionsTracker() {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [status, setStatus] = useState<'all' | 'paid' | 'pending' | 'rejected'>('all');
  const [period, setPeriod] = useState<PeriodFilter>('all');
  const [page, setPage] = useState(0);

  const from = useMemo(() => periodStart(period), [period]);

  const { data, isLoading, isRefetching, refetch } = useQuery({
    queryKey: ['proxy-commission-tracker', search, kind, status, period, page],
    queryFn: async (): Promise<TrackerPayload> => {
      const { data, error } = await supabase.rpc('get_proxy_commission_tracker' as never, {
        p_search: search.trim() || null,
        p_kind: kind,
        p_status: status,
        p_from: from,
        p_to: null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      } as never);
      if (error) throw error;
      return data as unknown as TrackerPayload;
    },
    staleTime: 30_000,
  });

  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const totalCount = data?.total_count ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const [confirm, setConfirm] = useState<{ row: TrackerRow; action: 'approve' | 'complete' } | null>(null);
  const [working, setWorking] = useState(false);

  const runAction = async () => {
    if (!confirm) return;
    const { row, action } = confirm;
    setWorking(true);
    try {
      const { data: res, error } = await supabase.rpc(
        (action === 'approve' ? 'approve_proxy_commission' : 'mark_proxy_commission_completed') as never,
        { p_id: row.id, p_note: null } as never,
      );
      if (error) throw error;
      const status = (res as { status?: string; reason?: string } | null)?.status;
      const reason = (res as { reason?: string } | null)?.reason;
      if (status === 'skipped') {
        toast.error(
          reason === 'not_pending'
            ? 'This commission was already settled.'
            : `Could not complete this action${reason ? ` (${reason})` : ''}.`,
        );
      } else if (action === 'approve') {
        toast.success(`${formatUGX(Number(row.commission_amount))} sent to ${row.agent_name || 'the proxy agent'}.`);
      } else {
        toast.success('Marked as paid. No money was moved.');
      }
      setConfirm(null);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setWorking(false);
    }
  };


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
              Paid automatically — 2% when a managed partner's portfolio is created, 1% on a top-up.
              This page tracks every commission; nothing here needs approving.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
            <RefreshCw className={`h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            <Zap className="h-4 w-4 shrink-0 text-primary" />
            Commissions are credited to the proxy agent's wallet the moment they are earned and
            booked as a marketing expense. Earlier entries left waiting are shown here as they are —
            they are not re-sent.
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Commission paid"
              value={formatUGX(totals?.paid_amount ?? 0)}
              caption={`${totals?.paid_count ?? 0} payout${(totals?.paid_count ?? 0) === 1 ? '' : 's'}`}
              icon={<Wallet className="h-4 w-4" />}
            />
            <Stat label="Portfolios created (2%)" value={formatUGX(totals?.creation_paid_amount ?? 0)} />
            <Stat label="Top-ups (1%)" value={formatUGX(totals?.topup_paid_amount ?? 0)} />
            <Stat
              label="Portfolio volume behind it"
              value={formatUGX(totals?.portfolio_volume ?? 0)}
              caption={`${totals?.pending_count ?? 0} still waiting · ${totals?.rejected_count ?? 0} rejected`}
              icon={<Megaphone className="h-4 w-4" />}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Tabs
              value={kind}
              onValueChange={(v) => { setKind(v as KindFilter); setPage(0); }}
            >
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="portfolio_creation">Created · 2%</TabsTrigger>
                <TabsTrigger value="portfolio_topup">Top-up · 1%</TabsTrigger>
              </TabsList>
            </Tabs>

            <Select value={status} onValueChange={(v) => { setStatus(v as typeof status); setPage(0); }}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="pending">Waiting</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>

            <Select value={period} onValueChange={(v) => { setPeriod(v as PeriodFilter); setPage(0); }}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Period" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All time</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
              </SelectContent>
            </Select>

            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search proxy agent, partner, phone, portfolio ID or code"
              className="w-full max-w-sm"
            />
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No commissions match this view.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>What it was for</TableHead>
                      <TableHead>Portfolio</TableHead>
                      <TableHead className="text-right">Portfolio amount</TableHead>
                      <TableHead className="text-right">Commission earned</TableHead>
                      <TableHead>Paid on</TableHead>
                      <TableHead>Proxy agent</TableHead>
                      <TableHead>Partner</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>

                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="align-top">
                          <div className="flex flex-col gap-1">
                            <span className="font-medium">{r.kind_label}</span>
                            <Badge variant="outline" className="w-fit">
                              {(Number(r.rate) * 100).toFixed(2)}% commission
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              on {formatUGX(Number(r.base_amount))}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-col">
                            <span className="font-medium">{r.portfolio_code || 'No code'}</span>
                            <span className="font-mono text-xs text-muted-foreground" title={r.portfolio_id ?? ''}>
                              {shortId(r.portfolio_id)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-right">
                          {r.portfolio_amount != null ? formatUGX(Number(r.portfolio_amount)) : '—'}
                        </TableCell>
                        <TableCell className="align-top text-right font-semibold text-emerald-600">
                          {formatUGX(Number(r.commission_amount))}
                        </TableCell>
                        <TableCell className="align-top text-sm">
                          {r.paid_at
                            ? new Date(r.paid_at).toLocaleString()
                            : <span className="text-muted-foreground">Not paid</span>}
                          <div className="text-xs text-muted-foreground">
                            earned {new Date(r.earned_at).toLocaleDateString()}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-col">
                            <span>{r.agent_name || 'Unnamed proxy agent'}</span>
                            <span className="font-mono text-xs text-muted-foreground" title={r.agent_id}>
                              {shortId(r.agent_id)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-col">
                            <span>{r.partner_name || 'Unknown partner'}</span>
                            <span className="font-mono text-xs text-muted-foreground" title={r.partner_id}>
                              {shortId(r.partner_id)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-col gap-1">
                            <StatusBadge status={r.status} />
                            {r.auto_approved && <Badge variant="secondary" className="w-fit">Automatic</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-right">
                          {r.status === 'pending' ? (
                            <div className="flex flex-col items-end gap-1.5 sm:flex-row sm:justify-end">
                              <Button
                                size="sm"
                                className="gap-1.5"
                                onClick={() => setConfirm({ row: r, action: 'approve' })}
                              >
                                <Send className="h-3.5 w-3.5" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5"
                                onClick={() => setConfirm({ row: r, action: 'complete' })}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Completed
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">No action needed</span>
                          )}
                        </TableCell>
                      </TableRow>

                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} of {totalCount}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {page + 1} of {pageCount}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page + 1 >= pageCount}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open && !working) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === 'approve' ? 'Send this commission now?' : 'Mark this commission as paid?'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {confirm?.action === 'approve'
                    ? `${formatUGX(Number(confirm?.row.commission_amount ?? 0))} will be sent straight to ${confirm?.row.agent_name || 'the proxy agent'}'s wallet. This cannot be undone here.`
                    : `This only records ${formatUGX(Number(confirm?.row.commission_amount ?? 0))} as already settled for ${confirm?.row.agent_name || 'the proxy agent'}. No money will be sent.`}
                </p>
                <p className="text-muted-foreground">
                  {confirm?.row.kind_label} · {confirm?.row.partner_name || 'Unknown partner'} ·{' '}
                  {confirm?.row.portfolio_code || 'No code'}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); runAction(); }}
              disabled={working}
            >
              {working && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {confirm?.action === 'approve' ? 'Yes, send the money' : 'Yes, mark as paid'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>

  );
}

function Stat({ label, value, caption, icon }: {
  label: string; value: string; caption?: string; icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: TrackerRow['status'] }) {
  if (status === 'paid') return <Badge className="w-fit bg-emerald-600 hover:bg-emerald-600">Paid</Badge>;
  if (status === 'rejected') return <Badge variant="destructive" className="w-fit">Rejected</Badge>;
  return <Badge variant="secondary" className="w-fit">Waiting</Badge>;
}

export default ProxyCommissionsTracker;
