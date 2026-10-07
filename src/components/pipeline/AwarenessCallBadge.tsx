import { PhoneCall, PhoneOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { awarenessBadgeText, type AwarenessCallStatus } from '@/lib/awarenessCallStatus';

/**
 * Small read-only badge for a Rent Plan on a pipeline list: "No call yet at this stage" or "Called N times".
 * It only describes what has been recorded; it never blocks or confirms anything. With no status (still loading, or the read
 * failed) it shows nothing.
 */
export function AwarenessCallBadge({ status, className }: { status: AwarenessCallStatus | null | undefined; className?: string }) {
  const text = awarenessBadgeText(status);
  if (!text) return null;
  const none = text.tone === 'none';
  const Icon = none ? PhoneOff : PhoneCall;
  return (
    <span
      data-testid="awareness-call-badge"
      data-state={none ? 'no-call' : 'called'}
      title={text.title}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        none ? 'border-warning/40 bg-warning/10 text-foreground' : 'border-success/30 bg-success/10 text-success',
        className,
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden="true" />
      {text.label}
    </span>
  );
}
