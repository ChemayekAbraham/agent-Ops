import { useMemo, type ComponentType, type ReactNode } from 'react';
import { AlertTriangle, BadgeCheck, Bike, Building2, FileText, Loader2, Network, Phone, PhoneCall, RefreshCw, Smartphone, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAgentOpsNetworkOverview } from '@/hooks/useAgentOpsNetworkOverview';
import { formatUGX } from '@/lib/rentCalculations';
import { telHref } from '@/lib/awarenessCallLabels';
import { kampalaLabel } from '@/lib/kampalaDays';
import { networkErrorMessage, networkRangeParams } from '@/lib/agentNetwork';
import type { AgentNetworkOverview } from '@/lib/agentNetwork';

// "Agent Network" tab of the Agent Operations Overview. Every figure is shown exactly as get_agent_ops_network_overview returns it:
// no sums, rates or re-derivation here. Semantic tokens only.

const n = (v: number) => v.toLocaleString('en-US');
const pct = (v: number) => `${v}%`;

function KpiCard({ title, value, hint, icon: Icon }: { title: string; value: string; hint: string; icon: ComponentType<{ className?: string }> }) {
  return (
    <Card className="flex min-h-[104px] flex-col gap-1.5 p-3 sm:p-4" data-testid="network-kpi">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
      </div>
      <p className="text-xl font-bold leading-tight tabular-nums text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </Card>
  );
}

function PhoneLink({ name, phone }: { name: string; phone: string | null }) {
  const href = telHref(phone);
  if (!phone) return <span className="text-muted-foreground">—</span>;
  if (!href) return <span>{phone}</span>;
  return (
    <a href={href} aria-label={`Call ${name} on ${phone}`} className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-primary hover:underline">
      <Phone className="h-3 w-3" /> {phone}
    </a>
  );
}

interface Column<T> { label: string; align?: 'right'; render: (row: T) => ReactNode }

