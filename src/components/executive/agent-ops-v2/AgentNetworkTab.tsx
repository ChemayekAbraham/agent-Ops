import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, Bike, Building2, Download, FileText, Info, Loader2, Network, Phone, PhoneCall, RefreshCw, Smartphone, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAgentOpsNetworkOverview } from '@/hooks/useAgentOpsNetworkOverview';
import { formatUGX } from '@/lib/rentCalculations';
import { telHref } from '@/lib/awarenessCallLabels';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { kampalaLabel, kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  DEFAULT_MIN,
  MIN_OPTIONS,
  NET_PRESETS,
  buildRankedCsv,
  clearNetworkParams,
  netPresetOf,
  netPresetRange,
  networkErrorMessage,
  networkRangeParams,
  readNetworkParams,
  writeNetworkParams,
  type AgentNetworkOverview,
  type RankedKind,
  type SmartphoneKey,
} from '@/lib/agentNetwork';

// "Agent Network" tab of the Agent Operations Overview, also the "Agent Network" chip on the Agent Ops home page. Every figure is shown exactly
// as get_agent_ops_network_overview returns it: no sums, rates or re-derivation here. Semantic tokens only.

const n = (v: number) => v.toLocaleString('en-US');
const pct = (v: number) => `${v}%`;

/** One plain line per card, from the definitions in the migration header. */
const HOW_COUNTED: [string, string][] = [
  ['Agents', 'Everyone the Agent Ops agent list counts, each person once; deleted accounts are left out.'],
  ['With service centres', 'Agents who run a service centre, are named on a Rent Plan request as its service-centre manager, or are assigned to one.'],
  ['With bikes', 'Agents with a bike lease that is not rejected and is approved or activated; the card also shows what is still owed.'],
  ['With smartphone plan', 'Agents who own a smartphone sale that has a repayment schedule (not rejected).'],
  ['Tenants on smartphones', 'Agents with at least one tenant recorded as having a smartphone (the same group the Tenant Ops smartphone figures count).'],
  ['With sub-agents', 'Agents with at least one working sub-agent: a verified link to a sub-agent who is also an agent.'],
  ['Posted rent requests', 'Agents who posted at least one Rent Plan request, any status, ever.'],
  ['Approved agents', 'Agents with a Rent Plan that was funded, repaying or completed, ever.'],
  ['Approved (chosen dates)', 'Requests funded, repaying or completed, dated by the CFO approval time (or the funding time), inside the chosen dates.'],
  ['Portfolio', 'The outstanding balance of an agent\'s live Rent Plans (funded or repaying, not ended) today.'],
  ['Collection rate', 'Collections not reversed in the chosen dates against the expected amount pinned for those days; only agents at or above the minimum.'],
  ['Default rate', 'Arrears on the payout clock against the outstanding balance today; only agents with a book at or above the minimum.'],
];

const SMARTPHONE_LABEL: Record<SmartphoneKey, string> = {
  tenants: 'Tenants',
  recorded_smartphone: 'Recorded with a smartphone',
  recorded_without: 'Recorded without',
  confirmed_smartphone: 'Confirmed smartphone',
  confirmed_feature_phone: 'Confirmed feature phone',
  device_unknown: 'Device unknown',
  joined: 'Joined in the dates',
  joined_recorded_smartphone: 'Joined with a smartphone',
  checks: 'Checks in the dates',
  checks_smartphone: 'Checks: smartphone',
  checks_feature_phone: 'Checks: feature phone',
  seen_on_phone: 'Seen on a phone in the dates',
};
const SMARTPHONE_SHOWN: SmartphoneKey[] = ['tenants', 'recorded_smartphone', 'confirmed_smartphone', 'confirmed_feature_phone', 'device_unknown', 'joined', 'checks', 'seen_on_phone'];

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

function RangeBadge() {
  return <Badge variant="secondary" className="shrink-0 text-xs" data-testid="in-range-badge">In the chosen dates</Badge>;
}

