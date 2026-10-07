import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { fetchPromissoryApprovalPreview, approvalPreviewFingerprint, type PromissoryApprovalPreview } from '@/hooks/usePromissoryApprovalPreview';
import { reconcilePromissoryPendingCount } from './promissoryPendingCount';

export function PromissoryApprovePay({ ids, onCompleted }: { ids: string[]; onCompleted: (ids: string[]) => void }) {
  const client = useQueryClient();
  const busyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<PromissoryApprovalPreview[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const eligible = rows.filter(row => row.eligible);
  const total = eligible.reduce((sum, row) => sum + Number(row.payout_amount), 0);

  async function preview() {
    if (busyRef.current) return;
    busyRef.current = true;
    setOpen(true); setBusy(true); setRows([]); setReason(''); setError('');
    try { setRows(await fetchPromissoryApprovalPreview(ids)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load payout preview'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function confirm() {
    if (busyRef.current || reason.trim().length < 20 || eligible.length === 0) return;
    busyRef.current = true; setBusy(true); setError('');
    const completed: string[] = [];
    let paid = 0;
    try {
      const fresh = await fetchPromissoryApprovalPreview(rows.map(row => row.note_id));
      if (approvalPreviewFingerprint(fresh) !== approvalPreviewFingerprint(rows)) {
        setRows(fresh); setError('Payout details changed. Review the updated preview and confirm again.'); return;
      }
      for (const row of fresh.filter(item => item.eligible)) {
        const { data, error: rpcError } = await supabase.rpc('approve_promissory_note', { p_note_id: row.note_id, p_reason: reason.trim() });
        if (rpcError) throw rpcError;
        const result = data as { status?: string; message?: string; amount?: number };
        if (result?.status !== 'approved' && result?.status !== 'already_approved') throw new Error(result?.message || 'Approval could not be confirmed');
        completed.push(row.note_id);
        if (result.status === 'approved') paid += Number(result.amount ?? 0);
      }
      toast.success(`Approved ${completed.length} note(s) — ${formatUGX(paid)} credited to proxy agent wallets.`);
      setOpen(false);
    } catch (err) {
      setError(`${completed.length} note(s) completed before processing stopped. ${err instanceof Error ? err.message : 'Could not complete approval'}`);
      try { setRows(await fetchPromissoryApprovalPreview(rows.map(row => row.note_id))); }
      catch { setRows([]); }
    } finally {
      onCompleted(completed);
      client.invalidateQueries({ queryKey: ['promissory-ops-report'] });
      reconcilePromissoryPendingCount(client);
      busyRef.current = false; setBusy(false);
    }
  }

  return <>
    <Button size="sm" className="h-7 px-2 text-[11px] ml-auto" onClick={() => { void preview(); }} disabled={busy || ids.length > 100}>
      <BadgeCheck className="h-3.5 w-3.5 mr-1" /> Approve &amp; Pay {ids.length}
    </Button>
    <AlertDialog open={open} onOpenChange={value => { if (!busyRef.current) setOpen(value); }}>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Approve &amp; Pay — payout preview</AlertDialogTitle>
          <AlertDialogDescription>Verification rewards will be credited to proxy agent wallets, not sent to their phones. No payment is made until you confirm.</AlertDialogDescription>
        </AlertDialogHeader>
        {busy && <p className="text-sm text-muted-foreground" role="status">Checking payout details…</p>}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <div className="divide-y rounded-md border">
          {rows.map(row => <div key={row.note_id} className="p-3 space-y-1">
            <div className="flex justify-between gap-3">
              <p className="text-sm font-semibold break-words">{row.agent_name || 'No proxy agent linked'}</p>
              <p className="text-sm font-semibold shrink-0">{formatUGX(row.eligible ? Number(row.payout_amount) : 0)}</p>
            </div>
            <p className="text-xs text-muted-foreground">{row.agent_phone} · {row.partner_name || 'Missing note'}</p>
            {row.blocked_reason && <p className="text-xs text-destructive">Skipped: {row.blocked_reason}</p>}
            {row.eligible && row.pso_bonus_excluded && <p className="text-xs text-muted-foreground">Platform Sales Officer — no verification reward.</p>}
            {Number(row.attached_plans) > 0 && <p className="text-xs text-warning">Also commits {formatUGX(Number(row.attached_amount))} from the partner wallet to {row.attached_plans} attached Rent Plan(s).</p>}
          </div>)}
        </div>
        <div className="flex justify-between gap-3 text-sm font-semibold"><span>Total proxy agent payout</span><span>{formatUGX(total)}</span></div>
        <div className="space-y-2">
          <Label htmlFor="selected-payment-reason">Reason for approval (min 20 characters)</Label>
          <Textarea id="selected-payment-reason" value={reason} onChange={event => setReason(event.target.value)} disabled={busy} rows={3} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button onClick={() => { void confirm(); }} disabled={busy || reason.trim().length < 20 || eligible.length === 0}>
            <BadgeCheck className="h-4 w-4 mr-2" />{busy ? 'Checking…' : 'Confirm approval & pay'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}