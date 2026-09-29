/**
 * Tenant Ops "20+ DAYS NO PAYMENT" tab.
 *
 * Presentation only — every figure (days since last payment, progress %, the
 * per-agent 20+/30+/40+ counts) comes from get_tenant_ops_no_payment_report()
 * via useTenantOpsNoPaymentReport. No client-side arithmetic beyond
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
import { AlertTriangle, CalendarX2, Check, ChevronsUpDown, Users } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useTenantOpsNoPaymentReport } from '@/hooks/useTenantOpsNoPaymentReport';
import { useTenantNoPaymentNotesSummaries } from '@/hooks/useTenantNoPaymentNotes';
import { KPICard } from '@/components/executive/KPICard';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { TenantNotesPopover } from '@/components/executive/tenant-ops/workspace/TenantNotesPopover';

const dayLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const dormancyTone = (days: number) =>
  days >= 40 ? 'text-destructive' : days >= 30 ? 'text-warning' : 'text-foreground';

export default function NoPaymentTab() {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const { data, isLoading } = useTenantOpsNoPaymentReport(agentId);
  const { data: noteSummaries } = useTenantNoPaymentNotesSummaries();

  const agents = data?.agent_summary ?? [];
  const totals = useMemo(
    () =>
      agents.reduce(
        (acc, a) => ({
          gte_20: acc.gte_20 + a.gte_20,
          gte_30: acc.gte_30 + a.gte_30,
          gte_40: acc.gte_40 + a.gte_40,
        }),
        { gte_20: 0, gte_30: 0, gte_40: 0 },
      ),
    [agents],
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
      <p className="text-sm text-muted-foreground">
        Tenants on a live, landlord-funded Rent Plan who have gone 20 or more days without a single
        payment — the same "at risk" plans the Repayment Watchlist already tracks, grouped here by how
        long they have gone quiet.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KPICard title="20+ days" value={totals.gte_20} icon={CalendarX2} color="bg-warning/10 text-warning" />
        <KPICard title="30+ days" value={totals.gte_30} icon={AlertTriangle} color="bg-destructive/10 text-destructive" />
        <KPICard title="40+ days" value={totals.gte_40} icon={AlertTriangle} color="bg-destructive/10 text-destructive" />
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
                  <Badge variant="secondary" className="tabular-nums">{selectedAgent?.gte_20 ?? totals.gte_20}</Badge>
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
                    <Badge variant="secondary" className="shrink-0 tabular-nums">{totals.gte_20}</Badge>
                  </CommandItem>
                  {agents.map((agent) => (
                    <CommandItem key={agent.agent_id ?? 'unassigned'} value={`${agent.label} ${agent.agent_id ?? ''}`} onSelect={() => chooseAgent(agent.agent_id)} className="min-h-11 gap-2">
                      <Check className={`h-4 w-4 shrink-0 ${agentId !== null && agentId === agent.agent_id ? 'opacity-100' : 'opacity-0'}`} />
                      <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug">{agent.label}</span>
                      <Badge variant="secondary" className="shrink-0 tabular-nums">{agent.gte_20}</Badge>
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
          title="No tenants have gone 20+ days without a payment"
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
                    <span className={`text-sm font-bold tabular-nums ${dormancyTone(t.days_since_last_payment)}`}>
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
                      <TableCell className={`text-xs font-semibold tabular-nums ${dormancyTone(t.days_since_last_payment)}`}>
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
