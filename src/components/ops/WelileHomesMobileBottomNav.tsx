import { createPortal } from 'react-dom';
import {
  LayoutDashboard,
  Home,
  Users,
  Banknote,
  Wallet,
  Smartphone,
  Clock,
  ClipboardList,
  MoreHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type WelileTab = 'overview' | 'applications' | 'landlords' | 'all';

interface WelileHomesMobileBottomNavProps {
  active: WelileTab;
  onChange: (tab: WelileTab) => void;
  counts?: {
    applications?: number;
    landlords?: number;
    all?: number;
  };
}

const TABS: {
  key: WelileTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  countKey?: 'applications' | 'landlords' | 'all';
}[] = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'applications', label: 'Applications', icon: ClipboardList, countKey: 'applications' },
  { key: 'landlords', label: 'Portfolio', icon: Home, countKey: 'landlords' },
  { key: 'all', label: 'Subscriptions', icon: Users, countKey: 'all' },
];

export function WelileHomesMobileBottomNav({
  active,
  onChange,
  counts,
}: WelileHomesMobileBottomNavProps) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <nav
      className={cn(
        'fixed bottom-0 inset-x-0 z-50 md:hidden',
        'bg-card/95 backdrop-blur-md border-t border-border shadow-lg',
        'pb-[env(safe-area-inset-bottom)]',
      )}
      aria-label="Welile Homes mobile navigation"
    >
      <ul className="grid grid-cols-4">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.key;
          const count = tab.countKey && counts ? counts[tab.countKey] : undefined;

          return (
            <li key={tab.key}>
              <button
                type="button"
                onClick={() => {
                  onChange(tab.key);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'w-full flex flex-col items-center justify-center gap-0.5 py-1.5 touch-manipulation relative',
                  'transition-all duration-150 active:scale-95',
                  isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <div className="relative flex items-center justify-center">
                  <Icon className={cn('h-4.5 w-4.5', isActive && 'drop-shadow-sm stroke-[2.3]')} />
                  {typeof count === 'number' && count > 0 && (
                    <span
                      className={cn(
                        'absolute -top-1.5 -right-2.5 text-[8px] font-bold px-1 min-w-[13px] h-3.5 rounded-full flex items-center justify-center tabular-nums leading-none',
                        isActive
                          ? 'bg-primary text-primary-foreground shadow-2xs'
                          : 'bg-muted-foreground/20 text-muted-foreground',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </div>
                <span className={cn('text-[9.5px] tracking-tight truncate max-w-full', isActive ? 'font-bold' : 'font-medium')}>
                  {tab.label}
                </span>
                {isActive ? (
                  <span className="h-0.5 w-5 rounded-full bg-primary" aria-hidden />
                ) : (
                  <span className="h-0.5 w-5 bg-transparent" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>,
    document.body,
  );
}
