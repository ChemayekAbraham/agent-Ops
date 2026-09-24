import { memo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Home, Users, Wallet, Building2, Shield, ChevronDown, Lock } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { roleDashboardRoutes } from '@/components/layout/executiveSidebarConfig';
import { roleToSlug } from '@/lib/roleRoutes';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import ApplyForRoleDialog from '@/components/ApplyForRoleDialog';
import { useAuth } from '@/hooks/useAuth';
import { useRoleAccessRequests } from '@/hooks/useRoleAccessRequests';

type AppRole = 'tenant' | 'agent' | 'landlord' | 'supporter' | 'manager' | 'ceo' | 'coo' | 'cfo' | 'cto' | 'cmo' | 'crm' | 'employee' | 'operations' | 'super_admin' | 'hr' | 'access_admin' | 'rd';

const MANAGER_ACCESS_CODE = 'Manager@welile';

interface RoleSwitcherProps {
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  onAddRole?: (role: AppRole) => Promise<{ error: Error | null }>;
  variant?: 'header' | 'prominent';
}

const roleConfig: Record<AppRole, { label: string; shortLabel: string; icon: React.ReactNode; emoji: string }> = {
  tenant: { label: 'Tenant', shortLabel: 'Tenant', icon: <Home className="h-3.5 w-3.5" />, emoji: '🏠' },
  agent: { label: 'Agent', shortLabel: 'Agent', icon: <Users className="h-3.5 w-3.5" />, emoji: '👥' },
  supporter: { label: 'Supporter', shortLabel: 'Funder', icon: <Wallet className="h-3.5 w-3.5" />, emoji: '💰' },
  landlord: { label: 'Landlord', shortLabel: 'Owner', icon: <Building2 className="h-3.5 w-3.5" />, emoji: '🏢' },
  manager: { label: 'Manager', shortLabel: 'Admin', icon: <Shield className="h-3.5 w-3.5" />, emoji: '🛡️' },
  ceo: { label: 'CEO', shortLabel: 'CEO', icon: <Shield className="h-3.5 w-3.5" />, emoji: '👔' },
  coo: { label: 'COO', shortLabel: 'COO', icon: <Shield className="h-3.5 w-3.5" />, emoji: '⚙️' },
  cfo: { label: 'CFO', shortLabel: 'CFO', icon: <Wallet className="h-3.5 w-3.5" />, emoji: '💵' },
  cto: { label: 'CTO', shortLabel: 'CTO', icon: <Shield className="h-3.5 w-3.5" />, emoji: '🖥️' },
  cmo: { label: 'CMO', shortLabel: 'CMO', icon: <Users className="h-3.5 w-3.5" />, emoji: '📣' },
  crm: { label: 'CRM', shortLabel: 'CRM', icon: <Users className="h-3.5 w-3.5" />, emoji: '🤝' },
  employee: { label: 'Employee', shortLabel: 'Staff', icon: <Users className="h-3.5 w-3.5" />, emoji: '🧑‍💼' },
  operations: { label: 'Operations', shortLabel: 'Ops', icon: <Shield className="h-3.5 w-3.5" />, emoji: '🔧' },
  super_admin: { label: 'Super Admin', shortLabel: 'S.Admin', icon: <Shield className="h-3.5 w-3.5" />, emoji: '🔑' },
  hr: { label: 'HR', shortLabel: 'HR', icon: <Users className="h-3.5 w-3.5" />, emoji: '👤' },
  access_admin: { label: 'Access Admin', shortLabel: 'Access', icon: <Shield className="h-3.5 w-3.5" />, emoji: '🔐' },
  rd: { label: 'R&D', shortLabel: 'R&D', icon: <Shield className="h-3.5 w-3.5" />, emoji: '🔬' },
};

const ALL_ROLES: AppRole[] = ['tenant', 'agent', 'landlord', 'supporter', 'manager', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'employee', 'operations', 'super_admin', 'hr'];

const RESTRICTED_ROLES: AppRole[] = ['manager', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'employee', 'operations', 'super_admin', 'hr'];

