import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { 
  X, 
  UserPlus, 
  ArrowDownCircle,
  TrendingUp,
  Store,
  Search,
  History,
  Receipt,
  Banknote,
  Users,
  HandCoins,
  Share2,
  Download,
  Trophy,
  Target,
  FileText,
  Handshake,
  ChevronDown,
  Calculator,
  Home,
  Settings,
  HelpCircle,
  ScrollText,
  BarChart3,
  PiggyBank,
  Building2,
  Calendar,
  Wallet,
  ShieldCheck,
  MapPin,
  Zap,
  Droplets,
  Phone,
  RefreshCw,
  ClipboardList,
  Briefcase,
  Heart,
  BookOpen,
  LucideIcon,
  FileDown,
  Megaphone,
} from 'lucide-react';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import { GlossaryButton } from '@/components/shared/GlossaryButton';
import partnerContractAsset from '@/assets/welile-partner-contract.pdf.asset.json';

interface AgentMenuDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeposit: () => void;
  onPostRentRequest: () => void;
  onInviteSubAgent: () => void;
  onOpenEarningsRank: () => void;
  onManageProperty?: () => void;
  onViewManagedProperties?: () => void;
  onViewMyRentRequests?: () => void;
  onTopUpTenant?: () => void;
  onViewTenants?: () => void;
  onFundPartner?: () => void;
  onViewProxyHistory?: () => void;
  onIssueReceipt?: () => void;
  onViewLandlordMap?: () => void;
  onFindRentals?: () => void;
  onListEmptyHouse?: () => void;
  onViewMyListings?: () => void;
  onViewSubAgents?: () => void;
  onViewLandlords?: () => void;
  onShareSubAgentLink?: () => void;
  onManageFunders?: () => void;
  onOpenPartnerDashboard?: () => void;
  onInviteFunder?: () => void;
  onInviteAngelPartner?: () => void;
  onOpenRequisition?: () => void;
  onShareTenantForm?: () => void;
  onInviteTenant?: () => void;
  onSharePartnerForm?: () => void;
  onShareLandlordSignup?: () => void;
  onRequestAdvance?: () => void;
  onViewCreditAccess?: () => void;
  onViewSavedDrafts?: () => void;
  onDownloadLandlordForm?: () => void;
  onDownloadTenantForm?: () => void;
  onOpenRentPoster?: () => void;
  isFinancialAgent?: boolean;
  /**
   * Merchant Agents (cash-out only) must not access tenant / landlord / house
   * operations. When true, those menu entries are removed entirely.
   */
  restricted?: boolean;
}

interface MenuItem {
  icon: LucideIcon;
  label: string;
  description?: string;
  path?: string;
  onClick?: () => void;
  badge?: string;
  accent: string; // tailwind color key like 'primary', 'success', 'blue-500'
}

interface Category {
  id: string;
  icon: LucideIcon;
  label: string;
  items: MenuItem[];
}

