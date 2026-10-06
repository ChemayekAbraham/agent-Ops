import { useEffect, useRef, useState, lazy, Suspense, useMemo } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AgentOpsHomeView, type DateRange } from './agent-ops-v2/AgentOpsHomeView';
import { AgentOpsBottomNav, type BottomTab } from './agent-ops-v2/AgentOpsBottomNav';

const PortfolioPerformanceReport = lazy(() => import('@/pages/tenant-ops/PortfolioPerformanceReport'));
import { AdvanceRequestsQueue } from '@/components/ops/AdvanceRequestsQueue';
import { AdvanceRequestsReviewed } from '@/components/ops/AdvanceRequestsReviewed';
import { AdvanceRepaymentsPanel } from '@/components/ops/AdvanceRepaymentsPanel';
import { ActiveAdvancesPanel } from '@/components/ops/ActiveAdvancesPanel';
import { BusinessAdvanceQueue } from '@/components/ops/BusinessAdvanceQueue';
import { RentHistoryVerificationQueue } from '@/components/ops/RentHistoryVerificationQueue';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { TenantTransferPanel } from './TenantTransferPanel';
import { IdleTenantsPanel } from './IdleTenantsPanel';
import { AgentTenantConnector } from './AgentTenantConnector';
import { AgentOpsPipelineHub } from './AgentOpsPipelineHub';
import { AgentDirectory } from './AgentDirectory';
import { AgentPerformanceTiers } from './AgentPerformanceTiers';
import { AgentCollectionsCommandCenter } from './agent-ops-v2/AgentCollectionsCommandCenter';
import { AgentLifecyclePipeline } from './AgentLifecyclePipeline';
import { AgentTaskManager } from './AgentTaskManager';
import { AgentEscalationQueue } from './AgentEscalationQueue';
import { ServiceCentreVerificationQueue } from './ServiceCentreVerificationQueue';
import { ServiceCenterRequestsQueue } from './ServiceCenterRequestsQueue';
import { ServiceCentreOverview } from './service-centres/ServiceCentreOverview';
import { ServiceCentreDirectory } from './service-centres/ServiceCentreDirectory';
import { ServiceCentrePayouts } from './service-centres/ServiceCentrePayouts';
import { ServiceCentreOperatingModel } from './service-centres/ServiceCentreOperatingModel';
import { AgentProductsPanel } from './agent-ops/AgentProductsPanel';
import { ShoppingAdvanceEligibleCount } from './agent-ops/ShoppingAdvanceEligibleCount';
import { AGENT_PRODUCT_PAGES } from '@/pages/AgentProductCategoryPage';
import { SubAgentVerificationQueue } from './SubAgentVerificationQueue';
import { TenantToSubAgentPanel } from './TenantToSubAgentPanel';
import { AgentOpsFloatPayoutReview } from '@/components/agent/AgentOpsFloatPayoutReview';
import { AgentBalancesPanel } from './AgentBalancesPanel';
import { LendingAgentsPanel } from './LendingAgentsPanel';
import { UserProfileDialog } from '@/components/supporter/UserProfileDialog';
import { TrustCaptureTab } from './TrustCaptureTab';
import { AgentProductsServicesReport } from './agent-ops/AgentProductsServicesReport';
import { AgentGuarantorFloatPanel } from './agent-ops/AgentGuarantorFloatPanel';
import { AgentRentBehaviourPanel } from './agent-ops/AgentRentBehaviourPanel';
import { PartialCollectionsPanel } from './agent-ops/PartialCollectionsPanel';
import { AgentProductsOnlyReportSection } from './agent-ops/AgentProductsOnlyReportSection';
import { SubAgentCommissionWhitelistPanel } from './agent-ops/SubAgentCommissionWhitelistPanel';
import { AgentFeatureFlagsPanel } from './AgentFeatureFlagsPanel';
import { AgentBulkOpsConsole } from './AgentBulkOpsConsole';
import { AgentDailyOverviewReportButton } from './AgentDailyOverviewReportButton';
import { AgentRentCapacityPanel } from './AgentRentCapacityPanel';
import { AgentAdvanceRepaymentMonitor } from './agent-ops-v2/AgentAdvanceRepaymentMonitor';
import { AgentMonthlyKpis } from './agent-ops-v2/AgentMonthlyKpis';
import { AgentAdvancePotential } from './agent-ops-v2/AgentAdvancePotential';
import { AgentAdvanceLimits } from './agent-ops-v2/AgentAdvanceLimits';
import { AdvanceAnalyticsPanel } from './agent-ops-v2/AdvanceAnalyticsPanel';
import { AdvanceActivityCorrelation } from './agent-ops-v2/AdvanceActivityCorrelation';
import { AdvancesAnalyticsView } from '@/components/advances/AdvancesAnalyticsView';
import { AgentLeaderboardPanel } from './AgentLeaderboardPanel';
import { AgentListingCampaignPanel } from './AgentListingCampaignPanel';
import { DailyRentReport } from '@/components/reports/DailyRentReport';
import { TenantSelfRepaymentsPanel } from '@/components/reporting/TenantSelfRepaymentsPanel';
import { AgentDailyCollectionsView } from '@/components/executive/agent-ops/AgentDailyCollectionsView';
import { AgentOpsComprehensiveReport } from '@/components/executive/agent-ops/AgentOpsComprehensiveReport';
import { AgentOpsReportWindow } from '@/components/executive/agent-ops/AgentOpsReportWindow';
import { ReportsOverview } from '@/components/executive/agent-ops-v2/ReportsOverview';
import { usePendingAdvanceCount } from '@/hooks/usePendingAdvanceCount';
import { AgentOpsOverview, AtRiskAgentsPreview } from './agent-ops-v2/AgentOpsOverview';
import { WelileHomesAdminPanel } from '@/components/ops/WelileHomesAdminPanel';
import { CallingHub } from '@/components/ops/calling';
import { ApprovalHistoryLog } from './ApprovalHistoryLog';
import { TenantRentCollector } from './TenantRentCollector';
import { AgentAllocationReport } from './AgentAllocationReport';
import { AdvanceHealthCard } from './agent-ops-v2/AdvanceHealthCard';
import { AgentsSpacePanel } from './AgentsSpacePanel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Users, Banknote, DollarSign, Search, UserPlus, Trophy, BarChart3, 
  ClipboardList, AlertTriangle, Building2, Wallet, Bell, ArrowLeftRight,
  ChevronLeft, Briefcase, TrendingUp, TrendingDown, UsersRound, PiggyBank, HandCoins, ShieldCheck, FileBarChart,
  LayoutGrid, ChevronDown, ToggleRight, Layers, Gauge, Target, Activity, Clock3
  , Coins, Megaphone, Lock, Store, MapPinned, Workflow, Package,
  Bike, ShoppingBag, Signpost, Smartphone, PhoneCall, Loader2, Sparkles, X, ChevronRight
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