const PUBLIC_ROLES: AppRole[] = ['tenant', 'agent', 'landlord', 'supporter'];

const RoleSwitcher = memo(function RoleSwitcher({ currentRole, availableRoles, onRoleChange, onAddRole, variant = 'header' }: RoleSwitcherProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const { hasApplied, requestRole } = useRoleAccessRequests(user?.id);
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [pendingRole, setPendingRole] = useState<AppRole | null>(null);
  const [accessCode, setAccessCode] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applyRole, setApplyRole] = useState<AppRole | null>(null);

  const handleSwitch = async (role: AppRole) => {
    if (role === currentRole) return;
    hapticTap();

    const hasRole = availableRoles.includes(role);

    if (hasRole) {
      // Already has role — just switch
      if (role === 'manager') {
        navigate('/manager-login');
        return;
      }
      onRoleChange(role);
      const route = roleDashboardRoutes[role];
      navigate(route || roleToSlug(role));
      return;
    }

    // Doesn't have role yet — need to add it
    const isRestricted = RESTRICTED_ROLES.includes(role);

    if (isRestricted) {
      // Prompt for access code
      setPendingRole(role);
      setAccessCode('');
      setCodeDialogOpen(true);
      return;
    }

    // Public role they don't have yet — open the Apply dialog instead of
    // silently granting. Strict ownership: nothing is auto-granted on tap.
    setApplyRole(role);
    setApplyDialogOpen(true);
  };

  const confirmAccessCode = async () => {
    if (accessCode !== MANAGER_ACCESS_CODE) {
      toast({ title: 'Invalid Code', description: 'The access code is incorrect', variant: 'destructive' });
      return;
    }
    if (!pendingRole || !onAddRole) return;

    setIsAdding(true);
    const { error } = await onAddRole(pendingRole);
    setIsAdding(false);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return;
    }

    toast({ title: 'Role Added', description: `You now have access to the ${roleConfig[pendingRole].label} dashboard` });
    setCodeDialogOpen(false);
    setAccessCode('');
    
    if (pendingRole === 'manager') {
      navigate('/manager-login');
    } else {
      onRoleChange(pendingRole);
      const route = roleDashboardRoutes[pendingRole];
      navigate(route || roleToSlug(pendingRole));
    }
    setPendingRole(null);
  };

  const currentConfig = roleConfig[currentRole];

  const accessCodeDialog = (
    <Dialog open={codeDialogOpen} onOpenChange={(open) => { setCodeDialogOpen(open); if (!open) { setPendingRole(null); setAccessCode(''); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-warning" />
            Access Code Required
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Enter the access code to unlock the <strong>{pendingRole ? roleConfig[pendingRole].label : ''}</strong> role.
        </p>
        <div className="space-y-2">
          <Label>Access Code</Label>
          <Input
            type="password"
            placeholder="Enter access code"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmAccessCode()}
          />
        </div>
        <div className="flex gap-2 pt-2">
          <Button variant="outline" onClick={() => setCodeDialogOpen(false)}>Cancel</Button>
          <Button onClick={confirmAccessCode} disabled={isAdding} className="flex-1">
            {isAdding ? 'Adding...' : 'Verify & Switch'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  // Prominent variant — full-width horizontal pills in dashboard body
  if (variant === 'prominent') {
    // Only show public roles + restricted roles the user ALREADY has
    const visibleRoles = ALL_ROLES.filter(r => PUBLIC_ROLES.includes(r) || availableRoles.includes(r));
    return (
      <>
        <div className="w-full">
          <div className="flex items-center gap-1.5 p-1 bg-muted/60 rounded-2xl flex-wrap">
            {visibleRoles.map((role) => {
              const config = roleConfig[role];
              const isActive = role === currentRole;
              const hasRole = availableRoles.includes(role);
              const pending = !hasRole && PUBLIC_ROLES.includes(role) && hasApplied(role);
              return (
                <button
                  key={role}
                  onClick={() => handleSwitch(role)}
                  disabled={isAdding}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl text-sm font-semibold transition-all duration-200 touch-manipulation min-h-[44px] min-w-[80px]",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-md shadow-primary/25"
                      : hasRole
                        ? "text-muted-foreground hover:text-foreground hover:bg-background/60 active:scale-95"
                        : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-background/40 active:scale-95"
                  )}
                >
                  <span className="text-base">{config.emoji}</span>
                  <span className="truncate">{pending ? 'Pending' : config.label}</span>
                  {!hasRole && !pending && <Lock className="h-3 w-3 opacity-60" />}
                </button>
              );
            })}
          </div>
        </div>
        {accessCodeDialog}
        <ApplyForRoleDialog
          open={applyDialogOpen}
          onOpenChange={setApplyDialogOpen}
          role={applyRole}
          hasApplied={applyRole ? hasApplied(applyRole) : false}
          onApply={requestRole}
        />
      </>
    );
  }

  // Header variant — dropdown showing only roles the user can access
  // Only show restricted roles the user ALREADY has — never expose internal roles to consumers
  const visibleRestrictedRoles = RESTRICTED_ROLES.filter(r => availableRoles.includes(r));
  
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 touch-manipulation min-h-[32px] bg-white/15 text-white hover:bg-white/25 max-w-full min-w-0">
            <span className="text-sm shrink-0">{currentConfig.emoji}</span>
            <span className="truncate">{currentConfig.shortLabel}</span>
            <ChevronDown className="h-3 w-3 opacity-70 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-[200px] max-h-[400px] overflow-y-auto">
          {/* Public roles */}
          {PUBLIC_ROLES.map((role) => {
            const config = roleConfig[role];
            const isActive = role === currentRole;
            const hasRole = availableRoles.includes(role);
            const pending = !hasRole && hasApplied(role);
            return (
              <DropdownMenuItem
                key={role}
                onClick={() => handleSwitch(role)}
                disabled={isAdding}
                className={cn(
                  "flex items-center gap-2 cursor-pointer",
                  isActive && "bg-primary/10 text-primary font-semibold"
                )}
              >
                <span className="text-sm">{config.emoji}</span>
                <span className="flex-1">{config.label}</span>
                {!hasRole && (
                  pending
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning">Pending</span>
                    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex items-center gap-1"><Lock className="h-2.5 w-2.5" />Apply</span>
                )}
              </DropdownMenuItem>
            );
          })}
          
          {/* Only show restricted roles the user already has */}
          {visibleRestrictedRoles.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {visibleRestrictedRoles.map((role) => {
                const config = roleConfig[role];
                const isActive = role === currentRole;
                return (
                  <DropdownMenuItem
                    key={role}
                    onClick={() => handleSwitch(role)}
                    disabled={isAdding}
                    className={cn(
                      "flex items-center gap-2 cursor-pointer",
                      isActive && "bg-primary/10 text-primary font-semibold"
                    )}
                  >
                    <span className="text-sm">{config.emoji}</span>
                    <span className="flex-1">{config.label}</span>
                  </DropdownMenuItem>
                );
              })}
            </>
          )}

          {/* My Profile links for employees */}
          {availableRoles.includes('employee') && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                My Profile
              </div>
              <DropdownMenuItem onClick={() => navigate('/my-pay')} className="cursor-pointer">
                <span className="flex-1">My Payslips</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/hr/dashboard/my-work')} className="cursor-pointer">
                <span className="flex-1">My Work</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/your-profile')} className="cursor-pointer">
                <span className="flex-1">My Profile</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/settings')} className="cursor-pointer">
                <span className="flex-1">Settings</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/notifications')} className="cursor-pointer">
                <span className="flex-1">Notifications</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {accessCodeDialog}
      <ApplyForRoleDialog
        open={applyDialogOpen}
        onOpenChange={setApplyDialogOpen}
        role={applyRole}
        hasApplied={applyRole ? hasApplied(applyRole) : false}
        onApply={requestRole}
      />
    </>
  );
});

export default RoleSwitcher;
