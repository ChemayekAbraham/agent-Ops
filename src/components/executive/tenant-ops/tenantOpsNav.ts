import {
  LayoutDashboard,
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
  type LucideIcon,
} from 'lucide-react';
import type { TenantOpsClassicView } from '../TenantOpsDashboard';

/**
 * Sidebar nav for Tenant Ops → Classic. Section keys are either Classic's own
 * view keys (so selecting one simply drives `TenantOpsDashboard`) or one of the
 * shell-owned keys below.
 */
export type TenantOpsShellOnlyView = 'home' | 'phone-duplicates';
export type TenantOpsViewKey = TenantOpsShellOnlyView | TenantOpsClassicView;

/** Actions that are not views — they open a sheet or leave the dashboard. */
export type TenantOpsActionKey = 'action.word-report' | 'action.locations' | 'action.welile-homes';

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
  {
    key: 'verification',
    label: 'Verification & Users',
    icon: Shield,
    keywords: ['verify', 'users'],
    children: [
      { key: 'global-verification', label: 'Global Verification Center', icon: Shield, keywords: ['landlords', 'lc1', 'chairperson', 'requests', 'country'] },
      { key: 'welile-operations', label: 'Welile Operations', icon: Landmark, keywords: ['users', 'tenants', 'landlords', 'agents', 'partners', 'profiles'] },
      { key: 'phone-duplicates', label: 'Phone Duplicates', icon: Copy, keywords: ['duplicate', 'phone', 'fraud', 'same number'] },
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
      { key: 'missed', label: 'Missed Days', icon: CalendarX2, keywords: ['behind', 'arrears', 'late'] },
      { key: 'behavior', label: 'Tenant Behavior', icon: Activity, keywords: ['risk', 'score', 'patterns'] },
      { key: 'history', label: 'Approval History', icon: History, keywords: ['log', 'approvals', 'rejections'] },
      { key: 'all-requests', label: 'All Requests', icon: Table2, keywords: ['table', 'every request'] },
      { key: 'link-agent', label: 'Link Agent', icon: Link2, keywords: ['assign', 'agent', 'tenant'] },
      { key: 'transfer-audit', label: 'Transfer Audit', icon: Shield, keywords: ['geo', 'transfers', 'link history'] },
      { key: 'collect-rent', label: 'Collect Rent', icon: HandCoins, keywords: ['charge', 'wallet', 'payment'] },
      { key: 'agent-tenants', label: 'Search by Agent', icon: Users, keywords: ['find tenants', 'agent'] },
      { key: 'advance-requests', label: 'Business Advances', icon: Banknote, keywords: ['advance', 'rent history'] },
      { key: 'agent-allocations', label: 'Agent Allocations', icon: Network, keywords: ['per agent', 'repayment'] },
      { key: 'landlord-float', label: 'Agent Landlord Float', icon: Landmark, keywords: ['float', 'earmarks', 'payout'] },
      { key: 'landlord-float-timeline', label: 'Float Timeline', icon: History, keywords: ['allocation history', 'reference'] },
      { key: 'location-browser', label: 'Browse by Location', icon: MapPin, keywords: ['country', 'region', 'district', 'ward'] },
      { key: 'daily-repayments-report', label: 'Daily Rent Repayments', icon: HandCoins, keywords: ['ledger', 'repayments', 'day'] },
    ],
  },
  {
    key: 'workspaces',
    label: 'Workspaces',
    icon: Gauge,
    keywords: ['hubs', 'workspaces'],
    children: [
      { key: 'pipeline-hub', label: 'Pipeline Status', icon: Activity, keywords: ['lifecycle', 'receivables', 'payables', 'charts'] },
      { key: 'agent-capacity-hub', label: 'Agent Rent Capacity', icon: Gauge, keywords: ['capacity', 'eligibility', 'rating'] },
      { key: 'all-tenants-hub', label: 'All Tenants', icon: Users, keywords: ['register', 'search', 'bulk'] },
      { key: 'daily-collections', label: 'Daily Collection Monitoring', icon: CalendarCheck, keywords: ['expected', 'collected', 'edit'] },
      { key: 'reliability-hub', label: 'Repayment Reliability Score', icon: ShieldCheck, keywords: ['risk', 'score', 'recency'] },
      { key: 'tenant-products-report', label: 'Tenant Products & Services', icon: FileText, keywords: ['products', 'services', 'report'] },
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
  TENANT_OPS_NAV.flatMap((item) => {
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