type ActiveView = null | 'general-activities' | 'agents-rent' | 'agents-bikes' | 'welile-merchandise' | 'shopping-advance' | 'business-advance' | 'agent-marketplace' | 'welile-homes' | 'agents-hope' | 'agents-space' | 'agent-ops-report' | 'comprehensive-report' | 'products-services-report' | 'sc-products' | 'pipeline' | 'directory' | 'rent-capacity' | 'connector' | 'performance' | 'lifecycle' | 'tasks' | 'escalations' | 'service-centres' | 'sc-overview' | 'sc-directory' | 'sc-payouts' | 'sc-requests' | 'sc-operating-model' | 'sub-agents' | 'promote-tenant' | 'float-payouts' | 'leaderboard' | 'earnings' | 'transfers' | 'locked-transfers' | 'advances-analytics' | 'advance-requests' | 'active-advances' | 'advance-potential' | 'advance-limits' | 'advance-repayments' | 'balances' | 'lending-agents' | 'trust-capture' | 'feature-flags' | 'bulk-ops' | 'listing-campaign' | 'daily-collections-report' | 'advance-activity-correlation' | 'agent-service-centres' | 'agent-products-services' | 'guarantor-float' | 'rent-behaviour' | 'subagent-commission-whitelist' | 'partial-collections' | 'calling-hub' | 'portfolio-performance' | 'collect-rent' | 'agent-allocations' | 'approval-history' | 'tenant-self-repayments' | 'reports-overview';

const NAV_ITEMS: { key: ActiveView; icon: any; label: string; color: string; priority?: boolean }[] = [
  { key: 'general-activities', icon: Activity, label: 'General Agents Activities', color: 'bg-primary' },
  { key: 'agents-rent', icon: Banknote, label: 'Agents Rent', color: 'bg-primary' },
  { key: 'agents-bikes', icon: Bike, label: 'Agents Bikes', color: 'bg-primary' },
  { key: 'welile-merchandise', icon: ShoppingBag, label: 'Welile Merchandise', color: 'bg-primary' },
  { key: 'shopping-advance', icon: ShoppingBag, label: 'Welile Shopping Advance', color: 'bg-primary' },
  { key: 'business-advance', icon: Briefcase, label: 'Welile Business Advance', color: 'bg-primary' },
  { key: 'agent-marketplace', icon: Store, label: 'Welile Marketplace', color: 'bg-primary' },
  { key: 'welile-homes', icon: Building2, label: 'Welile Homes', color: 'bg-primary' },
  { key: 'agents-hope', icon: Sparkles, label: 'Welile Agents Hope', color: 'bg-primary' },
  { key: 'agents-space', icon: Wallet, label: "Agents' Space", color: 'bg-primary', priority: true },
  { key: 'reports-overview', icon: FileBarChart, label: 'Overview', color: 'bg-emerald-600', priority: true },
  { key: 'agent-ops-report', icon: FileBarChart, label: 'Agent Operations Report', color: 'bg-emerald-700', priority: true },
  { key: 'portfolio-performance', icon: BarChart3, label: 'Portfolio Performance', color: 'bg-emerald-700', priority: true },
  { key: 'comprehensive-report', icon: FileBarChart, label: 'Comprehensive Report', color: 'bg-emerald-800', priority: true },
  { key: 'guarantor-float', icon: AlertTriangle, label: 'Guarantor Float Tracker', color: 'bg-rose-800', priority: true },
  { key: 'products-services-report', icon: FileBarChart, label: 'Products & Services Report', color: 'bg-purple-900', priority: true },
  { key: 'advances-analytics', icon: BarChart3, label: 'Advances Overview', color: 'bg-purple-800', priority: true },
  { key: 'advance-potential', icon: Target, label: 'Advance Potential', color: 'bg-purple-700', priority: true },
  { key: 'advance-activity-correlation', icon: BarChart3, label: 'Advance vs Activity', color: 'bg-purple-600', priority: true },
  { key: 'daily-collections-report', icon: FileBarChart, label: 'Daily Rent Collections', color: 'bg-emerald-700', priority: true },
  { key: 'partial-collections', icon: AlertTriangle, label: 'Partial Collections', color: 'bg-amber-800', priority: true },
  { key: 'advance-limits', icon: Coins, label: 'Advance Limits', color: 'bg-emerald-800', priority: true },
  { key: 'advance-repayments', icon: TrendingDown, label: 'Repayments', color: 'bg-emerald-700', priority: true },
  { key: 'bulk-ops', icon: Layers, label: 'Abilities', color: 'bg-rose-700', priority: true },
  { key: 'pipeline', icon: Briefcase, label: 'Pipeline', color: 'bg-primary', priority: true },
  { key: 'balances', icon: PiggyBank, label: 'Agent Balances', color: 'bg-emerald-600', priority: true },
  { key: 'lending-agents', icon: HandCoins, label: 'Welile Lending Agents', color: 'bg-violet-600', priority: true },
  { key: 'sc-overview', icon: Store, label: 'Service Centers', color: 'bg-orange-600', priority: true },
  { key: 'service-centres', icon: Building2, label: 'Verification Queue', color: 'bg-orange-500', priority: true },
  { key: 'sc-directory', icon: MapPinned, label: 'Centers Directory', color: 'bg-orange-400' },
  { key: 'sc-payouts', icon: Banknote, label: 'Center Payouts', color: 'bg-orange-700' },
  { key: 'sc-requests', icon: Store, label: 'Free Center Requests', color: 'bg-orange-800', priority: true },
  { key: 'sc-operating-model', icon: Workflow, label: 'Operating Model', color: 'bg-amber-700' },
  { key: 'sc-products', icon: Package, label: 'Products', color: 'bg-amber-600', priority: true },
  { key: 'sub-agents', icon: UsersRound, label: 'Sub-Agents', color: 'bg-amber-600', priority: true },
  { key: 'subagent-commission-whitelist', icon: ShieldCheck, label: 'Sub-Agent Commission Whitelist', color: 'bg-emerald-700', priority: true },
  { key: 'promote-tenant', icon: ArrowLeftRight, label: 'Tenant → Sub-Agent', color: 'bg-fuchsia-600', priority: true },
  { key: 'directory', icon: Search, label: 'Directory', color: 'bg-blue-500', priority: true },
  { key: 'rent-capacity', icon: Gauge, label: 'Rent Capacity', color: 'bg-cyan-500', priority: true },
  { key: 'rent-behaviour', icon: Clock3, label: 'Rent Behaviour', color: 'bg-teal-600', priority: true },
  { key: 'tasks', icon: ClipboardList, label: 'Tasks', color: 'bg-emerald-500', priority: true },
  { key: 'escalations', icon: AlertTriangle, label: 'Escalations', color: 'bg-red-500' },
  { key: 'connector', icon: UserPlus, label: 'Tenant Transfer', color: 'bg-violet-500' },
  { key: 'float-payouts', icon: Wallet, label: 'Landlord Float Payouts', color: 'bg-pink-500' },
  { key: 'performance', icon: TrendingUp, label: 'Performance', color: 'bg-teal-500' },
  { key: 'lifecycle', icon: BarChart3, label: 'Lifecycle', color: 'bg-indigo-500' },
  { key: 'leaderboard', icon: Trophy, label: 'Leaderboard', color: 'bg-amber-500' },
  { key: 'listing-campaign', icon: Megaphone, label: 'Weekly Listing Campaign', color: 'bg-purple-600' },
  { key: 'earnings', icon: Banknote, label: 'Earnings', color: 'bg-green-500' },
  { key: 'transfers', icon: ArrowLeftRight, label: 'Transfers', color: 'bg-cyan-600' },
  { key: 'locked-transfers', icon: Lock, label: 'Idle Tenants', color: 'bg-rose-600', priority: true },
  { key: 'advance-requests', icon: Banknote, label: 'Advances', color: 'bg-purple-600', priority: true },
  { key: 'collect-rent', icon: HandCoins, label: 'Collect Rent', color: 'bg-orange-600', priority: true },
  { key: 'agent-allocations', icon: Workflow, label: 'Agent Allocations', color: 'bg-cyan-700', priority: true },
  { key: 'approval-history', icon: ClipboardList, label: 'Approval History', color: 'bg-slate-600' },
  { key: 'active-advances', icon: Activity, label: 'Active Advances', color: 'bg-purple-500', priority: true },
  { key: 'agent-service-centres', icon: Store, label: 'Agent Service Centres', color: 'bg-orange-600' },
  { key: 'agent-products-services', icon: Package, label: 'Agent Products & Services', color: 'bg-amber-600', priority: true },
  { key: 'calling-hub', icon: PhoneCall, label: 'Calling Hub', color: 'bg-sky-600', priority: true },
  { key: 'tenant-self-repayments', icon: HandCoins, label: 'Tenant Self-Repayments', color: 'bg-emerald-600', priority: true },
  { key: 'trust-capture', icon: ShieldCheck, label: 'Trust Capture', color: 'bg-emerald-600', priority: true },
  { key: 'feature-flags', icon: ToggleRight, label: 'Feature Flags', color: 'bg-indigo-600', priority: true },
];

