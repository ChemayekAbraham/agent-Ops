import { createPortal } from 'react-dom';
import { LayoutDashboard, Users, Compass, Wallet, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BottomTab = 'home' | 'pipeline' | 'agents' | 'finance' | 'more';

const TABS: { key: BottomTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'home', label: 'Overview', icon: LayoutDashboard },
  { key: 'pipeline', label: 'Field', icon: Compass },
  { key: 'agents', label: 'Agents', icon: Users },
  { key: 'finance', label: 'Finance', icon: Wallet },
  { key: 'more', label: 'More', icon: MoreHorizontal },
];

export function AgentOpsBottomNav({
  active,
  onChange,
}: {
  active: BottomTab;
  onChange: (tab: BottomTab) => void;
}) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <nav
      className={cn(
        'fixed bottom-0 inset-x-0 z-50 sm:hidden',
        'bg-card/95 backdrop-blur border-t border-border',
        'pb-[env(safe-area-inset-bottom)]',
      )}
      aria-label="Agent Ops navigation"
    >
      <ul className="grid grid-cols-5">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.key;
          return (
            <li key={tab.key}>
              <button
                type="button"
                onClick={() => onChange(tab.key)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'w-full flex flex-col items-center justify-center gap-0.5 py-2 touch-manipulation',
                  'transition-colors active:scale-95',
                  isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className={cn('h-5 w-5', isActive && 'drop-shadow-sm')} />
                <span className="text-[10px] font-semibold">{tab.label}</span>
                {isActive && <span className="h-0.5 w-6 rounded-full bg-primary" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>,
    document.body,
  );
}