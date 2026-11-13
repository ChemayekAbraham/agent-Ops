import { useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { AlertTriangle, Copy, Download, FileWarning, Loader2, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useReceiptHistory } from '@/hooks/usePartnerReceipts';
import { PAYOUT_RECEIPT_BASE_URL, type ArchiveRow } from '@/hooks/useReceiptArchive';
import { useReceiptCopy } from '@/hooks/useReceiptCopy';
import { downloadReceiptCopy, printReceiptCopy, prettyPhone } from '@/lib/receiptCopy';
import { METHOD_LABEL, type PartnerReceiptMethod } from '@/lib/partnerReceiptPdf';
import { formatUGX } from '@/lib/rentCalculations';
import { finopsPath } from '@/lib/financialOpsRoutes';
import { ReceiptCopy } from './ReceiptCopy';

/**
 * Receipt detail drawer: the black-and-white receipt copy on the left; who handled it, delivery, linked record and history on the right.
 * Read-only. Print and Download make a reprint of the copy. Corrections are requested in Partner Receipts and approved by the CFO.
 */
const EVENT_LABEL: Record<string, string> = {
  issued: 'Issued', issued_as_correction: 'Issued as a correction', cash_confirmed: 'Cash counted and confirmed', delivered: 'Copy given to the partner',
  correction_requested: 'Correction requested', correction_rejected: 'Correction rejected', voided: 'Voided',
};

const STATUS_TONE: Record<string, string> = {
  issued: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  voided: 'border-border bg-muted text-muted-foreground',
  corrected: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="text-sm space-y-1">{children}</div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{k}</span>
      <span className="font-medium text-right break-words min-w-0">{v}</span>
    </div>
  );
}

