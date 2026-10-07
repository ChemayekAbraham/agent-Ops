import { useEffect, useState } from 'react';
import { CheckCircle2, Phone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Callout, SectionCard } from '@/components/executive/tenant-ops/workspace/payment-behavior/shared';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { TEAM_LABEL, telHref } from '@/lib/awarenessCallLabels';
import { count, kampalaDate, percent, statusLabel } from '@/lib/awarenessMonitoringLabels';
import { useAwarenessGaps, type AwarenessFilters, type AwarenessGapRow, type AwarenessOutcome } from '@/hooks/useAwarenessMonitoring';
import { PAGE_SIZE, Pager } from './shared';

function PhoneLink({ phone }: { phone: string | null | undefined }) {
  const href = telHref(phone);
  if (!phone) return <span className="text-muted-foreground">—</span>;
  return href ? (
    <a href={href} className="inline-flex items-center gap-1 text-primary hover:underline" aria-label={`Call ${phone}`}>
      <Phone className="h-3 w-3" />{phone}
    </a>
  ) : <span>{phone}</span>;
}

const ALL = '__all__';

const OUTCOME_LABEL: Record<AwarenessOutcome, string> = { approved: 'Approved', rejected: 'Rejected' };

function OutcomeBadge({ outcome }: { outcome: AwarenessOutcome | undefined }) {
  if (!outcome) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant={outcome === 'rejected' ? 'destructive' : 'secondary'} className="text-[10px]" data-testid="gap-outcome">
      {OUTCOME_LABEL[outcome]}
    </Badge>
  );
}

const who = (name: string | null | undefined, phone: string | null | undefined) => (
  <div className="min-w-0">
    <p className="truncate font-medium">{name || '—'}</p>
    <p className="text-xs"><PhoneLink phone={phone} /></p>
  </div>
);

/**
 * Rent Plans that moved past a stage in the dates chosen with no awareness call recorded at that stage. The page's team, region,
 * district and request status filters apply; the filters that describe a call (caller, person type, call result, answer) cannot,
 * because there is no call to describe.
 */
export function GapsTab({ filters, enabled }: { filters: AwarenessFilters; enabled: boolean }) {
  const [page, setPage] = useState(0);
  const [outcome, setOutcome] = useState<AwarenessOutcome | null>(null);
  const sig = [filters.startIso, filters.endIso, filters.team, filters.region, filters.district, filters.status, outcome].join('|');
  useEffect(() => setPage(0), [sig]);

  const q = useAwarenessGaps(filters, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }, enabled, outcome);
  const data = q.data;
  const rows = data?.rows ?? [];
  const ignored = [filters.caller && 'caller', filters.subjectType && 'person type', filters.result && 'call result', filters.answer && 'answer choice']
    .filter(Boolean) as string[];

  return (
    <div className="space-y-3">
      {ignored.length > 0 && (
        <Callout tone="info">
          The {ignored.join(', ')} {ignored.length === 1 ? 'filter does' : 'filters do'} not apply here: a Rent Plan with no call has no caller, person, result or answer.
        </Callout>
      )}
      {data && (
        <Callout tone={data.tracking_started ? 'info' : 'warning'} title="How to read this">
          {data.tracking_started
            ? `A Rent Plan appears once for each stage it moved past with no awareness call recorded at that stage, whether it was approved or rejected there. Calls have only been recorded since ${kampalaDate(data.tracking_started)}, so stages passed before then appear here too.`
            : 'No awareness call has been recorded yet, so every stage a Rent Plan moved past appears here.'}
        </Callout>
      )}

      <SectionCard
        title={<>Requests without a call {data && <Badge variant="outline" className="text-[10px]">{count(data.total)}</Badge>}</>}
        description={data ? `${count(data.totals.passed)} stage moves between ${kampalaDate(data.window.start_day)} and ${kampalaDate(data.window.end_day)}${data.totals.rejected ? ` (${count(data.totals.rejected)} rejected)` : ''}; ${count(data.totals.with_call)} had a call (${percent(data.totals.covered_pct)}).` : undefined}
        actions={(
          <Select value={outcome ?? ALL} onValueChange={(v) => setOutcome(v === ALL ? null : (v as AwarenessOutcome))}>
            <SelectTrigger className="h-10 w-full text-xs sm:w-44" aria-label="Outcome"><SelectValue placeholder="All outcomes" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className="text-xs">All outcomes</SelectItem>
              <SelectItem value="approved" className="text-xs">Approved</SelectItem>
              <SelectItem value="rejected" className="text-xs">Rejected</SelectItem>
            </SelectContent>
          </Select>
        )}
      >
        {q.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : rows.length === 0 ? (
          <WorkspaceEmptyState icon={CheckCircle2} title="Every Rent Plan that moved past a stage had a call" hint="Nothing is missing for these dates and filters." />
        ) : (
          <>
            <div className="hidden lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tenant</TableHead>
                    <TableHead>Landlord</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Moved past (outcome)</TableHead>
                    <TableHead>On</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Status now</TableHead>
                    <TableHead className="text-right">Calls at other stages</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r: AwarenessGapRow) => (
                    <TableRow key={`${r.rent_request_id}-${r.stage}`}>
                      <TableCell>{who(r.tenant_name, r.tenant_phone)}</TableCell>
                      <TableCell>{who(r.landlord_name, r.landlord_phone)}</TableCell>
                      <TableCell className="text-sm">{r.agent_name || '—'}</TableCell>
                      <TableCell>
                        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">{r.stage_label} <OutcomeBadge outcome={r.outcome} /></p>
                        <p className="text-xs text-muted-foreground">{TEAM_LABEL[r.team]} · {r.plan_code}</p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{kampalaDate(r.passed_day)}</TableCell>
                      <TableCell className="text-xs">{r.passed_by_name || '—'}</TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{statusLabel(r.current_status)}</Badge></TableCell>
                      <TableCell className="text-right tabular-nums">{count(r.calls_at_other_stages)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2 lg:hidden">
              {rows.map((r) => (
                <WorkspaceMobileRow
                  key={`${r.rent_request_id}-${r.stage}`}
                  title={r.tenant_name || 'Unnamed tenant'}
                  badge={<Badge variant="outline" className="text-[10px]">{r.stage_label}</Badge>}
                  fields={[
                    { label: 'Tenant phone', value: <PhoneLink phone={r.tenant_phone} /> },
                    { label: 'Landlord', value: r.landlord_name || '—' },
                    { label: 'Landlord phone', value: <PhoneLink phone={r.landlord_phone} /> },
                    { label: 'Agent', value: r.agent_name || '—' },
                    { label: 'Outcome', value: <OutcomeBadge outcome={r.outcome} /> },
                    { label: 'Moved past on', value: kampalaDate(r.passed_day) },
                    { label: 'By', value: r.passed_by_name || '—' },
                    { label: 'Status now', value: statusLabel(r.current_status) },
                    { label: 'Calls at other stages', value: count(r.calls_at_other_stages) },
                  ]}
                />
              ))}
            </div>
            <Pager page={page} total={data?.total ?? 0} onPage={setPage} noun="stage moves" />
          </>
        )}
      </SectionCard>
    </div>
  );
}
