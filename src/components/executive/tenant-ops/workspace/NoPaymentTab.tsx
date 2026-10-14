/**
 * Tenant Ops "N+ DAYS NO PAYMENT" tab (N is staff-selectable, default 20, kept in the URL as ?days=).
 *
 * Presentation only — every figure (days since last payment, progress %, the
 * per-agent N+ / N+10 / N+20 counts) comes from get_tenant_ops_no_payment_report_v2()
 * via useTenantOpsNoPaymentReportV2. No client-side arithmetic beyond
 * formatting and the agent selector, which just re-issues the same RPC
 * with p_agent_id set — the server does the filtering.
 *
 * Visual language matched to the rest of Tenant Ops -> Classic: KPICard with
 * the success/warning/destructive/primary semantic color tokens
 * (TenantOpsHome.tsx, ManagementOverviewTab.tsx), section content wrapped in
 * a Card the same way TenantCommunicationsTab.tsx wraps its list, and the
 * searchable selector idiom used in other executive reports.
 */
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, CalendarX2, Check, ChevronsUpDown, FileDown, Sheet as SheetIcon, Users } from 'lucide-react';
import { downloadPdf, generateNoPaymentPdfForDays } from '@/lib/tenantOpsWeeklyPerformancePdf';
import { exportNoPaymentXlsx, summariseNoPayment } from '@/lib/tenantOpsNoPaymentReport';
import { noPaymentBands, noPaymentFileStem, withoutPaymentText } from '@/lib/noPaymentDays';
import { formatUGX } from '@/lib/rentCalculations';
import { useNoPaymentDays } from '@/hooks/useNoPaymentDays';
import { useTenantOpsNoPaymentReportV2 } from '@/hooks/useTenantOpsNoPaymentReportV2';
import { DaysWithoutPaymentControl } from '@/components/executive/tenant-ops/workspace/DaysWithoutPaymentControl';
import { useTenantNoPaymentNotesSummaries } from '@/hooks/useTenantNoPaymentNotes';
import { KPICard } from '@/components/executive/KPICard';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { TenantNotesPopover } from '@/components/executive/tenant-ops/workspace/TenantNotesPopover';

const dayLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const dormancyTone = (days: number, mid: number, high: number) =>
  days >= high ? 'text-destructive' : days >= mid ? 'text-warning' : 'text-foreground';

