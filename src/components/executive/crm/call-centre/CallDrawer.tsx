import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, PhoneCall, PhoneOff, Volume2, VolumeX } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { startRingback, type RingbackHandle } from '@/lib/ringbackTone';
import { CALLEE_ROLE_LABEL, describeHangupCause, formatTalkTime } from '@/lib/callCentre';
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

  const [soundOn, setSoundOn] = useState(true);
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
      previewCall.restart();
      return;
    }
    stopRingback();
    setDialAttempt((n) => n + 1);
  }, [preview, previewCall, stopRingback]);

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

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
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
      <SheetContent side="right" className="flex w-full max-w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl lg:max-w-5xl">
        {!target ? null : (
          <div className="flex min-h-full flex-col">
            <header className="shrink-0 border-b border-primary/50 bg-background px-5 pb-5 pt-7 sm:px-7">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-4">
                  <div className="relative shrink-0">
                {dialling && (
                  <>
                    <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" aria-hidden />
                    <span className="absolute -inset-1.5 animate-pulse rounded-full bg-primary/10" aria-hidden />
                  </>
                )}
                    <Avatar className="relative h-16 w-16 border-2 border-background shadow-md">
                  <AvatarImage src={target.avatarUrl ?? undefined} alt="" />
                      <AvatarFallback className="bg-primary/15 text-lg font-bold text-primary">
                    {initials(target.name)}
                  </AvatarFallback>
                </Avatar>
                    <span className={cn('absolute bottom-0 right-0 h-4 w-4 rounded-full border-2 border-background', state === 'connected' ? 'bg-success' : 'bg-muted-foreground')} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <SheetTitle className="truncate text-xl font-bold text-foreground">{target.name}</SheetTitle>
                      <Badge variant="outline" className="text-[10px]">{CALLEE_ROLE_LABEL[target.role]}</Badge>
                    </div>
                    <SheetDescription className="mt-0.5 text-sm tabular-nums text-muted-foreground">{target.phone}</SheetDescription>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className={cn('flex items-center gap-1.5 text-sm font-semibold tabular-nums', state === 'connected' && 'text-success', ended && state !== 'completed' && 'text-destructive')} aria-live="polite">
                        <span className={cn('h-2 w-2 rounded-full', state === 'connected' ? 'animate-pulse bg-success' : ended ? 'bg-muted-foreground' : 'animate-pulse bg-primary')} />
                        {statusLine}
                      </p>
                      {target.location && <Badge variant="outline" className="text-[10px]">{target.location}</Badge>}
                      {preview && <Badge variant="outline" className="border-warning/40 bg-warning/10 text-[10px] font-semibold text-warning-foreground">Test view · no call placed</Badge>}
                    </div>
                    {causeLine && <p className="mt-1 text-xs text-muted-foreground">{causeLine}</p>}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                    className="rounded-lg"
                  onClick={preview ? previewCall.toggleMute : call.toggleMute}
                  disabled={state !== 'connected'}
                  aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                  aria-pressed={muted}
                >
                  {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </Button>

                  <Button type="button" variant="outline" size="icon" className="rounded-lg" onClick={() => setSoundOn((s) => !s)} aria-label={soundOn ? 'Mute ringing tone' : 'Unmute ringing tone'} aria-pressed={!soundOn}>
                    {soundOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
                  </Button>
                {!ended ? (
                  <Button
                    type="button"
                    variant="destructive"
                      className="ml-1 h-11 rounded-lg px-4 shadow-md"
                    onClick={preview ? previewCall.end : call.end}
                    disabled={isEnding || state === 'idle'}
                    aria-label="End call"
                  >
                      <PhoneOff className="h-4 w-4" />
                      End call
                  </Button>
                ) : (
                    <Button
                      type="button"
                      variant="success"
                      className="ml-1 h-11 rounded-lg px-4"
                      onClick={handleRedial}
                      aria-label={`Redial ${target.name}`}
                    >
                      <PhoneCall className="h-4 w-4" />
                      {preview ? 'Run test again' : 'Redial'}
                    </Button>
                )}
              </div>
              </div>
              {dialling && <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">{preview ? 'Safe preview: nobody is dialled and no call record is created.' : 'Keep this tab open and speak through your headset. Pick-up and hang-up are detected automatically.'}</p>}
            </header>
            <div className="min-w-0 flex-1 bg-muted/20">
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
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
