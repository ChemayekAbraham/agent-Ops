import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { EXCEPTIONS, adjustmentChange, type ExceptionCode, type RepaymentPlanRow } from '@/lib/tenantRepaymentTracker';
import { useTenantRepaymentDetail } from '@/hooks/useTenantRepaymentTracker';

const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kampala' }) : '—');
const fmtDay = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'Africa/Kampala' }) : '—');

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className="rounded-lg border border-border/70 p-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''}`}>{value}</p>
    </div>
  );
}

/** Read-only detail of one Rent Plan. Nothing here changes a balance, a repayment or a ledger entry. */
export function TenantRepaymentDetailSheet({ row, onClose }: { row: RepaymentPlanRow | null; onClose: () => void }) {
  const { data, isLoading, error } = useTenantRepaymentDetail(row?.rent_request_id ?? null);
  const p = data?.plan ?? row;

  return (
    <Sheet open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto">
        {p && (
          <>
            <SheetHeader>
              <SheetTitle>{p.tenant_name ?? 'Unknown tenant'}</SheetTitle>
              <SheetDescription>
                {p.tenant_phone ?? 'No phone'} · Agent {p.agent_name ?? '—'} · Landlord {p.landlord_name ?? '—'} · Plan {p.rent_request_id.slice(0, 8)} · {p.status}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-4">
              {p.exceptions.length > 0 && (
                <div className="space-y-1.5" role="alert">
                  {p.exceptions.map((code) => {
                    const e = EXCEPTIONS[code as ExceptionCode];
                    return (
                      <div key={code} className={`flex gap-2 rounded-lg border p-2.5 text-xs ${e?.severity === 'high' ? 'border-destructive/40 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
                        <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${e?.severity === 'high' ? 'text-destructive' : 'text-amber-600'}`} />
                        <div><p className="font-semibold">{e?.label ?? code}</p><p className="text-muted-foreground">{e?.meaning}</p></div>
                      </div>
                    );
                  })}
                </div>
              )}

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">What the tenant owes</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Figure label="Original principal" value={formatUGX(p.principal)} />
                  <Figure label="Access fee" value={formatUGX(p.access_fee)} />
                  <Figure label="Request fee" value={formatUGX(p.request_fee)} />
                  <Figure label="Total repayment obligation" value={formatUGX(p.obligation)} />
                </div>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Collections and balance</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Figure label="Collected" value={formatUGX(p.verified_collected)} />
                  <Figure label="Outstanding" value={formatUGX(p.calc_outstanding)} tone={p.calc_outstanding > 0 ? 'warn' : undefined} />
                  <Figure label="Recorded repaid" value={formatUGX(p.stored_repaid)} tone={p.repaid_without_receipts >= 1000 ? 'bad' : undefined} />
                  <Figure label="Recorded outstanding" value={formatUGX(p.stored_outstanding)} />
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Collected = {formatUGX(p.money_in_collected)} on Money In (Tenant Products and Services) from 1 Oct 2026
                  {p.pre_cutoff_collected > 0 ? ` + ${formatUGX(p.pre_cutoff_collected)} in receipts before 1 Oct 2026` : ''}.
                </p>
                <div className="mt-3">
                  <div className="flex justify-between text-xs mb-1"><span>Repayment progress</span><span className="tabular-nums">{p.progress_pct ?? 0}%</span></div>
                  <Progress value={Number(p.progress_pct ?? 0)} aria-label="Repayment progress" />
                </div>
                {(p.repaid_without_receipts >= 1000 || p.manual_reduction_total > 0 || p.reversed_amount > 0 || p.unverified_amount > 0) && (
                  <ul className="mt-3 text-xs text-muted-foreground space-y-0.5 list-disc pl-4">
                    {p.repaid_without_receipts >= 1000 && <li>{formatUGX(p.repaid_without_receipts)} is recorded as repaid with no collection behind it.</li>}
                    {p.manual_reduction_total > 0 && <li>{formatUGX(p.manual_reduction_total)} of balance reductions by edit ({p.manual_reduction_count}). Not counted as repayment.</li>}
                    {p.reversed_amount > 0 && <li>{formatUGX(p.reversed_amount)} in {p.reversed_count} reversed receipt(s), not counted.</li>}
                    {p.unverified_amount > 0 && <li>{formatUGX(p.unverified_amount)} in {p.unverified_count} repayment record(s) with no receipt and no ledger entry, not counted.</li>}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Schedule (payout clock)</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Figure label="Clock" value={`${p.clock_bucket ?? '—'}`} />
                  <Figure label="Term" value={`${fmtDay(p.clock_start)} to ${fmtDay(p.clock_end)}`} />
                  <Figure label="Expected to date" value={p.expected_to_date === null ? '—' : formatUGX(p.expected_to_date)} />
                  <Figure label="Arrears" value={p.arrears === null ? '—' : `${formatUGX(p.arrears)}${p.days_behind ? ` · ${p.days_behind} days` : ''}`} tone={Number(p.arrears) >= 1000 ? 'warn' : undefined} />
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Books: disbursed {p.disbursed === null ? '—' : formatUGX(p.disbursed)}, receivable {p.books_receivable === null ? '—' : formatUGX(p.books_receivable)}
                  {p.is_legacy ? ' (funded before 1 Oct 2026, earlier posting scheme)' : ''}.
                </p>
              </section>

              {isLoading && <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading history...</p>}
              {error && <p className="text-xs text-destructive">Could not load the history: {(error as Error).message}</p>}

              {data && (
                <Tabs defaultValue="money-in">
                  <TabsList className="flex-wrap h-auto">
                    <TabsTrigger value="money-in">Money In ({data.money_in.length})</TabsTrigger>
                    <TabsTrigger value="receipts">Receipts ({data.receipts.length})</TabsTrigger>
                    <TabsTrigger value="adjustments">Balance adjustments ({data.adjustments.length})</TabsTrigger>
                    <TabsTrigger value="records">Other records ({data.repayment_records.length})</TabsTrigger>
                    <TabsTrigger value="ledger">Ledger ({data.ledger.length})</TabsTrigger>
                  </TabsList>

                  <TabsContent value="money-in">
                    <p className="text-[11px] text-muted-foreground mb-2">The plan's entries on Money In (Tenant Products and Services). Counted from 1 Oct 2026.</p>
                    {data.money_in.length === 0 ? <p className="text-xs text-muted-foreground py-3">No Money In entries.</p> : (
                      <Table>
                        <TableHeader><TableRow><TableHead>Date</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Reference</TableHead><TableHead>Counted</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {data.money_in.map((m, i) => (
                            <TableRow key={`${m.group}-${i}`}>
                              <TableCell className="text-xs whitespace-nowrap">{fmtDate(m.at)}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums">{m.direction === 'cash_out' ? '-' : ''}{formatUGX(Number(m.amount))}</TableCell>
                              <TableCell className="text-xs"><span className="font-mono">{m.reference ?? String(m.group).slice(0, 8)}</span><div className="text-muted-foreground">{m.description}</div></TableCell>
                              <TableCell className="text-xs">{m.counted ? <Badge variant="outline">Yes</Badge> : <Badge variant="secondary">Before 1 Oct 2026</Badge>}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </TabsContent>

                  <TabsContent value="receipts">
                    <p className="text-[11px] text-muted-foreground mb-2">Collection receipts. Counted before 1 Oct 2026; from then on a receipt counts through its Money In entry.</p>
                    {data.receipts.length === 0 ? <p className="text-xs text-muted-foreground py-3">No receipts.</p> : (
                      <Table>
                        <TableHeader><TableRow><TableHead>Date</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Reference</TableHead><TableHead>How</TableHead><TableHead>Checks</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {data.receipts.map((r) => (
                            <TableRow key={r.id} className={r.reversed ? 'opacity-60' : ''}>
                              <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.at)}</TableCell>
                              <TableCell className={`text-xs text-right tabular-nums ${r.reversed ? 'line-through' : ''}`}>{formatUGX(Number(r.amount))}</TableCell>
                              <TableCell className="text-xs font-mono">{r.reference ?? '—'}</TableCell>
                              <TableCell className="text-xs">{r.path}{r.method ? ` · ${r.method}` : ''}{r.agent ? ` · ${r.agent}` : ''}</TableCell>
                              <TableCell className="text-xs space-x-1">
                                {r.reversed && <Badge variant="secondary">Reversed</Badge>}
                                {!r.reversed && r.counted && <Badge variant="outline">Counted</Badge>}
                                {!r.reversed && r.ledger_checked && (r.ledger_posted ? <Badge variant="outline">On Money In</Badge> : <Badge variant="destructive">Not on Money In</Badge>)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </TabsContent>

                  <TabsContent value="adjustments">
                    {data.adjustments.length === 0 ? <p className="text-xs text-muted-foreground py-3">No balance or obligation changes.</p> : (
                      <ul className="space-y-2">
                        {data.adjustments.map((a, i) => (
                          <li key={`${a.at}-${i}`} className="rounded-lg border border-border/70 p-2.5 text-xs">
                            <div className="flex flex-wrap justify-between gap-2">
                              <span className="font-semibold">{a.kind}</span>
                              <span className="text-muted-foreground">{fmtDate(a.at)}</span>
                            </div>
                            <p className="mt-0.5">{adjustmentChange(a, formatUGX)}{Number(a.reduction) > 0 ? ` (reduction ${formatUGX(Number(a.reduction))})` : ''}</p>
                            <p className="text-muted-foreground mt-0.5">
                              By {a.by ?? 'unknown'}{a.approved_by ? ` · approved by ${a.approved_by}` : ''}{a.status ? ` · ${a.status}` : ''}
                              {a.after_funding === false ? ' · before funding' : ''}
                            </p>
                            {a.reason && <p className="mt-0.5">Reason: {a.reason}</p>}
                            {a.decision_note && <p className="mt-0.5">Decision note: {a.decision_note}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TabsContent>

                  <TabsContent value="records">
                    <p className="text-[11px] text-muted-foreground mb-2">Repayment records with no matching receipt. Counted before 1 Oct 2026 when the ledger carries the cash.</p>
                    {data.repayment_records.length === 0 ? <p className="text-xs text-muted-foreground py-3">None.</p> : (
                      <Table>
                        <TableHeader><TableRow><TableHead>Date</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Reference</TableHead><TableHead>Counted</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {data.repayment_records.map((r, i) => (
                            <TableRow key={`${r.at}-${i}`}>
                              <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.at)}</TableCell>
                              <TableCell className="text-xs text-right tabular-nums">{formatUGX(Number(r.amount))}</TableCell>
                              <TableCell className="text-xs font-mono">{r.reference ?? '—'}</TableCell>
                              <TableCell className="text-xs">{r.counted ? <Badge variant="outline">Yes, in ledger</Badge> : r.ledger_backed ? <Badge variant="secondary">In ledger, counted on Money In</Badge> : <Badge variant="destructive">No, unverified</Badge>}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </TabsContent>

                  <TabsContent value="ledger">
                    {data.ledger.length === 0 ? <p className="text-xs text-muted-foreground py-3">No ledger entries.</p> : (
                      <Table>
                        <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Entry</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Group</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {data.ledger.map((l, i) => (
                            <TableRow key={`${l.group}-${i}`}>
                              <TableCell className="text-xs whitespace-nowrap">{fmtDate(l.at)}</TableCell>
                              <TableCell className="text-xs">{l.category} · {l.scope} {l.direction}<div className="text-muted-foreground">{l.description}</div></TableCell>
                              <TableCell className="text-xs text-right tabular-nums">{formatUGX(Number(l.amount))}</TableCell>
                              <TableCell className="text-xs font-mono">{String(l.group).slice(0, 8)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </TabsContent>
                </Tabs>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
