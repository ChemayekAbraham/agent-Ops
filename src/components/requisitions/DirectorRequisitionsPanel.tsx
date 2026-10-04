import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { requisitionApprovalError } from '@/lib/requisitionApprovalError';
import {
  Loader2, Plus, CheckCircle2, XCircle, Clock, HelpCircle, FileText, Building2, Wallet, RefreshCw,
} from 'lucide-react';

type Status = 'pending' | 'approved' | 'rejected' | 'more_info';

interface Requisition {
  id: string;
  requisition_code: string;
  title: string;
  amount: number;
  reason: string;
  status: Status;
  requester_name: string | null;
  requester_role: string | null;
  approver_name: string | null;
  director_comment: string | null;
  decided_at: string | null;
  created_at: string;
  wallet_credit_status: string | null;
  wallet_transaction_id: string | null;
  credited_at: string | null;
  credited_by: string | null;
}

interface ReqEvent {
  id: string;
  requisition_id: string;
  actor_name: string | null;
  action: string;
  comment: string | null;
  created_at: string;
}

const DIRECTOR_ROLES = ['ceo', 'super_admin', 'manager'];

const SAMPLE = {
  title: 'Merchant Line Top-up Request',
  amount: '8000000',
  reason:
    'Kindly requesting UGX 8,000,000 to top up the merchant lines to ensure uninterrupted operations and maintain sufficient transaction liquidity.',
};

