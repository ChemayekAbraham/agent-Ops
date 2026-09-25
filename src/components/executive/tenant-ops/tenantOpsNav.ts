import {
  LayoutDashboard,
  TrendingUp,
  Shield,
  Landmark,
  FileSearch,
  ClipboardList,
  CalendarCheck,
  CalendarX2,
  Activity,
  History,
  Table2,
  Link2,
  HandCoins,
  Users,
  Banknote,
  Network,
  MapPin,
  Gauge,
  ShieldCheck,
  Download,
  Copy,
  Home,
  FileText,
  Headphones,
  PhoneCall,
  AlertTriangle,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import type { TenantOpsClassicView } from '../TenantOpsDashboard';

/**
 * Sidebar nav for Tenant Ops → Classic. Section keys are either Classic's own
 * view keys (so selecting one simply drives `TenantOpsDashboard`) or one of the
 * shell-owned keys below.
 */
export type TenantOpsShellOnlyView =
  | 'home'
  | 'phone-duplicates'
  | 'calling-hub'
  | 'calling-center'
  | 'tenant-operations-workspace'
  | 'tenant-ops-weekly-performance';
export type TenantOpsViewKey = TenantOpsShellOnlyView | TenantOpsClassicView;

/** Actions that are not views — they open a sheet or leave the dashboard. */
export type TenantOpsActionKey =
  | 'action.word-report'
  | 'action.locations'
  | 'action.welile-homes'
  | 'action.portfolio-performance'
  | 'action.notifications-analytics';

export interface TenantOpsNavChild {
  key: TenantOpsViewKey | TenantOpsActionKey;
  label: string;
  icon: LucideIcon;
  keywords?: string[];
}

export interface TenantOpsNavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  view?: TenantOpsViewKey;
  children?: TenantOpsNavChild[];
  keywords?: string[];
}

export const TENANT_OPS_NAV: TenantOpsNavItem[] = [
  { key: 'home', label: 'Home', icon: LayoutDashboard, view: 'home', keywords: ['overview', 'summary', 'landing', 'start'] },
  { key: 'action.portfolio-performance', label: 'Portfolio Performance', icon: TrendingUp, keywords: ['portfolio', 'performance', 'collections', 'requests', 'report'] },
  { key: 'action.notifications-analytics', label: 'Notifications & Devices', icon: Smartphone, keywords: ['smartphone', 'notifications', 'sms', 'push', 'analytics', 'devices'] },
  {
    key: 'verification',
    label: 'Verification & Users',
    icon: Shield,
    keywords: ['verify', 'users'],
    children: [
      { key: 'registration-review', label: 'Review Registration', icon: FileSearch, keywords: ['edit tenant', 'registration', 'details'] },
    ],
  },
  {
    key: 'tools',
    label: 'Tenant Ops Tools',
    icon: ClipboardList,
    keywords: ['tools'],
    children: [
      { key: 'pipeline', label: 'Review Requests', icon: ClipboardList, keywords: ['approve', 'vet', 'queue', 'pipeline'] },
      { key: 'daily', label: 'Daily Payments', icon: CalendarCheck, keywords: ['today', 'paid', 'unpaid'] },
      { key: 'calling-hub', label: 'Calling Hub', icon: PhoneCall, keywords: ['call', 'calls', 'phone', 'follow up', 'pending', 'closed', 'missed calls'] },
      { key: 'calling-center', label: 'Calling Center', icon: Headphones, keywords: ['call centre', 'call center', 'dial', 'auto call', 'sequential', 'live call', 'voice'] },
      { key: 'missed', label: 'Missed Days', icon: CalendarX2, keywords: ['behind', 'arrears', 'late'] },
      { key: 'backlog-analysis', label: 'Backlog Analysis', icon: AlertTriangle, keywords: ['overdue', 'backlog', 'arrears', 'recovery', 'ageing', 'aging'] },
      { key: 'behavior', label: 'Tenant Behavior', icon: Activity, keywords: ['risk', 'score', 'patterns'] },
      { key: 'all-requests', label: 'All Requests', icon: Table2, keywords: ['table', 'every request'] },
      { key: 'link-agent', label: 'Link Agent', icon: Link2, keywords: ['assign', 'agent', 'tenant'] },
      { key: 'transfer-audit', label: 'Transfer Audit', icon: Shield, keywords: ['geo', 'transfers', 'link history'] },
      { key: 'agent-tenants', label: 'Search by Agent', icon: Users, keywords: ['find tenants', 'agent'] },
      { key: 'location-browser', label: 'Browse by Location', icon: MapPin, keywords: ['country', 'region', 'district', 'ward'] },
      { key: 'daily-repayments-report', label: 'Daily Rent Repayments', icon: HandCoins, keywords: ['ledger', 'repayments', 'day'] },
      { key: 'tenant-self-repayments', label: 'Tenant Self-Repayments', icon: HandCoins, keywords: ['self pay', 'tenant paid', 'deposit', 'own rent', 'self repayment'] },
    ],
  },
  {
    key: 'workspaces',
    label: 'Workspaces',
    icon: Gauge,
    keywords: ['hubs', 'workspaces'],
    children: [
      { key: 'tenant-operations-workspace', label: 'Tenant Operations Workspace', icon: Gauge, keywords: ['workspace', 'top up', 'topup', 'top-up', 'eligibility', 'increase', 'tenant operations'] },
      { key: 'tenant-ops-weekly-performance', label: 'Weekly Performance', icon: CalendarX2, keywords: ['weekly', 'performance', 'management summary', 'active tenants', 'paying tenants', 'payment rate', 'new tenants', '20 days no payment', 'dormant', 'self payment', 'merchant'] },
      { key: 'pipeline-hub', label: 'Pipeline Status', icon: Activity, keywords: ['lifecycle', 'receivables', 'payables', 'charts'] },
      { key: 'agent-capacity-hub', label: 'Agent Rent Capacity', icon: Gauge, keywords: ['capacity', 'eligibility', 'rating'] },
      { key: 'all-tenants-hub', label: 'All Tenants', icon: Users, keywords: ['register', 'search', 'bulk'] },
      { key: 'tenant-locations-test', label: 'Tenant Locations', icon: MapPin, keywords: ['region', 'district', 'county', 'subcounty', 'parish', 'village', 'unmapped', 'locations'] },
      { key: 'daily-collections', label: 'Daily Collection Monitoring', icon: CalendarCheck, keywords: ['expected', 'collected', 'edit'] },
      { key: 'agent-monitoring', label: 'Agent Monitoring', icon: Users, keywords: ['agents', 'monitoring', 'collections', 'expected', 'collected', 'performance'] },
      { key: 'reliability-hub', label: 'Repayment Reliability Score', icon: ShieldCheck, keywords: ['risk', 'score', 'recency'] },
      { key: 'location-corrections', label: 'Tenant Location Corrections', icon: MapPin, keywords: ['location', 'village', 'district', 'legacy', 'corrections', 'fix'] },
      { key: 'tenant-products-report', label: 'Tenant Products & Services', icon: FileText, keywords: ['products', 'services', 'report'] },
      { key: 'portfolio-performance-hub', label: 'Portfolio Performance', icon: TrendingUp, keywords: ['portfolio', 'performance', 'expected', 'collected', 'arrears', 'closing arrears', 'collection rate'] },
    ],
  },
  {
    key: 'reports',
    label: 'Reports & Tools',
    icon: Download,
    keywords: ['reports', 'exports'],
    children: [
      { key: 'reports-hub', label: 'Reports & Exports', icon: Download, keywords: ['extract', 'csv', 'pdf', 'date range'] },
      { key: 'action.word-report', label: 'Word Report', icon: FileText, keywords: ['docx', 'operations report'] },
      { key: 'action.welile-homes', label: 'Welile Homes', icon: Home, keywords: ['agent managed', 'subscriptions'] },
      { key: 'action.locations', label: 'Locations', icon: MapPin, keywords: ['location management', 'districts'] },
    ],
  },
];

