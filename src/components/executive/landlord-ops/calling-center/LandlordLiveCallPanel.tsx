import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  SkipForward,
  CheckCircle2,
  Clock,
  ExternalLink,
  AlertCircle,
  Send,
  Smartphone,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  QUICK_OUTCOMES,
  ccErrorText,
  type CcCallingHub,
} from '@/hooks/useCcCallingHub';
import { isTerminalCallState, type CallState } from '@/hooks/useCrmVoiceCall';
import { formatTalkTime } from '@/lib/callCentre';
import { telHref, waHref } from '@/components/ops/calling/ccPhone';
import { CallingPausedNotice } from '@/components/executive/crm/call-centre/CallingPausedNotice';
import { RecordOutcomeDialog } from '@/components/ops/calling/RecordOutcomeDialog';
import { formatUGX } from '@/lib/rentCalculations';
import { LandlordContextPanel } from './LandlordContextPanel';
import { LandlordTimelineDrawer } from './LandlordTimelineDrawer';
import { LandlordForwardConcernDialog } from './LandlordForwardConcernDialog';
import type { LandlordCallCenterDialer } from './useLandlordCallCenterDialer';
import { formatHumanLabel } from './ccUi';

const STATE_LABEL: Record<CallState, string> = {
  idle: 'Ready to call',
  initializing: 'Connecting to voice service…',
  calling: 'Calling…',
  ringing: 'Ringing…',
  connected: 'Connected',
  ending: 'Ending…',
  completed: 'Call ended',
  cancelled: 'Call cancelled',
  rejected: 'Call rejected',
  busy: 'Landlord busy',
  no_answer: 'No answer',
  failed: 'Call failed',
};

