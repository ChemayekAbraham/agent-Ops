/**
 * ENGREP — Engineering Contribution Report.
 *
 * Renders the reporting-window summary, the DAILY / WEEKLY / MONTHLY toggle and four
 * mounted zones: A Lovable edits, B external commits, C exceptions (continuous) and
 * LOCK PERIOD. Presentation only — no score, point or payout is computed here.
 * The route sits behind HRSignedInRoute, which checks authentication only; RLS on the
 * engrep views plus the adjudicator check inside each RPC are the whole access control.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { WindowToggle } from '@/components/hr/engrep/WindowToggle';
import { ZoneALovableEdits } from '@/components/hr/engrep/ZoneALovableEdits';
import { ZoneBExternalCommits } from '@/components/hr/engrep/ZoneBExternalCommits';
import { ZoneCExceptions } from '@/components/hr/engrep/ZoneCExceptions';
import { LockPeriodButton } from '@/components/hr/engrep/LockPeriodButton';



import { getLatestWindowSummary, isAdjudicator } from '@/hr/engrep/api';
import type { EngrepGranularity } from '@/hr/engrep/types';
import { useState } from 'react';

const RESTRICTED_NOTE = 'Adjudication is restricted to the registered adjudicator.';

const ZONES: Array<{ key: string; label: string; note?: string }> = [
  { key: 'a', label: 'A · LOVABLE EDITS' },
  { key: 'b', label: 'B · EXTERNAL COMMITS' },
  {
    key: 'c',
    label: 'C · EXCEPTIONS',
    note: 'Displayed continuously — this zone is not affected by the DAILY / WEEKLY / MONTHLY toggle.',
  },
  { key: 'lock', label: 'LOCK PERIOD' },
];

function formatEatCloseTime(periodEnd: string | null | undefined): string {
  if (!periodEnd) return '—';
  // The window closes at 17:00 EAT (UTC+3) on its final day.
  const closesAt = new Date(`${periodEnd}T17:00:00+03:00`);
  return `${closesAt.toLocaleString('en-GB', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} EAT`;
}

export default function EngineeringContribution() {
  const [granularity, setGranularity] = useState<EngrepGranularity>('day');

  const summaryQuery = useQuery({
    queryKey: ['engrep', 'window-summary', granularity],
    queryFn: () => getLatestWindowSummary(granularity),
  });

  const adjudicatorQuery = useQuery({
    queryKey: ['engrep', 'is-adjudicator'],
    queryFn: () => isAdjudicator().catch(() => false),
  });

  const summary = summaryQuery.data ?? null;
  const canAdjudicate = adjudicatorQuery.data === true;
  const statusLabel = summary?.status === 'locked' ? 'Locked' : 'Open';

  return (
    <div className="container mx-auto max-w-6xl space-y-6 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Engineering Contribution Report</h1>
        <p className="text-sm text-muted-foreground">
          Attested contribution rows per reporting window. Adjudication is enforced by the database.
        </p>
      </div>

      <WindowToggle value={granularity} onChange={setGranularity} />

      <Card>
        <CardContent className="grid gap-4 py-4 sm:grid-cols-3">
          {summaryQuery.isLoading ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : (
            <>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Window closes</p>
                <p className="text-sm font-medium">{formatEatCloseTime(summary?.period_end)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Unadjudicated rows</p>
                <p className="text-sm font-medium">{summary ? summary.unadjudicated : '—'}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
                {summary ? (
                  <Badge variant={summary.status === 'locked' ? 'secondary' : 'default'}>
                    {statusLabel}
                  </Badge>
                ) : (
                  <p className="text-sm text-muted-foreground">No window opened yet</p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {!canAdjudicate && (
        <p className="text-sm text-muted-foreground" aria-disabled="true">
          {RESTRICTED_NOTE}
        </p>
      )}

      <div className="space-y-4">
        {ZONES.map((zone) => (
          <Card key={zone.key} aria-disabled={!canAdjudicate}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide">
                {zone.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {zone.note && <p className="text-xs text-muted-foreground">{zone.note}</p>}
              {zone.key === 'a' && (
                <ZoneALovableEdits windowId={summary?.window_id ?? null} />
              )}
              {zone.key === 'b' && (
                <ZoneBExternalCommits
                  windowId={summary?.window_id ?? null}
                  distinctAuthorEmails={summary?.distinct_author_emails ?? null}
                />
              )}
              {zone.key === 'c' && <ZoneCExceptions canAdjudicate={canAdjudicate} />}
              {zone.key === 'lock' && (
                <LockPeriodButton
                  windowId={summary?.window_id ?? null}
                  granularity={granularity}
                  periodStart={summary?.period_start ?? null}
                  periodEnd={summary?.period_end ?? null}
                  unadjudicated={summary?.unadjudicated ?? null}
                  status={summary?.status ?? null}
                  canAdjudicate={canAdjudicate}
                />
              )}



              {!canAdjudicate && (
                <p className="text-xs text-muted-foreground">{RESTRICTED_NOTE}</p>
              )}
            </CardContent>

          </Card>
        ))}
      </div>
    </div>
  );
}
