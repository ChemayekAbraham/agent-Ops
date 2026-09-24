import { memo, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Home, Users, Wallet, Building2, ShieldCheck, Lock } from "lucide-react";
import { hapticTap } from "@/lib/haptics";
import { AppRole } from "@/hooks/useAuth";
import { useAuth } from "@/hooks/useAuth";
import { roleDashboardRoutes } from "@/components/layout/executiveSidebarConfig";
import { roleToSlug } from "@/lib/roleRoutes";
import { preloadRole } from "@/lib/preloadRoleDashboards";
import { useDeployedCapital } from "@/hooks/useDeployedCapital";
import { useRoleAccessRequests } from "@/hooks/useRoleAccessRequests";
import { areAllRolesUnlocked } from "@/hooks/useAppPreferences";
import ApplyForRoleDialog from "@/components/ApplyForRoleDialog";
import {
  FLOATING_NAV_ITEM,
  FLOATING_NAV_LABEL,
  FLOATING_NAV_SHELL,
  FLOATING_NAV_SHELL_STYLE,
  FloatingNavRow,
  SlidingIndicator,
  useSlidingIndicator,
} from "@/components/ui/floating-nav";

interface BottomRoleSwitcherProps {
  currentRole: AppRole;
  onRoleChange: (role: AppRole) => void;
}

const PUBLIC_ROLES: { role: AppRole; label: string; icon: typeof Home }[] = [
  { role: "tenant", label: "Tenant", icon: Home },
  { role: "agent", label: "Agent", icon: Users },
  { role: "supporter", label: "Funder", icon: Wallet },
  { role: "landlord", label: "Owner", icon: Building2 },
];

const GATED_ROLES: AppRole[] = ["tenant", "agent", "landlord"];
const STAFF_ROLES: AppRole[] = [
  "manager",
  "super_admin",
  "employee",
  "operations",
  "ceo",
  "coo",
  "cfo",
  "cto",
  "cmo",
  "crm",
];

