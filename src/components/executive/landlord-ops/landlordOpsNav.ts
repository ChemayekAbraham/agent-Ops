import {
  LayoutDashboard,
  Shield,
  ShieldCheck,
  ShieldQuestion,
  Building2,
  Users,
  UserCheck,
  UserX,
  Home,
  Banknote,
  Table2,
  MapPin,
  Globe,
  DoorOpen,
  GitBranch,
  Link2,
  Handshake,
  Layers,
  Gauge,
  Download,
  ClipboardList,
  PhoneCall,
  Landmark,

  type LucideIcon,
} from 'lucide-react';
import type { LandlordOpsClassicView } from '../LandlordOpsDashboard';

/**
 * Sidebar nav for Landlord Ops → Classic. Every section key is one of Classic's
 * own view keys, so selecting one simply drives `LandlordOpsDashboard`; `home`
 * is owned by the shell (its landing page).
 */
export type LandlordOpsShellOnlyView = 'calling-hub' | 'agent-landlord-float';
export type LandlordOpsViewKey = LandlordOpsClassicView | LandlordOpsShellOnlyView;


export interface LandlordOpsNavChild {
  key: LandlordOpsViewKey;
  label: string;
  icon: LucideIcon;
  keywords?: string[];
}

export interface LandlordOpsNavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  view?: LandlordOpsViewKey;
  children?: LandlordOpsNavChild[];
  keywords?: string[];
}

export const LANDLORD_OPS_NAV: LandlordOpsNavItem[] = [
  { key: 'home', label: 'Home', icon: LayoutDashboard, view: 'home', keywords: ['overview', 'summary', 'landing', 'start'] },
  {
    key: 'verification',
    label: 'Verification & Approvals',
    icon: Shield,
    keywords: ['verify', 'approve', 'queue'],
    children: [
      { key: 'verify', label: 'Verification Queue', icon: ShieldCheck, keywords: ['houses', 'listings', 'pending', 'photos'] },
      { key: 'agent-verify-requests', label: 'Agent Verification Requests', icon: UserCheck, keywords: ['field', 'agents', 'landlord verification'] },
      { key: 'lc1-inbox', label: 'LC1 Verification Inbox', icon: ShieldCheck, keywords: ['lc1', 'chairperson', 'inbox'] },
      { key: 'lc1-requests', label: 'Agents Requesting LC1', icon: ShieldQuestion, keywords: ['lc1', 'requests', 'approve', 'reject'] },
      { key: 'residence-verify', label: 'Landlord GPS Verification', icon: MapPin, keywords: ['gps', 'residence', 'location', 'status'] },
      { key: 'lc1-duplicates', label: 'LC1 Duplicates', icon: Layers, keywords: ['duplicate', 'merge', 'phone'] },
    ],
  },
  {
    key: 'tools',
    label: 'Landlord Ops Tools',
    icon: ClipboardList,
    keywords: ['tools'],
    children: [
      { key: 'landlords', label: 'All Landlords', icon: Building2, keywords: ['directory', 'contacts', 'properties'] },
      { key: 'landlords-tenants', label: 'Landlords & Tenants', icon: Users, keywords: ['paid', 'pending', 'tenants'] },
      { key: 'houses-by-landlord', label: 'Houses by Landlord', icon: Home, keywords: ['bind', 'swap', 'remove tenant', 'reassign agent'] },
      { key: 'landlords-paid', label: 'Landlords Paid', icon: Banknote, keywords: ['disbursements', 'funded', 'payouts'] },
      { key: 'all-requests', label: 'All Requests', icon: Table2, keywords: ['table', 'rent requests', 'landlord lens'] },
      { key: 'no-landlord', label: 'No Landlord Listed', icon: UserX, keywords: ['missing landlord', 'contact', 'bonus'] },
      { key: 'matching', label: 'Tenant Matching', icon: Handshake, keywords: ['match', 'empty houses', 'tenants'] },
      { key: 'calling-hub', label: 'Calling Hub', icon: PhoneCall, keywords: ['call', 'calls', 'phone', 'follow up', 'pending', 'closed', 'missed calls', 'landlord calls'] },
      { key: 'advance-requests', label: 'Business Advances', icon: Banknote, keywords: ['advance', 'rent history'] },
      { key: 'agent-landlord-float', label: 'Agent Landlord Float', icon: Landmark, keywords: ['float', 'earmarks', 'payout'] },

      { key: 'lc1', label: 'LC1 Chairpersons', icon: ShieldCheck, keywords: ['register', 'approved', 'rejected', 'reports'] },
    ],
  },
  {
    key: 'workspaces',
    label: 'Workspaces',
    icon: Gauge,
    keywords: ['hubs', 'workspaces'],
    children: [
      { key: 'rent-pipeline-queue', label: 'Rent Pipeline', icon: GitBranch, keywords: ['landlord stage', 'queue', 'awaiting'] },
      { key: 'rejected-queue', label: 'Rejected at Landlord Ops', icon: ShieldQuestion, keywords: ['returned', 'reopen'] },
      { key: 'payout-review', label: 'Landlord Payout Review', icon: Banknote, keywords: ['payouts', 'before sending', 'review'] },
      { key: 'agent-capacity', label: 'Agent Rent Capacity', icon: Users, keywords: ['fleet', 'capacity', 'eligibility'] },
      { key: 'service-centres', label: 'Service Centre Managers', icon: Building2, keywords: ['managers', 'sub-agents', 'network'] },
      { key: 'pipeline', label: 'Deal Pipeline', icon: GitBranch, keywords: ['approvals', 'deal flow'] },
      { key: 'chain', label: 'Chain Health', icon: Link2, keywords: ['completeness', 'property chain'] },
      { key: 'agents', label: 'Listing Agents', icon: Users, keywords: ['rankings', 'performance'] },
      { key: 'analytics', label: 'Analytics', icon: Gauge, keywords: ['photos', 'gps', 'vacancy'] },
    ],
  },
  {
    key: 'places',
    label: 'Places & Houses',
    icon: MapPin,
    keywords: ['locations', 'geography'],
    children: [
      { key: 'locations', label: 'Locations', icon: MapPin, keywords: ['regions', 'districts', 'wards', 'house counts'] },
      { key: 'cities', label: 'Cities We Operate In', icon: Globe, keywords: ['cities', 'coverage'] },
      { key: 'empty', label: 'Empty Houses', icon: DoorOpen, keywords: ['vacant', 'lost revenue'] },
      { key: 'occupied', label: 'Occupied Houses', icon: UserCheck, keywords: ['tenants', 'active'] },
    ],
  },
  {
    key: 'reports',
    label: 'Reports & Exports',
    icon: Download,
    keywords: ['reports', 'exports', 'extract'],
    children: [
      { key: 'reports', label: 'Reports & Exports', icon: Download, keywords: ['extract centre', 'pdf', 'csv', 'date range'] },
    ],
  },
];

