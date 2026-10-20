import {
  Activity,
  Banknote,
  Bike,
  ShoppingBag,
  Building2,
  UsersRound,
  Briefcase,
  Store,
  Wallet,
  Sparkles,
  Trophy,
  Search,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Layers,
  Gauge,
  Clock3,
  ClipboardList,
  AlertTriangle,
  UserPlus,
  Package,
  MapPinned,
  Workflow,
  Coins,
  FileBarChart,
  BarChart3,
  Sprout,
  HandCoins,
  PhoneCall,
  ToggleRight,
  ArrowLeftRight,
  Lock,
  Megaphone,
  Smartphone,
  Signpost,
  Network,
  PiggyBank,
  Target,
} from 'lucide-react';

export type ActiveView =
  | null
  | 'general-activities'
  | 'agents-rent'
  | 'agents-bikes'
  | 'welile-merchandise'
  | 'shopping-advance'
  | 'business-advance'
  | 'agent-marketplace'
  | 'welile-homes'
  | 'agents-hope'
  | 'agents-space'
  | 'agent-ops-report'
  | 'comprehensive-report'
  | 'products-services-report'
  | 'sc-products'
  | 'pipeline'
  | 'directory'
  | 'rent-capacity'
  | 'connector'
  | 'performance'
  | 'lifecycle'
  | 'tasks'
  | 'escalations'
  | 'service-centres'
  | 'sc-overview'
  | 'sc-directory'
  | 'sc-payouts'
  | 'sc-requests'
  | 'sc-operating-model'
  | 'sub-agents'
  | 'promote-tenant'
  | 'float-payouts'
  | 'leaderboard'
  | 'earnings'
  | 'transfers'
  | 'locked-transfers'
  | 'advances-analytics'
  | 'advance-requests'
  | 'active-advances'
  | 'advance-potential'
  | 'advance-limits'
  | 'advance-repayments'
  | 'balances'
  | 'lending-agents'
  | 'trust-capture'
  | 'feature-flags'
  | 'bulk-ops'
  | 'listing-campaign'
  | 'daily-collections-report'
  | 'first7-tracker'
  | 'advance-activity-correlation'
  | 'agent-service-centres'
  | 'agent-products-services'
  | 'guarantor-float'
  | 'rent-behaviour'
  | 'subagent-commission-whitelist'
  | 'partial-collections'
  | 'calling-hub'
  | 'portfolio-performance'
  | 'collect-rent'
  | 'agent-allocations'
  | 'approval-history'
  | 'tenant-self-repayments'
  | 'reports-overview';