function RankedCard<T extends { agent_id: string; name: string; phone: string | null }>({
  title, caption, rows, columns, empty, testId,
}: { title: string; caption: string; rows: T[]; columns: Column<T>[]; empty: string; testId: string }) {
  return (
    <Card className="space-y-2 p-3 sm:p-4" data-testid={testId}>
      <div>
        <h3 className="text-sm font-bold text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                {columns.map((c) => <TableHead key={c.label} className={c.align === 'right' ? 'text-right' : undefined}>{c.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.agent_id}>
                  <TableCell className="text-xs font-bold tabular-nums text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="whitespace-nowrap font-medium">{r.name}</TableCell>
                  <TableCell><PhoneLink name={r.name} phone={r.phone} /></TableCell>
                  {columns.map((c) => (
                    <TableCell key={c.label} className={c.align === 'right' ? 'whitespace-nowrap text-right tabular-nums' : 'whitespace-nowrap'}>{c.render(r)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading Agent Network">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-[104px] w-full rounded-xl" />)}
      </div>
      <Skeleton className="h-28 w-full rounded-xl" />
      {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-56 w-full rounded-xl" />)}
    </div>
  );
}

function Content({ d }: { d: AgentNetworkOverview }) {
  const c = d.counts;
  const minLine = `at least ${formatUGX(d.range.min_expected)}`;
  return (
    <div className="space-y-4">
      <section aria-label="Agents in the network" className="space-y-2">
        <p className="text-xs text-muted-foreground">Agents in the network today, all time.</p>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4">
          <KpiCard title="Agents" value={n(c.agents)} hint="each person once" icon={Users} />
          <KpiCard title="With service centres" value={n(c.with_service_centres)} hint="agents linked to a service centre" icon={Building2} />
          <KpiCard title="With bikes" value={n(c.with_bikes)} hint="agents with a bike lease" icon={Bike} />
          <KpiCard title="With smartphone plan" value={n(c.with_smartphone_plan)} hint="agents with a smartphone plan" icon={Smartphone} />
          <KpiCard title="Tenants on smartphones" value={n(c.with_smartphone_tenants)} hint="agents with tenants on smartphones" icon={PhoneCall} />
          <KpiCard title="With sub-agents" value={n(c.with_subagents)} hint="agents with a verified sub-agent" icon={Network} />
          <KpiCard title="Posted rent requests" value={n(c.posted_requests)} hint="agents who posted a Rent Plan request" icon={FileText} />
          <KpiCard title="Approved agents" value={n(c.approved_agents)} hint="agents with an approved Rent Plan, ever" icon={BadgeCheck} />
        </div>
      </section>

      <Card className="space-y-3 p-3 sm:p-4" data-testid="network-approved">
        <div>
          <h3 className="text-sm font-bold text-foreground">Approved</h3>
          <p className="text-xs text-muted-foreground">Rent Plan requests approved in the range.</p>
        </div>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Agents</dt><dd className="text-lg font-bold tabular-nums text-foreground">{n(d.approved.agents)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Requests</dt><dd className="text-lg font-bold tabular-nums text-foreground">{n(d.approved.requests)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Amount approved</dt><dd className="text-lg font-bold tabular-nums text-foreground">{formatUGX(d.approved.amount)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Receivables outstanding</dt><dd className="text-lg font-bold tabular-nums text-foreground">{formatUGX(d.approved.receivables_outstanding)}</dd></div>
        </dl>
      </Card>

      <RankedCard
        testId="network-portfolios"
        title="Biggest portfolios"
        caption="Largest live Rent Plan books today (outstanding balance)."
        rows={d.top_portfolios}
        empty="No agent has a live Rent Plan portfolio."
        columns={[
          { label: 'Rent Plans', align: 'right', render: (r) => n(r.plans) },
          { label: 'Portfolio', align: 'right', render: (r) => <span className="font-semibold">{formatUGX(r.portfolio)}</span> },
        ]}
      />
      <RankedCard
        testId="network-collection-rate"
        title="Best collection rate"
        caption={`Collected against expected in the range. Only agents with expected of ${minLine}.`}
        rows={d.top_collection_rate}
        empty={`No agent has expected collections of ${minLine} in this range.`}
        columns={[
          { label: 'Collected', align: 'right', render: (r) => formatUGX(r.collected) },
          { label: 'Expected', align: 'right', render: (r) => formatUGX(r.expected) },
          { label: 'Rate', align: 'right', render: (r) => <span className="font-semibold">{pct(r.rate_pct)}</span> },
        ]}
      />
      <RankedCard
        testId="network-default-rate"
        title="Default rate (lowest first)"
        caption={`Defaulted against outstanding today. Only agents with a live book of ${minLine}.`}
        rows={d.default_rate_ascending}
        empty={`No agent has a live book of ${minLine}.`}
        columns={[
          { label: 'Rent Plans', align: 'right', render: (r) => n(r.plans) },
          { label: 'Outstanding', align: 'right', render: (r) => formatUGX(r.outstanding) },
          { label: 'Defaulted', align: 'right', render: (r) => formatUGX(r.defaulted) },
          { label: 'Rate', align: 'right', render: (r) => <span className="font-semibold">{pct(r.default_rate_pct)}</span> },
        ]}
      />
    </div>
  );
}

/** The range is the page's own range picker value; it is sent as Kampala days. */
export function AgentNetworkTab({ start, end }: { start: Date; end: Date }) {
  const { p_start, p_end } = useMemo(() => networkRangeParams(start, end), [start, end]);
  const { data, isLoading, isFetching, error, refetch } = useAgentOpsNetworkOverview(p_start, p_end);

  return (
    <div className="space-y-3" data-testid="agent-network-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Kampala days {kampalaLabel(data?.range.start || p_start)} → {kampalaLabel(data?.range.end || p_end)}
        </p>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={refetch} disabled={isFetching}>
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </Button>
      </div>
      {isLoading ? (
        <Loading />
      ) : error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load the Agent Network</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{networkErrorMessage(error)}</p>
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={refetch}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : data ? (
        <Content d={data} />
      ) : null}
    </div>
  );
}