export interface LandlordOpsSearchResult {
  view: LandlordOpsViewKey;
  label: string;
  parentLabel?: string;
  icon: LucideIcon;
}

/** Flat, searchable index of every navigable destination (parents + children). */
export const LANDLORD_OPS_SEARCH_INDEX: (LandlordOpsSearchResult & { haystack: string })[] =
  LANDLORD_OPS_NAV.flatMap((item): (LandlordOpsSearchResult & { haystack: string })[] => {
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
      view: (item.view || item.key) as LandlordOpsViewKey,
      label: item.label,
      icon: item.icon,
      haystack: [item.label, ...(item.keywords || [])].join(' ').toLowerCase(),
    }];
  });

export function searchLandlordOpsNav(query: string): LandlordOpsSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return LANDLORD_OPS_SEARCH_INDEX
    .filter((entry) => terms.every((t) => entry.haystack.includes(t)))
    .slice(0, 12)
    .map(({ haystack, ...rest }) => rest);
}

/** Label for a destination key — used by the shell's in-view heading. */
export function landlordOpsLabelFor(key: string): string {
  const hit = LANDLORD_OPS_SEARCH_INDEX.find((e) => e.view === key);
  return hit?.label || '';
}

/** Which group should be expanded for a given active view. */
export function landlordOpsGroupForView(view: string): string | null {
  const found = LANDLORD_OPS_NAV.find((item) => item.children?.some((c) => c.key === view));
  return found ? String(found.key) : null;
}

/** Every valid destination key, for validating a `?view=` URL parameter. */
export const LANDLORD_OPS_VIEW_KEYS = new Set<string>(
  LANDLORD_OPS_SEARCH_INDEX.map((e) => String(e.view)),
);