interface BusinessAreaItem {
  num: string;
  title: string;
  icon: typeof Activity;
  section: ActiveView;
  highlight?: boolean;
  category: 'advances' | 'rent-bikes' | 'commerce' | 'field' | 'reports';
  desc: string;
  keywords: string[];
  to?: string;
}

const BUSINESS_AREAS: BusinessAreaItem[] = [
  {
    num: '01',
    title: 'General Agents Activities',
    icon: Activity,
    section: 'general-activities',
    category: 'field',
    desc: 'Agent roster, active status & field operations',
    keywords: ['activity', 'field', 'overview', 'agents', 'status', 'monitoring', 'general'],
  },
  {
    num: '02',
    title: 'Agent Advances',
    icon: HandCoins,
    section: 'advance-requests',
    category: 'advances',
    desc: 'Emergency & operational advance requests & reviews',
    keywords: ['advance', 'loans', 'credit', 'cash advance', 'requests', 'limits', 'repayments'],
  },
  {
    num: '03',
    title: 'Agents Rent',
    icon: Banknote,
    section: 'agents-rent',
    category: 'rent-bikes',
    desc: 'Agent rent plans, landlords & collections',
    keywords: ['rent', 'landlords', 'tenants', 'rent plans', 'lease', 'collections', 'properties'],
  },
  {
    num: '04',
    title: 'Agents Bikes',
    icon: Bike,
    section: 'agents-bikes',
    category: 'rent-bikes',
    desc: 'Spiro bike lease orders, reviews & verification',
    keywords: ['bikes', 'spiro', 'motorcycle', 'boda', 'lease', 'riders', 'dossier', 'delivery'],
    to: '/agent-ops/products/motor-bikes',
  },
  {
    num: '05',
    title: 'Welile Merchandise',
    icon: ShoppingBag,
    section: 'welile-merchandise',
    category: 'commerce',
    desc: 'Boutique merchandise, branded apparel & orders',
    keywords: ['merchandise', 'boutique', 'shop', 'goods', 'store', 'apparel', 'uniforms'],
  },
  {
    num: '06',
    title: 'Service Centre as a Service',
    icon: Building2,
    section: 'sc-overview',
    category: 'field',
    desc: 'Service center branches, kiosks & physical hubs',
    keywords: ['service centre', 'sc', 'branches', 'kiosks', 'hubs', 'centers', 'physical'],
  },
  {
    num: '07',
    title: 'Welile Lending Agents',
    icon: UsersRound,
    section: 'lending-agents',
    category: 'advances',
    desc: 'Lending agents management, capital & vetting',
    keywords: ['lending', 'agents', 'capital', 'allocations', 'credit', 'vetted'],
  },
  {
    num: '08',
    title: 'Welile Shopping Advance',
    icon: ShoppingBag,
    section: 'shopping-advance',
    category: 'advances',
    desc: 'Qualified agent shopping float advances',
    keywords: ['shopping advance', 'advance', 'supermarket', 'retail', 'groceries', 'limits'],
  },
  {
    num: '09',
    title: 'Welile Business Advance',
    icon: Briefcase,
    section: 'business-advance',
    category: 'advances',
    desc: 'Merchant and enterprise commercial advances',
    keywords: ['business advance', 'sme', 'commercial', 'enterprise', 'traders', 'merchants'],
  },
  {
    num: '10',
    title: 'Welile Marketplace',
    icon: Store,
    section: 'agent-marketplace',
    category: 'commerce',
    desc: 'Vendor portal and products marketplace',
    keywords: ['marketplace', 'vendors', 'sellers', 'ecommerce', 'products', 'listings'],
  },
  {
    num: '11',
    title: 'Welile Wallet Business',
    icon: Wallet,
    section: 'balances',
    category: 'commerce',
    desc: 'Agent float balances, deposits and ledger',
    keywords: ['wallet', 'balances', 'float', 'ledger', 'cash', 'deposits', 'withdrawals'],
  },
  {
    num: '12',
    title: 'Welile Homes',
    icon: Building2,
    section: 'welile-homes',
    category: 'field',
    desc: 'Housing pipeline, property acquisition & estates',
    keywords: ['homes', 'real estate', 'housing', 'properties', 'land', 'plots'],
  },
  {
    num: '13',
    title: 'Welile Agents Hope',
    icon: Sparkles,
    section: 'agents-hope',
    category: 'field',
    desc: 'Community resilience and agent welfare programs',
    keywords: ['hope', 'welfare', 'support', 'grants', 'charity', 'relief', 'benevolence'],
  },
  {
    num: '14',
    title: 'Welile Agents Ranks',
    icon: Trophy,
    section: 'leaderboard',
    category: 'reports',
    desc: 'Performance leaderboard & agent tier rankings',
    keywords: ['ranks', 'leaderboard', 'top agents', 'tiers', 'performance', 'rewards', 'rankings'],
  },
];

