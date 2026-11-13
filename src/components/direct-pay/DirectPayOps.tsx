import { useEffect, useMemo, useRef, useState } from 'react';
import { Phone, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDirectPayApprove, useDirectPayProofPhotos, useDirectPayQueue, useDirectPayReject, useDirectPaySendOtp } from '@/hooks/useDirectPay';
import { DIRECT_PAY_FLAG_LABEL, directPayDecisionMessage, formatUgx, welileReceiptUrl, type DirectPayQueueRow, type DirectPayQueueView } from '@/lib/directPay';
import { DirectPayUnavailable } from './DirectPayPartner';

function OpsPayment({ row, canAct, photos }: { row: DirectPayQueueRow; canAct: boolean; photos: Record<string, string> }) {
  const [otp, setOtp] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ number?: string; code?: string } | null>(null);
  const send = useDirectPaySendOtp();
  const approve = useDirectPayApprove();
  const reject = useDirectPayReject();
  const busy = send.isPending || approve.isPending || reject.isPending;
  const failure = () => setMessage(directPayDecisionMessage({ ok: false, code: 'not_found' }));
  return <li className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="font-semibold">{row.tenant.name ?? 'Tenant'} · Rent Plan</h2><div className="flex flex-wrap gap-2"><Badge variant="outline">{row.status}</Badge>{row.over_24h && <Badge variant="destructive">Over 24 hours</Badge>}</div></div>
    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <div><dt className="text-muted-foreground">Partner</dt><dd>{row.partner.name ?? '—'} · {row.partner.phone ?? '—'}</dd></div>
      <div><dt className="text-muted-foreground">Tenant</dt><dd>{row.tenant.name ?? '—'} · {row.tenant.phone ?? '—'}</dd></div>
      <div><dt className="text-muted-foreground">Agent</dt><dd>{row.agent.name ?? '—'} · {row.agent.phone ?? '—'}</dd></div>
      <div><dt className="text-muted-foreground">Landlord</dt><dd>{row.landlord.name ?? '—'}</dd><dt className="mt-1 text-muted-foreground">Phone on file</dt><dd>{row.landlord.phone_on_file ?? '—'}</dd><dt className="mt-1 text-muted-foreground">Verified number</dt><dd>{row.landlord.verified_number ?? '—'}</dd></div>
      <div><dt className="text-muted-foreground">Amount due</dt><dd className="font-semibold">{formatUgx(row.amount_due)}</dd><dt className="mt-1 text-muted-foreground">Amount received</dt><dd>{formatUgx(row.amount_received)}</dd></div>
      <div><dt className="text-muted-foreground">Waiting time</dt><dd>{row.waiting_hours} hours</dd><dt className="mt-1 text-muted-foreground">Cover fee</dt><dd>{formatUgx(row.cover_fee)} · {row.cover_fee_status}</dd></div>
    </dl>
    <div className="flex flex-wrap gap-2">{row.flags.map((flag) => <Badge variant="destructive" key={flag}>{DIRECT_PAY_FLAG_LABEL[flag]}</Badge>)}</div>
    <ul className="grid gap-4 sm:grid-cols-2">{row.proofs.map((proof) => <li key={proof.id} className="min-w-0 space-y-2 border-t border-border pt-3">
      {photos[proof.photo_path] ? <a href={photos[proof.photo_path]} target="_blank" rel="noopener noreferrer" aria-label="Open full SMS proof"><img src={photos[proof.photo_path]} alt="Payment SMS proof" className="h-64 w-full object-contain" loading="lazy" /></a> : <p className="text-sm text-muted-foreground">Proof photo unavailable</p>}
      <dl className="space-y-1 break-words text-xs"><div><dt className="inline text-muted-foreground">Provider: </dt><dd className="inline">{proof.provider ?? '—'}</dd></div><div><dt className="inline text-muted-foreground">Amount read / typed: </dt><dd className="inline">{proof.amount_read === null ? '—' : formatUgx(proof.amount_read)} / {proof.amount_typed === null ? '—' : formatUgx(proof.amount_typed)}</dd></div><div><dt className="inline text-muted-foreground">TID read / typed: </dt><dd className="inline">{proof.tid_read ?? '—'} / {proof.tid_typed ?? '—'}</dd></div><div><dt className="inline text-muted-foreground">Number read: </dt><dd className="inline">{proof.recipient_read ?? '—'}</dd></div><div><dt className="inline text-muted-foreground">Date read: </dt><dd className="inline">{proof.paid_at_read ?? '—'}</dd></div></dl>
    </li>)}</ul>
    {canAct && row.status === 'pending' && !receipt && <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap gap-2">{row.landlord.phone_on_file && <Button asChild variant="outline"><a href={`tel:${row.landlord.phone_on_file}`}><Phone className="mr-2 h-4 w-4" />Call landlord</a></Button>}<Button variant="outline" disabled={busy} onClick={async () => { try { const result = await send.mutateAsync(row.payment_id); setMessage(result.ok ? `Code sent to ${result.sent_to ?? '—'}, valid until ${result.expires_at ? new Date(result.expires_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'} (10 minutes)` : 'The SMS did not go through. Try again.'); } catch { failure(); } }}><Send className="mr-2 h-4 w-4" />Send OTP</Button></div>
      <form className="space-y-3" onSubmit={async (event) => { event.preventDefault(); try { const result = await approve.mutateAsync({ paymentId: row.payment_id, otp, callNote: note, flagReason: row.has_flags ? reason : null }); if (result.ok) { setReceipt({ number: result.receipt_number, code: result.receipt_code }); setMessage('Portfolio active, repayments start tomorrow'); } else setMessage(directPayDecisionMessage(result)); } catch { failure(); } }}>
        <Label className="block">Landlord's 6-digit code<Input value={otp} inputMode="numeric" maxLength={6} onChange={(e) => setOtp(e.target.value)} className="mt-1 max-w-60" /></Label>
        <Label className="block">Call note<Textarea value={note} onChange={(e) => setNote(e.target.value)} className="mt-1" /></Label>
        {row.has_flags && <Label className="block">Why is it safe to approve?<Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1" /></Label>}
        <div className="flex gap-2"><Button type="submit" disabled={busy}>Approve</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => setRejecting((value) => !value)}>Reject</Button></div>
      </form>
      {rejecting && <form className="space-y-2" onSubmit={async (event) => { event.preventDefault(); try { const result = await reject.mutateAsync({ paymentId: row.payment_id, reason: rejectReason }); setMessage(result.ok ? 'Payment rejected.' : directPayDecisionMessage(result)); if (result.ok) setRejecting(false); } catch { failure(); } }}><Label className="block">Reason for rejecting<Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className="mt-1" /></Label><Button variant="destructive" type="submit" disabled={busy}>Confirm rejection</Button></form>}
    </div>}
    {row.call_note && <p className="text-sm">Call note: {row.call_note}</p>}{row.flag_reason && <p className="text-sm">Approval reason: {row.flag_reason}</p>}{row.reject_note && <p className="text-sm">Rejection reason: {row.reject_note}</p>}
    {message && <p role="status" className="text-sm text-primary">{message}</p>}
    {receipt && (receipt.code ? <Button asChild variant="outline"><a href={welileReceiptUrl(receipt.code)} target="_blank" rel="noopener noreferrer">{receipt.number ?? 'WLR receipt'}</a></Button> : <p className="font-semibold">{receipt.number}</p>)}
  </li>;
}

