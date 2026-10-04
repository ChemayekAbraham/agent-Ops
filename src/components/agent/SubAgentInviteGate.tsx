import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import {
  getPendingSubAgentInvite,
  clearPendingSubAgentInvite,
} from '@/lib/pendingSubAgentInvite';
import { UserPlus, Check, X, Loader2 } from 'lucide-react';

interface PendingInvite {
  id: string;
  parent_agent_id: string;
  acceptance_token: string | null;
  invite_message: string | null;
  parent_name: string;
}

/**
 * Global gate that shows a dashboard dialog to any signed-in user who has a
 * pending sub-agent invitation. The invited user can Accept (becomes the
 * inviter's sub-agent) or Cancel (declines). No SMS is involved.
 */
export function SubAgentInviteGate() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [invite, setInvite] = useState<PendingInvite | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);

  // Resume a persisted invite once the user signs in: take them straight to the
  // acceptance screen so they don't have to re-click the original link.
  useEffect(() => {
    if (!user?.id) return;
    const pendingToken = getPendingSubAgentInvite();
    if (!pendingToken) return;
    const alreadyOnInvite =
      location.pathname === '/sub-agent-invite' &&
      new URLSearchParams(location.search).get('token') === pendingToken;
    if (alreadyOnInvite) {
      clearPendingSubAgentInvite();
      return;
    }
    clearPendingSubAgentInvite();
    navigate(`/sub-agent-invite?token=${encodeURIComponent(pendingToken)}`);
  }, [user?.id, location.pathname, location.search, navigate]);

  const loadInvite = useCallback(async () => {
    if (!user?.id) return;
    const { data, error } = await supabase
      .from('agent_subagents')
      .select('id, parent_agent_id, acceptance_token, invite_message')
      .eq('sub_agent_id', user.id)
      .eq('status', 'pending_acceptance')
      .order('invite_sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      setInvite(null);
      setOpen(false);
      return;
    }

    // Resolve the inviter's display name.
    let parentName = 'A Welile agent';
    const { data: parent } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', data.parent_agent_id)
      .maybeSingle();
    if (parent?.full_name) parentName = parent.full_name;

    setInvite({
      id: data.id,
      parent_agent_id: data.parent_agent_id,
      acceptance_token: data.acceptance_token,
      invite_message: data.invite_message,
      parent_name: parentName,
    });
    setOpen(true);
  }, [user?.id]);

  useEffect(() => {
    loadInvite();
  }, [loadInvite]);

  const handleAccept = async () => {
    if (!invite?.acceptance_token) return;
    setBusy('accept');
    try {
      const response = await supabase.functions.invoke('accept-subagent-invite', {
        body: { acceptanceToken: invite.acceptance_token },
      });
      if (response.error || response.data?.error) {
        const msg = await extractEdgeFunctionError(response, 'Could not accept the invitation.');
        throw new Error(msg);
      }
      toast({
        title: 'Invitation accepted!',
        description: `You are now a sub-agent of ${invite.parent_name}.`,
      });
      setOpen(false);
      setInvite(null);
    } catch (err: any) {
      toast({ title: 'Could not accept', description: err?.message || 'Please try again.', variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const handleDecline = async () => {
    if (!invite?.acceptance_token) return;
    setBusy('decline');
    try {
      const response = await supabase.functions.invoke('decline-subagent-invite', {
        body: { acceptanceToken: invite.acceptance_token },
      });
      if (response.error || response.data?.error) {
        const msg = await extractEdgeFunctionError(response, 'Could not decline the invitation.');
        throw new Error(msg);
      }
      toast({ title: 'Invitation declined', description: `You declined ${invite.parent_name}'s invitation.` });
      setOpen(false);
      setInvite(null);
    } catch (err: any) {
      toast({ title: 'Could not decline', description: err?.message || 'Please try again.', variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  if (!invite) return null;

  const initials = invite.parent_name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-orange-500/15 text-orange-600">
            <UserPlus className="h-7 w-7" />
          </div>
          <DialogTitle className="text-center">
            {invite.parent_name} is inviting you to become their sub-agent
          </DialogTitle>
          <DialogDescription className="text-center">
            Accept to join their team and start tracking your activity. They'll see you in their sub-agent list.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
          <Avatar className="h-10 w-10">
            <AvatarFallback className="bg-orange-500/15 text-orange-700 text-xs font-semibold">
              {initials || 'WL'}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{invite.parent_name}</div>
            {invite.invite_message ? (
              <p className="text-xs text-muted-foreground italic mt-0.5">"{invite.invite_message}"</p>
            ) : (
              <p className="text-xs text-muted-foreground mt-0.5">Wants you to join their agent team.</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            onClick={handleDecline}
            disabled={busy !== null}
          >
            {busy === 'decline' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            Cancel
          </Button>
          <Button
            type="button"
            className="gap-2 bg-green-600 hover:bg-green-700 text-white"
            onClick={handleAccept}
            disabled={busy !== null}
          >
            {busy === 'accept' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Accept
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SubAgentInviteGate;