export function AgentMenuDrawer({ 
  open, 
  onOpenChange, 
  onDeposit,
  onPostRentRequest,
  onInviteSubAgent,
  onOpenEarningsRank,
  onManageProperty,
  onViewManagedProperties,
  onViewMyRentRequests,
  onTopUpTenant,
  onViewTenants,
  onFundPartner,
  onViewProxyHistory,
  onIssueReceipt,
  onViewLandlordMap,
  onFindRentals,
  onListEmptyHouse,
  onViewMyListings,
  onViewSubAgents,
  onViewLandlords,
  onShareSubAgentLink,
  onManageFunders,
  onOpenPartnerDashboard,
  onInviteFunder,
  onInviteAngelPartner,
  onOpenRequisition,
  onShareTenantForm,
  onInviteTenant,
  onSharePartnerForm,
  onShareLandlordSignup,
  onRequestAdvance,
  onViewCreditAccess,
  onViewSavedDrafts,
  onDownloadLandlordForm,
  onDownloadTenantForm,
  onOpenRentPoster,
  isFinancialAgent = false,
  restricted = false,
}: AgentMenuDrawerProps) {
  const navigate = useNavigate();
  const [activeCategory, setActiveCategory] = useState('money');
  const [guideOpen, setGuideOpen] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const handleClose = () => {
    hapticTap();
    setSearch('');
    onOpenChange(false);
  };

  const handleItemClick = (item: MenuItem) => {
    hapticSuccess();
    onOpenChange(false);
    if (item.onClick) {
      item.onClick();
    } else if (item.path) {
      navigate(item.path);
    }
  };

  const categories: Category[] = [
    {
      id: 'money',
      icon: Banknote,
      label: '💰 Money',
      items: [
        { icon: Banknote, label: 'Pay Rent', description: 'Pay rent for your tenant', onClick: onTopUpTenant, accent: 'primary', badge: '★' },
        { icon: ArrowDownCircle, label: 'Deposit', description: 'Add funds to wallet', onClick: onDeposit, accent: 'success' },
        { icon: Wallet, label: 'Top Up Wallet', description: 'Deposit to tenant wallet', onClick: onTopUpTenant, accent: 'emerald-500' },
        { icon: HandCoins, label: 'Fund Partner', description: 'Proxy funding', onClick: onFundPartner, accent: 'emerald-600', badge: 'Proxy' },
        { icon: Receipt, label: 'Issue Receipt', description: 'Record cash payment', onClick: onIssueReceipt, accent: 'amber-500' },
        { icon: Banknote, label: 'Cash, Mobile Money & Bank Payouts', description: 'Verify & pay cash-outs', path: '/agent/cash-payouts', accent: 'orange-500', badge: '💵' },
        { icon: Wallet, label: 'Request Advance', description: 'Get funds to your wallet', onClick: onRequestAdvance, accent: 'purple-500', badge: '💰' },
      ].filter(i => i.onClick !== undefined || i.path !== undefined),
    },
    {
      id: 'share',
      icon: Share2,
      label: '📤 Share',
      items: [
        { icon: Share2, label: 'Share Tenant Form', description: 'Send registration link', onClick: onShareTenantForm, accent: 'teal-500', badge: '🔗' },
        { icon: Building2, label: 'Share Landlord Signup', description: 'Invite landlords', onClick: onShareLandlordSignup, accent: 'purple-600', badge: '🏠' },
        { icon: UserPlus, label: 'Share Partner Form', description: 'Partner signup link', onClick: onSharePartnerForm, accent: 'emerald-600', badge: '🤝' },
        { icon: Heart, label: 'Invite Funder', description: 'Share signup for funders', onClick: onInviteFunder, accent: 'primary', badge: '💜' },
        { icon: Briefcase, label: 'Invite Partner', description: 'Angel Pool signup link', onClick: onInviteAngelPartner, accent: 'purple-500', badge: '🦄' },
        { icon: Share2, label: 'Recruit Sub-Agent', description: 'WhatsApp / Copy link', onClick: onShareSubAgentLink, accent: 'green-500', badge: '🔗' },
        { icon: Share2, label: 'Campaign Links', description: 'Field recruitment & QR codes', path: '/agent/campaigns', accent: 'orange-500', badge: '📣' },
        { icon: Share2, label: 'Invite & Refer', description: 'Grow your network', path: '/referrals', accent: 'pink-500' },
      ].filter(i => i.onClick !== undefined || i.path !== undefined),
    },
    {
      id: 'people',
      icon: Users,
      label: '👥 People',
      items: [
        { icon: Users, label: 'My Tenants', description: 'Repayment schedules', onClick: onViewTenants, accent: 'primary' },
        { icon: UserPlus, label: 'Onboard Tenant', description: 'Invite link — you earn commission', onClick: onInviteTenant, accent: 'teal-500', badge: '🔗' },
        { icon: ClipboardList, label: 'Registrations', description: 'Invite status & links', path: '/agent-registrations', accent: 'blue-600' },
        { icon: Building2, label: 'My Landlords', description: 'Registered & referred status', onClick: onViewLandlords, accent: 'emerald-600', badge: '🏠' },
        { icon: ScrollText, label: 'Rent Requests', description: 'Verify posted requests', onClick: onViewMyRentRequests, accent: 'indigo-500' },
        { icon: FileText, label: 'Saved Rent Drafts', description: 'Drafts waiting to unlock', onClick: onViewSavedDrafts, accent: 'amber-500', badge: '💾' },
        { icon: Calendar, label: 'Schedules', description: 'PDF & WhatsApp', onClick: onViewMyRentRequests, accent: 'primary', badge: 'PDF' },
        { icon: History, label: 'Proxy History', description: 'Partner funding records', onClick: onViewProxyHistory, accent: 'emerald-500' },
        { icon: HandCoins, label: 'My Funders', description: 'No-smartphone partners', onClick: onManageFunders, accent: 'primary', badge: '📱' },
        { icon: Handshake, label: 'Register Sub-Agent', description: 'Add to your team', onClick: onInviteSubAgent, accent: 'amber-500', badge: '500' },
        { icon: Users, label: 'My Sub-Agents', description: 'View your team', onClick: onViewSubAgents, accent: 'orange-500' },
      ].filter(i => i.onClick !== undefined || i.path !== undefined),
    },
    {
      id: 'property',
      icon: Home,
      label: '🏠 Property',
      items: [
        { icon: Home, label: 'List House', description: 'UGX 2,000 on verification', onClick: onListEmptyHouse, accent: 'chart-4', badge: '2K' },
        { icon: ClipboardList, label: 'My Listings', description: 'View listed houses', onClick: onViewMyListings, accent: 'teal-500' },
        { icon: Building2, label: 'Manage Property', description: 'For landlords', onClick: onManageProperty, accent: 'orange-500', badge: '2%' },
        { icon: Home, label: 'Managed Props', description: 'Properties & payouts', onClick: onViewManagedProperties, accent: 'teal-500' },
        { icon: Search, label: 'Find Rentals', description: 'Browse by location', onClick: onFindRentals, accent: 'violet-500' },
        { icon: MapPin, label: 'Landlord Map', description: 'Navigate to landlords', onClick: onViewLandlordMap, accent: 'emerald-500', badge: 'GPS' },
        { icon: FileText, label: 'Post Rent', description: 'Request on behalf of tenant', onClick: onPostRentRequest, accent: 'blue-600' },
      ].filter(i => i.onClick !== undefined),
    },
    {
      id: 'earnings',
      icon: TrendingUp,
      label: '📊 Earnings',
      items: [
        { icon: BarChart3, label: 'Partner Dashboard', description: 'Partners & commissions', onClick: onOpenPartnerDashboard, accent: 'emerald-500', badge: 'New' },
        { icon: TrendingUp, label: 'Rent Fee Available', description: 'View your credit limit', onClick: onViewCreditAccess, accent: 'purple-500', badge: '📊' },
        { icon: Trophy, label: 'Rank System', description: 'Levels & badges', onClick: onOpenEarningsRank, accent: 'amber-500' },
        { icon: TrendingUp, label: 'My Earnings', description: 'Detailed breakdown', path: '/earnings', accent: 'success' },
        { icon: Target, label: 'Goals', description: 'Track targets', path: '/agent-analytics', accent: 'primary' },
        { icon: BarChart3, label: 'Analytics', description: 'Performance metrics', path: '/agent-analytics', accent: 'purple-500' },
        { icon: PiggyBank, label: 'Withdrawals', description: 'Commission payouts', path: '/earnings', accent: 'success' },
        { icon: Users, label: 'Referrals', description: 'Users you brought in', path: '/referrals', accent: 'purple-500' },
      ],
    },
    {
      id: 'pdfs',
      icon: FileDown,
      label: '📄 Downloadable PDFs',
      items: [
        { icon: Building2, label: 'Landlord Reg Form', description: 'Download or share on WhatsApp', onClick: onDownloadLandlordForm, accent: 'emerald-600', badge: '📲' },
        { icon: UserPlus, label: 'Tenant Reg Form', description: 'Download or share on WhatsApp', onClick: onDownloadTenantForm, accent: 'blue-600', badge: '📲' },
        { icon: Megaphone, label: 'Available for Rent Poster', description: 'Print or share on WhatsApp', onClick: onOpenRentPoster, accent: 'purple-500', badge: '📲' },
        { icon: ScrollText, label: 'Partner Contract', description: 'Download the partner agreement', onClick: () => { window.open(partnerContractAsset.url, '_blank', 'noopener,noreferrer'); }, accent: 'indigo-500', badge: '📄' },
      ].filter(i => i.onClick !== undefined),
    },
    {
      id: 'tools',
      icon: Calculator,
      label: '🛠 Tools',
      items: [
        { icon: Store, label: 'Shop', description: 'Buy & sell', path: '/shop', accent: 'orange-500' },
        { icon: Receipt, label: 'Receipts', description: 'Scan to earn', path: '/my-receipts', accent: 'teal-500' },
        ...(isFinancialAgent ? [{ icon: FileText, label: 'Fund Requisition', description: 'Submit financial requests', onClick: onOpenRequisition, accent: 'primary', badge: 'FA' }] : []),
        { icon: Banknote, label: 'My Loans', description: 'View & manage', path: '/my-loans', accent: 'green-500' },
        { icon: History, label: 'Transactions', description: 'Payment history', path: '/transactions', accent: 'blue-500' },
        { icon: FileText, label: 'Statement', description: 'Financial statement', path: '/financial-statement', accent: 'indigo-500' },
        { icon: Calculator, label: 'Calculator', description: 'Rent & interest', path: '/calculator', accent: 'indigo-500' },
      ],
    },
    {
      id: 'more',
      icon: Settings,
      label: '⋯ More',
      items: [
        { icon: BookOpen, label: 'Internship Program', description: 'Earn while you learn', path: '/internship', accent: 'amber-500', badge: '🎓' },
        { icon: Briefcase, label: 'Apply for a Job', description: 'Developers, sales & more', path: '/careers', accent: 'indigo-500', badge: '💼' },
        { icon: Download, label: 'Share App', path: '/install', accent: 'primary' },
        { icon: ScrollText, label: 'Agreement', path: '/agent-agreement', accent: 'muted-foreground' },
        { icon: Settings, label: 'Settings', path: '/settings', accent: 'muted-foreground' },
        { icon: HelpCircle, label: 'Help', path: '/help', accent: 'muted-foreground' },
      ],
    },
  ];

  // Merchant Agents are payout-only. Strip every tenant / landlord / house
  // operational entry so they cannot be reached via the menu drawer.
  const MERCHANT_BLOCKED_LABELS = new Set<string>([
    // Tenant operations
    'Pay Rent', 'Top Up Wallet', 'Issue Receipt', 'Share Tenant Form', 'Tenant Reg Form',
    'My Tenants', 'Rent Requests', 'Saved Rent Drafts', 'Schedules', 'Post Rent',
    // Landlord operations
    'Share Landlord Signup', 'Landlord Reg Form', 'My Landlords', 'Landlord Map',
    'Manage Property', 'Managed Props',
    // House listing
    'List House', 'My Listings',
  ]);
  const visibleCategories = restricted
    ? categories
        .map((c) => ({ ...c, items: c.items.filter((i) => !MERCHANT_BLOCKED_LABELS.has(i.label)) }))
        .filter((c) => c.items.length > 0)
    : categories;

  const activeCat =
    visibleCategories.find((c) => c.id === activeCategory) || visibleCategories[0];

  // Flat, cross-category search — type once, jump anywhere. The single biggest
  // win for agents who manage lots of borrowers and can't remember which tab
  // a given action lives under.
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const searchResults = searching
    ? visibleCategories.flatMap((cat) =>
        cat.items.map((item) => ({ item, catLabel: cat.label })),
      ).filter(({ item }) =>
        item.label.toLowerCase().includes(query) ||
        (item.description?.toLowerCase().includes(query) ?? false),
      )
    : [];

  const getAccentClasses = (accent: string) => {
    const map: Record<string, { bg: string; text: string; ring: string }> = {
      'primary': { bg: 'bg-primary/15', text: 'text-primary', ring: 'ring-primary/20' },
      'success': { bg: 'bg-success/15', text: 'text-success', ring: 'ring-success/20' },
      'chart-4': { bg: 'bg-chart-4/15', text: 'text-chart-4', ring: 'ring-chart-4/20' },
      'blue-500': { bg: 'bg-blue-500/15', text: 'text-blue-500', ring: 'ring-blue-500/20' },
      'blue-600': { bg: 'bg-blue-600/15', text: 'text-blue-600', ring: 'ring-blue-600/20' },
      'amber-500': { bg: 'bg-amber-500/15', text: 'text-amber-500', ring: 'ring-amber-500/20' },
      'emerald-500': { bg: 'bg-emerald-500/15', text: 'text-emerald-500', ring: 'ring-emerald-500/20' },
      'emerald-600': { bg: 'bg-emerald-600/15', text: 'text-emerald-600', ring: 'ring-emerald-600/20' },
      'teal-500': { bg: 'bg-teal-500/15', text: 'text-teal-500', ring: 'ring-teal-500/20' },
      'orange-500': { bg: 'bg-orange-500/15', text: 'text-orange-500', ring: 'ring-orange-500/20' },
      'violet-500': { bg: 'bg-violet-500/15', text: 'text-violet-500', ring: 'ring-violet-500/20' },
      'pink-500': { bg: 'bg-pink-500/15', text: 'text-pink-500', ring: 'ring-pink-500/20' },
      'purple-500': { bg: 'bg-purple-500/15', text: 'text-purple-500', ring: 'ring-purple-500/20' },
      'indigo-500': { bg: 'bg-indigo-500/15', text: 'text-indigo-500', ring: 'ring-indigo-500/20' },
      'green-500': { bg: 'bg-green-500/15', text: 'text-green-500', ring: 'ring-green-500/20' },
      'muted-foreground': { bg: 'bg-muted', text: 'text-muted-foreground', ring: 'ring-border' },
    };
    return map[accent] || map['primary'];
  };

  if (!open) return null;

  return (
        <>
          {/* Backdrop */}
          <div
            onClick={handleClose}
            className="fixed inset-0 bg-black/60 z-[100] animate-fade-in"
          />

          {/* Bottom Sheet */}
          <div
            className="fixed inset-x-0 bottom-0 z-[101] bg-background rounded-t-3xl shadow-2xl flex flex-col animate-slide-up"
            style={{ maxHeight: '88vh' }}
          >
            {/* Drag Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pb-3">
              <h2 className="font-bold text-lg">Agent Hub</h2>
              <button
                onClick={handleClose}
                className="p-2 rounded-full bg-muted hover:bg-muted/80 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Search — type to jump to any action across every category */}
            <div className="px-4 pb-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  inputMode="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search actions… (e.g. deposit, tenant, advance)"
                  aria-label="Search agent actions"
                  className="w-full h-11 pl-9 pr-9 rounded-2xl bg-muted/60 border border-border/50 text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-all"
                />
                {search.length > 0 && (
                  <button
                    onClick={() => { hapticTap(); setSearch(''); }}
                    aria-label="Clear search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-full bg-muted hover:bg-muted-foreground/20 transition-colors"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
            </div>

            {/* Category Tabs — Horizontal Scroll (hidden while searching) */}
            {!searching && (
            <div className="px-3 pb-3">
              <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1">
                {visibleCategories.map((cat) => {
                  const isActive = cat.id === activeCategory;
                  const CatIcon = cat.icon;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => { hapticTap(); setActiveCategory(cat.id); }}
                      className={cn(
                        "flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-all shrink-0",
                        isActive
                          ? "bg-primary text-primary-foreground shadow-md"
                          : "bg-muted/60 text-muted-foreground hover:bg-muted"
                      )}
                    >
                      <CatIcon className="h-3.5 w-3.5" />
                      {cat.label}
                      {cat.items.some(i => i.badge) && !isActive && (
                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            )}

            {/* Content Grid */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
              {searching ? (
                /* === SEARCH RESULTS — flat list across all categories === */
                searchResults.length > 0 ? (
                  <div className="space-y-2 animate-fade-in">
                    <p className="text-[11px] font-semibold text-muted-foreground px-1">
                      {searchResults.length} {searchResults.length === 1 ? 'result' : 'results'}
                    </p>
                    {searchResults.map(({ item, catLabel }, idx) => {
                      const colors = getAccentClasses(item.accent);
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.label + idx}
                          onClick={() => handleItemClick(item)}
                          className="w-full flex items-center gap-3 p-3 rounded-2xl border border-border/50 bg-card hover:bg-muted/40 active:scale-[0.98] transition-all touch-manipulation text-left"
                        >
                          <div className={cn("p-2.5 rounded-xl shrink-0", colors.bg)}>
                            <Icon className={cn("h-5 w-5", colors.text)} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-sm font-semibold leading-tight truncate">{item.label}</p>
                              {item.badge && (
                                <span className="px-1.5 py-0.5 text-[9px] font-bold bg-success/20 text-success rounded-full leading-none shrink-0">
                                  {item.badge}
                                </span>
                              )}
                            </div>
                            {item.description && (
                              <p className="text-[11px] text-muted-foreground leading-tight truncate mt-0.5">{item.description}</p>
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground/70 shrink-0">{catLabel}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-center animate-fade-in">
                    <div className="p-3 rounded-2xl bg-muted/60 mb-3">
                      <Search className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-semibold">No actions found</p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">
                      Nothing matches “{search.trim()}”. Try a shorter word like “rent”, “pay”, or “tenant”.
                    </p>
                  </div>
                )
              ) : (
              <div
                key={activeCategory}
                className="animate-fade-in"
              >
                  {/* Build Your Team CTA — visible in People tab */}
                  {activeCategory === 'people' && (
                    <div className="mb-3 rounded-2xl border-2 border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-orange-500/10 p-3">
                      <div className="flex items-center gap-2.5 mb-2">
                        <div className="p-2 rounded-xl bg-amber-500/20">
                          <Users className="h-5 w-5 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm">Build Your Team 🚀</p>
                          <p className="text-[10px] text-muted-foreground">Earn <span className="font-bold text-amber-600">UGX 500</span> per signup + <span className="font-bold text-amber-600">2%</span> of their collections</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5">
                        <button
                          onClick={() => { hapticSuccess(); onInviteSubAgent(); onOpenChange(false); }}
                          className="flex flex-col items-center gap-1 p-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 active:scale-95 transition-all touch-manipulation"
                        >
                          <Handshake className="h-4 w-4 text-amber-600" />
                          <span className="text-[9px] font-semibold text-amber-700">Register</span>
                        </button>
                        <button
                          onClick={() => { hapticSuccess(); if (onViewSubAgents) onViewSubAgents(); onOpenChange(false); }}
                          className="flex flex-col items-center gap-1 p-2 rounded-xl bg-orange-500/15 hover:bg-orange-500/25 active:scale-95 transition-all touch-manipulation"
                        >
                          <Users className="h-4 w-4 text-orange-600" />
                          <span className="text-[9px] font-semibold text-orange-700">My Team</span>
                        </button>
                        <button
                          onClick={() => { hapticSuccess(); if (onShareSubAgentLink) onShareSubAgentLink(); onOpenChange(false); }}
                          className="flex flex-col items-center gap-1 p-2 rounded-xl bg-green-500/15 hover:bg-green-500/25 active:scale-95 transition-all touch-manipulation"
                        >
                          <Share2 className="h-4 w-4 text-green-600" />
                          <span className="text-[9px] font-semibold text-green-700">Share Link</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Icon Grid */}
                  <div className="grid grid-cols-3 gap-2.5">
                    {activeCat.items.map((item, idx) => {
                      const colors = getAccentClasses(item.accent);
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.label + idx}
                          onClick={() => handleItemClick(item)}
                          className={cn(
                            "relative flex flex-col items-center gap-2 p-4 rounded-2xl border border-border/50 bg-card hover:bg-muted/40 active:scale-95 transition-all touch-manipulation",
                          )}
                        >
                          {item.badge && (
                            <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[9px] font-bold bg-success/20 text-success rounded-full leading-none">
                              {item.badge}
                            </span>
                          )}
                          <div className={cn("p-2.5 rounded-xl", colors.bg)}>
                            <Icon className={cn("h-5 w-5", colors.text)} />
                          </div>
                          <div className="text-center">
                            <p className="text-[11px] font-semibold leading-tight">{item.label}</p>
                            {item.description && (
                              <p className="text-[9px] text-muted-foreground leading-tight mt-0.5 line-clamp-2">{item.description}</p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Guides Section — only in "more" tab */}
                  {activeCategory === 'more' && (
                    <div className="mt-6 space-y-2">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 mb-3">
                        How It Works
                      </h4>
                      {/* Glossary — shared team vocabulary */}
                      <div className="mb-2">
                        <GlossaryButton variant="menu" label="Glossary — what each term means" />
                      </div>
                      <GuideAccordion
                        id="rent-payment"
                        icon={Wallet}
                        title="Rent Payments & Auto-Deductions"
                        subtitle="Learn the rent payment process"
                        accentClass="bg-success/10 text-success border-success/10"
                        isOpen={guideOpen === 'rent-payment'}
                        onToggle={() => setGuideOpen(guideOpen === 'rent-payment' ? null : 'rent-payment')}
                      >
                        <RentPaymentGuideContent />
                      </GuideAccordion>
                      <GuideAccordion
                        id="tenant-verify"
                        icon={ShieldCheck}
                        title="How to Verify a Tenant"
                        subtitle="Step-by-step field guide"
                        accentClass="bg-primary/5 text-primary border-primary/10"
                        isOpen={guideOpen === 'tenant-verify'}
                        onToggle={() => setGuideOpen(guideOpen === 'tenant-verify' ? null : 'tenant-verify')}
                      >
                        <TenantVerifyGuideContent />
                      </GuideAccordion>
                      <GuideAccordion
                        id="landlord-verify"
                        icon={Building2}
                        title="How to Verify a Landlord"
                        subtitle="Registration & verification steps"
                        accentClass="bg-amber-500/5 text-amber-500 border-amber-500/10"
                        isOpen={guideOpen === 'landlord-verify'}
                        onToggle={() => setGuideOpen(guideOpen === 'landlord-verify' ? null : 'landlord-verify')}
                      >
                        <LandlordVerifyGuideContent />
                      </GuideAccordion>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
  );
}

// --- Sub-components for guides ---

function GuideAccordion({ id, icon: Icon, title, subtitle, accentClass, isOpen, onToggle, children }: {
  id: string; icon: LucideIcon; title: string; subtitle: string; accentClass: string; isOpen: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={() => { hapticTap(); onToggle(); }}
        className={cn("w-full flex items-center gap-3 p-3 rounded-xl border text-left touch-manipulation", accentClass)}
      >
        <div className={cn("p-2 rounded-lg", accentClass.split(' ').slice(0, 1).join(' '))}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate">{title}</p>
          <p className="text-[10px] text-muted-foreground">{subtitle}</p>
        </div>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform shrink-0", isOpen && "rotate-180")} />
      </button>
      {isOpen && (
          <div className="overflow-hidden animate-fade-in">
            <div className="mt-2 px-2 py-3 rounded-xl bg-muted/40 border border-border/60 text-xs space-y-2">
              {children}
            </div>
          </div>
      )}
    </div>
  );
}

function StepItem({ num, color = 'primary', children }: { num: string; color?: string; children: React.ReactNode }) {
  const bgMap: Record<string, string> = {
    primary: 'bg-primary text-primary-foreground',
    success: 'bg-success text-success-foreground',
    'amber-500': 'bg-amber-500 text-white',
    warning: 'bg-warning text-warning-foreground',
    destructive: 'bg-destructive text-destructive-foreground',
  };
  return (
    <div className="flex gap-2">
      <span className={cn("shrink-0 h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold", bgMap[color] || bgMap.primary)}>
        {num}
      </span>
      <div className="text-xs">{children}</div>
    </div>
  );
}

function RentPaymentGuideContent() {
  return (
    <>
      <p className="text-[10px] font-bold text-primary uppercase tracking-wider mb-2">Paying Rent for a Tenant</p>
      <StepItem num="1"><p className="font-medium">Search Tenant</p><p className="text-muted-foreground">Search by name or phone number.</p></StepItem>
      <StepItem num="2"><p className="font-medium">Enter Amount</p><p className="text-muted-foreground">See outstanding balance and your wallet balance.</p></StepItem>
      <StepItem num="3"><p className="font-medium">Instant Processing</p><p className="text-muted-foreground">Money deducted from your wallet. You earn 5% commission.</p></StepItem>
      <StepItem num="✓" color="success"><p className="font-medium text-success">Receivables Updated</p><p className="text-muted-foreground">Statement updates immediately.</p></StepItem>
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-2 space-y-1.5 mt-2">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-3 w-3 text-warning" />
          <p className="text-[10px] font-bold text-warning uppercase tracking-wider">Auto-Deduction System</p>
        </div>
        <div className="text-[11px] text-muted-foreground leading-relaxed space-y-1">
          <p>1. System deducts from <strong className="text-foreground">tenant's wallet</strong> first</p>
          <p>2. If low → <strong className="text-foreground">agent's wallet</strong> covers shortfall</p>
          <p>3. If both low → recorded as <strong className="text-foreground">accumulated debt</strong></p>
        </div>
      </div>
    </>
  );
}

function TenantVerifyGuideContent() {
  return (
    <>
      <StepItem num="1"><p className="font-medium">Visit Tenant's Residence</p><p className="text-muted-foreground">Confirm they live at the address.</p></StepItem>
      <StepItem num="2"><p className="font-medium flex items-center gap-1"><Zap className="h-3 w-3" /> Verify Electricity Meter</p><p className="text-muted-foreground">Check UMEME/UEDCL meter number.</p></StepItem>
      <StepItem num="3"><p className="font-medium flex items-center gap-1"><Droplets className="h-3 w-3" /> Verify Water Meter</p><p className="text-muted-foreground">Check NWSC water meter.</p></StepItem>
      <StepItem num="4"><p className="font-medium flex items-center gap-1"><Phone className="h-3 w-3" /> Confirm MM Details</p><p className="text-muted-foreground">Verify MM name matches phone.</p></StepItem>
      <StepItem num="5"><p className="font-medium flex items-center gap-1"><MapPin className="h-3 w-3" /> Capture GPS</p><p className="text-muted-foreground">Pin the tenant's residence location.</p></StepItem>
      <StepItem num="✓" color="success"><p className="font-medium text-success">Tap "Verify"</p><p className="text-muted-foreground">Earn <strong>UGX 10,000</strong> + <strong>5%</strong> ongoing commission!</p></StepItem>
    </>
  );
}

function LandlordVerifyGuideContent() {
  return (
    <>
      <StepItem num="1" color="amber-500"><p className="font-medium">Visit Landlord's Property</p><p className="text-muted-foreground">Verify property exists and matches description.</p></StepItem>
      <StepItem num="2" color="amber-500"><p className="font-medium">Collect MM Details</p><p className="text-muted-foreground">Record Mobile Money name and number.</p></StepItem>
      <StepItem num="3" color="amber-500"><p className="font-medium flex items-center gap-1"><Zap className="h-3 w-3" /> Record Utility Meters</p><p className="text-muted-foreground">Note electricity and water meter numbers.</p></StepItem>
      <StepItem num="4" color="amber-500"><p className="font-medium">Get LC1 Details</p><p className="text-muted-foreground">Record LC1 Chairperson's name, phone & village.</p></StepItem>
      <StepItem num="5" color="amber-500"><p className="font-medium flex items-center gap-1"><MapPin className="h-3 w-3" /> Capture GPS</p><p className="text-muted-foreground">Tap "Capture GPS" at the property.</p></StepItem>
      <StepItem num="6" color="amber-500"><p className="font-medium">Register & Share Link</p><p className="text-muted-foreground">Share WhatsApp activation link.</p></StepItem>
      <StepItem num="✓" color="success"><p className="font-medium text-success">Landlord Verified!</p><p className="text-muted-foreground">They can now receive rent via Welile.</p></StepItem>
    </>
  );
}
