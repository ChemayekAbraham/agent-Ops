import { useState } from 'react';
import {
  Home,
  Banknote,
  Users,
  Wallet,
  AlertTriangle,
  Loader2,
  RefreshCw,
  ChevronRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useLandlordFloatOverview,
  useLandlordFloatDrilldown,
  type LandlordFloatDrilldownKind,
} from '@/hooks/useLandlordFloatOverview';

const KAMPALA = 'Africa/Kampala';

function fmtDateTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    timeZone: KAMPALA,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Home;
  tone?: 'default' | 'amber' | 'emerald' | 'sky';
  onClick?: () => void;
}) {
  const toneRing =
    tone === 'amber'
      ? 'border-amber-500/30 bg-amber-500/5'
      : tone === 'emerald'
        ? 'border-emerald-500/30 bg-emerald-500/5'
        : tone === 'sky'
          ? 'border-sky-500/30 bg-sky-500/5'
          : 'border-border/60 bg-card';
  const inner = (
    <>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="truncate">{label}</span>
        {onClick && <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />}
      </div>
      <p className="mt-2 text-xl font-bold tabular-nums leading-tight">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`rounded-xl border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${toneRing}`}
      >
        {inner}
      </button>
    );
  }

  return <div className={`rounded-xl border p-4 ${toneRing}`}>{inner}</div>;
}

function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap';
const TD = 'px-3 py-2 align-middle whitespace-nowrap';

/** One column of a drill-down table. */
interface DrillColumn {
  key: string;
  label: string;
  type?: 'text' | 'ugx' | 'date' | 'badge';
  align?: 'left' | 'right';
}

interface DrillTarget {
  title: string;
  description?: string;
  columns: DrillColumn[];
  /** Rows already loaded by the overview RPC. */
  rows?: Record<string, any>[];
  /** Or fetch the underlying rows from the drill-down RPC. */
  kind?: LandlordFloatDrilldownKind;
  filterKey?: string | null;
}

function DrillCell({ column, row }: { column: DrillColumn; row: Record<string, any> }) {
  const raw = row[column.key];
  if (column.type === 'ugx') {
    return (
      <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(Number(raw) || 0)}</td>
    );
  }
  if (column.type === 'date') {
    return <td className={TD}>{fmtDateTime(raw)}</td>;
  }
  if (column.type === 'badge') {
    return (
      <td className={TD}>
        {raw ? (
          <Badge variant="outline" className="text-[10px]">
            {String(raw).replace(/_/g, ' ')}
          </Badge>
        ) : (
          '—'
        )}
      </td>
    );
  }
  return (
    <td className={`${TD} ${column.align === 'right' ? 'text-right tabular-nums' : ''}`}>
      {raw === null || raw === undefined || raw === '' ? '—' : String(raw)}
    </td>
  );
}

