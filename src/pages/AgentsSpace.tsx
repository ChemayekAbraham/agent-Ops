import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { AgentsSpacePanel } from '@/components/executive/AgentsSpacePanel';
import { SmartphoneJourneyCard } from '@/components/merchandise/SmartphoneJourneyCard';
import ScreenLoader from '@/components/common/ScreenLoader';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ShieldAlert, ArrowLeft, Home } from 'lucide-react';

export default function AgentsSpacePage() {
  const navigate = useNavigate();
  const { user, roles, loading: authLoading } = useAuth();

  // Check if user is an executive/admin/manager
  const isExecutive = (roles || []).some((r) =>
    ['manager', 'super_admin', 'operations', 'agent_operations', 'ceo', 'coo', 'cfo'].includes(r)
  );

  // Check if user is an explicitly designated Unique / Special Agent
  const { data: isSpecialAgent = false, isLoading: isCheckingDesignation } = useQuery({
    queryKey: ['check-user-is-special-agent', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      if (!user?.id) return false;
      const { data, error } = await supabase
        .from('staff_permissions')
        .select('user_id')
        .eq('user_id', user.id)
        .eq('permitted_dashboard', 'agents-space')
        .is('revoked_at', null)
        .maybeSingle();

      if (error || !data) return false;
      return true;
    },
    staleTime: 30_000,
  });

  // Anyone repaying a released phone gets automatic access to their phone section.
  const { data: hasPhonePlan = false, isLoading: isCheckingPhone } = useQuery({
    queryKey: ['user-has-active-smartphone-plan', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data } = await supabase.rpc('has_active_smartphone_plan', { p_user: user!.id });
      return !!data;
    },
    staleTime: 60_000,
  });

  if (authLoading || isCheckingDesignation || isCheckingPhone) {
    return <ScreenLoader />;
  }

  const hasFullAccess = isExecutive || isSpecialAgent;
  const hasAccess = hasFullAccess || hasPhonePlan;

  if (!hasAccess) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-6 text-center space-y-4 rounded-2xl border-border bg-card shadow-lg">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center">
            <ShieldAlert className="h-7 w-7" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-foreground">Restricted Access</h2>
            <p className="text-xs text-muted-foreground">
              Agents' Space is reserved exclusively for designated Special Agents and Operations executives.
            </p>
          </div>
          <Button
            onClick={() => navigate('/dashboard')}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-xl gap-2"
          >
            <Home className="h-4 w-4" /> Return to Dashboard
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-4">
        {!hasFullAccess && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="gap-1">
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <h1 className="text-lg font-bold">Agents' Space</h1>
          </div>
        )}
        {hasPhonePlan && (
          <div className="max-w-2xl">
            <SmartphoneJourneyCard />
          </div>
        )}
        {hasFullAccess && <AgentsSpacePanel onBack={() => navigate('/dashboard')} />}
      </div>
    </div>
  );
}
