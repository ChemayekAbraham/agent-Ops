import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { ShieldQuestion, Phone, UserCircle, Loader2, Clock, FileText, Hash, Edit3, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

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
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

const statusBadge: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
  pending: { label: 'Pending review', className: 'bg-amber-600 text-white hover:bg-amber-600', icon: <AlertTriangle className="h-3 w-3" /> },
  verified: { label: 'Verified', className: 'bg-emerald-600 text-white hover:bg-emerald-600', icon: <CheckCircle className="h-3 w-3" /> },
  rejected: { label: 'Rejected', className: 'bg-rose-600 text-white hover:bg-rose-600', icon: <XCircle className="h-3 w-3" /> },
};

interface Props {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function DetailRow({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-border/40 last:border-0">
      <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0 min-w-[90px]">
        {icon}
        {label}
      </dt>
      <dd className="text-xs font-semibold text-foreground text-right break-words min-w-0">{value}</dd>
    </div>
  );
}

/**
 * Read-only side panel showing a single landlord verification request.
 * Opened from the "View details" toast action so the agent can review the
 * request without leaving (and resetting) the List Empty House dialog.
 */
export default function VerificationRequestDetailSheet({ requestId, open, onOpenChange }: Props) {
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const [resolvedByName, setResolvedByName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!requestId) return;
    setLoading(true);
    const { data } = await supabase
      .from('landlord_verification_requests')
      .select('id, landlord_id, landlord_name, landlord_phone, requested_by, agent_name, agent_phone, note, status, reject_comment, resolved_by, resolved_at, created_at, updated_at')
      .eq('id', requestId)
      .maybeSingle();

    const req = (data as VerificationRequest) ?? null;
    setRequest(req);

    // Look up resolver name if available.
    if (req?.resolved_by) {
      const { data: resolver } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', req.resolved_by)
        .maybeSingle();
      setResolvedByName(resolver?.full_name ?? null);
    } else {
      setResolvedByName(null);
    }

    setLoading(false);
  }, [requestId]);

  useEffect(() => {
    if (open && requestId) load();
  }, [open, requestId, load]);

  // Keep the panel live while it's open.
  useEffect(() => {
    if (!open || !requestId) return;
    const channel = supabase
      .channel(`verification-request-sheet-${requestId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'landlord_verification_requests', filter: `id=eq.${requestId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [open, requestId, load]);

  const badge = request ? (statusBadge[request.status] ?? statusBadge.pending) : statusBadge.pending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Verification request</SheetTitle>
          <SheetDescription>Landlord verification status and details.</SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !request ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <ShieldQuestion className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              This request may have been removed, or you don&apos;t have access to view it.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Header card */}
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
                <Badge className={`${badge.className} shrink-0 flex items-center gap-1`}>
                  {badge.icon}
                  {badge.label}
                </Badge>
              </div>

              {request.landlord_phone && (
                <p className="text-sm text-foreground flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> {request.landlord_phone}
                </p>
              )}
            </div>

            {/* Full details list */}
            <div className="rounded-xl border border-border bg-card p-3 space-y-0">
              <DetailRow
                label="Request ID"
                value={<span className="font-mono text-[11px]">{request.id}</span>}
                icon={<Hash className="h-3 w-3 text-muted-foreground" />}
              />
              <DetailRow
                label="Landlord ID"
                value={<span className="font-mono text-[11px]">{request.landlord_id}</span>}
                icon={<Hash className="h-3 w-3 text-muted-foreground" />}
              />
              <DetailRow
                label="Requested by"
                value={
                  <span>
                    {request.agent_name || 'Agent'}
                    {request.agent_phone ? ` · ${request.agent_phone}` : ''}
                  </span>
                }
                icon={<UserCircle className="h-3 w-3 text-muted-foreground" />}
              />
              <DetailRow
                label="Submitted"
                value={formatDistanceToNow(new Date(request.created_at), { addSuffix: true })}
                icon={<Clock className="h-3 w-3 text-muted-foreground" />}
              />
              <DetailRow
                label="Last updated"
                value={formatDistanceToNow(new Date(request.updated_at), { addSuffix: true })}
                icon={<Edit3 className="h-3 w-3 text-muted-foreground" />}
              />
              {request.resolved_at && (
                <DetailRow
                  label="Resolved"
                  value={formatDistanceToNow(new Date(request.resolved_at), { addSuffix: true })}
                  icon={<CheckCircle className="h-3 w-3 text-muted-foreground" />}
                />
              )}
              {request.resolved_by && (
                <DetailRow
                  label="Resolved by"
                  value={resolvedByName || `Staff (${request.resolved_by.slice(0, 8)}…)`}
                  icon={<UserCircle className="h-3 w-3 text-muted-foreground" />}
                />
              )}
            </div>

            {/* Agent note */}
            {request.note && (
              <div className="rounded-xl border border-border/60 bg-background p-3">
                <p className="text-[11px] font-medium text-muted-foreground mb-1 flex items-center gap-1">
                  <FileText className="h-3 w-3" />
                  Agent note
                </p>
                <p className="text-sm text-foreground">{request.note}</p>
              </div>
            )}

            {/* Rejection reason */}
            {request.status === 'rejected' && request.reject_comment && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-50/60 dark:bg-rose-500/5 p-3">
                <p className="text-[11px] font-medium text-rose-700 mb-1 flex items-center gap-1">
                  <XCircle className="h-3 w-3" />
                  Rejection reason
                </p>
                <p className="text-sm text-foreground">{request.reject_comment}</p>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
