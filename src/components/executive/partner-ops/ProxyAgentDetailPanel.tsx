/**
 * ProxyAgentDetailPanel — full proxy agent profile rendered as an inline
 * section (no route change, no sheet): bio data, promissory notes,
 * partners under them (status + support type), earning history, plus the
 * revoke / transfer controls. One RPC per open (no N+1).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
  CalendarDays,
  FileText,
  Handshake,
  Loader2,
  Mail,
  MapPin,
  Percent,
  Phone,
  ShieldOff,
  TrendingUp,
  UserCog,
  Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  fetchProxyDetail,
  proxyInitials,
  proxyStatusTone,
  PROXY_SOURCE_LABELS,
  supportTypeLabel,
  type ProxyDirRow,
} from './proxyAgentDirectory';

const TAB_CLS =
  'text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm';

interface Props {
  agent: ProxyDirRow;
  /** Other proxy agents already loaded by the directory — reused as transfer
   *  targets so the panel needs no extra query. */
  transferTargets: ProxyDirRow[];
  onBack: () => void;
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={cn('mt-1 text-base font-bold tabular-nums', tone)}>{value}</p>
    </div>
  );
}

function BioRow({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b py-2 last:border-0">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="text-right text-xs font-semibold">{value || '—'}</span>
    </div>
  );
}

