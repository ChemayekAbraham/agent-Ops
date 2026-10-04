# ENGREP UI inventory

Database: RentFlow (Supabase ref wirntoujqoyjobfhyelc). `src/hr/api/recruitment.ts` confirmed present.
Read-only inventory. Every line number below was taken from the working tree at the time of writing.

## 1. Files

| Path | What it is |
| --- | --- |
| `src/pages/hr/EngineeringContribution.tsx` | ENGREP adjudicator screen (page shell hosting Zones A, B, C and LOCK PERIOD). |
| `src/pages/me/MyContribution.tsx` | Engineer self-view of own harvested rows (`engrep_my_rows`), read-only. |
| `src/components/hr/engrep/WindowToggle.tsx` | DAILY / WEEKLY / MONTHLY three-segment tab strip. |
| `src/components/hr/engrep/ZoneALovableEdits.tsx` | Zone A tiles A1/A2/A3 and the Lovable-edits table. |
| `src/components/hr/engrep/ZoneBExternalCommits.tsx` | Zone B tiles B1/B2 and the external-commits table. |
| `src/components/hr/engrep/ZoneCExceptions.tsx` | Zone C exception panels: claimed-but-not-live, live-but-unclaimed. |
| `src/components/hr/engrep/AdjudicationRow.tsx` | Per-row Band cell, Written basis cell, addendum dialog. |
| `src/components/hr/engrep/LockPeriodButton.tsx` | LOCK PERIOD control and confirmation dialog. |
| `src/hr/engrep/api.ts` | All ENGREP reads (`.from`) and writes (`.rpc`). |
| `src/hr/engrep/types.ts` | ENGREP TypeScript types. |
| `src/App.tsx` | Route registration for both ENGREP screens. |
| `src/integrations/supabase/types.ts` | Generated database types (contains engrep names). |
| `docs/HANDOVER/06-live-state-verification.md` | Handover doc referencing ENGREP live-state verification. |
| `supabase/migrations/20260903213446_eae02870-2906-4eb8-ad5c-b2fa2180b7ab.sql` | ENGREP migration. |
| `supabase/migrations/20260903213741_5d2ab990-7059-448e-8f8f-7efc41934a68.sql` | ENGREP migration. |
| `supabase/migrations/20260903214028_005dd086-b014-40b9-bbd3-dca1888398ce.sql` | ENGREP migration. |
| `supabase/migrations/20260903214250_709a1119-c3b5-4333-894e-5b8830ae4faa.sql` | ENGREP migration. |
| `supabase/migrations/20260903214456_2a7c3b22-87e8-4fb3-ac0b-d98dfd81e193.sql` | ENGREP migration. |
| `supabase/migrations/20260903214813_2395c72f-6084-4403-93fc-48026a938589.sql` | ENGREP migration. |
| `supabase/migrations/20260903215049_6c2f32ee-eda9-4e42-a41d-82d205627229.sql` | ENGREP migration. |
| `supabase/migrations/20260903222137_fbee89ac-76f9-410b-ba75-153d57bee88b.sql` | ENGREP migration. |
| `supabase/migrations/20260903222225_7da7dbf0-bdc7-431f-a4fe-43e8617f9182.sql` | ENGREP migration. |
| `supabase/migrations/20260903225300_fa8129d4-bb2d-4129-8394-0e3ee6098e34.sql` | ENGREP migration. |
| `supabase/migrations/20260910085636_fba75d5e-a4cc-45e3-9ac1-7dd551c0d368.sql` | ENGREP catalog-snapshot index + prune cron. |
| `supabase/migrations/20260910092859_c583edb3-a01e-4977-b7de-efa8fd4f968b.sql` | ENGREP migration. |

No file under `supabase/functions/` references engrep, and `supabase/config.toml` contains no engrep entry: ABSENT.

## 2. Routes

`src/App.tsx` line 666:

```tsx
          <Route path="/me/contribution" element={<HRSignedInRoute><MyContribution /></HRSignedInRoute>} />
```

`src/App.tsx` line 667:

```tsx
          <Route path="/hr/engineering/contribution" element={<HRSignedInRoute><EngineeringContribution /></HRSignedInRoute>} />
```

Lazy imports, `src/App.tsx` lines 227 and 229:

```tsx
const MyContribution = lazy(() => import('./pages/me/MyContribution'));
const EngineeringContribution = lazy(() => import('./pages/hr/EngineeringContribution'));
```

## 3. Guards

Both routes are wrapped in `HRSignedInRoute`. There is no `allowedRoles` array or any role list anywhere in the guard: ABSENT.

`src/hr/components/HRSignedInRoute.tsx` lines 11-25:

```tsx
export default function HRSignedInRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  return <>{children}</>;
}
```

The adjudicator screen additionally gates its controls on the database, `src/pages/hr/EngineeringContribution.tsx` lines 61-65:

```tsx
  const adjudicatorQuery = useQuery({
    queryKey: ['engrep', 'is-adjudicator'],
    queryFn: () => isAdjudicator().catch(() => false),
  });
```

## 4. Feature presence

| Feature | File | Line | Status |
| --- | --- | --- | --- |
| Daily / Weekly / Monthly toggle | `src/components/hr/engrep/WindowToggle.tsx` | 15-19, 21-33 | `src/components/hr/engrep/WindowToggle.tsx:15`; mounted at `src/pages/hr/EngineeringContribution.tsx:78` |
| tile A1, edits in window with per-engineer split | `src/components/hr/engrep/ZoneALovableEdits.tsx` | 144-148 | `src/components/hr/engrep/ZoneALovableEdits.tsx:144` (split via `engineerBreakdown` at line 55, used line 147) |
| tile A2, live verified n of m | `src/components/hr/engrep/ZoneALovableEdits.tsx` | 149-153 | `src/components/hr/engrep/ZoneALovableEdits.tsx:149` (`liveFraction` built line 139) |
| tile A3, flags raised | `src/components/hr/engrep/ZoneALovableEdits.tsx` | 154-158 | `src/components/hr/engrep/ZoneALovableEdits.tsx:154` |
| Zone A table with a per-row W1-W5 band control | `src/components/hr/engrep/ZoneALovableEdits.tsx` / `AdjudicationRow.tsx` | 214 / 32-38, 224-235 | `src/components/hr/engrep/ZoneALovableEdits.tsx:214` → `src/components/hr/engrep/AdjudicationRow.tsx:224` |
| per-row written basis input | `src/components/hr/engrep/AdjudicationRow.tsx` | 240-250 | `src/components/hr/engrep/AdjudicationRow.tsx:248` |
| tile B1, human commits | `src/components/hr/engrep/ZoneBExternalCommits.tsx` | 150-156 | `src/components/hr/engrep/ZoneBExternalCommits.tsx:152` |
| tile B2, distinct author emails | `src/components/hr/engrep/ZoneBExternalCommits.tsx` | 157-170 | `src/components/hr/engrep/ZoneBExternalCommits.tsx:167` |
| Zone B table with band and basis controls | `src/components/hr/engrep/ZoneBExternalCommits.tsx` | 217 | `src/components/hr/engrep/ZoneBExternalCommits.tsx:217` (same `AdjudicationCells`) |
| Zone C exceptions, claimed-but-not-live | `src/components/hr/engrep/ZoneCExceptions.tsx` | 196-220 | `src/components/hr/engrep/ZoneCExceptions.tsx:199` (`PANEL_1_HEADING`) |
| Zone C exceptions, live-but-unclaimed | `src/components/hr/engrep/ZoneCExceptions.tsx` | 27, 223-270 | `src/components/hr/engrep/ZoneCExceptions.tsx:226` (`PANEL_2_HEADING`) |
| Lock Period control | `src/components/hr/engrep/LockPeriodButton.tsx` | 89-98 | `src/components/hr/engrep/LockPeriodButton.tsx:96`; mounted `src/pages/hr/EngineeringContribution.tsx:140` |
| stacked or card layout for viewports below 640px | — | — | ABSENT — no `sm:hidden` / `hidden sm:` / card fallback exists. Below 640px the tiles stack via `grid gap-3 sm:grid-cols-3` (`src/components/hr/engrep/ZoneALovableEdits.tsx:143`) and `grid gap-3 sm:grid-cols-2` (`src/components/hr/engrep/ZoneBExternalCommits.tsx:149`), but both tables remain `<table>` inside `overflow-x-auto` (`ZoneALovableEdits.tsx:161`, `ZoneBExternalCommits.tsx:173`) with no stacked/card variant. |

