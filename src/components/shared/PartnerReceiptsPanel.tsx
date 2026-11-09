import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  AlertTriangle, Ban, CheckCircle2, Download, FileSpreadsheet, FilePlus2, Loader2, Receipt, Search, ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import {
  RECEIPT_PAGE_SIZE, useDailyClosing, usePartnerReceipts, usePendingCorrections, useReceiptAccess, useReceiptHistory,
  useReceiptMutations, type ReceiptFilters,
} from '@/hooks/usePartnerReceipts';
import {
  METHOD_LABEL, amountInWords, downloadPartnerReceiptPdf, type PartnerReceiptMethod, type PartnerReceiptRow,
} from '@/lib/partnerReceiptPdf';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Partner Receipts: the digital replacement for the paper receipt books.
 * Shown to Financial Ops, the CFO and Partner Ops. Issuing is limited to Financial Ops and the CFO; corrections are
 * approved by the CFO, never by the person who asked. A receipt is evidence only: nothing here moves money.
 */
const today = () => format(new Date(), 'yyyy-MM-dd');
const ANY = '__any';

export function PartnerReceiptsPanel() {
  const { toast } = useToast();
  const access = useReceiptAccess();
  const m = useReceiptMutations();
  const [filters, setFilters] = useState<ReceiptFilters>({ search: '', from: '', to: '', method: '', status: '', page: 0 });
  const [issueOpen, setIssueOpen] = useState(false);
  const [open, setOpen] = useState<PartnerReceiptRow | null>(null);
  const list = usePartnerReceipts(filters);
  const closing = useDailyClosing(today());
  const canApprove = !!access.data?.canApprove;
  const pending = usePendingCorrections(canApprove);
  const rows = list.data ?? [];
  const total = rows[0]?.total_count ?? 0;
  const set = (p: Partial<ReceiptFilters>) => setFilters((f) => ({ ...f, page: 0, ...p }));
  const err = (e: unknown) => toast({ title: 'Could not do that', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });

  const exportExcel = async () => {
    const XLSX = await import('xlsx');
    const sheet = rows.map((r) => ({
      'Receipt': r.receipt_code, 'Date': r.received_on, 'Received from': r.received_from, 'Phone': r.payer_phone ?? '',
      'Amount (UGX)': r.amount, 'Method': METHOD_LABEL[r.payment_method], 'Cheque/draft no.': r.instrument_no ?? '',
      'Drawn on': r.drawn_on ?? '', 'Purpose': r.purpose, 'Status': r.status, 'Issued by': r.issued_by_name ?? '',
      'Cash confirmed by': r.cash_confirmed_by_name ?? '', 'Linked to a system deposit': r.deposit_request_id ? 'Yes' : 'No',
      'Void reason': r.void_reason ?? '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'Receipts');
    XLSX.writeFile(wb, `welile-receipts-${today()}.xlsx`);
  };

  const c = closing.data;
  const pendingById = useMemo(() => new Map((pending.data ?? []).map((p) => [p.receipt_id, p])), [pending.data]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="h-11 w-11 rounded-xl border flex items-center justify-center bg-primary/10 text-primary">
            <Receipt className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight">Partner Receipts</h1>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Every payment handed in gets a numbered digital receipt, searchable for years. Receipts cannot be edited or
              deleted; mistakes go through a correction the CFO approves.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportExcel} disabled={!rows.length}>
            <FileSpreadsheet className="h-4 w-4 mr-1" /> Excel
          </Button>
          {access.data?.canIssue && (
            <Button size="sm" onClick={() => setIssueOpen(true)}><FilePlus2 className="h-4 w-4 mr-1" /> Issue receipt</Button>
          )}
        </div>
      </header>

      {/* Daily closing */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Today's closing</CardTitle></CardHeader>
        <CardContent>
          {closing.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : c ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Receipts issued" value={String(c.issued_count)} />
                <Stat label="Total receipted" value={formatUGX(c.issued_total)} />
                <Stat label="Voided today" value={String(c.voided_count)} />
                <Stat label="Corrections waiting" value={String(c.pending_corrections)} warn={c.pending_corrections > 0} />
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries(c.by_method).map(([k, v]) => (
                  <Badge key={k} variant="secondary">{METHOD_LABEL[k as PartnerReceiptMethod] ?? k}: {v.count} · {formatUGX(v.total)}</Badge>
                ))}
              </div>
              {(c.cash_unconfirmed_count > 0 || c.unlinked_count > 0 || c.undelivered_count > 0) && (
                <ul className="text-sm space-y-1">
                  {c.cash_unconfirmed_count > 0 && <Flag text={`${c.cash_unconfirmed_count} cash receipt(s), ${formatUGX(c.cash_unconfirmed_total)}, not yet counted and confirmed by a second person.`} />}
                  {c.unlinked_count > 0 && <Flag text={`${c.unlinked_count} receipt(s) not linked to a system deposit. Find the deposit, or the money is not in the books.`} />}
                  {c.undelivered_count > 0 && <Flag text={`${c.undelivered_count} receipt(s) not yet given to the partner.`} />}
                </ul>
              )}
            </div>
          ) : <p className="text-sm text-muted-foreground">Closing report unavailable.</p>}
        </CardContent>
      </Card>

      {/* Corrections waiting for the CFO */}
      {canApprove && (pending.data?.length ?? 0) > 0 && (
        <Card className="border-amber-500/40">
          <CardHeader className="pb-2"><CardTitle className="text-base">Corrections waiting for your decision</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {pending.data!.map((p) => {
              const r = rows.find((x) => x.id === p.receipt_id);
              const mine = p.requested_by === access.data?.userId;
              return (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-semibold">{r ? `${r.receipt_code} · ${r.received_from} · ${formatUGX(r.amount)}` : 'Receipt'}</div>
                    <div className="text-muted-foreground">
                      {p.kind === 'void' ? 'Void' : `Correct to ${JSON.stringify(p.proposed)}`}: {p.reason}
                    </div>
                  </div>
                  {mine ? <span className="text-xs text-muted-foreground">You asked for this; another approver must decide.</span> : (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => m.decide.mutate({ id: p.id, approve: true }, { onError: err, onSuccess: () => toast({ title: 'Approved' }) })}>Approve</Button>
                      <Button size="sm" variant="outline" onClick={() => {
                        const note = window.prompt('Why are you rejecting this?') ?? '';
                        if (note.trim()) m.decide.mutate({ id: p.id, approve: false, note }, { onError: err });
                      }}>Reject</Button>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="grid gap-2 sm:grid-cols-5">
            <div className="relative sm:col-span-2">
              <Search className="h-4 w-4 absolute left-2.5 top-3 text-muted-foreground" />
              <Input className="pl-8" placeholder="Name, receipt number, amount or phone" value={filters.search}
                onChange={(e) => set({ search: e.target.value })} aria-label="Search receipts" />
            </div>
            <Input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} aria-label="From date" />
            <Input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} aria-label="To date" />
            <Select value={filters.method || ANY} onValueChange={(v) => set({ method: v === ANY ? '' : v })}>
              <SelectTrigger aria-label="Payment method"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All methods</SelectItem>
                {Object.entries(METHOD_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            {(['', 'issued', 'voided'] as const).map((s) => (
              <Button key={s || 'all'} size="sm" variant={filters.status === s ? 'default' : 'outline'} onClick={() => set({ status: s })}>
                {s === '' ? 'All' : s === 'issued' ? 'Issued' : 'Voided'}
              </Button>
            ))}
          </div>

          {list.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : list.error ? (
            <p className="text-sm text-destructive">{(list.error as Error).message}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No receipts match.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {rows.map((r) => (
                <button key={r.id} type="button" onClick={() => setOpen(r)}
                  className="w-full text-left p-3 flex flex-wrap items-center justify-between gap-2 hover:bg-muted/50 focus-visible:outline focus-visible:outline-2">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{r.received_from}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.receipt_code} · {format(new Date(`${r.received_on}T00:00:00`), 'dd MMM yyyy')} · {METHOD_LABEL[r.payment_method]}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {pendingById.has(r.id) || r.pending_correction_id ? <Badge variant="outline">Correction pending</Badge> : null}
                    {r.status === 'voided' ? <Badge variant="destructive">Voided</Badge> : <Badge variant="secondary">Issued</Badge>}
                    <span className="font-bold tabular-nums">{formatUGX(r.amount)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
          {total > RECEIPT_PAGE_SIZE && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{filters.page * RECEIPT_PAGE_SIZE + 1}–{Math.min((filters.page + 1) * RECEIPT_PAGE_SIZE, total)} of {total}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={filters.page === 0} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>Previous</Button>
                <Button size="sm" variant="outline" disabled={(filters.page + 1) * RECEIPT_PAGE_SIZE >= total} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {issueOpen && <IssueDialog onClose={() => setIssueOpen(false)} onIssued={(r) => { setIssueOpen(false); setOpen(r); }} />}
      {open && <DetailDialog receipt={open} canIssue={!!access.data?.canIssue} userId={access.data?.userId} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warn ? 'border-amber-500/50 bg-amber-500/5' : ''}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-black tabular-nums">{value}</div>
    </div>
  );
}
function Flag({ text }: { text: string }) {
  return <li className="flex gap-2 items-start text-amber-700 dark:text-amber-400"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{text}</li>;
}

function IssueDialog({ onClose, onIssued }: { onClose: () => void; onIssued: (r: PartnerReceiptRow) => void }) {
  const { toast } = useToast();
  const m = useReceiptMutations();
  const [f, setF] = useState({
    name: '', phone: '', amount: '', method: 'cash' as PartnerReceiptMethod, purpose: 'Partnership contribution',
    date: today(), instrument: '', drawnOn: '', depositId: '', note: '',
  });
  const amountNum = Number(f.amount.replace(/[^0-9]/g, ''));
  const needsInstrument = f.method === 'cheque' || f.method === 'bank_draft';
  const problem = f.name.trim().length < 3 ? 'Enter the full name of the person who paid.'
    : !amountNum ? 'Enter the amount.'
    : needsInstrument && !f.instrument.trim() ? 'Enter the cheque or draft number.'
    : f.purpose.trim().length < 3 ? 'Enter what the payment is for.'
    : /^\s*$/.test(f.depositId) || /^[0-9a-f-]{36}$/i.test(f.depositId.trim()) ? null : 'The deposit ID must be a full ID, or leave it blank.';
  const submit = () => m.issue.mutate({
    received_from: f.name, amount: amountNum, method: f.method, purpose: f.purpose, received_on: f.date,
    payer_phone: f.phone, instrument_no: f.instrument, drawn_on: f.drawnOn, deposit_request_id: f.depositId.trim() || null, note: f.note,
  }, {
    onSuccess: (r) => { toast({ title: `Receipt ${r.receipt_code} issued` }); onIssued(r); },
    onError: (e) => toast({ title: 'Could not issue the receipt', description: (e as Error).message, variant: 'destructive' }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Issue a receipt</DialogTitle>
          <DialogDescription>Check every field. After you issue it, the amount and name can no longer be changed.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Received with thanks from"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Phone (optional)"><Input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Amount (UGX)">
            <Input inputMode="numeric" value={f.amount ? amountNum.toLocaleString('en-US') : ''} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            {amountNum > 0 && <p className="text-xs text-muted-foreground mt-1">{amountInWords(amountNum)}</p>}
          </Field>
          <Field label="How was it paid?">
            <Select value={f.method} onValueChange={(v) => setF({ ...f, method: v as PartnerReceiptMethod })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(METHOD_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {needsInstrument && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cheque / draft no."><Input value={f.instrument} onChange={(e) => setF({ ...f, instrument: e.target.value })} /></Field>
              <Field label="Drawn on (bank)"><Input value={f.drawnOn} onChange={(e) => setF({ ...f, drawnOn: e.target.value })} /></Field>
            </div>
          )}
          <Field label="For"><Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
          <Field label="Date received"><Input type="date" max={today()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="System deposit ID (links this receipt to the money in the books)">
            <Input value={f.depositId} placeholder="Paste the deposit ID, or leave blank" onChange={(e) => setF({ ...f, depositId: e.target.value })} />
            <p className="text-xs text-muted-foreground mt-1">The amount must equal the deposit. A receipt with no deposit is flagged in the daily closing.</p>
          </Field>
          <Field label="Note (optional)"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        {problem && <p className="text-sm text-amber-700">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!!problem || m.issue.isPending} onClick={submit}>
            {m.issue.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Issue receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label className="text-xs">{label}</Label>{children}</div>;
}

function DetailDialog({ receipt: r, canIssue, userId, onClose }: { receipt: PartnerReceiptRow; canIssue: boolean; userId?: string; onClose: () => void }) {
  const { toast } = useToast();
  const m = useReceiptMutations();
  const history = useReceiptHistory(r.id);
  const [mode, setMode] = useState<null | 'void' | 'correct'>(null);
  const [reason, setReason] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newName, setNewName] = useState('');
  const fail = (e: unknown) => toast({ title: 'Could not do that', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
  const proposed: Record<string, unknown> = {};
  if (newAmount) proposed.amount = Number(newAmount.replace(/[^0-9]/g, ''));
  if (newName.trim()) proposed.received_from = newName.trim();
  const live = r.status === 'issued';
  const cashNeedsConfirm = live && r.payment_method === 'cash' && !r.cash_confirmed_at;
  const send = () => mode && m.requestCorrection.mutate(
    { id: r.id, kind: mode, reason, proposed: mode === 'correct' ? proposed : {} },
    { onSuccess: () => { toast({ title: 'Sent to the CFO for approval' }); setMode(null); onClose(); }, onError: fail },
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{r.receipt_code}
            {live ? <Badge variant="secondary">Issued</Badge> : <Badge variant="destructive">Voided</Badge>}
          </DialogTitle>
          <DialogDescription>{r.received_from} · {formatUGX(r.amount)}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Date</dt><dd>{format(new Date(`${r.received_on}T00:00:00`), 'dd MMM yyyy')}</dd>
          <dt className="text-muted-foreground">In words</dt><dd>{amountInWords(r.amount)}</dd>
          <dt className="text-muted-foreground">Method</dt>
          <dd>{METHOD_LABEL[r.payment_method]}{r.instrument_no ? ` no. ${r.instrument_no}` : ''}{r.drawn_on ? `, ${r.drawn_on}` : ''}</dd>
          <dt className="text-muted-foreground">For</dt><dd>{r.purpose}</dd>
          <dt className="text-muted-foreground">Issued by</dt><dd>{r.issued_by_name ?? 'Unknown'} · {format(new Date(r.issued_at), 'dd MMM HH:mm')}</dd>
          <dt className="text-muted-foreground">System deposit</dt>
          <dd>{r.deposit_request_id ? <span className="inline-flex items-center gap-1"><ShieldCheck className="h-4 w-4 text-green-600" />Linked</span> : <span className="text-amber-700">Not linked</span>}</dd>
          {r.payment_method === 'cash' && (<><dt className="text-muted-foreground">Cash counted by</dt>
            <dd>{r.cash_confirmed_by_name ? `${r.cash_confirmed_by_name} · ${format(new Date(r.cash_confirmed_at!), 'dd MMM HH:mm')}` : <span className="text-amber-700">Not yet confirmed</span>}</dd></>)}
          <dt className="text-muted-foreground">Given to partner</dt>
          <dd>{r.delivered_at ? `${r.delivered_via} · ${format(new Date(r.delivered_at), 'dd MMM HH:mm')}` : 'Not yet'}</dd>
          {!live && (<><dt className="text-muted-foreground">Void reason</dt><dd>{r.void_reason}</dd></>)}
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => downloadPartnerReceiptPdf(r).then(() => canIssue && live && m.markDelivered.mutate({ id: r.id, via: 'download' })).catch(fail)}>
            <Download className="h-4 w-4 mr-1" /> PDF
          </Button>
          {canIssue && cashNeedsConfirm && (
            r.issued_by === userId
              ? <span className="text-xs text-muted-foreground self-center">A different person must count and confirm this cash.</span>
              : <Button size="sm" variant="outline" onClick={() => m.confirmCash.mutate(r.id, { onSuccess: () => { toast({ title: 'Cash confirmed' }); onClose(); }, onError: fail })}>
                  <CheckCircle2 className="h-4 w-4 mr-1" /> I counted this cash
                </Button>
          )}
          {canIssue && live && !r.pending_correction_id && (
            <>
              <Button size="sm" variant="outline" onClick={() => setMode('correct')}>Request correction</Button>
              <Button size="sm" variant="outline" onClick={() => setMode('void')}><Ban className="h-4 w-4 mr-1" /> Request void</Button>
            </>
          )}
          {r.pending_correction_id && <Badge variant="outline">Correction waiting for the CFO</Badge>}
        </div>

        {mode && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-semibold">{mode === 'void' ? 'Void this receipt' : 'Correct this receipt'}</p>
            <p className="text-xs text-muted-foreground">The original stays on record. The CFO decides; the person who asks cannot approve.</p>
            {mode === 'correct' && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Right amount (leave blank if unchanged)"><Input inputMode="numeric" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} /></Field>
                <Field label="Right name (leave blank if unchanged)"><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></Field>
              </div>
            )}
            <Field label="Why?"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setMode(null)}>Cancel</Button>
              <Button size="sm" disabled={reason.trim().length < 5 || (mode === 'correct' && !Object.keys(proposed).length) || m.requestCorrection.isPending} onClick={send}>
                Send to CFO
              </Button>
            </div>
          </div>
        )}

        <div>
          <p className="text-sm font-semibold mb-1">History</p>
          {history.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : (
            <ol className="text-xs space-y-1">
              {(history.data ?? []).map((e, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span>{e.event.replace(/_/g, ' ')} · {e.actor_name ?? 'system'}</span>
                  <span className="text-muted-foreground">{format(new Date(e.at), 'dd MMM HH:mm')}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PartnerReceiptsPanel;
