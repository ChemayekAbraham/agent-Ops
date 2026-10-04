import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Home, Menu, Settings, Store, Users, FileText, Wallet, Shield, ArrowDownToLine } from 'lucide-react';
import { AppRole } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import { roleToSlug } from '@/lib/roleRoutes';
import WelileAIChatDrawer from '@/components/ai-chat/WelileAIChatDrawer';
import MobileManagerMenu from '@/components/manager/MobileManagerMenu';
import {
  FLOATING_NAV_ITEM,
  FLOATING_NAV_LABEL,
  FLOATING_NAV_SHELL,
  FLOATING_NAV_SHELL_STYLE,
  SlidingIndicator,
  useSlidingIndicator,
} from '@/components/ui/floating-nav';

const GeminiSparkle = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M14 2C14 2 16.5 9 18.5 11.5C20.5 14 26 14 26 14C26 14 20.5 14 18.5 16.5C16.5 19 14 26 14 26C14 26 11.5 19 9.5 16.5C7.5 14 2 14 2 14C2 14 7.5 14 9.5 11.5C11.5 9 14 2 14 2Z"
      fill="currentColor"
    />
  </svg>
);

const NAV_SHELL = cn('md:hidden z-50', FLOATING_NAV_SHELL);
const NAV_SHELL_STYLE = FLOATING_NAV_SHELL_STYLE;
const NAV_ITEM = FLOATING_NAV_ITEM;
const NAV_LABEL = FLOATING_NAV_LABEL;

interface MobileBottomNavProps {
  currentRole: AppRole;
  onManagerHubChange?: (hub: 'home' | 'wallets' | 'rent-investments' | 'buffer') => void;
  activeManagerHub?: string;
  onScrollToProductivity?: () => void;
  onOpenMenu?: () => void;
}

export default function MobileBottomNav({ currentRole, onManagerHubChange, activeManagerHub, onScrollToProductivity, onOpenMenu }: MobileBottomNavProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname;
  const currentSearch = location.search;
  const personaSlug = roleToSlug(currentRole);
  const [aiOpen, setAiOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleTap = () => { hapticTap(); };

  // One-tap Deposit shortcut for money-handling personas. If we are already
  // on the persona dashboard, fire the global `open-deposit` event so the
  // dashboard opens its deposit dialog without remounting. Otherwise,
  // navigate to the persona home with `?deposit=1` — the dashboards read
  // that flag on mount and auto-open the same dialog.
  const showDepositFab = ['tenant', 'agent', 'supporter'].includes(currentRole);
  const handleDepositTap = () => {
    hapticTap();
    if (currentPath === personaSlug) {
      window.dispatchEvent(new CustomEvent('open-deposit'));
    } else {
      navigate(`${personaSlug}?deposit=1`);
    }
  };

  // Manager bottom nav: hub switching when on the manager dashboard
  if (currentRole === 'manager' && currentPath === '/dashboard/manager' && onManagerHubChange) {
    return (
      <>
        <ManagerHubNav
          activeManagerHub={activeManagerHub}
          onManagerHubChange={onManagerHubChange}
          onTap={handleTap}
          onOpenAi={() => setAiOpen(true)}
          onOpenMenu={() => setMenuOpen(true)}
        />
        <WelileAIChatDrawer open={aiOpen} onOpenChange={setAiOpen} />
        {menuOpen && <MobileManagerMenu onScrollToProductivity={onScrollToProductivity} isOpen={menuOpen} onClose={() => setMenuOpen(false)} />}
      </>
    );
  }

  // Standard nav for all roles
  const getNavItems = () => {
    const baseItems = [{ href: personaSlug, icon: Home, label: 'Home', active: currentPath === personaSlug }];

    if (currentRole === 'manager') {
      return [...baseItems,
        { href: '/manager-access?tab=users', icon: Users, label: 'Users', active: currentPath === '/manager-access' && currentSearch.includes('users') },
        { href: '/manager-access', icon: FileText, label: 'Rent', active: currentPath === '/manager-access' && !currentSearch.includes('users') },
        { href: '/marketplace', icon: Store, label: 'Shop', active: currentPath === '/marketplace' },
      ];
    }
    if (currentRole === 'agent') {
      return [...baseItems,
        { href: '/marketplace', icon: Store, label: 'Shop', active: currentPath === '/marketplace' },
      ];
    }
    if (currentRole === 'supporter') {
      return [...baseItems,
        { href: '/transactions', icon: Wallet, label: 'Wallet', active: currentPath === '/transactions' },
        { href: '/marketplace', icon: Store, label: 'Shop', active: currentPath === '/marketplace' },
        { href: '/settings', icon: Settings, label: 'Settings', active: currentPath === '/settings' },
      ];
    }
    return [...baseItems,
      { href: '/marketplace', icon: Store, label: 'Shop', active: currentPath === '/marketplace' },
      { href: '/referrals', icon: Users, label: 'Invite', active: currentPath === '/referrals' },
    ];
  };

  const navItems = getNavItems();
  const isSettingsActive = currentPath === '/settings';
  // Indicator tracks the nav links first, then the trailing Settings link when
  // it is the active route (the Deposit / AI / Menu actions never own it).
  const trailingSettingsIndex = onOpenMenu ? -1 : navItems.length;
  const activeIndex = navItems.findIndex((i) => i.active);
  const resolvedActiveIndex = activeIndex >= 0 ? activeIndex : (isSettingsActive ? trailingSettingsIndex : -1);
  const { containerRef, setItemRef, indicatorStyle } = useSlidingIndicator(resolvedActiveIndex, [
    navItems.length,
    showDepositFab,
    Boolean(onOpenMenu),
  ]);

  return (
    <>
      <nav className={NAV_SHELL} style={NAV_SHELL_STYLE}>
        <div ref={containerRef} className="relative flex items-center px-1.5 py-1.5">
          <SlidingIndicator style={indicatorStyle} />
          {navItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.label + item.href}
                to={item.href}
                onClick={handleTap}
                ref={setItemRef(index)}
                className={cn(
                  NAV_ITEM,
                  item.active ? 'text-primary' : 'text-muted-foreground active:text-foreground active:scale-95'
                )}
              >
                <Icon className={cn('h-5 w-5 transition-transform', item.active && 'scale-110')} strokeWidth={item.active ? 2.5 : 2} />
                <span className={NAV_LABEL}>{item.label}</span>
              </Link>
            );
          })}
          {showDepositFab && (
            <button
              onClick={handleDepositTap}
              aria-label="Deposit"
              className="relative z-10 flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-1 text-primary active:scale-95 touch-manipulation"
            >
              <div className="h-11 w-11 -mt-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg ring-4 ring-card">
                <ArrowDownToLine className="h-5 w-5" strokeWidth={2.5} />
              </div>
              <span className={NAV_LABEL}>Deposit</span>
            </button>
          )}
          <button
            onClick={() => { handleTap(); setAiOpen(true); }}
            aria-label="Welile AI"
            className={cn(NAV_ITEM, 'text-primary active:scale-95')}
          >
            <GeminiSparkle size={20} />
            <span className={NAV_LABEL}>AI</span>
          </button>
          {onOpenMenu ? (
            <button
              onClick={() => { handleTap(); onOpenMenu(); }}
              aria-label="Menu"
              className={cn(NAV_ITEM, 'text-muted-foreground active:text-foreground active:scale-95')}
            >
              <div className="h-5 w-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md">
                <Menu className="h-3.5 w-3.5" />
              </div>
              <span className={NAV_LABEL}>Menu</span>
            </button>
          ) : (
            <Link
              to="/settings"
              onClick={handleTap}
              ref={setItemRef(trailingSettingsIndex)}
              className={cn(
                NAV_ITEM,
                isSettingsActive ? 'text-primary' : 'text-muted-foreground active:text-foreground active:scale-95'
              )}
            >
              <Settings className={cn('h-5 w-5 transition-transform', isSettingsActive && 'scale-110')} strokeWidth={isSettingsActive ? 2.5 : 2} />
              <span className={NAV_LABEL}>Menu</span>
            </Link>
          )}
        </div>
      </nav>
      <WelileAIChatDrawer open={aiOpen} onOpenChange={setAiOpen} />
    </>
  );
}