export interface BusinessAreaItem {
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

export const BUSINESS_AREAS: BusinessAreaItem[] = [
  {
    num: '01',
    title: 'General Agents Activities',
    icon: Activity,
    section: 'general-activities',
    category: 'field',
    desc: 'Agent roster, active status & field operations',
    keywords: ['activity', 'field', 'overview', 'agents', 'status', 'monitoring', 'general', 'roster'],
  },
  {
    num: '02',
    title: 'Agent Advances',
    icon: HandCoins,
    section: 'advance-requests',
    category: 'advances',
    desc: 'Emergency & operational advance requests & reviews',
    keywords: ['advance', 'loans', 'credit', 'cash advance', 'requests', 'limits', 'repayments', 'vetting', 'approvals'],
  },
  {
    num: '03',
    title: 'Agents Rent',
    icon: Banknote,
    section: 'agents-rent',
    category: 'rent-bikes',
    desc: 'Agent rent plans, landlords & collections',
    keywords: ['rent', 'landlords', 'tenants', 'rent plans', 'lease', 'collections', 'properties', 'command center'],
  },
  {
    num: '04',
    title: 'Agents Bikes',
    icon: Bike,
    section: 'agents-bikes',
    category: 'rent-bikes',
    desc: 'Spiro bike lease orders, reviews & verification',
    keywords: ['bikes', 'spiro', 'motorcycle', 'boda', 'lease', 'riders', 'dossier', 'delivery', 'motor bikes', 'ev', 'asset financing'],
    to: '/agent-ops/products/motor-bikes',
  },
  {
    num: '05',
    title: 'Welile Merchandise',
    icon: ShoppingBag,
    section: 'welile-merchandise',
    category: 'commerce',
    desc: 'Boutique merchandise, branded apparel & orders',
    keywords: ['merchandise', 'boutique', 'shop', 'goods', 'store', 'apparel', 'uniforms', 'branding', 't-shirts', 'gear'],
  },
  {
    num: '06',
    title: 'Service Centre as a Service',
    icon: Building2,
    section: 'sc-overview',
    category: 'field',
    desc: 'Service center branches, kiosks & physical hubs',
    keywords: ['service centre', 'service center', 'sc', 'branches', 'kiosks', 'hubs', 'centers', 'physical'],
  },
  {
    num: '07',
    title: 'Welile Lending Agents',
    icon: UsersRound,
    section: 'lending-agents',
    category: 'advances',
    desc: 'Lending agents management, capital & vetting',
    keywords: ['lending', 'agents', 'capital', 'allocations', 'credit', 'vetted', 'peer lending', 'loan books'],
  },
  {
    num: '08',
    title: 'Welile Shopping Advance',
    icon: ShoppingBag,
    section: 'shopping-advance',
    category: 'advances',
    desc: 'Qualified agent shopping float advances',
    keywords: ['shopping advance', 'advance', 'supermarket', 'retail', 'groceries', 'limits', 'shopping float'],
  },
  {
    num: '09',
    title: 'Welile Business Advance',
    icon: Briefcase,
    section: 'business-advance',
    category: 'advances',
    desc: 'Merchant and enterprise commercial advances',
    keywords: ['business advance', 'sme', 'commercial', 'enterprise', 'traders', 'merchants', 'working capital'],
  },
  {
    num: '10',
    title: 'Welile Marketplace',
    icon: Store,
    section: 'agent-marketplace',
    category: 'commerce',
    desc: 'Vendor portal and products marketplace',
    keywords: ['marketplace', 'vendors', 'sellers', 'ecommerce', 'products', 'listings', 'store'],
  },
  {
    num: '11',
    title: 'Welile Wallet Business',
    icon: Wallet,
    section: 'balances',
    category: 'commerce',
    desc: 'Agent float balances, deposits and ledger',
    keywords: ['wallet', 'balances', 'float', 'ledger', 'cash', 'deposits', 'withdrawals', 'wallet business'],
  },
  {
    num: '12',
    title: 'Welile Homes',
    icon: Building2,
    section: 'welile-homes',
    category: 'field',
    desc: 'Housing pipeline, property acquisition & estates',
    keywords: ['homes', 'real estate', 'housing', 'properties', 'land', 'plots', 'estates', 'pipeline'],
  },
  {
    num: '13',
    title: 'Welile Agents Hope',
    icon: Sparkles,
    section: 'agents-hope',
    category: 'field',
    desc: 'Community resilience and agent welfare programs',
    keywords: ['hope', 'welfare', 'support', 'grants', 'charity', 'relief', 'benevolence', 'community'],
  },
  {
    num: '14',
    title: 'Welile Agents Ranks',
    icon: Trophy,
    section: 'leaderboard',
    category: 'reports',
    desc: 'Performance leaderboard & agent tier rankings',
    keywords: ['ranks', 'leaderboard', 'top agents', 'tiers', 'performance', 'rewards', 'rankings', 'top performers'],
  },
];

export type FeatureCategoryGroup =
  | 'Core Business Areas'
  | "Agents' Space"
  | 'Agents'
  | 'Field Operations'
  | 'Service Centers'
  | 'Agent Products & Services'
  | 'Financials'
  | 'Advances'
  | 'Reports'
  | 'Additional Tools';

export interface DashboardFeatureItem {
  id: string;
  title: string;
  section: ActiveView;
  to?: string;
  categoryGroup: FeatureCategoryGroup;
  icon: any;
  color: string;
  desc: string;
  keywords: string[];
  isCoreBusinessArea?: boolean;
  businessAreaNum?: string;
  badge?: string;
}

export const ALL_DASHBOARD_FEATURES: DashboardFeatureItem[] = [
  // Core Business Areas (The 14)
  {
    id: 'core-01-general-activities',
    title: 'General Agents Activities',
    section: 'general-activities',
    categoryGroup: 'Core Business Areas',
    icon: Activity,
    color: 'bg-primary',
    desc: 'Agent roster, active status & field monitoring overview',
    keywords: ['general', 'activities', 'overview', 'roster', 'active status', 'field operations', 'monitoring', 'status', 'summary', 'command center'],
    isCoreBusinessArea: true,
    businessAreaNum: '01',
  },
  {
    id: 'core-02-agent-advances',
    title: 'Agent Advances',
    section: 'advance-requests',
    categoryGroup: 'Core Business Areas',
    icon: HandCoins,
    color: 'bg-primary',
    desc: 'Emergency & operational advance requests & reviews',
    keywords: ['advance', 'loans', 'credit', 'cash advance', 'requests', 'limits', 'repayments', 'reviews', 'vetting', 'approvals'],
    isCoreBusinessArea: true,
    businessAreaNum: '02',
  },
  {
    id: 'core-03-agents-rent',
    title: 'Agents Rent',
    section: 'agents-rent',
    categoryGroup: 'Core Business Areas',
    icon: Banknote,
    color: 'bg-primary',
    desc: 'Agent rent plans, landlords & collections command center',
    keywords: ['rent', 'landlords', 'tenants', 'rent plans', 'lease', 'collections', 'properties', 'agents rent', 'daily targets'],
    isCoreBusinessArea: true,
    businessAreaNum: '03',
  },
  {
    id: 'core-04-agents-bikes',
    title: 'Agents Bikes',
    section: 'agents-bikes',
    to: '/agent-ops/products/motor-bikes',
    categoryGroup: 'Core Business Areas',
    icon: Bike,
    color: 'bg-primary',
    desc: 'Spiro bike lease orders, reviews & verification queue',
    keywords: ['bikes', 'spiro', 'motorcycle', 'boda', 'lease', 'riders', 'dossier', 'delivery', 'motor bikes', 'ev', 'asset financing', 'orders'],
    isCoreBusinessArea: true,
    businessAreaNum: '04',
  },
  {
    id: 'core-05-welile-merchandise',
    title: 'Welile Merchandise',
    section: 'welile-merchandise',
    to: '/agent-ops/products/boutique',
    categoryGroup: 'Core Business Areas',
    icon: ShoppingBag,
    color: 'bg-primary',
    desc: 'Boutique merchandise, branded apparel & orders',
    keywords: ['merchandise', 'boutique', 'shop', 'goods', 'store', 'apparel', 'uniforms', 'branding', 't-shirts', 'gear', 'orders', 'recoveries'],
    isCoreBusinessArea: true,
    businessAreaNum: '05',
  },
  {
    id: 'core-06-service-centre-as-service',
    title: 'Service Centre as a Service',
    section: 'sc-overview',
    categoryGroup: 'Core Business Areas',
    icon: Building2,
    color: 'bg-primary',
    desc: 'Service center branches, kiosks & physical hubs',
    keywords: ['service centre', 'service center', 'sc', 'branches', 'kiosks', 'hubs', 'centers', 'physical', 'footprint', 'locations'],
    isCoreBusinessArea: true,
    businessAreaNum: '06',
  },
  {
    id: 'core-07-lending-agents',
    title: 'Welile Lending Agents',
    section: 'lending-agents',
    categoryGroup: 'Core Business Areas',
    icon: UsersRound,
    color: 'bg-primary',
    desc: 'Lending agents management, capital & vetting',
    keywords: ['lending', 'agents', 'capital', 'allocations', 'credit', 'vetted', 'peer lending', 'loan books', 'lenders'],
    isCoreBusinessArea: true,
    businessAreaNum: '07',
  },
  {
    id: 'core-08-shopping-advance',
    title: 'Welile Shopping Advance',
    section: 'shopping-advance',
    categoryGroup: 'Core Business Areas',
    icon: ShoppingBag,
    color: 'bg-primary',
    desc: 'Qualified agent shopping float advances',
    keywords: ['shopping advance', 'advance', 'supermarket', 'retail', 'groceries', 'limits', 'shopping float', 'eligible agents'],
    isCoreBusinessArea: true,
    businessAreaNum: '08',
  },
  {
    id: 'core-09-business-advance',
    title: 'Welile Business Advance',
    section: 'business-advance',
    categoryGroup: 'Core Business Areas',
    icon: Briefcase,
    color: 'bg-primary',
    desc: 'Merchant and enterprise commercial advances',
    keywords: ['business advance', 'sme', 'commercial', 'enterprise', 'traders', 'merchants', 'working capital', 'business queue'],
    isCoreBusinessArea: true,
    businessAreaNum: '09',
  },
  {
    id: 'core-10-welile-marketplace',
    title: 'Welile Marketplace',
    section: 'agent-marketplace',
    categoryGroup: 'Core Business Areas',
    icon: Store,
    color: 'bg-primary',
    desc: 'Vendor portal and products marketplace',
    keywords: ['marketplace', 'vendors', 'sellers', 'ecommerce', 'products', 'listings', 'store', 'catalog', 'merchants'],
    isCoreBusinessArea: true,
    businessAreaNum: '10',
  },
  {
    id: 'core-11-wallet-business',
    title: 'Welile Wallet Business',
    section: 'balances',
    categoryGroup: 'Core Business Areas',
    icon: Wallet,
    color: 'bg-primary',
    desc: 'Agent float balances, deposits and ledger',
    keywords: ['wallet', 'balances', 'float', 'ledger', 'cash', 'deposits', 'withdrawals', 'wallet business', 'balance tracking'],
    isCoreBusinessArea: true,
    businessAreaNum: '11',
  },
  {
    id: 'core-12-welile-homes',
    title: 'Welile Homes',
    section: 'welile-homes',
    categoryGroup: 'Core Business Areas',
    icon: Building2,
    color: 'bg-primary',
    desc: 'Housing pipeline, property acquisition & estates',
    keywords: ['homes', 'real estate', 'housing', 'properties', 'land', 'plots', 'estates', 'property pipeline', 'welile homes'],
    isCoreBusinessArea: true,
    businessAreaNum: '12',
  },
  {
    id: 'core-13-agents-hope',
    title: 'Welile Agents Hope',
    section: 'agents-hope',
    categoryGroup: 'Core Business Areas',
    icon: Sparkles,
    color: 'bg-primary',
    desc: 'Community resilience and agent welfare programs',
    keywords: ['hope', 'welfare', 'support', 'grants', 'charity', 'relief', 'benevolence', 'community', 'agents hope', 'resilience'],
    isCoreBusinessArea: true,
    businessAreaNum: '13',
  },
  {
    id: 'core-14-agents-ranks',
    title: 'Welile Agents Ranks',
    section: 'leaderboard',
    categoryGroup: 'Core Business Areas',
    icon: Trophy,
    color: 'bg-primary',
    desc: 'Performance leaderboard & agent tier rankings',
    keywords: ['ranks', 'leaderboard', 'top agents', 'tiers', 'performance', 'rewards', 'rankings', 'top performers', 'champions'],
    isCoreBusinessArea: true,
    businessAreaNum: '14',
  },

  // Agents' Space
  {
    id: 'agents-space',
    title: "Agents' Space",
    section: 'agents-space',
    categoryGroup: "Agents' Space",
    icon: Wallet,
    color: 'bg-primary',
    desc: 'Agent operational console, wallet overview, float and rent tools',
    keywords: ['agents space', 'space', 'agent portal', 'wallet', 'float', 'my tools', 'agent console', 'ops console'],
  },

  // Agents Group
  {
    id: 'agents-directory',
    title: 'Agent Directory',
    section: 'directory',
    categoryGroup: 'Agents',
    icon: Search,
    color: 'bg-blue-500',
    desc: 'Full agent roster, KYC status, contact information & search',
    keywords: ['directory', 'roster', 'agents list', 'search agents', 'kyc', 'phone numbers', 'territory', 'agent search', 'contacts', 'profiles', 'verification'],
  },
  {
    id: 'agent-performance',
    title: 'Agent Performance',
    section: 'performance',
    categoryGroup: 'Agents',
    icon: TrendingUp,
    color: 'bg-teal-500',
    desc: 'Collections command center, recovery rates & performance tiers',
    keywords: ['performance', 'targets', 'collections', 'recovery', 'tiers', 'command center', 'agent performance', 'daily performance'],
  },
  {
    id: 'sub-agents',
    title: 'Sub-Agents Verification Queue',
    section: 'sub-agents',
    categoryGroup: 'Agents',
    icon: UsersRound,
    color: 'bg-amber-600',
    desc: 'Sub-agent onboarding applications, vetting & supervisor linking',
    keywords: ['sub-agents', 'sub agents', 'verification queue', 'onboarding', 'vetting', 'subagent approvals', 'subordinates', 'supervisors'],
  },
  {
    id: 'subagent-commission-whitelist',
    title: 'Sub-Agent Commission Whitelist',
    section: 'subagent-commission-whitelist',
    categoryGroup: 'Agents',
    icon: ShieldCheck,
    color: 'bg-emerald-700',
    desc: 'Eligible commission whitelist, authorizations & split rules',
    keywords: ['whitelist', 'commission whitelist', 'subagent commission', 'eligibility', 'authorization', 'rates', 'splits', 'commissions'],
  },
  {
    id: 'promote-tenant',
    title: 'Tenant → Sub-Agent Promotion',
    section: 'promote-tenant',
    categoryGroup: 'Agents',
    icon: ArrowLeftRight,
    color: 'bg-fuchsia-600',
    desc: 'Convert high-performing tenants in good standing into active sub-agents',
    keywords: ['promote tenant', 'tenant to agent', 'conversion', 'tenant subagent', 'upgrade tenant', 'promotion', 'agent recruit'],
  },
  {
    id: 'bulk-ops',
    title: 'Abilities & Bulk Operations',
    section: 'bulk-ops',
    categoryGroup: 'Agents',
    icon: Layers,
    color: 'bg-rose-700',
    desc: 'Mass agent capabilities console, batch updates & permissions',
    keywords: ['abilities', 'bulk ops', 'bulk operations', 'mass permissions', 'console', 'batch update', 'agent permissions', 'mass action'],
  },
  {
    id: 'trust-capture',
    title: 'Trust Capture',
    section: 'trust-capture',
    categoryGroup: 'Agents',
    icon: ShieldCheck,
    color: 'bg-emerald-600',
    desc: 'Agent trust scoring, identity credentials & fraud prevention metrics',
    keywords: ['trust capture', 'trust score', 'identity', 'verification', 'credibility', 'risk rating', 'agent trust', 'biometrics', 'credentials'],
  },
  {
    id: 'feature-flags',
    title: 'Agent Feature Flags',
    section: 'feature-flags',
    categoryGroup: 'Agents',
    icon: ToggleRight,
    color: 'bg-indigo-600',
    desc: 'Operational toggles, beta feature switches & rollout management',
    keywords: ['feature flags', 'flags', 'toggles', 'rollout', 'beta switches', 'settings', 'experiments', 'configurations'],
  },

  // Field Operations Group
  {
    id: 'pipeline',
    title: 'Agent Lifecycle Pipeline Hub',
    section: 'pipeline',
    categoryGroup: 'Field Operations',
    icon: Briefcase,
    color: 'bg-primary',
    desc: 'Multi-stage agent onboarding funnel, active pipeline & stage transitions',
    keywords: ['pipeline', 'funnel', 'lifecycle', 'stages', 'onboarding pipeline', 'agent funnel', 'agent pipeline', 'intake'],
  },
  {
    id: 'rent-capacity',
    title: 'Rent Capacity',
    section: 'rent-capacity',
    categoryGroup: 'Field Operations',
    icon: Gauge,
    color: 'bg-cyan-500',
    desc: 'Agent rent portfolio capacity limits, active quotas & headroom',
    keywords: ['rent capacity', 'capacity', 'quota', 'portfolio limit', 'allocation limit', 'capacity monitoring', 'headroom', 'ceilings'],
  },
  {
    id: 'rent-behaviour',
    title: 'Rent Behaviour',
    section: 'rent-behaviour',
    categoryGroup: 'Field Operations',
    icon: Clock3,
    color: 'bg-teal-600',
    desc: 'Repayment punctuality patterns, early vs late payers & delinquency signals',
    keywords: ['rent behaviour', 'behaviour', 'habits', 'repayment timing', 'discipline', 'delinquency', 'punctuality', 'late payers'],
  },
  {
    id: 'daily-collections-report',
    title: 'Daily Rent Collections',
    section: 'daily-collections-report',
    categoryGroup: 'Field Operations',
    icon: FileBarChart,
    color: 'bg-emerald-700',
    desc: 'Real-time daily collection breakdown by agent, receipt logs & CSV export',
    keywords: ['daily collections', 'collections report', 'daily rent', 'today collections', 'receipts', 'export csv', 'reconciliation', 'collections'],
  },
  {
    id: 'first7-tracker',
    title: 'First 7 Days Tracker',
    section: 'first7-tracker',
    categoryGroup: 'Field Operations',
    icon: Sprout,
    color: 'bg-emerald-700',
    desc: 'New tenant & agent day 1 to 7 activation milestones & velocity tracker',
    keywords: ['first 7 days', 'first7', 'onboarding milestones', 'new tenants', 'day 1-7', 'activation', 'tracker', 'early activation', 'f7'],
  },
  {
    id: 'partial-collections',
    title: 'Partial Collections',
    section: 'partial-collections',
    categoryGroup: 'Field Operations',
    icon: AlertTriangle,
    color: 'bg-amber-800',
    desc: 'Underpaid rent installment tracking, split payments & deficits',
    keywords: ['partial collections', 'partial payments', 'underpaid', 'split rent', 'installments', 'deficits', 'shortfalls'],
  },
  {
    id: 'agent-tasks',
    title: 'Agent Tasks',
    section: 'tasks',
    categoryGroup: 'Field Operations',
    icon: ClipboardList,
    color: 'bg-emerald-500',
    desc: 'Operational field task assignments, daily checklists & completions',
    keywords: ['tasks', 'task manager', 'assignments', 'to-do', 'follow-ups', 'field tasks', 'checklists', 'daily duties'],
  },
  {
    id: 'escalations',
    title: 'Agent Escalations',
    section: 'escalations',
    categoryGroup: 'Field Operations',
    icon: AlertTriangle,
    color: 'bg-red-500',
    desc: 'Priority dispute resolution, critical field issues & landlord complaints',
    keywords: ['escalations', 'disputes', 'tickets', 'urgent issues', 'complaints', 'fraud alerts', 'critical', 'dispute resolution'],
  },
  {
    id: 'connector-transfers',
    title: 'Tenant Transfer / Connector',
    section: 'connector',
    categoryGroup: 'Field Operations',
    icon: UserPlus,
    color: 'bg-violet-500',
    desc: 'Reassign tenants between agents & balance territory coverage',
    keywords: ['tenant transfer', 'connector', 'reassign tenant', 'transfer', 'handover', 'territory transfer', 'reassignment'],
  },
  {
    id: 'guarantor-float',
    title: 'Guarantor Float Tracker',
    section: 'guarantor-float',
    categoryGroup: 'Field Operations',
    icon: AlertTriangle,
    color: 'bg-rose-800',
    desc: 'Float backed by guarantors, liability tracking & surety exposure',
    keywords: ['guarantor float', 'guarantor', 'collateral', 'float backup', 'liability', 'surety', 'guarantors'],
  },
  {
    id: 'calling-hub',
    title: 'Calling Hub & Dialer',
    section: 'calling-hub',
    categoryGroup: 'Field Operations',
    icon: PhoneCall,
    color: 'bg-sky-600',
    desc: 'Integrated CRM phone dialer, agent dossier & call log histories',
    keywords: ['calling hub', 'phone call', 'crm dialer', 'outbound calling', 'call logs', 'dialer', 'telephony', 'dossier', 'callee'],
  },

  // Service Centers Group
  {
    id: 'sc-overview',
    title: 'Service Centers Overview',
    section: 'sc-overview',
    categoryGroup: 'Service Centers',
    icon: Store,
    color: 'bg-orange-600',
    desc: 'Physical kiosk network overview, hub distribution & branch status',
    keywords: ['service centres', 'service centers', 'kiosks', 'overview', 'hubs', 'physical network', 'branches', 'footprint'],
  },
  {
    id: 'service-centres-queue',
    title: 'Service Center Verification Queue',
    section: 'service-centres',
    categoryGroup: 'Service Centers',
    icon: Building2,
    color: 'bg-orange-500',
    desc: 'New service center application review, premises audit & approval',
    keywords: ['service center verification', 'sc verification', 'approval queue', 'inspection', 'premises audit', 'branch onboarding'],
  },
  {
    id: 'sc-directory',
    title: 'Centers Directory',
    section: 'sc-directory',
    categoryGroup: 'Service Centers',
    icon: MapPinned,
    color: 'bg-orange-400',
    desc: 'Registry of all active physical centers, branches, managers & addresses',
    keywords: ['centers directory', 'sc directory', 'branch list', 'locations list', 'kiosk locations', 'physical addresses'],
  },
  {
    id: 'sc-payouts',
    title: 'Center Payouts',
    section: 'sc-payouts',
    categoryGroup: 'Service Centers',
    icon: Banknote,
    color: 'bg-orange-700',
    desc: 'Disbursement of center fees, float distributions & reconciliation',
    keywords: ['sc payouts', 'center payouts', 'disbursements', 'fees', 'payout queue', 'reconciliation', 'branch payouts'],
  },
  {
    id: 'sc-requests',
    title: 'Free Center Requests',
    section: 'sc-requests',
    categoryGroup: 'Service Centers',
    icon: Store,
    color: 'bg-orange-800',
    desc: 'Community hub sponsorship applications & free kiosk equipment requests',
    keywords: ['free center requests', 'sc requests', 'grants', 'free kiosks', 'sponsorship', 'community hubs', 'intake requests'],
  },
  {
    id: 'sc-operating-model',
    title: 'Service Center Operating Model',
    section: 'sc-operating-model',
    categoryGroup: 'Service Centers',
    icon: Workflow,
    color: 'bg-amber-700',
    desc: 'Tier classifications, commission splits & standard operational procedures',
    keywords: ['operating model', 'sop', 'sc tiers', 'commission splits', 'rules', 'margins', 'operational model'],
  },
  {
    id: 'sc-products',
    title: 'Service Center Products',
    section: 'sc-products',
    categoryGroup: 'Service Centers',
    icon: Package,
    color: 'bg-amber-600',
    desc: 'Physical merchandise, POS terminals & equipment inventory at centers',
    keywords: ['service center products', 'sc inventory', 'hardware', 'stock', 'pos machines', 'equipment', 'terminals'],
  },

  // Agent Products & Services Group
  {
    id: 'agent-products-services-hub',
    title: 'Agent Products & Services Hub',
    section: 'agent-products-services',
    categoryGroup: 'Agent Products & Services',
    icon: Package,
    color: 'bg-amber-600',
    desc: 'Master product catalog: motor bikes, smartphones, boutique merchandise & signages',
    keywords: ['agent products', 'services', 'product hub', 'catalog', 'asset financing', 'hardware', 'offerings'],
  },
  {
    id: 'product-motor-bikes',
    title: 'Agent Motor Bikes (Spiro)',
    section: 'agents-bikes',
    to: '/agent-ops/products/motor-bikes',
    categoryGroup: 'Agent Products & Services',
    icon: Bike,
    color: 'bg-orange-500',
    desc: 'Electric motorcycle leases, Spiro partnership, battery swaps & lease payments',
    keywords: ['motor bikes', 'bikes', 'spiro', 'ev', 'motorcycle', 'boda boda', 'lease approval', 'dossiers', 'asset financing'],
  },
  {
    id: 'product-smartphones',
    title: 'Agent Smart Phones',
    section: 'agent-products-services',
    to: '/agent-ops/products/smart-phones',
    categoryGroup: 'Agent Products & Services',
    icon: Smartphone,
    color: 'bg-indigo-600',
    desc: 'Smartphone asset financing, device approvals & micro-installment repayment',
    keywords: ['smart phones', 'smartphones', 'phones', 'devices', 'android', 'mobile financing', 'device orders', 'phone plans'],
  },
  {
    id: 'product-boutique',
    title: 'Agent Boutique & Merchandise',
    section: 'welile-merchandise',
    to: '/agent-ops/products/boutique',
    categoryGroup: 'Agent Products & Services',
    icon: ShoppingBag,
    color: 'bg-rose-500',
    desc: 'Branded merchandise, polo shirts, uniform sales & inventory recovery',
    keywords: ['boutique', 'merchandise', 'apparel', 'polo shirts', 'uniforms', 'swag', 'branded gear', 'kits'],
  },
  {
    id: 'product-signages',
    title: 'Shop Signages',
    section: 'agent-products-services',
    to: '/agent-ops/products/signages',
    categoryGroup: 'Agent Products & Services',
    icon: Signpost,
    color: 'bg-green-600',
    desc: 'Storefront signage production, branding installations & agent contributions',
    keywords: ['signages', 'signs', 'store branding', 'shop signs', 'billboards', 'branding installation', 'advertising'],
  },

  // Financials Group
  {
    id: 'agent-balances',
    title: 'Agent Balances & Float',
    section: 'balances',
    categoryGroup: 'Financials',
    icon: PiggyBank,
    color: 'bg-emerald-600',
    desc: 'Agent wallet balances, float ledger, capital deposits & withdrawal tracking',
    keywords: ['balances', 'float', 'agent balances', 'wallet', 'ledger', 'float balances', 'cash position', 'deposits', 'withdrawals'],
  },
  {
    id: 'float-payouts',
    title: 'Landlord Float Payouts Review',
    section: 'float-payouts',
    categoryGroup: 'Financials',
    icon: Wallet,
    color: 'bg-pink-500',
    desc: 'Landlord payout review queue, phone number verification & sign-offs',
    keywords: ['float payouts', 'landlord payouts', 'payout review', 'disbursements', 'payout approvals', 'landlords'],
  },
  {
    id: 'agent-earnings',
    title: 'Agent Earnings & Commissions',
    section: 'earnings',
    categoryGroup: 'Financials',
    icon: Banknote,
    color: 'bg-green-500',
    desc: 'Commission payouts, referral earnings, performance bonuses & audit records',
    keywords: ['earnings', 'commissions', 'referrals', 'bonuses', 'payout history', 'agent revenue', 'compensation'],
  },
  {
    id: 'locked-transfers',
    title: 'Idle Tenants / Locked Transfers',
    section: 'locked-transfers',
    categoryGroup: 'Financials',
    icon: Lock,
    color: 'bg-rose-600',
    desc: 'Dormant tenant accounts, locked float reconciliation & recoverable funds',
    keywords: ['locked transfers', 'idle tenants', 'dormant', 'locked float', 'inactive tenants', 'unclaimed', 'float recovery'],
  },
  {
    id: 'collect-rent',
    title: 'Collect Rent',
    section: 'collect-rent',
    categoryGroup: 'Financials',
    icon: HandCoins,
    color: 'bg-orange-600',
    desc: 'Direct rent payment collection, manual receipting & agent float debit',
    keywords: ['collect rent', 'manual collection', 'rent payment', 'take payment', 'receipting', 'cash collection'],
  },
  {
    id: 'tenant-self-repayments',
    title: 'Tenant Self-Repayments',
    section: 'tenant-self-repayments',
    categoryGroup: 'Financials',
    icon: HandCoins,
    color: 'bg-emerald-600',
    desc: 'Tenant self-service USSD & Mobile Money payment reconciliation log',
    keywords: ['tenant self-repayments', 'self repayment', 'momo', 'direct payment', 'ussd payments', 'mobile money'],
  },

  // Advances Group
  {
    id: 'advances-analytics',
    title: 'Advances Overview & Analytics',
    section: 'advances-analytics',
    categoryGroup: 'Advances',
    icon: BarChart3,
    color: 'bg-purple-800',
    desc: 'Portfolio health score, recovery curve, monthly advance KPIs & repayment monitor',
    keywords: ['advances analytics', 'advance health', 'kpis', 'recovery rate', 'advance overview', 'repayment monitor', 'portfolio health'],
  },
  {
    id: 'advance-requests-queue',
    title: 'Advance Requests Queue',
    section: 'advance-requests',
    categoryGroup: 'Advances',
    icon: Banknote,
    color: 'bg-purple-600',
    desc: 'Incoming agent emergency & operational advance review queue and approvals',
    keywords: ['advance requests', 'requests queue', 'pending advances', 'reviews', 'advance approvals', 'emergency advance'],
  },
  {
    id: 'active-advances',
    title: 'Active Advances Book',
    section: 'active-advances',
    categoryGroup: 'Advances',
    icon: Activity,
    color: 'bg-purple-500',
    desc: 'Active disbursed advance accounts, outstanding principal & daily repayment tracking',
    keywords: ['active advances', 'open advances', 'outstanding balance', 'advance portfolio', 'active book', 'disbursed advances'],
  },
  {
    id: 'advance-potential',
    title: 'Advance Potential',
    section: 'advance-potential',
    categoryGroup: 'Advances',
    icon: Target,
    color: 'bg-purple-700',
    desc: 'Agent credit eligibility scoring & predicted borrowing capacity ceiling',
    keywords: ['advance potential', 'borrowing capacity', 'credit limit potential', 'eligibility scoring', 'creditworthiness'],
  },
  {
    id: 'advance-limits',
    title: 'Advance Limits',
    section: 'advance-limits',
    categoryGroup: 'Advances',
    icon: Coins,
    color: 'bg-emerald-800',
    desc: 'Maximum borrowing ceilings, risk parameter brackets & tier allowance rules',
    keywords: ['advance limits', 'limits', 'ceilings', 'caps', 'risk tiers', 'max advance', 'allowance'],
  },
  {
    id: 'advance-repayments',
    title: 'Advance Repayments & At-Risk Preview',
    section: 'advance-repayments',
    categoryGroup: 'Advances',
    icon: TrendingDown,
    color: 'bg-emerald-700',
    desc: 'Recent advance repayments feed, early warning delinquency flags & at-risk agents',
    keywords: ['advance repayments', 'repayments', 'at risk agents', 'overdue', 'delinquent advances', 'default warning'],
  },
  {
    id: 'advance-activity-correlation',
    title: 'Advance vs Activity Correlation',
    section: 'advance-activity-correlation',
    categoryGroup: 'Advances',
    icon: BarChart3,
    color: 'bg-purple-600',
    desc: 'Analysis comparing agent advance borrowing volume against field collections output',
    keywords: ['advance activity correlation', 'productivity correlation', 'output vs debt', 'efficiency', 'correlation matrix'],
  },

  // Reports Group
  {
    id: 'reports-overview',
    title: 'Reports Overview Hub',
    section: 'reports-overview',
    categoryGroup: 'Reports',
    icon: FileBarChart,
    color: 'bg-emerald-600',
    desc: 'Centralized hub for all agent ops reporting, summaries, exports & audit windows',
    keywords: ['reports overview', 'reporting hub', 'analytics', 'exports', 'summaries', 'master reports'],
  },
  {
    id: 'agent-ops-report',
    title: 'Agent Operations Report',
    section: 'agent-ops-report',
    categoryGroup: 'Reports',
    icon: FileBarChart,
    color: 'bg-emerald-700',
    desc: 'Comprehensive executive operational report window with Kampala day alignment',
    keywords: ['agent ops report', 'operations report', 'executive report', 'report window', 'kampala days'],
  },
  {
    id: 'portfolio-performance',
    title: 'Portfolio Performance Report',
    section: 'portfolio-performance',
    categoryGroup: 'Reports',
    icon: BarChart3,
    color: 'bg-emerald-700',
    desc: 'Longitudinal agent rent portfolio recovery, cohort performance & risk metrics',
    keywords: ['portfolio performance', 'portfolio report', 'cohort analysis', 'recovery curve', 'vintage analysis'],
  },
  {
    id: 'comprehensive-report',
    title: 'Comprehensive Report',
    section: 'comprehensive-report',
    categoryGroup: 'Reports',
    icon: FileBarChart,
    color: 'bg-emerald-800',
    desc: 'Multi-dimensional executive report covering float, agents, tenants & collections',
    keywords: ['comprehensive report', 'full report', 'master report', 'audit report', 'multi dimensional'],
  },
  {
    id: 'products-services-report',
    title: 'Products & Services Report',
    section: 'products-services-report',
    categoryGroup: 'Reports',
    icon: FileBarChart,
    color: 'bg-purple-900',
    desc: 'Sales, lease volumes & repayment metrics for motor bikes, phones & merchandise',
    keywords: ['products services report', 'hardware report', 'bike performance', 'merchandise report', 'asset report'],
  },

  // Additional Tools Group
  {
    id: 'agent-allocations',
    title: 'Agent Allocations Report',
    section: 'agent-allocations',
    categoryGroup: 'Additional Tools',
    icon: Workflow,
    color: 'bg-cyan-700',
    desc: 'Capital allocation breakdown, territory float distribution & agent quotas',
    keywords: ['agent allocations', 'allocations', 'capital distribution', 'float quotas', 'territory float'],
  },
  {
    id: 'approval-history',
    title: 'Approval History Log',
    section: 'approval-history',
    categoryGroup: 'Additional Tools',
    icon: ClipboardList,
    color: 'bg-slate-600',
    desc: 'Immutable audit trail of agent ops actions, sign-offs & approvals',
    keywords: ['approval history', 'audit log', 'activity history', 'sign-offs', 'decisions log', 'audit trail'],
  },
  {
    id: 'listing-campaign',
    title: 'Weekly Listing Campaign',
    section: 'listing-campaign',
    categoryGroup: 'Additional Tools',
    icon: Megaphone,
    color: 'bg-purple-600',
    desc: 'Agent tenant onboarding competitions, weekly listing challenges & rewards',
    keywords: ['listing campaign', 'weekly challenge', 'incentives', 'gamification', 'tenant acquisition', 'competitions'],
  },
  {
    id: 'agent-lifecycle',
    title: 'Agent Lifecycle',
    section: 'lifecycle',
    categoryGroup: 'Additional Tools',
    icon: BarChart3,
    color: 'bg-indigo-500',
    desc: 'Agent progression journey from newly recruited to verified top earner',
    keywords: ['lifecycle', 'agent lifecycle', 'stages', 'progression', 'retention', 'milestones'],
  },
];

export interface SearchResult {
  matchingBusinessAreas: BusinessAreaItem[];
  matchingFeatures: DashboardFeatureItem[];
  totalCount: number;
}

export function searchEntireDashboard(
  query: string,
  categoryFilter: string = 'all'
): SearchResult {
  const q = query.trim().toLowerCase();
  if (!q) {
    const areas = BUSINESS_AREAS.filter((area) => {
      if (
        categoryFilter !== 'all' &&
        categoryFilter !== 'first7' &&
        categoryFilter !== 'network' &&
        categoryFilter !== 'metrics' &&
        area.category !== categoryFilter
      ) {
        return false;
      }
      return true;
    });
    return {
      matchingBusinessAreas: areas,
      matchingFeatures: [],
      totalCount: areas.length,
    };
  }

  // Split query into terms for multi-word fuzzy matching
  const queryTokens = q.split(/\s+/).filter(Boolean);

  const matchItem = (
    title: string,
    desc: string,
    keywords: string[],
    extra?: string[]
  ): boolean => {
    const haystack = [
      title.toLowerCase(),
      desc.toLowerCase(),
      ...keywords.map((k) => k.toLowerCase()),
      ...(extra ? extra.map((e) => e.toLowerCase()) : []),
    ].join(' ');

    return queryTokens.every((token) => haystack.includes(token));
  };

  const matchingBusinessAreas = BUSINESS_AREAS.filter((area) => {
    const matchesNum = area.num.includes(q) || String(parseInt(area.num, 10)).includes(q);
    return (
      matchesNum ||
      matchItem(area.title, area.desc, area.keywords, [area.section || '', area.category])
    );
  });

  const matchingBusinessAreaSections = new Set(
    matchingBusinessAreas.map((b) => b.section)
  );

  const matchingFeatures = ALL_DASHBOARD_FEATURES.filter((feature) => {
    // Avoid duplicate cards if the core business area already matched and is shown
    if (feature.isCoreBusinessArea && matchingBusinessAreaSections.has(feature.section)) {
      return false;
    }
    return matchItem(feature.title, feature.desc, feature.keywords, [
      feature.categoryGroup,
      feature.section || '',
    ]);
  });

  return {
    matchingBusinessAreas,
    matchingFeatures,
    totalCount: matchingBusinessAreas.length + matchingFeatures.length,
  };
}