const BottomRoleSwitcher = memo(function BottomRoleSwitcher({ currentRole, onRoleChange }: BottomRoleSwitcherProps) {
  const navigate = useNavigate();
  const { user, roles } = useAuth();
  const { isQualifiedInvestor } = useDeployedCapital(user?.id);
  const { hasApplied, requestRole } = useRoleAccessRequests(user?.id);

  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applyRole, setApplyRole] = useState<AppRole | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const hasStaffRole = roles.some((r) => STAFF_ROLES.includes(r));
  const staffRole = roles.find((r) => STAFF_ROLES.includes(r));

  // A user who already holds every public persona (or an all-access staff role)
  // should never be prompted to "request access" — they already have the role.
  const hasAllPublicRoles = PUBLIC_ROLES.every(({ role }) => roles.includes(role));
  const hasAllAccessStaffRole = roles.includes("super_admin") || roles.includes("manager");

  const isRoleGated = (role: AppRole): boolean => {
    // Strict ownership: a role is gated unless the user actually holds it.
    // The dev-only "unlock all" preference still bypasses the gate.
    if (areAllRolesUnlocked()) return false;
    // Users who already have every role (or an all-access staff role) are never gated.
    if (hasAllPublicRoles || hasAllAccessStaffRole) return false;
    if (roles.includes(role)) return false;
    return true;
  };

  const handleSwitch = (role: AppRole) => {
    if (role === currentRole) return;
    hapticTap();

    // Warm the chunk as early as possible in case idle preloading hasn't run.
    preloadRole(role);

    // Check if role is gated for qualified investors
    if (isRoleGated(role)) {
      const label = PUBLIC_ROLES.find((r) => r.role === role)?.label ?? role;
      setAnnouncement(`${label} dashboard is locked. Opening access request.`);
      setApplyRole(role);
      setApplyDialogOpen(true);
      return;
    }

    const label = PUBLIC_ROLES.find((r) => r.role === role)?.label ?? role;
    setAnnouncement(`Switched to ${label} dashboard`);
    onRoleChange(role);
    // Sync URL with the new persona — URL is the source of truth.
    navigate(roleToSlug(role));
  };

  const handleStaffNav = () => {
    hapticTap();
    setAnnouncement("Opening Staff hub");
    if (staffRole) {
      const route = roleDashboardRoutes[staffRole] || "/admin/dashboard";
      navigate(route);
    }
  };

  const showStaffTab = hasStaffRole && !["tenant", "agent", "landlord", "supporter"].includes(currentRole);
  const cols = showStaffTab ? 5 : 4;

  const [mounted, setMounted] = useState(false);
  const [isMapExpanded, setIsMapExpanded] = useState(() => (typeof document !== 'undefined' ? document.body.dataset.mapExpanded === 'true' : false));

  useEffect(() => {
    setMounted(true);
    const updateExpanded = () => {
      setIsMapExpanded(document.body.dataset.mapExpanded === 'true');
    };
    const observer = new MutationObserver(updateExpanded);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-map-expanded'] });
    return () => observer.disconnect();
  }, []);

  const activeIndex = PUBLIC_ROLES.findIndex(({ role }) => role === currentRole);
  const { containerRef, setItemRef, indicatorStyle } = useSlidingIndicator(activeIndex, [currentRole, cols]);

  const navContent = (
    <>
      {/* Polite live region — screen readers announce role changes without stealing focus */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>

      <nav
        aria-label="Switch dashboard role"
        className={cn(FLOATING_NAV_SHELL, "z-[100] max-w-lg mx-auto")}
        style={FLOATING_NAV_SHELL_STYLE}
      >
        <FloatingNavRow containerRef={containerRef}>
          <SlidingIndicator style={indicatorStyle} />
          {PUBLIC_ROLES.map(({ role, label, icon: Icon }, index) => {
            const isActive = role === currentRole;
            const gated = isRoleGated(role);
            const pending = gated && hasApplied(role);
            return (
              <button
                key={role}
                ref={setItemRef(index)}
                onClick={() => handleSwitch(role)}
                onPointerDown={() => {
                  // Warm on intent: starts the chunk fetch on touch-down,
                  // buying a head start before the tap completes.
                  if (role !== currentRole && !gated) preloadRole(role);
                }}
                aria-label={`${label}${isActive ? ' (current)' : ''}${gated ? ' (locked)' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  FLOATING_NAV_ITEM,
                  isActive
                    ? "text-primary"
                    : gated
                      ? "text-muted-foreground/40"
                      : "text-muted-foreground hover:text-foreground",
                )}
              >
                <div className="relative flex items-center justify-center">
                  <Icon
                    className={cn("h-5 w-5 transition-transform", isActive && "text-primary scale-110")}
                    strokeWidth={isActive ? 2.5 : 2}
                  />
                  {gated && (
                    <div className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-warning/20 flex items-center justify-center">
                      <Lock className="h-2 w-2 text-warning" />
                    </div>
                  )}
                </div>
                <span
                  className={cn(
                    FLOATING_NAV_LABEL,
                    isActive && "text-primary",
                    pending && "text-warning",
                  )}
                >
                  {pending ? "Pending" : label}
                </span>
              </button>
            );
          })}
          {hasStaffRole && !["tenant", "agent", "landlord", "supporter"].includes(currentRole) && (
            <button
              onClick={handleStaffNav}
              aria-label="Staff hub"
              className={cn(FLOATING_NAV_ITEM, "text-muted-foreground hover:text-foreground")}
            >
              <ShieldCheck className="h-5 w-5" />
              <span className={FLOATING_NAV_LABEL}>Staff</span>
            </button>
          )}
        </FloatingNavRow>
      </nav>

      <ApplyForRoleDialog
        open={applyDialogOpen}
        onOpenChange={setApplyDialogOpen}
        role={applyRole}
        hasApplied={applyRole ? hasApplied(applyRole) : false}
        onApply={requestRole}
      />
    </>
  );

  if (!mounted || isMapExpanded) return null;
  return createPortal(navContent, document.body);
});

export default BottomRoleSwitcher;
