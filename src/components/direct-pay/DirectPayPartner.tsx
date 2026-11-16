import { useEffect, useState } from 'react';
import { Copy, Smartphone, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useDirectPayClaim, useDirectPayRefresh, useDirectPayRelease, useDirectPayUploadProof, useMyDirectPayments } from '@/hooks/useDirectPay';
import { DIRECT_PAY_SUPPORT_PHONE, directPayMessage, formatUgx, holdTimeLeft, isDirectPayView, type DirectPayClaimResult, type DirectPayStatus, type DirectPayView } from '@/lib/directPay';

const statusLabel: Record<DirectPayStatus, string> = {
  held: 'Waiting for your SMS', pending: 'With Landlord Ops', confirmed: 'Active: Rent Profit Share started',
  rejected: 'Not confirmed by the landlord', expired: 'Hold ended',
};

export function DirectPayUnavailable({ retry }: { retry?: () => void }) {
  return <div role="alert" className="space-y-2 text-sm text-muted-foreground">
    <p>{directPayMessage({ ok: false, code: 'not_available' })}</p>
    <a href={`tel:${DIRECT_PAY_SUPPORT_PHONE}`} className="text-primary underline">{DIRECT_PAY_SUPPORT_PHONE}</a>
    {retry && <Button variant="outline" size="sm" onClick={retry}>Try again</Button>}
  </div>;
}

