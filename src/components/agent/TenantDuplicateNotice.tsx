import { Loader2, AlertTriangle } from 'lucide-react';
import type { TenantDuplicateMatch } from '@/hooks/useTenantDuplicateCheck';

interface TenantDuplicateNoticeProps {
  match: TenantDuplicateMatch | null;
  checking: boolean;
  field: 'name' | 'phone' | 'national ID';
  /** Optional: tap to auto-fill the form with this existing person. */
  onUse?: (match: TenantDuplicateMatch) => void;
}

export function TenantDuplicateNotice({
  match,
  checking,
  field,
  onUse,
}: TenantDuplicateNoticeProps) {
  if (checking && !match) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking if this {field} is already registered…
      </p>
    );
  }

  if (!match) return null;

  const name = match.full_name?.trim() || 'an existing user';

  return (
    <button
      type="button"
      onClick={() => onUse?.(match)}
      className="w-full text-left rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-warning-foreground"
    >
      <p className="flex items-start gap-1.5 text-xs font-semibold text-warning">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span>
          This {field} is already registered to <span className="underline">{name}</span>.
          Do not create a duplicate.
        </span>
      </p>
      {onUse && (
        <p className="mt-1 text-[10px] text-foreground/70">
          Tap to use this existing tenant instead.
        </p>
      )}
    </button>
  );
}
