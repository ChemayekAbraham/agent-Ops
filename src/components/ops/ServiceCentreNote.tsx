import { MessageSquareQuote } from 'lucide-react';

/**
 * Displays the Service Centre manager's mandatory vetting comment so the
 * Landlord/Agent Ops verifier sees the field context before deciding.
 */
export function ServiceCentreNote({
  comment,
  reviewedAt,
}: {
  comment?: string | null;
  reviewedAt?: string | null;
}) {
  const text = (comment ?? '').trim();
  if (!text) return null;
  return (
    <div className="rounded-lg border border-violet-300/60 bg-violet-50 dark:bg-violet-500/10 px-2.5 py-2 space-y-1">
      <p className="text-[10px] font-semibold text-violet-700 dark:text-violet-300 uppercase tracking-wider flex items-center gap-1">
        <MessageSquareQuote className="h-3 w-3" /> Service Centre note
        {reviewedAt && (
          <span className="font-normal normal-case text-muted-foreground">
            · {new Date(reviewedAt).toLocaleDateString()}
          </span>
        )}
      </p>
      <p className="text-xs leading-snug">{text}</p>
    </div>
  );
}
