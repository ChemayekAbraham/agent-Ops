import { useCallback, useEffect, useMemo, useState } from 'react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Loader2, Plus, Clock, CheckCircle2, XCircle, HelpCircle, Building2, Wallet,
} from 'lucide-react';

interface Requisition {
  id: string;
  requisition_code: string;
  title: string;
  amount: number;
  approved_amount: number | null;
  reason: string;
  category: string | null;
  needed_by: string | null;
  stage: string;
  current_approver_role: string | null;
  final_stage: string;
  rejection_reason: string | null;
  wallet_credit_status: string | null;
  credited_at: string | null;
  created_at: string;
}

interface ReqEvent {
  id: string;
  requisition_id: string;
  actor_name: string | null;
  action: string;
  stage: string | null;
  comment: string | null;
  created_at: string;
}

interface RouteInfo {
  department_id: string | null;
  department_name: string | null;
  first_stage: string;
  supervisor_role: string | null;
  final_stage: string;
}

const STAGE_LABEL: Record<string, string> = {
  supervisor: 'Department head',
  coo: 'COO',
  cfo: 'CFO',
  ceo: 'CEO',
  approved: 'Approved',
  rejected: 'Declined',
  returned: 'Needs your update',
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function StatusPill({ row }: { row: Requisition }) {
  if (row.stage === 'approved') {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Approved
      </Badge>
    );
  }
  if (row.stage === 'rejected') {
    return (
      <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-700">
        <XCircle className="mr-1 h-3 w-3" /> Declined
      </Badge>
    );
  }
  if (row.stage === 'returned') {
    return (
      <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700">
        <HelpCircle className="mr-1 h-3 w-3" /> Needs your update
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
      <Clock className="mr-1 h-3 w-3" /> With {STAGE_LABEL[row.stage] || row.stage}
    </Badge>
  );
}

const EMPTY_FORM = {
  title: '',
  amount: '',
  category: '',
  needed_by: '',
  reason: '',
};

const MyRequisitions = () => {
  const [rows, setRows] = useState<Requisition[]>([]);
  const [events, setEvents] = useState<Record<string, ReqEvent[]>>({});
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [resubmitId, setResubmitId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) { setLoading(false); return; }

    const [reqRes, routeRes] = await Promise.all([
      supabase
        .from('staff_requisitions')
        .select('*')
        .eq('requester_id', uid)
        .order('created_at', { ascending: false }),
      supabase.rpc('staff_requisition_route', { _user_id: uid }),
    ]);

    if (reqRes.error) {
      toast.error('Could not load your requisitions', { description: reqRes.error.message });
    } else {
      setRows((reqRes.data || []) as unknown as Requisition[]);
    }
    if (!routeRes.error && routeRes.data) {
      const r = Array.isArray(routeRes.data) ? routeRes.data[0] : routeRes.data;
      setRoute(r as unknown as RouteInfo);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void fetchRows(); }, [fetchRows]);

  useEffect(() => {
    const channel = supabase
      .channel('my-staff-requisitions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_requisitions' }, () => { void fetchRows(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchRows]);

  const loadEvents = useCallback(async (id: string) => {
    if (events[id]) return;
    const { data } = await supabase
      .from('staff_requisition_events')
      .select('*')
      .eq('requisition_id', id)
      .order('created_at', { ascending: true });
    setEvents((prev) => ({ ...prev, [id]: (data || []) as unknown as ReqEvent[] }));
  }, [events]);

  const routeLine = useMemo(() => {
    if (!route) return null;
    const stages = ['supervisor', 'coo', 'cfo', 'ceo'];
    const startIdx = Math.max(0, stages.indexOf(route.first_stage));
    const endIdx = route.final_stage === 'ceo' ? stages.indexOf('ceo') : stages.indexOf('cfo');
    const supervisorLabel = route.supervisor_role
      ? route.supervisor_role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : STAGE_LABEL.supervisor;
    const chain = stages
      .slice(startIdx, endIdx + 1)
      .map((s) => (s === 'supervisor' ? supervisorLabel : STAGE_LABEL[s] || s));
    return chain.join(' → ');
  }, [route]);


  const startNew = () => {
    setResubmitId(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  };

  const startResubmit = (row: Requisition) => {
    setResubmitId(row.id);
    setForm({
      title: row.title,
      amount: String(row.amount),
      category: row.category ?? '',
      needed_by: row.needed_by ?? '',
      reason: row.reason,
    });
    setOpen(true);
  };

  const submit = async () => {
    const amount = Number(form.amount);
    if (!form.title.trim()) return toast.error('Enter a short title');
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Enter a valid amount');
    if (form.reason.trim().length < 10) return toast.error('Explain the request in at least 10 characters');

    setSubmitting(true);
    const { error } = await invokeEdgeFunction('staff-requisition-submit', {
      body: {
        ...(resubmitId ? { requisition_id: resubmitId } : {}),
        title: form.title.trim(),
        amount,
        category: form.category.trim() || null,
        needed_by: form.needed_by || null,
        reason: form.reason.trim(),
      },
      errorTitle: 'Could not submit your requisition',
    });
    setSubmitting(false);
    if (!error) {
      toast.success(resubmitId ? 'Requisition resubmitted' : 'Requisition submitted for review');
      setOpen(false);
      setForm(EMPTY_FORM);
      setResubmitId(null);
      await fetchRows();
    }
  };

  return (
    <PersonalLayout title="Make a requisition">
      <div className="space-y-4">
        <Card className="rounded-2xl p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Building2 className="h-4 w-4 text-primary" />
                {route?.department_name || 'Your department'}
              </p>
              <p className="text-sm text-muted-foreground">
                {routeLine
                  ? `Your requests are reviewed in this order: ${routeLine}.`
                  : 'Your request is reviewed by your department head, then the COO, then the CFO.'}
              </p>
              <p className="text-xs text-muted-foreground">
                On final approval the amount is credited straight to your wallet.
              </p>
            </div>
            <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setResubmitId(null); }}>
              <DialogTrigger asChild>
                <Button onClick={startNew}>
                  <Plus className="mr-2 h-4 w-4" /> New requisition
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>{resubmitId ? 'Update and resubmit' : 'New requisition'}</DialogTitle>
                  <DialogDescription>
                    Approvers see your department budget alongside the request.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="req-title">What is it for</Label>
                    <Input
                      id="req-title"
                      value={form.title}
                      onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                      placeholder="Field data bundles for September"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="req-amount">Amount (UGX)</Label>
                      <Input
                        id="req-amount"
                        inputMode="numeric"
                        value={form.amount}
                        onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value.replace(/[^0-9.]/g, '') }))}
                        placeholder="250000"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="req-needed">Needed by (optional)</Label>
                      <Input
                        id="req-needed"
                        type="date"
                        value={form.needed_by}
                        onChange={(e) => setForm((f) => ({ ...f, needed_by: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="req-category">Category (optional)</Label>
                    <Input
                      id="req-category"
                      value={form.category}
                      onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                      placeholder="Operations, marketing, travel…"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="req-reason">Why do you need it</Label>
                    <Textarea
                      id="req-reason"
                      rows={4}
                      value={form.reason}
                      onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                      placeholder="Explain the need, what it covers and the expected outcome (min 10 characters)"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>Cancel</Button>
                  <Button onClick={() => void submit()} disabled={submitting}>
                    {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {resubmitId ? 'Resubmit' : 'Submit for review'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </Card>

        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your requisitions…
          </div>
        ) : rows.length === 0 ? (
          <Card className="rounded-2xl p-8 text-center text-sm text-muted-foreground">
            You have not raised a requisition yet.
          </Card>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <Card key={row.id} className="rounded-2xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{row.requisition_code}</span>
                      <StatusPill row={row} />
                    </div>
                    <p className="font-semibold">{row.title}</p>
                    <p className="text-xs text-muted-foreground">Raised {fmtDate(row.created_at)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold">{formatUGX(Number(row.approved_amount ?? row.amount))}</p>
                    {row.approved_amount != null && Number(row.approved_amount) !== Number(row.amount) && (
                      <p className="text-xs text-muted-foreground">Requested {formatUGX(Number(row.amount))}</p>
                    )}
                  </div>
                </div>

                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{row.reason}</p>

                {row.stage === 'approved' && (
                  <p className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-700">
                    <Wallet className="h-4 w-4" />
                    {row.wallet_credit_status === 'credited'
                      ? `Credited to your wallet ${fmtDate(row.credited_at)}`
                      : 'Approved — the wallet credit is being processed.'}
                  </p>
                )}

                {row.rejection_reason && (
                  <p className="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700">
                    {row.rejection_reason}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => void loadEvents(row.id)}>
                    View progress
                  </Button>
                  {row.stage === 'returned' && (
                    <Button size="sm" variant="outline" onClick={() => startResubmit(row)}>
                      Update and resubmit
                    </Button>
                  )}
                </div>

                {(events[row.id]?.length ?? 0) > 0 && (
                  <div className="mt-3 space-y-2 rounded-xl border p-3">
                    {events[row.id].map((e) => (
                      <div key={e.id} className="text-xs">
                        <span className="font-medium capitalize">{e.action.replace(/_/g, ' ')}</span>
                        {e.stage ? ` • ${STAGE_LABEL[e.stage] || e.stage}` : ''} • {e.actor_name || 'System'} • {fmtDate(e.created_at)}
                        {e.comment && <p className="text-muted-foreground">{e.comment}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </PersonalLayout>
  );
};

export default MyRequisitions;
