import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { Banknote, Copy, CheckCircle2, XCircle, Phone, User, Loader2 } from 'lucide-react';
import { LandlordPayoutShareCard, type LandlordPayoutShareData } from './LandlordPayoutShareCard';
import { LandlordPaymentCompletedDialog, type LandlordPaymentCompletion } from './LandlordPaymentCompletedDialog';
import { ReceiptNumberLookupPanel } from './ReceiptNumberLookupPanel';

type Payout = {
  id: string;
  agent_id: string;
  tenant_id: string | null;
  rent_request_id: string | null;
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string;
  mobile_money_provider: string;
  amount: number;
  status: string;
  created_at: string;
  agent_profile?: { full_name: string | null; phone: string | null } | null;
  tenant_profile?: { full_name: string | null } | null;
};

function formatUGX(n: number) {
  return `UGX ${Number(n).toLocaleString()}`;
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error('Copy failed');
  }
}

export function LandlordPayoutsQueue() {
  const qc = useQueryClient();
  const [disburse, setDisburse] = useState<Payout | null>(null);
  const [reject, setReject] = useState<Payout | null>(null);
  const [momoRef, setMomoRef] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [shareData, setShareData] = useState<LandlordPayoutShareData | null>(null);
  const [completionState, setCompletion] = useState<LandlordPaymentCompletion | null>(null);

  const { data: payouts, isLoading } = useQuery({
    queryKey: ['finops-landlord-payouts-queue'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('landlord_payouts')
        .select('id, agent_id, tenant_id, rent_request_id, landlord_id, landlord_name, landlord_phone, mobile_money_provider, amount, status, created_at')
        .eq('status', 'pending_finops_disbursement')
        .order('created_at', { ascending: true })
        .limit(100);
      if (error) throw error;
      const rows = (data ?? []) as Payout[];
      // hydrate agent + tenant names
      const agentIds = Array.from(new Set(rows.map(r => r.agent_id)));
      const tenantIds = Array.from(new Set(rows.map(r => r.tenant_id).filter(Boolean) as string[]));
      const ids = Array.from(new Set([...agentIds, ...tenantIds]));
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        const map = new Map((profs ?? []).map(p => [p.id, p]));
        rows.forEach(r => {
          r.agent_profile = (map.get(r.agent_id) as any) ?? null;
          if (r.tenant_id) r.tenant_profile = (map.get(r.tenant_id) as any) ?? null;
        });
      }
      return rows;
    },
    refetchInterval: 60_000,
  });

  const closeAll = () => {
    setDisburse(null);
    setReject(null);
    setMomoRef('');
    setNotes('');
    setReason('');
    setSubmitting(false);
  };

  const handleMarkDisbursed = async () => {
    if (!disburse) return;
    if (momoRef.trim().length < 6) {
      toast.error('MoMo TID must be at least 6 characters');
      return;
    }
    setSubmitting(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('landlord_payouts')
        .update({
          status: 'awaiting_agent_receipt',
          finops_disbursed_by: u.user?.id ?? null,
          finops_disbursed_at: new Date().toISOString(),
          finops_momo_reference: momoRef.trim(),
          finops_notes: notes.trim() || null,
          external_reference: momoRef.trim(),
          disbursed_at: new Date().toISOString(),
        })
        .eq('id', disburse.id)
        .eq('status', 'pending_finops_disbursement');
      if (error) throw error;

      // Issue the permanent rent receipt and SMS the landlord the receipt link.
      // Idempotent server-side, so a double-tap cannot double-send.
      let completion: LandlordPaymentCompletion = {
        payoutId: disburse.id,
        amount: disburse.amount,
        landlordName: disburse.landlord_name,
        tenantName: disburse.tenant_profile?.full_name ?? null,
        landlordPhone: disburse.landlord_phone,
        receiptUrl: null,
        receiptNumber: null,
        smsSent: false,
      };
      try {
        const { data: rec, error: recErr } = await supabase.functions.invoke('landlord-rent-receipt', {
          body: { payout_id: disburse.id },
        });
        if (!recErr && rec) {
          completion = {
            ...completion,
            receiptUrl: (rec as any).receipt_url ?? null,
            receiptNumber: (rec as any).receipt_number ?? null,
            smsSent: (rec as any).sms_sent === true || !!(rec as any).sms_sent_at,
          };
        }
      } catch { /* non-blocking — SMS failure never reverses a paid payout */ }

      try {
        await supabase.from('notifications').insert({
          user_id: disburse.agent_id,
          type: 'landlord_payout_disbursed',
          title: 'Landlord paid — upload receipt',
          message: `Financial Ops sent ${formatUGX(disburse.amount)} to ${disburse.landlord_name}. Please upload the receipt now.`,
          metadata: { payout_id: disburse.id, momo_reference: momoRef.trim() },
        });
      } catch { /* non-blocking */ }


      toast.success('Marked as disbursed');
      qc.invalidateQueries({ queryKey: ['finops-landlord-payouts-queue'] });
      setCompletion(completion);
      // Open WhatsApp share card so FinOps can notify the agent immediately.
      setShareData({
        amount: disburse.amount,
        landlord_name: disburse.landlord_name,
        landlord_phone: disburse.landlord_phone,
        mobile_money_provider: disburse.mobile_money_provider,
        tenant_name: disburse.tenant_profile?.full_name ?? null,
        agent_name: disburse.agent_profile?.full_name ?? null,
        agent_phone: disburse.agent_profile?.phone ?? null,
        momo_reference: momoRef.trim(),
        paid_at: new Date().toISOString(),
      });
      closeAll();

    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to mark disbursed');
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!reject) return;
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setSubmitting(true);
    try {
      const { error: refundErr } = await supabase.rpc('refund_agent_float_for_payout', {
        p_payout_id: reject.id,
        p_reason: `FINOPS_REJECT: ${reason.trim()}`,
      });
      if (refundErr) throw refundErr;

      const { data: u } = await supabase.auth.getUser();
      await supabase
        .from('landlord_payouts')
        .update({
          status: 'failed',
          last_error: `Rejected by Financial Ops: ${reason.trim()}`,
          finops_disbursed_by: u.user?.id ?? null,
          finops_notes: reason.trim(),
        })
        .eq('id', reject.id);

      try {
        await supabase.from('notifications').insert({
          user_id: reject.agent_id,
          type: 'landlord_payout_rejected',
          title: 'Landlord payout rejected',
          message: `Financial Ops rejected your ${formatUGX(reject.amount)} payout to ${reject.landlord_name}. Float refunded. Reason: ${reason.trim()}`,
          metadata: { payout_id: reject.id },
        });
      } catch { /* non-blocking */ }

      // SMS the agent too — the in-app notification alone is easy to miss
      // when they're mid-round on the road, and the whole point of the float
      // refund is that they can withdraw again right away.
      try {
        await supabase.functions.invoke('notify-landlord-payout-rejected', {
          body: { payout_id: reject.id, reason: reason.trim() },
        });
      } catch { /* non-blocking — SMS failure never reverses the rejection/refund */ }

      toast.success('Rejected and refunded');
      qc.invalidateQueries({ queryKey: ['finops-landlord-payouts-queue'] });
      closeAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to reject');
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading queue…
      </div>
    );
  }

  if (!payouts?.length) {
    return (
      <div className="space-y-4">
        <ReceiptNumberLookupPanel />
        <Card className="p-8 text-center text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-500" />
          <p className="text-sm font-medium">No landlord payouts waiting for disbursement.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ReceiptNumberLookupPanel />

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold flex items-center gap-2">
          <Banknote className="h-4 w-4 text-orange-600" />
          Landlord Payouts — Approve with MoMo TID
          <Badge variant="secondary">{payouts.length}</Badge>
        </h3>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Agent has paid the landlord via MoMo (OTP-verified). Enter the MoMo TID to settle the withdrawal and release the agent's float ledger lock.
      </p>


      <div className="space-y-3">
        {payouts.map(p => (
          <Card key={p.id} className="p-4 border-orange-500/30 bg-orange-500/5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Pay landlord</p>
                <p className="text-lg font-bold truncate">{p.landlord_name}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-muted-foreground">Amount</p>
                <p className="text-xl font-bold text-orange-700 dark:text-orange-400">{formatUGX(p.amount)}</p>
              </div>
            </div>

            <div className="rounded-lg bg-background border p-3 space-y-2 mb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase text-muted-foreground">{p.mobile_money_provider}</p>
                    <p className="font-mono text-base font-semibold tracking-wide">{p.landlord_phone}</p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => copyText(p.landlord_phone, 'Phone')}>
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase text-muted-foreground">Recipient name (must match MoMo)</p>
                    <p className="font-semibold truncate">{p.landlord_name}</p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => copyText(p.landlord_name, 'Name')}>
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground mb-3">
              <div>
                <p className="text-[10px] uppercase">Agent</p>
                <p className="font-medium text-foreground truncate">{p.agent_profile?.full_name ?? '—'}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase">For tenant</p>
                <p className="font-medium text-foreground truncate">{p.tenant_profile?.full_name ?? 'Unallocated'}</p>
              </div>
              <div className="col-span-2">
                <p className="text-[10px] uppercase">Submitted</p>
                <p className="font-medium text-foreground">{formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}</p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => setDisburse(p)}>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Approve with TID
              </Button>
              <Button variant="outline" onClick={() => setReject(p)}>
                <XCircle className="h-4 w-4 mr-1" /> Reject & Refund
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/* Mark Disbursed Dialog */}
      <Dialog open={!!disburse} onOpenChange={open => !open && closeAll()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve landlord payout with MoMo TID</DialogTitle>
            <DialogDescription>
              The agent paid {disburse && formatUGX(disburse.amount)} to {disburse?.landlord_name} via {disburse?.mobile_money_provider}. Enter the MoMo Transaction ID (TID) from the agent's MoMo confirmation to settle this payout.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="momo-ref">MoMo Transaction ID (TID) *</Label>
              <Input
                id="momo-ref"
                value={momoRef}
                onChange={e => setMomoRef(e.target.value)}
                placeholder="e.g. CK230420.1542.A12345"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground mt-1">Minimum 6 characters. Must match the agent's MoMo confirmation.</p>
            </div>
            <div>
              <Label htmlFor="momo-notes">Notes (optional)</Label>
              <Textarea
                id="momo-notes"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                placeholder="Anything the agent should know"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAll} disabled={submitting}>Cancel</Button>
            <Button onClick={handleMarkDisbursed} disabled={submitting || momoRef.trim().length < 6}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Approve with TID'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={!!reject} onOpenChange={open => !open && closeAll()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject and refund payout</DialogTitle>
            <DialogDescription>
              The agent's float will be returned. Provide a clear reason (≥10 chars) so the agent can fix it.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="reject-reason">Reason *</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Wrong landlord MoMo number; agent should re-verify with landlord"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAll} disabled={submitting}>Cancel</Button>
            <Button variant="destructive" onClick={handleReject} disabled={submitting || reason.trim().length < 10}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reject & Refund'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Internal completion screen — receipt proof, link + SMS resend */}
      <LandlordPaymentCompletedDialog completion={completionState} onClose={() => setCompletion(null)} />

      {/* WhatsApp share card — opens after a successful TID approval */}
      <LandlordPayoutShareCard
        open={!!shareData}
        onOpenChange={(o) => !o && setShareData(null)}
        data={shareData}
      />
    </div>
  );
}