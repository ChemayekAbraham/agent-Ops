import { lazy, Suspense, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardHeader from '@/components/DashboardHeader';
import BottomRoleSwitcher from '@/components/BottomRoleSwitcher';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import type { AppRole } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import AiIdButton from '@/components/ai-id/AiIdButton';
import { AgentNotificationBell } from '@/components/agent/AgentNotificationBell';
import { BadgeCheck } from 'lucide-react';
import { SignatureRentRequestCard } from '@/components/agent/SignatureRentRequestCard';

const AgentRentRequestDialog = lazy(() => import('@/components/agent/AgentRentRequestDialog'));

export default function AgentDashboardNew() {
  const { user, signOut, roles, switchRole } = useAuth();
  const { profile } = useProfile();
  const navigate = useNavigate();
  const [rentRequestOpen, setRentRequestOpen] = useState(false);

  const firstName = profile?.full_name?.trim().split(/\s+/)[0] || 'Agent';


  const handleRoleChange = useCallback((newRole: AppRole) => {
    if (!roles.includes(newRole)) return;
    switchRole(newRole);
    navigate(roleToSlug(newRole), { replace: true });
  }, [roles, switchRole, navigate]);

  return (
    <div className="min-h-screen bg-background pb-24">
      <DashboardHeader
        currentRole={'agent' as AppRole}
        availableRoles={roles as AppRole[]}
        onRoleChange={handleRoleChange}
        onSignOut={signOut}
      />
      <main className="min-h-[60vh] px-4 pt-4">
        <div className="flex items-center gap-3">
          <UserAvatar avatarUrl={profile?.avatar_url} fullName={profile?.full_name} size="lg" />
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-xl leading-tight flex items-center gap-1.5 flex-wrap">
              <span className="break-words">{profile?.full_name || 'Agent'}</span>
              {profile?.verified && <BadgeCheck className="h-4 w-4 text-primary fill-primary/20 shrink-0" />}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">Welile Agent{profile?.territory ? ` · ${profile.territory}` : ''}</p>
            <div className="mt-1.5"><AiIdButton variant="compact" /></div>
          </div>
          {user && <div className="shrink-0"><AgentNotificationBell userId={user.id} /></div>}
        </div>
        <div className="mt-5">
          <SignatureRentRequestCard fullName={profile?.full_name} onPostRequest={() => setRentRequestOpen(true)} />
        </div>
      </main>
      {rentRequestOpen && (
        <Suspense fallback={null}>
          <AgentRentRequestDialog open={rentRequestOpen} onOpenChange={setRentRequestOpen} />
        </Suspense>
      )}
      <BottomRoleSwitcher currentRole={'agent' as AppRole} onRoleChange={handleRoleChange} />
    </div>
  );
}