export function ProxyAgentDetailPanel({ agent, transferTargets, onBack }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [transferTo, setTransferTo] = useState('');

  const detail = useQuery({
    queryKey: ['proxy-agent-detail', agent.agent_user_id],
    enabled: !!agent.agent_user_id,
    queryFn: () => fetchProxyDetail(agent.agent_user_id),
    staleTime: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['proxy-agent-directory'] });
    qc.invalidateQueries({ queryKey: ['proxy-agent-detail'] });
  };

  const revoke = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('partner_ops_decide_proxy_agent', {
        p_agent_user_id: agent.agent_user_id,
        p_decision: 'suspended',
        p_notes: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Proxy rights revoked', description: 'The agent can no longer act as a proxy.' });
      setReason('');
      invalidate();
    },
    onError: (e: any) => toast({ title: 'Could not revoke', description: e.message, variant: 'destructive' }),
  });

  const transfer = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_transfer_proxy_book', {
        p_from_agent_id: agent.agent_user_id,
        p_to_agent_id: transferTo,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (res) => {
      toast({
        title: 'Book transferred',
        description: `${res?.assignments_moved ?? 0} partner link(s), ${res?.notes_moved ?? 0} note(s) moved.`,
      });
      setReason('');
      setTransferTo('');
      invalidate();
    },
    onError: (e: any) => toast({ title: 'Transfer failed', description: e.message, variant: 'destructive' }),
  });

  const bio = detail.data?.bio;
  const partners = detail.data?.partners ?? [];
  const notes = detail.data?.notes ?? [];
  const earnings = detail.data?.earnings ?? [];

  const noteTotals = useMemo(() => {
    let pending = 0;
    let pendingAmount = 0;
    let activated = 0;
    let activatedAmount = 0;
    for (const n of notes) {
      if (n.status === 'activated') {
        activated += 1;
        activatedAmount += Number(n.amount || 0);
      } else {
        pending += 1;
        pendingAmount += Number(n.amount || 0);
      }
    }
    return { pending, pendingAmount, activated, activatedAmount };
  }, [notes]);

  const reasonOk = reason.trim().length >= 10;
  const targets = transferTargets.filter(
    (t) => t.agent_user_id !== agent.agent_user_id && t.status === 'approved',
  );

  return (
    <div className="animate-in fade-in slide-in-from-right-2 duration-200">
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to directory
        </Button>
        <span className="text-xs font-semibold text-muted-foreground">Proxy agent profile</span>
      </div>

        {detail.isLoading && (
          <div className="space-y-3 py-4">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        )}

        {bio && (
          <div className="space-y-4 pb-10">
            {/* Identity banner */}
            <Card className="overflow-hidden">
              <CardContent className="flex items-center gap-3 p-4">
                <Avatar className="h-14 w-14 border">
                  <AvatarImage src={bio.avatar_url ?? undefined} alt={bio.name} />
                  <AvatarFallback className="text-sm font-bold">{proxyInitials(bio.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{bio.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {bio.phone || '—'} {bio.email ? `· ${bio.email}` : ''}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className={cn('text-[10px]', proxyStatusTone(bio.status))}>
                      {bio.status}
                    </Badge>
                    {bio.invite_code && (
                      <Badge variant="secondary" className="text-[10px] font-mono">{bio.invite_code}</Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Headline numbers */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat icon={Users} label="Partners" value={String(partners.length)} />
              <Stat
                icon={Handshake}
                label="Came in"
                value={String(partners.filter((p) => p.came_in).length)}
                tone="text-emerald-600"
              />
              <Stat icon={FileText} label="Notes pending" value={String(noteTotals.pending)} tone="text-amber-600" />
              <Stat
                icon={TrendingUp}
                label="Earned"
                value={formatUGX(Number(detail.data?.earnings_total || 0))}
              />
            </div>

            <Tabs defaultValue="bio">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="bio" className={TAB_CLS}>Bio</TabsTrigger>
                <TabsTrigger value="notes" className={TAB_CLS}>Notes ({notes.length})</TabsTrigger>
                <TabsTrigger value="partners" className={TAB_CLS}>Partners ({partners.length})</TabsTrigger>
                <TabsTrigger value="earnings" className={TAB_CLS}>Earnings</TabsTrigger>
              </TabsList>

              <TabsContent value="bio" className="mt-3">
                <Card>
                  <CardContent className="p-4">
                    <BioRow icon={Phone} label="Phone" value={bio.phone} />
                    <BioRow icon={Mail} label="Email" value={bio.email} />
                    <BioRow icon={MapPin} label="District" value={bio.district} />
                    <BioRow icon={BadgeCheck} label="National ID / NIN" value={bio.national_id || bio.nin} />
                    <BioRow
                      icon={CalendarDays}
                      label="Joined"
                      value={bio.joined_at ? format(new Date(bio.joined_at), 'dd MMM yyyy') : null}
                    />
                    <BioRow
                      icon={ShieldOff}
                      label="Proxy approved"
                      value={bio.approved_at ? format(new Date(bio.approved_at), 'dd MMM yyyy') : null}
                    />
                    <BioRow icon={UserCog} label="Referred by" value={bio.referrer_name} />
                    <BioRow icon={Building2} label="Partner lead" value={bio.lead_name} />
                    {bio.review_notes && (
                      <p className="mt-2 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground">
                        {bio.review_notes}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="notes" className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Stat
                    icon={FileText}
                    label="Pending volume"
                    value={formatUGX(noteTotals.pendingAmount)}
                    tone="text-amber-600"
                  />
                  <Stat
                    icon={BadgeCheck}
                    label="Came in volume"
                    value={formatUGX(noteTotals.activatedAmount)}
                    tone="text-emerald-600"
                  />
                </div>
                {notes.length === 0 && (
                  <p className="py-6 text-center text-xs text-muted-foreground">No promissory notes yet.</p>
                )}
                {notes.map((n) => (
                  <div key={n.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{n.partner_name || 'Unnamed partner'}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {n.phone || '—'} · {format(new Date(n.created_at), 'dd MMM yyyy')}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-bold tabular-nums">{formatUGX(Number(n.amount || 0))}</p>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px]',
                          n.status === 'activated'
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                            : 'border-amber-500/40 bg-amber-500/10 text-amber-600',
                        )}
                      >
                        {n.status === 'activated' ? 'Came in' : 'Pending'}
                      </Badge>
                    </div>
                  </div>
                ))}
              </TabsContent>

              <TabsContent value="partners" className="mt-3 space-y-2">
                {partners.length === 0 && (
                  <p className="py-6 text-center text-xs text-muted-foreground">No partners linked yet.</p>
                )}
                {partners.map((p) => (
                  <div key={p.partner_user_id} className="rounded-xl border p-3">
                    <div className="flex items-center gap-2">
                      <Avatar className="h-8 w-8 border">
                        <AvatarImage src={p.avatar_url ?? undefined} alt={p.partner_name} />
                        <AvatarFallback className="text-[10px]">{proxyInitials(p.partner_name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">{p.partner_name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{p.partner_phone || '—'}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs font-bold tabular-nums">{formatUGX(Number(p.total_funded || 0))}</p>
                        <p className="text-[10px] text-muted-foreground">{p.portfolios} portfolio(s)</p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px]',
                          p.support_type === 'self_support'
                            ? 'border-sky-500/40 bg-sky-500/10 text-sky-600'
                            : 'border-violet-500/40 bg-violet-500/10 text-violet-600',
                        )}
                      >
                        {supportTypeLabel(p.support_type)}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px]',
                          p.came_in
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                            : 'border-muted text-muted-foreground',
                        )}
                      >
                        {p.came_in ? 'Came in' : 'Not yet'}
                      </Badge>
                      {p.portfolio_status && (
                        <Badge variant="secondary" className="text-[10px]">{p.portfolio_status}</Badge>
                      )}
                      {(p.sources ?? []).map((s) => (
                        <Badge key={s} variant="outline" className="text-[10px]">
                          {PROXY_SOURCE_LABELS[s] ?? s}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </TabsContent>

              <TabsContent value="earnings" className="mt-3 space-y-2">
                {earnings.length === 0 && (
                  <p className="py-6 text-center text-xs text-muted-foreground">No commission earnings recorded.</p>
                )}
                {earnings.map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-xs font-semibold">
                        <Percent className="h-3.5 w-3.5 text-muted-foreground" />
                        {e.category.replace(/_/g, ' ')}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {format(new Date(e.transaction_date), 'dd MMM yyyy')}
                        {e.linked_party ? ` · ${e.linked_party}` : ''}
                      </p>
                    </div>
                    <p className="shrink-0 text-xs font-bold tabular-nums text-emerald-600">
                      +{formatUGX(Number(e.amount || 0))}
                    </p>
                  </div>
                ))}
              </TabsContent>
            </Tabs>

            {/* Controls */}
            <Card className="border-destructive/30">
              <CardContent className="space-y-3 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  Proxy rights & handover
                </p>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (minimum 10 characters) — stored on the audit trail"
                  className="min-h-[70px] text-xs"
                />
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select value={transferTo} onValueChange={setTransferTo}>
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue placeholder="Transfer book to another proxy agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((t) => (
                        <SelectItem key={t.agent_user_id} value={t.agent_user_id} className="text-xs">
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-9 shrink-0 text-xs"
                    disabled={!reasonOk || !transferTo || transfer.isPending}
                    onClick={() => transfer.mutate()}
                  >
                    {transfer.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Transfer
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-9 w-full text-xs"
                  disabled={!reasonOk || revoke.isPending || bio.status !== 'approved'}
                  onClick={() => revoke.mutate()}
                >
                  {revoke.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldOff className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Revoke proxy rights
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
    </div>
  );
}

export default ProxyAgentDetailPanel;
