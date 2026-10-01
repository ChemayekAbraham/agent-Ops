import { useEffect, useState, useCallback, useRef, Suspense, memo } from 'react';

import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useAuth, AppRole } from '@/hooks/useAuth';
import { roleToSlug, slugToRole } from '@/lib/roleRoutes';
import { useProfile } from '@/hooks/useProfile';
import AddRoleDialog from '@/components/AddRoleDialog';
import BottomRoleSwitcher from '@/components/BottomRoleSwitcher';
// FloatingChatButton removed — chat accessible only via nav

import { ISOLATED_ROLES, roleDashboardRoutes } from '@/components/layout/executiveSidebarConfig';

import { WifiOff, RefreshCw, ShieldAlert } from 'lucide-react';

import { getCachedUserRoles, cacheUserRoles } from '@/lib/offlineDataStorage';
import { getPreloadedRoles } from '@/lib/sessionCache';
import { getPreferredDefaultRole, areAllRolesUnlocked } from '@/hooks/useAppPreferences';
import { useDeployedCapital } from '@/hooks/useDeployedCapital';
import { useToast } from '@/hooks/use-toast';
import { useConfetti } from '@/components/Confetti';
import { Button } from '@/components/ui/button';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
import ScreenLoader from '@/components/common/ScreenLoader';
import { schedulePreloadOtherRoles } from '@/lib/preloadRoleDashboards';
// Lazy load dashboards for faster initial load
const TenantDashboard = lazyWithRetry(() => import('@/components/dashboards/TenantDashboard'));
const AgentDashboard = lazyWithRetry(() => import('@/components/dashboards/AgentDashboard'));
const SupporterDashboard = lazyWithRetry(() => import('@/components/dashboards/SupporterDashboard'));
const LandlordDashboard = lazyWithRetry(() => import('@/components/dashboards/LandlordDashboard'));
const ManagerDashboard = lazyWithRetry(() => import('@/components/dashboards/ManagerDashboard'));
import { DashboardErrorBoundary } from '@/components/dashboards/DashboardErrorBoundary';

// Minimal loading skeleton - memoized for performance
const DashboardLoadingFallback = memo(() => <ScreenLoader label="Loading..." />);
DashboardLoadingFallback.displayName = 'DashboardLoadingFallback';

// Offline fallback when dashboard can't load
const OfflineFallback = ({ cachedRole, onRetry }: { cachedRole?: AppRole | null; onRetry: () => void }) => (
  <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6">
    <div className="w-16 h-16 rounded-full bg-warning/20 flex items-center justify-center">
      <WifiOff className="h-8 w-8 text-warning" />
    </div>
    <div className="text-center space-y-2 max-w-sm">
      <h1 className="text-xl font-semibold">You're Offline</h1>
      <p className="text-muted-foreground text-sm">
        {cachedRole 
          ? `Your ${cachedRole} dashboard will load with cached data when connection is restored.`
          : 'Please check your internet connection and try again.'
        }
      </p>
    </div>
    <Button onClick={onRetry} className="gap-2">
      <RefreshCw className="h-4 w-4" />
      Retry Connection
    </Button>
    <p className="text-xs text-muted-foreground/60 text-center mt-4">
      The app works best with an internet connection, but cached data is available when offline.
    </p>
  </div>
);

