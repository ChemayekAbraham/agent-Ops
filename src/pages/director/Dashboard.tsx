import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { requisitionApprovalError } from '@/lib/requisitionApprovalError';
import {
  Loader2, CheckCircle2, XCircle, Clock, HelpCircle, FileText, Building2,
  ArrowLeft, ChevronRight, ShieldCheck, User, Calendar,
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

export default function DirectorDashboardPage() {
  const navigate = useNavigate();
  const { roles } = useAuth();
  const isDirector = roles.some((r) => DIRECTOR_ROLES.includes(r));

  const [rows, setRows] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Status>('pending');

  // detail view
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailEvents, setDetailEvents] = useState<ReqEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // action dialog
  const [actionType, setActionType] = useState<'approve' | 'reject' | 'request_info' | null>(null);
  const [comment, setComment] = useState('');
  const [acting, setActing] = useState(false);

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

  useEffect(() => {
    const channel = supabase
      .channel('director-dashboard-requisitions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'director_requisitions' }, () => fetchData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchData]);

  const loadEvents = useCallback(async (reqId: string) => {
    setEventsLoading(true);
    const { data } = await supabase
      .from('director_requisition_events')
      .select('*')
      .eq('requisition_id', reqId)
      .order('created_at', { ascending: true });
    setDetailEvents((data || []) as ReqEvent[]);
    setEventsLoading(false);
  }, []);

  const openDetail = (req: Requisition) => {
    setSelectedId(req.id);
    loadEvents(req.id);
  };

  const counts = useMemo(() => ({
    pending: rows.filter((r) => r.status === 'pending').length,
    more_info: rows.filter((r) => r.status === 'more_info').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
  }), [rows]);

  const selected = rows.find((r) => r.id === selectedId) || null;
  const visible = rows.filter((r) => r.status === tab);

  const submitAction = async () => {
    if (!selected || !actionType) return;
    if (comment.trim().length < 10) return toast.error('Add a comment (min 10 characters) for the audit trail');
    setActing(true);
    const { error } = await invokeEdgeFunction('director-requisition-action', {
      body: { requisition_id: selected.id, action: actionType, comment: comment.trim() },
      errorTitle: 'Action failed',
      silent: true,
    });
    setActing(false);
    if (error) {
      toast.error(actionType === 'approve' ? requisitionApprovalError(error.message) : error.message);
    } else {
      toast.success('Decision recorded and requester notified');
      setActionType(null);
      setComment('');
      await fetchData();
      await loadEvents(selected.id);
    }
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-background overflow-hidden">
      <header className="shrink-0 z-30 bg-card/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => (selected ? setSelectedId(null) : navigate('/admin/dashboard'))}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold truncate flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" /> Director Dashboard
            </h1>
            <p className="text-xs text-muted-foreground">Requisition approvals &amp; audit</p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="max-w-5xl mx-auto p-4 pb-24">
          {selected ? (
            <RequisitionDetail
              req={selected}
              events={detailEvents}
              eventsLoading={eventsLoading}
              isDirector={isDirector}
              onBack={() => setSelectedId(null)}
              onAction={(type) => { setActionType(type); setComment(''); }}
            />
          ) : (
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
                  <div className="text-center py-14 text-muted-foreground">
                    <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    No {STATUS_META[tab].label.toLowerCase()} requisitions.
                  </div>
                ) : (
                  visible.map((req) => {
                    const meta = STATUS_META[req.status];
                    const StatusIcon = meta.icon;
                    return (
                      <button
                        key={req.id}
                        onClick={() => openDetail(req)}
                        className="w-full text-left"
                      >
                        <Card className="p-4 transition-all hover:shadow-md hover:border-primary/40">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs text-muted-foreground">{req.requisition_code}</span>
                                <Badge variant="outline" className={meta.className}>
                                  <StatusIcon className="h-3 w-3 mr-1" />{meta.label}
                                </Badge>
                              </div>
                              <h3 className="font-semibold mt-1 truncate">{req.title}</h3>
                              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                {req.requester_name || '—'}{req.requester_role ? ` · ${req.requester_role.toUpperCase()}` : ''} · {fmtDate(req.created_at)}
                              </p>
                            </div>
                            <div className="text-right shrink-0 flex items-center gap-2">
                              <div>
                                <div className="text-base font-bold">{formatUGX(Number(req.amount))}</div>
                              </div>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </div>
                          </div>
                        </Card>
                      </button>
                    );
                  })
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>

      {/* Action dialog */}
      <Dialog open={!!actionType} onOpenChange={(o) => !o && setActionType(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionType === 'approve' ? 'Approve requisition' : actionType === 'reject' ? 'Reject requisition' : 'Request more information'}
            </DialogTitle>
            <DialogDescription>
              {selected?.requisition_code} — {selected?.title} · {selected ? formatUGX(Number(selected.amount)) : ''}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="action-comment">Comment (required, min 10 chars)</Label>
            <Textarea
              id="action-comment"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Reason for this decision (added to the audit trail and sent to the requester)"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionType(null)} disabled={acting}>Cancel</Button>
            <Button onClick={submitAction} disabled={acting} className="gap-2">
              {acting && <Loader2 className="h-4 w-4 animate-spin" />} Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RequisitionDetail({
  req, events, eventsLoading, isDirector, onBack, onAction,
}: {
  req: Requisition;
  events: ReqEvent[];
  eventsLoading: boolean;
  isDirector: boolean;
  onBack: () => void;
  onAction: (type: 'approve' | 'reject' | 'request_info') => void;
}) {
  const meta = STATUS_META[req.status];
  const StatusIcon = meta.icon;
  const canAct = isDirector && (req.status === 'pending' || req.status === 'more_info');

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="gap-1 -ml-2" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> Back to list
      </Button>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{req.requisition_code}</span>
              <Badge variant="outline" className={meta.className}>
                <StatusIcon className="h-3 w-3 mr-1" />{meta.label}
              </Badge>
            </div>
            <h2 className="text-xl font-bold mt-1">{req.title}</h2>
          </div>
          <div className="text-right">
            <div className="text-2xl font-black">{formatUGX(Number(req.amount))}</div>
          </div>
        </div>

        <div className="mt-4 rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-line">{req.reason}</div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 text-sm">
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Requester:</span>
            <span className="font-medium">{req.requester_name || '—'}{req.requester_role ? ` (${req.requester_role.toUpperCase()})` : ''}</span>
          </div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Approver:</span>
            <span className="font-medium">{req.approver_name || '—'}</span>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Created:</span>
            <span className="font-medium">{fmtDate(req.created_at)}</span>
          </div>
          {req.decided_at && (
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Decided:</span>
              <span className="font-medium">{fmtDate(req.decided_at)}</span>
            </div>
          )}
        </div>

        {req.director_comment && (
          <div className="mt-4 rounded-md border border-border p-3 text-sm">
            <span className="font-medium">Director comment: </span>{req.director_comment}
          </div>
        )}

        {canAct && (
          <div className="flex flex-wrap items-center gap-2 mt-5">
            <Button size="sm" className="gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => onAction('approve')}>
              <CheckCircle2 className="h-4 w-4" /> Approve
            </Button>
            <Button size="sm" variant="destructive" className="gap-1" onClick={() => onAction('reject')}>
              <XCircle className="h-4 w-4" /> Reject
            </Button>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => onAction('request_info')}>
              <HelpCircle className="h-4 w-4" /> Request info
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="font-semibold flex items-center gap-2 mb-3">
          <FileText className="h-4 w-4 text-primary" /> Audit trail
        </h3>
        {eventsLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events recorded.</p>
        ) : (
          <div className="border-l-2 border-border pl-4 space-y-3">
            {events.map((e) => (
              <div key={e.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium capitalize">{e.action.replace(/_/g, ' ')}</span>
                  <span className="text-muted-foreground">· {e.actor_name || 'System'}</span>
                  <span className="text-muted-foreground">· {fmtDate(e.created_at)}</span>
                </div>
                {e.comment && <div className="text-muted-foreground mt-0.5">{e.comment}</div>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}