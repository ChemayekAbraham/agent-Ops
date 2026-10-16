// BACKUP SNAPSHOT - served at /dashboard/agent-bk.
//
// This is AgentHubTabs exactly as it stood at commit 16c8eb552c (12 Oct 2026, 13:30 UTC),
// before Lovable's rework of the agent dashboard that afternoon (the wallet hero
// card moved to the Profile page, the Money / Tenants / Grow tabs moved into the
// agent menu, and the Top Up and Landlord Map actions were removed).
//
// It is a frozen copy. Do not fix or restyle it - change the live files instead.
// Delete src/components/agent-bk/, AgentDashboardBk.tsx and the /dashboard/agent-bk
// route together when the old layout is no longer needed.
//
import { Home } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import {
  FLOATING_NAV_ITEM,
  FLOATING_NAV_LABEL,
  FloatingNavRow,
  SlidingIndicator,
  useSlidingIndicator,
} from '@/components/ui/floating-nav';

export type AgentHubTab = 'home' | 'money' | 'tenants' | 'grow' | 'subagents' | 'league' | 'portfolio';

interface AgentHubTabsProps {
  active: AgentHubTab;
  onChange: (tab: AgentHubTab) => void;
  /** When true, hides operational (tenant) sections for Merchant Agents. */
  restricted?: boolean;
  /** Optional callback for the Proxy Agents shortcut (now moved to menu). */
  onProxyAgentsClick?: () => void;
}

const tabs: { id: AgentHubTab; icon: typeof Home; label: string }[] = [
  { id: 'home', icon: Home, label: 'Home' },
];

export function AgentHubTabs({ active, onChange, restricted = false }: AgentHubTabsProps) {
  // Merchant Agents are locked to the Home tab only — all operational tabs are hidden.
  const mainTabs = restricted ? tabs.filter((t) => t.id === 'home') : tabs;
  const activeIndex = mainTabs.findIndex((t) => t.id === active);
  const { containerRef, setItemRef, indicatorStyle } = useSlidingIndicator(activeIndex, [
    mainTabs.length,
  ]);

  return (
    <div
      className="sticky z-20 -mx-4 px-3 pb-2"
      style={{ top: 0, paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))' }}
      role="tablist"
      aria-label="Agent hub sections"
    >
      <div
        className="rounded-full border border-border/60 bg-background/90 backdrop-blur-xl shadow-[0_10px_34px_-8px_hsl(var(--foreground)/0.3)]"
      >
        <FloatingNavRow containerRef={containerRef}>
          <SlidingIndicator style={indicatorStyle} />
          {mainTabs.map((t, i) => {
            const isActive = active === t.id;
            return (
              <button
                key={t.id}
                ref={setItemRef(i)}
                role="tab"
                aria-selected={isActive}
                aria-label={t.label}
                onClick={() => { hapticTap(); onChange(t.id); }}
                className={cn(
                  FLOATING_NAV_ITEM,
                  isActive ? 'text-primary font-bold' : 'text-muted-foreground'
                )}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <t.icon className={cn('h-5 w-5', isActive && 'scale-110')} strokeWidth={isActive ? 2.5 : 2} />
                <span className={FLOATING_NAV_LABEL}>{t.label}</span>
              </button>
            );
          })}
        </FloatingNavRow>
      </div>
    </div>
  );
}