const MANAGER_HUBS = [
  { id: 'home' as const, icon: Home, label: 'Home' },
  { id: 'wallets' as const, icon: Wallet, label: 'Wallets' },
  { id: 'rent-investments' as const, icon: FileText, label: 'Rent' },
  { id: 'buffer' as const, icon: Shield, label: 'Buffer' },
];

function ManagerHubNav({
  activeManagerHub,
  onManagerHubChange,
  onTap,
  onOpenAi,
  onOpenMenu,
}: {
  activeManagerHub?: string;
  onManagerHubChange: (hub: 'home' | 'wallets' | 'rent-investments' | 'buffer') => void;
  onTap: () => void;
  onOpenAi: () => void;
  onOpenMenu: () => void;
}) {
  const activeIndex = MANAGER_HUBS.findIndex((h) => h.id === activeManagerHub);
  const { containerRef, setItemRef, indicatorStyle } = useSlidingIndicator(activeIndex, [activeManagerHub]);

  return (
    <nav className={NAV_SHELL} style={NAV_SHELL_STYLE}>
      <div ref={containerRef} className="relative flex items-center px-1.5 py-1.5">
        <SlidingIndicator style={indicatorStyle} />
        {MANAGER_HUBS.map((item, index) => {
          const Icon = item.icon;
          const isActive = activeManagerHub === item.id;
          return (
            <button
              key={item.id}
              ref={setItemRef(index)}
              onClick={() => { onTap(); onManagerHubChange(item.id); }}
              className={cn(
                NAV_ITEM,
                isActive ? 'text-primary' : 'text-muted-foreground active:text-foreground active:scale-95',
              )}
            >
              <Icon className={cn('h-5 w-5', isActive && 'scale-110')} strokeWidth={isActive ? 2.5 : 2} />
              <span className={NAV_LABEL}>{item.label}</span>
            </button>
          );
        })}
        <button
          onClick={() => { onTap(); onOpenAi(); }}
          aria-label="Welile AI"
          className={cn(NAV_ITEM, 'text-primary active:scale-95')}
        >
          <GeminiSparkle size={20} />
          <span className={NAV_LABEL}>AI</span>
        </button>
        <button
          onClick={() => { onTap(); onOpenMenu(); }}
          aria-label="Menu"
          className={cn(NAV_ITEM, 'text-muted-foreground active:text-foreground active:scale-95')}
        >
          <div className="h-5 w-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md">
            <Menu className="h-3.5 w-3.5" />
          </div>
          <span className={NAV_LABEL}>Menu</span>
        </button>
      </div>
    </nav>
  );
}
