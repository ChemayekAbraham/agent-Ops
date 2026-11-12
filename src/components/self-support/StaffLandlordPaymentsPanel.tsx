import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useResolveLandlordPayment, useStaffLandlordPayments } from '@/hooks/useSelfSupportDirect';
import {
  staffAttentionReason, staffResolveErrorMessage, staffResolveProblem,
  type StaffLandlordPayment, type StaffPaymentFilter, type StaffResolveOutcome,
} from '@/lib/selfSupportDirect';

const ugx = (n: number | null | undefined) => `UGX ${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;
const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function SettleDialog({ row, onClose }: { row: StaffLandlordPayment; onClose: () => void }) {
  const [outcome, setOutcome] = useState<StaffResolveOutcome>('refund');
  const [reason, setReason] = useState('');
  const resolve = useResolveLandlordPayment();
  const problem = staffResolveProblem(row, outcome, reason);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settle Rent Plan</DialogTitle>
          <DialogDescription>{row.tenant_name ?? 'Tenant'} · {ugx(row.amount)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2" role="radiogroup">
          {([['refund', 'Recall and refund the partner'], ['paid', 'Landlord was paid: activate']] as const).map(([v, label]) => (
            <label key={v} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm">
              <input type="radio" name="settle-outcome" checked={outcome === v} onChange={() => setOutcome(v)} />
              {label}
            </label>
          ))}
          <Textarea placeholder="Reason (at least 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!!problem || resolve.isPending}
            onClick={() => resolve.mutate({ paymentId: row.id, outcome, reason }, {
              onSuccess: () => { toast.success(outcome === 'refund' ? 'Recalled and partner refunded' : 'Portfolio activated'); onClose(); },
              onError: (err) => toast.error(staffResolveErrorMessage(err)),
            })}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Financial Ops: partner-funded Rent Plans held until the landlord is paid. */
export function StaffLandlordPaymentsPanel() {
  const [filter, setFilter] = useState<StaffPaymentFilter>('attention');
  const [settling, setSettling] = useState<StaffLandlordPayment | null>(null);
  const { data, isLoading, error } = useStaffLandlordPayments(filter);
  return (
    <section className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Partner-funded Rent Plans waiting for landlord</h3>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as StaffPaymentFilter)}>
          <TabsList>
            <TabsTrigger value="attention">Needs attention</TabsTrigger>
            <TabsTrigger value="queued">Waiting</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {error ? <p className="text-sm text-destructive">Only Financial Ops can see this</p>
        : isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
        : (data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Nothing here.</p>
        : (
          <ul className="space-y-2">
            {(data ?? []).map((row) => (
              <li key={row.id} className="space-y-1 rounded-xl border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{row.tenant_name ?? 'Tenant'} · {ugx(row.amount)}</span>
                  <div className="flex items-center gap-2">
                    {row.overdue ? <Badge variant="warning">Overdue</Badge> : null}
                    {row.payout_status ? <Badge variant="outline">{row.payout_status.replace(/_/g, ' ')}</Badge> : null}
                    {row.status === 'queued' ? <Button size="sm" onClick={() => setSettling(row)}>Settle</Button> : null}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Landlord: {row.landlord_name ?? '—'}{row.landlord_phone ? ` (${row.landlord_phone})` : ''} · Agent: {row.agent_name ?? '—'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Partners: {(row.partners ?? []).map((p) => `${p.name ?? 'Partner'} ${ugx(p.share)}`).join(', ') || '—'}
                </p>
                <p className="text-xs text-muted-foreground">Created {when(row.created_at)} · Due {when(row.expires_at)}</p>
                <p className="text-xs">{staffAttentionReason(row)}</p>
              </li>
            ))}
          </ul>
        )}
      {settling ? <SettleDialog row={settling} onClose={() => setSettling(null)} /> : null}
    </section>
  );
}
