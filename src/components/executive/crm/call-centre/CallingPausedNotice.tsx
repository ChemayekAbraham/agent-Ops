/**
 * Small notice shown while calling from the app is paused server-side.
 *
 * The automated call centre now owns the phone line, so while the pause is on
 * the server refuses every human call. Screens hide their call buttons and show
 * this instead — hiding is a courtesy, the server is the gate.
 */
import { PhoneCall } from 'lucide-react';
import { useHumanCallingPaused } from '@/hooks/useCrmVoiceCall';

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "12 minutes ago" is right for a pause; anything past a day just says "yesterday"/"3 days ago". */
function relativeStamp(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

export function CallingPausedNotice() {
  const { data } = useHumanCallingPaused();
  if (!data?.paused) return null;

  const pausedFor = relativeStamp(data.paused_at);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
      <PhoneCall className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <span className="font-medium">
        Calling from the app is paused. This line is now used for automated calls.
      </span>
      {pausedFor && <span className="text-muted-foreground">Paused {pausedFor}</span>}
    </div>
  );
}
