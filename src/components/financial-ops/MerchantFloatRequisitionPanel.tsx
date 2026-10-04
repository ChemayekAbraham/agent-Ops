import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Loader2, Plus, CheckCircle2, XCircle, Clock, HelpCircle, HandCoins, Send } from 'lucide-react';

type Status = 'pending' | 'approved' | 'rejected' | 'more_info';

interface Requisition {
  id: string;
  requisition_code: string;
  title: string;
  requested_amount: number;
  reason: string;
  coverage_notes: string | null;
  status: Status;
  requester_name: string | null;
  requester_role: string | null;
  approver_name: string | null;
  cfo_comment: string | null;
  decided_at: string | null;
  created_at: string;
}

const STATUS_META: Record<Status, { label: string; icon: typeof Clock; className: string }> = {
  pending: { label: 'Awaiting CFO', icon: Clock, className: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  approved: { label: 'Approved by CFO', icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' },
  rejected: { label: 'Declined', icon: XCircle, className: 'bg-red-500/10 text-red-700 border-red-500/30' },
  more_info: { label: 'More info requested', icon: HelpCircle, className: 'bg-blue-500/10 text-blue-700 border-blue-500/30' },
};

const DECIDER_ROLES = ['cfo', 'ceo', 'manager', 'super_admin'];

function fmt(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Merchant Float Requisition — raised by Financial Ops and sent to the CFO.
 * Financial Ops states how much merchant float is needed and why; the CFO
 * approves, declines or asks for more information. Funding itself still
 * happens through the Merchant Float Requests panel.
 */
export function MerchantFloatRequisitionPanel({ mode = 'finops' }: { mode?: 'finops' | 'cfo' }) {
  const { user, roles } = useAuth();
  const canDecide = useMemo(() => roles.some((r) => DECIDER_ROLES.includes(r)), [roles]);

  const [rows, setRows] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    title: 'Merchant Float Top-up Requisition',
    amount: '',
    reason: '',
    coverage: '',
  });

  const [actionReq, setActionReq] = useState<Requisition | null>(null);
  const [actionType, setActionType] = useState<'approved' | 'rejected' | 'more_info'>('approved');
  const [comment, setComment] = useState('');
  const [acting, setActing] = useState(false);

  const fetchData = useCallback(async () => {
    const { data, error } = await supabase
      .from('merchant_float_requisitions')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) toast.error('Could not load requisitions', { description: error.message });
    else setRows((data || []) as unknown as Requisition[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Polled every 60s (+ on focus). The old Realtime listener was on merchant_float_requisitions, which
  // is not in the publication, so it never fired (doc 147).
  const { lastUpdatedAt, refresh } = usePolling(() => fetchData(), 60_000);

  const submit = async () => {
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Enter a valid amount');
    if (form.reason.trim().length < 10) return toast.error('Give a reason of at least 10 characters');
    setSubmitting(true);
    const { error } = await supabase.from('merchant_float_requisitions').insert({
      title: form.title.trim() || 'Merchant Float Top-up Requisition',
      requested_amount: amount,
      reason: form.reason.trim(),
      coverage_notes: form.coverage.trim() || null,
      requested_by: user?.id,
      requester_name: (user?.user_metadata as { full_name?: string } | undefined)?.full_name || user?.email || null,
      requester_role: 'financial_ops',
    });
    setSubmitting(false);
    if (error) return toast.error('Could not send requisition', { description: error.message });
    toast.success('Requisition sent to the CFO');
    setCreateOpen(false);
    setForm({ title: 'Merchant Float Top-up Requisition', amount: '', reason: '', coverage: '' });
    fetchData();
  };

  const decide = async () => {
    if (!actionReq) return;
    if (actionType !== 'approved' && comment.trim().length < 10) {
      return toast.error('Give a comment of at least 10 characters');
    }
    setActing(true);
    const { error } = await supabase
      .from('merchant_float_requisitions')
      .update({
        status: actionType,
        cfo_comment: comment.trim() || null,
        decided_by: user?.id,
        approver_name: (user?.user_metadata as { full_name?: string } | undefined)?.full_name || user?.email || null,
        decided_at: new Date().toISOString(),
      })
      .eq('id', actionReq.id);
    setActing(false);
    if (error) return toast.error('Could not save decision', { description: error.message });
    toast.success('Decision recorded');
    setActionReq(null);
    setComment('');
    fetchData();
  };

  const pendingTotal = rows.filter(r => r.status === 'pending').reduce((s, r) => s + Number(r.requested_amount || 0), 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <HandCoins className="h-4 w-4" />
            Merchant Float Requisitions
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === 'cfo'
              ? 'Requisitions raised by Financial Ops for merchant float funding. Approve, decline or ask for more information.'
              : 'Raise a funding requisition for the merchant network and send it to the CFO.'}
          </p>
          {pendingTotal > 0 && (
            <p className="mt-1 text-xs font-medium">Awaiting CFO: {formatUGX(pendingTotal)}</p>
          )}
        </div>
        {mode === 'finops' && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> New requisition
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No requisitions yet.</p>
        ) : (
          rows.map((r) => {
            const meta = STATUS_META[r.status] || STATUS_META.pending;
            const Icon = meta.icon;
            return (
              <div key={r.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.requisition_code} · {formatUGX(Number(r.requested_amount))} · {fmt(r.created_at)}
                    </p>
                  </div>
                  <Badge variant="outline" className={meta.className}>
                    <Icon className="mr-1 h-3 w-3" /> {meta.label}
                  </Badge>
                </div>
                <p className="mt-2 text-xs">{r.reason}</p>
                {r.coverage_notes && (
                  <p className="mt-1 text-xs text-muted-foreground">Coverage: {r.coverage_notes}</p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Raised by {r.requester_name || '—'}
                  {r.decided_at ? ` · Decided by ${r.approver_name || '—'} on ${fmt(r.decided_at)}` : ''}
                </p>
                {r.cfo_comment && (
                  <p className="mt-1 text-xs italic text-muted-foreground">CFO: {r.cfo_comment}</p>
                )}
                {canDecide && r.status !== 'approved' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => { setActionReq(r); setActionType('approved'); setComment(''); }}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setActionReq(r); setActionType('more_info'); setComment(''); }}>
                      Request info
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => { setActionReq(r); setActionType('rejected'); setComment(''); }}>
                      Decline
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New merchant float requisition</DialogTitle>
            <DialogDescription>This is sent straight to the CFO for a funding decision.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Title</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <Label>Amount requested (UGX)</Label>
              <Input
                type="number"
                inputMode="numeric"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="8000000"
              />
            </div>
            <div>
              <Label>Reason</Label>
              <Textarea
                rows={3}
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Why the merchant network needs this float now"
              />
            </div>
            <div>
              <Label>Merchants / coverage notes (optional)</Label>
              <Textarea
                rows={2}
                value={form.coverage}
                onChange={(e) => setForm({ ...form, coverage: e.target.value })}
                placeholder="Which merchants and channels this covers"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send to CFO
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!actionReq} onOpenChange={(o) => { if (!o) setActionReq(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionType === 'approved' ? 'Approve requisition' : actionType === 'rejected' ? 'Decline requisition' : 'Request more information'}
            </DialogTitle>
            <DialogDescription>
              {actionReq ? `${actionReq.requisition_code} · ${formatUGX(Number(actionReq.requested_amount))}` : ''}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={actionType === 'approved' ? 'Optional note' : 'Explain your decision (min 10 characters)'}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionReq(null)}>Cancel</Button>
            <Button onClick={decide} disabled={acting}>
              {acting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}