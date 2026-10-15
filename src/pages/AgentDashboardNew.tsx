import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardHeader from '@/components/DashboardHeader';
import BottomRoleSwitcher from '@/components/BottomRoleSwitcher';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleSlug';
import type { AppRole } from '@/hooks/useAuth';

// Empty shell: top section (header with avatar) + bottom role switcher only.
export default function AgentDashboardNew() {
  const { signOut, roles, switchRole } = useAuth();
  const navigate = useNavigate();

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
      <main className="min-h-[60vh]" />
      <BottomRoleSwitcher currentRole={'agent' as AppRole} onRoleChange={handleRoleChange} />
    </div>
  );
}
