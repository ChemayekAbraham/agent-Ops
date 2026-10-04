import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, FileDown, Printer, RefreshCw, FileText, CalendarDays, Clock, Search } from 'lucide-react';
import { downloadCsv } from '@/lib/csvExport';
import { toast } from 'sonner';

const fmtUGX = (n: number | null | undefined) =>
  `UGX ${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;

type Granularity = 'daily' | 'weekly' | 'monthly';

/** UTC instant for the EAT (UTC+3) midnight starting the given calendar date. */
function eatMidnight(y: number, m: number, d: number) {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 3 * 3600 * 1000);
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** EAT period boundaries expressed as UTC instants, plus human labels. */
function periodRange(anchor: string, granularity: Granularity) {
  const [y, m, d] = anchor.split('-').map(Number);

  if (granularity === 'monthly') {
    const start = eatMidnight(y, m, 1);
    const end = eatMidnight(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1);
    const lastDay = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0)).getUTCDate();
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
      }),
      stem: `${y}-${pad(m)}`,
      firstDate: isoDate(y, m, 1),
      lastDate: isoDate(y, m, lastDay),
    };
  }

  if (granularity === 'weekly') {
    // Monday-to-Sunday week containing the anchor date.
    const anchorUtc = new Date(Date.UTC(y, m - 1, d));
    const offset = (anchorUtc.getUTCDay() + 6) % 7; // Mon = 0
    const first = new Date(anchorUtc.getTime() - offset * 24 * 3600 * 1000);
    const last = new Date(first.getTime() + 6 * 24 * 3600 * 1000);
    const start = eatMidnight(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate());
    const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
    const firstDate = isoDate(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate());
    const lastDate = isoDate(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate());
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: `${firstDate} → ${lastDate}`,
      stem: `${firstDate}_to_${lastDate}`,
      firstDate,
      lastDate,
    };
  }

  const start = eatMidnight(y, m, d);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: anchor,
    stem: anchor,
    firstDate: anchor,
    lastDate: anchor,
  };
}

interface Row {
  n: number; ledger_id: string; rent_request_id: string | null;
  tenant_id: string | null; tenant_name: string; tenant_phone: string;
  landlord_id: string | null; landlord_name: string; landlord_phone: string;
  agent_name: string; disbursed_by: string;
  amount: number; rent_amount: number; daily_repayment: number; duration_days: number;
  payout_method: string; recipient_type: string; recipient_name: string;
  reference: string; status: string;
  location: string | null; property: string | null;
  date_eat: string; time_eat: string; description: string | null;
}
interface Bucket { label: string; count: number; amount: number }
interface Report {
  period: { start: string; end: string; start_eat: string; end_eat: string };
  generated_at: string;
  summary: { disbursements_count: number; total_amount: number; tenants_count: number; landlords_count: number };
  rows: Row[];
  by_method: Bucket[];
  by_status: Bucket[];
}

export default function RentDisbursementReportPanel() {
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const [anchor, setAnchor] = useState<string>(today);
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [tenantSearch, setTenantSearch] = useState('');
  const range = useMemo(() => periodRange(anchor, granularity), [anchor, granularity]);
  const periodNoun =
    granularity === 'daily' ? 'day' : granularity === 'weekly' ? 'week' : 'month';

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['rent-disbursement-report', range.start, range.end],
    queryFn: async (): Promise<Report> => {
      const { data, error } = await supabase.rpc('get_rent_disbursement_report' as any, {
        p_start: range.start,
        p_end: range.end,
      });
      if (error) throw error;
      return data as unknown as Report;
    },
    staleTime: 30_000,
  });

  const fileStem = `Rent_Disbursement_Report_${granularity}_${range.stem}`;

  const exportCsv = () => {
    if (!data) return;
    downloadCsv(
      `${fileStem}.csv`,
      ['#', 'Tenant', 'Tenant ID', 'Tenant phone', 'Landlord', 'Landlord phone', 'Property', 'Location',
       'Recipient', 'Recipient type', 'Payout method', 'Reference', 'Status', 'Agent', 'Disbursed by',
       'Date (EAT)', 'Time (EAT)', 'Amount (UGX)'],
      data.rows.map((r) => [
        r.n, r.tenant_name, r.tenant_id ?? '—', r.tenant_phone, r.landlord_name, r.landlord_phone,
        r.property ?? '—', r.location ?? '—', r.recipient_name, r.recipient_type, r.payout_method,
        r.reference, r.status, r.agent_name, r.disbursed_by, r.date_eat, r.time_eat, r.amount,
      ]),
    );
  };

  const exportPdf = async () => {
    if (!data) return;
    try {
      const { downloadRentDisbursementPdf } = await import('@/lib/rentDisbursementPdf');
      await downloadRentDisbursementPdf({ filename: `${fileStem}.pdf`, dateLabel: range.label, report: data });
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not build the PDF');
    }
  };

  return (
    <div className="space-y-4 printable">
      <Card className="overflow-hidden rounded-2xl border shadow-sm">
        <CardHeader className="gap-0 border-b bg-card px-5 py-5 sm:px-7 sm:py-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <FileText className="h-6 w-6" />
              </div>
              <div>
                <CardTitle className="text-xl font-bold tracking-tight sm:text-2xl">
                  Rent Disbursement Report
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Read-only report of every rent disbursement recorded in the selected {periodNoun}.
                  Built from the existing rent disbursement transactions — no separate calculation.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5" /> Reporting in EAT
                  </span>
                  {data ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" /> Generated: {new Date(data.generated_at).toLocaleString()}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-5 pt-5 sm:px-7 sm:pt-6">
          <div className="no-print flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Report period
              </Label>
              <div className="flex h-11 items-center gap-1 rounded-xl border bg-muted/40 p-1">
                {(['daily', 'weekly', 'monthly'] as Granularity[]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGranularity(g)}
                    className={`h-9 rounded-lg px-4 text-xs font-semibold capitalize transition ${
                      granularity === g
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rent-report-anchor" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {granularity === 'daily' ? 'Report date' : granularity === 'weekly' ? 'Week containing' : 'Month'}
              </Label>
              <div className="relative">
                <Input
                  id="rent-report-anchor"
                  type={granularity === 'monthly' ? 'month' : 'date'}
                  value={granularity === 'monthly' ? anchor.slice(0, 7) : anchor}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) { setAnchor(today); return; }
                    setAnchor(granularity === 'monthly' ? `${v}-01` : v);
                  }}
                  className="h-11 w-full rounded-xl pr-10 text-sm font-medium sm:w-[200px] [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                />
                <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary" />
              </div>
              <p className="text-[11px] text-muted-foreground">Covers {range.firstDate} → {range.lastDate} (EAT)</p>
            </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 xl:border-l xl:pl-5">
              <Button className="h-11 rounded-xl px-5" onClick={() => refetch()} disabled={isFetching}>
                {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                <span className="ml-2 font-semibold">Refresh</span>
              </Button>
              <Button variant="outline" className="h-11 rounded-xl px-5" onClick={() => window.print()} disabled={!data}>
                <Printer className="h-4 w-4 mr-2" /><span className="font-semibold">Print</span>
              </Button>
              <Button variant="outline" className="h-11 rounded-xl px-5" onClick={exportPdf} disabled={!data}>
                <FileDown className="h-4 w-4 mr-2" /><span className="font-semibold">PDF</span>
              </Button>
              <Button variant="ghost" className="h-11 rounded-xl px-4" onClick={exportCsv} disabled={!data?.rows.length}>
                <FileDown className="h-4 w-4 mr-2" /><span className="font-semibold">CSV</span>
              </Button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
              <Loader2 className="h-4 w-4 animate-spin" /> Building the report…
            </div>
          ) : isError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {(error as any)?.message ?? 'Could not load the report'}
            </div>
          ) : data ? (
            <div className="space-y-6">
              <div className="rounded-lg border p-4">
                <h2 className="text-base font-semibold">Welile — Rent Disbursement Report</h2>
                <p className="text-sm text-muted-foreground">
                  Reporting {periodNoun}: {range.label} (EAT) · Window {data.period.start_eat} to {data.period.end_eat} ·
                  Generated {new Date(data.generated_at).toLocaleString()}
                </p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-4">
                  <Kpi label="Rent disbursements" value={String(data.summary.disbursements_count)} hint={`Successful entries for the ${periodNoun}`} />
                  <Kpi label="Total amount disbursed" value={fmtUGX(data.summary.total_amount)} hint="Sum of rent paid out" />
                  <Kpi label="Tenants covered" value={String(data.summary.tenants_count)} hint="Distinct tenants" />
                  <Kpi label="Landlords paid" value={String(data.summary.landlords_count)} hint="Distinct landlords" />
                </div>
              </div>

              <section className="space-y-2">
                <SectionTitle
                  index={1}
                  title={`Rent disbursements (${data.rows.length})`}
                  right={
                    <div className="relative w-full sm:w-64">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="text"
                        value={tenantSearch}
                        onChange={(e) => setTenantSearch(e.target.value)}
                        placeholder="Filter by tenant name…"
                        className="h-9 rounded-lg pl-8 text-sm"
                        aria-label="Filter by tenant name"
                      />
                    </div>
                  }
                />
                {data.rows.length === 0 ? (
                  <Empty text={`No rent disbursements were recorded in this ${periodNoun}.`} />
                ) : (
                  (() => {
                    const q = tenantSearch.trim().toLowerCase();
                    const visibleRows = q
                      ? data.rows.filter((r) => r.tenant_name.toLowerCase().includes(q))
                      : data.rows;
                    return (
                      <div className="overflow-x-auto rounded-md border">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/60">
                            <tr>
                              <Th>#</Th><Th>Tenant</Th><Th>Landlord</Th><Th>Property / location</Th>
                              <Th>Recipient</Th><Th>Method</Th><Th>Reference</Th><Th>Status</Th>
                              <Th>Time (EAT)</Th><Th align="right">Amount</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleRows.map((r) => (
                              <tr key={r.ledger_id} className="border-t">
                                <Td>{r.n}</Td>
                                <Td>
                                  <span className="font-medium">{r.tenant_name}</span>
                                  <span className="block font-mono text-[11px] text-muted-foreground">{r.tenant_phone}</span>
                                </Td>
                                <Td>
                                  {r.landlord_name}
                                  <span className="block font-mono text-[11px] text-muted-foreground">{r.landlord_phone}</span>
                                </Td>
                                <Td className="max-w-[220px] text-xs">
                                  {r.property ?? '—'}
                                  <span className="block text-muted-foreground">{r.location ?? '—'}</span>
                                </Td>
                                <Td className="text-xs">
                                  {r.recipient_name !== '—' ? r.recipient_name : r.recipient_type}
                                  <span className="block text-muted-foreground">{r.recipient_type}</span>
                                </Td>
                                <Td className="text-xs">{r.payout_method}</Td>
                                <Td className="font-mono text-[11px]">{r.reference}</Td>
                                <Td className="text-xs">{r.status}</Td>
                                <Td className="whitespace-nowrap text-xs">{r.date_eat} {r.time_eat}</Td>
                                <Td align="right" className="font-semibold">{fmtUGX(r.amount)}</Td>
                              </tr>
                            ))}
                            {visibleRows.length === 0 && (
                              <tr className="border-t">
                                <Td colSpan={10}>
                                  <span className="text-sm text-muted-foreground">
                                    No tenants match “{tenantSearch}”.
                                  </span>
                                </Td>
                              </tr>
                            )}
                          </tbody>
                          <tfoot>
                            <tr className="border-t bg-muted/40 font-semibold">
                              <Td colSpan={9}>
                                Total rent disbursed ({visibleRows.length} of {data.summary.disbursements_count} disbursements)
                              </Td>
                              <Td align="right">
                                {fmtUGX(visibleRows.reduce((sum, r) => sum + r.amount, 0))}
                              </Td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    );
                  })()
                )}
              </section>

              <section className="space-y-2">
                <SectionTitle index={2} title="Breakdown by payout method" />
                <BucketTable rows={data.by_method} head="Payout method" />
              </section>

              <section className="space-y-2">
                <SectionTitle index={3} title="Breakdown by rent request status" />
                <BucketTable rows={data.by_status} head="Status" />
              </section>

              <section className="space-y-2">
                <SectionTitle index={4} title="Scope" />
                <p className="text-sm text-muted-foreground">
                  Successful rent disbursement transactions recorded in the ledger between{' '}
                  {data.period.start_eat} and {data.period.end_eat} (EAT). Cancelled, failed or pending
                  rent requests never produce a rent disbursement transaction, so they are excluded by
                  the existing status logic. Amounts in UGX.
                </p>
              </section>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function BucketTable({ rows, head }: { rows: Bucket[]; head: string }) {
  if (!rows.length) return <Empty text="Nothing to break down for this date." />;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60">
          <tr><Th>{head}</Th><Th align="right">Disbursements</Th><Th align="right">Amount</Th></tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.label} className="border-t">
              <Td>{b.label}</Td>
              <Td align="right">{b.count}</Td>
              <Td align="right" className="font-semibold">{fmtUGX(b.amount)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-bold mt-1 break-words">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground mt-0.5">{hint}</p> : null}
    </div>
  );
}

function SectionTitle({ index, title, right }: { index: number; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{index}. {title}</h3>
      {right}
    </div>
  );
}

function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-3 py-2 text-${align} text-xs font-semibold text-muted-foreground whitespace-nowrap`}>{children}</th>;
}

function Td({ children, align = 'left', className = '', colSpan }: { children?: React.ReactNode; align?: 'left' | 'right'; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={`px-3 py-2 text-${align} ${className}`}>{children}</td>;
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{text}</div>;
}
