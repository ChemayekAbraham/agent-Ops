import { useNavigate } from 'react-router-dom';
import { 
  X, 
  CreditCard,
  TrendingUp,
  History,
  Receipt,
  Share2,
  Download,
  Calculator,
  Settings,
  HelpCircle,
  ScrollText,
  Store,
  Wallet,
  FileText,
  ChevronRight,
  Zap,
  Home,
  Building2,
  Users,
  UserRound,
  Bell,
  Briefcase,
  LogOut,
  type LucideIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import { CreditRequestsFeed } from '@/components/supporter/CreditRequestsFeed';
import { RentCategoryFeed, RentCategory } from '@/components/supporter/RentCategoryFeed';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import React from 'react';

interface SupporterMenuDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddInvestment: () => void;
  onOpenCalculator: () => void;
  onViewAgreement: () => void;
  showCreditRequests?: boolean;
  isLocked?: boolean;
  onLockedClick?: () => void;
  onFundCategory?: (category: RentCategory) => void;
  onRefreshRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  onOpenWallet?: () => void;
  onOpenPortfolios?: () => void;
  onShowDirectSupport?: () => void;
  onShowVacantHouses?: () => void;
  onShowManagedSupport?: () => void;
  onShowAngelPool?: () => void;
  onShowSupportedHouses?: () => void;
  onSignOut?: () => void;
}

interface MenuItem {
  icon: LucideIcon;
  label: string;
  description?: string;
  path?: string;
  onClick?: () => void;
  badge?: string;
}

interface MenuSection {
  title: string;
  items: MenuItem[];
}

function MenuItemRow({ item, onClick }: { item: MenuItem; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="w-full min-h-11 h-auto justify-start gap-3 px-3 py-2.5 rounded-xl hover:bg-muted/60 active:scale-[0.98] transition-all text-left group focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="w-9 h-9 rounded-lg bg-muted/80 flex items-center justify-center shrink-0">
        <item.icon className="h-[18px] w-[18px] text-foreground/70" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-[13px] text-foreground truncate">{item.label}</p>
        {item.description && (
          <p className="text-[11px] text-muted-foreground truncate">{item.description}</p>
        )}
      </div>
      {item.badge && (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-primary/10 text-primary rounded-full">
          {item.badge}
        </span>
      )}
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0 group-hover:text-muted-foreground transition-colors" />
    </Button>
  );
}

