import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Users } from 'lucide-react';
import { SectionCard } from '@/components/executive/tenant-ops/workspace/payment-behavior/shared';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { TEAM_LABEL } from '@/lib/awarenessCallLabels';
import { count, kampalaDateTime, percent } from '@/lib/awarenessMonitoringLabels';
import type { AwarenessByCaller } from '@/hooks/useAwarenessMonitoring';
import { triple } from './shared';

/** One row per person who made calls: how many, how many were answered, and what they heard. */
export function CallerTab({ data, loading }: { data: AwarenessByCaller | undefined; loading: boolean }) {
  const rows = data?.rows ?? [];
  const cut = data ? data.total_callers > rows.length : false;

  return (
    <SectionCard
      title="By caller"
      description="Most calls first. People are counted once however often they were phoned; answers are over answered calls (knew / heard but unsure / did not know)."
    >
      {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <WorkspaceEmptyState icon={Users} title="No calls match these filters" hint="Try a wider date range or fewer filters." />
      ) : (
        <>
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Caller</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Answered</TableHead>
                  <TableHead className="text-right">People reached</TableHead>
                  <TableHead className="text-right">Rent Plans</TableHead>
                  <TableHead className="text-right">30M</TableHead>
                  <TableHead className="text-right">Merchant codes</TableHead>
                  <TableHead className="text-right">Explained</TableHead>
                  <TableHead>Last call</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.caller_id}>
                    <TableCell className="font-medium">{r.caller_name}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{TEAM_LABEL[r.team]}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{count(r.calls)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(r.answered)} <span className="text-xs text-muted-foreground">({percent(r.answered_pct)})</span></TableCell>
                    <TableCell className="text-right tabular-nums">{count(r.people_reached)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(r.rent_plans_called)}</TableCell>
                    <TableCell className="text-right tabular-nums">{triple(r.aware_30m.knew, r.aware_30m.heard, r.aware_30m.did_not_know)}</TableCell>
                    <TableCell className="text-right tabular-nums">{triple(r.aware_merchant_codes.knew, r.aware_merchant_codes.heard, r.aware_merchant_codes.did_not_know)}</TableCell>
                    <TableCell className="text-right tabular-nums">{triple(r.explained.yes, r.explained.partly, r.explained.no)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{kampalaDateTime(r.last_call_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="space-y-2 lg:hidden">
            {rows.map((r) => (
              <WorkspaceMobileRow
                key={r.caller_id}
                title={r.caller_name}
                badge={<Badge variant="outline" className="text-[10px]">{TEAM_LABEL[r.team]}</Badge>}
                fields={[
                  { label: 'Calls', value: count(r.calls) },
                  { label: 'Answered', value: `${count(r.answered)} (${percent(r.answered_pct)})` },
                  { label: 'People reached', value: count(r.people_reached) },
                  { label: 'Rent Plans', value: count(r.rent_plans_called) },
                  { label: '30M (knew / heard / did not)', value: triple(r.aware_30m.knew, r.aware_30m.heard, r.aware_30m.did_not_know), full: true },
                  { label: 'Merchant codes', value: triple(r.aware_merchant_codes.knew, r.aware_merchant_codes.heard, r.aware_merchant_codes.did_not_know), full: true },
                  { label: 'Explained (yes / partly / no)', value: triple(r.explained.yes, r.explained.partly, r.explained.no), full: true },
                  { label: 'Last call', value: kampalaDateTime(r.last_call_at), full: true },
                ]}
              />
            ))}
          </div>
          {cut && <p className="mt-2 text-[11px] text-muted-foreground">Showing the {count(rows.length)} callers with the most calls, of {count(data?.total_callers)}.</p>}
        </>
      )}
    </SectionCard>
  );
}
