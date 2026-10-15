import { Home, Store, Sparkles, Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import {
  FLOATING_NAV_ITEM,
  FLOATING_NAV_LABEL,
  FloatingNavRow,
  SlidingIndicator,
  useSlidingIndicator,
} from '@/components/ui/floating-nav';

export type AgentHubTab = 'home' | 'money' | 'tenants' | 'grow' | 'subagents';

interface AgentHubTabsProps {
  active: AgentHubTab;
  onChange: (tab: AgentHubTab) => void;
  /** When true, hides operational (tenant) sections for Merchant Agents. */
  restricted?: boolean;
  /** Optional callback for the Proxy Agents shortcut rendered below Service Center. */
  onProxyAgentsClick?: () => void;
  /** Opens the full agent menu (Money, My Tenant Hub, Grow & Earn, ...). */
  onMenuClick?: () => void;
}

const tabs: { id: AgentHubTab; icon: typeof Home; label: string }[] = [
  { id: 'home', icon: Home, label: 'Home' },
];

export function AgentHubTabs({ active, onChange, restricted = false, onProxyAgentsClick, onMenuClick }: AgentHubTabsProps) {
  // Merchant Agents are locked to the Home tab only — all operational tabs are hidden.
  const mainTabs = restricted ? tabs.filter((t) => t.id === 'home') : tabs;
  const activeIndex = mainTabs.findIndex((t) => t.id === active);
  const { containerRef, setItemRef, indicatorStyle } = useSlidingIndicator(activeIndex, [
    mainTabs.length,
  ]);
  return (
    <>
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
            {onMenuClick && !restricted && (
              <button
                aria-label="More Actions"
                onClick={() => { hapticTap(); onMenuClick(); }}
                className={cn(FLOATING_NAV_ITEM, 'text-muted-foreground')}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Menu className="h-5 w-5" strokeWidth={2} />
                <span className={FLOATING_NAV_LABEL}>More Actions</span>
              </button>
            )}
          </FloatingNavRow>
        </div>
      </div>
    </>
  );
}
