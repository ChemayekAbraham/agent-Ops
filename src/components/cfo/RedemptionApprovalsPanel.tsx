import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';

type Red = {
  id: string; created_at: string; old_principal: number; redeemed_amount: number; scope: string;
  partner_id: string; partner_name: string | null; partner_phone: string | null; partner_email: string | null;
  portfolio_code: string; payout_status: string; payout_reason: string | null; payout_decided_at: string | null;
  payout_decided_by_name: string | null; processed_by_name: string | null; note: string | null;
};

const TABS = [
  { id: 'awaiting_cfo', label: 'Awaiting approval' },
  { id: 'paid', label: 'Paid' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'legacy', label: 'Older (not payable here)' },
];

export function RedemptionApprovalsPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('awaiting_cfo');
  const [target, setTarget] = useState<{ r: Red; mode: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');

  const list = useQuery({
    queryKey: ['cfo-redemptions', tab],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_list_redemptions', { p_status: tab });
      if (error) throw error;
      return (data ?? []) as Red[];
    },
  });

  const act = useMutation({
    mutationFn: async () => {
      if (!target) return;
      const fn = target.mode === 'approve' ? 'cfo_approve_redemption' : 'cfo_reject_redemption';
      const { data, error } = await (supabase.rpc as any)(fn, { p_id: target.r.id, p_reason: reason.trim() });
      if (error) throw error;
      if (target.mode === 'approve') {
        const r = target.r;
        if (r.partner_email) {
          const { error: mailErr } = await supabase.functions.invoke('send-transactional-email', {
            body: {
              templateName: 'redemption-paid',
              recipientEmail: r.partner_email,
              idempotencyKey: `redemption-paid-${r.id}`,
              templateData: {
                partner_name: r.partner_name || 'Supporter',
                portfolio_code: r.portfolio_code,
                amount: r.redeemed_amount,
                paid_date: new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'long', year: 'numeric' }),
                currency: 'UGX',
              },
            },
          });
          if (mailErr) toast.warning('Paid, but the email could not be sent.');
        } else {
          toast.warning('Paid, but this Supporter has no email on file.');
        }
      }
      return data;
    },
    onSuccess: () => {
      toast.success(target?.mode === 'approve' ? 'Redemption paid to the Supporter wallet.' : 'Redemption rejected.');
      setTarget(null); setReason('');
      qc.invalidateQueries({ queryKey: ['cfo-redemptions'] });
    },
    onError: (e: any) => toast.error(e?.message?.replace(/_/g, ' ') || 'Could not complete this action.'),
  });

  const rows = list.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Redemptions</CardTitle>
        <div className="flex flex-wrap gap-2 pt-2">
          {TABS.map((t) => (
            <Button key={t.id} size="sm" variant={tab === t.id ? 'default' : 'outline'} onClick={() => setTab(t.id)}>{t.label}</Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {list.error && <p className="text-sm text-destructive">Could not load redemptions.</p>}
        {!list.isLoading && !list.error && rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing here.</p>}
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">{r.partner_name || 'Supporter'} <span className="text-muted-foreground text-xs">{r.partner_phone}</span></p>
              <p className="text-xs text-muted-foreground">
                {r.portfolio_code} · {r.scope === 'full' ? 'Full' : 'Partial'} redemption · {new Date(r.created_at).toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala' })}
                {r.processed_by_name ? ` · processed by ${r.processed_by_name}` : ''}
              </p>
              {r.payout_reason && <p className="text-xs text-muted-foreground">Reason: {r.payout_reason}</p>}
              {!r.partner_email && <p className="text-xs text-warning">No email on file.</p>}
            </div>
            <div className="flex items-center gap-3">
              <span className="font-semibold">{formatUGX(r.redeemed_amount)}</span>
              <Badge variant="outline">{r.payout_status === 'awaiting_cfo' ? 'Awaiting CFO approval' : r.payout_status}</Badge>
              {r.payout_status === 'awaiting_cfo' && (
                <>
                  <Button size="sm" onClick={() => { setReason(''); setTarget({ r, mode: 'approve' }); }}>Approve & pay</Button>
                  <Button size="sm" variant="outline" onClick={() => { setReason(''); setTarget({ r, mode: 'reject' }); }}>Reject</Button>
                </>
              )}
            </div>
          </div>
        ))}
      </CardContent>

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{target?.mode === 'approve' ? 'Approve and pay redemption' : 'Reject redemption'}</DialogTitle>
            <DialogDescription>
              {target && `${target.r.partner_name || 'Supporter'} · ${target.r.portfolio_code} · ${formatUGX(target.r.redeemed_amount)}`}
              {target?.mode === 'approve' && ' — the money goes to their withdrawable wallet and they are emailed.'}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (at least 10 characters)" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button>
            <Button disabled={reason.trim().length < 10 || act.isPending} onClick={() => act.mutate()}>
              {act.isPending ? 'Working…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
