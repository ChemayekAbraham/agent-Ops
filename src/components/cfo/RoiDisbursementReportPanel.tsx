import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, FileDown, Printer, RefreshCw, AlertTriangle, CheckCircle2, FileText, CalendarDays, Clock, ShieldCheck, Search } from 'lucide-react';
import { downloadCsv } from '@/lib/csvExport';
import { toast } from 'sonner';

type Period = 'daily' | 'weekly' | 'monthly' | 'yearly';

const fmtUGX = (n: number | null | undefined) =>
  `UGX ${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;

/** EAT (UTC+3) day boundaries expressed as UTC instants. */
function periodRange(period: Period, anchor: string) {
  const [y, m, d] = anchor.split('-').map(Number);
  const startEatDay = (yy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0) - 3 * 3600 * 1000);
  let start: Date;
  let end: Date;
  if (period === 'daily') {
    start = startEatDay(y, m, d);
    end = new Date(start.getTime() + 24 * 3600 * 1000);
  } else if (period === 'weekly') {
    const base = startEatDay(y, m, d);
    // Week starts Monday in EAT
    const eatDow = new Date(base.getTime() + 3 * 3600 * 1000).getUTCDay();
    const back = (eatDow + 6) % 7;
    start = new Date(base.getTime() - back * 24 * 3600 * 1000);
    end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  } else if (period === 'monthly') {
    start = startEatDay(y, m, 1);
    end = startEatDay(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1);
  } else {
    start = startEatDay(y, 1, 1);
    end = startEatDay(y + 1, 1, 1);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

interface CashRow {
  n: number; portfolio_phone: string; partner: string; paid_to: string;
  principal: number; returns_paid: number; time_eat: string; date_eat: string; portfolio_code: string | null;
}
interface CompRow {
  n: number; portfolio_phone: string; partner: string; new_principal: number;
  returns_compounded: number; executed_by: string; time_eat: string; date_eat: string; portfolio_code: string | null;
}
interface ApprovalRow { stage: string; authorised_by: string; role: string; items: number; amount: number; window: string; }
interface RoutingRow { name: string; phone: string; credits: number; amount: number; }
interface ExceptionRow { portfolio_code: string | null; partner: string; amount: number; compounded_at: string; paid_at: string; }

interface Report {
  period: { start: string; end: string; start_eat: string; end_eat: string };
  generated_at: string;
  summary: {
    total_approved: number; cash_total: number; compounded_total: number;
    partners_affected: number; payouts_count: number; compounded_portfolios: number;
    portfolios_total: number; principal_total: number;
  };
  cash: CashRow[];
  compounded: CompRow[];
  approvals: ApprovalRow[];
  reconciliation: {
    wallet_credits: { legs: number; amount: number };
    reinvestments: { legs: number; amount: number };
    platform_expense: { legs: number; amount: number };
    balanced: boolean;
  };
  routing: RoutingRow[];
  proxy_credits: number;
  exceptions: ExceptionRow[];
}

const PERIOD_LABEL: Record<Period, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly',
};

export default function RoiDisbursementReportPanel() {
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const [period, setPeriod] = useState<Period>('daily');
  const [anchor, setAnchor] = useState<string>(today);
  const [nameSearch, setNameSearch] = useState('');
  const range = useMemo(() => periodRange(period, anchor), [period, anchor]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['roi-disbursement-report', range.start, range.end],
    queryFn: async (): Promise<Report> => {
      const { data, error } = await supabase.rpc('get_roi_disbursement_report' as any, {
        p_start: range.start,
        p_end: range.end,
      });
      if (error) throw error;
      return data as unknown as Report;
    },
    staleTime: 60_000,
  });

  const periodTitle = `${PERIOD_LABEL[period]} Returns Disbursement Report`;
  const fileStem = `ROI_Disbursement_Report_${period}_${anchor}`;

  const nameQuery = nameSearch.trim().toLowerCase();
  const matchesName = (r: { partner?: string | null; paid_to?: string | null; portfolio_phone?: string | null }) =>
    !nameQuery ||
    (r.partner ?? '').toLowerCase().includes(nameQuery) ||
    (r.paid_to ?? '').toLowerCase().includes(nameQuery) ||
    (r.portfolio_phone ?? '').toLowerCase().includes(nameQuery);

  const cashRows = useMemo(() => (data?.cash ?? []).filter(matchesName), [data, nameQuery]);
  const compoundedRows = useMemo(() => (data?.compounded ?? []).filter(matchesName), [data, nameQuery]);
  const cashFilteredTotal = cashRows.reduce((s, r) => s + Number(r.returns_paid ?? 0), 0);
  const compoundedFilteredTotal = compoundedRows.reduce((s, r) => s + Number(r.returns_compounded ?? 0), 0);

  const exportCash = () => {
    if (!data) return;
    downloadCsv(
      `${fileStem}_cash.csv`,
      ['#', 'Portfolio phone', 'Partner', 'Paid to (wallet)', 'Principal (UGX)', 'Returns paid (UGX)', 'Date (EAT)', 'Time (EAT)', 'Portfolio'],
      data.cash.map((r) => [r.n, r.portfolio_phone, r.partner, r.paid_to, r.principal, r.returns_paid, r.date_eat, r.time_eat, r.portfolio_code ?? '—']),
    );
  };

  const exportCompounded = () => {
    if (!data) return;
    downloadCsv(
      `${fileStem}_compounded.csv`,
      ['#', 'Portfolio phone', 'Partner', 'New principal (UGX)', 'Returns compounded (UGX)', 'Executed by', 'Date (EAT)', 'Time (EAT)', 'Portfolio'],
      data.compounded.map((r) => [r.n, r.portfolio_phone, r.partner, r.new_principal, r.returns_compounded, r.executed_by, r.date_eat, r.time_eat, r.portfolio_code ?? '—']),
    );
  };

  const exportPdf = async () => {
    if (!data) return;
    try {
      const { downloadRoiDisbursementPdf } = await import('@/lib/roiDisbursementPdf');
      await downloadRoiDisbursementPdf({
        filename: `${fileStem}.pdf`,
        periodLabel: PERIOD_LABEL[period],
        report: data,
      });
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
                  Returns (ROI) Disbursement Report
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Read-only report generated from the ledger and approval history.
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
            {data ? (
              <div
                className={`inline-flex h-10 shrink-0 items-center gap-2 self-start rounded-full border px-4 text-sm font-medium ${
                  data.reconciliation.balanced
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : 'border-destructive/30 bg-destructive/10 text-destructive'
                }`}
              >
                {data.reconciliation.balanced ? <ShieldCheck className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                Ledger Check: {data.reconciliation.balanced ? 'Balanced' : 'Review needed'}
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-5 pt-5 sm:px-7 sm:pt-6">
          <div className="no-print flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
              <div className="space-y-2">
                <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Report period
                </Label>
                <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
                  <TabsList className="h-11 rounded-xl border bg-muted/40 p-1">
                    {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
                      <TabsTrigger
                        key={p}
                        value={p}
                        className="rounded-lg px-4 text-sm font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
                      >
                        {PERIOD_LABEL[p]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
              <div className="space-y-2">
                <Label htmlFor="roi-report-anchor" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {period === 'daily' ? 'Report date' : period === 'weekly' ? 'Any date in the week' : period === 'monthly' ? 'Any date in the month' : 'Any date in the year'}
                </Label>
                <div className="relative">
                  <Input
                    id="roi-report-anchor"
                    type="date"
                    value={anchor}
                    onChange={(e) => setAnchor(e.target.value || today)}
                    className="h-11 w-full rounded-xl pr-10 text-sm font-medium sm:w-[200px] [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                  />
                  <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary" />
                </div>
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
              {/* Report header block */}
              <div className="rounded-lg border p-4">
                <h2 className="text-base font-semibold">Welile — {periodTitle}</h2>
                <p className="text-sm text-muted-foreground">
                  Window: {data.period.start_eat} to {data.period.end_eat} (EAT) · Generated {new Date(data.generated_at).toLocaleString()}
                </p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-4">
                  <Kpi label="Total Returns approved" value={fmtUGX(data.summary.total_approved)} hint={`${data.summary.portfolios_total} portfolio entries`} />
                  <Kpi label="Cash disbursed to wallets" value={fmtUGX(data.summary.cash_total)} hint={`${data.summary.payouts_count} payouts`} />
                  <Kpi label="Compounded to principal" value={fmtUGX(data.summary.compounded_total)} hint={`${data.summary.compounded_portfolios} portfolios`} />
                  <Kpi label="Partners affected" value={String(data.summary.partners_affected)} hint={`Principal base ${fmtUGX(data.summary.principal_total)}`} />
                </div>

              </div>

              {/* Section 1 */}
              <section className="space-y-2">
                <SectionTitle
                  index={1}
                  title="Cash Returns disbursed to wallets"
                  right={
                    <div className="flex items-center gap-2">
                      <div className="relative w-full sm:w-64">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          type="text"
                          value={nameSearch}
                          onChange={(e) => setNameSearch(e.target.value)}
                          placeholder="Filter by partner name…"
                          className="h-9 rounded-lg pl-8 text-sm"
                          aria-label="Filter by partner name"
                        />
                      </div>
                      <Button variant="ghost" size="sm" className="no-print" onClick={exportCash} disabled={!data.cash.length}><FileDown className="h-4 w-4 mr-1" />CSV</Button>
                    </div>
                  }
                />
                {data.cash.length === 0 ? (
                  <Empty text="No cash Returns were disbursed in this window." />
                ) : cashRows.length === 0 ? (
                  <Empty text="No records match this name." />
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/60">
                        <tr>
                          <Th>#</Th><Th>Portfolio phone</Th><Th>Partner</Th><Th>Paid to (wallet)</Th>
                          <Th align="right">Principal</Th><Th align="right">Returns paid</Th><Th>Time (EAT)</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {cashRows.map((r) => (
                          <tr key={`${r.n}-${r.portfolio_code}`} className="border-t">
                            <Td>{r.n}</Td>
                            <Td className="font-mono text-xs">{r.portfolio_phone}</Td>
                            <Td>{r.partner}</Td>
                            <Td>{r.paid_to}</Td>
                            <Td align="right">{fmtUGX(r.principal)}</Td>
                            <Td align="right" className="font-semibold">{fmtUGX(r.returns_paid)}</Td>
                            <Td className="whitespace-nowrap">{r.date_eat} {r.time_eat}</Td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t bg-muted/40 font-semibold">
                          <Td colSpan={5}>{nameQuery ? 'Total cash disbursed (filtered)' : 'Total cash disbursed'}</Td>
                          <Td align="right">{fmtUGX(nameQuery ? cashFilteredTotal : data.summary.cash_total)}</Td>
                          <Td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </section>

              {/* Section 2 */}
              <section className="space-y-2">
                <SectionTitle
                  index={2}
                  title="Returns compounded into principal"
                  right={<Button variant="ghost" size="sm" className="no-print" onClick={exportCompounded} disabled={!data.compounded.length}><FileDown className="h-4 w-4 mr-1" />CSV</Button>}
                />
                {data.compounded.length === 0 ? (
                  <Empty text="No Returns were compounded in this window." />
                ) : compoundedRows.length === 0 ? (
                  <Empty text="No records match this name." />
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/60">
                        <tr>
                          <Th>#</Th><Th>Portfolio phone</Th><Th>Partner</Th>
                          <Th align="right">New principal</Th><Th align="right">Returns compounded</Th><Th>Executed by</Th><Th>Time (EAT)</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {compoundedRows.map((r) => (
                          <tr key={`${r.n}-${r.portfolio_code}`} className="border-t">
                            <Td>{r.n}</Td>
                            <Td className="font-mono text-xs">{r.portfolio_phone}</Td>
                            <Td>{r.partner}</Td>
                            <Td align="right">{fmtUGX(r.new_principal)}</Td>
                            <Td align="right" className="font-semibold">{fmtUGX(r.returns_compounded)}</Td>
                            <Td>{r.executed_by}</Td>
                            <Td className="whitespace-nowrap">{r.date_eat} {r.time_eat}</Td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t bg-muted/40 font-semibold">
                          <Td colSpan={4}>{nameQuery ? 'Total compounded (filtered)' : 'Total compounded'}</Td>
                          <Td align="right">{fmtUGX(nameQuery ? compoundedFilteredTotal : data.summary.compounded_total)}</Td>
                          <Td colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </section>

              {/* Section 3 */}
              <section className="space-y-2">
                <SectionTitle index={3} title="Approval chain — who authorised the disbursement" />
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/60">
                      <tr><Th>Stage</Th><Th>Authorised by</Th><Th>Role</Th><Th align="right">Items</Th><Th align="right">Amount</Th><Th>Window (EAT)</Th></tr>
                    </thead>
                    <tbody>
                      {data.approvals.map((a) => (
                        <tr key={a.stage} className="border-t">
                          <Td>{a.stage}</Td>
                          <Td className="font-medium">{a.authorised_by}</Td>
                          <Td><Badge variant="secondary">{a.role}</Badge></Td>
                          <Td align="right">{a.items}</Td>
                          <Td align="right">{fmtUGX(a.amount)}</Td>
                          <Td className="whitespace-nowrap">{a.window}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Section 4 */}
              <section className="space-y-2">
                <SectionTitle index={4} title="Ledger reconciliation" />
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/60">
                      <tr><Th>Ledger leg</Th><Th align="right">Entries</Th><Th align="right">Amount</Th></tr>
                    </thead>
                    <tbody>
                      <tr className="border-t"><Td>Wallet credits (cash Returns)</Td><Td align="right">{data.reconciliation.wallet_credits.legs}</Td><Td align="right">{fmtUGX(data.reconciliation.wallet_credits.amount)}</Td></tr>
                      <tr className="border-t"><Td>Reinvestments (compounded)</Td><Td align="right">{data.reconciliation.reinvestments.legs}</Td><Td align="right">{fmtUGX(data.reconciliation.reinvestments.amount)}</Td></tr>
                      <tr className="border-t bg-muted/40 font-semibold"><Td>Platform Returns expense</Td><Td align="right">{data.reconciliation.platform_expense.legs}</Td><Td align="right">{fmtUGX(data.reconciliation.platform_expense.amount)}</Td></tr>
                    </tbody>
                  </table>
                </div>
                <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${data.reconciliation.balanced ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
                  {data.reconciliation.balanced
                    ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600" />
                    : <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600" />}
                  <span>
                    Wallet credits + reinvestments = {fmtUGX(data.reconciliation.wallet_credits.amount + data.reconciliation.reinvestments.amount)} against platform Returns expense {fmtUGX(data.reconciliation.platform_expense.amount)}.
                    {data.reconciliation.balanced ? ' Balanced.' : ' Variance present — review the ledger for this window.'}
                  </span>
                </div>
              </section>

              {/* Section 5 */}
              <section className="space-y-2">
                <SectionTitle index={5} title="Payout routing note (managed proxy wallets)" />
                {data.routing.length === 0 ? (
                  <Empty text="Every cash payout landed in the partner's own wallet." />
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/60">
                        <tr><Th>Receiving wallet</Th><Th>Phone</Th><Th align="right">Credits</Th><Th align="right">Amount</Th></tr>
                      </thead>
                      <tbody>
                        {data.routing.map((r) => (
                          <tr key={`${r.name}-${r.phone}`} className="border-t">
                            <Td>{r.name}</Td>
                            <Td className="font-mono text-xs">{r.phone}</Td>
                            <Td align="right">{r.credits}</Td>
                            <Td align="right">{fmtUGX(r.amount)}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Section 6 */}
              <section className="space-y-2">
                <SectionTitle index={6} title="Exceptions to review" />
                {data.exceptions.length === 0 ? (
                  <Empty text="No exceptions detected for this window." />
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/60">
                        <tr><Th>Portfolio</Th><Th>Partner</Th><Th align="right">Amount</Th><Th>Compounded at</Th><Th>Paid at</Th></tr>
                      </thead>
                      <tbody>
                        {data.exceptions.map((e, i) => (
                          <tr key={`${e.portfolio_code}-${i}`} className="border-t">
                            <Td className="font-mono text-xs">{e.portfolio_code ?? '—'}</Td>
                            <Td>{e.partner}</Td>
                            <Td align="right">{fmtUGX(e.amount)}</Td>
                            <Td className="whitespace-nowrap">{e.compounded_at}</Td>
                            <Td className="whitespace-nowrap">{e.paid_at}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </CardContent>
      </Card>
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
