/**
 * The live-call face for the Tenant Calling Center.
 *
 * Outcomes are written by the Hub's own mutations (`recordQuick` / the shared
 * `RecordOutcomeDialog`), so a call recorded here is indistinguishable from one
 * recorded in the Calling Hub.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Mic, MicOff, Phone, PhoneOff, MessageCircle, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { startRingback, type RingbackHandle } from '@/lib/ringbackTone';
import { describeHangupCause, formatTalkTime } from '@/lib/callCentre';
import { isTerminalCallState, type CallState } from '@/hooks/useCrmVoiceCall';
import { QUICK_OUTCOMES, ccErrorText, type CcCallingHub } from '@/hooks/useCcCallingHub';
import { telHref, waHref } from '@/components/ops/calling/ccPhone';
import { TenantCallContextPanel } from './TenantCallContextPanel';
import type { TenantCallCenterDialer } from './useTenantCallCenterDialer';

const STATE_LABEL: Record<CallState, string> = {
  idle: 'Ready to call',
  initializing: 'Connecting to the voice service…',
  calling: 'Calling…',
  ringing: 'Ringing…',
  connected: 'Connected',
  ending: 'Ending…',
  completed: 'Call ended',
  cancelled: 'Call cancelled',
  rejected: 'Call rejected',
  busy: 'Tenant busy',
  no_answer: 'No answer',
  failed: 'Call failed',
};

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '??';

export function LiveCallPanel({
  hub,
  dialer,
  onOpenForm,
}: {
  hub: CcCallingHub;
  dialer: TenantCallCenterDialer;
  onOpenForm: (attempt: { id: string; cycle_row_id: string; name: string }) => void;
}) {
  const { current, call, needsOutcome, suggestion } = dialer;

  if (!current) {
    return (
      <Card className="p-8 text-center">
        <div className="mx-auto w-fit rounded-2xl bg-primary/10 p-3 text-primary">
          <Phone className="h-6 w-6" />
        </div>
        <p className="mt-3 text-sm font-bold">No call on the line</p>
        <p className="mx-auto mt-1 max-w-[22rem] text-xs leading-snug text-muted-foreground">
          Pick a tenant in the Work Queue and press Call, or start a sequential run.
        </p>
      </Card>
    );
  }


  const ended = isTerminalCallState(call.state);
  const dialling = call.state === 'initializing' || call.state === 'calling' || call.state === 'ringing';
  const statusLine =
    call.state === 'connected'
      ? formatTalkTime(call.elapsed)
      : call.state === 'completed'
        ? `Call ended · ${formatTalkTime(call.elapsed)}`
        : STATE_LABEL[call.state];
  const causeLine = ended ? (call.error ?? describeHangupCause(call.hangupCause)) : null;

  const record = (outcome: (typeof QUICK_OUTCOMES)[number]['value'], label: string) =>
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

  return (
    <Card className="overflow-hidden">
      <div
        className={cn(
          'px-4 pb-5 pt-6 text-center transition-colors',
          call.state === 'connected'
            ? 'bg-gradient-to-b from-emerald-500/15 to-transparent'
            : ended
              ? 'bg-muted/50'
              : 'bg-gradient-to-b from-primary/15 to-transparent',
        )}
      >
        <div className="relative mx-auto w-fit">
          {dialling && (
            <span className="absolute inset-0 animate-ping rounded-full bg-primary/25" aria-hidden />
          )}
          <div
            className={cn(
              'relative flex h-20 w-20 items-center justify-center rounded-full border-2 border-background text-lg font-bold shadow-md',
              call.state === 'connected' ? 'bg-emerald-500/20 text-emerald-700' : 'bg-primary/15 text-primary',
            )}
          >
            {initials(current.name)}
          </div>
        </div>

        <h3 className="mt-3 truncate text-base font-bold">{current.name}</h3>
        <p className="text-xs font-semibold tabular-nums text-muted-foreground">
          {current.phone ?? 'No number on file'}
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          <Badge variant="secondary" className="text-[10px]">Tenant</Badge>
          {current.district && <Badge variant="outline" className="text-[10px]">{current.district}</Badge>}
        </div>


        <p
          className={cn(
            'mt-3 text-sm font-semibold tabular-nums',
            call.state === 'connected' && 'text-primary',
            ended && call.state !== 'completed' && 'text-destructive',
          )}
          aria-live="polite"
        >
          {statusLine}
        </p>
        {causeLine && (
          <p className="mx-auto mt-1 max-w-[18rem] text-[11px] leading-snug text-muted-foreground">
            {causeLine}
          </p>
        )}
        {dialling && (
          <p className="mx-auto mt-2 max-w-[18rem] text-[11px] leading-snug text-muted-foreground">
            You are talking from this browser — keep the tab open and use your headset.
          </p>
        )}
      </div>

      <div className="flex items-center justify-center gap-3 border-y border-border/60 px-4 py-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-10 w-10 rounded-full"
          onClick={call.toggleMute}
          disabled={call.state !== 'connected'}
          aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={call.muted}
        >
          {call.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </Button>

        {!ended ? (
          <Button
            type="button"
            variant="destructive"
            className="h-14 w-14 rounded-full shadow"
            onClick={dialer.hangUp}
            disabled={call.isEnding}
            aria-label="End call"
          >
            <PhoneOff className="h-5 w-5" />
          </Button>
        ) : (
          <Button type="button" variant="outline" className="h-10 text-xs" onClick={dialer.clearCurrent}>
            Clear
          </Button>
        )}

        {current.phone && (
          <>
            <Button asChild variant="outline" size="icon" className="h-10 w-10 rounded-full" aria-label="Dial on handset">
              <a href={telHref(current.phone)}>
                <Phone className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild variant="outline" size="icon" className="h-10 w-10 rounded-full" aria-label="WhatsApp">
              <a href={waHref(current.phone)} target="_blank" rel="noreferrer">
                <MessageCircle className="h-4 w-4" />
              </a>
            </Button>
          </>
        )}
      </div>

      <div className="border-b border-border/60 p-3">
        <TenantCallContextPanel
          hub={hub}
          subjectId={current.subjectId}
          fallbackName={current.name}
          district={current.district}
          linkedAgent={current.row?.linked_agent ?? null}
          phone={current.phone}
          row={current.row ?? null}
        />
      </div>

      <div className="space-y-2 p-3">
        <p className="text-[11px] font-semibold text-muted-foreground">
          {needsOutcome
            ? suggestion
              ? 'Record the outcome to release this attempt. Suggested from the network result.'
              : 'Record the outcome to release this attempt.'
            : 'Outcome recorded for this attempt.'}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_OUTCOMES.map((o) => (
            <Button
              key={o.value}
              size="sm"
              variant={suggestion === o.value ? 'default' : 'outline'}
              className="h-8 px-2 text-[11px]"
              disabled={!needsOutcome || hub.recordQuick.isPending}
              onClick={() => record(o.value, o.label)}
            >
              {o.label}
            </Button>
          ))}
          <Button
            size="sm"
            className="h-8 px-2 text-[11px]"
            disabled={!needsOutcome}
            onClick={() =>
              onOpenForm({ id: current.attemptId, cycle_row_id: current.rowId, name: current.name })
            }
          >
            Engaged / callback
          </Button>
        </div>
      </div>
    </Card>
  );
}