function HowCounted() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs"><Info className="h-3.5 w-3.5" /> How these are counted</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-[min(92vw,26rem)] overflow-y-auto p-3" data-testid="how-counted">
        <p className="mb-2 text-sm font-bold text-foreground">How these are counted</p>
        <ul className="space-y-2">
          {HOW_COUNTED.map(([t, line]) => (
            <li key={t} className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">{t}.</span> {line}</li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
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
  title, caption, rows, columns, empty, testId, inRange, onCsv,
}: { title: string; caption: string; rows: T[]; columns: Column<T>[]; empty: string; testId: string; inRange?: boolean; onCsv: () => void }) {
  return (
    <Card className="space-y-2 p-3 sm:p-4" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-foreground">{title}</h3>
            {inRange && <RangeBadge />}
          </div>
          <p className="text-xs text-muted-foreground">{caption}</p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={onCsv} disabled={rows.length === 0} aria-label={`Download CSV: ${title}`}>
          <Download className="h-3.5 w-3.5" /> Download CSV
        </Button>
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

function downloadRanked(kind: RankedKind, d: AgentNetworkOverview) {
  const { filename, preamble, headers, rows } = buildRankedCsv(kind, d);
  downloadCsvWithPreamble(filename, preamble, headers, rows);
}

function Content({ d }: { d: AgentNetworkOverview }) {
  const c = d.counts;
  const minLine = `at least ${formatUGX(d.range.min_expected)}`;
  const phone = d.smartphone_usage;
  return (
    <div className="space-y-4">
      <section aria-label="Today's network (all time)" className="space-y-2">
        <h3 className="text-sm font-bold text-foreground">Today&apos;s network (all time)</h3>
        <p className="text-xs text-muted-foreground">These cards do not change with the chosen dates.</p>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4">
          <KpiCard title="Agents" value={n(c.agents)} hint="each person once" icon={Users} />
          <KpiCard title="With service centres" value={n(c.with_service_centres)} hint="linked agents · few centres are set up yet" icon={Building2} />
          <KpiCard title="With bikes" value={n(c.with_bikes)} hint={`${n(d.bikes.leases)} leases · ${formatUGX(d.bikes.amount_outstanding)} still owed`} icon={Bike} />
          <KpiCard title="With smartphone plan" value={n(c.with_smartphone_plan)} hint="agents with a smartphone plan" icon={Smartphone} />
          <KpiCard title="Tenants on smartphones" value={n(c.with_smartphone_tenants)} hint="agents with tenants on smartphones" icon={PhoneCall} />
          <KpiCard title="With sub-agents" value={n(c.with_subagents)} hint="agents with a verified sub-agent" icon={Network} />
          <KpiCard title="Posted rent requests" value={n(c.posted_requests)} hint="agents who posted a Rent Plan request" icon={FileText} />
          <KpiCard title="Approved agents" value={n(c.approved_agents)} hint="agents with an approved Rent Plan, ever" icon={BadgeCheck} />
        </div>
      </section>

      <Card className="space-y-3 p-3 sm:p-4" data-testid="network-approved">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-foreground">Approved</h3>
            <RangeBadge />
          </div>
          <p className="text-xs text-muted-foreground">Rent Plan requests approved in the range.</p>
        </div>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Agents</dt><dd className="text-lg font-bold tabular-nums text-foreground">{n(d.approved.agents)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Requests</dt><dd className="text-lg font-bold tabular-nums text-foreground">{n(d.approved.requests)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Amount approved</dt><dd className="text-lg font-bold tabular-nums text-foreground">{formatUGX(d.approved.amount)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Receivables outstanding</dt><dd className="text-lg font-bold tabular-nums text-foreground">{formatUGX(d.approved.receivables_outstanding)}</dd></div>
        </dl>
      </Card>

      <Card className="space-y-3 p-3 sm:p-4" data-testid="network-smartphones">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-foreground">Tenant smartphones (Tenant Ops figures)</h3>
            <Badge variant="outline" className="shrink-0 text-xs">Platform-wide</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            All tenants on the platform, not only these agents&apos; tenants. Counts of people; &quot;in the dates&quot; lines follow the chosen dates ({phone.from_day || '—'} to {phone.to_day || '—'}).
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {SMARTPHONE_SHOWN.map((k) => (
            <div key={k}><dt className="text-xs text-muted-foreground">{SMARTPHONE_LABEL[k]}</dt><dd className="text-lg font-bold tabular-nums text-foreground">{n(phone.totals[k])}</dd></div>
          ))}
        </dl>
      </Card>

      <RankedCard
        testId="network-portfolios"
        title="Biggest portfolios"
        caption="Largest live Rent Plan books today (outstanding balance)."
        rows={d.top_portfolios}
        empty="No agent has a live Rent Plan portfolio."
        onCsv={() => downloadRanked('portfolios', d)}
        columns={[
          { label: 'Rent Plans', align: 'right', render: (r) => n(r.plans) },
          { label: 'Portfolio', align: 'right', render: (r) => <span className="font-semibold">{formatUGX(r.portfolio)}</span> },
        ]}
      />
      <RankedCard
        testId="network-collection-rate"
        title="Best collection rate"
        inRange
        caption={`Collected against expected in the range. Only agents with expected of ${minLine}.`}
        rows={d.top_collection_rate}
        empty={`No agent has expected collections of ${minLine} in this range.`}
        onCsv={() => downloadRanked('collection', d)}
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
        onCsv={() => downloadRanked('default', d)}
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

/** The range is a pair of dates (the Overview page's picker, or the standalone one); it is sent as Kampala days. The minimum is local unless the caller owns it. */
export function AgentNetworkTab({ start, end, minExpected, onMinChange }: { start: Date; end: Date; minExpected?: number; onMinChange?: (min: number) => void }) {
  const [localMin, setLocalMin] = useState<number>(DEFAULT_MIN);
  const min = minExpected ?? localMin;
  const setMin = (v: number) => (onMinChange ? onMinChange(v) : setLocalMin(v));
  const { p_start, p_end } = useMemo(() => networkRangeParams(start, end), [start, end]);
  const { data, isLoading, isFetching, error, refetch } = useAgentOpsNetworkOverview(p_start, p_end, min);

  return (
    <div className="space-y-3" data-testid="agent-network-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Kampala days {kampalaLabel(data?.range.start || p_start)} → {kampalaLabel(data?.range.end || p_end)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Minimum
            <Select value={String(min)} onValueChange={(v) => setMin(Number(v))}>
              <SelectTrigger className="h-8 w-[8.5rem] text-xs" aria-label="Minimum size for the rankings"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MIN_OPTIONS.map((m) => <SelectItem key={m} value={String(m)} className="text-xs">{formatUGX(m)}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <HowCounted />
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={refetch} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        </div>
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

const asDate = (ymd: string) => new Date(`${ymd}T00:00:00`);

/**
 * The Agent Network on the Agent Ops home page: its own date presets (Kampala days, default Last 30 days, the end never in the future) and
 * minimum, kept in the URL (?net=1&netfrom=&netto=&netmin=) so a link opens on the same view. It does not depend on the Overview page.
 */
export function AgentNetworkStandalone() {
  const [sp, setSp] = useSearchParams();
  const today = kampalaTodayYmd();
  const params = useMemo(() => readNetworkParams(sp, today), [sp, today]);
  const preset = netPresetOf(params.from, params.to, today);
  const [customOpen, setCustomOpen] = useState(preset === 'custom');
  const showCustom = customOpen || preset === 'custom';

  const update = (patch: Partial<typeof params>) =>
    setSp((prev) => writeNetworkParams(prev, { ...readNetworkParams(prev, today), ...patch }), { replace: true });

  // keep the link in the address bar while this view is open, and take it out again when another chip is chosen
  const { from, to, min } = params;
  const setSpRef = useRef(setSp);
  setSpRef.current = setSp;
  useEffect(() => {
    setSpRef.current((prev) => writeNetworkParams(prev, { from, to, min }), { replace: true });
  }, [from, to, min]);
  useEffect(() => () => setSpRef.current((prev) => clearNetworkParams(prev), { replace: true }), []);

  return (
    <div className="space-y-3" data-testid="agent-network-standalone">
      <Card className="space-y-3 p-3">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-bold text-foreground">Agent Network</p>
            <p className="text-xs text-muted-foreground">Agents, their portfolios and collections. Pick the dates the range figures cover.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Dates">
          {NET_PRESETS.map((p) => (
            <Button
              key={p.id}
              type="button"
              size="sm"
              variant={!showCustom && preset === p.id ? 'default' : 'outline'}
              aria-pressed={!showCustom && preset === p.id}
              className="h-8 text-xs"
              onClick={() => { setCustomOpen(false); update(netPresetRange(p.id, today)); }}
            >
              {p.label}
            </Button>
          ))}
          <Button type="button" size="sm" variant={showCustom ? 'default' : 'outline'} aria-pressed={showCustom} className="h-8 text-xs" onClick={() => setCustomOpen(true)}>
            Custom
          </Button>
        </div>
        {showCustom && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              From
              <Input type="date" value={params.from} max={today} onChange={(e) => e.target.value && update({ from: e.target.value, to: e.target.value > params.to ? e.target.value : params.to })} className="h-8 w-auto text-xs" />
            </label>
            <label className="flex items-center gap-1.5">
              To
              <Input type="date" value={params.to} max={today} onChange={(e) => e.target.value && update({ to: e.target.value > today ? today : e.target.value, from: e.target.value < params.from ? e.target.value : params.from })} className="h-8 w-auto text-xs" />
            </label>
          </div>
        )}
      </Card>
      <AgentNetworkTab start={asDate(params.from)} end={asDate(params.to)} minExpected={params.min} onMinChange={(m) => update({ min: m })} />
    </div>
  );
}
