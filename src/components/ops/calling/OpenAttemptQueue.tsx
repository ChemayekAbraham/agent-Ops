import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock } from 'lucide-react';
import { type CcCallingHub } from '@/hooks/useCcCallingHub';
import { OpenAttemptList, type OpenFormAttempt } from './OpenAttemptList';

/**
 * The surface a caller returns to in order to record what they did.
 * Unreached outcomes are one tap. Engaged / callback open the form.
 * The row behaviour itself lives in OpenAttemptList, shared with the
 * mobile record sheet.
 */
export function OpenAttemptQueue({
  hub,
  onOpenForm,
}: {
  hub: CcCallingHub;
  onOpenForm: (attempt: OpenFormAttempt) => void;
}) {
  const { openCount, wipBlocked, wipLimit } = hub;

  return (
    <Card className="rounded-2xl border-border/60 p-3 sm:p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <Clock className="h-4 w-4 text-amber-600" />
          Open attempts
        </h3>
        <Badge variant={wipBlocked ? 'destructive' : 'secondary'}>
          {wipLimit == null ? `${openCount} open` : `${openCount} of ${wipLimit} open`}
        </Badge>

      </div>

      {wipBlocked && (
        <p className="mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">
          Record the outcome of your open calls before revealing another number.
        </p>
      )}

      <OpenAttemptList hub={hub} onOpenForm={onOpenForm} />
    </Card>
  );
}
