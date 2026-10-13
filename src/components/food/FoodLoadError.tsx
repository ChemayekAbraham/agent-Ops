import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LoadableQuery {
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/**
 * Shown when any of a screen's reads failed. Without it a failed read fell
 * through to the screen's EMPTY state ("Nothing outstanding", no meals, …),
 * telling the coordinator there was nothing when the data simply had not
 * loaded. Retry re-runs only the reads that failed.
 */
export default function FoodLoadError({ queries }: { queries: LoadableQuery[] }) {
  const failed = queries.filter((q) => q.isError);
  if (failed.length === 0) return null;
  const message = (failed[0].error as Error | undefined)?.message;
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center"
    >
      <AlertCircle className="h-6 w-6 text-destructive" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium">Some of this could not be loaded</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {message ?? 'Please try again.'} What is shown below may be incomplete.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => failed.forEach((q) => q.refetch())}>
        Try again
      </Button>
    </div>
  );
}
