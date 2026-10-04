import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { UserCheck, UserX, Phone, Clock, Inbox, AlertTriangle, Loader2 } from 'lucide-react';

interface PendingRequest {
  id: string;
  user_id: string;
  requested_role: string;
  reason: string | null;
  created_at: string;
  full_name: string;
  phone: string;
}

export function PendingPartnerRequests() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(true);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data: requests, isLoading } = useQuery({
    queryKey: ['pending-partner-role-requests'],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('role_access_requests')
        .select('id, user_id, requested_role, reason, created_at')
        .eq('requested_role', 'supporter')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
      if (error) throw error;
      const base = rows || [];
      if (base.length === 0) return [] as PendingRequest[];
      const ids = Array.from(new Set(base.map(r => r.user_id)));
      const { data: profiles } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
      const pMap = new Map((profiles || []).map(p => [p.id, p]));
      return base.map(r => ({
        ...r,
        full_name: pMap.get(r.user_id)?.full_name || 'Unknown',
        phone: pMap.get(r.user_id)?.phone || '—',
      })) as PendingRequest[];
    },
    staleTime: 30_000,
  });

  const approveMutation = useMutation({
    mutationFn: async (req: PendingRequest) => {
      // Always re-fetch fresh — never trust cache for state transitions
      const { data: fresh, error: fetchErr } = await supabase
        .from('role_access_requests')
        .select('id, status, user_id, requested_role')
        .eq('id', req.id)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!fresh) throw new Error('Request no longer exists');
      if (fresh.status !== 'pending') throw new Error(`Already ${fresh.status}`);

      // 1. Grant supporter role (idempotent upsert)
      const { error: roleErr } = await supabase
        .from('user_roles')
        .upsert({ user_id: fresh.user_id, role: 'supporter' as any, enabled: true }, { onConflict: 'user_id,role' });
      if (roleErr) throw roleErr;

      // 2. Mark request approved
      const { error: updErr } = await supabase
        .from('role_access_requests')
        .update({ status: 'approved', reviewed_by: user?.id, reviewed_at: new Date().toISOString() })
        .eq('id', req.id)
        .eq('status', 'pending');
      if (updErr) throw updErr;

      // 3. Audit
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'approve_partner_role_request',
        table_name: 'role_access_requests',
        record_id: req.id,
        metadata: { approved_user: req.full_name, phone: req.phone, source: 'PartnerOps' },
      });

      return req;
    },
    onSuccess: (req) => {
      toast({ title: '✅ Partner approved', description: `${req.full_name} can now use the Partner dashboard.` });
      qc.invalidateQueries({ queryKey: ['pending-partner-role-requests'] });
      qc.invalidateQueries({ queryKey: ['new-partners-panel'] });
    },
    onError: (err: any) => {
      toast({ title: 'Approval failed', description: err?.message || 'Try again', variant: 'destructive' });
      qc.invalidateQueries({ queryKey: ['pending-partner-role-requests'] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase
        .from('role_access_requests')
        .update({ status: 'rejected', rejection_reason: reason, reviewed_by: user?.id, reviewed_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'pending');
      if (error) throw error;
      const req = requests?.find(r => r.id === id);
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'reject_partner_role_request',
        table_name: 'role_access_requests',
        record_id: id,
        metadata: { rejected_user: req?.full_name, phone: req?.phone, rejection_reason: reason },
      });
    },
    onSuccess: () => {
      toast({ title: 'Request rejected', description: 'Partner role request declined.' });
      setRejectId(null); setRejectReason('');
      qc.invalidateQueries({ queryKey: ['pending-partner-role-requests'] });
    },
    onError: (err: any) => toast({ title: 'Rejection failed', description: err?.message, variant: 'destructive' }),
  });

  const count = requests?.length || 0;
  if (!isLoading && count === 0) return null;

  return (
    <>
      <Card className="border-warning/40 bg-warning/5">
        <CardContent className="p-4 space-y-3">
          <button onClick={() => setExpanded(!expanded)} className="flex items-center justify-between w-full text-left">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-warning/15">
                <Inbox className="h-4 w-4 text-warning" />
              </div>
              <div>
                <h3 className="text-sm font-bold">Pending Partner Requests</h3>
                <p className="text-[10px] text-muted-foreground">Users who applied for the Partner dashboard</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {count > 0 && <Badge className="bg-warning/20 text-warning border-0 text-xs font-bold">{count}</Badge>}
              <svg className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </button>

          {expanded && (isLoading ? (
            <div className="space-y-2">{[1, 2].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}</div>
          ) : (
            <div className="space-y-2">
              {requests?.map(r => (
                <Card key={r.id} className="border border-border/60">
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{r.full_name}</p>
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Phone className="h-2.5 w-2.5" />{r.phone}
                        </div>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0 gap-1 bg-warning/10 text-warning border-warning/30">
                        <Clock className="h-2.5 w-2.5" /> Pending
                      </Badge>
                    </div>
                    <div className="text-[10px] text-muted-foreground space-y-0.5">
                      {r.reason && <p><span className="font-medium text-foreground">Reason:</span> {r.reason}</p>}
                      <p><span className="font-medium text-foreground">Requested:</span> {format(new Date(r.created_at), 'dd MMM yyyy, HH:mm')}</p>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        className="flex-1 h-8 text-xs gap-1.5 bg-success hover:bg-success/90 text-white"
                        onClick={() => approveMutation.mutate(r)}
                        disabled={approveMutation.isPending}
                      >
                        {approveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserCheck className="h-3 w-3" />}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 h-8 text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                        onClick={() => setRejectId(r.id)}
                        disabled={rejectMutation.isPending}
                      >
                        <UserX className="h-3 w-3" /> Reject
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={!!rejectId} onOpenChange={(o) => { if (!o) { setRejectId(null); setRejectReason(''); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" /> Reject Partner Request
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Provide a reason (min 10 characters). The user will see it.</p>
            <Input placeholder="Why is this being rejected?" value={rejectReason} onChange={e => setRejectReason(e.target.value)} maxLength={200} />
            <p className="text-[10px] text-muted-foreground">{rejectReason.length}/200</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { setRejectId(null); setRejectReason(''); }}>Cancel</Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={rejectReason.trim().length < 10 || rejectMutation.isPending}
              onClick={() => rejectId && rejectMutation.mutate({ id: rejectId, reason: rejectReason.trim() })}
            >
              {rejectMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
