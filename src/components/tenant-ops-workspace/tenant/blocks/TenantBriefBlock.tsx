/**
 * The AI-generated brief, always labelled as generated, with the exact
 * figures it was validated against shown beside it — never in place of a
 * failed/degraded response, which falls back to the figures alone.
 */
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { useTenantBrief } from '@/hooks/tenantOpsWorkspace/useTenantBrief';

export function TenantBriefBlock({ rentRequestId }: { rentRequestId: string | undefined }) {
  const { data, isLoading, error } = useTenantBrief(rentRequestId);

  if (!rentRequestId) return null;

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          Brief
          <Badge variant="outline" className="text-[10px]">Generated</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <p className="text-xs text-muted-foreground">Generating…</p>}
        {error && <p className="text-xs text-muted-foreground">Could not generate a brief right now.</p>}

        {data && (
          <>
            {data.narrative ? (
              <p className="text-xs text-foreground">{data.narrative}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                No AI summary available for this plan right now — the figures below are current.
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border bg-muted/30 p-2 text-[11px] sm:grid-cols-3">
              <p><span className="text-muted-foreground">Outstanding: </span>{formatUGX(data.facts.outstanding_ugx)}</p>
              <p><span className="text-muted-foreground">Expected to date: </span>{formatUGX(data.facts.expected_to_date_ugx)}</p>
              <p><span className="text-muted-foreground">Paid to date: </span>{formatUGX(data.facts.paid_to_date_ugx)}</p>
              <p><span className="text-muted-foreground">Days past due: </span>{data.facts.days_past_due ?? '—'}</p>
              <p>
                <span className="text-muted-foreground">Missed instalments: </span>
                {data.facts.missed_instalments_count} of {data.facts.total_instalments_count}
              </p>
              {data.facts.catch_up_daily_ugx != null && (
                <p><span className="text-muted-foreground">Catch-up/day: </span>{formatUGX(data.facts.catch_up_daily_ugx)}</p>
              )}
              {data.facts.last_promise ? (
                <p className="col-span-2 sm:col-span-3">
                  <span className="text-muted-foreground">Last promise: </span>
                  {formatUGX(data.facts.last_promise.promised_amount_ugx)} by {data.facts.last_promise.promised_date}
                  {' '}via {data.facts.last_promise.channel} ({data.facts.last_promise.status})
                </p>
              ) : (
                <p className="col-span-2 sm:col-span-3"><span className="text-muted-foreground">Last promise: </span>none on record</p>
              )}
              <p className="col-span-2 sm:col-span-3">
                <span className="text-muted-foreground">Contact: </span>
                {data.facts.total_contact_attempts} attempts
                {data.facts.last_contact_at && `, last ${data.facts.last_contact_outcome ?? 'unrecorded'}`}
              </p>
            </div>
            <p className="text-[10px] text-muted-foreground">
              As at {data.facts.as_at} — {data.facts.basis}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
