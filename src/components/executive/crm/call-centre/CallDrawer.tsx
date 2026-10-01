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
import { CALLEE_ROLE_LABEL, describeHangupCause, formatTalkTime } from '@/lib/callCentre';
import { useSaveCallSummary } from '@/hooks/useCrmCallCentre';
import { isTerminalCallState, useCrmVoiceCall, type CallState } from '@/hooks/useCrmVoiceCall';
import type { DialTarget } from './useCallDialer';
import { usePreviewCall } from './usePreviewCall';
import { CalleeDossierPanel } from './CalleeDossierPanel';

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '??';

/** Headline for each state. The state machine is the single source of truth for
 *  what the drawer says — no separate booleans to fall out of step. */
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
  busy: 'Customer busy',
  no_answer: 'No answer',
  failed: 'Call failed',
};

/* ------------------------------------------------------------------ *
 * The drawer
 * ------------------------------------------------------------------ */

export function CallDrawer({
  target,
  open,
  onOpenChange,
  preview = false,
}: {
  target: DialTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Look-only mode: show the call as it looks while dialling, dial nobody. */
  preview?: boolean;
}) {
  const call = useCrmVoiceCall();
  const previewCall = usePreviewCall(preview && open);
  const saveSummary = useSaveCallSummary();

  const [soundOn, setSoundOn] = useState(true);
  const [summary, setSummary] = useState('');
  const [savedSummary, setSavedSummary] = useState(false);
  /** Bumped by the redial button so the dial effect runs again for the same person. */
  const [dialAttempt, setDialAttempt] = useState(0);

  const ringbackRef = useRef<RingbackHandle | null>(null);

  const stopRingback = useCallback(() => {
    ringbackRef.current?.stop();
    ringbackRef.current = null;
  }, []);

  // One view of the call for the whole drawer. In preview mode every field below
  // comes from the local script, which has no network or database behind it, so
  // there is no second path that could quietly place a real call.
  const state = preview ? previewCall.state : call.state;
  const elapsed = preview ? previewCall.elapsed : call.elapsed;
  const muted = preview ? previewCall.muted : call.muted;
  const isEnding = preview ? false : call.isEnding;
  const callId = preview ? null : call.callId;
  const error = preview ? null : call.error;
  const hangupCause = preview ? null : call.hangupCause;

  const ended = isTerminalCallState(state);
  const dialling = state === 'initializing' || state === 'calling' || state === 'ringing';

  /* --- Start a real call whenever the drawer opens on someone new. --- */
  useEffect(() => {
    if (!open || !target || preview) return;
    setSummary('');
    setSavedSummary(false);
    void call.start({
      calleeId: target.calleeId,
      name: target.name,
      phone: target.phone,
      role: target.role,
      location: target.location,
    });
    // `call.start` is stable; re-running on it would re-dial.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.calleeId, dialAttempt, preview]);

  /* --- Ringback tone while the far end is still ringing. --- */
  useEffect(() => {
    if (!(open && dialling && soundOn)) {
      stopRingback();
      return;
    }
    ringbackRef.current = startRingback(120);
    return stopRingback;
  }, [open, dialling, soundOn, stopRingback]);

  /** Silence the tone on unmount/close — a leaked oscillator rings over the app. */
  useEffect(() => stopRingback, [stopRingback]);

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  const handleRedial = useCallback(() => {
    if (preview) {
      setSummary('');
      setSavedSummary(false);
      previewCall.restart();
      return;
    }
    stopRingback();
    setDialAttempt((n) => n + 1);
  }, [preview, previewCall, stopRingback]);

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
    if (state === 'connected') return formatTalkTime(elapsed);
    if (state === 'completed') return `Call ended · ${formatTalkTime(elapsed)}`;
    return STATE_LABEL[state];
  }, [state, elapsed]);

  /** Plain-language reason the network gave. Codes stay in the call log only. */
  const causeLine = useMemo(
    () => (ended ? (error ?? describeHangupCause(hangupCause)) : null),
    [ended, error, hangupCause],
  );

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
          if (preview) {
            // Nothing was ever dialled, so there is nothing to drop — just stand
            // the local script down.
            previewCall.reset();
          } else {
            // Closing mid-call must actually drop the telephone leg, not just hide
            // the drawer — and it must write an outcome so the row is never
            // stranded 'in_progress'.
            if (!ended && state !== 'idle') call.end();
            call.reset();
          }
        }
        onOpenChange(next);
      }}
    >
      {/* Capped at EVERY width, not just from `sm:` up. `w-full` here beat the
          variant's own `w-3/4` (tailwind-merge keeps the last width utility) and
          left the drawer full-bleed below 640px — a side drawer that turned into
          a full-screen sheet on a narrow viewport. `max-w-sm` is the unprefixed
          floor; `sm:max-w-md` replaces the variant's `sm:max-w-sm` above it. */}
      <SheetContent side="right" className="flex w-full max-w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl lg:max-w-5xl lg:flex-row lg:overflow-hidden">
        {!target ? null : (
          <>
          <div className="flex shrink-0 flex-col lg:w-[22rem] lg:overflow-y-auto lg:border-r lg:border-border">
            {/* ---------- Call face ---------- */}
            <div
              className={cn(
                'shrink-0 px-5 pb-5 pt-8 text-center transition-colors',
                state === 'connected' ? 'bg-primary/10' : ended ? 'bg-muted' : 'bg-primary/5',
              )}
            >
              <div className="relative mx-auto w-fit">
                {dialling && (
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
                {preview && (
                  <Badge variant="outline" className="border-primary/40 bg-primary/10 text-[10px] font-semibold text-primary">
                    Test view · no call placed
                  </Badge>
                )}
              </div>

              <p
                className={cn(
                  'mt-4 text-sm font-semibold tabular-nums',
                  state === 'connected' && 'text-primary',
                  ended && state !== 'completed' && 'text-destructive',
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

              {dialling && !preview && (
                <p className="mx-auto mt-3 max-w-[16rem] text-[11px] leading-snug text-muted-foreground">
                  You are calling from this browser — keep this tab open and talk
                  through your headset.
                </p>
              )}
              {dialling && preview && (
                <p className="mx-auto mt-3 max-w-[16rem] text-[11px] leading-snug text-muted-foreground">
                  Test view: nobody is dialled, no call is logged, and nothing is
                  saved. Close it and the screen is gone.
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
                  onClick={preview ? previewCall.toggleMute : call.toggleMute}
                  disabled={state !== 'connected'}
                  aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                  aria-pressed={muted}
                >
                  {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </Button>

                {/* No green "answer" button: this is an OUTBOUND call. End Call is
                    the only primary action, and it invokes the voice client's own
                    hangup so the telephone leg really drops. */}
                {!ended ? (
                  <Button
                    type="button"
                    variant="destructive"
                    className="h-20 w-20 rounded-full shadow-lg"
                    onClick={preview ? previewCall.end : call.end}
                    disabled={isEnding || state === 'idle'}
                    aria-label="End call"
                  >
                    <PhoneOff className="h-8 w-8" />
                  </Button>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    {/* The call is over, so the primary action becomes trying the
                        same person again without reopening the row. */}
                    <Button
                      type="button"
                      className="h-20 w-20 rounded-full bg-emerald-600 shadow-lg hover:bg-emerald-700"
                      onClick={handleRedial}
                      aria-label={`Redial ${target.name}`}
                    >
                      <PhoneCall className="h-8 w-8" />
                    </Button>
                    <Badge variant="outline" className="px-3 py-1 text-[10px]">
                      {STATE_LABEL[state]}
                    </Badge>
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {preview ? 'Tap to run the test again' : 'Tap to redial'}
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

              {!ended && (
                <p className="mt-3 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {isEnding
                    ? 'Ending…'
                    : preview
                      ? 'Test view — nothing is dialled or recorded'
                      : 'Pick-up and hang-up are detected automatically'}
                </p>
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
                {preview
                  ? 'Summary saving is off in test view'
                  : saveSummary.isPending
                    ? 'Saving…'
                    : savedSummary
                      ? 'Summary saved'
                      : 'Save summary'}
              </Button>
              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <UserRound className="mt-px h-3 w-3 shrink-0" aria-hidden />
                Open this person in People / Calls to read every past summary.
              </p>
            </div>
          </div>
          <div className="min-w-0 flex-1 bg-muted/20 lg:overflow-y-auto">
            <CalleeDossierPanel
              userId={target.calleeId}
              callId={callId}
              profileHint={{
                full_name: target.name,
                phone: target.phone,
                location: target.location,
                avatar_url: target.avatarUrl,
                roles: target.roles ?? [target.role],
              }}
            />
          </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