function DrillDownDialog({
  target,
  onClose,
}: {
  target: DrillTarget | null;
  onClose: () => void;
}) {
  const { data: fetched, isLoading, isError, error } = useLandlordFloatDrilldown(
    target?.rows ? null : (target?.kind ?? null),
    target?.filterKey ?? null,
  );
  const rows = target?.rows ?? fetched ?? [];
  const total = rows.reduce((sum, r) => {
    const col = target?.columns.find((c) => c.type === 'ugx');
    return sum + (col ? Number(r[col.key]) || 0 : 0);
  }, 0);

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="text-base">{target?.title}</DialogTitle>
          {target?.description && (
            <DialogDescription>{target.description}</DialogDescription>
          )}
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="py-6 text-sm text-destructive">
            {(error as Error)?.message || 'These records could not be loaded.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                {rows.length.toLocaleString()} record{rows.length === 1 ? '' : 's'}
              </span>
              {total > 0 && <span className="font-semibold tabular-nums">{formatUGX(total)}</span>}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              <TableShell>
                <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                  <tr>
                    {target?.columns.map((c) => (
                      <th
                        key={c.key}
                        className={`${TH} ${c.type === 'ugx' || c.align === 'right' ? 'text-right' : ''}`}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td className={`${TD} text-muted-foreground`} colSpan={target?.columns.length || 1}>
                        Nothing recorded here.
                      </td>
                    </tr>
                  )}
                  {rows.map((r, i) => (
                    <tr key={String(r.id ?? r.rent_request_id ?? r.agent_id ?? i)} className="border-t border-border/50">
                      {target?.columns.map((c) => (
                        <DrillCell key={c.key} column={c} row={r} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </div>
            <p className="text-xs text-muted-foreground">
              Read-only records, shown exactly as recorded. Up to 500 rows.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const EMPTY_HOUSE_COLUMNS: DrillColumn[] = [
  { key: 'title', label: 'House' },
  { key: 'district', label: 'District' },
  { key: 'sub_county', label: 'Sub-county' },
  { key: 'village', label: 'Village' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'agent_name', label: 'Listing agent' },
  { key: 'amount', label: 'Monthly rent', type: 'ugx' },
  { key: 'created_at', label: 'Listed', type: 'date' },
];

const WAITING_COLUMNS: DrillColumn[] = [
  { key: 'tenant_name', label: 'Tenant' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'district', label: 'District' },
  { key: 'status', label: 'Stage', type: 'badge' },
  { key: 'amount', label: 'Rent needed', type: 'ugx' },
  { key: 'created_at', label: 'Requested', type: 'date' },
];

const PAYOUT_COLUMNS: DrillColumn[] = [
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'tenant_name', label: 'Tenant' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'provider', label: 'Channel' },
  { key: 'reference', label: 'Reference' },
  { key: 'amount', label: 'Amount', type: 'ugx' },
  { key: 'disbursed_at', label: 'Paid', type: 'date' },
];

const COLLECTING_COLUMNS: DrillColumn[] = [
  { key: 'tenant_name', label: 'Tenant' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'status', label: 'Status', type: 'badge' },
  { key: 'contracted', label: 'Expected total', type: 'ugx' },
  { key: 'collected', label: 'Collected', type: 'ugx' },
  { key: 'outstanding', label: 'Outstanding', type: 'ugx' },
  { key: 'funded_at', label: 'Funded', type: 'date' },
];

const AGENT_COLUMNS: DrillColumn[] = [
  { key: 'agent_name', label: 'Agent' },
  { key: 'agent_phone', label: 'Phone' },
  { key: 'region', label: 'Region' },
  { key: 'balance', label: 'Float held', type: 'ugx' },
  { key: 'total_funded', label: 'Funded', type: 'ugx' },
  { key: 'total_paid_out', label: 'Paid out', type: 'ugx' },
  { key: 'updated_at', label: 'Last movement', type: 'date' },
];

const PORTFOLIO_COLUMNS: DrillColumn[] = [
  { key: 'portfolio_code', label: 'Portfolio' },
  { key: 'partner_name', label: 'Funder' },
  { key: 'partner_phone', label: 'Phone' },
  { key: 'status', label: 'Status', type: 'badge' },
  { key: 'duration_months', label: 'Months', align: 'right' },
  { key: 'amount', label: 'Capital', type: 'ugx' },
  { key: 'created_at', label: 'Created', type: 'date' },
];

const ATTACHED_COLUMNS: DrillColumn[] = [
  { key: 'partner_name', label: 'Funder' },
  { key: 'house_title', label: 'House' },
  { key: 'district', label: 'District' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'status', label: 'Status', type: 'badge' },
  { key: 'amount', label: 'Principal', type: 'ugx' },
  { key: 'supported_at', label: 'Attached', type: 'date' },
];

export default function LandlordFloat() {
  const { data, isLoading, isError, error, refetch, isFetching } = useLandlordFloatOverview();
  const [tab, setTab] = useState('needed');
  const [drill, setDrill] = useState<DrillTarget | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="flex items-start gap-3 p-5">
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-semibold">Landlord float could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground break-words">
              {(error as Error)?.message || 'Please try again.'}
            </p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { needed, collecting, with_agents, no_tenant } = data;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">Landlord Float</h1>
          <p className="text-sm text-muted-foreground">
            Where landlord rent money is needed, where it is being collected, and where it is
            sitting right now. As at {fmtDateTime(data.as_at)} (EAT).
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* Headline tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Float needed"
          value={formatUGX(needed.total_amount)}
          sub={`${needed.total_houses.toLocaleString()} houses`}
          icon={Home}
          tone="amber"
        />
        <StatTile
          label="Being collected"
          value={formatUGX(collecting.expected.expected)}
          sub={`${formatUGX(collecting.paid_out.amount)} paid to landlords`}
          icon={Banknote}
          tone="emerald"
        />
        <StatTile
          label="With agents"
          value={formatUGX(with_agents.summary.amount)}
          sub={`${with_agents.summary.agents.toLocaleString()} agents holding float`}
          icon={Users}
          tone="sky"
        />
        <StatTile
          label="No tenant attached"
          value={formatUGX(no_tenant.unattached)}
          sub={`${no_tenant.portfolios.toLocaleString()} funder portfolios`}
          icon={Wallet}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex w-full flex-wrap justify-start gap-1 h-auto">
          <TabsTrigger value="needed">1 · Float needed</TabsTrigger>
          <TabsTrigger value="collecting">2 · Being collected</TabsTrigger>
          <TabsTrigger value="agents">3 · With agents</TabsTrigger>
          <TabsTrigger value="no-tenant">4 · No tenant attached</TabsTrigger>
        </TabsList>

        {/* 1 — Float needed */}
        <TabsContent value="needed" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Landlord float needed</CardTitle>
              <p className="text-sm text-muted-foreground">
                Listed houses that are still empty, plus houses that already have a tenant whose
                rent request is still waiting for funding.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  label="Empty listed houses"
                  value={formatUGX(needed.empty_houses.amount)}
                  sub={`${needed.empty_houses.houses.toLocaleString()} houses`}
                  icon={Home}
                />
                <StatTile
                  label="Tenant in, awaiting funding"
                  value={formatUGX(needed.waiting_funding.amount)}
                  sub={`${needed.waiting_funding.houses.toLocaleString()} requests`}
                  icon={Home}
                  tone="amber"
                />
                <StatTile
                  label="Total float needed"
                  value={formatUGX(needed.total_amount)}
                  sub={`${needed.total_houses.toLocaleString()} houses in total`}
                  icon={Banknote}
                  tone="emerald"
                />
              </div>

              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Empty houses by district
                </p>
                <TableShell>
                  <thead className="bg-muted/40">
                    <tr>
                      <th className={TH}>District</th>
                      <th className={`${TH} text-right`}>Houses</th>
                      <th className={`${TH} text-right`}>Monthly rent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {needed.by_district.length === 0 && (
                      <tr>
                        <td className={`${TD} text-muted-foreground`} colSpan={3}>
                          No empty listed houses.
                        </td>
                      </tr>
                    )}
                    {needed.by_district.map((r) => (
                      <tr key={r.district} className="border-t border-border/50">
                        <td className={TD}>{r.district}</td>
                        <td className={`${TD} text-right tabular-nums`}>{r.houses.toLocaleString()}</td>
                        <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>

              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Tenants in a house, waiting for funding
                </p>
                <TableShell>
                  <thead className="bg-muted/40">
                    <tr>
                      <th className={TH}>Tenant</th>
                      <th className={TH}>Landlord</th>
                      <th className={TH}>Landlord phone</th>
                      <th className={TH}>District</th>
                      <th className={TH}>Stage</th>
                      <th className={`${TH} text-right`}>Rent needed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {needed.waiting_rows.length === 0 && (
                      <tr>
                        <td className={`${TD} text-muted-foreground`} colSpan={6}>
                          Nothing is waiting for funding.
                        </td>
                      </tr>
                    )}
                    {needed.waiting_rows.map((r) => (
                      <tr key={r.rent_request_id} className="border-t border-border/50">
                        <td className={TD}>{r.tenant_name}</td>
                        <td className={TD}>{r.landlord_name}</td>
                        <td className={TD}>{r.landlord_phone || '—'}</td>
                        <td className={TD}>{r.district}</td>
                        <td className={TD}>
                          <Badge variant="outline" className="text-[10px]">
                            {r.status.replace(/_/g, ' ')}
                          </Badge>
                        </td>
                        <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 2 — Being collected */}
        <TabsContent value="collecting" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Landlord float being collected</CardTitle>
              <p className="text-sm text-muted-foreground">
                Rent already paid out to landlords, and what is still expected back from the tenants
                living in those houses.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <StatTile
                  label="Paid out to landlords"
                  value={formatUGX(collecting.paid_out.amount)}
                  sub={`${collecting.paid_out.payouts.toLocaleString()} completed payouts`}
                  icon={Banknote}
                />
                <StatTile
                  label="Contracted from tenants"
                  value={formatUGX(collecting.expected.contracted)}
                  sub={`${collecting.expected.plans.toLocaleString()} live rent plans`}
                  icon={Home}
                />
                <StatTile
                  label="Collected so far"
                  value={formatUGX(collecting.expected.collected)}
                  icon={Wallet}
                  tone="emerald"
                />
                <StatTile
                  label="Still to collect"
                  value={formatUGX(collecting.expected.expected)}
                  icon={AlertTriangle}
                  tone="amber"
                />
              </div>

              <TableShell>
                <thead className="bg-muted/40">
                  <tr>
                    <th className={TH}>Tenant</th>
                    <th className={TH}>Landlord</th>
                    <th className={TH}>Landlord phone</th>
                    <th className={`${TH} text-right`}>Rent paid</th>
                    <th className={`${TH} text-right`}>Expected total</th>
                    <th className={`${TH} text-right`}>Collected</th>
                    <th className={`${TH} text-right`}>Outstanding</th>
                    <th className={`${TH} text-right`}>Daily</th>
                    <th className={TH}>Funded</th>
                  </tr>
                </thead>
                <tbody>
                  {collecting.rows.length === 0 && (
                    <tr>
                      <td className={`${TD} text-muted-foreground`} colSpan={9}>
                        No live rent plans.
                      </td>
                    </tr>
                  )}
                  {collecting.rows.map((r) => (
                    <tr key={r.rent_request_id} className="border-t border-border/50">
                      <td className={TD}>{r.tenant_name}</td>
                      <td className={TD}>{r.landlord_name}</td>
                      <td className={TD}>{r.landlord_phone || '—'}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.rent_amount)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.contracted)}</td>
                      <td className={`${TD} text-right tabular-nums text-emerald-600 dark:text-emerald-400`}>
                        {formatUGX(r.collected)}
                      </td>
                      <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(r.outstanding)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.daily_repayment)}</td>
                      <td className={TD}>{fmtDateTime(r.funded_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 3 — With agents */}
        <TabsContent value="agents" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Landlord float with agents</CardTitle>
              <p className="text-sm text-muted-foreground">
                Landlord payout float still in agents' hands — the same balance each agent sees under
                Landlord Float on their dashboard.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <StatTile
                  label="Held by agents"
                  value={formatUGX(with_agents.summary.amount)}
                  sub={`${with_agents.summary.agents.toLocaleString()} agents`}
                  icon={Users}
                  tone="sky"
                />
                <StatTile
                  label="Total ever funded"
                  value={formatUGX(with_agents.summary.total_funded)}
                  icon={Banknote}
                />
                <StatTile
                  label="Total paid to landlords"
                  value={formatUGX(with_agents.summary.total_paid_out)}
                  icon={Home}
                  tone="emerald"
                />
                <StatTile
                  label="Agents holding float"
                  value={with_agents.summary.agents.toLocaleString()}
                  icon={Users}
                />
              </div>

              <TableShell>
                <thead className="bg-muted/40">
                  <tr>
                    <th className={TH}>Agent</th>
                    <th className={TH}>Phone</th>
                    <th className={TH}>Region</th>
                    <th className={`${TH} text-right`}>Float held</th>
                    <th className={`${TH} text-right`}>Funded</th>
                    <th className={`${TH} text-right`}>Paid out</th>
                    <th className={TH}>Last movement</th>
                  </tr>
                </thead>
                <tbody>
                  {with_agents.rows.length === 0 && (
                    <tr>
                      <td className={`${TD} text-muted-foreground`} colSpan={7}>
                        No agent is holding landlord float.
                      </td>
                    </tr>
                  )}
                  {with_agents.rows.map((r) => (
                    <tr key={r.agent_id} className="border-t border-border/50">
                      <td className={TD}>{r.agent_name}</td>
                      <td className={TD}>{r.agent_phone || '—'}</td>
                      <td className={TD}>{r.region || '—'}</td>
                      <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(r.balance)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.total_funded)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.total_paid_out)}</td>
                      <td className={TD}>{fmtDateTime(r.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 4 — No tenant attached */}
        <TabsContent value="no-tenant" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Landlord float with no tenant attached</CardTitle>
              <p className="text-sm text-muted-foreground">
                Funder portfolio capital held by the company, and how much of it is not yet attached
                to a house or tenant. Sourced from Partnership Ops records.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  label="Total funder portfolios"
                  value={formatUGX(no_tenant.total)}
                  sub={`${no_tenant.portfolios.toLocaleString()} live portfolios`}
                  icon={Wallet}
                />
                <StatTile
                  label="Attached to a house"
                  value={formatUGX(no_tenant.attached_amount)}
                  sub={`${no_tenant.attached_houses.toLocaleString()} supported houses`}
                  icon={Home}
                  tone="emerald"
                />
                <StatTile
                  label="Not attached to a tenant"
                  value={formatUGX(no_tenant.unattached)}
                  icon={AlertTriangle}
                  tone="amber"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Figures are shown exactly as recorded — nothing is estimated or adjusted here.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
