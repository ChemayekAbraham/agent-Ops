import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { AlertCircle, RefreshCw, Trash2, Loader2, User, Building, Calendar, MessageSquare } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { useAgentRejectedRequests, type AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';
import { AgentEditRentRequestDialog } from './AgentEditRentRequestDialog';

export function AgentRejectedRequestsSection() {
  const qc = useQueryClient();
  const { data: requests, isLoading, refetch } = useAgentRejectedRequests();
  const [editing, setEditing] = useState<AgentRejectedRequest | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentRejectedRequest | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);

  if (isLoading) {
    return <Skeleton className="h-32 w-full rounded-xl" />;
  }
  if (!requests || requests.length === 0) return null;

  const onResubmitted = () => {
    qc.invalidateQueries({ queryKey: ['agent-rejected-rent-requests'] });
    refetch();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (deleteReason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setDeleting(true);
    try {
      const { error } = await supabase.rpc('agent_delete_rejected_rent_request' as any, {
        p_request_id: deleteTarget.id,
        p_reason: deleteReason.trim(),
      });
      if (error) throw error;
      toast.success('Request deleted');
      setDeleteTarget(null);
      setDeleteReason('');
      onResubmitted();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <h3 className="text-sm font-bold">Needs your attention</h3>
        <Badge variant="destructive" className="text-[10px]">
          {requests.length} rejected
        </Badge>
      </div>

      {requests.map((req) => {
        const RESUBMIT_CAP = 5;
        const used = req.reopen_count ?? 0;
        const lockedFromResubmit = used >= RESUBMIT_CAP;
        return (
          <Card key={req.id} className="border-2 border-destructive/40 bg-destructive/5 overflow-hidden">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <User className="h-4 w-4 text-primary shrink-0" />
                    <span className="font-semibold truncate">{req.tenant_name}</span>
                    <Badge
                      variant={req.returned_by_recall ? 'warning' : 'destructive'}
                      className="text-[10px] gap-1"
                    >
                      {req.returned_by_recall ? req.stage_label : `Rejected at ${req.stage_label}`}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <Building className="h-3 w-3" />
                      <span className="truncate">{req.landlord_name}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Calendar className="h-3 w-3" />
                      <span>
                        Created {format(new Date(req.created_at), 'MMM d')}
                        {req.rejected_at && ` · Rejected ${format(new Date(req.rejected_at), 'MMM d, h:mm a')}`}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-base font-bold">{formatUGX(req.rent_amount)}</p>
                  <p className="text-[10px] text-muted-foreground">{req.duration_days} days</p>
                </div>
              </div>

              {/* Highlighted reviewer comment */}
              <div
                className={`rounded-lg border bg-background p-3 ${
                  req.returned_by_recall ? 'border-warning/40' : 'border-destructive/40'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <MessageSquare
                    className={`h-3.5 w-3.5 ${req.returned_by_recall ? 'text-warning' : 'text-destructive'}`}
                  />
                  <p
                    className={`text-[10px] font-bold uppercase tracking-wide ${
                      req.returned_by_recall ? 'text-warning' : 'text-destructive'
                    }`}
                  >
                    {req.returned_by_recall
                      ? 'Why it came back — automatic recall'
                      : `Reviewer comment — ${req.reviewer_name}`}
                  </p>
                </div>
                <p className="text-sm text-foreground/90 whitespace-pre-wrap">
                  {req.rejected_reason || 'No reason provided.'}
                </p>
                {used > 0 && (
                  <p className="text-[10px] mt-1.5">
                    <span className={lockedFromResubmit ? 'text-destructive font-semibold' : 'text-muted-foreground'}>
                      Resubmits used: {used}/{RESUBMIT_CAP}
                      {lockedFromResubmit && ' — limit reached, ask a manager to reopen this request'}
                    </span>
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => setEditing(req)}
                  disabled={lockedFromResubmit}
                  title={
                    lockedFromResubmit
                      ? `Resubmit cap reached (${RESUBMIT_CAP}/${RESUBMIT_CAP}). A manager must reopen it.`
                      : req.returned_by_recall
                        ? 'Submit this Rent Plan again — the landlord float goes back out once the CFO disburses it'
                        : 'Edit and send back to reviewer'
                  }
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {lockedFromResubmit ? 'Manager reopen required' : 'Edit & Resubmit'}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="gap-1.5"
                  onClick={() => { setDeleteTarget(req); setDeleteReason(''); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <AgentEditRentRequestDialog
        request={editing}
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onResubmitted={onResubmitted}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) { setDeleteTarget(null); setDeleteReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this rejected request?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the request from your dashboard. The record stays in the audit log and cannot be restored from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Reason for deletion (min 10 characters)</label>
            <Textarea
              rows={3}
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="e.g. Tenant withdrew, duplicate request, captured under wrong landlord…"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={deleting || deleteReason.trim().length < 10}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
