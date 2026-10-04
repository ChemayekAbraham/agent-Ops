import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Crown, Cpu, Megaphone, MessageSquare, Users, Home, Building2,
  Shield, Activity, BarChart3, Wallet, Handshake, ArrowLeft, Gift, LayoutDashboard,
  ShieldCheck, ChevronRight, Briefcase, FlaskConical
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useStaffPermissions } from '@/hooks/useStaffPermissions';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';

import { supabase } from '@/integrations/supabase/client';
import { Loader2 } from 'lucide-react';
import RunBackupNowButton from '@/components/admin/RunBackupNowButton';
import RentAccessLimitParamsPanel from '@/components/admin/RentAccessLimitParamsPanel';
import RunGscVerifyButton from '@/components/admin/RunGscVerifyButton';
import ScreenLoader from '@/components/common/ScreenLoader';

interface DashboardCard {
  label: string;
  description: string;
  icon: typeof Crown;
  route: string;
  color: string;
  permissionKey: string;
}

const executiveDashboards: DashboardCard[] = [
  { label: 'CEO', description: 'Platform overview & strategy', icon: Crown, route: '/ceo/dashboard', color: 'bg-amber-500/10 text-amber-700 border-amber-500/30', permissionKey: 'ceo' },
  { label: 'CTO', description: 'Infrastructure & engineering', icon: Cpu, route: '/cto/dashboard', color: 'bg-blue-500/10 text-blue-700 border-blue-500/30', permissionKey: 'cto' },
  { label: 'CFO', description: 'Financial governance', icon: BarChart3, route: '/cfo/dashboard', color: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30', permissionKey: 'cfo' },
  { label: 'COO', description: 'Operations health', icon: Activity, route: '/coo/dashboard', color: 'bg-purple-500/10 text-purple-700 border-purple-500/30', permissionKey: 'coo' },
  { label: 'CMO', description: 'Marketing & growth', icon: Megaphone, route: '/cmo/dashboard', color: 'bg-pink-500/10 text-pink-700 border-pink-500/30', permissionKey: 'cmo' },
  { label: 'CRM', description: 'Customer support & disputes', icon: MessageSquare, route: '/crm/dashboard', color: 'bg-orange-500/10 text-orange-700 border-orange-500/30', permissionKey: 'crm' },
  { label: 'HR', description: 'People, recruitment & performance', icon: Briefcase, route: '/hr/dashboard', color: 'bg-cyan-500/10 text-cyan-700 border-cyan-500/30', permissionKey: 'hr' },
  { label: 'R&D', description: 'Missions, signals, experiments & decisions', icon: FlaskConical, route: '/rd', color: 'bg-lime-500/10 text-lime-700 border-lime-500/30', permissionKey: 'rd' },
];

const operationsDashboards: DashboardCard[] = [
  { label: 'Financial Ops', description: 'Deposits, withdrawals, ledger & reconciliation', icon: Wallet, route: '/admin/financial-ops', color: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30', permissionKey: 'financial-ops' },
  { label: 'Company Staff', description: 'Manage employees & staff accounts', icon: Shield, route: '/admin/users', color: 'bg-red-500/10 text-red-700 border-red-500/30', permissionKey: 'company-ops' },
  { label: 'Agent Ops', description: 'Agent performance & activity', icon: Users, route: '/executive-hub?tab=agent-ops', color: 'bg-indigo-500/10 text-indigo-700 border-indigo-500/30', permissionKey: 'agent-ops' },
  { label: 'Tenant Ops', description: 'Tenant metrics & rentals', icon: Home, route: '/executive-hub?tab=tenant-ops', color: 'bg-teal-500/10 text-teal-700 border-teal-500/30', permissionKey: 'tenant-ops' },
  { label: 'Landlord Ops', description: 'Property management', icon: Building2, route: '/executive-hub?tab=landlord-ops', color: 'bg-sky-500/10 text-sky-700 border-sky-500/30', permissionKey: 'landlord-ops' },
  { label: 'Partner Ops', description: 'Supporter portfolios', icon: Handshake, route: '/executive-hub?tab=partners-ops', color: 'bg-violet-500/10 text-violet-700 border-violet-500/30', permissionKey: 'partner-ops' },
  { label: 'Referral Audit', description: 'Bonus status, ledger IDs & trigger reasons', icon: Gift, route: '/admin/referrals', color: 'bg-pink-500/10 text-pink-700 border-pink-500/30', permissionKey: 'financial-ops' },
  { label: 'OAuth Failures', description: 'Failed Google sign-ins by device & reason (7d)', icon: ShieldCheck, route: '/admin/oauth-failures', color: 'bg-rose-500/10 text-rose-700 border-rose-500/30', permissionKey: 'cto' },
  { label: 'Recovery SMS Log', description: 'Overdraft auto-recovery SMS delivery status per provider', icon: MessageSquare, route: '/admin/recovery-sms-log', color: 'bg-amber-500/10 text-amber-700 border-amber-500/30', permissionKey: 'financial-ops' },
];

export default function AdminDashboardPage() {
  const navigate = useNavigate();
  const { user, role } = useAuth();
  const { hasPermission, loading } = useStaffPermissions();
  const loggedRef = useRef(false);

  // Send the user back to whichever persona dashboard matches their active
  // role (agent → /dashboard/agent, tenant → /dashboard/tenant, funder →
  // /dashboard/funder, landlord → /dashboard/landlord, manager → /dashboard/manager).
  const homeDashboard = roleToSlug(role);

  const personaTargets = [
    { label: 'Agent dashboard', route: '/dashboard/agent', icon: Users },
    { label: 'Tenant dashboard', route: '/dashboard/tenant', icon: Home },
    { label: 'Funder dashboard', route: '/dashboard/funder', icon: Handshake },
    { label: 'Owner dashboard', route: '/dashboard/landlord', icon: Building2 },
  ];

  // Log dashboard_accessed
  useEffect(() => {
    if (!user || loggedRef.current) return;
    loggedRef.current = true;
    supabase.from('audit_logs').insert({
      user_id: user.id,
      action_type: 'dashboard_accessed',
      metadata: { dashboard: 'admin-panel', timestamp: new Date().toISOString() },
    });
  }, [user]);

  if (loading) {
    return (
      <ScreenLoader />
    );
  }

  const visibleExecutive = executiveDashboards.filter(d => hasPermission(d.permissionKey));
  const visibleOperations = operationsDashboards.filter(d => hasPermission(d.permissionKey));

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Sticky top bar so the back action is always reachable */}
      <div className="shrink-0 z-40 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-2 text-sm font-medium -ml-2"
                aria-label="Back to personal dashboard"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to personal dashboard
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 bg-popover z-50">
              <DropdownMenuLabel>Open personal dashboard</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {personaTargets.map((p) => (
                <DropdownMenuItem key={p.route} onClick={() => navigate(p.route)} className="gap-2 cursor-pointer">
                  <p.icon className="h-4 w-4" />
                  {p.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2 text-sm"
              >
                <LayoutDashboard className="h-4 w-4" />
                My dashboard
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-popover z-50">
              <DropdownMenuItem onClick={() => navigate(homeDashboard)} className="gap-2 cursor-pointer">
                <LayoutDashboard className="h-4 w-4" />
                My active role dashboard
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {personaTargets.map((p) => (
                <DropdownMenuItem key={p.route} onClick={() => navigate(p.route)} className="gap-2 cursor-pointer">
                  <p.icon className="h-4 w-4" />
                  {p.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto max-w-5xl mx-auto px-4 py-8 space-y-8 w-full">
        <div>
          <h1 className="text-2xl font-black text-foreground">Dashboard Access Panel</h1>
          <p className="text-sm text-muted-foreground mt-1">Open any executive or operations dashboard you have access to</p>
        </div>

        {hasPermission('director') && (
          <button
            onClick={() => navigate('/director/dashboard')}
            className={cn(
              'w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all hover:shadow-md hover:scale-[1.005] active:scale-[0.995]',
              'bg-primary/10 text-primary border-primary/30'
            )}
          >
            <div className="h-11 w-11 rounded-lg flex items-center justify-center bg-background/60">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm">Director Dashboard</p>
              <p className="text-xs text-muted-foreground truncate">Review, approve &amp; audit funding requisitions</p>
            </div>
            <ChevronRight className="h-5 w-5 shrink-0" />
          </button>
        )}

        {visibleExecutive.length > 0 && (
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Executive Dashboards</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleExecutive.map((d) => (
                <button
                  key={d.label}
                  onClick={() => navigate(d.route)}
                  className={cn(
                    'flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all hover:shadow-md hover:scale-[1.01] active:scale-[0.99]',
                    d.color
                  )}
                >
                  <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-background/60">
                    <d.icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm">{d.label} Dashboard</p>
                    <p className="text-xs text-muted-foreground truncate">{d.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {visibleOperations.length > 0 && (
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Operations Dashboards</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleOperations.map((d) => (
                <button
                  key={d.label}
                  onClick={() => navigate(d.route)}
                  className={cn(
                    'flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all hover:shadow-md hover:scale-[1.01] active:scale-[0.99]',
                    d.color
                  )}
                >
                  <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-background/60">
                    <d.icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm">{d.label}</p>
                    <p className="text-xs text-muted-foreground truncate">{d.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {visibleExecutive.length === 0 && visibleOperations.length === 0 && (
          <div className="text-center py-16 space-y-3">
            <Shield className="h-12 w-12 text-muted-foreground/30 mx-auto" />
            <p className="text-muted-foreground font-medium">No dashboards assigned</p>
            <p className="text-sm text-muted-foreground/70">Contact your administrator to get access to specific dashboards.</p>
          </div>
        )}

        {(hasPermission('cto') || hasPermission('cfo')) && (
          <div className="space-y-4">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">System</p>
            {hasPermission('cto') && <RunBackupNowButton />}
            {hasPermission('cto') && <RunGscVerifyButton />}
            {hasPermission('cfo') && <RentAccessLimitParamsPanel />}
          </div>
        )}
      </div>
    </div>
  );
}