const STATUS_META: Record<Status, { label: string; icon: typeof Clock; className: string }> = {
  pending: { label: 'Pending', icon: Clock, className: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  approved: { label: 'Approved', icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' },
  rejected: { label: 'Rejected', icon: XCircle, className: 'bg-red-500/10 text-red-700 border-red-500/30' },
  more_info: { label: 'More Info Required', icon: HelpCircle, className: 'bg-blue-500/10 text-blue-700 border-blue-500/30' },
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

interface DirectorRequisitionsPanelProps {
  /** History mode: hides creation and decision actions. New requests live in the staff flow. */
  readOnly?: boolean;
}

export function DirectorRequisitionsPanel({ readOnly = false }: DirectorRequisitionsPanelProps = {}) {
  const { user, roles } = useAuth();
  const isDirector = roles.some((r) => DIRECTOR_ROLES.includes(r));

  const [rows, setRows] = useState<Requisition[]>([]);
  const [events, setEvents] = useState<Record<string, ReqEvent[]>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Status>('pending');

  // create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(SAMPLE);
  const [submitting, setSubmitting] = useState(false);

  // action dialog
  const [actionReq, setActionReq] = useState<Requisition | null>(null);
  const [actionType, setActionType] = useState<'approve' | 'reject' | 'request_info'>('approve');
  const [comment, setComment] = useState('');
  const [acting, setActing] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const retryCredit = async (requisitionId: string) => {
    setRetrying(requisitionId);
    const { data, error } = await invokeEdgeFunction('requisition-credit-retry', {
      body: {
        source_table: 'director_requisitions',
        requisition_id: requisitionId,
      },
    });
    setRetrying(null);
    const result = data as { message?: string; already_credited?: boolean } | null;
    if (error) {
      toast.error('Wallet credit failed', { description: error.message });
    } else {
      toast.success(result?.message || 'Wallet credited');
    }
    await fetchData();
  };

  const fetchData = useCallback(async () => {
    const { data, error } = await supabase
      .from('director_requisitions')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      toast.error('Could not load requisitions', { description: error.message });
    } else {
      setRows((data || []) as Requisition[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Realtime refresh
  useEffect(() => {
    const channel = supabase
      .channel('director-requisitions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'director_requisitions' }, () => fetchData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchData]);

  const loadEvents = useCallback(async (reqId: string) => {
    const { data } = await supabase
      .from('director_requisition_events')
      .select('*')
      .eq('requisition_id', reqId)
      .order('created_at', { ascending: true });
    setEvents((prev) => ({ ...prev, [reqId]: (data || []) as ReqEvent[] }));
  }, []);

  const counts = useMemo(() => ({
    pending: rows.filter((r) => r.status === 'pending').length,
    more_info: rows.filter((r) => r.status === 'more_info').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
  }), [rows]);

  const visible = rows.filter((r) => r.status === tab);

  const submitCreate = async () => {
    const amount = Number(form.amount);
    if (!form.title.trim()) return toast.error('Enter a title');
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Enter a valid amount');
    if (form.reason.trim().length < 10) return toast.error('Enter a reason (min 10 characters)');

    setSubmitting(true);
    const { error } = await invokeEdgeFunction('create-director-requisition', {
      body: { title: form.title.trim(), amount, reason: form.reason.trim() },
      errorTitle: 'Could not submit requisition',
    });
    setSubmitting(false);
    if (!error) {
      toast.success('Requisition submitted to the Director');
      setCreateOpen(false);
      setForm(SAMPLE);
      fetchData();
    }
  };

  const submitAction = async () => {
    if (!actionReq) return;
    if (comment.trim().length < 10) return toast.error('Add a comment (min 10 characters) for the audit trail');
    setActing(true);
    const { error } = await invokeEdgeFunction('director-requisition-action', {
      body: { requisition_id: actionReq.id, action: actionType, comment: comment.trim() },
      errorTitle: 'Action failed',
      silent: true,
    });
    setActing(false);
    if (error) {
      toast.error(actionType === 'approve' ? requisitionApprovalError(error.message) : error.message);
    } else {
      toast.success('Decision recorded and requester notified');
      setActionReq(null);
      setComment('');
      fetchData();
    }
  };

  const openAction = (req: Requisition, type: 'approve' | 'reject' | 'request_info') => {
    setActionReq(req);
    setActionType(type);
    setComment('');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" /> Director Requisitions
          </h2>
          <p className="text-sm text-muted-foreground">
            {readOnly
              ? 'Historical record of the retired Director requisition flow.'
              : 'Submit operational funding requests to the Director and track every decision.'}
          </p>
        </div>
        {!readOnly && (
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> New requisition</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>New requisition</DialogTitle>
              <DialogDescription>This is delivered to the Director by in-app alert, SMS and email.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label htmlFor="req-title">Title</Label>
                <Input id="req-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="req-amount">Amount requested (UGX)</Label>
                <Input id="req-amount" type="number" inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                {Number(form.amount) > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">{formatUGX(Number(form.amount))}</p>
                )}
              </div>
              <div>
                <Label htmlFor="req-reason">Reason</Label>
                <Textarea id="req-reason" rows={4} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>Cancel</Button>
              <Button onClick={submitCreate} disabled={submitting} className="gap-2">
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Submit to Director
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Status)}>
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="pending">Pending {counts.pending ? `(${counts.pending})` : ''}</TabsTrigger>
          <TabsTrigger value="more_info">More Info {counts.more_info ? `(${counts.more_info})` : ''}</TabsTrigger>
          <TabsTrigger value="approved">Approved {counts.approved ? `(${counts.approved})` : ''}</TabsTrigger>
          <TabsTrigger value="rejected">Rejected {counts.rejected ? `(${counts.rejected})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-4 space-y-3">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
          ) : visible.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
              No {STATUS_META[tab].label.toLowerCase()} requisitions.
            </div>
          ) : (
            visible.map((req) => {
              const meta = STATUS_META[req.status];
              const StatusIcon = meta.icon;
              const canAct = isDirector && (req.status === 'pending' || req.status === 'more_info');
              const evs = events[req.id];
              return (
                <Card key={req.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{req.requisition_code}</span>
                        <Badge variant="outline" className={meta.className}>
                          <StatusIcon className="h-3 w-3 mr-1" />{meta.label}
                        </Badge>
                      </div>
                      <h3 className="font-semibold mt-1">{req.title}</h3>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold">{formatUGX(Number(req.amount))}</div>
                      <div className="text-xs text-muted-foreground">{fmtDate(req.created_at)}</div>
                    </div>
                  </div>

                  <p className="text-sm text-muted-foreground mt-2">{req.reason}</p>

                  <div className="grid grid-cols-2 gap-2 mt-3 text-xs text-muted-foreground">
                    <div>Requester: <span className="text-foreground">{req.requester_name || '—'}{req.requester_role ? ` (${req.requester_role.toUpperCase()})` : ''}</span></div>
                    <div>Approver: <span className="text-foreground">{req.approver_name || '—'}</span></div>
                    {req.decided_at && <div>Decided: <span className="text-foreground">{fmtDate(req.decided_at)}</span></div>}
                  </div>

                  {req.status === 'approved' && (
                    <div className="mt-3 rounded-md border border-border bg-muted/40 p-2 text-xs space-y-1">
                      <div className="flex items-center gap-2 font-medium">
                        <Wallet className="h-3.5 w-3.5" />
                        Wallet credit:
                        <Badge
                          variant="outline"
                          className={
                            req.wallet_credit_status === 'credited'
                              ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30'
                              : req.wallet_credit_status === 'failed'
                                ? 'bg-red-500/10 text-red-700 border-red-500/30'
                                : 'bg-amber-500/10 text-amber-700 border-amber-500/30'
                          }
                        >
                          {req.wallet_credit_status === 'credited'
                            ? 'Credited'
                            : req.wallet_credit_status === 'failed'
                              ? 'Approved — wallet credit failed'
                              : 'Not credited'}
                        </Badge>
                      </div>
                      <div>Wallet transaction: <span className="font-mono text-foreground">{req.wallet_transaction_id || '—'}</span></div>
                      <div>Credited at: <span className="text-foreground">{req.credited_at ? fmtDate(req.credited_at) : '—'}</span></div>
                      <div>Credited by: <span className="text-foreground">{req.approver_name || '—'}</span></div>
                      {isDirector && req.wallet_credit_status !== 'credited' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 mt-1"
                          disabled={retrying === req.id}
                          onClick={() => retryCredit(req.id)}
                        >
                          {retrying === req.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                          Retry wallet credit
                        </Button>
                      )}
                    </div>
                  )}

                  {req.director_comment && (
                    <div className="mt-2 rounded-md bg-muted/50 p-2 text-sm">
                      <span className="font-medium">Director comment: </span>{req.director_comment}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    {canAct && !readOnly && (
                      <>
                        <Button size="sm" className="gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => openAction(req, 'approve')}>
                          <CheckCircle2 className="h-4 w-4" /> Approve
                        </Button>
                        <Button size="sm" variant="destructive" className="gap-1" onClick={() => openAction(req, 'reject')}>
                          <XCircle className="h-4 w-4" /> Reject
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1" onClick={() => openAction(req, 'request_info')}>
                          <HelpCircle className="h-4 w-4" /> Request info
                        </Button>
                      </>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => (evs ? setEvents((p) => { const n = { ...p }; delete n[req.id]; return n; }) : loadEvents(req.id))}>
                      {evs ? 'Hide audit trail' : 'View audit trail'}
                    </Button>
                  </div>

                  {evs && (
                    <div className="mt-3 border-l-2 border-border pl-3 space-y-2">
                      {evs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No events.</p>
                      ) : evs.map((e) => (
                        <div key={e.id} className="text-xs">
                          <span className="font-medium capitalize">{e.action.replace(/_/g, ' ')}</span>
                          {' · '}<span className="text-muted-foreground">{e.actor_name || 'System'}</span>
                          {' · '}<span className="text-muted-foreground">{fmtDate(e.created_at)}</span>
                          {e.comment && <div className="text-muted-foreground">{e.comment}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })
          )}
        </TabsContent>
      </Tabs>

      {/* Action dialog */}
      <Dialog open={!!actionReq} onOpenChange={(o) => !o && setActionReq(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionType === 'approve' ? 'Approve requisition' : actionType === 'reject' ? 'Reject requisition' : 'Request more information'}
            </DialogTitle>
            <DialogDescription>
              {actionReq?.requisition_code} — {actionReq?.title} · {actionReq ? formatUGX(Number(actionReq.amount)) : ''}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="action-comment">Comment (required, min 10 chars)</Label>
            <Textarea id="action-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Reason for this decision (added to the audit trail and sent to the requester)" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionReq(null)} disabled={acting}>Cancel</Button>
            <Button onClick={submitAction} disabled={acting} className="gap-2">
              {acting && <Loader2 className="h-4 w-4 animate-spin" />} Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default DirectorRequisitionsPanel;
