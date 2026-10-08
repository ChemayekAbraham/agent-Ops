import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, FileDown, Printer, RefreshCw, MessageSquare, CalendarDays, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { useSmsCostReport, type SmsCostSourceRow } from '@/hooks/useSmsCostReport';
import {
  SMS_PROVIDERS, countPayments, kampalaDay, paymentsBetween, sumPayments, useProviderPayments,
} from '@/hooks/useProviderPayments';

const fmt = (n: number | null | undefined) => Math.round(Number(n ?? 0)).toLocaleString('en-US');
const ugx = (n: number | null | undefined) => `UGX ${fmt(n)}`;
const ugx1 = (n: number) => `UGX ${n.toFixed(1)}`;

const WINDOWS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOWS)[number];

const isOtpSource = (s: string) => /otp|password[-_]reset/i.test(s);

/** Source names arrive as function/stream slugs; show them as plain words. */
function streamLabel(source: string) {
  const known: Record<string, string> = {
    'issue-landlord-payout-otp': 'Landlord payout codes',
    wallet_withdrawal_otp: 'Withdrawal approval codes',
    phone_change_old_number_otp: 'Phone change codes (old number)',
  };
  if (known[source]) return known[source];
  const words = source.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : source;
}

function addDays(day: string, delta: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * CFO > Reports & Audit > SMS & OTP Costs. What SMS and one-time codes cost,
 * priced by message length from get_sms_cost_report (an estimate from the rate
 * card, not the provider invoice), set against what finance actually paid the
 * providers (approved requisitions naming Yoola or Africa's Talking). Read-only.
 */
export default function SmsOtpCostsPanel() {
  const [days, setDays] = useState<WindowDays>(30);
  const [busy, setBusy] = useState(false);
  const end = kampalaDay(new Date().toISOString());
  const start = addDays(end, -(days - 1));

  const cost = useSmsCostReport({ startDate: start, endDate: end });
  const paid = useProviderPayments();
  const report = cost.data;
  const payments = useMemo(() => paymentsBetween(paid.data ?? [], start, end), [paid.data, start, end]);

  const otp = useMemo(() => {
    const rows = (report?.by_source ?? []).filter((r) => isOtpSource(r.source));
    return {
      rows,
      messages: rows.reduce((s, r) => s + r.messages, 0),
      segments: rows.reduce((s, r) => s + r.segments, 0),
      cost: rows.reduce((s, r) => s + r.cost_ugx, 0),
    };
  }, [report]);

  const usageFor = (name: string) =>
    (report?.by_provider ?? [])
      .filter((r) => {
        const p = (r.provider ?? '').toLowerCase();
        return name === 'Yoola' ? p.includes('yoola') : p.includes('africa');
      })
      .reduce((s, r) => s + Number(r.cost_ugx || 0), 0);

  const totals = report?.totals;
  const failedCost = totals ? totals.cost_ugx - totals.cost_ugx_sent_only : 0;
  const per = (c: number, m: number) => (m > 0 ? c / m : 0);

  const download = async () => {
    if (!report) return;
    setBusy(true);
    try {
      const { downloadSmsCostReportPdf } = await import('@/lib/smsCostReportPdf');
      await downloadSmsCostReportPdf(`Welile-sms-otp-costs-${start}-to-${end}.pdf`, report, {
        windowLabel: `Last ${days} days`,
        rangeLabel: `${start} → ${end}`,
        payments,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the PDF');
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => { void cost.refetch(); void paid.refetch(); };

  return (
    <div className="space-y-4 printable">
      <Card className="overflow-hidden rounded-2xl border shadow-sm">
        <CardHeader className="gap-0 border-b bg-card px-5 py-5 sm:px-7 sm:py-6">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <MessageSquare className="h-6 w-6" />
            </div>
            <div>
              <CardTitle className="text-xl font-bold tracking-tight sm:text-2xl">SMS &amp; OTP Costs</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                What SMS and one-time codes cost, priced by message length, and what has been paid to Yoola and
                Africa&apos;s Talking. Read-only.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" /> {start} → {end} (Kampala days)</span>
                {report ? (
                  <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> Generated: {new Date(report.generated_at).toLocaleString()}</span>
                ) : null}
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6 px-5 pt-5 pb-6 sm:px-7 sm:pt-6">
          <div className="no-print flex flex-wrap items-center justify-between gap-3">
            <div className="flex h-11 items-center gap-1 rounded-xl border bg-muted/40 p-1">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setDays(w)}
                  className={`h-9 rounded-lg px-4 text-xs font-semibold transition ${
                    days === w ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Last {w} days
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={refresh} disabled={cost.isFetching}>
                <RefreshCw className={`mr-2 h-4 w-4 ${cost.isFetching ? 'animate-spin' : ''}`} /> Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!report}>
                <Printer className="mr-2 h-4 w-4" /> Print
              </Button>
              <Button size="sm" onClick={download} disabled={!report || busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />} Download PDF
              </Button>
            </div>
          </div>

          {cost.isLoading ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the report…</div>
          ) : cost.error || !report || !totals ? (
            <p className="py-6 text-sm text-destructive">Could not load the SMS cost report{cost.error ? `: ${(cost.error as Error).message}` : ''}.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi label="Total charges" value={ugx(totals.cost_ugx)} sub={`${fmt(totals.messages)} attempts · ${fmt(totals.segments)} segments`} />
                <Kpi label="One-time-code SMS" value={ugx(otp.cost)} sub={`${fmt(otp.messages)} codes at ${ugx1(per(otp.cost, otp.messages))} each`} />
                <Kpi label="Charged, not accepted" value={ugx(failedCost)} sub={`${fmt(totals.failed)} failed or pending attempts`} tone={failedCost > 0 ? 'warn' : undefined} />
                <Kpi label="Paid to providers" value={ugx(sumPayments(payments))} sub={`${fmt(payments.length)} requisitions in this window`} />
              </div>

              <Section title="Paid to the providers" note="Approved, credited requisitions naming the provider, against the usage estimate for the same days. Africa's Talking requisitions can also cover its voice API and sender ID, so paid and used will not match exactly.">
                {paid.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading payments…</p>
                ) : paid.error ? (
                  <p className="text-sm text-destructive">Could not load the provider payments.</p>
                ) : (
                  <>
                    <Table>
                      <TableHeader><TableRow><TableHead>Provider</TableHead><TableHead className="text-right">Requisitions</TableHead><TableHead className="text-right">Paid</TableHead><TableHead className="text-right">Usage estimate</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {SMS_PROVIDERS.map((n) => (
                          <TableRow key={n}>
                            <TableCell className="font-medium">{n}</TableCell>
                            <TableCell className="text-right">{fmt(countPayments(payments, n))}</TableCell>
                            <TableCell className="text-right">{ugx(sumPayments(payments, n))}</TableCell>
                            <TableCell className="text-right">{ugx(usageFor(n))}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="font-semibold">
                          <TableCell>Total</TableCell>
                          <TableCell className="text-right">{fmt(payments.length)}</TableCell>
                          <TableCell className="text-right">{ugx(sumPayments(payments))}</TableCell>
                          <TableCell className="text-right">{ugx(SMS_PROVIDERS.reduce((s, n) => s + usageFor(n), 0))}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                    {payments.length > 0 ? (
                      <Table className="mt-4">
                        <TableHeader><TableRow><TableHead>Requisition</TableHead><TableHead>Paid on</TableHead><TableHead>Provider</TableHead><TableHead>Title</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {payments.map((p) => (
                            <TableRow key={p.code}>
                              <TableCell className="font-medium">{p.code}</TableCell>
                              <TableCell>{p.day}</TableCell>
                              <TableCell>{p.provider}</TableCell>
                              <TableCell className="max-w-[320px] truncate" title={p.title}>{p.title}</TableCell>
                              <TableCell className="text-right">{ugx(p.amount)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : (
                      <p className="mt-3 text-sm text-muted-foreground">No requisition naming Yoola or Africa&apos;s Talking was approved in this window.</p>
                    )}
                  </>
                )}
              </Section>

              <Section title="Charges by provider">
                <UsageTable
                  rows={report.by_provider.map((r) => ({ name: r.provider, messages: r.messages, segments: r.segments, cost: r.cost_ugx }))}
                  total={{ name: 'Total', messages: totals.messages, segments: totals.segments, cost: totals.cost_ugx }}
                  first="Provider"
                />
              </Section>

              <Section title="One-time codes: charge per code">
                {otp.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No one-time-code SMS were found among the costliest streams in this window.</p>
                ) : (
                  <UsageTable
                    rows={otp.rows.map((r) => ({ name: streamLabel(r.source), messages: r.messages, segments: r.segments, cost: r.cost_ugx }))}
                    total={{ name: 'All one-time-code SMS', messages: otp.messages, segments: otp.segments, cost: otp.cost }}
                    first="Code stream"
                    perLabel="Per code"
                  />
                )}
              </Section>

              <Section title="Costliest message streams" note="The report lists the 30 costliest streams.">
                <UsageTable
                  rows={report.by_source.filter((r: SmsCostSourceRow) => !isOtpSource(r.source)).slice(0, 15).map((r) => ({ name: streamLabel(r.source), messages: r.messages, segments: r.segments, cost: r.cost_ugx }))}
                  first="Message stream"
                />
              </Section>

              <Section title="Charges per day">
                <Table>
                  <TableHeader><TableRow><TableHead>Day</TableHead><TableHead className="text-right">Messages</TableHead><TableHead className="text-right">Segments</TableHead><TableHead className="text-right">Yoola</TableHead><TableHead className="text-right">Africa&apos;s Talking</TableHead><TableHead className="text-right">Charges</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {[...report.daily].reverse().map((r) => (
                      <TableRow key={r.day}>
                        <TableCell className="font-medium">{r.day}</TableCell>
                        <TableCell className="text-right">{fmt(r.messages)}</TableCell>
                        <TableCell className="text-right">{fmt(r.segments)}</TableCell>
                        <TableCell className="text-right">{ugx(r.yoola_cost_ugx)}</TableCell>
                        <TableCell className="text-right">{ugx(r.at_cost_ugx)}</TableCell>
                        <TableCell className="text-right font-medium">{ugx(r.cost_ugx)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>

              <p className="text-xs text-muted-foreground">
                Priced at the platform&apos;s list rate: UGX 30 per segment (UGX 25 on Africa&apos;s Talking). A segment holds 160 characters (153 each when a message needs several; 70 and 67 with symbols).
                Every attempt counts, retries included. An estimate, not the provider invoice.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone === 'warn' ? 'text-destructive' : ''}`}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {children}
    </section>
  );
}

type UsageRow = { name: string; messages: number; segments: number; cost: number };

function UsageTable({ rows, total, first, perLabel = 'Per message' }: { rows: UsageRow[]; total?: UsageRow; first: string; perLabel?: string }) {
  const line = (r: UsageRow, bold = false) => (
    <TableRow key={r.name} className={bold ? 'font-semibold' : undefined}>
      <TableCell className="font-medium">{r.name}</TableCell>
      <TableCell className="text-right">{fmt(r.messages)}</TableCell>
      <TableCell className="text-right">{fmt(r.segments)}</TableCell>
      <TableCell className="text-right">{ugx1(r.messages > 0 ? r.cost / r.messages : 0)}</TableCell>
      <TableCell className="text-right">{ugx(r.cost)}</TableCell>
    </TableRow>
  );
  return (
    <Table>
      <TableHeader><TableRow><TableHead>{first}</TableHead><TableHead className="text-right">Messages</TableHead><TableHead className="text-right">Segments</TableHead><TableHead className="text-right">{perLabel}</TableHead><TableHead className="text-right">Charges</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((r) => line(r))}{total ? line(total, true) : null}</TableBody>
    </Table>
  );
}
