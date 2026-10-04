import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2, ShieldCheck, Phone, Store } from 'lucide-react';
import ScreenLoader from '@/components/common/ScreenLoader';

/**
 * Landing page for invited Merchant Agents. Shows onboarding status and
 * awaits admin approval (an active row in `cashout_agents`). Once approved,
 * `pending_merchant_agent` is cleared by the DB trigger and the user is
 * forwarded to the Merchant Agent dashboard.
 */
export default function MerchantAgentOnboarding() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile-merchant-onboarding', user?.id],
    enabled: !!user?.id,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone, phone_verified, pending_merchant_agent, merchant_agent_referrer_id')
        .eq('id', user!.id)
        .maybeSingle();
      return data;
    },
  });

  const { data: cashoutRow } = useQuery({
    queryKey: ['cashout-agent-self', user?.id],
    enabled: !!user?.id,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data } = await supabase
        .from('cashout_agents')
        .select('id, is_active')
        .eq('agent_id', user!.id)
        .maybeSingle();
      return data;
    },
  });

  const isApproved = !!cashoutRow?.is_active;

  useEffect(() => {
    if (isApproved) navigate('/dashboard/agent', { replace: true });
  }, [isApproved, navigate]);

  if (isLoading) {
    return (
      <ScreenLoader />
    );
  }

  const phoneOk = !!profile?.phone && profile?.phone_verified;
  const nameOk = !!(profile?.full_name && profile.full_name.trim().length > 2);

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/10 via-background to-background p-4 flex items-center justify-center">
      <Card className="w-full max-w-md p-6 rounded-3xl">
        <div className="text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/15 flex items-center justify-center mb-3">
            <Store className="h-7 w-7 text-primary" />
          </div>
          <h1 className="text-xl font-extrabold">Merchant Agent Onboarding</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Complete these steps and wait for approval.
          </p>
        </div>

        <ul className="mt-5 space-y-3">
          <StepRow
            done={nameOk}
            icon={<CheckCircle2 className="h-4 w-4" />}
            title="Your full name"
            detail={profile?.full_name || 'Add your legal full name'}
          />
          <StepRow
            done={phoneOk}
            icon={<Phone className="h-4 w-4" />}
            title="Phone verified"
            detail={profile?.phone ? profile.phone : 'Verify your mobile number'}
          />
          <StepRow
            done={isApproved}
            icon={<ShieldCheck className="h-4 w-4" />}
            title="Approval by Welile"
            detail={isApproved ? 'Approved' : 'Pending review by our team'}
          />
        </ul>

        <div className="mt-6 space-y-2">
          <Button
            className="w-full h-11 rounded-xl"
            onClick={async () => {
              if (user?.id) {
                await supabase
                  .from('profiles')
                  .update({ pending_merchant_agent: false })
                  .eq('id', user.id);
              }
              navigate('/dashboard/agent', { replace: true });
            }}
          >
            Go to dashboard
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </Card>
    </div>
  );
}

function StepRow({ done, icon, title, detail }: { done: boolean; icon: React.ReactNode; title: string; detail: string }) {
  return (
    <li className={`flex items-start gap-3 p-3 rounded-xl border ${done ? 'border-success/40 bg-success/5' : 'border-border bg-card'}`}>
      <div className={`p-2 rounded-lg ${done ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground truncate">{detail}</p>
      </div>
      {done && <span className="text-xs font-bold text-success">Done</span>}
    </li>
  );
}