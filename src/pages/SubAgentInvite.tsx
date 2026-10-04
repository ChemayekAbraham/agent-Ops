import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import {
  savePendingSubAgentInvite,
  clearPendingSubAgentInvite,
} from '@/lib/pendingSubAgentInvite';
import { Loader2, UsersRound, CheckCircle2, AlertTriangle, LogIn, Wallet, Users, TrendingUp, Info } from 'lucide-react';
import ScreenLoader from '@/components/common/ScreenLoader';

type Phase = 'idle' | 'accepting' | 'accepted' | 'error' | 'need-login' | 'already-sub-agent';

interface ParentAgent {
  full_name: string;
  avatar_url: string | null;
}

interface InviteInfo {
  status: string;
  parent: ParentAgent;
}

export default function SubAgentInvite() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { user, loading } = useAuth();

  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [parentName, setParentName] = useState('your agent');
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [existingParent, setExistingParent] = useState<ParentAgent | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

  // If the user is already a verified sub-agent, show that clearly instead of
  // letting them try to accept another invitation (which would fail or replace
  // their existing relationship).
  useEffect(() => {
    async function fetchInviteState() {
      if (!user) return;
      setInviteLoading(true);
      try {
        const { data: existing } = await supabase
          .from('agent_subagents')
          .select('parent_agent_id, status')
          .eq('sub_agent_id', user.id)
          .eq('status', 'verified')
          .order('verified_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existing?.parent_agent_id) {
          const { data: parent } = await supabase
            .from('profiles')
            .select('full_name, avatar_url')
            .eq('id', existing.parent_agent_id)
            .maybeSingle();

          if (parent) {
            setExistingParent(parent);
            setParentName(parent.full_name || 'your agent');
          }
          setPhase('already-sub-agent');
          return;
        }

        if (!token) return;

        const { data: row, error } = await supabase
          .from('agent_subagents')
          .select('status, parent_agent_id')
          .eq('acceptance_token', token)
          .or(`sub_agent_id.eq.${user.id},parent_agent_id.eq.${user.id}`)
          .maybeSingle();

        if (error || !row) {
          return;
        }

        const { data: parent } = await supabase
          .from('profiles')
          .select('full_name, avatar_url')
          .eq('id', row.parent_agent_id)
          .maybeSingle();

        if (parent) {
          setInvite({ status: row.status, parent: parent });
          setParentName(parent.full_name || 'your agent');
        }
      } finally {
        setInviteLoading(false);
      }
    }

    if (user) fetchInviteState();
  }, [token, user]);

  const handleAccept = async () => {
    if (!token) {
      setPhase('error');
      setMessage('This invitation link is missing its token.');
      return;
    }
    setPhase('accepting');
    try {
      const response = await supabase.functions.invoke('accept-subagent-invite', {
        body: { acceptanceToken: token },
      });
      if (response.error || response.data?.error) {
        const msg = await extractEdgeFunctionError(response, 'Could not accept the invitation.');
        throw new Error(msg);
      }
      if (response.data?.parentName) setParentName(response.data.parentName);
      clearPendingSubAgentInvite();
      setPhase('accepted');
    } catch (err: any) {
      setPhase('error');
      setMessage(err?.message || 'Could not accept the invitation. Please try again.');
    }
  };

  useEffect(() => {
    if (loading) return;
    if (!user) {
      // Persist the invite so it survives the sign-in round-trip even if the
      // redirect param is lost (OAuth, PWA cold start, fresh tab, etc).
      if (token) savePendingSubAgentInvite(token);
      setPhase('need-login');
    }
  }, [loading, user, token]);

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  // Detailed commission breakdown for the invited sub-agent
  const commissionStreams = [
    {
      icon: Wallet,
      title: 'Rent collection commission',
      rate: '8%',
      example: 'UGX 8,000 on UGX 100,000 collected',
      note: 'Paid instantly to your wallet',
    },
    {
      icon: TrendingUp,
      title: 'Investment commission',
      rate: '2%',
      example: 'UGX 2,000 on UGX 100,000 invested',
      note: 'On every supporter investment you bring',
    },
    {
      icon: Users,
      title: 'Recruiter signup bonus',
      rate: 'UGX 10,000 flat',
      example: 'Per new sub-agent you recruit',
      note: 'Credited when they verify their first listing',
    },
    {
      icon: UsersRound,
      title: 'Recruiter rent override',
      rate: '2%',
      example: 'UGX 2,000 when your recruit collects UGX 100,000',
      note: 'Earned from your own sub-agents collections',
    },
  ];

  const monthlyExample = {
    rent: { amount: 'UGX 500,000', yourCut: 'UGX 40,000' },
    recruitOverride: { amount: 'UGX 300,000', yourCut: 'UGX 6,000' },
    recruitBonus: 'UGX 20,000',
    total: 'UGX 66,000',
  };

  if (loading || (!user && phase === 'idle')) {
    return (
      <ScreenLoader />
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-2 border-primary/20">
        <CardContent className="p-6 space-y-5 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
            {phase === 'accepted' ? (
              <CheckCircle2 className="h-7 w-7" />
            ) : phase === 'error' ? (
              <AlertTriangle className="h-7 w-7 text-destructive" />
            ) : (
              <UsersRound className="h-7 w-7" />
            )}
          </div>

          {phase === 'need-login' && (
            <>
              <div>
                <h1 className="text-lg font-bold">You've been invited to a team</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Sign in to see who invited you and the benefits you'll unlock.
                </p>
              </div>
              <Button
                className="w-full h-11 gap-2"
                onClick={() => navigate(`/?redirect=${encodeURIComponent(`/sub-agent-invite?token=${token}`)}`)}
              >
                <LogIn className="h-4 w-4" /> Sign in to accept
              </Button>
            </>
          )}

          {(phase === 'idle' || phase === 'accepting') && user && (
            <>
              {/* Lead agent preview */}
              {invite && invite.parent ? (
                <div className="flex flex-col items-center gap-2">
                  <Avatar className="h-16 w-16 border-2 border-primary/20">
                    <AvatarImage src={invite.parent.avatar_url || undefined} />
                    <AvatarFallback className="text-lg">{getInitials(invite.parent.full_name)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <h1 className="text-lg font-bold">{invite.parent.full_name || 'A Welile Agent'}</h1>
                    <p className="text-sm text-muted-foreground">invited you to join their team</p>
                  </div>
                  {invite.status === 'expired' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive bg-destructive/10 px-2 py-1 rounded-full">
                      <AlertTriangle className="h-3 w-3" /> This invite has expired
                    </span>
                  )}
                </div>
              ) : inviteLoading ? (
                <div className="flex flex-col items-center gap-2">
                  <Skeleton className="h-16 w-16 rounded-full" />
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-56" />
                </div>
              ) : (
                <div>
                  <h1 className="text-lg font-bold">You've been invited as a sub-agent</h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    Accept to join the team and start earning on Welile.
                  </p>
                </div>
              )}

              {/* Detailed commission breakdown */}
              <div className="text-left space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide text-center">What you'll earn</p>
                {commissionStreams.map((s) => (
                  <div key={s.title} className="flex items-start gap-3 p-3 rounded-xl bg-muted/50 border border-border/50">
                    <div className="mt-0.5 shrink-0 w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                      <s.icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold">{s.title}</p>
                        <span className="text-xs font-bold text-primary shrink-0">{s.rate}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{s.example}</p>
                      <p className="text-[11px] text-muted-foreground/70 mt-0.5 italic">{s.note}</p>
                    </div>
                  </div>
                ))}

                {/* Monthly scenario card */}
                <div className="p-3 rounded-xl bg-primary/5 border border-primary/15">
                  <p className="text-xs font-semibold text-primary text-center mb-2">Example month</p>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">You collect {monthlyExample.rent.amount} rent</span>
                      <span className="font-semibold">{monthlyExample.rent.yourCut}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Your recruit collects {monthlyExample.recruitOverride.amount}</span>
                      <span className="font-semibold">{monthlyExample.recruitOverride.yourCut}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">You recruit 2 new agents</span>
                      <span className="font-semibold">{monthlyExample.recruitBonus}</span>
                    </div>
                    <div className="border-t border-primary/15 pt-1.5 mt-1.5 flex justify-between">
                      <span className="font-semibold text-foreground">Total you earn</span>
                      <span className="font-bold text-primary">{monthlyExample.total}</span>
                    </div>
                  </div>
                </div>

                {/* Regulator-safe commission disclaimer */}
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-muted/40 border border-border/40">
                  <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Commission is calculated on the rent amount you facilitate after the platform's service and access fees have been deducted. You are not lending money; you are earning a facilitation fee on rent plan collections processed through Welile.
                  </p>
                </div>
              </div>

              <Button
                className="w-full h-11 gap-2"
                onClick={handleAccept}
                disabled={phase === 'accepting' || invite?.status === 'expired'}
              >
                {phase === 'accepting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {invite?.status === 'expired' ? 'Invite expired' : 'Accept invitation'}
              </Button>
            </>
          )}

          {phase === 'accepted' && (
            <>
              <div>
                <h1 className="text-lg font-bold">Invitation accepted!</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  You're now a sub-agent of {parentName}. Welcome aboard!
                </p>
              </div>
              <Button className="w-full h-11" onClick={() => navigate('/dashboard/agent')}>
                Go to my dashboard
              </Button>
            </>
          )}

          {phase === 'already-sub-agent' && existingParent && (
            <>
              <div className="flex flex-col items-center gap-3">
                <Avatar className="h-16 w-16 border-2 border-primary/20">
                  <AvatarImage src={existingParent.avatar_url || undefined} />
                  <AvatarFallback className="text-lg">{getInitials(existingParent.full_name)}</AvatarFallback>
                </Avatar>
                <div>
                  <h1 className="text-lg font-bold">You're already a sub-agent</h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    You are already a sub-agent to <span className="font-semibold text-foreground">{existingParent.full_name || 'your agent'}</span>.
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    You can only belong to one agent team at a time. If this looks wrong, contact support.
                  </p>
                </div>
              </div>
              <Button className="w-full h-11" onClick={() => navigate('/dashboard/agent')}>
                Go to my dashboard
              </Button>
            </>
          )}

          {phase === 'error' && (
            <>
              <div>
                <h1 className="text-lg font-bold">Couldn't accept</h1>
                <p className="text-sm text-muted-foreground mt-1">{message}</p>
              </div>
              <Button variant="outline" className="w-full h-11" onClick={() => { setPhase('idle'); setMessage(''); }}>
                Try again
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

