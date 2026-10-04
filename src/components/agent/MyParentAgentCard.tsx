import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { useToast } from '@/hooks/use-toast';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import { UsersRound, Clock, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

interface MyParentAgentCardProps {
  agentId: string;
}

function fmtInviteDate(iso: string | null | undefined) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return (
    d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' \u00B7 ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  );
}

type InviteStatus = 'pending' | 'accepted' | 'expired';

function classifyInviteStatus(raw: string, expiresAt: string | null): InviteStatus {
  const s = raw.toLowerCase().trim();
  if (s === 'pending' || s === 'pending_acceptance') {
    if (expiresAt && new Date(expiresAt) < new Date()) return 'expired';
    return 'pending';
  }
  if (s === 'expired' || s === 'rejected' || s === 'inactive' || s === 'revoked') return 'expired';
  return 'accepted'; // approved, verified, active, etc.
}

function statusBadgeClass(status: InviteStatus) {
  switch (status) {
    case 'pending':
      return 'bg-amber-500/10 text-amber-600';
    case 'accepted':
      return 'bg-emerald-500/10 text-emerald-600';
    case 'expired':
      return 'bg-red-500/10 text-red-600';
  }
}

/**
 * Shows the invited (sub-)agent who recruited them — i.e. their parent agent.
 * Renders nothing if the current agent was not invited by anyone.
 */
export function MyParentAgentCard({ agentId }: MyParentAgentCardProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [accepting, setAccepting] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['my-parent-agent', agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data: link } = await supabase
        .from('agent_subagents')
        .select('parent_agent_id, status, accepted_at, created_at, expires_at, acceptance_token')
        .eq('sub_agent_id', agentId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!link?.parent_agent_id) return null;

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, avatar_url, phone')
        .eq('id', link.parent_agent_id)
        .maybeSingle();

      return {
        parentId: link.parent_agent_id,
        status: link.status as string,
        acceptedAt: link.accepted_at as string | null,
        createdAt: link.created_at as string | null,
        expiresAt: link.expires_at as string | null,
        acceptanceToken: link.acceptance_token as string | null,
        fullName: (profile?.full_name as string) || 'Your agent',
        avatarUrl: (profile?.avatar_url as string) || null,
        phone: (profile?.phone as string) || null,
      };
    },
  });

  // Realtime: instantly reflect acceptance no matter where it happened
  // (this dashboard, the emailed /sub-agent-invite link, or staff action).
  useEffect(() => {
    if (!agentId) return;
    const channel = supabase
      .channel(`my-parent-agent-${agentId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_subagents',
          filter: `sub_agent_id=eq.${agentId}`,
        },
        () => queryClient.invalidateQueries({ queryKey: ['my-parent-agent', agentId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [agentId, queryClient]);

  if (isLoading || !data) return null;

  const inviteDateLabel = fmtInviteDate(data.createdAt);
  const expiresDateLabel = fmtInviteDate(data.expiresAt);
  const inviteStatus = classifyInviteStatus(data.status, data.expiresAt);
  const isExpired = inviteStatus === 'expired';
  const isPending = inviteStatus === 'pending';

  const handleAccept = async () => {
    if (!data.acceptanceToken) {
      toast({
        title: 'Cannot accept here',
        description: 'This invitation is missing its acceptance code. Please use the link your agent sent you.',
        variant: 'destructive',
      });
      return;
    }
    setAccepting(true);
    try {
      const response = await supabase.functions.invoke('accept-subagent-invite', {
        body: { acceptanceToken: data.acceptanceToken },
      });
      if (response.error || response.data?.error) {
        const msg = await extractEdgeFunctionError(response, 'Could not accept the invitation.');
        throw new Error(msg);
      }
      toast({
        title: '🎉 Invitation accepted',
        description: `You're now a sub-agent of ${data.fullName}. Welcome aboard!`,
      });
      await queryClient.invalidateQueries({ queryKey: ['my-parent-agent', agentId] });
    } catch (err: any) {
      toast({
        title: 'Could not accept',
        description: err?.message || 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Card className={`border ${isExpired ? 'border-red-300 bg-red-50/[0.03]' : 'border-primary/20 bg-primary/[0.03]'}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
        <UserAvatar
          fullName={data.fullName}
          avatarUrl={data.avatarUrl}
          className="h-11 w-11 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
            <UsersRound className="h-3 w-3" /> Invited you to Welile
          </p>
          <p className="font-semibold text-foreground truncate">{data.fullName}</p>
          {data.phone && (
            <p className="text-xs text-muted-foreground truncate">{data.phone}</p>
          )}
          {inviteDateLabel && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
              <Clock className="h-3 w-3" />
              {inviteStatus === 'accepted'
                ? `Recruited on ${inviteDateLabel}`
                : `Invited on ${inviteDateLabel}`}
            </p>
          )}
          {isExpired && expiresDateLabel && (
            <p className="text-[11px] text-red-500 flex items-center gap-1 mt-0.5">
              <AlertCircle className="h-3 w-3" />
              Expired on {expiresDateLabel}
            </p>
          )}
          {isExpired && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              This invitation is no longer valid. Ask your agent to re-send it.
            </p>
          )}
        </div>
        <span
          className={`text-[10px] font-semibold px-2 py-1 rounded-full capitalize shrink-0 ${statusBadgeClass(inviteStatus)}`}
        >
          {inviteStatus}
        </span>
        </div>

        {isPending && (
          <div className="mt-3 pt-3 border-t border-border/60">
            <p className="text-[11px] text-muted-foreground mb-2">
              Accept to join {data.fullName}'s team and start earning together.
            </p>
            <Button
              className="w-full h-10 gap-2"
              onClick={handleAccept}
              disabled={accepting}
            >
              {accepting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {accepting ? 'Accepting…' : 'Accept invitation'}
            </Button>
          </div>
        )}

        {inviteStatus === 'accepted' && (
          <div className="mt-3 pt-3 border-t border-border/60 flex items-center gap-2 text-emerald-600">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <p className="text-[11px] font-medium">
              You're an active sub-agent of {data.fullName}.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
