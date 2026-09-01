import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, PhoneCall, PhoneOff, Save, UserRound, Volume2, VolumeX } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { startRingback, type RingbackHandle } from '@/lib/ringbackTone';
import { CALLEE_ROLE_LABEL, deriveOutcome, formatTalkTime, type CallOutcome } from '@/lib/callCentre';
import {
  useCallSession,
  useCancelCall,
  useEndCall,
  usePlaceCall,
  useSaveCallSummary,
  CALL_CENTRE_IS_STUBBED,
} from '@/hooks/useCrmCallCentre';
import type { DialTarget } from './useCallDialer';

/** Where the call has got to. Mirrors the agent-leg-first bridge flow. */
type DialerPhase = 'ringing' | 'connected' | 'ended';

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '??';

/* ------------------------------------------------------------------ *
 * The drawer
 * ------------------------------------------------------------------ */

export function CallDrawer({
  target,
  open,
  onOpenChange,
}: {
  target: DialTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const placeCall = usePlaceCall();
  const endCall = useEndCall();
  const cancelCall = useCancelCall();
  const saveSummary = useSaveCallSummary();

  const [phase, setPhase] = useState<DialerPhase>('ringing');
  const [muted, setMuted] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [summary, setSummary] = useState('');
  const [callId, setCallId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [savedSummary, setSavedSummary] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** Bumped by the redial button so the dial effect runs again for the same person. */
  const [dialAttempt, setDialAttempt] = useState(0);


  const ringbackRef = useRef<RingbackHandle | null>(null);
  /** Talk time is measured from a wall-clock mark, so a throttled background
   *  tab cannot under-count the duration the way a tick counter would. */
  const connectedAtRef = useRef<number | null>(null);

  const stopRingback = useCallback(() => {
    ringbackRef.current?.stop();
    ringbackRef.current = null;
  }, []);

  /* --- Start a call whenever the drawer opens on someone new. --- */
  useEffect(() => {
    if (!open || !target) return;

    // Reset for the new call.
    setPhase('ringing');
    setMuted(false);
    setElapsed(0);
    setSummary('');
    setOutcome(null);
    setSavedSummary(false);
    setStartError(null);
    setCallId(null);


    connectedAtRef.current = null;

    let cancelled = false;
    placeCall
      .mutateAsync({
        calleeId: target.calleeId,
        calleeName: target.name,
        calleePhone: target.phone,
        calleeRole: target.role,
        calleeAvatarUrl: target.avatarUrl,
        location: target.location,
      })
      .then((res) => {
        if (cancelled) return;
        setCallId(res.callId);
        // Africa's Talking rings the STAFF handset first, so this is emphatically
        // not "the customer is connected".
        toast.info(res.message);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The edge function returns an operator-readable reason (out of voice
        // credit, invalid staff number, throttled…). Swallowing it left staff
        // staring at a ringing drawer with no idea why nothing happened.
        const reason = err instanceof Error && err.message ? err.message : 'Could not start the call.';
        stopRingback();
        setStartError(reason);
        setPhase('ended');
        setOutcome('not_reachable');
        toast.error(reason);
      });


    return () => {
      cancelled = true;
    };
    // `placeCall` is a stable mutation object; re-running on it would re-dial.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.calleeId, dialAttempt]);

  /** Dial the same person again after the call ended or failed to start. */
  const handleRedial = useCallback(() => {
    stopRingback();
    connectedAtRef.current = null;
    setDialAttempt((n) => n + 1);
  }, [stopRingback]);

  /* --- Ringback tone, tied to the ringing phase. --- */
  useEffect(() => {
    const shouldRing = open && phase === 'ringing' && soundOn;
    if (!shouldRing) {
      stopRingback();
      return;
    }
    ringbackRef.current = startRingback(120);
    return stopRingback;
  }, [open, phase, soundOn, stopRingback]);

  /* --- Always silence the tone when the drawer goes away, even on unmount.
         A leaked oscillator would keep ringing over the whole app. --- */
  useEffect(() => stopRingback, [stopRingback]);
  useEffect(() => {
    if (!open) stopRingback();
  }, [open, stopRingback]);

  /* --- The provider is the authority on pick-up. --- */
  const session = useCallSession(callId, open && phase !== 'ended');

  useEffect(() => {
    if (!session || phase === 'ended') return;

    // Bridged means Africa's Talking reported the staff leg answered and the
    // customer leg is being dialled — start the clock from the provider event,
    // never from a staff member asserting it.
    if (session.bridged && phase !== 'connected') {
      connectedAtRef.current = Date.now();
      stopRingback();
      setPhase('connected');
      setElapsed(0);
      return;
    }

    if (session.settled) {
      const seconds = session.durationSeconds ?? 0;
      stopRingback();
      setPhase('ended');
      setElapsed(seconds);
      setOutcome(
        deriveOutcome({
          status: session.status,
          hangupCause: session.hangupCause,
          durationSeconds: session.durationSeconds,
        }) as Exclude<CallOutcome, 'in_progress'>,
      );
    }
  }, [session, phase, stopRingback]);

  /* --- Talk-time ticker. --- */
  useEffect(() => {
    if (phase !== 'connected') return;
    const id = window.setInterval(() => {
      if (connectedAtRef.current !== null) {
        setElapsed(Math.floor((Date.now() - connectedAtRef.current) / 1000));
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  const settle = useCallback(
    (nextOutcome: Exclude<CallOutcome, 'in_progress'>) => {
      const seconds =
        connectedAtRef.current !== null ? Math.floor((Date.now() - connectedAtRef.current) / 1000) : 0;
      stopRingback();
      setPhase('ended');
      setOutcome(nextOutcome);
      setElapsed(seconds);
      if (callId) {
        endCall
          .mutateAsync({ callId, durationSeconds: seconds, outcome: nextOutcome })
          .catch(() => toast.error('Could not record how the call ended.'));
      }
    },
    [callId, endCall, stopRingback],
  );

  const handleHangUp = useCallback(() => {
    // Tell the provider first: `crm_cancel_call` flags the leg so the voice
    // callback answers with <Hangup/> instead of bridging. Previously this
    // button only changed the drawer, so both handsets kept ringing and the
    // customer was still dialled the moment the staff leg picked up.
    if (callId) {
      cancelCall
        .mutateAsync(callId)
        .then(() => {
          // The voice provider offers no remote hang-up for a leg that is
          // already up, so be honest instead of implying the line is dead.
          if (phase === 'connected') {
            toast.info('Call closed here. Put your handset down to drop the line.');
          } else {
            toast.info('Call cancelled. A handset already ringing may ring a few more seconds.');
          }
        })
        .catch(() => toast.error('Could not stop the call on the phone network.'));
    }
    if (phase === 'connected') settle('answered');
    else settle('not_reachable');
  }, [callId, cancelCall, phase, settle]);



  const handleSaveSummary = async () => {
    if (!callId) return;
    try {
      await saveSummary.mutateAsync({ callId, summary });
      setSavedSummary(true);
      toast.success('Call summary saved.');
    } catch {
      toast.error('Could not save the summary.');
    }
  };

  const statusLine = useMemo(() => {
    if (startError) return startError;
    if (phase === 'ringing') return 'Ringing your handset…';
    if (phase === 'connected') return formatTalkTime(elapsed);
    if (outcome === 'answered') return `Call ended · ${formatTalkTime(elapsed)}`;
    if (outcome === 'rejected') return 'Call rejected';
    return 'Not reachable';
  }, [phase, elapsed, outcome, startError]);


  const summaryDirty = summary.trim().length > 0 && !savedSummary;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && summaryDirty) {
          // Losing a typed summary to a stray click is the one irreversible
          // thing in this drawer, so it gets a confirm.
          const discard = window.confirm('Close without saving your call summary?');
          if (!discard) return;
        }
        if (!next) {
          stopRingback();
          // Closing an unsettled call must still write an outcome. Leaving the
          // row 'in_progress' would strand it there forever and permanently
          // inflate the in-progress KPI, since only this drawer ever settles it.
          if (phase !== 'ended') handleHangUp();
        }
        onOpenChange(next);
      }}
    >
      {/* Capped at EVERY width, not just from `sm:` up. `w-full` here beat the
          variant's own `w-3/4` (tailwind-merge keeps the last width utility) and
          left the drawer full-bleed below 640px — a side drawer that turned into
          a full-screen sheet on a narrow viewport. `max-w-sm` is the unprefixed
          floor; `sm:max-w-md` replaces the variant's `sm:max-w-sm` above it.
          `w-3/4` is a standard utility (an arbitrary `w-[..vw]` value here did not
          compile), so a strip of backdrop always stays visible. */}
      <SheetContent side="right" className="flex w-3/4 max-w-sm flex-col gap-0 p-0 sm:max-w-md">
        {!target ? null : (
          <>
            {/* ---------- Call face ---------- */}
            <div
              className={cn(
                'shrink-0 px-5 pb-5 pt-8 text-center transition-colors',
                phase === 'connected' ? 'bg-primary/10' : phase === 'ended' ? 'bg-muted' : 'bg-primary/5',
              )}
            >
              <div className="relative mx-auto w-fit">
                {phase === 'ringing' && (
                  <>
                    <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" aria-hidden />
                    <span className="absolute -inset-2 animate-pulse rounded-full bg-primary/10" aria-hidden />
                  </>
                )}
                <Avatar className="relative h-24 w-24 border-2 border-background shadow-lg">
                  <AvatarImage src={target.avatarUrl ?? undefined} alt="" />
                  <AvatarFallback className="bg-primary/15 text-xl font-bold text-primary">
                    {initials(target.name)}
                  </AvatarFallback>
                </Avatar>
              </div>

              {/* SheetTitle/Description, not a bare h2 — Radix needs a labelled
                  dialog or screen readers announce the drawer as unnamed. */}
              <SheetTitle className="mt-4 truncate text-lg font-bold text-foreground">
                {target.name}
              </SheetTitle>
              <SheetDescription className="mt-0.5 text-sm tabular-nums text-muted-foreground">
                {target.phone}
              </SheetDescription>

              <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  {CALLEE_ROLE_LABEL[target.role]}
                </Badge>
                {target.location && (
                  <Badge variant="outline" className="text-[10px]">{target.location}</Badge>
                )}
              </div>

              <p
                className={cn(
                  'mt-4 text-sm font-semibold tabular-nums',
                  phase === 'connected' && 'text-primary',
                  phase === 'ended' && outcome !== 'answered' && 'text-destructive',
                )}
                aria-live="polite"
              >
                {statusLine}
              </p>

              {phase === 'ringing' && (
                <p className="mx-auto mt-3 max-w-[16rem] text-[11px] leading-snug text-muted-foreground">
                  {CALL_CENTRE_IS_STUBBED
                    ? 'Voice API not connected yet — mark how the call went to record it.'
                    : 'Answer your own handset first. We connect you to them as soon as you pick up.'}
                </p>
              )}
            </div>

            {/* ---------- Controls ---------- */}
            <div className="shrink-0 border-y border-border/60 bg-background px-5 py-4">
              <div className="flex items-center justify-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 rounded-full"
                  onClick={() => setMuted((m) => !m)}
                  disabled={phase !== 'connected'}
                  aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                  aria-pressed={muted}
                >
                  {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </Button>

                {/* No green "answer" button: this is an OUTBOUND call, so there is
                    nothing for the caller to accept — the other party picks up.
                    Ending the call is the only primary action, so it gets the
                    large button. Pick-up and the two failure outcomes are marked
                    from the text row below. */}
                {phase !== 'ended' ? (
                  <Button
                    type="button"
                    variant="destructive"
                    className="h-20 w-20 rounded-full shadow-lg"
                    onClick={handleHangUp}
                    aria-label={phase === 'connected' ? 'Hang up' : 'Cancel call'}
                  >
                    <PhoneOff className="h-8 w-8" />
                  </Button>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    {/* Redial: the call is over, so the primary action becomes
                        trying the same person again without reopening the row. */}
                    <Button
                      type="button"
                      className="h-20 w-20 rounded-full bg-emerald-600 shadow-lg hover:bg-emerald-700"
                      onClick={handleRedial}
                      disabled={placeCall.isPending}
                      aria-label={`Redial ${target.name}`}
                    >
                      <PhoneCall className="h-8 w-8" />
                    </Button>
                    <Badge variant="outline" className="px-3 py-1 text-[10px]">
                      {outcome === 'answered' ? 'Answered' : outcome === 'rejected' ? 'Rejected' : 'Not reachable'}
                    </Badge>
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {placeCall.isPending ? 'Redialling…' : 'Tap to redial'}
                    </span>
                  </div>
                )}


                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 rounded-full"
                  onClick={() => setSoundOn((s) => !s)}
                  aria-label={soundOn ? 'Mute ringing tone' : 'Unmute ringing tone'}
                  aria-pressed={!soundOn}
                >
                  {soundOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
                </Button>
              </div>

              {/* Pick-up arrives from the provider's own callback, so there is no
                  "they answered" button to press. Only the two failure outcomes
                  stay as manual overrides, for when the provider never reports. */}
              {phase === 'ringing' && (
                /* Divider + caption: without them these three sit directly under
                   the three round controls and read as labels for them. */
                <div className="mt-4 border-t border-border/60 pt-3">
                  <p className="mb-1 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Pick-up is detected automatically — only override a failure
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-1">
                    <Button type="button" variant="ghost" size="sm" className="text-xs" onClick={() => settle('rejected')}>
                      They rejected
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="text-xs" onClick={() => settle('not_reachable')}>
                      Not reachable
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* ---------- Summary notes ---------- */}
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="call-summary" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Call summary
                </label>
                {savedSummary && <Badge variant="outline" className="text-[10px]">Saved</Badge>}
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                What was discussed and what happens next. Saved against {target.name.split(' ')[0]} so
                anyone picking up the follow-up can read it.
              </p>
              <Textarea
                id="call-summary"
                value={summary}
                onChange={(e) => {
                  setSummary(e.target.value);
                  setSavedSummary(false);
                }}
                placeholder="e.g. Confirmed she will clear arrears on Friday. Wants an SMS reminder Thursday."
                className="min-h-[7rem] flex-1 resize-none text-sm"
              />
              <Button
                type="button"
                onClick={handleSaveSummary}
                disabled={!callId || summary.trim().length === 0 || saveSummary.isPending || savedSummary}
                className="w-full gap-2"
              >
                <Save className="h-4 w-4" />
                {saveSummary.isPending ? 'Saving…' : savedSummary ? 'Summary saved' : 'Save summary'}
              </Button>
              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <UserRound className="mt-px h-3 w-3 shrink-0" aria-hidden />
                Open this person in People / Calls to read every past summary.
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