export function LandlordLiveCallPanel({
  hub,
  dialer,
}: {
  hub: CcCallingHub;
  dialer: LandlordCallCenterDialer;
}) {
  const { call, callingPaused, current, needsOutcome, autoAdvance, setAutoAdvance } = dialer;
  const [outcomeAttempt, setOutcomeAttempt] = useState<{
    id: string;
    cycle_row_id: string;
    name: string;
  } | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const pendingCount =
    (hub.counts?.to_call ?? 0) + (hub.counts?.unreachable ?? 0) + (hub.counts?.callback ?? 0);

  const handleQuickOutcome = (
    outcome: (typeof QUICK_OUTCOMES)[number]['value'],
    label: string,
  ) => {
    if (!current) return;
    dialer.hangUp();
    hub.recordQuick.mutate(
      { attemptId: current.attemptId, outcome },
      {
        onSuccess: () => {
          toast.success(`Recorded: ${label}`);
          dialer.advanceAfterOutcome();
        },
        onError: (e) => toast.error(ccErrorText(e)),
      },
    );
  };

  if (!current) {
    return (
      <Card className="p-6 text-center space-y-3">
        <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center">
          <Phone className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-base font-semibold">Ready to Call Landlords</h3>
          <p className="text-xs text-muted-foreground max-w-md mx-auto mt-1">
            Start the next pending landlord in the active round, or pick any landlord from the{' '}
            <strong>Work Queue</strong> tab. Landlords with a linked user account connect in-browser; others offer instant Handset & WhatsApp dialing.
          </p>
        </div>
        {callingPaused ? (
          <div className="max-w-md mx-auto">
            <CallingPausedNotice />
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3 pt-1 flex-wrap">
            <Button
              size="sm"
              onClick={() => void dialer.dialNextPending()}
              disabled={dialer.isRevealing || pendingCount === 0}
              className="gap-1.5"
            >
              <Phone className="h-4 w-4" />
              Start Calling ({pendingCount} pending)
            </Button>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <Switch checked={autoAdvance} onCheckedChange={setAutoAdvance} />
              Auto-dial next after outcome
            </label>
          </div>
        )}
      </Card>
    );
  }

  const isLive = !isTerminalCallState(call.state) && call.state !== 'idle';
  const canInAppCall = Boolean(current.userId) && !callingPaused;

  return (
    <div className="space-y-3">
      <CallingPausedNotice />

      <Card className="p-4 border-primary/40 bg-gradient-to-br from-primary/5 via-background to-background space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-base truncate">{current.name}</span>
              {current.handsetOnly || !current.userId ? (
                <Badge variant="secondary" className="text-[10px] gap-1">
                  <Smartphone className="h-3 w-3" />
                  {current.userId
                    ? 'Handset / WhatsApp Mode'
                    : 'No Linked User Account — Handset / WhatsApp Only'}
                </Badge>
              ) : (
                <Badge
                  variant={call.state === 'connected' ? 'default' : 'secondary'}
                  className="text-[10px]"
                >
                  {STATE_LABEL[call.state] ?? formatHumanLabel(call.state)}
                </Badge>
              )}
              {call.state === 'connected' && (
                <span className="font-mono text-xs text-emerald-600 flex items-center gap-1">
                  <Clock className="h-3 w-3" /> {formatTalkTime(call.elapsed)}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
              {current.phone && <span className="font-mono text-foreground">{current.phone}</span>}
              {current.region && <span>Region: {current.region}</span>}
              {current.district && <span>District: {current.district}</span>}
              {current.agentName && <span>Agent: {current.agentName}</span>}
              {current.metricValue != null && Number(current.metricValue) > 0 && (
                <span>
                  Rent Plan Value:{' '}
                  <strong className="text-foreground">
                    {formatUGX(Number(current.metricValue))}
                  </strong>
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {!callingPaused && (
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                <Switch checked={autoAdvance} onCheckedChange={setAutoAdvance} />
                Auto-next
              </label>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTimelineOpen(true)}
              className="h-8 text-xs gap-1"
            >
              <Clock className="h-3.5 w-3.5" /> Call Timeline
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setForwardOpen(true)}
              className="h-8 text-xs gap-1"
            >
              <Send className="h-3 w-3" /> Forward Issue
            </Button>
          </div>
        </div>

        {/* Audio & line controls */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
          {canInAppCall && (
            <>
              <Button
                size="sm"
                variant={call.muted ? 'destructive' : 'outline'}
                onClick={call.toggleMute}
                disabled={!isLive}
                className="gap-1.5 h-8 text-xs"
              >
                {call.muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {call.muted ? 'Muted' : 'Mute'}
              </Button>
              {isLive ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={dialer.hangUp}
                  className="gap-1.5 h-8 text-xs"
                >
                  <PhoneOff className="h-3.5 w-3.5" /> End Call
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    if (!current.userId || !current.phone) return;
                    void call.start({
                      calleeId: current.userId,
                      name: current.name,
                      phone: current.phone,
                      role: 'landlord',
                      location: current.district,
                    });
                  }}
                  className="gap-1.5 h-8 text-xs"
                >
                  <Phone className="h-3.5 w-3.5" /> Redial In-Browser
                </Button>
              )}
            </>
          )}

          {/* Handset & WhatsApp links — always available, primary when no user_id */}
          {current.phone && (
            <div className="ml-auto flex items-center gap-1.5 flex-wrap">
              <Button
                size="sm"
                variant={!current.userId ? 'default' : 'ghost'}
                asChild
                className="h-8 text-xs gap-1"
              >
                <a href={telHref(current.phone)}>
                  <Phone className="h-3 w-3" /> Handset ({current.phone})
                </a>
              </Button>
              <Button
                size="sm"
                variant={!current.userId ? 'secondary' : 'ghost'}
                asChild
                className="h-8 text-xs gap-1"
              >
                <a href={waHref(current.phone)} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3 w-3" /> WhatsApp
                </a>
              </Button>
            </div>
          )}
        </div>

        {/* Mandatory outcome bar */}
        <div className="rounded-lg bg-muted/60 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium flex items-center gap-1.5">
              {needsOutcome ? (
                <>
                  <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                  Record the outcome to complete this landlord call:
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                  Quick outcome (ends call & logs to Calling Center):
                </>
              )}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={dialer.clearCurrent}
              className="h-6 text-[11px]"
            >
              Dismiss
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="default"
              onClick={() =>
                setOutcomeAttempt({
                  id: current.attemptId,
                  cycle_row_id: current.rowId,
                  name: current.name,
                })
              }
              className="h-8 text-xs"
            >
              Engaged / Callback (Add Notes)…
            </Button>
            {QUICK_OUTCOMES.map((o) => (
              <Button
                key={o.value}
                size="sm"
                variant="outline"
                disabled={hub.recordQuick.isPending}
                onClick={() => handleQuickOutcome(o.value, o.label)}
                className="h-8 text-xs"
              >
                {o.label}
              </Button>
            ))}
            {!callingPaused && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void dialer.dialNextPending()}
                disabled={dialer.isRevealing || pendingCount === 0}
                className="h-8 text-xs ml-auto gap-1"
              >
                <SkipForward className="h-3.5 w-3.5" /> Skip to Next
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Live Landlord Context Panel (Houses, Tenants, Rent Plans, Payouts, Payout Number Review) */}
      <Card className="p-3 sm:p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Live Landlord Dossier (Houses, Tenants, Rent Plans & Payouts)
        </div>
        <LandlordContextPanel
          subjectId={current.subjectId}
          fallbackName={current.name}
          fallbackPhone={current.phone}
          fallbackDistrict={current.district}
          fallbackAgentName={current.agentName}
          onOpenTimeline={() => setTimelineOpen(true)}
        />
      </Card>

      <RecordOutcomeDialog
        hub={hub}
        attempt={outcomeAttempt}
        onClose={() => {
          setOutcomeAttempt(null);
          dialer.advanceAfterOutcome();
        }}
      />

      <LandlordForwardConcernDialog
        open={forwardOpen}
        onOpenChange={setForwardOpen}
        defaultSubjectId={current.subjectId}
        defaultSubjectName={current.name}
        defaultSubjectPhone={current.phone}
        defaultDistrict={current.district}
        defaultAgentName={current.agentName}
        cycleRowId={current.rowId}
      />

      <LandlordTimelineDrawer
        open={timelineOpen}
        onOpenChange={setTimelineOpen}
        subjectId={current.subjectId}
        landlordId={current.landlordId}
        userId={current.userId}
        landlordName={current.name}
        phones={current.registry?.phones ?? (current.phone ? [current.phone] : null)}
      />
    </div>
  );
}
