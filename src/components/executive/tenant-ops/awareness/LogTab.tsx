import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FileSpreadsheet, FileText, Loader2, PhoneCall } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCard } from '@/components/executive/tenant-ops/workspace/payment-behavior/shared';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import {
  SUBJECT_LABEL, TEAM_LABEL, awarenessLabel, callResultLabel, explainedLabel, stageLabel, telHref,
} from '@/lib/awarenessCallLabels';
import { count, kampalaDateTime, statusLabel } from '@/lib/awarenessMonitoringLabels';
import { exportAwarenessLogCsv, exportAwarenessLogXlsx } from '@/lib/awarenessCallsExport';
import {
  fetchAllAwarenessLog, useAwarenessLog, type AwarenessFilters, type AwarenessLogRow, type AwarenessOptions,
} from '@/hooks/useAwarenessMonitoring';
import { PAGE_SIZE, Pager } from './shared';

const answers = (r: AwarenessLogRow) => (r.call_result === 'answered'
  ? `${awarenessLabel(r.aware_30m)} · ${awarenessLabel(r.aware_merchant_codes)} · ${explainedLabel(r.explained)}`
  : '—');

/** Every call in the filters, newest first, with who was phoned and by whom. Exports the whole filtered log, not just this page. */
export function LogTab({
  filters, options, enabled,
}: { filters: AwarenessFilters; options: AwarenessOptions | undefined; enabled: boolean }) {
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const sig = Object.values(filters).join('|');
  useEffect(() => setPage(0), [sig]);

  const q = useAwarenessLog(filters, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }, enabled);
  const data = q.data;
  const rows = data?.rows ?? [];

  const runExport = async (kind: 'csv' | 'xlsx') => {
    setExporting(kind);
    const id = toast.loading('Preparing the call log…');
    try {
      const all = await fetchAllAwarenessLog(filters);
      if (all.rows.length === 0) { toast.info('No calls to export for these filters', { id }); return; }
      if (kind === 'csv') exportAwarenessLogCsv(all.rows, filters);
      else await exportAwarenessLogXlsx(all.rows, filters, options?.callers.find((c) => c.id === filters.caller)?.name);
      toast.success(all.truncated
        ? `Exported the first ${count(all.rows.length)} of ${count(all.total)} calls. Narrow the filters to get the rest.`
        : `Exported ${count(all.rows.length)} calls`, { id });
    } catch (e) {
      toast.error((e as { message?: string })?.message || 'Could not export the call log', { id });
    } finally {
      setExporting(null);
    }
  };

  return (
    <SectionCard
      title={<>Call log {data && <Badge variant="outline" className="text-[10px]">{count(data.total)}</Badge>}</>}
      description="Newest first. Times are Kampala time. The export holds every call that matches the filters."
      actions={(
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button type="button" variant="outline" size="sm" className="h-9 flex-1 gap-1.5 sm:flex-none" disabled={!!exporting || (data?.total ?? 0) === 0} onClick={() => void runExport('csv')}>
            {exporting === 'csv' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            Export CSV
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-9 flex-1 gap-1.5 sm:flex-none" disabled={!!exporting || (data?.total ?? 0) === 0} onClick={() => void runExport('xlsx')}>
            {exporting === 'xlsx' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
            Export Excel
          </Button>
        </div>
      )}
    >
      {q.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <WorkspaceEmptyState icon={PhoneCall} title="No calls match these filters" hint="Try a wider date range or fewer filters." />
      ) : (
        <>
          <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dialled</TableHead>
                  <TableHead>Person</TableHead>
                  <TableHead>Caller</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>30M · codes · explained</TableHead>
                  <TableHead>Rent Plan</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">{kampalaDateTime(r.dial_started_at)}</TableCell>
                    <TableCell>
                      <p className="text-sm font-medium">{r.subject_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {SUBJECT_LABEL[r.subject_type]} · {telHref(r.subject_phone)
                          ? <a className="text-primary hover:underline" href={telHref(r.subject_phone)!}>{r.subject_phone}</a>
                          : r.subject_phone}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm">{r.caller_name}</p>
                      <p className="text-xs text-muted-foreground">{TEAM_LABEL[r.caller_team]}</p>
                    </TableCell>
                    <TableCell className="text-xs">{stageLabel(r.pipeline_stage)}</TableCell>
                    <TableCell><Badge variant={r.call_result === 'answered' ? 'secondary' : 'outline'} className="text-[10px]">{callResultLabel(r.call_result)}</Badge></TableCell>
                    <TableCell className="text-xs">{answers(r)}</TableCell>
                    <TableCell className="text-xs">
                      <p className="font-mono">{r.plan_code}</p>
                      <p className="text-muted-foreground">{statusLabel(r.current_status)}{r.region ? ` · ${r.region}` : ''}</p>
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground" title={r.note ?? undefined}>{r.note || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="space-y-2 lg:hidden">
            {rows.map((r) => (
              <WorkspaceMobileRow
                key={r.id}
                title={r.subject_name}
                badge={<Badge variant={r.call_result === 'answered' ? 'secondary' : 'outline'} className="text-[10px]">{callResultLabel(r.call_result)}</Badge>}
                fields={[
                  { label: 'Dialled', value: kampalaDateTime(r.dial_started_at) },
                  { label: 'Person', value: `${SUBJECT_LABEL[r.subject_type]} · ${r.subject_phone}` },
                  { label: 'Caller', value: `${r.caller_name} (${TEAM_LABEL[r.caller_team]})` },
                  { label: 'Stage', value: stageLabel(r.pipeline_stage) },
                  { label: 'Rent Plan', value: `${r.plan_code} · ${statusLabel(r.current_status)}` },
                  { label: 'Region', value: r.region || '—' },
                  { label: '30M · codes · explained', value: answers(r), full: true },
                  ...(r.note ? [{ label: 'Note', value: r.note, full: true }] : []),
                ]}
              />
            ))}
          </div>
          <Pager page={page} total={data?.total ?? 0} onPage={setPage} noun="calls" />
        </>
      )}
    </SectionCard>
  );
}
