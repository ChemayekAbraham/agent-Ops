import { Home, Wallet, Users, TrendingUp, Store, Sparkles } from 'lucide-react';
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
}

const tabs: { id: AgentHubTab; icon: typeof Home; label: string }[] = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'money', icon: Wallet, label: 'Money' },
  { id: 'tenants', icon: Users, label: 'Tenants' },
  { id: 'grow', icon: TrendingUp, label: 'Grow' },
  { id: 'subagents', icon: Store, label: 'Service Center' },
];

export function AgentHubTabs({ active, onChange, restricted = false, onProxyAgentsClick }: AgentHubTabsProps) {
  // Merchant Agents are locked to the Home tab only — all operational tabs are hidden.
  const visibleTabs = restricted ? tabs.filter((t) => t.id === 'home') : tabs;
  const mainTabs = visibleTabs.filter((t) => t.id !== 'subagents');
  const serviceCenterTab = visibleTabs.find((t) => t.id === 'subagents');
  const activeIndex = mainTabs.findIndex((t) => t.id === active);
  const { containerRef, setItemRef, indicatorStyle } = useSlidingIndicator(activeIndex, [
    mainTabs.length,
  ]);
  return (
    <>
      {serviceCenterTab && (
        <div className="-mx-4 px-3 pb-2 flex justify-end">
          <button
            key={serviceCenterTab.id}
            role="tab"
            aria-selected={active === serviceCenterTab.id}
            aria-label={serviceCenterTab.label}
            onClick={() => { hapticTap(); onChange(serviceCenterTab.id); }}
            className={cn(
              FLOATING_NAV_ITEM,
              'min-w-[5.5rem] px-3',
              'border border-purple-300/80 bg-purple-50/60 shadow-sm',
              'dark:border-purple-500/60 dark:bg-purple-950/30',
              active === serviceCenterTab.id ? 'text-primary font-bold' : 'text-purple-900/80 dark:text-purple-100/80'
            )}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <serviceCenterTab.icon className={cn('h-5 w-5', active === serviceCenterTab.id && 'scale-110')} strokeWidth={active === serviceCenterTab.id ? 2.5 : 2} />
            <span className={cn(FLOATING_NAV_LABEL, 'text-xs font-bold')}>{serviceCenterTab.label}</span>
            <span className="absolute -top-2 -right-2 inline-flex items-center rounded-full bg-gradient-to-r from-red-500 to-rose-500 px-2 py-0.5 text-[10px] font-extrabold tracking-wide text-white shadow-md ring-2 ring-background dark:ring-background">
              New
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-yellow-300 ring-1 ring-white" />
            </span>
          </button>
        </div>
      )}
      {serviceCenterTab && onProxyAgentsClick && (
        <div className="-mx-4 px-3 pb-2 flex justify-end">
          <button
            onClick={() => { hapticTap(); onProxyAgentsClick(); }}
            aria-label="Proxy Agents"
            className={cn(
              FLOATING_NAV_ITEM,
              'min-w-[5.5rem] px-3',
              'border border-purple-300/80 bg-purple-50/60 shadow-sm',
              'dark:border-purple-500/60 dark:bg-purple-950/30',
              'text-purple-900/80 dark:text-purple-100/80'
            )}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Sparkles className="h-5 w-5" strokeWidth={2} />
            <span className={cn(FLOATING_NAV_LABEL, 'text-xs font-bold')}>Proxy Agents</span>
          </button>
        </div>
      )}
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
    </>
  );
}