export function DirectPayHeldPlan({ payment }: { payment: DirectPayView }) {
  const [current, setCurrent] = useState(payment);
  const [message, setMessage] = useState<string | null>(directPayMessage(payment));
  const [askAmount, setAskAmount] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [tid, setTid] = useState('');
  const [amount, setAmount] = useState('');
  const [provider, setProvider] = useState<'mtn' | 'airtel'>('mtn');
  const [now, setNow] = useState(Date.now);
  const [copied, setCopied] = useState(false);
  const upload = useDirectPayUploadProof();
  const release = useDirectPayRelease();
  const refresh = useDirectPayRefresh();
  useEffect(() => { setCurrent(payment); }, [payment]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const showResult = (result: DirectPayClaimResult) => {
    if (isDirectPayView(result)) setCurrent(result);
    if (result.code === 'amount_missing') setAskAmount(true);
    setMessage(directPayMessage(result) ?? (isDirectPayView(result) && result.status === 'pending' ? 'We got your proof. Our team will call the landlord to confirm.' : null));
  };
  const fail = () => setMessage(directPayMessage({ ok: false, code: 'not_available' }));
  const busy = upload.isPending || release.isPending || refresh.isPending;
  return <article className="space-y-4 rounded-lg border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">{current.tenant_first_name}'s Rent Plan</h3>
      <Badge variant={current.status === 'confirmed' ? 'success' : current.status === 'rejected' ? 'destructive' : 'secondary'}>{statusLabel[current.status]}</Badge>
    </div>
    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">Landlord</dt><dd className="font-medium">{current.landlord_name}</dd></div>
      {current.landlord_number && <div><dt className="text-muted-foreground">Verified number</dt><dd className="flex items-center gap-2 font-medium">{current.landlord_number}<Button variant="ghost" size="icon" aria-label="Copy verified landlord number" title="Copy verified landlord number" onClick={async () => { try { await navigator.clipboard.writeText(current.landlord_number ?? ''); setCopied(true); } catch { fail(); } }}><Copy className="h-4 w-4" /></Button>{copied && <span role="status" className="text-xs text-success">Copied</span>}</dd></div>}
      <div><dt className="text-muted-foreground">Amount to send</dt><dd className="text-lg font-semibold">{formatUgx(current.amount_due)}</dd></div>
      <div><dt className="text-muted-foreground">Cover fee held</dt><dd className="font-medium">{formatUgx(current.cover_fee)}</dd></div>
    </dl>
    {current.status === 'held' && <>
      <p className="text-sm font-medium text-primary" role="timer">{holdTimeLeft(current.hold_expires_at, now).label}</p>
      <p className="text-sm text-muted-foreground">Only {formatUgx(current.amount_due)} counts. Anything extra stays between you and the landlord.</p>
      <form className="space-y-3" onSubmit={async (event) => { event.preventDefault(); if (!photo) { setMessage(directPayMessage({ ok: false, code: 'invalid_photo' })); return; } try { showResult(await upload.mutateAsync({ paymentId: current.payment_id, rentRequestId: current.rent_request_id, photo, tidTyped: tid || null, provider, amountTyped: askAmount && amount ? Number(amount) : null })); } catch { fail(); } }}>
        <Label className="block">SMS photo<Input type="file" accept="image/*" className="mt-1" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} /></Label>
        <Label className="block">Transaction ID (optional)<Input value={tid} onChange={(e) => setTid(e.target.value)} className="mt-1" /></Label>
        <fieldset><legend className="mb-1 text-sm font-medium">Mobile money provider</legend><div className="flex gap-2">{(['mtn', 'airtel'] as const).map((value) => <Button key={value} type="button" variant={provider === value ? 'default' : 'outline'} aria-pressed={provider === value} onClick={() => setProvider(value)}>{value === 'mtn' ? 'MTN' : 'Airtel'}</Button>)}</div></fieldset>
        {askAmount && <Label className="block">Amount<Input type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" /></Label>}
        <Button type="submit" disabled={busy} className="w-full"><Upload className="mr-2 h-4 w-4" />{upload.isPending ? 'Uploading…' : 'Upload SMS'}</Button>
      </form>
      {current.proofs.length === 0 && <Button variant="outline" disabled={busy} onClick={async () => { try { showResult(await release.mutateAsync(current.payment_id)); } catch { fail(); } }}>Let go of this plan</Button>}
    </>}
    {current.status === 'pending' && <p className="text-sm text-muted-foreground">We got your proof. Our team will call the landlord to confirm.</p>}
    {current.proofs.length > 0 && <ul className="space-y-2 border-t border-border pt-3">{current.proofs.map((proof) => <li key={proof.id} className="flex flex-wrap justify-between gap-2 text-sm"><span>{proof.amount === null ? 'Amount not read' : formatUgx(proof.amount)}</span><span>Transaction ID: {proof.tid_last4 ? `…${proof.tid_last4}` : 'Not read'}</span></li>)}</ul>}
    {message && <p role="alert" className="text-sm text-primary">{message}</p>}
    {current.code === 'float_short' && <Button variant="outline" disabled={busy} onClick={async () => { try { showResult(await refresh.mutateAsync(current.payment_id)); } catch { fail(); } }}>I topped up my float</Button>}
  </article>;
}

export function DirectPayStartButton({ rentRequestId }: { rentRequestId: string }) {
  const claim = useDirectPayClaim();
  const [payment, setPayment] = useState<DirectPayView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return <>
    <Button variant="outline" className="mt-2 h-auto min-h-11 w-full whitespace-normal border-primary text-primary" disabled={claim.isPending} onClick={async () => {
      setMessage(null);
      try { const result = await claim.mutateAsync(rentRequestId); if (isDirectPayView(result)) setPayment(result); else setMessage(directPayMessage(result)); }
      catch { setMessage(directPayMessage({ ok: false, code: 'not_available' })); }
    }}><Smartphone className="mr-2 h-4 w-4 shrink-0" />{claim.isPending ? 'Holding Rent Plan…' : "I'll pay the landlord myself"}</Button>
    {message && <p role="alert" className="mt-2 text-sm text-primary">{message}</p>}
    <Dialog open={!!payment} onOpenChange={(open) => { if (!open) setPayment(null); }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Pay the landlord directly</DialogTitle><DialogDescription>Rent Plan</DialogDescription></DialogHeader>{payment && <DirectPayHeldPlan payment={payment} />}</DialogContent></Dialog>
  </>;
}

export function DirectPayPartnerPayments() {
  const query = useMyDirectPayments();
  if (query.isLoading) return <p className="text-sm text-muted-foreground" role="status">Loading direct payments…</p>;
  if (query.isError) return <DirectPayUnavailable retry={() => { void query.refetch(); }} />;
  if (!query.data?.length) return null;
  return <section className="space-y-3" aria-label="Your direct landlord payments"><h2 className="text-lg font-semibold">Your direct landlord payments</h2>{query.data.map((payment) => <DirectPayHeldPlan key={payment.payment_id} payment={payment} />)}</section>;
}