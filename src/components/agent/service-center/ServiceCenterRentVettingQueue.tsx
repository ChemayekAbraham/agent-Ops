import { useState } from 'react';
import { VettingAgeChip } from '@/components/service-center/VettingAgeChip';
import { vettingClockAt } from '@/lib/vettingOverdueCopy';
import { useOverdueVettingAlert } from '@/hooks/useOverdueVettingAlert';
import { vetRowId } from '@/components/service-center/vettingNav';
import { CheckCircle2, ClipboardCheck, Eye, Loader2, MapPin, Phone, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { HouseDetailsDialog } from '@/components/agent/service-center/HouseDetailsDialog';
import {
  ServiceCenterQueueRequest,
  useServiceCenterRentQueue,
  useServiceCenterReviewRentRequest,
} from '@/hooks/useServiceCenterRentQueue';
import { matchesVettingQuery } from '@/components/agent/service-center/matchesVettingQuery';
import { AwarenessCallPanel } from '@/components/pipeline/AwarenessCallPanel';
import { AwarenessCallBadge } from '@/components/pipeline/AwarenessCallBadge';
import { MyAwarenessCallsCard } from '@/components/pipeline/MyAwarenessCallsCard';
import { useAwarenessCallStatus } from '@/hooks/useAwarenessCallStatus';
import { useCriticalFlow } from '@/hooks/useCriticalFlow';
import { hasNoCallAtStage } from '@/lib/awarenessCallStatus';

/**
 * Service Center vetting queue — the first gate a sub-agent rent request passes
 * before it enters the operations pipeline. Only shown to agents the backend has
 * tagged as Service Center managers.
 */
export function ServiceCenterRentVettingQueue({ searchQuery = '' }: { searchQuery?: string } = {}) {
  const { data, isLoading, error } = useServiceCenterRentQueue();
  const { data: vetPolicy } = useOverdueVettingAlert({ suppressed: true });
  const review = useServiceCenterReviewRentRequest();
  const { toast } = useToast();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [detailsReq, setDetailsReq] = useState<ServiceCenterQueueRequest | null>(null);
  const [noCallOnly, setNoCallOnly] = useState(false);

  // One batched read for the whole queue tells every card whether it has been called; the cards no longer read their own history
  // unless the batch says there is something to show.
  const callStatus = useAwarenessCallStatus((data?.pending ?? []).map((r) => r.id));

  // A comment typed for a decision that has not been sent is unsent work: nothing may interrupt it.
  useCriticalFlow('service-centre-comment', Object.values(comments).some((c) => c.trim().length > 0));

  /** Ops reads this comment during final verification, so it is never optional. */
  const MIN_COMMENT = 10;
  const commentFor = (id: string) => (comments[id] ?? '').trim();

  const act = async (req: ServiceCenterQueueRequest, decision: 'verify' | 'reject', comment?: string) => {
    setBusyId(req.id);
    try {
      await review.mutateAsync({ requestId: req.id, decision, comment });
      toast({
        title: decision === 'verify' ? 'Verified' : 'Declined',
        description:
          decision === 'verify'
            ? `${req.tenant_name ?? 'Tenant'} moved on to Agent Ops review.`
            : `${req.tenant_name ?? 'Tenant'} was returned to ${req.agent_name ?? 'the sub-agent'}.`,
      });
      setComments((prev) => { const next = { ...prev }; delete next[req.id]; return next; });
    } catch (e: any) {
      toast({ title: 'Could not save', description: e?.message ?? 'Please try again.', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) {
    return <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}</div>;
  }

  if (error) {
    return (
      <Card><CardContent className="p-6 text-sm text-destructive">
        Could not load your vetting queue. Please try again.
      </CardContent></Card>
    );
  }

  // Managers see the queue. A non-tagged agent still sees anything already routed
  // to them (e.g. tagged then revoked) so nothing is ever stranded.
  if (!data?.is_service_center_manager && !(data?.pending_count ?? 0)) {
    return (
      <Card><CardContent className="space-y-1 p-6 text-center">
        <p className="text-sm font-semibold text-foreground">Not a Service Center manager yet</p>
        <p className="text-xs text-muted-foreground">
          Once you qualify and are tagged as a Service Center manager, every rent request your
          sub-agents submit will land here for your verification before it enters the pipeline.
        </p>
      </CardContent></Card>
    );
  }

  const noCallCount = (data.pending ?? []).filter((req) => hasNoCallAtStage(callStatus.byId.get(req.id))).length;
  const pending = (data.pending ?? [])
    .filter((req) =>
      matchesVettingQuery(searchQuery, req.agent_name, req.agent_phone, req.tenant_name, req.tenant_phone, req.landlord_name, req.request_city),
    )
    .filter((req) => !(noCallOnly && callStatus.loaded) || hasNoCallAtStage(callStatus.byId.get(req.id)));
  const recentReviewed = (data.recent_reviewed ?? []).filter((r) =>
    matchesVettingQuery(searchQuery, r.agent_name, r.tenant_name),
  );

  return (
    <div className="space-y-3">
      <MyAwarenessCallsCard />

      <div className="flex flex-wrap items-center gap-2">
        <ClipboardCheck className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Awaiting your verification</span>
        <Badge variant="outline" className="text-[10px]">{pending.length}</Badge>
        {callStatus.loaded && (
          <Button
            type="button"
            variant={noCallOnly ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={noCallOnly}
            onClick={() => setNoCallOnly((v) => !v)}
            className="ml-auto h-7 gap-1 px-2 text-[11px]"
          >
            No call yet ({noCallCount})
          </Button>
        )}
      </div>

      {pending.length === 0 ? (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
          {searchQuery.trim()
            ? 'No requests match that search.'
            : 'No sub-agent rent requests are waiting for your verification.'}
        </CardContent></Card>
      ) : (
        pending.map((req) => (
          <Card key={req.id} id={vetRowId('rent_plan', req.id)}>
            <CardContent className="space-y-3 p-3">

              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold leading-tight text-foreground">{req.tenant_name ?? 'Tenant'}</p>
                  <p className="break-words text-[11px] text-muted-foreground">
                    Submitted by {req.agent_name ?? 'sub-agent'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  <VettingAgeChip createdAt={vettingClockAt(req.created_at, vetPolicy?.effective_from)} warnHours={vetPolicy?.warn_hours} overdueHours={vetPolicy?.overdue_hours} />
                  <AwarenessCallBadge status={callStatus.byId.get(req.id)} />
                  <Badge variant="outline" className="w-fit shrink-0 text-[10px]">Service Center review</Badge>
                </div>
              </div>


              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] leading-tight text-muted-foreground">
                <span className="break-words">Rent: <strong className="text-foreground">{formatUGX(Number(req.rent_amount || 0))}</strong></span>
                <span className="break-words">Daily: <strong className="text-foreground">{formatUGX(Number(req.daily_repayment || 0))}</strong></span>
                <span className="break-words">Duration: <strong className="text-foreground">{req.duration_days ?? '—'} days</strong></span>
                <span className="inline-flex items-center gap-1 break-words">
                  <MapPin className="h-3 w-3 shrink-0" /> <span className="break-words">{req.request_city ?? '—'}</span>
                </span>
                {req.tenant_phone && (
                  <span className="inline-flex items-center gap-1 break-words">
                    <Phone className="h-3 w-3 shrink-0" /> <span className="break-words">{req.tenant_phone}</span>
                  </span>
                )}
                {req.landlord_name && <span className="break-words">Landlord: {req.landlord_name}</span>}
              </div>


              <button type="button" onClick={() => setDetailsReq(req)} className="w-full text-left">
                {!!req.house_image_urls?.length && (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {req.house_image_urls.slice(0, 6).map((url, i) => (
                      <img
                        key={`${req.id}-${i}`}
                        src={url}
                        alt={`House photo ${i + 1} for ${req.tenant_name ?? 'tenant'}`}
                        loading="lazy"
                        className="h-16 w-24 shrink-0 rounded-md object-cover"
                      />
                    ))}
                  </div>
                )}
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
                  <Eye className="h-3 w-3" /> View house photos &amp; full details
                  {req.house_image_urls?.length ? ` (${req.house_image_urls.length})` : ''}
                </span>
              </button>

              {/* Awareness call: phone the tenant and record what they heard. Storage only; vetting below is unchanged. */}
              <AwarenessCallPanel
                request={req}
                defaultSubject="tenant"
                knownCalls={callStatus.loaded ? callStatus.byId.get(req.id) : callStatus.isError ? undefined : null}
              />

              <div className="space-y-2">
                <Textarea
                  value={comments[req.id] ?? ''}
                  onChange={(e) => setComments((prev) => ({ ...prev, [req.id]: e.target.value }))}
                  placeholder="Your comment (required) — what you checked, or what the agent must fix. Agent Ops will read this."
                  rows={2}
                  className="text-xs"
                />
                <p className="text-[10px] text-muted-foreground">
                  {commentFor(req.id).length < MIN_COMMENT
                    ? `Write at least ${MIN_COMMENT} characters to verify or decline (${commentFor(req.id).length}/${MIN_COMMENT}).`
                    : 'Comment saved with your decision for Agent Ops.'}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    size="sm"
                    className="flex-1 text-xs"
                    disabled={busyId === req.id || commentFor(req.id).length < MIN_COMMENT}
                    onClick={() => act(req, 'verify', commentFor(req.id))}
                  >
                    {busyId === req.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                    Verify &amp; send to Agent Ops
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 text-xs"
                    disabled={busyId === req.id || commentFor(req.id).length < MIN_COMMENT}
                    onClick={() => act(req, 'reject', commentFor(req.id))}
                  >
                    <XCircle className="mr-1 h-3.5 w-3.5" /> Decline
                  </Button>
                </div>
              </div>

            </CardContent>
          </Card>
        ))
      )}

      {!!recentReviewed.length && (
        <div className="space-y-2 pt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recently reviewed</p>
          {recentReviewed.map((r) => (
            <Card key={r.id}>
              <CardContent className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{r.tenant_name ?? 'Tenant'}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.agent_name ?? 'Sub-agent'} · {formatUGX(Number(r.rent_amount || 0))}
                  </p>
                  {r.service_center_comment && (
                    <p className="truncate text-xs text-muted-foreground">Note: {r.service_center_comment}</p>
                  )}
                </div>
                <Badge variant={r.status === 'rejected' ? 'destructive' : 'default'} className="shrink-0 text-[10px]">
                  {r.status === 'rejected' ? 'Declined' : 'Verified'}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <HouseDetailsDialog
        open={!!detailsReq}
        onOpenChange={(v) => { if (!v) setDetailsReq(null); }}
        title={detailsReq ? `${detailsReq.tenant_name ?? 'Tenant'} — house` : null}
        images={detailsReq?.house_image_urls}
        extras={[
          { label: 'Tenant', value: detailsReq?.tenant_name },
          { label: 'Tenant phone', value: detailsReq?.tenant_phone },
          { label: 'Submitted by', value: detailsReq?.agent_name },
          { label: 'Agent phone', value: detailsReq?.agent_phone },
          { label: 'Landlord', value: detailsReq?.landlord_name },
          { label: 'Landlord phone', value: detailsReq?.landlord_phone },
          { label: 'House type', value: detailsReq?.house_category ? String(detailsReq.house_category).replace(/_/g, ' ') : null },
          { label: 'Location', value: detailsReq?.request_city },
          { label: 'Rent', value: detailsReq ? formatUGX(Number(detailsReq.rent_amount || 0)) : null },
          { label: 'Daily repayment', value: detailsReq?.daily_repayment ? formatUGX(Number(detailsReq.daily_repayment)) : null },
          { label: 'Total repayment', value: detailsReq?.total_repayment ? formatUGX(Number(detailsReq.total_repayment)) : null },
          { label: 'Duration', value: detailsReq?.duration_days ? `${detailsReq.duration_days} days` : null },
          { label: 'Submitted', value: detailsReq?.created_at ? new Date(detailsReq.created_at).toLocaleString() : null },
        ]}
      />
    </div>
  );
}
