import { useState, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import WelileLogo from '@/components/WelileLogo';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Menu, Settings, Download, Home, Users, Wallet, Building2, Shield, ChevronDown, LogOut, Coins, Check, UserRound, Star, Store, Sparkles, TrendingUp, Gauge, FileText, Award, CalendarDays, Trophy, Package, Clock, Banknote } from 'lucide-react';
import { useIsMerchantAgent } from '@/hooks/useIsMerchantAgent';

import { hapticTap } from '@/lib/haptics';
import { AppRole, useAuth } from '@/hooks/useAuth';
import { usePWAInstall } from '@/hooks/usePWAInstall';
import { cn } from '@/lib/utils';
import { TenantInAppNotificationBell } from '@/components/tenant/TenantInAppNotificationBell';
import { AgentNotificationBell } from '@/components/agent/AgentNotificationBell';
import { roleDashboardRoutes } from '@/components/layout/executiveSidebarConfig';
import { roleToSlug } from '@/lib/roleRoutes';

interface MenuItemConfig {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  separator?: boolean;
  badge?: React.ReactNode;
  onPointerEnter?: () => void;
}

interface DashboardHeaderProps {
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  onSignOut: () => Promise<void>;
  menuItems?: MenuItemConfig[];
  opportunityCount?: number;
  onOpportunityBadgeClick?: () => void;
  headerActions?: React.ReactNode;
  hideNotifications?: boolean;
  showInstallPrompt?: boolean;
  compactInstallPrompt?: boolean;
  onMenuClick?: () => void;
}

const roleConfigMap: Record<string, { label: string; emoji: string; icon: React.ReactNode }> = {
  tenant: { label: 'Tenant', emoji: '🏠', icon: <Home className="h-4 w-4" /> },
  agent: { label: 'Agent', emoji: '👥', icon: <Users className="h-4 w-4" /> },
  supporter: { label: 'Funder', emoji: '💰', icon: <Wallet className="h-4 w-4" /> },
  landlord: { label: 'Owner', emoji: '🏢', icon: <Building2 className="h-4 w-4" /> },
  manager: { label: 'Admin', emoji: '🛡️', icon: <Shield className="h-4 w-4" /> },
  ceo: { label: 'CEO', emoji: '👔', icon: <Shield className="h-4 w-4" /> },
  coo: { label: 'COO', emoji: '⚙️', icon: <Shield className="h-4 w-4" /> },
  cfo: { label: 'CFO', emoji: '💵', icon: <Wallet className="h-4 w-4" /> },
  cto: { label: 'CTO', emoji: '🖥️', icon: <Shield className="h-4 w-4" /> },
  cmo: { label: 'CMO', emoji: '📣', icon: <Users className="h-4 w-4" /> },
  crm: { label: 'CRM', emoji: '🤝', icon: <Users className="h-4 w-4" /> },
  employee: { label: 'Employee', emoji: '🧑‍💼', icon: <Users className="h-4 w-4" /> },
  operations: { label: 'Operations', emoji: '🔧', icon: <Shield className="h-4 w-4" /> },
  super_admin: { label: 'Super Admin', emoji: '🔑', icon: <Shield className="h-4 w-4" /> },
};

const defaultRoleConfig = { label: 'Unknown', emoji: '👤', icon: <Users className="h-4 w-4" /> };
const getRoleConfig = (role: string) => roleConfigMap[role] || defaultRoleConfig;

const PUBLIC_ROLES: readonly string[] = [
  'tenant',
  'agent',
  'landlord',
  'supporter',
  'senior_agent',
  'sub_agent',
];