function DashboardContent() {
  const { user, role, roles, loading, signOut, switchRole, addRole } = useAuth();
  const [pendingRole, setPendingRole] = useState<AppRole | null>(null);
  const navigate = useNavigate();

  // Clear pendingRole when the active role matches it
  useEffect(() => {
    if (pendingRole && role === pendingRole) {
      setPendingRole(null);
    }
  }, [role, pendingRole]);

  const handlePublicRoleSwitch = useCallback(async (newRole: AppRole) => {
    if (newRole === role && !pendingRole) return;
    if (pendingRole) return; // Already switching, ignore taps

    // STRICT OWNERSHIP: only roles the user actually holds may switch.
    // Public roles are NO LONGER auto-granted on tap — that was a silent
    // privilege escalation. Users must apply via ApplyForRoleDialog (handled
    // by the switcher components).
    if (!roles.includes(newRole)) {
      console.warn('[Dashboard] Blocked switch to unowned role:', newRole);
      return;
    }

    setPendingRole(newRole);
    switchRole(newRole);

    // URL is the source of truth for which persona dashboard renders, so
    // every role switch (header dropdown, bottom switcher, etc.) must
    // also update the address bar to the matching `/dashboard/{role}` slug.
    navigate(roleToSlug(newRole), { replace: true });
  }, [role, roles, pendingRole, switchRole, navigate]);

  const { profile } = useProfile();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  
  // INSTANT: Use preloaded session cache for immediate display
  const preloadedRoles = getPreloadedRoles() as AppRole[] | null;
  const [cachedRoles, setCachedRoles] = useState<AppRole[]>(preloadedRoles || []);
  const [showCachedUI, setShowCachedUI] = useState(!!preloadedRoles?.length);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const { toast } = useToast();
  const { fireSuccess } = useConfetti();
  const { isQualifiedInvestor } = useDeployedCapital(user?.id);

  // Derive frozen state from profile (no separate DB call)
  const isFrozen = profile?.is_frozen ?? false;
  const frozenReason = (profile?.frozen_reason || 'Your account has been frozen for violating platform policies.').replace('0708 257 899', '+256777607640');
  

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // URL is source of truth for which persona view is shown
  const urlRole = slugToRole(location.pathname);

  // Keep auth.role aligned with the URL persona (so hooks reading useAuth().role
  // see the right value). This is a side-effect of URL-driven routing.
  useEffect(() => {
    if (loading || !user || roles.length === 0) return;
    if (!urlRole) return;
    if (urlRole === role) return;
    // Only auto-switch into roles the user already has, to avoid silent grants.
    if (roles.includes(urlRole)) {
      switchRole(urlRole);
    }
  }, [urlRole, role, roles, user, loading, switchRole]);

  // Auto-default qualified investors (≥100K deployed) to /funder on INITIAL load only
  const hasAutoDefaulted = useRef(false);
  useEffect(() => {
    if (loading || !user || roles.length === 0) return;
    if (hasAutoDefaulted.current) return; // Only auto-default once per session
    if (!isQualifiedInvestor) return;
    if (areAllRolesUnlocked()) return;
    const preferred = getPreferredDefaultRole();
    if (preferred !== 'auto') return;
    // Only auto-default when the user landed without an explicit persona slug
    // (e.g. bare /dashboard). If they explicitly chose /dashboard/agent or any
    // other persona, respect that choice — never yank them back to /funder.
    if (!urlRole && roles.includes('supporter')) {
      navigate('/dashboard/funder', { replace: true });
    }
    hasAutoDefaulted.current = true;
  }, [loading, user, roles, urlRole, isQualifiedInvestor, navigate]);

  // Handle role switch via URL param (e.g. after tenant/supporter activation)
  // Gate on !loading && roles.length > 0 to prevent race with fetchUserRoles
  useEffect(() => {
    if (loading || roles.length === 0 || !user) return;
    const requestedRole = searchParams.get('role') as AppRole | null;
    if (!requestedRole) return;
    const validRoles: AppRole[] = ['tenant', 'agent', 'landlord', 'supporter', 'manager'];
    if (validRoles.includes(requestedRole) && roles.includes(requestedRole)) {
      navigate(roleToSlug(requestedRole), { replace: true });
      return;
    }
    searchParams.delete('role');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, user, loading, roles, navigate, setSearchParams]);

  // Redirect executive/internal roles to their isolated dashboards
  useEffect(() => {
    if (!user || loading || !role) return;
    if (ISOLATED_ROLES.includes(role)) {
      const route = roleDashboardRoutes[role];
      if (route) {
        navigate(route, { replace: true });
      }
    }
  }, [user, loading, role, navigate]);

   // Handle investment account activation via link (investment_accounts table removed)
  useEffect(() => {
    const activateAccountId = searchParams.get('activate_account');
    if (!activateAccountId || !user) return;

    // investment_accounts table removed - just clear the param
    searchParams.delete('activate_account');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, user, toast, fireSuccess, setSearchParams]);

  // Try to load cached roles for instant display
  useEffect(() => {
    const loadCachedRoles = async () => {
      if (user && roles.length === 0 && loading) {
        try {
          const cached = await getCachedUserRoles(user.id);
          if (cached.length > 0) {
            setCachedRoles(cached as AppRole[]);
            setShowCachedUI(true);
          }
        } catch (e) {
          console.warn('[Dashboard] Failed to load cached roles:', e);
        }
      }
    };
    loadCachedRoles();
  }, [user, roles, loading]);

  // Cache roles when loaded
  useEffect(() => {
    if (user && roles.length > 0) {
      cacheUserRoles(user.id, roles).catch(console.warn);
      setShowCachedUI(false);
    }
  }, [user, roles]);

  // Safety redirect: wait briefly for roles to arrive before redirecting
  useEffect(() => {
    if (loading) return;

    if (!user) {
      navigate('/auth', { replace: true });
      return;
    }

    // Roles may still be loading asynchronously after auth loading finishes.
    // Wait 1.5s before concluding user has no roles to prevent flash redirect.
    if (user && roles.length === 0 && cachedRoles.length === 0) {
      const timeout = setTimeout(() => {
        // Re-check: roles may have arrived during the wait
        if (roles.length === 0 && cachedRoles.length === 0) {
          navigate('/select-role', { replace: true });
        }
      }, 1500);
      return () => clearTimeout(timeout);
    }
  }, [user, loading, roles, cachedRoles, navigate]);

  // URL is the source of truth. Fall back to auth.role only when URL doesn't
  // map to a persona (shouldn't normally happen on persona routes).
  const getDefaultRole = (availableRoles: AppRole[]): AppRole | null => {
    if (availableRoles.length === 0) return null;
    const preferred = getPreferredDefaultRole();
    if (preferred !== 'auto' && availableRoles.includes(preferred as AppRole)) return preferred as AppRole;
    if (availableRoles.includes('supporter')) return 'supporter';
    return availableRoles[0];
  };

  const displayRole = urlRole
    || role
    || (showCachedUI && cachedRoles.length > 0 ? getDefaultRole(cachedRoles) : null);
  const displayRoles = roles.length > 0 ? roles : cachedRoles;

  // PERF: once the visible dashboard has mounted, quietly warm the JS chunks
  // for the other personas this user holds so tapping them renders instantly
  // instead of showing the full-screen loader. Code only — no data fetching.
  // Skipped on save-data / 2G connections and while the tab is hidden.
  const rolesKey = displayRoles.join(',');
  useEffect(() => {
    if (!displayRole || displayRoles.length < 2) return;
    return schedulePreloadOtherRoles(displayRoles, displayRole);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRole, rolesKey]);

  // 🚫 FROZEN ACCOUNT - Block all access
  if (isFrozen) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full space-y-6 text-center">
          <div className="w-20 h-20 rounded-full bg-destructive/20 flex items-center justify-center mx-auto">
            <ShieldAlert className="h-10 w-10 text-destructive" />
          </div>
          <div className="bg-destructive/10 border-2 border-destructive rounded-xl p-6 space-y-3">
            <h1 className="text-xl font-bold text-destructive">🚫 Account Frozen</h1>
            <p className="text-destructive font-medium text-sm leading-relaxed">
              {frozenReason}
            </p>
          </div>
          <div className="bg-destructive/5 border border-destructive/30 rounded-lg p-4 space-y-2">
            <p className="text-sm font-semibold text-destructive">⚠️ All transactions are blocked</p>
            <p className="text-xs text-muted-foreground">
              Deposits, withdrawals, transfers, and all other operations have been suspended pending investigation.
            </p>
          </div>
          <div className="bg-card border rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium">Need help? Contact Support on WhatsApp</p>
            <a href="https://wa.me/256777607640" target="_blank" rel="noopener noreferrer" className="block text-lg font-bold text-green-600 underline">
              💬 +256777607640
            </a>
            <p className="text-xs text-muted-foreground">
              WhatsApp only
            </p>
          </div>
          <button
            onClick={() => signOut()}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

// Allow dashboards to render with cached data when offline
  // Only show offline fallback if we have no cached roles at all
  if (loading && !showCachedUI && !isOnline && cachedRoles.length === 0) {
    return <OfflineFallback cachedRole={null} onRetry={() => window.location.reload()} />;
  }

  // If loading but offline with cached roles, skip loading and show cached UI
  // Needs a real `user`: every dashboard reads `user.id` on first render, and
  // `user` is still null while the session restores (CTO report 2026-09-30,
  // "Cannot read properties of null (reading 'id')" in TenantDashboard). Without
  // one, fall through to the loader below.
  if (loading && !isOnline && cachedRoles.length > 0 && user) {
    // Use cached roles directly, but keep the persona in the URL when we hold it
    // (an agent on /dashboard/agent was being shown cachedRoles[0], the tenant one).
    const cachedDisplayRole = cachedRoles.find((r) => r === urlRole) ?? cachedRoles[0];
    const dashboardProps = {
      user,
      signOut, 
      currentRole: cachedDisplayRole, 
      availableRoles: cachedRoles, 
      onRoleChange: switchRole,
      addRoleComponent: <AddRoleDialog availableRoles={cachedRoles} onAddRole={addRole} />
    };

    return (
      <>
        <Suspense fallback={<DashboardLoadingFallback />}>
          {cachedDisplayRole === 'tenant' && (
            <DashboardErrorBoundary label="tenant dashboard">
              <TenantDashboard {...dashboardProps} />
            </DashboardErrorBoundary>
          )}
          {cachedDisplayRole === 'agent' && (
            <DashboardErrorBoundary label="agent dashboard">
              <AgentDashboard {...dashboardProps} />
            </DashboardErrorBoundary>
          )}
          {cachedDisplayRole === 'supporter' && (
            <DashboardErrorBoundary label="supporter dashboard">
              <SupporterDashboard {...dashboardProps} />
            </DashboardErrorBoundary>
          )}
          {cachedDisplayRole === 'landlord' && (
            <DashboardErrorBoundary label="landlord dashboard">
              <LandlordDashboard {...dashboardProps} />
            </DashboardErrorBoundary>
          )}
          {cachedDisplayRole === 'manager' && (
            <DashboardErrorBoundary label="manager dashboard">
              <ManagerDashboard {...dashboardProps} />
            </DashboardErrorBoundary>
          )}
        </Suspense>
      </>
    );
  }

  if ((loading && !showCachedUI) || pendingRole) {
    return (
      <>
        <DashboardLoadingFallback />
        {/* Keep bottom nav visible during transition for continuity */}
        {pendingRole && displayRole && ['tenant', 'agent', 'landlord', 'supporter'].includes(pendingRole) && (
          <BottomRoleSwitcher currentRole={pendingRole} onRoleChange={handlePublicRoleSwitch} />
        )}
      </>
    );
  }

  // If no user and not loading, the redirect effect above will handle it.
  // Show loading fallback briefly while redirect kicks in.
  if (!user || !displayRole) {
    return <DashboardLoadingFallback />;
  }

  const isPublicRole = ['tenant', 'agent', 'landlord', 'supporter'].includes(displayRole);

  const dashboardProps = { 
    user, 
    signOut, 
    currentRole: displayRole, 
    availableRoles: displayRoles, 
    onRoleChange: handlePublicRoleSwitch,
    addRoleComponent: <AddRoleDialog availableRoles={displayRoles} onAddRole={addRole} />
  };

  const renderDashboard = () => {
    switch (displayRole) {
      case 'tenant':
        return (
          <DashboardErrorBoundary label="tenant dashboard">
            <TenantDashboard {...dashboardProps} />
          </DashboardErrorBoundary>
        );
      case 'agent':
        return (
          <DashboardErrorBoundary label="agent dashboard">
            <AgentDashboard {...dashboardProps} />
          </DashboardErrorBoundary>
        );
      case 'supporter':
        return (
          <DashboardErrorBoundary label="supporter dashboard">
            <SupporterDashboard {...dashboardProps} />
          </DashboardErrorBoundary>
        );
      case 'landlord':
        return (
          <DashboardErrorBoundary label="landlord dashboard">
            <LandlordDashboard {...dashboardProps} />
          </DashboardErrorBoundary>
        );
      case 'manager':
        return (
          <DashboardErrorBoundary label="manager dashboard">
            <ManagerDashboard {...dashboardProps} />
          </DashboardErrorBoundary>
        );
      default:
        return (
          <div className="min-h-screen bg-background flex items-center justify-center">
            <p>Unknown role. Please contact support.</p>
          </div>
        );
    }
  };

  return (
    <>
      {/* Install card now renders inside DashboardHeader, directly below the top nav. */}
      <Suspense fallback={<DashboardLoadingFallback />}>
        {renderDashboard()}
      </Suspense>
      {isPublicRole && (
        <BottomRoleSwitcher currentRole={displayRole} onRoleChange={handlePublicRoleSwitch} />
      )}
    </>
  );
}

// Main Dashboard component — LocationPermissionGate removed (was a passthrough)
export default function Dashboard() {
  return <DashboardContent />;
}
