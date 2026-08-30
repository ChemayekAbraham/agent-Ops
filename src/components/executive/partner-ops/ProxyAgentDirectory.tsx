/**
 * ProxyAgentDirectory — Partner Ops directory of every proxy agent.
 * 4 KPI cards + searchable list (avatar, contacts, notes, partners that came
 * in, join date, referred by) with an inline full-section detail view and bulk
 * removal of proxy rights.
 *
 * One RPC serves KPIs + page rows; the detail view uses one RPC per agent.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Handshake,
  Loader2,
  RefreshCw,
  Search,
  ShieldOff,
  Trash2,
  TrendingUp,
  UserCog,
  UserPlus,
  Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  fetchProxyDirectory,
  proxyInitials,
  proxyStatusTone,
  PROXY_DIR_PAGE_SIZE,
  type ProxyDirRow,
} from './proxyAgentDirectory';
import { ProxyAgentDetailPanel } from './ProxyAgentDetailPanel';
import { OnboardProxyAgentDialog } from './OnboardProxyAgentDialog';
import { ProxyOnboardingAuditPanel } from './ProxyOnboardingAuditPanel';
import { ProxyAgentTargetPanel } from './ProxyAgentTargetPanel';

const STATUS_TABS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'approved', label: 'Approved' },
  { key: 'pending', label: 'Pending' },
  { key: 'suspended', label: 'Suspended' },
];

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-1 truncate text-xl font-bold tabular-nums">{value}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>
          </div>
          <div className="rounded-xl border bg-muted/50 p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ProxyAgentDirectory() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PROXY_DIR_PAGE_SIZE);
  const [selected, setSelected] = useState<ProxyDirRow | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');

  const query = useDebouncedValue(search, 350);

  // Exactly ONE page of rows per request — never accumulates, so the screen
  // costs the same with 1,000 or 1,000,000 proxy agents.
  const pageQueries = useQuery({
    queryKey: ['proxy-agent-directory', query, status, page, pageSize],
    queryFn: () => fetchProxyDirectory(query, status, page * pageSize, pageSize),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const rows = pageQueries.data?.rows ?? [];
  const kpis = pageQueries.data?.kpis;
  const total = pageQueries.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : page * pageSize + 1;
  const lastShown = page * pageSize + rows.length;


  const conversion = useMemo(() => {
    if (!kpis || !kpis.partners_linked) return 0;
    return Math.round((kpis.partners_came_in / kpis.partners_linked) * 100);
  }, [kpis]);

  const selectedIds = useMemo(
    () => Object.entries(checked).filter(([, v]) => v).map(([k]) => k),
    [checked],
  );
  const selectedRows = useMemo(
    () => rows.filter((r) => checked[r.agent_user_id]),
    [rows, checked],
  );
  const selectedTotals = useMemo(
    () =>
      selectedRows.reduce(
        (acc, r) => ({
          notes: acc.notes + Number(r.notes_count || 0),
          amount: acc.amount + Number(r.notes_amount || 0),
          partners: acc.partners + Number(r.partners_linked || 0),
        }),
        { notes: 0, amount: 0, partners: 0 },
      ),
    [selectedRows],
  );

  const allOnPage = rows.length > 0 && rows.every((r) => checked[r.agent_user_id]);

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_bulk_delete_proxy_agents', {
        p_agent_ids: selectedIds,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (res) => {
      toast({
        title: 'Proxy agents removed',
        description: `${res?.agents_deleted ?? 0} agent(s) removed · ${res?.notes_deleted ?? 0} promissory note(s) deleted.`,
      });
      setChecked({});
      setReason('');
      setConfirmOpen(false);
      setSelected(null);
      qc.invalidateQueries({ queryKey: ['proxy-agent-directory'] });
      qc.invalidateQueries({ queryKey: ['proxy-agent-detail'] });
    },
    onError: (e: any) =>
      toast({ title: 'Delete failed', description: e.message, variant: 'destructive' }),
  });

  const goToPage = (p: number) => {
    setPage(Math.min(Math.max(0, p), totalPages - 1));
    setChecked({});
  };


  if (selected) {
    return (
      <ProxyAgentDetailPanel
        agent={selected}
        transferTargets={rows}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <UserCog className="h-5 w-5 text-primary" />
            Proxy Agent Directory
          </h2>
          <p className="text-xs text-muted-foreground">
            Bio data, promissory notes, linked partners and earnings for every proxy agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-8 text-xs" onClick={() => setOnboardOpen(true)}>
            <UserPlus className="mr-1.5 h-3.5 w-3.5" />
            Onboard Proxy Agent
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => qc.invalidateQueries({ queryKey: ['proxy-agent-directory'] })}
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', pageQueries.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <OnboardProxyAgentDialog open={onboardOpen} onOpenChange={setOnboardOpen} />

      <ProxyAgentTargetPanel />

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {!kpis ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        ) : (
          <>
            <KpiCard
              icon={UserCog}
              label="Proxy agents"
              value={String(kpis.agents_total)}
              sub={`${kpis.agents_approved} approved · ${kpis.agents_suspended} not active`}
            />
            <KpiCard
              icon={Handshake}
              label="Partners came in"
              value={String(kpis.partners_came_in)}
              sub={`${conversion}% of ${kpis.partners_linked} linked`}
            />
            <KpiCard
              icon={FileText}
              label="Promissory pending"
              value={String(kpis.notes_pending)}
              sub={`${formatUGX(Number(kpis.notes_amount || 0))} total written`}
            />
            <KpiCard
              icon={TrendingUp}
              label="Capital raised"
              value={formatUGX(Number(kpis.partner_funded || 0))}
              sub={`${formatUGX(Number(kpis.earned || 0))} commissions paid`}
            />
          </>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type a name, phone, email or invite code to find an agent"
            className="h-9 pl-8 text-xs"
          />
        </div>
        <div className="inline-flex rounded-lg border bg-muted/40 p-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                status === t.key
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => {
                setPage(0);
                setStatus(t.key);
                setChecked({});
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-xs font-semibold">
            {selectedIds.length} selected
            <span className="ml-1 font-normal text-muted-foreground">
              · {selectedTotals.notes} note(s) worth {formatUGX(selectedTotals.amount)} will be deleted
            </span>
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setChecked({})}>
              Clear
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete selected
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      <Card>
        <CardContent className="p-0">
          {pageQueries.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">No proxy agents match this filter.</p>
          ) : (
            <>
              {/* Desktop header */}
              <div className="hidden grid-cols-12 items-center gap-2 border-b bg-muted/40 px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground md:grid">
                <div className="col-span-1 flex items-center">
                  <Checkbox
                    checked={allOnPage}
                    onCheckedChange={(v) => {
                      const next = { ...checked };
                      for (const r of rows) {
                        if (v) next[r.agent_user_id] = true;
                        else delete next[r.agent_user_id];
                      }
                      setChecked(next);
                    }}
                    aria-label="Select all loaded proxy agents"
                  />
                </div>
                <span className="col-span-3">Agent</span>
                <span className="col-span-2">Contacts</span>
                <span className="col-span-2 text-right">Promissory</span>
                <span className="col-span-2 text-right">Partners in</span>
                <span className="col-span-2 text-right">Joined / Referred by</span>
              </div>
              <ul className="divide-y">
                {rows.map((r) => (
                  <li
                    key={r.agent_user_id}
                    className={cn(
                      'grid grid-cols-1 items-center gap-2 px-4 py-3 transition-colors hover:bg-muted/50 md:grid-cols-12',
                      checked[r.agent_user_id] && 'bg-primary/5',
                    )}
                  >
                    <div className="hidden md:col-span-1 md:flex md:items-center">
                      <Checkbox
                        checked={!!checked[r.agent_user_id]}
                        onCheckedChange={(v) =>
                          setChecked((prev) => {
                            const next = { ...prev };
                            if (v) next[r.agent_user_id] = true;
                            else delete next[r.agent_user_id];
                            return next;
                          })
                        }
                        aria-label={`Select ${r.name}`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelected(r)}
                      className="grid w-full grid-cols-1 gap-2 text-left md:col-span-11 md:grid-cols-11 md:items-center"
                    >
                      <div className="flex items-center gap-2 md:col-span-3">
                        <div className="md:hidden">
                          <Checkbox
                            checked={!!checked[r.agent_user_id]}
                            onClick={(e) => e.stopPropagation()}
                            onCheckedChange={(v) =>
                              setChecked((prev) => {
                                const next = { ...prev };
                                if (v) next[r.agent_user_id] = true;
                                else delete next[r.agent_user_id];
                                return next;
                              })
                            }
                            aria-label={`Select ${r.name}`}
                          />
                        </div>
                        <Avatar className="h-9 w-9 border">
                          <AvatarImage src={r.avatar_url ?? undefined} alt={r.name} />
                          <AvatarFallback className="text-[10px] font-bold">{proxyInitials(r.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold">{r.name}</p>
                          <Badge variant="outline" className={cn('mt-0.5 text-[9px]', proxyStatusTone(r.status))}>
                            {r.status}
                          </Badge>
                        </div>
                      </div>
                      <div className="min-w-0 md:col-span-2">
                        <p className="truncate text-[11px] font-medium">{r.phone || '—'}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{r.email || '—'}</p>
                      </div>
                      <div className="md:col-span-2 md:text-right">
                        <p className="text-xs font-bold tabular-nums">{formatUGX(Number(r.notes_amount || 0))}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {r.notes_count} note(s) · {r.notes_pending} pending
                        </p>
                      </div>
                      <div className="md:col-span-2 md:text-right">
                        <p className="text-xs font-bold tabular-nums text-emerald-600">{r.partners_came_in}</p>
                        <p className="text-[11px] text-muted-foreground">of {r.partners_linked} linked</p>
                      </div>
                      <div className="flex items-center justify-between gap-2 md:col-span-2 md:justify-end">
                        <div className="md:text-right">
                          <p className="text-[11px] font-medium">
                            {r.joined_at ? format(new Date(r.joined_at), 'dd MMM yyyy') : '—'}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">{r.referrer_name || 'Direct'}</p>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
                <p className="text-[11px] text-muted-foreground">
                  Showing {firstShown.toLocaleString()}–{lastShown.toLocaleString()} of{' '}
                  {total.toLocaleString()} agents
                  {pageQueries.isFetching && (
                    <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin align-[-2px]" />
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => {
                      setPageSize(Number(v));
                      setPage(0);
                      setChecked({});
                    }}
                  >
                    <SelectTrigger className="h-8 w-[120px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[30, 60, 100, 200].map((n) => (
                        <SelectItem key={n} value={String(n)} className="text-xs">
                          {n} per page
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={page === 0}
                    onClick={() => goToPage(page - 1)}
                  >
                    <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                    Back
                  </Button>
                  <span className="text-[11px] font-semibold tabular-nums">
                    Page {(page + 1).toLocaleString()} of {totalPages.toLocaleString()}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={page + 1 >= totalPages}
                    onClick={() => goToPage(page + 1)}
                  >
                    Next
                    <ChevronRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

            </>
          )}
        </CardContent>
      </Card>

      <ProxyOnboardingAuditPanel />

      {/* Bulk delete confirmation */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!bulkDelete.isPending) setConfirmOpen(o);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldOff className="h-4 w-4 text-destructive" />
              Remove {selectedIds.length} proxy agent{selectedIds.length === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription className="text-xs">
              They will no longer be proxy agents. Their promissory notes are deleted and their
              partner links and invites are switched off. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Agents', value: String(selectedIds.length) },
                { label: 'Notes deleted', value: String(selectedTotals.notes) },
                { label: 'Note value', value: formatUGX(selectedTotals.amount) },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border bg-muted/40 p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{s.label}</p>
                  <p className="mt-0.5 truncate text-sm font-bold tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2">
              {selectedRows.map((r) => (
                <div key={r.agent_user_id} className="flex items-center gap-2">
                  <Avatar className="h-6 w-6 border">
                    <AvatarImage src={r.avatar_url ?? undefined} alt={r.name} />
                    <AvatarFallback className="text-[9px]">{proxyInitials(r.name)}</AvatarFallback>
                  </Avatar>
                  <p className="truncate text-[11px] font-medium">{r.name}</p>
                  <p className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {r.notes_count} note(s)
                  </p>
                </div>
              ))}
            </div>

            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (minimum 10 characters) — stored on the audit trail"
              className="min-h-[70px] text-xs"
            />
          </div>

          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-xs"
              disabled={bulkDelete.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-9 text-xs"
              disabled={reason.trim().length < 10 || bulkDelete.isPending}
              onClick={() => bulkDelete.mutate()}
            >
              {bulkDelete.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ProxyAgentDirectory;
