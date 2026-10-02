import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { Loader2 } from 'lucide-react';

type Row = {
  id: string; portfolio_code: string; partner_id: string; partner_name: string | null; partner_phone: string | null;
  partner_email: string | null; scope: string; redeemed_amount: number; old_principal: number; note: string | null;
  processed_by_name: string | null; created_at: string; payout_status: string; payout_decided_by_name: string | null;
  payout_decided_at: string | null; payout_reason: string | null;
};

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function RedemptionApprovalsPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'awaiting_cfo' | 'paid' | 'rejected'>('awaiting_cfo');
  const [action, setAction] = useState<{ row: Row; kind: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ['cfo-redemptions', tab],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_list_redemptions' as never, { p_status: tab } as never);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const submit = async () => {
    if (!action) return;
    setBusy(true);
    try {
      const fn = action.kind === 'approve' ? 'cfo_approve_redemption' : 'cfo_reject_redemption';
      const { error } = await supabase.rpc(fn as never, { p_id: action.row.id, p_reason: reason.trim() } as never);
      if (error) throw error;
      if (action.kind === 'approve' && action.row.partner_email) {
        const { error: mailErr } = await supabase.functions.invoke('send-transactional-email', {
          body: {
            templateName: 'redemption-paid',
            recipientEmail: action.row.partner_email,
            idempotencyKey: `redemption-paid-${action.row.id}`,
            templateData: {
              partner_name: action.row.partner_name ?? 'Partner',
              portfolio_id: action.row.portfolio_code,
              amount: action.row.redeemed_amount,
              paid_date: new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'long' }),
            },
          },
        });
        if (mailErr) toast.warning('Paid, but the email to the partner could not be sent.');
      }
      toast.success(action.kind === 'approve' ? 'Redemption paid to the partner wallet' : 'Redemption rejected');
      setAction(null); setReason('');
      qc.invalidateQueries({ queryKey: ['cfo-redemptions'] });
    } catch (e: any) {
      toast.error(e?.message ?? 'Action failed');
    } finally { setBusy(false); }
  };

  const rows = q.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Redemptions</CardTitle>
        <p className="text-sm text-muted-foreground">
          Closed portfolios waiting for payment. Approving credits the full principal to the partner's withdrawable wallet and emails them.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="awaiting_cfo">Awaiting approval</TabsTrigger>
            <TabsTrigger value="paid">Paid</TabsTrigger>
            <TabsTrigger value="rejected">Rejected</TabsTrigger>
          </TabsList>
        </Tabs>
        {q.isLoading ? <Loader2 className="h-5 w-5 animate-spin" />
          : q.error ? <p className="text-sm text-destructive">{(q.error as Error).message}</p>
          : rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing here.</p>
          : (
            <div className="space-y-3">
              {rows.map(r => (
                <div key={r.id} className="rounded-lg border p-4 flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 text-sm">
                    <div className="font-semibold">{r.partner_name ?? '—'} <span className="text-muted-foreground font-normal">{r.partner_phone}</span></div>
                    <div>Portfolio <span className="font-mono">{r.portfolio_code}</span> · {r.scope === 'full' ? 'Full' : 'Partial'} redemption</div>
                    <div className="text-muted-foreground">Closed {fmtDate(r.created_at)}{r.processed_by_name ? ` by ${r.processed_by_name}` : ''}</div>
                    {r.note && <div className="text-muted-foreground">Note: {r.note}</div>}
                    {r.payout_decided_at && (
                      <div className="text-muted-foreground">
                        {r.payout_status === 'paid' ? 'Paid' : 'Rejected'} {fmtDate(r.payout_decided_at)} by {r.payout_decided_by_name ?? '—'} — {r.payout_reason}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div className="text-lg font-bold">{formatUGX(r.redeemed_amount)}</div>
                    <Badge variant={r.payout_status === 'paid' ? 'default' : r.payout_status === 'rejected' ? 'destructive' : 'secondary'}>
                      {r.payout_status === 'awaiting_cfo' ? 'Awaiting CFO approval' : r.payout_status === 'paid' ? 'Paid' : 'Rejected'}
                    </Badge>
                    {r.payout_status === 'awaiting_cfo' && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => { setAction({ row: r, kind: 'reject' }); setReason(''); }}>Reject</Button>
                        <Button size="sm" onClick={() => { setAction({ row: r, kind: 'approve' }); setReason(''); }}>Approve & Pay</Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
      </CardContent>

      <Dialog open={!!action} onOpenChange={o => { if (!o && !busy) setAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action?.kind === 'approve' ? 'Approve & pay redemption' : 'Reject redemption'}</DialogTitle>
            <DialogDescription>
              {action?.kind === 'approve'
                ? `${formatUGX(action.row.redeemed_amount)} will be credited to ${action.row.partner_name ?? 'the partner'}'s withdrawable wallet and they will be emailed. This can only happen once.`
                : 'No money will move. The decision is recorded permanently.'}
            </DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Reason (at least 10 characters)" value={reason} onChange={e => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>Cancel</Button>
            <Button disabled={busy || reason.trim().length < 10} variant={action?.kind === 'reject' ? 'destructive' : 'default'} onClick={submit}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : action?.kind === 'approve' ? 'Confirm payment' : 'Confirm rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
