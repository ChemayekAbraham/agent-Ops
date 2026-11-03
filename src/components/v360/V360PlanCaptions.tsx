import { useV360PlanSummary, type V360Summary } from '@/hooks/useV360Plan';
import { v360CaptionLines } from '@/lib/v360Captions';

/**
 * Server captions for a 360-day Rent Plan. Hidden for every other plan.
 * Pass expectV360 only when the row is already known to be v360, so other
 * plans do not flash a loading line.
 */
export function V360PlanCaptions({
  rentRequestId,
  expectV360 = false,
}: {
  rentRequestId: string | null | undefined;
  expectV360?: boolean;
}) {
  const summary = useV360PlanSummary(rentRequestId);
  if (!rentRequestId) return null;
  if (summary.isLoading) {
    return expectV360 ? <p className="text-[11px] text-muted-foreground">Loading 360-day Rent Plan figures…</p> : null;
  }
  if (summary.isError) {
    return expectV360 ? <p className="text-[11px] text-destructive">360-day Rent Plan figures are unavailable.</p> : null;
  }
  const data = summary.data;
  if (!data || data.pricing_version !== 'v360') return null;
  return <V360PlanCaptionList summary={data} />;
}

export function V360PlanCaptionList({ summary }: { summary: V360Summary }) {
  const lines = v360CaptionLines(summary);
  return (
    <dl className="grid grid-cols-1 gap-1 rounded-lg border border-border bg-muted/30 p-2 text-[11px]" data-testid="v360-plan-captions">
      {lines.map((line) => (
        <div key={line.label} className="flex items-start justify-between gap-3">
          <dt className="text-muted-foreground">{line.label}</dt>
          <dd className="text-right font-semibold tabular-nums text-foreground">{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}
