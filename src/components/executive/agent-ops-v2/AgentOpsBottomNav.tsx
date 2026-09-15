import { createPortal } from 'react-dom';
import { LayoutDashboard, Users, FileText, Wallet, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BottomTab = 'home' | 'pipeline' | 'agents' | 'finance' | 'more';

const TABS: { key: BottomTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'home', label: 'Overview', icon: LayoutDashboard },
  { key: 'pipeline', label: 'Rent Requests', icon: FileText },
  { key: 'agents', label: 'Agents', icon: Users },
  { key: 'finance', label: 'Money', icon: Wallet },
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
        'fixed bottom-0 inset-x-0 z-50 lg:hidden',
        'bg-card/95 backdrop-blur-xl border-t border-border shadow-lg',
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
                  'w-full min-h-[64px] px-1 flex flex-col items-center justify-center gap-1 touch-manipulation',
                  'transition-colors active:scale-95',
                  isActive ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className={cn('h-5 w-5 shrink-0', isActive && 'drop-shadow-sm')} />
                <span className="max-w-full text-center text-[10px] font-semibold leading-[1.05]">{tab.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>,
    document.body,
  );
}