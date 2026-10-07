import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PctBar, SectionCard } from '@/components/executive/tenant-ops/workspace/payment-behavior/shared';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { Skeleton } from '@/components/ui/skeleton';
import { TEAM_LABEL } from '@/lib/awarenessCallLabels';
import { count, kampalaDate, percent } from '@/lib/awarenessMonitoringLabels';
import type { AwarenessByTeam, AwarenessGaps } from '@/hooks/useAwarenessMonitoring';
import { triple } from './shared';

const OK = 'hsl(var(--success))';

/** Calls per team, and how many Rent Plans that moved past each stage had a call at it. */
export function StageTeamTab({
  byTeam, gaps, loadingTeam, loadingStage,
}: { byTeam: AwarenessByTeam | undefined; gaps: AwarenessGaps | undefined; loadingTeam: boolean; loadingStage: boolean }) {
  const teams = byTeam?.rows ?? [];
  const stages = gaps?.by_stage ?? [];

  return (
    <div className="space-y-3">
      <SectionCard
        title="By team"
        description="Calls made by each team. Answers are counted over answered calls: knew / heard but unsure / did not know."
      >
        {loadingTeam ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div className="hidden lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Team</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Answered</TableHead>
                    <TableHead className="text-right">People reached</TableHead>
                    <TableHead className="text-right">Callers</TableHead>
                    <TableHead className="text-right">30M</TableHead>
                    <TableHead className="text-right">Merchant codes</TableHead>
                    <TableHead className="text-right">Explained (yes / partly / no)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teams.map((r) => (
                    <TableRow key={r.team}>
                      <TableCell className="font-medium">{TEAM_LABEL[r.team]}</TableCell>
                      <TableCell className="text-right tabular-nums">{count(r.calls)}</TableCell>
                      <TableCell className="text-right tabular-nums">{count(r.answered)} <span className="text-xs text-muted-foreground">({percent(r.answered_pct)})</span></TableCell>
                      <TableCell className="text-right tabular-nums">{count(r.people_reached)}</TableCell>
                      <TableCell className="text-right tabular-nums">{count(r.callers)}</TableCell>
                      <TableCell className="text-right tabular-nums">{triple(r.aware_30m.knew, r.aware_30m.heard, r.aware_30m.did_not_know)}</TableCell>
                      <TableCell className="text-right tabular-nums">{triple(r.aware_merchant_codes.knew, r.aware_merchant_codes.heard, r.aware_merchant_codes.did_not_know)}</TableCell>
                      <TableCell className="text-right tabular-nums">{triple(r.explained.yes, r.explained.partly, r.explained.no)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2 lg:hidden">
              {teams.map((r) => (
                <WorkspaceMobileRow
                  key={r.team}
                  title={TEAM_LABEL[r.team]}
                  fields={[
                    { label: 'Calls', value: count(r.calls) },
                    { label: 'Answered', value: `${count(r.answered)} (${percent(r.answered_pct)})` },
                    { label: 'People reached', value: count(r.people_reached) },
                    { label: 'Callers', value: count(r.callers) },
                    { label: '30M (knew / heard / did not)', value: triple(r.aware_30m.knew, r.aware_30m.heard, r.aware_30m.did_not_know), full: true },
                    { label: 'Merchant codes', value: triple(r.aware_merchant_codes.knew, r.aware_merchant_codes.heard, r.aware_merchant_codes.did_not_know), full: true },
                    { label: 'Explained (yes / partly / no)', value: triple(r.explained.yes, r.explained.partly, r.explained.no), full: true },
                  ]}
                />
              ))}
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="By stage"
        description={gaps
          ? `Rent Plans that moved past each stage between ${kampalaDate(gaps.window.start_day)} and ${kampalaDate(gaps.window.end_day)}, and how many had an awareness call at that stage.`
          : undefined}
      >
        {loadingStage ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <div className="hidden lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stage</TableHead>
                    <TableHead>Team</TableHead>
                    <TableHead className="text-right">Moved past</TableHead>
                    <TableHead className="text-right">With a call</TableHead>
                    <TableHead className="text-right">Without a call</TableHead>
                    <TableHead className="w-48">Covered</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stages.map((s) => (
                    <TableRow key={s.stage}>
                      <TableCell className="font-medium">{s.label}</TableCell>
                      <TableCell>{TEAM_LABEL[s.team]}</TableCell>
                      <TableCell className="text-right tabular-nums">{count(s.passed)}</TableCell>
                      <TableCell className="text-right tabular-nums">{count(s.with_call)}</TableCell>
                      <TableCell className="text-right tabular-nums">{count(s.without_call)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="flex-1"><PctBar value={s.covered_pct} color={OK} label={`${s.label} covered ${percent(s.covered_pct)}`} /></div>
                          <span className="w-12 text-right text-xs tabular-nums">{percent(s.covered_pct)}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2 lg:hidden">
              {stages.map((s) => (
                <WorkspaceMobileRow
                  key={s.stage}
                  title={s.label}
                  fields={[
                    { label: 'Team', value: TEAM_LABEL[s.team] },
                    { label: 'Moved past', value: count(s.passed) },
                    { label: 'With a call', value: count(s.with_call) },
                    { label: 'Without a call', value: count(s.without_call) },
                    { label: 'Covered', value: <div className="space-y-1"><span className="tabular-nums">{percent(s.covered_pct)}</span><PctBar value={s.covered_pct} color={OK} label={`${s.label} covered`} /></div>, full: true },
                  ]}
                />
              ))}
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}
