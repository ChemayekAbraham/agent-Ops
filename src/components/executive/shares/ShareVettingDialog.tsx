import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SignaturePad } from '@/components/shared/SignaturePad';
import { renderAgreementPdfBase64 } from '@/components/partner/renderAgreementPdf';
import { Loader2, FileSignature, XCircle } from 'lucide-react';
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
  const today = fmtShareDate(new Date());

  useEffect(() => {
    setRepName(''); setRepPosition(''); setSig(undefined); setShowCancel(false); setCancelReason(''); setBalance(null);
    if (row?.status === 'submitted') {
      supabase.rpc('get_user_available_balance', { p_user_id: row.shareholder_id })
        .then(({ data }) => setBalance(Number(data ?? 0)));
    }
  }, [row?.id, row?.status, row?.shareholder_id]);

  const data: ShareAgreementData | null = useMemo(() => row && ({
    participantName: row.shareholder_name, participantSignature: row.shareholder_signature_data_url,
    participantDate: fmtShareDate(row.shareholder_signed_at),
    adminName: row.status === 'completed' ? row.company_rep_name : repName,
    adminPosition: row.status === 'completed' ? row.company_rep_position : repPosition,
    adminSignature: row.status === 'completed' ? null : sig,
    adminDate: row.status === 'completed' ? fmtShareDate(row.company_signed_at) : (sig ? today : ''),
    referenceId: row.reference_id, amount: Number(row.amount), shares: Number(row.shares),
    companyOwnershipPercent: Number(row.company_ownership_percent),
  }), [row, repName, repPosition, sig, today]);

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
            {balance !== null && <> • Wallet available: UGX {balance.toLocaleString('en-US')}</>}
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
                <div><Label>Signature</Label><SignaturePad onChange={(d: string) => setSig(d || undefined)} /></div>
                <p className="text-xs text-muted-foreground">Date: {today}. Approving debits the shareholder's wallet and emails the signed agreement (copy to partnership@welile.com).</p>
                {balance !== null && balance < Number(row.amount) && (
                  <p className="text-xs text-destructive">Wallet balance is too low — approval will be refused.</p>
                )}
                <Button className="w-full" disabled={!canApprove || busy} onClick={approve}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Approve & send agreement
                </Button>
              </>
            ) : (
              <p className="rounded-md bg-muted p-3 text-sm">
                {row.status === 'awaiting_signature' && 'Waiting for the shareholder to sign.'}
                {row.status === 'completed' && `Completed ${fmtShareDate(row.company_signed_at)} by ${row.company_rep_name ?? 'Partner Ops'}.`}
                {row.status === 'cancelled' && 'This request was cancelled.'}
              </p>
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
