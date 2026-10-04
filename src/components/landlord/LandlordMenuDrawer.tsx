import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useDrawerTransition } from '@/hooks/useDrawerTransition';
import { 
  X, 
  Home,
  Receipt,
  Banknote,
  History,
  Users,
  Share2,
  Download,
  Settings,
  HelpCircle,
  ChevronRight,
  ScrollText,
  PiggyBank,
  Building,
  MessageSquare,
  FileText,
  DoorOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import { Separator } from '@/components/ui/separator';

interface LandlordMenuDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewListedHouses?: () => void;
}

interface MenuSection {
  title: string;
  items: MenuItem[];
}

interface MenuItem {
  icon: typeof Home;
  label: string;
  description?: string;
  path?: string;
  onClick?: () => void;
  badge?: string;
  color?: string;
}

export function LandlordMenuDrawer({ 
  open, 
  onOpenChange, 
  onViewListedHouses,
}: LandlordMenuDrawerProps) {
  const navigate = useNavigate();

  const handleClose = () => {
    hapticTap();
    onOpenChange(false);
  };

  const { mounted, visible } = useDrawerTransition(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); handleClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
      title: 'Property Management',
      items: [
        ...(onViewListedHouses ? [{ 
          icon: DoorOpen, 
          label: 'Daily Rent Listings', 
          description: 'View houses listed for daily rent',
          onClick: onViewListedHouses,
          color: 'text-success',
          badge: 'Daily Rent'
        } as MenuItem] : []),
        { 
          icon: Users, 
          label: 'My Tenants', 
          description: 'View & rate tenants',
          path: '/landlord-welile-homes',
          color: 'text-blue-500'
        },
        { 
          icon: PiggyBank, 
          label: 'Welile Homes Impact', 
          description: 'Tenant savings progress',
          path: '/landlord-welile-homes',
          color: 'text-purple-500'
        },
      ]
    },
    {
      title: 'Finances',
      items: [
        { 
          icon: Receipt, 
          label: 'My Receipts', 
          description: 'View payment receipts',
          path: '/my-receipts',
          color: 'text-teal-500'
        },
        { 
          icon: Banknote, 
          label: 'My Loans', 
          description: 'View & manage loans',
          path: '/my-loans',
          color: 'text-green-500'
        },
        { 
          icon: History, 
          label: 'Payment History', 
          description: 'All past transactions',
          path: '/transactions',
          color: 'text-blue-500'
        },
        { 
          icon: FileText, 
          label: 'Financial Statement', 
          description: 'Download your statement',
          path: '/financial-statement',
          color: 'text-indigo-500'
        },
      ]
    },
    {
      title: 'Growth',
      items: [
        { 
          icon: Receipt, 
          label: 'Post Shopping Receipt', 
          description: 'Earn loan limits & rent discounts',
          path: '/my-receipts',
          color: 'text-orange-500',
          badge: 'Earn benefits'
        },
        { 
          icon: Users, 
          label: 'My Referrals', 
          description: 'People you invited',
          path: '/referrals',
          color: 'text-purple-500'
        },
        { 
          icon: Share2, 
          label: 'Share & Earn', 
          description: 'Invite friends for rewards',
          path: '/benefits',
          color: 'text-pink-500'
        },
      ]
    },
    {
      title: 'More',
      items: [
        { 
          icon: ScrollText, 
          label: 'Landlord Agreement', 
          description: 'Terms & conditions',
          path: '/landlord-agreement',
          color: 'text-muted-foreground'
        },
        { 
          icon: Download, 
          label: 'Share App', 
          description: 'Invite friends to Welile',
          path: '/install',
          color: 'text-primary'
        },
        { 
          icon: Settings, 
          label: 'Settings', 
          description: 'Account preferences',
          path: '/settings',
          color: 'text-muted-foreground'
        },
        { 
          icon: HelpCircle, 
          label: 'Help & Support', 
          description: 'Get assistance',
          path: '/settings',
          color: 'text-muted-foreground'
        },
      ]
    },
  ];

  if (!mounted) return null;

  return (
    <>
          {/* Backdrop */}
          <div
            onClick={handleClose}
            className={cn(
              "fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] transition-opacity duration-300",
              visible ? "opacity-100" : "opacity-0",
            )}
          />

          {/* Drawer */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Landlord menu"
            className={cn(
              "fixed right-0 top-0 bottom-0 w-[85%] max-w-sm bg-background z-[101] shadow-2xl overflow-hidden flex flex-col transition-transform duration-300 ease-out will-change-transform",
              visible ? "translate-x-0" : "translate-x-full",
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border bg-card">
              <div>
                <h2 className="font-bold text-lg">Menu</h2>
                <p className="text-xs text-muted-foreground">All landlord features</p>
              </div>
              <button
                onClick={handleClose}
                className="p-2 rounded-full bg-muted hover:bg-muted/80 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              <div className="p-4 space-y-6">
                {menuSections.map((section, sectionIndex) => (
                  <div key={section.title}>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">
                      {section.title}
                    </h3>
                    <div className="space-y-1">
                      {section.items.map((item) => (
                        <button
                          key={item.label}
                          onClick={() => handleItemClick(item)}
                          className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 active:scale-[0.98] transition-all text-left animate-fade-in"
                        >
                          <div className={cn(
                            "p-2 rounded-lg bg-muted/80",
                            item.color
                          )}>
                            <item.icon className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-sm truncate">{item.label}</p>
                              {item.badge && (
                                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-success/20 text-success rounded-full">
                                  {item.badge}
                                </span>
                              )}
                            </div>
                            {item.description && (
                              <p className="text-xs text-muted-foreground truncate">{item.description}</p>
                            )}
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        </button>
                      ))}
                    </div>
                    {sectionIndex < menuSections.length - 1 && (
                      <Separator className="mt-4" />
                    )}
                  </div>
                ))}
              </div>

              {/* Footer Padding */}
              <div className="h-8" />
            </div>
          </div>
    </>
  );
}
