import { ReactNode, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth, type AppRole } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Lock, ArrowLeft, Send, Clock, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRoleAccessRequests } from '@/hooks/useRoleAccessRequests';
import { useStaffPermissions } from '@/hooks/useStaffPermissions';
import { isStaffRole, isPublicRole } from '@/lib/roleConstants';
import { useToast } from '@/hooks/use-toast';
import PhoneVerificationGate from '@/components/auth/PhoneVerificationGate';
import StalledLoaderWatchdog from '@/components/common/StalledLoaderWatchdog';
import NotFound from '@/pages/NotFound';
import { loginTelemetry as lt } from '@/lib/loginTelemetry';

interface RoleGuardProps {
  allowedRoles: AppRole[];
  children: ReactNode;
  redirectTo?: string;
  /**
   * Dashboard key matching `staff_permissions.permitted_dashboard`.
   *
   * When set, the user must hold BOTH an allowed role AND a grant for this
   * key. Denial renders the 404 page rather than an access-denied screen, so
   * an ungranted route is indistinguishable from one that does not exist.
   *
   * When omitted, behaviour is unchanged: role check only, with the existing
   * explanatory screen and "apply for access" flow.
   */
  requiredPermission?: string;
}

export default function RoleGuard({
  allowedRoles,
  children,
  redirectTo = '/dashboard/tenant',
  requiredPermission,
}: RoleGuardProps) {
  const { user, roles, loading } = useAuth();
  const { hasPermission, loading: permsLoading } = useStaffPermissions();
  const loggedRef = useRef(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { requests, requestRole, loading: reqLoading } = useRoleAccessRequests(user?.id);
  const [submitting, setSubmitting] = useState<AppRole | null>(null);

  const hasRoleAccess = roles.some((r) => allowedRoles.includes(r));
  const hasGrant = !requiredPermission || hasPermission(requiredPermission);
  const hasAccess = hasRoleAccess && hasGrant;

  // One-shot telemetry when the guard resolves: which path we ended on.
  useEffect(() => {
    if (loading) {
      lt.mark('guard.loading', { path: window.location.pathname, allowedRoles });
      return;
    }
    if (!user) {
      lt.mark('guard.no_user_redirect', { path: window.location.pathname });
      return;
    }
    lt.mark(
      'guard.resolved',
      {
        path: window.location.pathname,
        allowedRoles,
        requiredPermission,
        userRoles: roles,
        hasRoleAccess,
        hasGrant,
        hasAccess,
      },
      hasAccess ? 'ok' : 'denied',
    );
  }, [loading, user?.id, hasAccess, roles.join(','), allowedRoles.join(','), requiredPermission]);

  // Log unauthorized access attempts
  useEffect(() => {
    if (loading || permsLoading || !user || hasAccess || loggedRef.current) return;
    loggedRef.current = true;

    supabase.from('audit_logs').insert({
      user_id: user.id,
      action_type: 'unauthorized_access_attempt',
      metadata: {
        attempted_roles: allowedRoles,
        required_permission: requiredPermission ?? null,
        // Distinguishes "wrong role" from "right role, no grant" — the second
        // is the case worth reviewing, because it is a member of staff probing
        // a dashboard they were deliberately not given.
        denied_by: !hasRoleAccess ? 'role' : 'grant',
        user_roles: roles,
        path: window.location.pathname,
        timestamp: new Date().toISOString(),
      },
    });
  }, [loading, permsLoading, user, hasAccess, hasRoleAccess, allowedRoles, requiredPermission, roles]);

  if (loading || (requiredPermission && permsLoading)) {
    return <StalledLoaderWatchdog label="Signing you in\u2026" />;
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  // Grant-gated route, access denied for any reason -> behave as if the route
  // does not exist. No role names, no "request access" button, no signal that
  // there is anything here to find.
  if (requiredPermission && !hasAccess) {
    return <NotFound />;
  }

  if (!hasAccess) {
    // Determine the exact reason for the lock so the user understands
    // why they can't open this dashboard.
    const applicableRoles = allowedRoles.filter(
      (r) => isPublicRole(r) || isStaffRole(r),
    );
    // Prefer the first non-super_admin role as the one to apply for
    const primaryRole =
      applicableRoles.find((r) => r !== 'super_admin' && r !== 'cto') ||
      applicableRoles[0];

    const pending = requests.find(
      (r) => allowedRoles.includes(r.requested_role as AppRole) && r.status === 'pending',
    );
    const rejected = requests.find(
      (r) => allowedRoles.includes(r.requested_role as AppRole) && r.status === 'rejected',
    );

    const staffOnly = allowedRoles.every((r) => isStaffRole(r));

    let reason: 'pending' | 'rejected' | 'staff-only' | 'missing-role' = 'missing-role';
    if (pending) reason = 'pending';
    else if (rejected) reason = 'rejected';
    else if (staffOnly) reason = 'staff-only';

    const titleMap: Record<typeof reason, string> = {
      pending: 'Application pending',
      rejected: 'Access request was declined',
      'staff-only': 'Staff dashboard',
      'missing-role': 'You don\u2019t have access to this dashboard',
    };
    const descMap: Record<typeof reason, string> = {
      pending: `Your request for the ${pending?.requested_role} role is still under review. You\u2019ll be notified once it\u2019s approved.`,
      rejected: `Your previous request for the ${rejected?.requested_role} role was declined${rejected?.rejection_reason ? `: \u201C${rejected.rejection_reason}\u201D` : '.'} Please contact support if you believe this is a mistake.`,
      'staff-only': `This dashboard is restricted to internal staff (${allowedRoles.join(', ')}). Staff roles can only be assigned by an administrator \u2014 they cannot be self-requested.`,
      'missing-role': `This area requires one of these roles: ${allowedRoles.join(', ')}. Your current roles: ${roles.length ? roles.join(', ') : 'none'}.`,
    };
    const IconMap = {
      pending: Clock,
      rejected: ShieldAlert,
      'staff-only': Lock,
      'missing-role': Lock,
    } as const;
    const Icon = IconMap[reason];

    const handleApply = async () => {
      if (!primaryRole) return;
      setSubmitting(primaryRole);
      const { error } = await requestRole(primaryRole);
      setSubmitting(null);
      if (error) {
        toast({ title: 'Could not submit request', description: error.message, variant: 'destructive' });
      } else {
        toast({ title: 'Request submitted', description: `We\u2019ll notify you once your ${primaryRole} access is reviewed.` });
      }
    };

    const canApply =
      reason === 'missing-role' &&
      !!primaryRole &&
      isPublicRole(primaryRole) &&
      !reqLoading;

    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6 py-10">
        <div className="max-w-md w-full text-center space-y-5">
          <div className="mx-auto h-16 w-16 rounded-full bg-muted flex items-center justify-center">
            <Icon className="h-7 w-7 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-foreground">{titleMap[reason]}</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">{descMap[reason]}</p>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-left text-xs space-y-1">
            <div><span className="font-semibold">Required:</span> {allowedRoles.join(', ')}</div>
            <div><span className="font-semibold">You have:</span> {roles.length ? roles.join(', ') : 'none'}</div>
            {pending && (
              <div><span className="font-semibold">Pending since:</span> {new Date(pending.created_at).toLocaleDateString()}</div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {canApply && (
              <Button onClick={handleApply} disabled={submitting === primaryRole} className="gap-2">
                {submitting === primaryRole ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Apply for {primaryRole} access
              </Button>
            )}
            <Button variant="outline" onClick={() => navigate(redirectTo)} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Back to my dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <PhoneVerificationGate>{children}</PhoneVerificationGate>;
}
