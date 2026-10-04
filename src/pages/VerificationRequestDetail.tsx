import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowLeft, ShieldQuestion, CheckCircle2, XCircle, Phone, UserCircle, Loader2,
  Clock, Home,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { notifyVerificationResolved } from '@/lib/landlordVerificationNotify';
import { setLandlordVerification } from '@/lib/landlord-ops/verification';

interface VerificationRequest {
  id: string;
  landlord_id: string;
  landlord_name: string | null;
  landlord_phone: string | null;
  requested_by: string;
  agent_name: string | null;
  agent_phone: string | null;
  note: string | null;
  status: 'pending' | 'verified' | 'rejected' | string;
  reject_comment: string | null;
  resolved_at: string | null;
  created_at: string;
}

const OPS_ROLES = ['manager', 'super_admin', 'coo', 'operations'];

const statusBadge: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending review', className: 'bg-amber-600 text-white hover:bg-amber-600' },
  verified: { label: '✅ Verified', className: 'bg-emerald-600 text-white hover:bg-emerald-600' },
  rejected: { label: 'Rejected', className: 'bg-rose-600 text-white hover:bg-rose-600' },
};

/**
 * Deep-link target for a single landlord verification request.
 * Reached when a user taps a verification notification. Data access is gated by
 * RLS (requester or ops only). Ops users can verify / reject a pending request
 * directly from here.
 */
export default function VerificationRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, roles, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectComment, setRejectComment] = useState('');

  const isOps = (roles ?? []).some(r => OPS_ROLES.includes(r));

  const load = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('landlord_verification_requests')
      .select('id, landlord_id, landlord_name, landlord_phone, requested_by, agent_name, agent_phone, note, status, reject_comment, resolved_at, created_at')
      .eq('id', id)
      .maybeSingle();
    setRequest((data as VerificationRequest) ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { navigate('/auth'); return; }
    load();
  }, [authLoading, user, load, navigate]);

  useEffect(() => {
    if (!id) return;
    const channel = supabase
      .channel(`verification-request-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'landlord_verification_requests', filter: `id=eq.${id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, load]);

  const handleVerify = async () => {
    if (!user || !request) return;
    setBusy(true);
    try {
      await setLandlordVerification({
        landlordId: request.landlord_id,
        status: 'verified',
        reason: `Verified from verification request review (${request.agent_name || 'agent'})`,
        source: 'verification_detail',
      });
      toast({ title: '✅ Landlord verified', description: `${request.landlord_name || 'Landlord'} is now verified.` });
      void notifyVerificationResolved({
        status: 'verified',
        agentId: request.requested_by,
        landlordId: request.landlord_id,
        landlordName: request.landlord_name,
        landlordPhone: request.landlord_phone,
        requestId: request.id,
      });
      await load();
    } catch (err: any) {
      toast({ title: 'Verify failed', description: err?.message || 'Could not verify landlord', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!user || !request) return;
    const comment = rejectComment.trim();
    if (comment.length < 10) {
      toast({ title: 'Add a comment', description: 'Please give at least 10 characters explaining the rejection.', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      await setLandlordVerification({
        landlordId: request.landlord_id,
        status: 'rejected',
        reason: comment,
        source: 'verification_detail',
      });
      toast({ title: 'Request rejected', description: `${request.landlord_name || 'Landlord'} was rejected with a comment.` });
      void notifyVerificationResolved({
        status: 'rejected',
        agentId: request.requested_by,
        landlordId: request.landlord_id,
        landlordName: request.landlord_name,
        landlordPhone: request.landlord_phone,
        comment,
        requestId: request.id,
      });
      setRejecting(false);
      setRejectComment('');
      await load();
    } catch (err: any) {
      toast({ title: 'Reject failed', description: err?.message || 'Could not reject request', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  if (loading || authLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!request) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background px-6 text-center gap-4">
        <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
          <ShieldQuestion className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Verification request unavailable</h1>
          <p className="text-sm text-muted-foreground max-w-md">
            This request may have been removed, or you don&apos;t have access to view it.
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate(-1)} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      </div>
    );
  }

  const badge = statusBadge[request.status] ?? statusBadge.pending;
  const canAct = isOps && request.status === 'pending';

  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-14 border-b bg-background/95 backdrop-blur">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-bold text-base">Verification request</h1>
      </div>

      <main className="max-w-lg mx-auto px-4 py-5 space-y-4">
        <div className="rounded-2xl border-2 border-amber-500/40 bg-amber-50/50 dark:bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="p-2 rounded-xl bg-amber-500/15 shrink-0">
                <ShieldQuestion className="h-[18px] w-[18px] text-amber-600" />
              </div>
              <div className="min-w-0">
                <p className="font-bold text-base leading-tight truncate">{request.landlord_name || 'Unnamed landlord'}</p>
                <p className="text-[11px] text-muted-foreground">Landlord verification</p>
              </div>
            </div>
            <Badge className={`${badge.className} shrink-0`}>{badge.label}</Badge>
          </div>

          {request.landlord_phone && (
            <p className="text-sm text-foreground flex items-center gap-1.5">
              <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> {request.landlord_phone}
            </p>
          )}
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <UserCircle className="h-3.5 w-3.5 shrink-0" />
            Requested by <span className="font-medium text-foreground">{request.agent_name || 'Agent'}</span>
            {request.agent_phone ? ` · ${request.agent_phone}` : ''}
          </p>
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Clock className="h-3 w-3 shrink-0" />
            {formatDistanceToNow(new Date(request.created_at), { addSuffix: true })}
            {request.resolved_at ? ` · resolved ${formatDistanceToNow(new Date(request.resolved_at), { addSuffix: true })}` : ''}
          </p>

          {request.note && (
            <div className="rounded-xl border border-border/60 bg-background p-3">
              <p className="text-[11px] font-medium text-muted-foreground mb-1">Agent note</p>
              <p className="text-sm text-foreground">{request.note}</p>
            </div>
          )}

          {request.status === 'rejected' && request.reject_comment && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-50/60 dark:bg-rose-500/5 p-3">
              <p className="text-[11px] font-medium text-rose-700 mb-1">Rejection reason</p>
              <p className="text-sm text-foreground">{request.reject_comment}</p>
            </div>
          )}
        </div>

        {canAct && (
          rejecting ? (
            <div className="space-y-2">
              <Textarea
                value={rejectComment}
                onChange={(e) => setRejectComment(e.target.value)}
                placeholder="Add a comment explaining why this landlord is rejected (min 10 characters)…"
                className="min-h-[80px] text-sm"
              />
              <div className="flex gap-2">
                <Button variant="destructive" className="flex-1" disabled={busy} onClick={handleReject}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4 mr-1" />}
                  Confirm reject
                </Button>
                <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => { setRejecting(false); setRejectComment(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busy} onClick={handleVerify}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                Verify landlord
              </Button>
              <Button variant="outline" className="flex-1 border-rose-500/40 text-rose-700 hover:bg-rose-50" disabled={busy} onClick={() => { setRejecting(true); setRejectComment(''); }}>
                <XCircle className="h-4 w-4 mr-1" /> Reject
              </Button>
            </div>
          )
        )}

        {isOps && (
          <Button variant="outline" className="w-full gap-2" onClick={() => navigate('/executive-hub?tab=landlord-ops')}>
            <Home className="h-4 w-4" /> Open Landlord Operations
          </Button>
        )}
      </main>
    </div>
  );
}