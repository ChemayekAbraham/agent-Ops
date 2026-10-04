/**
 * Big tap-to-call action for the Landlord Ops verification surfaces.
 * Renders nothing when no phone number is recorded.
 */
import { Phone } from 'lucide-react';

interface Props {
  phone: string | null | undefined;
  /** Who is being called, e.g. "landlord" or "agent" — used in the label. */
  who: string;
  className?: string;
}

export function CallButton({ phone, who, className = '' }: Props) {
  if (!phone) return null;
  return (
    <a
      href={`tel:${phone}`}
      aria-label={`Call ${who} at ${phone}`}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-emerald-600/40 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 ${className}`}
    >
      <Phone className="h-4 w-4 shrink-0" />
      <span className="truncate">Call {who} · {phone}</span>
    </a>
  );
}
