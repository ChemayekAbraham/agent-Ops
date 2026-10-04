import { useEffect, useState } from 'react';
import { Copy, Share2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface PartnerLeadInvite {
  code: string;
  uses_count: number;
  expires_at: string | null;
  revoked: boolean;
}

interface EnrolledAgent {
  agent_id: string;
  full_name: string;
  phone: string | null;
  attached_at: string;
}

export default function MyProxyInviteLink() {
  const [invite, setInvite] = useState<PartnerLeadInvite | null>(null);
  const [agents, setAgents] = useState<EnrolledAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchInvite = async () => {
    try {
      const { data, error: rpcError } = await supabase.rpc('my_partner_lead_invite');
      if (rpcError) {
        setError(new Error(rpcError.message));
        toast.error(rpcError.message);
        return;
      }
      const rows = (data ?? []) as unknown as PartnerLeadInvite[];
      setInvite(rows[0] ?? null);
    } catch (e) {
      const caught = e instanceof Error ? e : new Error('Could not load invite link');
      setError(caught);
      toast.error(caught.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchAgents = async () => {
    const { data, error: rpcError } = await supabase.rpc('my_partner_lead_agents');
    if (rpcError) return;
    setAgents((data ?? []) as unknown as EnrolledAgent[]);
  };

  useEffect(() => {
    void fetchInvite();
    void fetchAgents();

    const channel = supabase
      .channel('my-partner-lead-agents')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'partner_lead_assignments' },
        () => {
          void fetchAgents();
        },
      )
      .subscribe();

    const interval = window.setInterval(() => {
      void fetchAgents();
    }, 30000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchAgents();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const handleCopy = async () => {
    if (!invite) return;
    const link = `${window.location.origin}/pa/${invite.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Invite link copied');
    } catch {
      toast.error('Could not copy link');
    }
  };

  const handleWhatsApp = () => {
    if (!invite) return;
    const link = `${window.location.origin}/pa/${invite.code}`;
    const text = encodeURIComponent(
      `Join Welile as my proxy agent using this link: ${link}`,
    );
    window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener,noreferrer');
  };

  const handleRevoke = async () => {
    if (!invite) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('revoke_partner_lead_invite');
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success('Invite link revoked');
      await fetchInvite();
      await fetchAgents();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not revoke invite');
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
        Invite link unavailable: {error.message}
      </div>
    );
  }

  if (loading) return null;

  if (!invite) {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        No invite link yet. Refresh, or ask ops to enable proxy invites for your account.
      </div>
    );
  }

  const link = `${window.location.origin}/pa/${invite.code}`;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">My proxy agent invite link</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="rounded-md border border-border bg-muted/40 p-2">
          <p className="select-all break-all text-sm font-medium text-foreground">
            {link}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={handleCopy}>
            <Copy className="mr-1.5 h-3.5 w-3.5" />
            Copy
          </Button>
          <Button size="sm" variant="outline" onClick={handleWhatsApp}>
            <Share2 className="mr-1.5 h-3.5 w-3.5" />
            WhatsApp
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="destructive" disabled={busy}>
                Revoke
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke invite link?</AlertDialogTitle>
                <AlertDialogDescription>
                  Existing attachments stay in place. New sign-ups through this
                  link will stop.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleRevoke} disabled={busy}>
                  Revoke
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <p className="text-xs text-muted-foreground">
          {agents.length} proxy agent{agents.length === 1 ? '' : 's'} enrolled under you
        </p>

        {agents.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {agents.map((a, i) => (
              <div
                key={a.agent_id}
                className="flex items-center justify-between gap-2 p-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {i + 1}. {a.full_name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.phone ?? 'No phone'}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(a.attached_at).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