## 5. Data access

`src/hr/engrep/api.ts:34`

```ts
      .from('engrep_window_summary')
```

`src/hr/engrep/api.ts:49`

```ts
      .from('engrep_window_summary')
```

`src/hr/engrep/api.ts:62`

```ts
    .from('engrep_rows')
```

`src/hr/engrep/api.ts:74`

```ts
    await db.from('engrep_claimed_not_live').select('*').eq('window_id', windowId),
```

`src/hr/engrep/api.ts:81`

```ts
      .from('engrep_unclaimed_objects')
```

`src/hr/engrep/api.ts:89`

```ts
  return db.rpc(fn, args).then((res) => unwrap(res) as T);
```

`src/hr/engrep/api.ts:93`

```ts
  return rpc<string>('engrep_open_window', {
```

`src/hr/engrep/api.ts:100`

```ts
  return rpc<string>('engrep_ingest_row', {
```

`src/hr/engrep/api.ts:120`

```ts
  return rpc('engrep_set_liveness', { p_row_id: rowId, p_verdict: verdict });
```

`src/hr/engrep/api.ts:124`

```ts
  return rpc('engrep_adjudicate', { p_row_id: rowId, p_band: band, p_basis: basis });
```

`src/hr/engrep/api.ts:128`

```ts
  return rpc('engrep_lock_window', { p_window_id: windowId });
```

`src/hr/engrep/api.ts:132`

```ts
  return rpc('engrep_detect_unclaimed', { p_window_id: windowId });
```

`src/hr/engrep/api.ts:136`

```ts
  return rpc('engrep_mark_harvested', { p_window_id: windowId });
```

`src/hr/engrep/api.ts:141`

```ts
  return rpc<boolean>('engrep_is_adjudicator');
```

`src/components/hr/engrep/ZoneALovableEdits.tsx:41`

```ts
    .from('engrep_rows')
```

`src/components/hr/engrep/ZoneBExternalCommits.tsx:42`

```ts
    .from('engrep_rows')
```

`src/components/hr/engrep/ZoneCExceptions.tsx:40`

```ts
    .from('engrep_windows')
```

`src/components/hr/engrep/ZoneCExceptions.tsx:66`

```ts
        .from('engrep_unclaimed_objects')
```

`src/components/hr/engrep/AdjudicationRow.tsx:80`

```ts
      const { error } = await db.from('engrep_addenda').insert({
```

`src/components/hr/engrep/AdjudicationRow.tsx:147`

```ts
        .from('engrep_windows')
```

`src/pages/me/MyContribution.tsx:50`

```ts
    .from('engrep_my_rows')
```

View / table / function names appearing above: `engrep_window_summary`, `engrep_rows`, `engrep_claimed_not_live`, `engrep_unclaimed_objects`, `engrep_windows`, `engrep_addenda`, `engrep_my_rows`, `engrep_open_window`, `engrep_ingest_row`, `engrep_set_liveness`, `engrep_adjudicate`, `engrep_lock_window`, `engrep_detect_unclaimed`, `engrep_mark_harvested`, `engrep_is_adjudicator`.

## 6. Navigation

ABSENT. No sidebar or navigation file references `/hr/engineering/contribution` or `/me/contribution`; the only occurrences of either path in `src/` are the two `<Route>` elements in `src/App.tsx`.

## 7. Verbatim source

Primary ENGREP screen: `src/pages/hr/EngineeringContribution.tsx`. It is primary because it is the adjudicator surface that mounts the window toggle, Zones A, B and C and the LOCK PERIOD control. The second candidate, `src/pages/me/MyContribution.tsx`, is an engineer's read-only self-view with no adjudication controls.

### src/pages/hr/EngineeringContribution.tsx

```tsx
/**
 * ENGREP — Engineering Contribution Report (page shell, P08).
 *
 * Zones A, B, C and LOCK PERIOD are intentionally empty here; P09 to P12 fill them.
 * The route sits behind HRSignedInRoute, which checks authentication only — RLS and the
 * adjudicator check inside each RPC are the whole control.
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

const RESTRICTED_NOTE = 'Adjudication is restricted to the Lead Engineer.';

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
```
Attribution trailer check — 10 Sep 2026.
