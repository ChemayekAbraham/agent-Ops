import { useState, useEffect, useRef, lazy, Suspense, ReactNode } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth, type AppRole } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { LogOut, Menu, X, ArrowLeft, RotateCcw, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Search } from 'lucide-react';
import RoleSwitcher from '@/components/RoleSwitcher';
import { SidebarSkeleton, TopBarSkeleton } from '@/components/skeletons/SectionSkeletons';
import { executiveSidebarConfig, roleLabels, roleDashboardRoutes } from './executiveSidebarConfig';
import { PARTNER_OPS_ATTENTION_ITEM_IDS } from './executiveSidebarConfig';
import { useQuery } from '@tanstack/react-query';
import type { SidebarSection, SidebarItem } from './executiveSidebarConfig';
import { useStaffPermissions } from '@/hooks/useStaffPermissions';

import { BudgetDepartmentNotificationBell } from '@/components/budget/BudgetDepartmentNotificationBell';
import { MissionBanner } from '@/components/mission/MissionBanner';

/** Shared "My Work" tab, available on every executive dashboard. Lazy so
 *  dashboards that never open the tab do not pay for it. */
const MyWork = lazy(() => import('@/hr/components/MyWork'));


interface ExecutiveDashboardLayoutProps {
  role: string;
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: ReactNode;
  /** Optional badge counts keyed by sidebar item id (e.g. { advances: 3 }). */
  badges?: Record<string, number>;
  /** Sidebar item ids whose badge should beam (pulse red) until the tab is opened. */
  pulseBadgeIds?: string[];
  /** Optional extra actions rendered in the top bar (e.g. a notification bell). */
  headerActions?: ReactNode;
}