export function ReceiptDetailDrawer({ row, onClose, canIssue }: { row: ArchiveRow | null; onClose: () => void; canIssue: boolean }) {
  const { toast } = useToast();
  const bundle = useReceiptCopy(row);
  const isIn = row?.source === 'partner_receipt';
  const history = useReceiptHistory(isIn ? row!.id : null);
  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null);

  const fail = (e: unknown) => toast({ title: 'Could not do that', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
  const data = bundle.data;

  const onPrint = async () => {
    if (!data) return;
    setBusy('print');
    try {
      const ok = await printReceiptCopy(data.copy);
      if (!ok) toast({ title: 'Allow pop-ups to print', description: 'Your browser blocked the print tab. Allow pop-ups for this site, or use Download PDF.', variant: 'destructive' });
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const onPdf = async () => {
    if (!data) return;
    setBusy('pdf');
    try { await downloadReceiptCopy(data.copy); } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const copyLink = async () => {
    if (!row?.link_token) return;
    const url = `${PAYOUT_RECEIPT_BASE_URL}${row.link_token}`;
    try { await navigator.clipboard.writeText(url); toast({ title: 'Receipt link copied', description: url }); } catch { toast({ title: 'Copy failed', description: url, variant: 'destructive' }); }
  };

  const p = data?.partner ?? null;

  return (
    <Sheet open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-[1120px] overflow-y-auto">
        {row && (
          <>
            <SheetHeader className="pr-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <SheetTitle className="text-xl">Receipt No. {row.receipt_ref}</SheetTitle>
                  <Badge variant="outline" className={`text-[10px] font-semibold ${STATUS_TONE[row.status]}`}>
                    {row.status === 'issued' ? 'Issued' : row.status === 'voided' ? 'Voided' : 'Corrected'}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={onPrint} disabled={!data || !!busy}>
                    {busy === 'print' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Printer className="h-4 w-4 mr-1" />} Print
                  </Button>
                  <Button size="sm" variant="outline" onClick={onPdf} disabled={!data || !!busy}>
                    {busy === 'pdf' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} Download PDF
                  </Button>
                  {!isIn && row.link_token && (
                    <Button size="sm" variant="outline" onClick={copyLink}><Copy className="h-4 w-4 mr-1" /> Copy public link</Button>
                  )}
                </div>
              </div>
              <SheetDescription>
                {isIn ? 'Money in' : 'Money out'} · {row.client_name || 'Name not recorded'} · {formatUGX(row.amount)}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {/* The copy */}
              <div className="rounded-xl bg-muted/60 p-3 sm:p-4 self-start">
                {bundle.isLoading ? <Skeleton className="w-full aspect-[210/148]" /> : bundle.isError ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive flex items-start gap-2" role="alert">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>Could not load this receipt. {bundle.error instanceof Error ? bundle.error.message : ''}</span>
                  </div>
                ) : data ? <ReceiptCopy data={data.copy} /> : null}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  This is a copy. Printing or downloading it adds a "Reprint" line so it cannot pass as the original.
                </p>
              </div>

              {/* Details */}
              <div className="space-y-5">
                <Section title="Summary">
                  <Row k="Client" v={row.client_name || '—'} />
                  <Row k="Phone" v={prettyPhone(row.client_phone) || '—'} />
                  <Row k="Amount" v={formatUGX(row.amount)} />
                  <Row k="Method" v={(METHOD_LABEL as Record<string, string>)[row.method] ?? row.method} />
                  <Row k="Purpose" v={row.purpose} />
                  <Row k="Date" v={format(new Date(row.event_at), isIn ? 'dd MMM yyyy' : 'dd MMM yyyy HH:mm')} />
                </Section>

                {isIn ? (
                  <>
                    <Section title="Handled by">
                      <Row k="Issued by" v={p ? `${p.issued_by_name ?? 'Unknown'}, ${format(new Date(p.issued_at), 'dd MMM yyyy HH:mm')}` : '—'} />
                      {p?.payment_method === 'cash' && (
                        <Row k="Cash confirmed by" v={p.cash_confirmed_at ? `${p.cash_confirmed_by_name ?? 'Unknown'}, ${format(new Date(p.cash_confirmed_at), 'dd MMM yyyy HH:mm')}` : (
                          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><FileWarning className="h-3.5 w-3.5" /> Not yet counted by a second person</span>
                        )} />
                      )}
                    </Section>
                    <Section title="Delivery">
                      <Row k="Given to the partner" v={p?.delivered_at ? `${p.delivered_via}, ${format(new Date(p.delivered_at), 'dd MMM yyyy HH:mm')}` : 'Not recorded'} />
                    </Section>
                    <Section title="Linked record">
                      <Row k="System deposit" v={p ? (p.deposit_request_id ? 'Linked' : 'Not linked') : '—'} />
                      {p && !p.deposit_request_id && <p className="text-xs text-muted-foreground">Find the deposit, or this money is not in the books.</p>}
                    </Section>
                    <Section title="History">
                      {history.isLoading ? <Skeleton className="h-16 w-full" /> : (history.data ?? []).length === 0 ? <p className="text-muted-foreground">No history yet.</p> : (
                        <ol className="relative border-l pl-4 space-y-3 ml-1">
                          {(history.data ?? []).map((e, i) => (
                            <li key={i} className="relative">
                              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
                              <div className="font-medium">{EVENT_LABEL[e.event] ?? e.event}</div>
                              <div className="text-xs text-muted-foreground">{e.actor_name ?? 'System'} · {format(new Date(e.at), 'dd MMM yyyy HH:mm')}</div>
                              {typeof e.detail?.reason === 'string' && <div className="text-xs">Reason: {e.detail.reason}</div>}
                            </li>
                          ))}
                        </ol>
                      )}
                    </Section>
                    {canIssue && row.status === 'issued' && (
                      <Button variant="outline" size="sm" asChild>
                        <Link to={finopsPath('partner_receipts')}>Request void / correction</Link>
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Section title="Payout">
                      <Row k="Reference (TID)" v={data?.reference ?? '—'} />
                      <Row k="Receipt code" v={row.receipt_ref} />
                      {row.link_token && (
                        <Row k="Public receipt" v={<a className="text-primary underline" href={`${PAYOUT_RECEIPT_BASE_URL}${row.link_token}`} target="_blank" rel="noopener noreferrer">Open the page sent to the recipient</a>} />
                      )}
                    </Section>
                    <p className="text-xs text-muted-foreground">
                      Payout proof of payment and who funded the payout are on the Payout proofs tab.
                    </p>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default ReceiptDetailDrawer;