const DashboardHeader = memo(function DashboardHeader({
  currentRole,
  availableRoles,
  onRoleChange,
  onSignOut,
  menuItems = [],
  opportunityCount,
  onOpportunityBadgeClick,
  headerActions,
  hideNotifications = false,
  onMenuClick,
  compactInstallPrompt = false,
}: DashboardHeaderProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { isInstalled, hasPrompt: isInstallable, promptInstall } = usePWAInstall();
  const { isMerchantAgent } = useIsMerchantAgent();
  const [rolePickerOpen, setRolePickerOpen] = useState(false);

  const handleInstallClick = async () => {
    if (isInstallable) {
      await promptInstall();
    } else {
      navigate('/install');
    }
  };

  const handleRoleSwitch = (role: AppRole) => {
    if (role !== currentRole) {
      hapticTap();
      setRolePickerOpen(false);
      if (role === 'manager') {
        navigate('/manager-login');
        return;
      }
      onRoleChange(role);
      const targetRoute = roleDashboardRoutes[role] || roleToSlug(role);
      navigate(targetRoute);
    } else {
      setRolePickerOpen(false);
    }
  };

  const showInstallButton = isInstallable && !isInstalled;
  const visibleRoles = availableRoles.filter((role) => role in roleConfigMap);
  const hasNonPublicRole = availableRoles.some((role) => !PUBLIC_ROLES.includes(role));

  // Check if current user is an executive/admin or an explicitly designated Special Agent
  const isExecutive = availableRoles.some((r) =>
    ['manager', 'super_admin', 'operations', 'agent_operations', 'ceo', 'coo', 'cfo'].includes(r)
  );

  const { data: isSpecialAgent = false } = useQuery({
    queryKey: ['user-is-special-agent-header'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;
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

  const { data: hasPhonePlan = false } = useQuery({
    queryKey: ['user-has-active-smartphone-plan'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;
      const { data } = await supabase.rpc('has_active_smartphone_plan', { p_user: user.id });
      return !!data;
    },
    staleTime: 60_000,
  });

  const canAccessAgentsSpace = isExecutive || isSpecialAgent || hasPhonePlan;
  const showRolePicker = availableRoles.length > 1 || canAccessAgentsSpace;

  return (
    <>
      <header className="sticky top-0 z-50 bg-primary pt-safe">
        <div className="px-3 py-2.5">
          <div className="flex items-center justify-between">
            {/* Left: Logo + tappable role picker */}
            <div className="flex items-center gap-2">
              <WelileLogo showText={false} size="sm" variant="light" linkToHome={true} />

              {/* Tappable role badge — opens role picker */}
              {showRolePicker ? (
                <>
                  <div className="h-3.5 w-px bg-white/20" />
                  <Popover open={rolePickerOpen} onOpenChange={setRolePickerOpen}>
                    <PopoverTrigger asChild>
                      <button className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 active:scale-95 transition-all touch-manipulation min-h-[32px]">
                        <span className="text-sm">{getRoleConfig(currentRole).emoji}</span>
                        <span className="text-xs font-semibold text-white">
                          {getRoleConfig(currentRole).label}
                        </span>
                        <ChevronDown className="h-3 w-3 text-white/60" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent 
                      align="start" 
                      sideOffset={8}
                      className="w-52 p-1.5 rounded-2xl shadow-2xl border bg-primary-foreground backdrop-blur-xl"
                    >
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest px-2 pt-1 pb-1.5">
                        Switch Role
                      </p>
                      {visibleRoles.map((role) => {
                        const config = getRoleConfig(role);
                        const isActive = role === currentRole;
                        return (
                          <button
                            key={role}
                            onClick={() => handleRoleSwitch(role)}
                            className={cn(
                              "w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl text-sm font-medium transition-all touch-manipulation min-h-[44px]",
                              isActive
                                ? "bg-primary/10 text-primary font-semibold"
                                : "text-foreground hover:bg-muted active:scale-[0.98]"
                            )}
                          >
                            <span className="text-base">{config.emoji}</span>
                            <span>{config.label}</span>
                            {isActive && (
                              <Check className="ml-auto h-4 w-4 text-white" />
                            )}
                          </button>
                        );
                      })}
                      {hasNonPublicRole && (
                        <>
                          <div className="my-1.5 h-px bg-border" />
                          <button
                            onClick={() => {
                              setRolePickerOpen(false);
                              navigate('/me');
                            }}
                            className="w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl text-sm font-medium text-foreground hover:bg-muted active:scale-[0.98] transition-all touch-manipulation min-h-[44px]"
                          >
                            <span className="text-base">👤</span>
                            <span>My space</span>
                          </button>
                        </>
                      )}
                      {canAccessAgentsSpace && (
                        <>
                          <div className="my-1.5 h-px bg-border" />
                          <button
                            onClick={() => {
                              setRolePickerOpen(false);
                              navigate('/agents-space');
                            }}
                            className="w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl text-sm font-medium text-foreground hover:bg-muted active:scale-[0.98] transition-all touch-manipulation min-h-[44px]"
                          >
                            <span className="text-base">🎖️</span>
                            <span>Agents' Space</span>
                          </button>
                        </>
                      )}
                    </PopoverContent>

                  </Popover>
                </>
              ) : (
                <>
                  <div className="h-3.5 w-px bg-white/20" />
                  <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 min-h-[32px]">
                    <span className="text-sm">{getRoleConfig(currentRole).emoji}</span>
                    <span className="text-xs font-semibold text-white">
                      {getRoleConfig(currentRole).label}
                    </span>
                  </div>
                </>
              )}

              {/* Opportunity badge for supporters */}
              {opportunityCount !== undefined && opportunityCount > 0 && (
                <button
                  onClick={onOpportunityBadgeClick}
                  className="min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold bg-card text-primary rounded-full px-1 shadow-sm animate-pulse touch-manipulation"
                >
                  {opportunityCount > 99 ? '99+' : opportunityCount}
                </button>
              )}
            </div>

            {/* Right: Notification + Menu */}
            <div className="flex items-center gap-0.5">
              {headerActions}
              {!headerActions && !hideNotifications && currentRole === 'agent' && user?.id && (
                <AgentNotificationBell userId={user.id} />
              )}
              {!headerActions && !hideNotifications && currentRole === 'tenant' && user?.id && (
                <TenantInAppNotificationBell tenantId={user.id} />
              )}

              {onMenuClick ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onMenuClick}
                  aria-label="Open menu"
                  className="h-10 w-10 min-w-[44px] min-h-[44px] text-white/90 hover:text-white hover:bg-white/10 rounded-xl touch-manipulation"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              ) : (
                <DropdownMenu onOpenChange={(open) => {
                  if (open) {
                    void import('@/pages/YourProfile');
                    void import('@/pages/Settings');
                    if (currentRole === 'agent') {
                      void import('@/pages/AgentServiceCenter');
                      void import('@/components/auth/ProxyAgentGuard');
                      void import('@/pages/agent/ProxyPerformanceDashboard');
                      void import('@/pages/AgentCommissionBenefits');
                      void import('@/pages/MerchandiseStore');
                    }
                  }
                }}>
                  <DropdownMenuTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    onPointerEnter={() => {
                      void import('@/pages/YourProfile');
                      if (currentRole === 'agent') {
                        void import('@/pages/AgentServiceCenter');
                        void import('@/components/auth/ProxyAgentGuard');
                        void import('@/pages/agent/ProxyPerformanceDashboard');
                      }
                    }}
                    className="h-10 w-10 min-w-[44px] min-h-[44px] text-white/90 hover:text-white hover:bg-white/10 rounded-xl touch-manipulation"
                  >
                    <Menu className="h-5 w-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent 
                  align="end" 
                  className="w-56 max-h-[70vh] overflow-y-auto bg-primary-foreground backdrop-blur-xl border shadow-2xl rounded-2xl p-1"
                >
                  <DropdownMenuItem
                    onClick={() => navigate('/your-profile')}
                    onPointerEnter={() => void import('@/pages/YourProfile')}
                    onTouchStart={() => void import('@/pages/YourProfile')}
                    className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation"
                  >
                    <div className="p-1.5 rounded-lg bg-primary/10">
                      <UserRound className="h-4 w-4 text-primary" />
                    </div>
                    Your Profile
                  </DropdownMenuItem>
                  {currentRole === 'agent' && isMerchantAgent && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-hub-tab-change', { detail: 'merchant' }));
                        navigate('/dashboard/agent?tab=merchant');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg bg-primary/10">
                          <Banknote className="h-4 w-4 text-primary" />
                        </div>
                        <span className="truncate">Merchant dashboard</span>
                      </div>
                    </DropdownMenuItem>
                  )}
                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => { hapticTap(); navigate('/agent/service-center'); }}
                      onPointerEnter={() => void import('@/pages/AgentServiceCenter')}
                      onTouchStart={() => void import('@/pages/AgentServiceCenter')}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg bg-primary/10">
                          <Store className="h-4 w-4 text-primary" />
                        </div>
                        <span className="truncate">Service Center</span>
                      </div>
                      <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-xs">
                        New
                      </span>
                    </DropdownMenuItem>
                  )}
                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => { hapticTap(); navigate('/dashboard/agent/proxy'); }}
                      onPointerEnter={() => {
                        void import('@/components/auth/ProxyAgentGuard');
                        void import('@/pages/agent/ProxyPerformanceDashboard');
                      }}
                      onTouchStart={() => {
                        void import('@/components/auth/ProxyAgentGuard');
                        void import('@/pages/agent/ProxyPerformanceDashboard');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg bg-primary/10">
                          <Sparkles className="h-4 w-4 text-primary" />
                        </div>
                        <span className="truncate">Proxy Agents</span>
                      </div>
                    </DropdownMenuItem>
                  )}
                  {showInstallButton && (
                    <DropdownMenuItem
                      onClick={handleInstallClick}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation"
                    >
                      <div className="p-1.5 rounded-lg bg-primary/10">
                        <Download className="h-4 w-4 text-primary" />
                      </div>
                      Install App
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'tenant' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('tenant-tab-change', { detail: 'rent-plan' }));
                        navigate('/dashboard/tenant?tab=rent-plan');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <FileText className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Your Rent Plan</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'tenant' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('tenant-tab-change', { detail: 'activity' }));
                        navigate('/dashboard/tenant?tab=activity');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Clock className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Recent Activity</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-hub-tab-change', { detail: 'money' }));
                        navigate('/dashboard/agent?tab=money');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Wallet className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Money</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-hub-tab-change', { detail: 'tenants' }));
                        navigate('/dashboard/agent?tab=tenants');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Users className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Tenants</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-hub-tab-change', { detail: 'grow' }));
                        navigate('/dashboard/agent?tab=grow');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <TrendingUp className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">More</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-hub-tab-change', { detail: 'league' }));
                        navigate('/dashboard/agent?tab=league');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Trophy className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Collection League</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-hub-tab-change', { detail: 'portfolio' }));
                        navigate('/dashboard/agent?tab=portfolio');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Package className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">My Repayment Portfolio</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-open-list-house'));
                        navigate('/dashboard/agent?action=list-house');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Building2 className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">List House</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-open-my-listings'));
                        navigate('/dashboard/agent?action=my-listings');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Building2 className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">My listed houses</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-open-collect-from-receipt'));
                        navigate('/dashboard/agent?action=collect-from-receipt');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <FileText className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Collect from a receipt</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-open-field-collections'));
                        navigate('/dashboard/agent?action=field-collections');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <CalendarDays className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Field Collections</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-open-rating'));
                        navigate('/dashboard/agent?action=rating');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Gauge className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Your Rating</span>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => {
                        hapticTap();
                        window.dispatchEvent(new CustomEvent('agent-open-free-service-center'));
                        navigate('/dashboard/agent?action=free-service-center');
                      }}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                          <Award className="h-4 w-4" style={{ color: '#7214c9' }} />
                        </div>
                        <span className="truncate">Free Service Centre</span>
                      </div>
                    </DropdownMenuItem>
                  )}






                  {currentRole === 'agent' && (
                    <DropdownMenuItem
                      onClick={() => navigate('/agent-commission-benefits')}
                      onPointerEnter={() => void import('@/pages/AgentCommissionBenefits')}
                      onTouchStart={() => void import('@/pages/AgentCommissionBenefits')}
                      className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation"
                    >
                      <div className="p-1.5 rounded-lg" style={{ backgroundColor: 'rgba(114, 20, 201, 0.1)' }}>
                        <Coins className="h-4 w-4" style={{ color: '#7214c9' }} />
                      </div>
                      Agent Commission Benefits
                    </DropdownMenuItem>
                  )}



                  {menuItems.length > 0 && <DropdownMenuSeparator />}
                  
                  {menuItems.map((item, index) => (
                    <div key={index}>
                      {item.separator && index > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        onClick={item.onClick}
                        onPointerEnter={item.onPointerEnter}
                        onTouchStart={item.onPointerEnter}
                        className={cn(
                          "gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation flex items-center justify-between",
                          item.destructive ? 'text-destructive' : ''
                        )}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={cn(
                            "p-1.5 rounded-lg shrink-0",
                            item.destructive ? "bg-destructive/10" : "bg-muted"
                          )}>
                            <item.icon className={cn("h-4 w-4", item.destructive && "text-destructive")} />
                          </div>
                          <span className="truncate">{item.label}</span>
                        </div>
                        {item.badge !== undefined && item.badge !== null && item.badge !== false && item.badge !== '' && (
                          <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-primary/15 text-primary shrink-0">
                            {item.badge}
                          </span>
                        )}
                      </DropdownMenuItem>
                    </div>
                  ))}
                  
                  <DropdownMenuSeparator />
                  <DropdownMenuItem 
                    onClick={() => navigate('/settings')} 
                    onPointerEnter={() => void import('@/pages/Settings')}
                    onTouchStart={() => void import('@/pages/Settings')}
                    className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium touch-manipulation"
                  >
                    <div className="p-1.5 rounded-lg bg-muted">
                      <Settings className="h-4 w-4" />
                    </div>
                    Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem 
                    onClick={() => { hapticTap(); onSignOut(); }}
                    className="gap-3 cursor-pointer py-3 px-3 rounded-xl text-sm font-medium text-destructive touch-manipulation"
                  >
                    <div className="p-1.5 rounded-lg bg-destructive/10">
                      <LogOut className="h-4 w-4 text-destructive" />
                    </div>
                    Sign Out
                  </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </div>
      </header>

    </>
  );
});

export default DashboardHeader;
