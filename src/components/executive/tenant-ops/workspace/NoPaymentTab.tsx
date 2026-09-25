/**
 * Tenant Ops "20+ DAYS NO PAYMENT" tab.
 *
 * Presentation only — every figure (days since last payment, progress %, the
 * per-agent 20+/30+/40+ counts) comes from get_tenant_ops_no_payment_report()
 * via useTenantOpsNoPaymentReport. No client-side arithmetic beyond
 * formatting and the agent-pill filter, which just re-issues the same RPC
 * with p_agent_id set — the server does the filtering.
 */
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, CalendarX2, Users } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useTenantOpsNoPaymentReport,
  type TenantOpsAgentNoPaymentSummary,
} from '@/hooks/useTenantOpsNoPaymentReport';
import { KPICard } from '@/components/executive/KPICard';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';

const dayLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const dormancyTone = (days: number) =>
  days >= 40 ? 'text-destructive' : days >= 30 ? 'text-amber-600' : 'text-foreground';

function AgentPill({
  agent,
  active,
  onClick,
}: {
  agent: TenantOpsAgentNoPaymentSummary | { agent_id: null; label: string; gte_20: number };
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-2 text-xs font-medium transition-all touch-manipulation ${
        active
          ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
          : 'bg-muted/50 text-muted-foreground active:bg-muted'
      }`}
    >
      {agent.label}
      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
        {agent.gte_20}
      </Badge>
    </button>
  );
}

export default function NoPaymentTab() {
  const [agentId, setAgentId] = useState<string | null>(null);
  const { data, isLoading } = useTenantOpsNoPaymentReport(agentId);

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
        <KPICard title="20+ days" value={totals.gte_20} icon={CalendarX2} color="bg-amber-500/10 text-amber-600" />
        <KPICard title="30+ days" value={totals.gte_30} icon={AlertTriangle} color="bg-orange-500/10 text-orange-600" />
        <KPICard title="40+ days" value={totals.gte_40} icon={AlertTriangle} color="bg-destructive/10 text-destructive" />
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold text-muted-foreground">Agent Accountability — filter by agent</p>
        <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-1 px-1">
          <AgentPill
            agent={{ agent_id: null, label: `All agents`, gte_20: totals.gte_20 }}
            active={agentId === null}
            onClick={() => setAgentId(null)}
          />
          {agents.map((a) => (
            <AgentPill
              key={a.agent_id ?? 'unassigned'}
              agent={a}
              active={agentId === a.agent_id}
              onClick={() => setAgentId(a.agent_id)}
            />
          ))}
        </div>
      </div>

      {tenants.length === 0 ? (
        <WorkspaceEmptyState
          icon={Users}
          title="No tenants have gone 20+ days without a payment"
          hint={agentId ? 'Nothing for this agent right now.' : 'Every live, funded Rent Plan has a recent payment on file.'}
        />
      ) : (
        <>
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