export default function ExecutiveDashboardLayout({
  role,
  activeTab,
  onTabChange,
  children,
  badges,
  pulseBadgeIds,
  headerActions,
}: ExecutiveDashboardLayoutProps) {
  const { user, roles, signOut, switchRole, addRole } = useAuth();
  const { hasPermission } = useStaffPermissions();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Desktop sidebar can be tucked away ("moved out") to give the content the
  // full width, and brought back with the same control. Persisted per browser.
  const [sidebarHidden, setSidebarHidden] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('exec-sidebar-hidden') === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    setSidebarHidden((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('exec-sidebar-hidden', next ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };
  const [checkingProfile, setCheckingProfile] = useState(true);
  const [navQuery, setNavQuery] = useState('');
  const loggedRef = useRef(false);

  /**
   * Partner Ops attention indicator. One call per layout mount for the current
   * month. If the caller's role means the RPC returns nothing (or errors), the
   * count stays 0 and the sidebar renders exactly as before — no error state.
   */
  const partnerOpsMonth = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  })();
  const { data: partnerOpsRedCount = 0 } = useQuery({
    queryKey: ['sidebar-partner-ops-red', partnerOpsMonth],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_ops_scoreboard', {
        p_month: partnerOpsMonth,
      });
      if (error) return 0;
      const rows = (data || []) as Array<{ state?: string }>;
      return rows.filter((r) => r?.state === 'red').length;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const hasPartnerOpsAlert = (itemId: string) =>
    partnerOpsRedCount > 0 && PARTNER_OPS_ATTENTION_ITEM_IDS.includes(itemId);

  useEffect(() => {
    if (!user) { setCheckingProfile(false); return; }
    setCheckingProfile(false);
  }, [user]);

  // Log dashboard_accessed
  useEffect(() => {
    if (!user || loggedRef.current) return;
    loggedRef.current = true;
    supabase.from('audit_logs').insert({
      user_id: user.id,
      action_type: 'dashboard_accessed',
      metadata: { dashboard: role, timestamp: new Date().toISOString() },
    });
  }, [user, role]);

  const allSections: SidebarSection[] = executiveSidebarConfig[role] || [];

  /**
   * An item renders only when the signed-in person could actually open its
   * route. Items with no `access` field keep their previous always-visible
   * behaviour.
   */
  const canSeeItem = (item: SidebarItem) => {
    if (!item.access) return true;
    if (item.access === 'signed-in') return !!user;
    if (!user) return false;
    const roleOk = item.access.roles.some((r) => roles.includes(r));
    if (!roleOk) return false;
    if (item.access.permission && !hasPermission(item.access.permission)) return false;
    return true;
  };

  // Groups whose items are all hidden drop their heading too. Children run
  // through the same gate, and a parent whose every child is hidden is dropped
  // with them — an expander that opens onto nothing is worse than no expander.
  const sections: SidebarSection[] = allSections
    .map((s) => ({
      ...s,
      items: s.items.filter(canSeeItem).map((item) =>
        item.children
          ? { ...item, children: item.children.filter(canSeeItem) }
          : item,
      ).filter((item) => !item.children || item.children.length > 0),
    }))
    .filter((s) => s.items.length > 0);

  /** True when the item's own label, or any child's, matches the nav filter. */
  const matchesQuery = (item: SidebarItem, q: string): boolean => {
    if (!q) return true;
    if (item.label.toLowerCase().includes(q)) return true;
    return (item.children ?? []).some((c) => c.label.toLowerCase().includes(q));
  };

  const displayRole = roleLabels[role as AppRole] || role.toUpperCase();

  /**
   * Per-section open state for collapsible groups (e.g. COO → Reports).
   * Initialised from the section's `defaultOpen`, but auto-opened when the
   * current route matches one of its items so the active page is visible.
   */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    sections.forEach((s) => {
      if (s.collapsible) init[s.title] = s.defaultOpen ?? false;
    });
    return init;
  });

  /**
   * Expansion state for parents that have children (e.g. CRM → Call Center).
   * Separate from `openGroups`, which tracks whole sections.
   */
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});


  // When the URL changes, force-open the group containing the active route.
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev };
      sections.forEach((s) => {
        if (!s.collapsible) return;
        const hasActive = s.items.some((it) =>
          it.route
            ? location.pathname === it.route || location.pathname.startsWith(it.route + '/')
            : activeTab === it.id,
        );
        if (hasActive) next[s.title] = true;
        else if (next[s.title] === undefined) next[s.title] = s.defaultOpen ?? false;
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, activeTab, role]);

  /**
   * Sync ?section=<id> from the URL → activeTab state. This means a deep link like
   * /cfo/dashboard?section=platform-impact opens that view AND highlights the row.
   * NOTE: this MUST match the param used by `usePersistedActiveTab` (`?section`).
   * Using a different param (`?tab`) here caused the two to clobber each other on
   * every navigation, resetting the view back to Overview (the "flash" bug).
   */
  useEffect(() => {
    const urlTab = searchParams.get('section');
    if (urlTab && urlTab !== activeTab) {
      onTabChange(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /**
   * When a sidebar tab is clicked, push the tab id into the URL so refresh /
   * link sharing keeps the highlight. Route items still navigate to their URL.
   */
  const handleItemClick = (item: { id: string; route?: string }) => {
    if (item.route) {
      navigate(item.route);
      return;
    }
    onTabChange(item.id);
    // `onTabChange` (usePersistedActiveTab) already writes `?section`. Avoid a
    // second competing setSearchParams call here — two calls in the same tick
    // clobber each other (last write wins) and drop a param.
  };

  /**
   * A sidebar item is "active" when:
   *  - it has a route AND the current pathname starts with that route, OR
   *  - it is a tab-style item whose id matches activeTab.
   */
  const isItemActive = (item: { id: string; route?: string }) => {
    if (item.route) {
      return location.pathname === item.route ||
        location.pathname.startsWith(item.route + '/');
    }
    return activeTab === item.id;
  };

  // Keep the parent of the active child open, so the current view is never
  // hidden inside a collapsed expander after a refresh or a deep link.
  useEffect(() => {
    const activeParents = sections.flatMap((s) =>
      s.items.filter((it) => (it.children ?? []).some((c) => isItemActive(c))).map((it) => it.id),
    );
    if (activeParents.length === 0) return;
    setOpenItems((prev) => {
      const missing = activeParents.filter((id) => !prev[id]);
      if (missing.length === 0) return prev;
      const next = { ...prev };
      missing.forEach((id) => { next[id] = true; });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, activeTab, role]);

  /**
   * Clear the persisted sidebar tab for THIS role+route combo and reset the
   * dashboard back to the default overview view. Mirrors the storage key
   * convention used by `usePersistedActiveTab`.
   */
  const handleResetSelection = () => {
    try {
      window.localStorage.removeItem(
        `dashboard:${role}:${location.pathname}:activeTab`,
      );
    } catch {
      /* storage unavailable */
    }
    onTabChange('overview');
    // `onTabChange('overview')` already clears the `?section` param via the hook.
  };

  const handleRoleChange = (newRole: AppRole) => {
    switchRole(newRole);
    const route = roleDashboardRoutes[newRole];
    if (route) {
      navigate(route);
    } else {
      navigate(roleToSlug(newRole));
    }
  };

  const handleExit = () => {
    navigate(roleToSlug(role as AppRole));
  };

  /**
   * One sidebar row. `depth` only indents — the markup is otherwise identical at
   * both levels, so parents and children stay visually consistent and every
   * existing (childless) dashboard renders exactly as it did before.
   */
  const renderNavLeaf = (item: SidebarItem, depth: number, onItemClick?: () => void) => (
    <button
      key={item.id}
      type="button"
      onClick={() => {
        handleItemClick(item);
        setNavQuery('');
        onItemClick?.();
      }}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all select-none relative',
        'active:scale-[0.98]',
        depth > 0 && 'pl-9 text-[13px]',
        isItemActive(item)
          ? 'bg-primary/10 text-primary font-semibold'
          : 'text-muted-foreground hover:bg-primary/5 hover:text-primary'
      )}
      style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
    >
      {hasPartnerOpsAlert(item.id) && (
        <span
          aria-hidden="true"
          className="-ml-2 mr-0 w-1 self-stretch shrink-0 rounded-full bg-destructive"
        />
      )}
      <item.icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
      {hasPartnerOpsAlert(item.id) && (
        <span
          title={`${partnerOpsRedCount} lead${partnerOpsRedCount === 1 ? '' : 's'} off track`}
          className="ml-auto shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold leading-none"
        >
          {partnerOpsRedCount > 99 ? '99+' : partnerOpsRedCount}
        </span>
      )}
      {badges && badges[item.id] > 0 && (
        <span
          className={cn(
            'ml-auto shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-none',
            pulseBadgeIds?.includes(item.id) &&
              'animate-pulse ring-2 ring-rose-500/40 shadow-[0_0_10px_2px_hsl(var(--destructive)/0.6)]',
          )}
        >
          {badges[item.id] > 99 ? '99+' : badges[item.id]}
        </span>
      )}
    </button>
  );

  /**
   * A leaf, or a parent that expands to reveal its children. A parent with
   * children is a disclosure, not a destination: clicking it toggles and never
   * changes the view, so its landing page lives in a child entry (Call Center →
   * Overview) rather than being hidden behind the parent id.
   */
  const renderNavItem = (item: SidebarItem, q: string, onItemClick?: () => void) => {
    const children = item.children ?? [];
    if (children.length === 0) return renderNavLeaf(item, 0, onItemClick);

    // While filtering, show only the children that matched — unless the parent
    // label itself matched, in which case the whole group is the result.
    const parentMatched = !q || item.label.toLowerCase().includes(q);
    const shownChildren = q && !parentMatched
      ? children.filter((c) => c.label.toLowerCase().includes(q))
      : children;

    // Forced open while filtering, so a match is never hidden behind a chevron.
    const expanded = q ? true : !!openItems[item.id];
    const childActive = children.some((c) => isItemActive(c));

    return (
      <div key={item.id}>
        <button
          type="button"
          onClick={() => setOpenItems((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
          aria-expanded={expanded}
          className={cn(
            'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all select-none',
            'active:scale-[0.98]',
            childActive
              ? 'text-primary font-semibold'
              : 'text-muted-foreground hover:bg-primary/5 hover:text-primary',
          )}
          style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
        >
          <item.icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{item.label}</span>
          {expanded ? (
            <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" />
          )}
        </button>
        {expanded && (
          <div className="mt-1 space-y-1">
            {shownChildren.map((child) => renderNavLeaf(child, 1, onItemClick))}
          </div>
        )}
      </div>
    );
  };

  const SidebarContent = ({ onItemClick }: { onItemClick?: () => void }) => (
    <nav className="flex-1 overflow-y-auto py-5 space-y-6" style={{ touchAction: 'manipulation' }}>
      {/* Quick filter — type to jump to any section on a phone */}
      <div className="px-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            inputMode="search"
            value={navQuery}
            onChange={(e) => setNavQuery(e.target.value)}
            placeholder="Search menu…"
            className="w-full h-11 pl-9 pr-9 rounded-xl bg-card border border-border/60 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 transition-all"
            style={{ fontSize: 16 }}
          />
          {navQuery && (
            <button
              type="button"
              onClick={() => setNavQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-muted transition-colors"
              aria-label="Clear search"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>
      {sections.map((section) => {
        const isOpen = section.collapsible ? !!openGroups[section.title] : true;
        const SectionIcon = section.icon;
        const q = navQuery.trim().toLowerCase();
        const visibleItems = q
          ? section.items.filter((it) => matchesQuery(it, q))
          : section.items;
        if (q && visibleItems.length === 0) return null;
        // While searching, force every matching group open.
        const sectionOpen = q ? true : isOpen;
        return (
          <div key={section.title}>
            {section.collapsible ? (
              <button
                type="button"
                onClick={() =>
                  setOpenGroups((prev) => ({ ...prev, [section.title]: !prev[section.title] }))
                }
                className="w-full flex items-center justify-between gap-2 px-4 mb-2.5 group"
                aria-expanded={sectionOpen}
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
              >
                <span className="flex items-center gap-2">
                  {SectionIcon && <SectionIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
                    {section.title}
                  </span>
                </span>
                {sectionOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform" />
                )}
              </button>
            ) : (
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5 px-4">
                {section.title}
              </p>
            )}
            {sectionOpen && (
              <div className="space-y-1 px-2">
                {visibleItems.map((item) => renderNavItem(item, q, onItemClick))}
              </div>
            )}
          </div>
        );
      })}

      {navQuery.trim() &&
        sections.every(
          (s) =>
            s.items.filter((it) => matchesQuery(it, navQuery.trim().toLowerCase()))
              .length === 0,
        ) && (
          <p className="px-4 text-sm text-muted-foreground">No menu items match “{navQuery}”.</p>
        )}

      <div className="px-2 pt-4 border-t border-border mx-2">
        <button
          type="button"
          onClick={() => { handleResetSelection(); onItemClick?.(); }}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors select-none active:scale-[0.98] mb-1"
          style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
          title="Clear saved sidebar selection and return to Overview"
        >
          <RotateCcw className="h-4 w-4 shrink-0" />
          <span>Reset layout</span>
        </button>
        <button
          type="button"
          onClick={() => { handleExit(); onItemClick?.(); }}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors select-none active:scale-[0.98]"
          style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          <span>Back to app</span>
        </button>
      </div>
    </nav>
  );

  if (checkingProfile) {
    return (
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        <TopBarSkeleton />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <SidebarSkeleton />
          <main className="flex-1 p-4 sm:p-6 max-w-7xl mx-auto w-full space-y-4">
            <div className="h-8 w-48 rounded bg-muted/50 animate-pulse" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="h-24 rounded-xl bg-muted/40 animate-pulse" />
              <div className="h-24 rounded-xl bg-muted/40 animate-pulse" />
              <div className="h-24 rounded-xl bg-muted/40 animate-pulse" />
              <div className="h-24 rounded-xl bg-muted/40 animate-pulse" />
            </div>
            <div className="h-64 rounded-xl bg-muted/30 animate-pulse" />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Top Bar */}
      <header className="shrink-0 z-40 h-14 bg-primary text-primary-foreground border-b border-border flex items-center px-2 sm:px-4 gap-2 md:gap-3">
        {/* Mobile hamburger */}
        <button
          type="button"
          className="lg:hidden p-1.5 rounded-lg hover:bg-white/10 transition-colors shrink-0"
          onClick={() => setDrawerOpen(true)}
          style={{ touchAction: 'manipulation' }}
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Desktop sidebar hide/show — tucks the navigation out of the way and brings it back */}
        <button
          type="button"
          className="hidden lg:flex p-1.5 rounded-lg hover:bg-white/10 transition-colors shrink-0"
          onClick={toggleSidebar}
          title={sidebarHidden ? 'Show the navigation panel' : 'Hide the navigation panel'}
          aria-label={sidebarHidden ? 'Show the navigation panel' : 'Hide the navigation panel'}
          aria-pressed={sidebarHidden}
          style={{ touchAction: 'manipulation' }}
        >
          {sidebarHidden ? (
            <PanelLeftOpen className="h-5 w-5" />
          ) : (
            <PanelLeftClose className="h-5 w-5" />
          )}
        </button>

        {/* Logo / Title — hidden on very small screens because the role switcher already shows the current role */}
        <div className="hidden sm:flex items-center gap-2 min-w-0">
          <span className="font-bold text-sm whitespace-nowrap">{displayRole}</span>
        </div>

        {/* Center: Role Switcher */}
        <div className="flex-1 flex justify-center min-w-0 overflow-hidden px-1">
          <RoleSwitcher
            currentRole={role as AppRole}
            availableRoles={roles}
            onRoleChange={handleRoleChange}
            onAddRole={addRole}
            variant="header"
          />
        </div>

        {/* Department budget cycle notices (only for departments the user can access).
            The CFO dashboard has a single unified bell (CFOApprovalNotificationsBell),
            which already includes budget notices — so no second bell there.
            The CMO dashboard uses CMONotificationsBell in headerActions, which already
            includes budget notices plus merchandise orders — so no second bell there. */}
        {role !== 'cfo' && role !== 'cmo' && (
          <BudgetDepartmentNotificationBell
            dashboard={role}
            className="text-primary-foreground hover:bg-white/10 hover:text-primary-foreground shrink-0"
          />
        )}


        {/* Role-specific header actions (notifications, etc.) */}
        <div className="shrink-0 flex items-center">
          {headerActions}
        </div>

        {/* Sign Out */}
        <button
          type="button"
          onClick={() => signOut()}
          className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg bg-background text-primary text-xs font-semibold shadow-sm hover:bg-background/90 transition-colors whitespace-nowrap shrink-0"
          style={{ touchAction: 'manipulation' }}
        >
          <LogOut className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">Sign Out</span>
        </button>
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop Sidebar — slides fully out of view when tucked away */}
        <aside
          className={cn(
            'hidden lg:flex flex-col shrink-0 border-r border-border bg-card overflow-y-auto transition-all duration-200',
            sidebarHidden ? 'w-0 border-r-0 overflow-hidden' : 'w-64',
          )}
          aria-hidden={sidebarHidden}
        >
          {!sidebarHidden && SidebarContent({})}
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 p-2 sm:p-4 lg:p-6 max-w-7xl mx-auto w-full overflow-y-auto overflow-x-hidden bg-muted/20">
          {activeTab !== 'mission-goals' && (
            <MissionBanner dashboardRole={role} className="mb-4" />
          )}
          {activeTab === 'my-work' ? (
            <Suspense fallback={null}>
              <MyWork embedded />
            </Suspense>
          ) : (
            children
          )}
        </main>
      </div>

      {/* Mobile Drawer */}
      {drawerOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-[60] lg:hidden"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            className="fixed inset-y-0 left-0 w-72 bg-background z-[70] lg:hidden flex flex-col shadow-xl animate-in slide-in-from-left duration-200"
            style={{ touchAction: 'manipulation' }}
          >
            <div className="h-14 flex items-center justify-between px-4 border-b border-border">
              <span className="font-bold text-sm">{displayRole} Dashboard</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="p-1.5 rounded-lg hover:bg-muted"
                style={{ touchAction: 'manipulation' }}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {SidebarContent({ onItemClick: () => setDrawerOpen(false) })}
            <div className="p-4 border-t border-border">
              <button
                type="button"
                onClick={() => signOut()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
                style={{ touchAction: 'manipulation' }}
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