export function DirectPayOpsQueue({ readOnly = false }: { readOnly?: boolean }) {
  const [view, setView] = useState<DirectPayQueueView>('pending');
  const queue = useDirectPayQueue(view);
  const paths = useMemo(() => [...new Set(queue.data?.pages.flatMap((page) => page.rows.flatMap((row) => row.proofs.map((proof) => proof.photo_path))) ?? [])], [queue.data]);
  const photos = useDirectPayProofPhotos(paths);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !queue.hasNextPage || queue.isFetchingNextPage || queue.isError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void queue.fetchNextPage(); }, { rootMargin: '200px' });
    observer.observe(element); return () => observer.disconnect();
  }, [queue.hasNextPage, queue.isFetchingNextPage, queue.fetchNextPage, queue.isError]);
  return <section className="space-y-4"><h1 className="text-xl font-semibold">Direct landlord payments</h1>
    <Tabs value={view} onValueChange={(value) => setView(value as DirectPayQueueView)}><TabsList><TabsTrigger value="pending">Pending</TabsTrigger><TabsTrigger value="decided">Decided</TabsTrigger></TabsList></Tabs>
    {queue.isLoading ? <p role="status">Loading payments…</p> : queue.isError ? <DirectPayUnavailable retry={() => { void queue.refetch(); }} /> : <>
      {(readOnly || queue.data?.pages[0]?.can_act === false) && <Badge variant="outline">Read-only</Badge>}
      {photos.isError && <DirectPayUnavailable retry={() => { void photos.refetch(); }} />}
      <ul className="space-y-4">{queue.data?.pages.flatMap((page) => page.rows.map((row) => <OpsPayment key={row.payment_id} row={row} canAct={!readOnly && page.can_act} photos={photos.data ?? {}} />))}</ul>
      {queue.data?.pages.every((page) => page.rows.length === 0) && <p className="text-sm text-muted-foreground">No {view} direct payments.</p>}
    </>}
    <div ref={sentinel}>{queue.hasNextPage && <Button variant="outline" disabled={queue.isFetchingNextPage} onClick={() => { void queue.fetchNextPage(); }}>{queue.isFetchingNextPage ? 'Loading…' : 'Load more'}</Button>}</div>
  </section>;
}