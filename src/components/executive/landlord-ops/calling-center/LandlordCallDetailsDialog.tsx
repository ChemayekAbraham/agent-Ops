import { useMemo, useState } from 'react';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Phone,
  MapPin,
  User,
  History,
  MessageSquare,
  Send,
  Calendar,
  ExternalLink,
  Smartphone,
  Clock,
  Building2,
} from 'lucide-react';
import { CcRow, type CcCallingHub } from '@/hooks/useCcCallingHub';
import { useCcSubjectCallHistory, type CcSubjectCall } from '@/hooks/useCcSubjectCallHistory';
import { LandlordContextPanel } from './LandlordContextPanel';
import { LandlordForwardConcernDialog } from './LandlordForwardConcernDialog';
import { LandlordTimelineDrawer } from './LandlordTimelineDrawer';
import { useLandlordRegistryEntry } from './useLandlordRegistryBatch';
import { CallingPausedNotice } from '@/components/executive/crm/call-centre/CallingPausedNotice';
import { useHumanCallingPaused } from '@/hooks/useCrmVoiceCall';
import { telHref, waHref } from '@/components/ops/calling/ccPhone';
import { formatUGX } from '@/lib/rentCalculations';
import { formatHumanLabel } from './ccUi';

export function LandlordCallDetailsDialog({
  row,
  subjectId,
  subjectName,
  subjectPhone,
  district,
  agentName,
  open,
  onOpenChange,
  onDialNow,
  hub,
}: {
  row?: CcRow | null;
  subjectId: string | null;
  subjectName?: string | null;
  subjectPhone?: string | null;
  district?: string | null;
  agentName?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDialNow?: (row: CcRow) => void;
  hub: CcCallingHub;
}) {
  const { data: pauseData } = useHumanCallingPaused();
  const callingPaused = !!pauseData?.paused;

  const history = useCcSubjectCallHistory('landlord', subjectId, open);
  const registryQuery = useLandlordRegistryEntry(subjectId, open && Boolean(subjectId));
  const registry = registryQuery.data;

  const [forwarding, setForwarding] = useState<CcSubjectCall | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const pastCalls = history.data ?? [];
  const lastCall = pastCalls[0] ?? null;
  const engagedCount = useMemo(
    () => pastCalls.filter((c) => c.outcome === 'engaged').length,
    [pastCalls],
  );

  if (!subjectId) return null;

  const displayName = subjectName || row?.name || registry?.full_name || 'Landlord';
  const displayDistrict = district ?? row?.district ?? registry?.district ?? null;
  const displayAgent = agentName ?? row?.linked_agent ?? registry?.registering_agent_name ?? null;
  const displayPhone = subjectPhone || registry?.phones?.[0] || null;

  const hasLinkedUserAccount = Boolean(registry?.user_id);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader className="space-y-2 text-left">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <DialogTitle className="text-base sm:text-lg font-bold flex items-center gap-2 flex-wrap">
                  <Building2 className="h-4 w-4 text-primary shrink-0" />
                  <span className="truncate">{displayName}</span>
                  {row?.state && (
                    <Badge variant="outline" className="text-[10px]">
                      {formatHumanLabel(row.state)}
                    </Badge>
                  )}
                  {!hasLinkedUserAccount && (
                    <Badge variant="secondary" className="text-[10px]">
                      Handset / WhatsApp Only
                    </Badge>
                  )}
                </DialogTitle>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
                  {displayPhone && (
                    <span className="inline-flex items-center gap-1 font-mono">
                      <Phone className="h-3 w-3" /> {displayPhone}
                    </span>
                  )}
                  {displayDistrict && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> {displayDistrict}
                    </span>
                  )}
                  {displayAgent && (
                    <span className="inline-flex items-center gap-1">
                      <User className="h-3 w-3" /> Agent: {displayAgent}
                    </span>
                  )}
                  {row?.metric_label && (
                    <span>
                      {row.metric_label}:{' '}
                      <strong className="text-foreground">
                        {formatUGX(Number(row.metric_value ?? 0))}
                      </strong>
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setTimelineOpen(true)}
                >
                  <Clock className="h-3.5 w-3.5" /> Call Timeline
                </Button>

                {displayPhone && !displayPhone.includes('*') && (
                  <>
                    <Button size="sm" variant="outline" asChild className="gap-1">
                      <a href={telHref(displayPhone)}>
                        <Smartphone className="h-3.5 w-3.5" /> Handset
                      </a>
                    </Button>
                    <Button size="sm" variant="outline" asChild className="gap-1">
                      <a href={waHref(displayPhone)} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" /> WhatsApp
                      </a>
                    </Button>
                  </>
                )}

                {row && onDialNow && !callingPaused && hasLinkedUserAccount && (
                  <Button
                    size="sm"
                    onClick={() => {
                      onOpenChange(false);
                      onDialNow(row);
                    }}
                    className="gap-1.5 shrink-0"
                  >
                    <Phone className="h-3.5 w-3.5" />
                    {pastCalls.length > 0 ? 'Call Landlord Again' : 'Call Landlord Now'}
                  </Button>
                )}

                {row && onDialNow && !hasLinkedUserAccount && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onOpenChange(false);
                      onDialNow(row);
                    }}
                    className="gap-1.5 shrink-0"
                  >
                    <Smartphone className="h-3.5 w-3.5" />
                    Reveal Phone & Dial (Handset / WhatsApp)
                  </Button>
                )}
              </div>
            </div>

            <CallingPausedNotice />

            {/* Quick past-call summary strip */}
            <div className="grid grid-cols-3 gap-2 pt-2">
              <div className="rounded-md border bg-muted/30 p-2 text-xs">
                <div className="text-[10px] uppercase text-muted-foreground">Times Called</div>
                <div className="text-base font-bold tabular-nums">{pastCalls.length}</div>
              </div>
              <div className="rounded-md border bg-muted/30 p-2 text-xs">
                <div className="text-[10px] uppercase text-muted-foreground">Engaged Calls</div>
                <div className="text-base font-bold tabular-nums text-emerald-600">
                  {engagedCount}
                </div>
              </div>
              <div className="rounded-md border bg-muted/30 p-2 text-xs">
                <div className="text-[10px] uppercase text-muted-foreground">Last Called</div>
                <div className="text-xs font-semibold truncate">
                  {lastCall
                    ? formatDistanceToNow(new Date(lastCall.recordedAt || lastCall.revealedAt), {
                        addSuffix: true,
                      })
                    : registry?.last_called_at
                      ? formatDistanceToNow(new Date(registry.last_called_at), { addSuffix: true })
                      : 'Never called'}
                </div>
              </div>
            </div>
          </DialogHeader>

          <Tabs defaultValue="dossier" className="mt-2">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="dossier" className="text-xs gap-1.5">
                <Building2 className="h-3.5 w-3.5" /> Landlord Panel (Houses, Rent Plans & Payouts)
              </TabsTrigger>
              <TabsTrigger value="history" className="text-xs gap-1.5">
                <History className="h-3.5 w-3.5" /> Calling Center Logs ({pastCalls.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="dossier" className="mt-3">
              <LandlordContextPanel
                subjectId={subjectId}
                fallbackName={displayName}
                fallbackPhone={displayPhone}
                fallbackDistrict={displayDistrict}
                fallbackAgentName={displayAgent}
                onOpenTimeline={() => setTimelineOpen(true)}
              />
            </TabsContent>

            <TabsContent value="history" className="mt-3 space-y-2">
              {history.isLoading && (
                <div className="text-xs text-muted-foreground py-6 text-center">
                  Loading call history…
                </div>
              )}
              {!history.isLoading && pastCalls.length === 0 && (
                <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                  No Calling Center calls recorded for this landlord yet. Click "Call Timeline" above to check Awareness and Verification calls.
                </div>
              )}
              {pastCalls.map((c) => {
                const when = c.recordedAt || c.revealedAt;
                return (
                  <div key={c.id} className="rounded-lg border bg-card p-3 space-y-1.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge
                          variant={c.outcome === 'engaged' ? 'default' : 'outline'}
                          className="text-[10px]"
                        >
                          {formatHumanLabel(c.outcome || 'open')}
                        </Badge>
                        {c.categoryLabel && (
                          <Badge variant="outline" className="text-[10px]">
                            {c.categoryLabel}
                          </Badge>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(when), 'dd MMM yyyy, HH:mm')} (
                        {formatDistanceToNow(new Date(when), { addSuffix: true })})
                      </span>
                    </div>

                    <div className="text-[11px] text-muted-foreground">
                      Called by <strong className="text-foreground">{c.officerName ?? 'Staff'}</strong>
                    </div>

                    {c.comment ? (
                      <div className="rounded bg-muted/40 p-2 text-foreground whitespace-pre-wrap flex items-start gap-1.5">
                        <MessageSquare className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                        <span>{c.comment}</span>
                      </div>
                    ) : (
                      <div className="text-[11px] italic text-muted-foreground">
                        No written feedback recorded.
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-1.5 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={() => setForwarding(c)}
                      >
                        <Send className="h-3 w-3" /> Forward for Review
                      </Button>
                    </div>
                  </div>
                );
              })}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {forwarding && (
        <LandlordForwardConcernDialog
          open={Boolean(forwarding)}
          onOpenChange={(v) => !v && setForwarding(null)}
          defaultSubjectId={subjectId}
          defaultSubjectName={displayName}
          defaultSubjectPhone={displayPhone}
          defaultDistrict={displayDistrict}
          defaultAgentName={displayAgent}
          defaultSummary={`Call follow-up: ${displayName} (${formatHumanLabel(forwarding.categoryLabel || forwarding.outcome)})`}
          defaultDetails={forwarding.comment}
          feedbackId={forwarding.feedbackId}
        />
      )}

      <LandlordTimelineDrawer
        open={timelineOpen}
        onOpenChange={setTimelineOpen}
        subjectId={subjectId}
        landlordId={registry?.landlord_id ?? subjectId}
        userId={registry?.user_id ?? null}
        landlordName={displayName}
        phones={registry?.phones ?? (displayPhone ? [displayPhone] : null)}
      />
    </>
  );
}
