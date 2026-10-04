import { useNavigate, useLocation } from 'react-router-dom';
import { useState, useMemo, useRef, useEffect } from 'react';
import { useDrawerTransition } from '@/hooks/useDrawerTransition';
import { 
  X, 
  Home,
  CreditCard,
  Calendar,
  Receipt,
  Banknote,
  ShoppingBag,
  History,
  Users,
  Share2,
  Download,
  Settings,
  Calculator,
  ChevronRight,
  ScrollText,
  PiggyBank,
  FileText,
  Search,
  ArrowUpRight,
  Copy,
  Info,
  Link2,
  ChevronDown,
} from 'lucide-react';
import { hapticTap, hapticSuccess, hapticImpact, hapticSelection, haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { formatUGX } from '@/lib/rentCalculations';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useToast } from '@/hooks/use-toast';
import { getPublicOrigin } from '@/lib/getPublicOrigin';

interface TenantMenuDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPayLandlord: () => void;
  onPayWelile: () => void;
  onRepaymentSchedule: () => void;
  onRentCalculator: () => void;
  onBrowseHouses?: () => void;
  extraContent?: ReactNode;
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

export function TenantMenuDrawer({ 
  open, 
  onOpenChange, 
  onPayLandlord,
  onPayWelile,
  onRepaymentSchedule,
  onRentCalculator,
  onBrowseHouses,
  extraContent,
}: TenantMenuDrawerProps) {

  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const { toast } = useToast();
  const [quickAction, setQuickAction] = useState<MenuItem | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const { mounted, visible } = useDrawerTransition(open);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('tenant-menu-collapsed');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  const toggleSection = (title: string) => {
    hapticSelection();
    setCollapsed((prev) => {
      const next = { ...prev, [title]: !prev[title] };
      try { window.localStorage.setItem('tenant-menu-collapsed', JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  };

  const setAllCollapsed = (titles: string[], value: boolean) => {
    hapticSelection();
    setCollapsed((prev) => {
      const next = { ...prev };
      titles.forEach((t) => { next[t] = value; });
      try { window.localStorage.setItem('tenant-menu-collapsed', JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  };

  // ESC to close + focus trap + restore focus
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = (document.activeElement as HTMLElement) || null;

    // Focus the first focusable element inside the drawer
    const focusFirst = () => {
      const root = drawerRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      (focusables[0] || root).focus();
    };
    const t = window.setTimeout(focusFirst, 50);

    const onKey = (e: KeyboardEvent) => {
      if (quickAction) return; // sheet has its own handling
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
        return;
      }
      if (e.key === 'Tab') {
        const root = drawerRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
      // Restore focus to the element that opened the drawer
      const prev = previouslyFocused.current;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch { /* noop */ }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startLongPress = (item: MenuItem) => {
    longPressFired.current = false;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      haptic('heavy');
      setQuickAction(item);
    }, 500);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const buildItemUrl = (item: MenuItem): string | null => {
    if (!item.path) return null;
    const origin = getPublicOrigin?.() || (typeof window !== 'undefined' ? window.location.origin : '');
    return `${origin}${item.path}`;
  };

  const handleCopyLink = async (item: MenuItem) => {
    const url = buildItemUrl(item);
    if (!url) {
      toast({ title: 'No link available', description: 'This action has no shareable link.' });
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      hapticSuccess();
      toast({ title: 'Link copied', description: item.label });
    } catch {
      toast({ title: 'Copy failed', description: 'Please try again.', variant: 'destructive' });
    }
    setQuickAction(null);
  };

  const handleShare = async (item: MenuItem) => {
    const url = buildItemUrl(item);
    const shareData: ShareData = {
      title: item.label,
      text: item.description || item.label,
      ...(url ? { url } : {}),
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        hapticSuccess();
      } else if (url) {
        await navigator.clipboard.writeText(url);
        hapticSuccess();
        toast({ title: 'Link copied', description: 'Sharing is not supported on this device.' });
      } else {
        toast({ title: 'Nothing to share' });
      }
    } catch {
      // user dismissed
    }
    setQuickAction(null);
  };

  const handleDetails = (item: MenuItem) => {
    setQuickAction(null);
    handleItemClick(item);
  };

  const handleClose = () => {
    hapticTap();
    setQuery('');
    onOpenChange(false);
  };

  const handleItemClick = (item: MenuItem) => {
    if (longPressFired.current) {
      // long-press handled — do not navigate on the trailing click
      longPressFired.current = false;
      return;
    }
    hapticImpact();
    setQuery('');
    onOpenChange(false);
    if (item.onClick) {
      item.onClick();
    } else if (item.path) {
      navigate(item.path);
    }
  };

  const menuSections: MenuSection[] = [
    {
      title: 'Money',
      items: [
        { 
          icon: Calendar, 
          label: 'My Repayment Schedule', 
          description: 'Daily plan, progress & share as PDF',
          onClick: onRepaymentSchedule,
          color: 'text-primary',
          badge: 'PDF & WhatsApp'
        },
        { 
          icon: Home, 
          label: 'Pay Rent to Landlord', 
          description: 'Direct landlord payment',
          onClick: onPayLandlord,
          color: 'text-success'
        },
        { 
          icon: CreditCard, 
          label: 'Pay Welile', 
          description: 'Via Mobile Money',
          onClick: onPayWelile,
          color: 'text-amber-500'
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
          label: 'Transaction History', 
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
        { 
          icon: Receipt, 
          label: 'My Receipts', 
          description: 'Earn rewards & rent discounts',
          path: '/my-receipts',
          color: 'text-teal-500',
        },
      ]
    },
    {
      title: 'Home',
      items: [
        ...(onBrowseHouses ? [{ 
          icon: Search, 
          label: 'Available Houses — Daily Rent', 
          description: 'Browse affordable houses, pay daily',
          onClick: onBrowseHouses,
          color: 'text-success',
          badge: 'New'
        } as MenuItem] : []),
        { 
          icon: PiggyBank, 
          label: 'Welile Homes', 
          description: 'Turn rent into a future home',
          path: '/welile-homes',
          color: 'text-emerald-500'
        },
        { 
          icon: Calculator, 
          label: 'Rent Calculator', 
          description: 'Estimate your daily plan',
          onClick: onRentCalculator,
          color: 'text-indigo-500'
        },
        { 
          icon: ShoppingBag, 
          label: 'Marketplace', 
          description: 'Shop daily essentials',
          path: '/marketplace',
          color: 'text-orange-500',
        },
      ]
    },
    {
      title: 'Profile',
      items: [
        { 
          icon: Users, 
          label: 'My Referrals', 
          description: 'People you have invited',
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
        { 
          icon: ScrollText, 
          label: 'Tenant Agreement', 
          description: 'Terms & conditions',
          path: '/tenant-agreement',
          color: 'text-muted-foreground'
        },
        { 
          icon: Settings, 
          label: 'Settings', 
          description: 'Account preferences',
          path: '/settings',
          color: 'text-muted-foreground'
        },
      ]
    },
    {
      title: 'Support',
      items: [
        { 
          icon: Download, 
          label: 'Share App', 
          description: 'Invite friends to Welile',
          path: '/install',
          color: 'text-primary'
        },
      ]
    },
  ];

  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return menuSections;
    return menuSections
      .map((s) => ({
        ...s,
        items: s.items.filter(
          (i) =>
            i.label.toLowerCase().includes(q) ||
            (i.description?.toLowerCase().includes(q) ?? false),
        ),
      }))
      .filter((s) => s.items.length > 0);
  }, [query, menuSections]);

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
            aria-label="Tenant menu"
            ref={drawerRef}
            tabIndex={-1}
            className={cn(
              "fixed right-0 top-0 bottom-0 w-[86%] max-w-sm bg-background z-[101] shadow-2xl overflow-hidden flex flex-col transition-transform duration-300 ease-out will-change-transform",
              visible ? "translate-x-0" : "translate-x-full",
            )}
          >
            {/* Header (title only) */}
            <div className="border-b border-border/60 bg-background/80 backdrop-blur">
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <h2 className="font-bold text-[17px] tracking-tight leading-tight">Menu</h2>
                  <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">Everything in one place</p>
                </div>
                <button
                  onClick={handleClose}
                  aria-label="Close menu"
                  className="h-9 w-9 rounded-full bg-muted/70 hover:bg-muted active:scale-95 transition-all flex items-center justify-center"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Scrollable Content — WhatsApp-style settings list */}
            <div className="flex-1 overflow-y-auto overscroll-contain bg-background">
              {/* Sticky WhatsApp-style search */}
              <div className="sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border/50 px-3 py-2.5">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    inputMode="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search menu…"
                    className="w-full h-10 pl-9 pr-9 rounded-full bg-muted/70 border border-transparent text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:bg-background focus:border-border transition-all"
                  />
                  {query && (
                    <button
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-muted hover:bg-muted-foreground/20 flex items-center justify-center"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>


              {extraContent && (
                <div className="px-4 py-3 border-b border-border/60 space-y-3">
                  {extraContent}
                </div>
              )}

              {filteredSections.length === 0 ? (
                <div className="text-center py-12 text-[13px] text-muted-foreground">
                  No results for “{query}”.
                </div>
              ) : (
                <>
                {!query.trim() && filteredSections.length > 1 && (() => {
                  const titles = filteredSections.map((s) => s.title);
                  const allCollapsed = titles.every((t) => !!collapsed[t]);
                  const allExpanded = titles.every((t) => !collapsed[t]);
                  return (
                    <div className="flex items-center justify-end gap-1 px-3 pt-2 pb-1">
                      <button
                        type="button"
                        onClick={() => setAllCollapsed(titles, false)}
                        disabled={allExpanded}
                        className="text-[11px] font-medium uppercase tracking-wide px-2 py-1 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        aria-label="Expand all sections"
                      >
                        Expand all
                      </button>
                      <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                      <button
                        type="button"
                        onClick={() => setAllCollapsed(titles, true)}
                        disabled={allCollapsed}
                        className="text-[11px] font-medium uppercase tracking-wide px-2 py-1 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        aria-label="Collapse all sections"
                      >
                        Collapse all
                      </button>
                    </div>
                  );
                })()}
                <nav aria-label="Tenant menu navigation">
                {filteredSections.map((section) => {
                  const sectionId = `tenant-menu-section-${section.title.toLowerCase().replace(/\s+/g, '-')}`;
                  const listId = `${sectionId}-list`;
                  // Force-expand while searching so matches are visible
                  const isCollapsed = !query.trim() && !!collapsed[section.title];
                  return (
                  <section key={section.title} className="py-1" aria-labelledby={sectionId}>
                    <h3 id={sectionId} className="px-2 pt-3 pb-0.5">
                      <button
                        type="button"
                        onClick={() => toggleSection(section.title)}
                        aria-expanded={!isCollapsed}
                        aria-controls={listId}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-[11px] font-semibold text-muted-foreground tracking-wide uppercase hover:bg-muted/40 active:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        <span className="flex items-center gap-1.5">
                          {section.title}
                          <span className="text-[10px] font-medium text-muted-foreground/60 normal-case tracking-normal">({section.items.length})</span>
                        </span>
                        <ChevronDown
                          aria-hidden="true"
                          className={cn(
                            "h-3.5 w-3.5 text-muted-foreground/70 transition-transform duration-200",
                            isCollapsed ? "-rotate-90" : "rotate-0",
                          )}
                        />
                      </button>
                    </h3>
                    {!isCollapsed && (
                        <ul
                          id={listId}
                          role="list"
                          className="m-0 p-0 list-none overflow-hidden animate-fade-in"
                        >
                          {section.items.map((item, itemIndex) => {
                        const isActive = !!item.path && (location.pathname === item.path || location.pathname.startsWith(item.path + '/'));
                        const ariaLabel = [
                          item.label,
                          item.description,
                          isActive ? '(current page)' : null,
                          item.badge && !isActive ? `(${item.badge})` : null,
                        ].filter(Boolean).join('. ');
                        return (
                          <li key={item.label}>
                            <button
                              type="button"
                              onPointerDown={() => { hapticSelection(); startLongPress(item); }}
                              onPointerUp={cancelLongPress}
                              onPointerLeave={cancelLongPress}
                              onPointerCancel={cancelLongPress}
                              onContextMenu={(e) => { e.preventDefault(); }}
                              onClick={() => handleItemClick(item)}
                              aria-current={isActive ? 'page' : undefined}
                              aria-label={ariaLabel}
                              className={cn(
                                "relative w-full min-h-[48px] flex items-center gap-4 pl-4 pr-3 py-2.5 transition-colors duration-100 text-left touch-manipulation select-none",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-inset",
                                isActive
                                  ? "bg-muted/70 hover:bg-muted/80 active:bg-muted"
                                  : "hover:bg-muted/40 active:bg-muted/70",
                              )}
                            >
                              {isActive && (
                                <span aria-hidden="true" className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-foreground" />
                              )}
                              <item.icon
                                aria-hidden="true"
                                strokeWidth={1.75}
                                className={cn(
                                  "h-[20px] w-[20px] shrink-0",
                                  isActive ? "text-foreground" : "text-foreground/80",
                                )}
                              />
                              <div className="flex-1 min-w-0 border-b border-border/50 py-2"
                                   style={itemIndex === section.items.length - 1 ? { borderBottom: 'none' } : undefined}>
                                <div className="flex items-center gap-1.5">
                                  <p className={cn(
                                    "text-[15px] truncate leading-tight text-foreground",
                                    isActive ? "font-semibold" : "font-normal",
                                  )}>{item.label}</p>
                                  {isActive && (
                                    <span className="px-1.5 py-px text-[9px] font-bold bg-foreground text-background rounded-full uppercase tracking-wide whitespace-nowrap">
                                      Current
                                    </span>
                                  )}
                                  {!isActive && item.badge && (
                                    <span className="px-1.5 py-px text-[9px] font-bold border border-border text-foreground/70 rounded-full uppercase tracking-wide whitespace-nowrap">
                                      {item.badge}
                                    </span>
                                  )}
                                </div>
                                {item.description && (
                                  <p className="text-[12px] text-muted-foreground truncate leading-tight mt-0.5">{item.description}</p>
                                )}
                              </div>
                            </button>
                          </li>
                        );
                          })}
                        </ul>
                    )}
                  </section>
                  );
                })}
                </nav>
                </>
              )}

              <p className="text-center text-[11px] text-muted-foreground/60 pt-6 pb-6 font-medium tracking-wide">
                Welile · Tenant
              </p>
            </div>
          </div>

          {/* Long-press quick actions */}
          <Sheet open={!!quickAction} onOpenChange={(o) => !o && setQuickAction(null)}>
            <SheetContent side="bottom" className="z-[110] rounded-t-2xl px-0 pb-6 pt-3 max-h-[70vh]">
              <div aria-hidden="true" className="mx-auto h-1 w-10 rounded-full bg-muted mb-3" />
              {quickAction && (
                <>
                  <SheetHeader className="px-5 text-left">
                    <SheetTitle className="text-[16px] font-semibold leading-tight">{quickAction.label}</SheetTitle>
                    {quickAction.description && (
                      <SheetDescription className="text-[12px]">{quickAction.description}</SheetDescription>
                    )}
                  </SheetHeader>
                  <div className="mt-3">
                    <button
                      type="button"
                      onPointerDown={() => hapticSelection()}
                      onClick={() => handleCopyLink(quickAction)}
                      className="w-full min-h-[52px] flex items-center gap-3 px-5 py-3 hover:bg-muted/50 active:bg-muted/80 transition-colors text-left"
                    >
                      <div aria-hidden="true" className="h-9 w-9 rounded-full bg-muted flex items-center justify-center">
                        <Link2 className="h-[18px] w-[18px] text-foreground/80" />
                      </div>
                      <span className="text-[14px] font-medium">Copy link</span>
                    </button>
                    <button
                      type="button"
                      onPointerDown={() => hapticSelection()}
                      onClick={() => handleShare(quickAction)}
                      className="w-full min-h-[52px] flex items-center gap-3 px-5 py-3 hover:bg-muted/50 active:bg-muted/80 transition-colors text-left"
                    >
                      <div aria-hidden="true" className="h-9 w-9 rounded-full bg-muted flex items-center justify-center">
                        <Share2 className="h-[18px] w-[18px] text-foreground/80" />
                      </div>
                      <span className="text-[14px] font-medium">Share</span>
                    </button>
                    <button
                      type="button"
                      onPointerDown={() => hapticSelection()}
                      onClick={() => handleDetails(quickAction)}
                      className="w-full min-h-[52px] flex items-center gap-3 px-5 py-3 hover:bg-muted/50 active:bg-muted/80 transition-colors text-left"
                    >
                      <div aria-hidden="true" className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                        <Info className="h-[18px] w-[18px] text-primary" />
                      </div>
                      <span className="text-[14px] font-medium text-primary">Open details</span>
                    </button>
                  </div>
                </>
              )}
            </SheetContent>
          </Sheet>
    </>
  );
}