export function isTenantOpsAction(key: string): key is TenantOpsActionKey {
  return key.startsWith('action.');
}

export interface TenantOpsSearchResult {
  view: TenantOpsViewKey | TenantOpsActionKey;
  label: string;
  parentLabel?: string;
  icon: LucideIcon;
}

/** Flat, searchable index of every navigable destination (parents + children). */
export const TENANT_OPS_SEARCH_INDEX: (TenantOpsSearchResult & { haystack: string })[] =
  TENANT_OPS_NAV.flatMap((item): (TenantOpsSearchResult & { haystack: string })[] => {
    if (item.children?.length) {
      return item.children.map((child) => ({
        view: child.key,
        label: child.label,
        parentLabel: item.label,
        icon: child.icon,
        haystack: [item.label, child.label, ...(item.keywords || []), ...(child.keywords || [])]
          .join(' ')
          .toLowerCase(),
      }));
    }
    return [{
      view: (item.view || item.key) as TenantOpsViewKey,
      label: item.label,
      icon: item.icon,
      haystack: [item.label, ...(item.keywords || [])].join(' ').toLowerCase(),
    }];
  });

export function searchTenantOpsNav(query: string): TenantOpsSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return TENANT_OPS_SEARCH_INDEX
    .filter((entry) => terms.every((t) => entry.haystack.includes(t)))
    .slice(0, 12)
    .map(({ haystack, ...rest }) => rest);
}

/** Label for a destination key — used by the shell's in-view heading. */
export function tenantOpsLabelFor(key: string): string {
  const hit = TENANT_OPS_SEARCH_INDEX.find((e) => e.view === key);
  return hit?.label || '';
}

/** Which group should be expanded for a given active view. */
export function tenantOpsGroupForView(view: string): string | null {
  const found = TENANT_OPS_NAV.find((item) => item.children?.some((c) => c.key === view));
  return found ? String(found.key) : null;
}

/** Every valid destination key, for validating a `?view=` URL parameter. */
export const TENANT_OPS_VIEW_KEYS = new Set<string>(TENANT_OPS_SEARCH_INDEX.map((e) => String(e.view)));

/**
 * Classic views that are reachable by drilling down inside Classic (e.g. clicking
 * a tenant row) but deliberately have no sidebar entry. They must still be
 * accepted as valid `?view=` values, otherwise the shell bounces back to Home.
 */
export const TENANT_OPS_TRANSIENT_VIEW_KEYS = new Set<string>([
  'tenant-detail',
  'tenant-location-browser',
  // Relocated to other dashboards (no sidebar entry here any more) but still
  // reachable from the Extract Center's "open the view" links inside Classic.
  'history',
  'agent-allocations',
  'landlord-float',
  'landlord-float-timeline',
  'collect-rent',
  'advance-requests',
  'global-verification',
  'welile-operations',
]);

/** Is this a destination the shell may render (sidebar entry or drill-down)? */
export function isTenantOpsViewKey(key: string): boolean {
  return TENANT_OPS_VIEW_KEYS.has(key) || TENANT_OPS_TRANSIENT_VIEW_KEYS.has(key);
}