const CATEGORIES: { id: 'all' | 'advances' | 'rent-bikes' | 'commerce' | 'field' | 'reports'; label: string; count: number }[] = [
  { id: 'all', label: 'All', count: 14 },
  { id: 'advances', label: 'Advances', count: 4 },
  { id: 'rent-bikes', label: 'Rent & Bikes', count: 2 },
  { id: 'commerce', label: 'Commerce & Float', count: 3 },
  { id: 'field', label: 'Field & Hubs', count: 4 },
  { id: 'reports', label: 'Ranks & Reports', count: 1 },
];

export function AgentOpsDashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Overview dashboard is the default landing view when Agent Ops opens.
  const [activeView, setActiveView] = useState<ActiveView>(() => {
    const s = searchParams.get('section');
    if (!s) return null;
    const requested = s === 'products' ? 'sc-products' : s;
    return NAV_ITEMS.some((item) => item.key === requested) ? (requested as ActiveView) : null;
  });
  const [selectedAgent, setSelectedAgent] = useState<any>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('home');
  const [productSection, setProductSection] = useState<null | 'motor_bike' | 'smart_phone' | 'boutique' | 'signage' | 'advances'>(null);
  const [dateRange, setDateRange] = useState<DateRange>('24h');
  const [sidebarWidth, setSidebarWidth] = useState(224); // default w-56
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | 'advances' | 'rent-bikes' | 'commerce' | 'field' | 'reports'>('all');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingAdvanceCount = usePendingAdvanceCount();
  const navigate = useNavigate();

  // Keyboard shortcut '/' or Cmd+K to focus search bar (only on overview landing, never in inputs/editors/dialogs)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if an active sub-view is open (search bar is not displayed)
      if (activeView !== null) return;

      const isSearchShortcut =
        e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k');
      if (!isSearchShortcut) return;

      // Don't intercept if typing in an input, textarea, select, contenteditable, combobox, or modal dialog
      const target = (e.target || document.activeElement) as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable ||
        target?.closest('[contenteditable="true"]') ||
        target?.closest('[role="dialog"]') ||
        target?.closest('[role="combobox"]') ||
        document.querySelector('[role="dialog"]')
      ) {
        return;
      }

      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeView]);

  // Deep-linkable sections: /executive-hub?tab=agent-ops&section=products
  useEffect(() => {
    const s = searchParams.get('section');
    if (!s) {
      setActiveView(null);
      return;
    }
    const requested = s === 'products' ? 'sc-products' : s;
    setActiveView(NAV_ITEMS.some((item) => item.key === requested) ? requested as ActiveView : null);
  }, [searchParams]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (activeView !== 'agent-products-services') setProductSection(null);
    const slug = activeView === 'sc-products' ? 'products' : activeView;
    if (slug) next.set('section', slug);
    else next.delete('section');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);

  const { data: kpis, isLoading: kpisLoading } = useQuery({
    queryKey: ['agent-ops-kpis'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_ops_kpis');
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        agents: Number(row?.agents ?? 0),
        earnings_total: Number(row?.earnings_total ?? 0),
        commissions_total: Number(row?.commissions_total ?? 0),
      };
    },
    staleTime: 60_000,
    refetchOnMount: 'always',
  });

  const { data: earnings, isLoading } = useQuery({
    queryKey: ['exec-agent-earnings'],
    queryFn: async () => {
      const { data } = await supabase.from('agent_earnings').select('agent_id, amount, earning_type, created_at')
        .order('created_at', { ascending: false }).limit(200);
      return data || [];
    },
    staleTime: 600000,
  });

  const { data: commissions } = useQuery({
    queryKey: ['exec-agent-commissions'],
    queryFn: async () => {
      const { data } = await supabase.from('agent_commission_payouts').select('agent_id, amount, status, created_at')
        .order('created_at', { ascending: false }).limit(100);
      return data || [];
    },
    staleTime: 600000,
  });

  const agentIds = [...new Set([...(earnings || []).map(e => e.agent_id), ...(commissions || []).map(c => c.agent_id)])];
  const { data: agentProfiles } = useQuery({
    queryKey: ['exec-agent-profiles-full', agentIds.sort().join(',')],
    queryFn: async () => {
      if (agentIds.length === 0) return {};
      const BATCH = 50;
      const allProfiles: any[] = [];
      for (let i = 0; i < agentIds.length; i += BATCH) {
        const { data } = await supabase.from('profiles')
          .select('id, full_name, phone, email, avatar_url, verified, created_at, territory')
          .in('id', agentIds.slice(i, i + BATCH));
        if (data) allProfiles.push(...data);
      }
      const map: Record<string, any> = {};
      allProfiles.forEach(p => { map[p.id] = p; });
      return map;
    },
    enabled: agentIds.length > 0,
    staleTime: 600000,
  });

  const getName = (id: string) => agentProfiles?.[id]?.full_name || id.substring(0, 8) + '...';

  const openAgentProfile = (agentId: string) => {
    const profile = agentProfiles?.[agentId];
    setSelectedAgent({
      id: agentId,
      name: profile?.full_name || 'Unknown Agent',
      avatarUrl: profile?.avatar_url,
      type: 'agent' as const,
      createdAt: profile?.created_at,
      phone: profile?.phone,
      verified: profile?.verified,
      city: profile?.territory,
    });
  };

  const totalEarnings = kpis?.earnings_total ?? 0;
  const totalCommissions = kpis?.commissions_total ?? 0;
  const uniqueAgents = kpis?.agents ?? 0;

  const earningsColumns: Column<any>[] = [
    { key: 'created_at', label: 'Date', render: (v) => v ? format(new Date(v as string), 'dd MMM yy') : '—' },
    { key: 'agent_id', label: 'Agent', render: (v) => (
      <button
        onClick={() => openAgentProfile(String(v))}
        className="text-primary hover:underline font-medium text-left"
      >
        {getName(String(v))}
      </button>
    )},
    { key: 'earning_type', label: 'Type', render: (v) => (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-muted">{String(v)}</span>
    )},
    { key: 'amount', label: 'Amount (UGX)', render: (v) => Number(v || 0).toLocaleString() },
  ];

  const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toLocaleString();

  const viewLabel = NAV_ITEMS.find(i => i.key === activeView)?.label || '';

  // Render sub-view content
  const renderSubView = () => {
    switch (activeView) {
      case 'reports-overview': return <ReportsOverview />;
      case 'agent-ops-report': return <AgentOpsReportWindow />;
      case 'comprehensive-report': return <AgentOpsComprehensiveReport />;
      case 'portfolio-performance':
        return (
          <Suspense fallback={<div className="flex min-h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>}>
            <PortfolioPerformanceReport onBack={() => setActiveView(null)} />
          </Suspense>
        );
      case 'guarantor-float': return <AgentGuarantorFloatPanel />;
      case 'products-services-report': return <AgentProductsServicesReport />;
      case 'trust-capture': return <TrustCaptureTab />;
      case 'daily-collections-report': return (
        <div className="space-y-4">
          <AgentDailyCollectionsView />
          <details className="rounded-xl border border-border bg-card p-3">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Detailed report &amp; exports
            </summary>
            <div className="mt-3">
              <DailyRentReport mode="agent" />
            </div>
          </details>
        </div>
      );
      case 'agents-space': return <AgentsSpacePanel mode="ops" onBack={() => setActiveView(null)} />;
      case 'general-activities': return <AgentOpsOverview onOpenSection={handleOpenSection} />;
      case 'agents-rent': return <AgentCollectionsCommandCenter />;
      case 'agents-bikes': return <Navigate to="/agent-ops/products/motor-bikes" replace />;
      case 'welile-merchandise': return (
        <div className="space-y-4">
          <AgentProductsPanel category="boutique" />
          <Button variant="outline" asChild><Link to="/agent-ops/products/boutique">Merchandise applications and orders</Link></Button>
        </div>
      );
      case 'shopping-advance': return (
        <div className="space-y-4">
          <ShoppingAdvanceEligibleCount />
          <p className="text-sm text-muted-foreground">Shopping Advance access limits are currently informational. There is no separate Agent Ops issuance or repayment register for them.</p>
          <Button variant="outline" onClick={() => selectView('advances-analytics')}>View agent advance analytics</Button>
        </div>
      );
      case 'business-advance': return <BusinessAdvanceQueue stage="agent_ops" />;
      case 'agent-marketplace': return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">A separate agent Marketplace management report is not available here yet.</p>
          <Button variant="outline" asChild><Link to="/marketplace">Open Welile Marketplace</Link></Button>
        </div>
      );
      case 'welile-homes': return <WelileHomesAdminPanel />;
      case 'agents-hope': return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">A dedicated Agents Hope management report is not available yet.</p>
          <Button variant="outline" onClick={() => selectView('agents-space')}>Open Agents' Space</Button>
        </div>
      );
      case 'feature-flags': return <AgentFeatureFlagsPanel onBack={() => setActiveView(null)} />;
      case 'bulk-ops': return <AgentBulkOpsConsole onBack={() => setActiveView(null)} />;
      case 'pipeline': return <AgentOpsPipelineHub />;
      case 'directory': return <AgentDirectory />;
      case 'rent-capacity': return <AgentRentCapacityPanel />;
      case 'rent-behaviour': return <AgentRentBehaviourPanel />;
      case 'partial-collections': return <PartialCollectionsPanel />;
      case 'calling-hub': return <CallingHub subjectType="agent" />;
      case 'tenant-self-repayments': return <TenantSelfRepaymentsPanel audience="agent-ops" />;
      case 'connector': return <AgentTenantConnector />;
      case 'performance': return <AgentCollectionsCommandCenter />;
      case 'lifecycle': return <AgentLifecyclePipeline />;
      case 'tasks': return <AgentTaskManager />;
      case 'escalations': return <AgentEscalationQueue />;
      case 'service-centres': return <ServiceCentreVerificationQueue />;
      case 'sc-overview': return <ServiceCentreOverview />;
      case 'sc-directory': return <ServiceCentreDirectory />;
      case 'sc-payouts': return <ServiceCentrePayouts />;
      case 'sc-requests': return <ServiceCenterRequestsQueue />;
      case 'sc-operating-model': return <ServiceCentreOperatingModel />;
      case 'sc-products': return <AgentProductsPanel />;
      case 'agent-service-centres': return <ServiceCentreOverview />;
      case 'agent-products-services': {
        return (
            <div className="space-y-4">
              <AgentProductsOnlyReportSection />
              <p className="text-sm text-muted-foreground">Choose a category to manage issuance, payments and receivables.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {AGENT_PRODUCT_PAGES.map((c) => (
                  <Link
                    key={c.slug}
                    to={c.to}
                    className="group text-left rounded-2xl border bg-card p-5 shadow-sm transition-all hover:shadow-lg hover:-translate-y-0.5 hover:border-primary/40"
                  >
                    <div className={`inline-flex h-12 w-12 items-center justify-center rounded-xl ${c.color} text-white shadow-md`}>
                      <c.icon className="h-6 w-6" />
                    </div>
                    <div className="mt-4 text-lg font-bold leading-tight">{c.label}</div>
                    <p className="mt-1 text-sm text-muted-foreground">{c.desc}</p>
                    <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-primary opacity-0 transition-opacity group-hover:opacity-100">Open full page →</div>
                  </Link>
                ))}
              </div>
            </div>
        );
      }
      case 'sub-agents': return <SubAgentVerificationQueue />;
      case 'subagent-commission-whitelist': return <SubAgentCommissionWhitelistPanel />;
      case 'promote-tenant': return <TenantToSubAgentPanel />;
      case 'float-payouts': return <AgentOpsFloatPayoutReview />;
      case 'balances': return <AgentBalancesPanel />;
      case 'collect-rent': return <TenantRentCollector />;
      case 'agent-allocations': return <AgentAllocationReport />;
      case 'approval-history': return <ApprovalHistoryLog />;
      case 'lending-agents': return <LendingAgentsPanel />;
      case 'advance-requests': return (
        <div className="space-y-6">
          <AdvanceAnalyticsPanel />
          <AdvanceRequestsQueue stage="agent_ops" />
          <AdvanceRequestsReviewed />
          <BusinessAdvanceQueue stage="agent_ops" />
          <RentHistoryVerificationQueue dept="agent_ops" />
        </div>
      );
      case 'advances-analytics': return (
        <div className="space-y-6">
          <AdvanceHealthCard />
          <AgentMonthlyKpis />
          <AgentAdvanceRepaymentMonitor />
          <AdvancesAnalyticsView context="agent_ops" />
        </div>
      );
      case 'active-advances': return <ActiveAdvancesPanel />;
      case 'advance-potential': return <AgentAdvancePotential />;
      case 'advance-limits': return <AgentAdvanceLimits />;
      case 'advance-repayments': return (
        <div className="space-y-6">
          <AdvanceRepaymentsPanel />
          <Card className="rounded-2xl border-border/50 p-3 sm:p-4">
            <h3 className="text-sm font-semibold mb-2">At-Risk Agents</h3>
            <AtRiskAgentsPreview />
          </Card>
        </div>
      );
      case 'advance-activity-correlation': return <AdvanceActivityCorrelation />;
      case 'transfers': return (
        <div className="rounded-2xl border border-border bg-card p-3">
          <TenantTransferPanel />
        </div>
      );
      case 'locked-transfers': return (
        <div className="rounded-2xl border border-border bg-card p-3">
          <IdleTenantsPanel />
        </div>
      );
      case 'leaderboard': return <AgentLeaderboardPanel />;
      case 'listing-campaign': return <AgentListingCampaignPanel />;
      case 'earnings': return (
        <ExecutiveDataTable data={earnings || []} columns={earningsColumns} loading={isLoading} title="Agent Earnings"
          filters={[{ key: 'earning_type', label: 'Type', options: [
            { value: 'commission', label: 'Commission' },
            { value: 'referral', label: 'Referral' },
            { value: 'bonus', label: 'Bonus' },
          ]}]}
        />
      );
      default: return null;
    }
  };

  // Map a bottom-nav tab → opening the matching sub-view
  const handleBottomNav = (tab: BottomTab) => {
    setBottomTab(tab);
    if (tab === 'home') { setActiveView(null); return; }
    if (tab === 'pipeline') { setActiveView('pipeline'); return; }
    if (tab === 'agents') { setActiveView('directory'); return; }
    if (tab === 'finance') { setActiveView('balances'); return; }
    setActiveView(null);
  };

  const selectView = (key: ActiveView) => {
    if (key === 'agents-bikes') {
      navigate('/agent-ops/products/motor-bikes');
      return;
    }
    setActiveView(key);
  };

  const handleOpenSection = (key: string) => {
    if (key === 'agents-bikes') {
      navigate('/agent-ops/products/motor-bikes');
      return;
    }
    const next = NAV_ITEMS.some((item) => item.key === key) ? key as ActiveView : null;
    setActiveView(next);
  };

  // Grouped sections for the "More" tab (mobile dropdown + grid)
  const MORE_GROUPS: { title: string; keys: ActiveView[] }[] = [
    { title: "Agents' Space", keys: ['agents-space'] },
    { title: 'Agents', keys: ['directory', 'performance', 'sub-agents', 'subagent-commission-whitelist', 'bulk-ops', 'trust-capture', 'feature-flags'] },
    { title: 'Field Operations', keys: ['pipeline', 'rent-capacity', 'rent-behaviour', 'daily-collections-report', 'calling-hub', 'tasks', 'escalations', 'connector'] },
    { title: 'Service Centers', keys: ['sc-overview', 'service-centres', 'sc-directory', 'sc-payouts', 'sc-requests', 'sc-operating-model', 'sc-products'] },
    { title: 'Agent Products & Services', keys: ['agent-products-services'] },
    { title: 'Financials', keys: ['balances', 'float-payouts', 'earnings', 'locked-transfers'] },
    { title: 'Advances', keys: ['advances-analytics', 'advance-requests', 'active-advances', 'advance-potential', 'advance-limits', 'advance-repayments', 'advance-activity-correlation'] },
    { title: 'Reports', keys: ['reports-overview', 'agent-ops-report', 'portfolio-performance', 'comprehensive-report', 'products-services-report'] },
  ];
  const groupedKeys = new Set(MORE_GROUPS.flatMap((group) => group.keys));
  const ALL_SECTIONS = [
    ...MORE_GROUPS,
    { title: 'Additional tools', keys: NAV_ITEMS.map((item) => item.key).filter((key) => !groupedKeys.has(key)) },
  ];

  const filteredBusinessAreas = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return BUSINESS_AREAS.filter((area) => {
      if (activeCategory !== 'all' && area.category !== activeCategory && !q) {
        return false;
      }
      if (!q) return true;
      const matchesNum = area.num.includes(q) || String(parseInt(area.num, 10)).includes(q);
      const matchesTitle = area.title.toLowerCase().includes(q);
      const matchesDesc = area.desc.toLowerCase().includes(q);
      const matchesKeywords = area.keywords.some((k) => k.toLowerCase().includes(q));
      const matchesKey = area.section?.toLowerCase().includes(q);
      return matchesNum || matchesTitle || matchesDesc || matchesKeywords || matchesKey;
    });
  }, [searchQuery, activeCategory]);

  const matchingNavItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const directBusinessSections = new Set(filteredBusinessAreas.map((b) => b.section));
    return NAV_ITEMS.filter((item) => {
      if (!item.key) return false;
      if (directBusinessSections.has(item.key)) return false;
      const label = item.label.toLowerCase();
      const key = String(item.key).toLowerCase();
      return label.includes(q) || key.includes(q);
    });
  }, [searchQuery, filteredBusinessAreas]);

  const totalResultsCount = filteredBusinessAreas.length + matchingNavItems.length;

  // Main content region — sub-view when one is active, else the business-area home / more-grid.
  const contentRegion = activeView ? (
    <div className="space-y-4">
      {activeView !== 'agents-space' && (
        <>
          <Button variant="ghost"
            onClick={() => setActiveView(null)}
            className="flex items-center gap-2 text-sm font-semibold text-primary lg:hidden"
          >
            <ChevronLeft className="h-4 w-4" />
            Back to Agent Ops Overview
          </Button>
          <h2 className="text-lg font-bold">{viewLabel}</h2>
        </>
      )}
      {renderSubView()}
    </div>
  ) : bottomTab !== 'more' ? (
    <div className="space-y-4">
      {/* Title & Stats */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-foreground">Agent Operations</h1>
          <p className="text-xs text-muted-foreground hidden sm:block">
            Instant search engine across all 14 business areas and operational tools.
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 text-xs font-medium">
          {searchQuery.trim() ? `${totalResultsCount} found` : '14 Business Areas'}
        </Badge>
      </div>

      {/* Search Engine Input & Category Filters */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search all 14 business areas, advances, bikes, rent, tools, reports..."
            className="h-11 pl-10 pr-10 text-sm bg-card border-border rounded-xl shadow-2xs focus-visible:ring-primary/40 mb-0"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                searchInputRef.current?.focus();
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-muted hover:bg-muted-foreground/20 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Quick Filter Categories */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar -mx-1 px-1">
          {CATEGORIES.map((cat) => {
            const isSelected = activeCategory === cat.id && !searchQuery;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  setActiveCategory(cat.id);
                  if (searchQuery) setSearchQuery('');
                }}
                className={cn(
                  'shrink-0 text-xs px-2.5 py-1 rounded-full font-medium transition-all select-none',
                  isSelected
                    ? 'bg-primary text-primary-foreground shadow-2xs'
                    : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground border border-border/50'
                )}
              >
                {cat.label}
                <span className={cn('ml-1 text-[10px] opacity-75', isSelected ? 'text-primary-foreground' : 'text-muted-foreground')}>
                  {cat.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Empty State */}
      {filteredBusinessAreas.length === 0 && matchingNavItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-8 rounded-2xl border border-dashed border-border bg-card/60 text-center space-y-3">
          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
            <Search className="h-6 w-6" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">No Agent Ops items found</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              We couldn&apos;t find any business areas or tools matching &ldquo;{searchQuery}&rdquo;. Try searching for &ldquo;advance&rdquo;, &ldquo;bikes&rdquo;, &ldquo;rent&rdquo;, &ldquo;calling&rdquo;, or &ldquo;merchandise&rdquo;.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSearchQuery('');
              setActiveCategory('all');
              searchInputRef.current?.focus();
            }}
            className="text-xs gap-1.5"
          >
            <X className="h-3.5 w-3.5" /> Clear search
          </Button>
        </div>
      ) : (
        <>
          {/* Business Areas Grid */}
          {filteredBusinessAreas.length > 0 && (
            <div className="space-y-2">
              {searchQuery.trim() && (
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-0.5">
                  Core Business Areas ({filteredBusinessAreas.length})
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                {filteredBusinessAreas.map(({ num, title, icon: Icon, section, highlight, desc, to }) => (
                  <Button
                    key={title}
                    type="button"
                    variant="outline"
                    onClick={() => (to ? navigate(to) : selectView(section))}
                    aria-label={title}
                    className={cn(
                      'group relative h-auto min-h-24 w-full whitespace-normal justify-start gap-3.5 rounded-xl p-3.5 text-left transition-all',
                      highlight
                        ? [
                            '!bg-primary !text-primary-foreground !border-primary-foreground/25',
                            'hover:!bg-primary/90 hover:!border-primary-foreground/45 active:!bg-primary/80',
                            'shadow-glow hover:shadow-lg hover:-translate-y-0.5',
                          ]
                        : 'border-border bg-card shadow-2xs hover:border-primary/50 hover:bg-muted/50 hover:-translate-y-0.5'
                    )}
                  >
                    {highlight && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute -inset-1 rounded-xl border-2 border-primary-foreground/55 animate-attention-halo"
                      />
                    )}
                    <span className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      highlight ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-primary/10 text-primary'
                    )}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-xs font-semibold tracking-wide', highlight ? 'text-primary-foreground/75' : 'text-muted-foreground')}>
                        {num}
                      </span>
                      <span className={cn('block text-sm font-bold leading-snug', highlight ? 'text-primary-foreground' : 'text-foreground')}>
                        {title}
                      </span>
                      {desc && (
                        <span className={cn('block text-xs line-clamp-1 mt-0.5', highlight ? 'text-primary-foreground/85' : 'text-muted-foreground')}>
                          {desc}
                        </span>
                      )}
                    </span>
                    <ChevronDown className={cn('h-4 w-4 shrink-0 -rotate-90 transition-transform group-hover:translate-x-1', highlight ? 'text-primary-foreground/70' : 'text-muted-foreground')} />
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Related Tools & Detailed Sub-sections */}
          {matchingNavItems.length > 0 && (
            <div className="space-y-2.5 pt-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-0.5">
                Related Agent Ops Tools &amp; Reports ({matchingNavItems.length})
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-2.5">
                {matchingNavItems.map((item) => {
                  const Icon = item.icon;
                  const showBadge = item.key === 'advance-requests' && pendingAdvanceCount > 0;
                  return (
                    <button
                      key={item.key as string}
                      type="button"
                      onClick={() => selectView(item.key)}
                      className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-primary/40 active:scale-[0.99] transition-all text-left shadow-2xs group"
                    >
                      <span className={cn('h-8 w-8 rounded-lg flex items-center justify-center shrink-0', item.color)}>
                        <Icon className="h-4 w-4 text-white" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="block text-xs sm:text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                          {item.label}
                        </span>
                        <span className="block text-[10px] text-muted-foreground truncate">
                          Direct view &bull; Agent Ops
                        </span>
                      </div>
                      {showBadge && (
                        <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                          {pendingAdvanceCount > 99 ? '99+' : pendingAdvanceCount}
                        </span>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  ) : (
    <div className="space-y-5 pb-20 sm:pb-4">
      {ALL_SECTIONS.map((group) => (
        <section key={group.title} className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">
            {group.title}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
            {group.keys.map((key) => {
              const item = NAV_ITEMS.find((n) => n.key === key);
              if (!item) return null;
              const showBadge = item.key === 'advance-requests' && pendingAdvanceCount > 0;
              return (
                <button
                  key={item.key}
                  onClick={() => selectView(item.key)}
                  className={cn(
                    'flex flex-col items-center gap-2 p-3 rounded-2xl border border-border bg-card',
                    'active:scale-95 transition-all touch-manipulation min-h-[84px]',
                    'hover:shadow-md hover:border-primary/30',
                    'relative',
                  )}
                >
                  {showBadge && (
                    <span className="absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center">
                      {pendingAdvanceCount > 99 ? '99+' : pendingAdvanceCount}
                    </span>
                  )}
                  <div className={cn('p-2.5 rounded-xl shadow-sm', item.color)}>
                    <item.icon className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-[11px] sm:text-xs font-semibold text-center leading-tight">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );

  // HOME VIEW / shell
  return (
    <div className="space-y-4 pb-[calc(env(safe-area-inset-bottom)+72px)] sm:pb-4">
      {/* Greeting header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-foreground">Good day 👋</h2>
          <p className="text-xs text-muted-foreground">Agent Operations Manager</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <AgentDailyOverviewReportButton />
          {/* Section switcher — mobile / tablet only (desktop uses the left sidebar) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline"
                type="button"
                className="lg:hidden h-9 px-3 gap-1.5 text-xs"
                aria-label="All Agent Ops sections"
              >
                <LayoutGrid className="h-4 w-4 text-primary" />
                <span className="hidden xs:inline">All sections</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 max-h-[70vh] overflow-y-auto">
              {ALL_SECTIONS.map((group, gi) => (
                <div key={group.title}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {group.title}
                  </DropdownMenuLabel>
                  {group.keys.map((key) => {
                    const item = NAV_ITEMS.find((n) => n.key === key);
                    if (!item) return null;
                    const Icon = item.icon;
                    const showBadge = item.key === 'advance-requests' && pendingAdvanceCount > 0;
                    return (
                      <DropdownMenuItem
                        key={item.key as string}
                        onClick={() => selectView(item.key)}
                        className="gap-2.5 cursor-pointer"
                      >
                        <span className={cn('p-1.5 rounded-md shrink-0', item.color)}>
                          <Icon className="h-3.5 w-3.5 text-white" />
                        </span>
                        <span className="text-sm font-medium">{item.label}</span>
                        {showBadge && (
                          <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center">
                            {pendingAdvanceCount > 99 ? '99+' : pendingAdvanceCount}
                          </span>
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Body: persistent left sidebar (desktop) + content */}
      <div className="lg:flex lg:items-start">
        <div className="hidden lg:block shrink-0">
          <Button variant="ghost" size="icon-sm" title={sidebarOpen ? 'Collapse sections' : 'Open all sections'} aria-label={sidebarOpen ? 'Collapse sections' : 'Open all sections'} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}>
            <LayoutGrid className="h-4 w-4" />
          </Button>
          {sidebarOpen && <AgentOpsSideNav
            activeView={activeView}
            onSelect={(k) => selectView(k)}
            onHome={() => { setBottomTab('home'); setActiveView(null); }}
            style={{ width: sidebarWidth }}
          />}
        </div>
        {sidebarOpen && <SidebarResizer currentWidth={sidebarWidth} onChange={setSidebarWidth} />}
        <div className="flex-1 min-w-0">{contentRegion}</div>
      </div>

      {/* Mobile bottom nav */}
      <AgentOpsBottomNav active={bottomTab} onChange={handleBottomNav} />

      <UserProfileDialog open={!!selectedAgent} onOpenChange={(open) => !open && setSelectedAgent(null)} user={selectedAgent} />
    </div>
  );
}

/* ===================================================================
 * SidebarResizer — drag handle between the sidebar and main content.
 * Highlights on hover and lets the user widen/narrow the nav.
 * =================================================================== */
function SidebarResizer({
  currentWidth,
  onChange,
  min = 180,
  max = 480,
}: {
  currentWidth: number;
  onChange: (width: number) => void;
  min?: number;
  max?: number;
}) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: PointerEvent) => {
      if (!startRef.current) return;
      const delta = e.clientX - startRef.current.x;
      const width = Math.max(min, Math.min(max, startRef.current.width + delta));
      onChange(width);
    };
    const handleUp = () => {
      setDragging(false);
      startRef.current = null;
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragging, min, max, onChange]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={currentWidth}
      onPointerDown={(e) => {
        e.preventDefault();
        startRef.current = { x: e.clientX, width: currentWidth };
        setDragging(true);
      }}
      className={cn(
        'hidden lg:flex w-1.5 shrink-0 cursor-col-resize self-stretch items-center justify-center transition-colors',
        dragging ? 'bg-primary/40' : 'hover:bg-primary/20'
      )}
    >
      <div
        className={cn(
          'h-10 w-px rounded-full transition-colors',
          dragging ? 'bg-primary' : 'bg-border group-hover:bg-primary/60'
        )}
      />
    </div>
  );
}

/* ===================================================================
 * AgentOpsSideNav — persistent desktop left navigation for the Agent
 * Ops Dashboard. Mirrors the mobile "All sections" menu but always
 * visible on lg+. Advances is pinned to the top (Priority group).
 * =================================================================== */
function AgentOpsSideNav({
  activeView,
  onSelect,
  onHome,
  style,
}: {
  activeView: ActiveView;
  onSelect: (k: ActiveView) => void;
  onHome: () => void;
  style?: React.CSSProperties;
}) {
  const pendingAdvanceCount = usePendingAdvanceCount();
  // Priority stays pinned & always exposed on top. Every other group is
  // collapsible so the nav never over-scrolls. Agent Network sits right
  // below Priority and is open by default (this dashboard is agent-centric).
  const SIDE_GROUPS: { title: string; keys: ActiveView[]; pinned?: boolean; defaultOpen?: boolean }[] = [
    { title: "Agents' Space", defaultOpen: true, keys: ['agents-space'] },
    { title: 'Agents', defaultOpen: false, keys: ['directory', 'performance', 'sub-agents', 'subagent-commission-whitelist', 'bulk-ops', 'trust-capture', 'feature-flags'] },
    { title: 'Field Operations', defaultOpen: false, keys: ['pipeline', 'rent-capacity', 'rent-behaviour', 'daily-collections-report', 'partial-collections', 'tasks', 'escalations', 'connector', 'guarantor-float'] },
    { title: 'Service Centers', keys: ['sc-overview', 'service-centres', 'sc-directory', 'sc-payouts', 'sc-requests', 'sc-operating-model', 'sc-products'] },
    { title: 'Agent Products & Services', keys: ['agent-products-services'] },
    { title: 'Financials', keys: ['balances', 'float-payouts', 'earnings', 'locked-transfers'] },
    { title: 'Advances', keys: ['advances-analytics', 'advance-requests', 'active-advances', 'advance-potential', 'advance-limits', 'advance-repayments', 'advance-activity-correlation'] },
    { title: 'Reports', defaultOpen: true, keys: ['reports-overview', 'agent-ops-report', 'portfolio-performance', 'comprehensive-report', 'products-services-report'] },
  ];
  const sideKeys = new Set(SIDE_GROUPS.flatMap((group) => group.keys));
  SIDE_GROUPS.push({ title: 'Additional tools', keys: NAV_ITEMS.map((item) => item.key).filter((key) => !sideKeys.has(key)) });

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    SIDE_GROUPS.forEach((g) => { init[g.title] = false; });
    return init;
  });
  const toggleGroup = (title: string) =>
    setOpenGroups((prev) => ({ ...prev, [title]: !prev[title] }));

  const renderItem = (key: ActiveView) => {
    const item = NAV_ITEMS.find((n) => n.key === key);
    if (!item) return null;
    const Icon = item.icon;
    const active = activeView === key;
    const showBadge = item.key === 'advance-requests' && pendingAdvanceCount > 0;
    return (
      <button
        key={key as string}
        type="button"
        onClick={() => onSelect(key)}
        className={cn(
          'w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
          active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
        )}
      >
        <span className={cn('h-6 w-6 rounded-md flex items-center justify-center shrink-0', item.color)}>
          <Icon className="h-3.5 w-3.5 text-white" />
        </span>
        <span className="truncate">{item.label}</span>
        {showBadge && (
          <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center">
            {pendingAdvanceCount > 99 ? '99+' : pendingAdvanceCount}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside
      style={style}
      className="hidden lg:flex flex-col shrink-0 sticky top-0 self-start max-h-[calc(100dvh-8.5rem)] overflow-y-auto pr-2"
    >
      <nav className="space-y-3 py-1">
        <Button variant="ghost"
          type="button"
          onClick={onHome}
          className={cn(
            'w-full justify-start gap-2.5 px-2.5 py-2 text-sm font-semibold',
            !activeView ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
          )}
        >
          <span className="h-6 w-6 rounded-md flex items-center justify-center shrink-0 bg-primary">
            <LayoutGrid className="h-3.5 w-3.5 text-white" />
          </span>
          <span className="truncate">Overview</span>
        </Button>

        {SIDE_GROUPS.map((group) => {
          const containsActive = group.keys.includes(activeView as ActiveView);
          const open = group.pinned || openGroups[group.title] || containsActive;
          if (group.pinned) {
            return (
              <div key={group.title} className="space-y-1">
                <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-primary/80">
                  {group.title}
                </p>
                {group.keys.map(renderItem)}
              </div>
            );
          }
          return (
            <div key={group.title} className="space-y-1">
              <button
                type="button"
                onClick={() => toggleGroup(group.title)}
                className="w-full flex items-center justify-between px-2 py-1 rounded-md hover:bg-muted/60 transition-colors"
                aria-expanded={open}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.title}
                </span>
                <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open ? '' : '-rotate-90')} />
              </button>
              {open && <div className="space-y-1">{group.keys.map(renderItem)}</div>}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