export default function NoPaymentTab() {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [chosenDays, setChosenDays] = useNoPaymentDays();
  const { data, isLoading, isFetching } = useTenantOpsNoPaymentReportV2(chosenDays, agentId);
  const { data: noteSummaries } = useTenantNoPaymentNotesSummaries();

  // Titles, bands and figures always come from the report on screen, so they can never disagree with each other
  // while a newly chosen number is still loading.
  const days = data?.min_days ?? chosenDays;
  const [band1, band2, band3] = noPaymentBands(days);
  const updating = isFetching && data !== undefined && data.min_days !== chosenDays;

  const agents = data?.agent_summary ?? [];
  const totals = useMemo(
    () => (data ? summariseNoPayment(data) : { min: 0, min10: 0, min20: 0, outstanding: 0, dailyAtRisk: 0 }),
    [data],
  );

  const tenants = data?.tenants ?? [];
  const selectedAgent = agents.find((agent) => agent.agent_id === agentId && agentId !== null);
  const chooseAgent = (id: string | null) => {
    setAgentId(id);
    setAgentPickerOpen(false);
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <DaysWithoutPaymentControl days={chosenDays} onChange={setChosenDays} idPrefix="no-payment-days" />
      {updating && <p className="text-[11px] text-muted-foreground" data-testid="no-payment-updating">Updating to {chosenDays}+ days…</p>}
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={!data}
          onClick={() =>
            data &&
            downloadPdf(
              generateNoPaymentPdfForDays(data, selectedAgent?.label ?? null),
              `Welile_TenantOps_${noPaymentFileStem(data.min_days)}_${new Date().toISOString().slice(0, 10)}.pdf`,
            )
          }
        >
          <FileDown className="h-4 w-4" /> Export PDF
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={!data}
          onClick={() => data && exportNoPaymentXlsx(data, selectedAgent?.label ?? null)}
        >
          <SheetIcon className="h-4 w-4" /> Export Excel
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Tenants on a live, landlord-funded Rent Plan who have gone {days} or more days without a single
        payment — the same "at risk" plans the Repayment Watchlist already tracks, grouped here by how
        long they have gone quiet.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KPICard title={`${band1}+ days`} value={totals.min} icon={CalendarX2} color="bg-warning/10 text-warning" />
        <KPICard title={`${band2}+ days`} value={totals.min10} icon={AlertTriangle} color="bg-destructive/10 text-destructive" />
        <KPICard title={`${band3}+ days`} value={totals.min20} icon={AlertTriangle} color="bg-destructive/10 text-destructive" />
      </div>

      <Card className="min-w-0 border shadow-sm">
        <CardHeader className="px-3 pb-2 sm:px-4">
          <CardTitle className="text-sm font-semibold">Agent Accountability</CardTitle>
          <p className="text-xs text-muted-foreground">Filter the list below by agent</p>
        </CardHeader>
        <CardContent className="px-3 pb-3 sm:px-4">
          <Popover open={agentPickerOpen} onOpenChange={setAgentPickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" aria-expanded={agentPickerOpen} aria-label="Filter by agent" className="flex h-auto min-h-11 w-full min-w-0 justify-between gap-3 px-3 py-2 text-left font-normal sm:max-w-sm">
                <span className="min-w-0 whitespace-normal break-words font-medium">{selectedAgent?.label ?? 'All agents'}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  <Badge variant="secondary" className="tabular-nums">{selectedAgent?.gte_min ?? totals.min}</Badge>
                  <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
              <Command>
                <CommandInput placeholder="Search agent name…" aria-label="Search agents" />
                <CommandList className="max-h-72">
                  <CommandEmpty>No agents found.</CommandEmpty>
                  <CommandItem value="All agents" onSelect={() => chooseAgent(null)} className="min-h-11 gap-2">
                    <Check className={`h-4 w-4 shrink-0 ${agentId === null ? 'opacity-100' : 'opacity-0'}`} />
                    <span className="min-w-0 flex-1 truncate">All agents</span>
                    <Badge variant="secondary" className="shrink-0 tabular-nums">{totals.min}</Badge>
                  </CommandItem>
                  {agents.map((agent) => (
                    <CommandItem key={agent.agent_id ?? 'unassigned'} value={`${agent.label} ${agent.agent_id ?? ''}`} onSelect={() => chooseAgent(agent.agent_id)} className="min-h-11 gap-2">
                      <Check className={`h-4 w-4 shrink-0 ${agentId !== null && agentId === agent.agent_id ? 'opacity-100' : 'opacity-0'}`} />
                      <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug">{agent.label}</span>
                      <Badge variant="secondary" className="shrink-0 tabular-nums">{agent.gte_min}</Badge>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </CardContent>
      </Card>

      {tenants.length === 0 ? (
        <WorkspaceEmptyState
          icon={Users}
          title={`No tenants have gone ${withoutPaymentText(days)}`}
          hint={agentId ? 'Nothing for this agent right now.' : 'Every live, funded Rent Plan has a recent payment on file.'}
        />
      ) : (
        <Card className="border shadow-sm">
          <CardContent className="px-2 pb-3 pt-3 sm:px-4">
            <div className="space-y-2 lg:hidden">
              {tenants.map((t) => (
                <WorkspaceMobileRow
                  key={t.tenant_id}
                  title={t.tenant_name ?? 'Unnamed tenant'}
                  badge={
                    <span className={`text-sm font-bold tabular-nums ${dormancyTone(t.days_since_last_payment, band2, band3)}`}>
                      {t.days_since_last_payment}d
                    </span>
                  }
                  fields={[
                    { label: 'Account number', value: t.tenant_account_number ?? '—' },
                    { label: 'Agent responsible', value: t.agent_name },
                    { label: 'Last payment', value: dayLabel(t.date_of_last_payment) },
                    { label: 'Expected daily payment', value: formatUGX(t.expected_daily_payment) },
                    { label: 'Outstanding balance', value: formatUGX(t.outstanding_balance) },
                    { label: 'Total paid', value: formatUGX(t.total_amount_paid) },
                    { label: 'Progress', value: `${t.progress_pct}%` },
                    { label: 'Status', value: t.tenant_status },
                  ]}
                  actions={<TenantNotesPopover tenantId={t.tenant_id} summary={noteSummaries?.get(t.tenant_id)} />}
                />
              ))}
            </div>

            <div className="hidden overflow-auto rounded-lg border lg:block">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-xs">Tenant Name</TableHead>
                    <TableHead className="text-xs">Tenant / Account Number</TableHead>
                    <TableHead className="text-xs">Agent Responsible</TableHead>
                    <TableHead className="text-xs">Date of Last Payment</TableHead>
                    <TableHead className="text-xs">Days Since Last Payment</TableHead>
                    <TableHead className="text-xs">Expected Daily Payment</TableHead>
                    <TableHead className="text-xs">Outstanding Balance</TableHead>
                    <TableHead className="text-xs">Total Amount Paid</TableHead>
                    <TableHead className="text-xs">Progress %</TableHead>
                    <TableHead className="text-xs">Tenant Status</TableHead>
                    <TableHead className="text-xs">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenants.map((t) => (
                    <TableRow key={t.tenant_id}>
                      <TableCell className="text-xs font-medium">{t.tenant_name ?? 'Unnamed tenant'}</TableCell>
                      <TableCell className="text-xs">{t.tenant_account_number ?? '—'}</TableCell>
                      <TableCell className="text-xs">{t.agent_name}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{dayLabel(t.date_of_last_payment)}</TableCell>
                      <TableCell className={`text-xs font-semibold tabular-nums ${dormancyTone(t.days_since_last_payment, band2, band3)}`}>
                        {t.days_since_last_payment}d
                      </TableCell>
                      <TableCell className="text-xs">{formatUGX(t.expected_daily_payment)}</TableCell>
                      <TableCell className="text-xs">{formatUGX(t.outstanding_balance)}</TableCell>
                      <TableCell className="text-xs">{formatUGX(t.total_amount_paid)}</TableCell>
                      <TableCell className="text-xs">{t.progress_pct}%</TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {t.tenant_status.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        <TenantNotesPopover tenantId={t.tenant_id} summary={noteSummaries?.get(t.tenant_id)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
