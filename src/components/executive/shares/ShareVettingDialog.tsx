import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import ShareSignatureInput, { typedSignatureDataUrl } from './ShareSignatureInput';
import { Checkbox } from '@/components/ui/checkbox';
import { renderAgreementPdfBase64 } from '@/components/partner/renderAgreementPdf';
import { Loader2, FileSignature, XCircle, UserPen } from 'lucide-react';
import ShareAgreementPreview from './ShareAgreementPreview';
import { buildShareAgreementHtml, fmtShareDate, type ShareAgreementData } from './shareAgreementTemplate';
import { invokeShareFn, useInvalidateShares, type ShareRequestRow } from './useShareOnboarding';

export default function ShareVettingDialog({ row, onClose }: { row: ShareRequestRow | null; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateShares();
  const [repName, setRepName] = useState('');
  const [repPosition, setRepPosition] = useState('');
  const [sig, setSig] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  // Partner Ops filling the shareholder's part on their behalf.
  const [showFill, setShowFill] = useState(false);
  const [holderName, setHolderName] = useState('');
  const [holderSig, setHolderSig] = useState<string | undefined>();
  const [noHolderSig, setNoHolderSig] = useState(false);
  const today = fmtShareDate(new Date());

  useEffect(() => {
    setRepName(''); setRepPosition(''); setSig(undefined); setShowCancel(false); setCancelReason(''); setBalance(null);
    setShowFill(false); setHolderName(row?.shareholder_full_name ?? ''); setHolderSig(undefined); setNoHolderSig(false);
    if (row?.status === 'submitted') {
      // Countersigning draws from the operational float, not withdrawable.
      supabase.from('wallets').select('float_balance').eq('user_id', row.shareholder_id).maybeSingle()
        .then(({ data }) => setBalance(Number(data?.float_balance ?? 0)));
    }
  }, [row?.id, row?.status, row?.shareholder_id]);

  const filling = showFill && row?.status === 'awaiting_signature';
  const typedSig = useMemo(() => (filling && noHolderSig && holderName.trim().length >= 3 ? typedSignatureDataUrl(holderName) : ''), [filling, noHolderSig, holderName]);
  const holderFinalSig = noHolderSig ? typedSig || undefined : holderSig;

  const data: ShareAgreementData | null = useMemo(() => row && ({
    participantName: filling ? holderName : row.shareholder_name,
    participantSignature: filling ? holderFinalSig ?? null : row.shareholder_signature_data_url,
    participantDate: filling ? (holderFinalSig ? today : '') : fmtShareDate(row.shareholder_signed_at),
    adminName: row.status === 'completed' ? row.company_rep_name : repName,
    adminPosition: row.status === 'completed' ? row.company_rep_position : repPosition,
    adminSignature: row.status === 'completed' ? null : sig,
    adminDate: row.status === 'completed' ? fmtShareDate(row.company_signed_at) : (sig ? today : ''),
    referenceId: row.reference_id, amount: Number(row.amount), shares: Number(row.shares),
    companyOwnershipPercent: Number(row.company_ownership_percent),
  }), [row, repName, repPosition, sig, today, filling, holderName, holderFinalSig]);

  if (!row || !data) return null;
  const canApprove = row.status === 'submitted' && repName.trim().length >= 3 && repPosition.trim().length >= 2 && !!sig;

  const approve = async () => {
    setBusy(true);
    try {
      const pdfBase64 = await renderAgreementPdfBase64(buildShareAgreementHtml(data), { format: 'a4' });
      const res = await invokeShareFn('finalize-share-onboarding', {
        action: 'approve', id: row.id, repName: repName.trim(), repPosition: repPosition.trim(), repSignature: sig, pdfBase64,
      });
      toast({ title: 'Shares completed', description: res.emailed ? 'Signed agreement emailed to the shareholder.' : 'Completed. No email on file.' });
      invalidate(); onClose();
    } catch (e: any) {
      toast({ title: 'Could not complete', description: e.message, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  const canSignForHolder = holderName.trim().length >= 3 && !!holderFinalSig;
  const signOnBehalf = async () => {
    setBusy(true);
    try {
      await invokeShareFn('finalize-share-onboarding', {
        action: 'sign_on_behalf', id: row.id, shareholderName: holderName.trim(),
        shareholderSignature: holderFinalSig, typedSignature: noHolderSig,
      });
      toast({ title: 'Shareholder part filled', description: 'The agreement is now ready for Partner Ops approval.' });
      invalidate(); onClose();
    } catch (e: any) {
      toast({ title: 'Could not save', description: e.message, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await invokeShareFn('finalize-share-onboarding', { action: 'cancel', id: row.id, reason: cancelReason.trim() });
      toast({ title: 'Request cancelled' }); invalidate(); onClose();
    } catch (e: any) {
      toast({ title: 'Could not cancel', description: e.message, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[94vh] w-[calc(100vw-1rem)] max-w-6xl overflow-y-auto p-3 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileSignature className="h-5 w-5" />{row.shareholder_full_name || 'Shareholder'} • {row.reference_id}</DialogTitle>
          <DialogDescription>
            UGX {Number(row.amount).toLocaleString('en-US')} • {Number(row.shares).toLocaleString('en-US', { maximumFractionDigits: 2 })} shares
            {balance !== null && <> • Operational float: UGX {balance.toLocaleString('en-US')}</>}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <ShareAgreementPreview data={data} />

          <div className="space-y-3">
            {row.status === 'submitted' ? (
              <>
                <p className="text-sm font-medium">Welile signatory</p>
                <div><Label>Full name</Label><Input value={repName} onChange={(e) => setRepName(e.target.value)} /></div>
                <div><Label>Position</Label><Input value={repPosition} onChange={(e) => setRepPosition(e.target.value)} placeholder="e.g. Partner Operations Manager" /></div>
                <div><Label>Signature</Label><ShareSignatureInput value={sig} onChange={setSig} /></div>
                <p className="text-xs text-muted-foreground">Date: {today}. Approving debits the shareholder's wallet and emails the signed agreement (copy to partnership@welile.com).</p>
                {balance !== null && balance < Number(row.amount) && (
                  <p className="text-xs text-destructive">Operational float is too low — approval will be refused.</p>
                )}
                <Button className="w-full" disabled={!canApprove || busy} onClick={approve}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Approve & send agreement
                </Button>
              </>
            ) : row.status === 'awaiting_signature' && showFill ? (
              <>
                <p className="text-sm font-medium">Fill in for the shareholder</p>
                <div><Label>Full legal name</Label><Input value={holderName} onChange={(e) => setHolderName(e.target.value)} /></div>
                {row.shareholder_phone && <div><Label>Phone</Label><Input value={row.shareholder_phone} readOnly /></div>}
                {row.shareholder_email && <div><Label>Email</Label><Input value={row.shareholder_email} readOnly /></div>}
                <div><Label>Date</Label><Input value={today} readOnly /></div>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={noHolderSig} onCheckedChange={(c) => setNoHolderSig(c === true)} className="mt-0.5" />
                  <span>No signature from the shareholder — use their name in lowercase italics</span>
                </label>
                {noHolderSig ? (
                  <div className="rounded-md border border-border bg-background p-2 text-center">
                    {typedSig ? <img src={typedSig} alt="Typed signature" className="mx-auto max-h-16" /> : <p className="text-xs text-muted-foreground">Enter the full name first.</p>}
                  </div>
                ) : (
                  <div><Label>Shareholder signature</Label><ShareSignatureInput value={holderSig} onChange={setHolderSig} /></div>
                )}
                <p className="text-xs text-muted-foreground">This records that Partner Ops filled the agreement for the shareholder. No money moves until approval.</p>
                <Button className="w-full" disabled={!canSignForHolder || busy} onClick={signOnBehalf}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save shareholder part
                </Button>
                <Button variant="ghost" className="w-full" onClick={() => setShowFill(false)}>Back</Button>
              </>
            ) : (
              <p className="rounded-md bg-muted p-3 text-sm">
                {row.status === 'awaiting_signature' && 'Waiting for the shareholder to sign.'}
                {row.status === 'completed' && `Completed ${fmtShareDate(row.company_signed_at)} by ${row.company_rep_name ?? 'Partner Ops'}.`}
                {row.status === 'cancelled' && 'This request was cancelled.'}
              </p>
            )}

            {row.status === 'awaiting_signature' && !showFill && (
              <Button className="w-full" onClick={() => setShowFill(true)}><UserPen className="mr-2 h-4 w-4" />Fill in for shareholder</Button>
            )}

            {['awaiting_signature', 'submitted'].includes(row.status) && (
              showCancel ? (
                <div className="space-y-2">
                  <Textarea placeholder="Reason (at least 10 characters)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                  <Button variant="destructive" className="w-full" disabled={cancelReason.trim().length < 10 || busy} onClick={cancel}>Confirm cancel</Button>
                </div>
              ) : (
                <Button variant="outline" className="w-full" onClick={() => setShowCancel(true)}><XCircle className="mr-2 h-4 w-4" />Cancel request</Button>
              )
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