export function SupporterMenuDrawer({ 
  open, 
  onOpenChange, 
  onAddInvestment,
  onOpenCalculator,
  onViewAgreement,
  showCreditRequests,
  isLocked,
  onLockedClick,
  onFundCategory,
  onRefreshRef,
  onOpenWallet,
  onOpenPortfolios,
  onShowDirectSupport,
  onShowVacantHouses,
  onShowManagedSupport,
  onShowAngelPool,
  onShowSupportedHouses,
  onSignOut,
}: SupporterMenuDrawerProps) {
  const navigate = useNavigate();

  const handleItemClick = (item: MenuItem) => {
    hapticSuccess();
    onOpenChange(false);
    if (item.onClick) {
      item.onClick();
    } else if (item.path) {
      navigate(item.path);
    }
  };

  const menuSections: MenuSection[] = [
    {
      title: 'Share & Grow',
      items: [
        { icon: Share2, label: 'Referrals', description: 'Invite & earn rewards', path: '/referrals' },
        { icon: Download, label: 'Share App', description: 'Invite friends to Welile', path: '/install' },
      ]
    },
    {
      title: 'Support tenants',
      items: [
        ...(onShowDirectSupport ? [{ icon: Home, label: 'Houses with ready tenants', description: 'Support an approved tenant directly', onClick: onShowDirectSupport }] : []),
        ...(onShowVacantHouses ? [{ icon: Building2, label: 'Houses without tenants', description: 'Browse verified vacant houses', onClick: onShowVacantHouses }] : []),
        ...(onShowManagedSupport ? [{ icon: Users, label: 'Welile-managed support', description: 'We deploy and manage your capital', onClick: onShowManagedSupport }] : []),
        { icon: CreditCard, label: 'Support Tenant', description: 'Fund via Mobile Money', onClick: onAddInvestment },
      ]
    },
    {
      title: 'Portfolio & returns',
      items: [
        ...(onOpenPortfolios ? [{ icon: TrendingUp, label: 'My Portfolios', description: 'View active and past portfolios', onClick: onOpenPortfolios }] : []),
        ...(onShowSupportedHouses ? [{ icon: Home, label: 'Houses I Support', description: 'Track funded houses and tenants', onClick: onShowSupportedHouses }] : []),
        ...(onShowAngelPool ? [{ icon: Zap, label: 'Angel Pool', description: 'View Welile share opportunities', onClick: onShowAngelPool }] : []),
        { icon: TrendingUp, label: 'Returns Analytics', description: 'Earnings & projections', path: '/supporter-earnings' },
        { icon: History, label: 'Reinvestment History', description: 'Compounding growth timeline', path: '/reinvestment-history' },
        { icon: Calculator, label: 'Returns Calculator', description: 'Project your returns', onClick: onOpenCalculator },
      ]
    },
    {
      title: 'Finances',
      items: [
        { icon: Wallet, label: 'My Wallet', description: 'Balance & transactions', onClick: onOpenWallet, path: onOpenWallet ? undefined : '/transactions' },
        { icon: History, label: 'History', description: 'All payment activity', path: '/transactions' },
        { icon: FileText, label: 'Statement', description: 'Download financial statement', path: '/financial-statement' },
        { icon: Receipt, label: 'Receipts', description: 'Payment records', path: '/my-receipts' },
      ]
    },
    {
      title: 'Community',
      items: [
        { icon: Store, label: 'Marketplace', description: 'Shop products', path: '/marketplace' },
      ]
    },
    {
      title: 'Account',
      items: [
        { icon: UserRound, label: 'Your Profile', description: 'View and update your profile', path: '/your-profile' },
        { icon: Bell, label: 'Notifications', description: 'View your latest updates', path: '/notifications' },
        { icon: ScrollText, label: 'Agreement', description: 'Terms & conditions', onClick: onViewAgreement },
        { icon: ScrollText, label: 'Angel Pool Agreement', description: 'View & sign pool terms', path: '/angel-pool-agreement' },
        { icon: Briefcase, label: "We're Hiring", description: 'Explore and apply for open roles', path: '/careers' },
        { icon: Settings, label: 'Settings', description: 'Account preferences', path: '/settings' },
        { icon: HelpCircle, label: 'Help', description: 'Get assistance', path: '/settings' },
        ...(onSignOut ? [{ icon: LogOut, label: 'Sign Out', description: 'Sign out of your account', onClick: onSignOut }] : []),
      ]
    },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent
            side="right"
            aria-describedby={undefined}
            className="w-[82%] max-w-xs p-0 gap-0 overflow-hidden flex flex-col"
            overlayClassName="bg-background/50 backdrop-blur-[2px]"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-border/60">
              <SheetTitle className="font-bold text-base tracking-tight">Menu</SheetTitle>
              <SheetClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close menu"
                  onClick={hapticTap}
                  className="min-h-11 min-w-11 rounded-lg bg-muted/60 hover:bg-muted"
              >
                <X className="h-4 w-4" />
                </Button>
              </SheetClose>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              <div className="py-3 space-y-1">
                {/* Welile AI Credit Requests */}
                {showCreditRequests && (
                  <div className="px-4 pb-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Zap className="h-3 w-3 text-primary" />
                      AI Credit Requests
                    </p>
                    <CreditRequestsFeed isLocked={isLocked} onLockedClick={onLockedClick} />
                  </div>
                )}

                {/* Investment Categories */}
                {onFundCategory && (
                  <div className="px-4 pb-2">
                    <RentCategoryFeed
                      onFundCategory={(cat) => { onOpenChange(false); onFundCategory(cat); }}
                      isLocked={isLocked}
                      onLockedClick={onLockedClick}
                      onRefreshRef={onRefreshRef}
                    />
                  </div>
                )}

                {/* Menu Sections */}
                {menuSections.map((section) => (
                  <div key={section.title} className="px-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-3 pt-3 pb-1.5">
                      {section.title}
                    </p>
                    {section.items.map((item) => (
                      <MenuItemRow
                        key={item.label}
                        item={item}
                        onClick={() => handleItemClick(item)}
                      />
                    ))}
                  </div>
                ))}
              </div>

              <div className="h-6" />
            </div>
          </SheetContent>
    </Sheet>
  );
}
