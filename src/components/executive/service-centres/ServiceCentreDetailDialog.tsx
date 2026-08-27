import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Building2, CheckCircle2, ExternalLink, Loader2, MapPin, Search, UserMinus, UserPlus, Users,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { SC_STATUS_META, mapsUrl, type ServiceCentre, type ServiceCentreStatus } from '@/hooks/useServiceCentres';
import {
  useAssignableAgents,
  useAssignServiceCentreAgents,
  useServiceCentre360,
  useUnassignServiceCentreAgent,
} from '@/hooks/useServiceCentre360';
import { ServiceCentreReceivablePanel } from './ServiceCentreReceivablePanel';


const initials = (name: string) =>
  (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

interface Props {
  centre: ServiceCentre | null;
  photos: ServiceCentre[];
  avatarUrl?: string | null;
  onClose: () => void;
}

/**
 * Full Service Centre record: status, information, repayment history and the
 * agents attached to it — with Agent Ops able to attach more agents.
 */
export function ServiceCentreDetailDialog({ centre, photos, avatarUrl, onClose }: Props) {
  const id = centre?.id ?? null;
  const { data, isLoading } = useServiceCentre360(id);
  const [tab, setTab] = useState('overview');

  return (
    <Dialog open={!!centre} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto p-4 sm:max-w-3xl sm:p-6">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 pr-6">
            <Avatar className="h-9 w-9 shrink-0">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={centre?.agent_name || ''} />}
              <AvatarFallback className="text-[10px]">{initials(centre?.agent_name || '')}</AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <span className="block truncate text-base">{centre?.agent_name}</span>
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {centre?.location_name || 'No location description'}
              </span>
            </span>
          </DialogTitle>
        </DialogHeader>

        {centre && (
          <Tabs value={tab} onValueChange={setTab} className="mt-1">
            <TabsList className="grid w-full grid-cols-3 gap-1 sm:grid-cols-5">
              <TabsTrigger value="overview" className="text-[11px] sm:text-xs">Overview</TabsTrigger>
              <TabsTrigger value="agents" className="text-[11px] sm:text-xs">
                Agents{data ? ` (${data.assigned_agents.length})` : ''}
              </TabsTrigger>
              <TabsTrigger value="receivable" className="text-[11px] sm:text-xs">Receivable</TabsTrigger>
              <TabsTrigger value="repayments" className="text-[11px] sm:text-xs">Repayments</TabsTrigger>
              <TabsTrigger value="advances" className="text-[11px] sm:text-xs">Advances</TabsTrigger>

            </TabsList>

            {isLoading && (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            <TabsContent value="overview" className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn('border-0 text-[10px]', SC_STATUS_META[centre.status as ServiceCentreStatus]?.className)}
                >
                  {SC_STATUS_META[centre.status as ServiceCentreStatus]?.label || centre.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Requested {format(new Date(centre.created_at), 'dd MMM yyyy, HH:mm')}
                </span>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Detail label="Phone number" value={centre.agent_phone || '—'} />
                <Detail label="Location description" value={centre.location_name || '—'} />
                <Detail label="GPS" value={`${centre.latitude.toFixed(5)}, ${centre.longitude.toFixed(5)}`} />
                <Detail label="Verified" value={centre.verified_at ? format(new Date(centre.verified_at), 'dd MMM yyyy') : 'Not yet'} />
                <Detail label="Approved" value={centre.approved_at ? format(new Date(centre.approved_at), 'dd MMM yyyy') : 'Not yet'} />
                <Detail label="Agents attached" value={String(data?.assigned_agents.length ?? 0)} />
                <Detail
                  label="Approved amount"
                  value={data?.centre.cfo_approved_amount != null ? formatUGX(Number(data.centre.cfo_approved_amount)) : '—'}
                />
                <Detail label="Payee" value={data?.centre.payee_name || '—'} />
              </div>

              {centre.rejection_reason && (
                <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{centre.rejection_reason}</p>
              )}

              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Service centre photo{photos.length > 1 ? 's' : ''}
                </p>
                {photos.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No photo attached.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {photos.map((p) => (
                      <a key={p.id} href={p.photo_url} target="_blank" rel="noopener noreferrer" className="block">
                        <img
                          src={p.photo_url}
                          alt={`Service centre submitted by ${centre.agent_name} on ${format(new Date(p.created_at), 'dd MMM yyyy')}`}
                          loading="lazy"
                          className="h-40 w-full rounded-lg border border-border object-cover"
                        />
                        <span className="mt-1 block text-[10px] text-muted-foreground">
                          {format(new Date(p.created_at), 'dd MMM yyyy')} · {p.location_name || 'No description'}
                        </span>
                      </a>
                    ))}
                  </div>
                )}
              </div>

              <a
                href={mapsUrl(centre.latitude, centre.longitude)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <MapPin className="h-4 w-4" />Open in Google Maps<ExternalLink className="h-3 w-3" />
              </a>
            </TabsContent>

            <TabsContent value="agents">
              <AgentsTab centreId={centre.id} data={data} />
            </TabsContent>

            <TabsContent value="repayments" className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Kpi label="Today" value={formatUGX(Number(data?.repayment_totals.collected_today ?? 0))} />
                <Kpi label="Last 7 days" value={formatUGX(Number(data?.repayment_totals.collected_7d ?? 0))} />
                <Kpi label="Last 30 days" value={formatUGX(Number(data?.repayment_totals.collected_30d ?? 0))} />
                <Kpi label="All time" value={formatUGX(Number(data?.repayment_totals.collected_all ?? 0))} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {data?.repayment_totals.payments ?? 0} payments collected by this centre's agents ·{' '}
                {data?.repayment_totals.partial_payments ?? 0} partial
              </p>

              {(data?.repayment_history.length ?? 0) === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No rent repayments recorded yet.</p>
              ) : (
                <ScrollArea className="h-[320px] rounded-lg border border-border">
                  <div className="divide-y divide-border">
                    {data!.repayment_history.map((r) => (
                      <div key={r.id} className="flex items-start justify-between gap-2 p-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">{r.tenant_name}</p>
                          <p className="truncate text-[10px] text-muted-foreground">
                            {r.agent_name} · {format(new Date(r.created_at), 'dd MMM yyyy, HH:mm')}
                            {r.payment_method ? ` · ${r.payment_method.replace(/_/g, ' ')}` : ''}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-xs tabular-nums">{formatUGX(Number(r.amount))}</p>
                          {r.is_partial ? (
                            <p className="text-[10px] text-amber-600">
                              short {formatUGX(Number(r.shortfall_amount || 0))}
                            </p>
                          ) : (
                            <p className="flex items-center justify-end gap-1 text-[10px] text-emerald-600">
                              <CheckCircle2 className="h-3 w-3" />full
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>

            <TabsContent value="receivable" className="space-y-2">
              <ServiceCentreReceivablePanel
                serviceCentreId={centre.id}
                agents={(data?.assigned_agents ?? []).map((a) => ({ agent_id: a.agent_id, agent_name: a.agent_name }))}
                approvedAmount={data?.centre.cfo_approved_amount ?? data?.centre.verified_amount ?? null}
              />
            </TabsContent>

            <TabsContent value="advances" className="space-y-2">

              {(data?.advances.length ?? 0) === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No service centre advances attached to these agents.
                </p>
              ) : (
                data!.advances.map((a) => (
                  <div key={a.id} className="rounded-lg border border-border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-medium">{a.agent_name}</p>
                      <Badge variant="outline" className="shrink-0 text-[10px] capitalize">{a.status}</Badge>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground sm:grid-cols-4">
                      <span>Principal <span className="font-mono text-foreground">{formatUGX(Number(a.principal_amount))}</span></span>
                      <span>Recovered <span className="font-mono text-foreground">{formatUGX(Number(a.amount_recovered))}</span></span>
                      <span>Daily <span className="font-mono text-foreground">{formatUGX(Number(a.daily_deduction))}</span></span>
                      <span>{a.duration_days} days · {format(new Date(a.attached_at), 'dd MMM yyyy')}</span>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Assigned agents + the attach-more-agents picker. */
function AgentsTab({ centreId, data }: { centreId: string; data?: ReturnType<typeof useServiceCentre360>['data'] }) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');

  const { data: agents, isLoading } = useAssignableAgents(adding);
  const assign = useAssignServiceCentreAgents(centreId);
  const unassign = useUnassignServiceCentreAgent(centreId);

  const takenIds = useMemo(
    () => new Set([...(data?.assigned_agents.map((a) => a.agent_id) || []), data?.centre.agent_id].filter(Boolean) as string[]),
    [data],
  );

  const options = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (agents || [])
      .filter((a) => !takenIds.has(a.id))
      .filter((a) => !term || [a.full_name, a.phone].some((v) => (v || '').toLowerCase().includes(term)))
      .slice(0, 40);
  }, [agents, q, takenIds]);

  const submit = async () => {
    if (picked.length === 0) return;
    try {
      const res = await assign.mutateAsync({ agentIds: picked, note });
      toast.success(`${res.assigned} agent(s) assigned${res.skipped ? `, ${res.skipped} already attached` : ''}`);
      setPicked([]); setNote(''); setQ(''); setAdding(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not assign agents');
    }
  };

  const remove = async (assignmentId: string, name: string) => {
    const reason = window.prompt(`Reason for removing ${name} from this service centre?`) || '';
    if (reason === null) return;
    try {
      await unassign.mutateAsync({ assignmentId, reason });
      toast.success(`${name} removed from this service centre`);
    } catch (e: any) {
      toast.error(e?.message || 'Could not remove agent');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Users className="h-3.5 w-3.5" />Agents working from this centre
        </p>
        <Button size="sm" className="h-7 text-xs" onClick={() => setAdding((v) => !v)}>
          <UserPlus className="mr-1 h-3.5 w-3.5" />{adding ? 'Cancel' : 'Assign agents'}
        </Button>
      </div>

      {adding && (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search agent by name or phone"
              className="pl-9"
            />
          </div>

          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : options.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No matching agent available.</p>
          ) : (
            <ScrollArea className="h-[200px]">
              <div className="space-y-1 pr-2">
                {options.map((a) => {
                  const on = picked.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setPicked((p) => (on ? p.filter((x) => x !== a.id) : [...p, a.id]))}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg border p-2 text-left transition-colors',
                        on ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                      )}
                    >
                      <Avatar className="h-7 w-7 shrink-0">
                        <AvatarFallback className="text-[10px]">{initials(a.full_name || '')}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{a.full_name || 'Unnamed agent'}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{a.phone || '—'}</span>
                      </span>
                      {on && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          )}

          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. role or shift at this centre)"
            className="min-h-[60px] text-xs"
          />
          <Button size="sm" className="w-full" disabled={picked.length === 0 || assign.isPending} onClick={submit}>
            {assign.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Assign {picked.length || ''} agent{picked.length === 1 ? '' : 's'}
          </Button>
        </div>
      )}

      <div className="rounded-xl border border-border/60 bg-muted/30 p-2.5">
        <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          <Building2 className="h-3 w-3" />Centre owner
        </p>
        <p className="text-sm font-medium">{data?.centre.agent_name}</p>
        <p className="text-[10px] text-muted-foreground">{data?.centre.agent_phone || '—'}</p>
      </div>

      {(data?.assigned_agents.length ?? 0) === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No additional agents assigned yet.</p>
      ) : (
        <div className="space-y-2">
          {data!.assigned_agents.map((a) => (
            <div key={a.assignment_id} className="rounded-xl border border-border p-2.5">
              <div className="flex items-start gap-2">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="text-[10px]">{initials(a.agent_name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.agent_name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {a.agent_phone || '—'} · assigned {format(new Date(a.assigned_at), 'dd MMM yyyy')}
                    {a.assigned_by_name ? ` by ${a.assigned_by_name}` : ''}
                  </p>
                  {a.role_note && <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">{a.role_note}</p>}
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    30-day collections{' '}
                    <span className="font-mono text-foreground">{formatUGX(Number(a.collected_30d || 0))}</span> ·{' '}
                    {a.collections_30d} payments
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-[11px] text-destructive hover:text-destructive"
                  disabled={unassign.isPending}
                  onClick={() => remove(a.assignment_id, a.agent_name)}
                >
                  <UserMinus className="mr-1 h-3.5 w-3.5" />Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(data?.removed_agents.length ?? 0) > 0 && (
        <div className="space-y-1 pt-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Previously assigned</p>
          {data!.removed_agents.map((r) => (
            <p key={r.assignment_id} className="text-[11px] text-muted-foreground">
              {r.agent_name} — removed{' '}
              {r.unassigned_at ? format(new Date(r.unassigned_at), 'dd MMM yyyy') : '—'}
              {r.unassign_reason ? ` · ${r.unassign_reason}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="break-words text-sm">{value}</p>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-2">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono text-xs font-semibold tabular-nums">{value}</p>
    </div>
  );
}
