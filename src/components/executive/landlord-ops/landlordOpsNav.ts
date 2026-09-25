import {
  LayoutDashboard,
  Home,
  UserCheck,
  ShieldCheck,
  GitBranch,
  Banknote,
  ClipboardCheck,
  Landmark,
  Link2,
  Layers,
  MapPin,
  AlertTriangle,
  Handshake,
  Building2,
  Users,
  Table2,
  PhoneCall,
  Globe,
  Download,
  Wallet,
  Undo2,
  type LucideIcon,
} from 'lucide-react';

export interface LandlordOpsNavItem {
  key: string;
  label: string;
  path: string;
  icon: LucideIcon;
  badgeKey?: string;
  badge?: number;
}

export interface LandlordOpsNavSection {
  title?: string;
  items: LandlordOpsNavItem[];
}

export const LANDLORD_OPS_SECTIONS: LandlordOpsNavSection[] = [
  {
    items: [
      { key: 'today', label: 'Today', path: '', icon: LayoutDashboard },
    ],
  },
  {
    title: 'VERIFY',
    items: [
      { key: 'verify-houses', label: 'Houses', path: 'verify/houses', icon: Home, badgeKey: 'verify' },
      { key: 'verify-landlords', label: 'Landlords', path: 'verify/landlords', icon: UserCheck, badgeKey: 'landlords' },
      { key: 'verify-lc1', label: 'LC1 Chairpersons', path: 'verify/lc1', icon: ShieldCheck, badgeKey: 'lc1' },
    ],
  },
  {
    title: 'PIPELINE',
    items: [
      { key: 'pipeline-rent-requests', label: 'Rent Requests', path: 'pipeline/rent-requests', icon: GitBranch, badgeKey: 'pipeline' },
      { key: 'pipeline-advances', label: 'Business Advances', path: 'pipeline/advances', icon: Banknote },
    ],
  },
  {
    title: 'PAYOUTS',
    items: [
      { key: 'payouts-review', label: 'Payout Review', path: 'payouts/review', icon: ClipboardCheck, badgeKey: 'payouts' },
      { key: 'payouts-paid', label: 'Landlords Paid', path: 'payouts/paid', icon: Banknote },
      { key: 'payouts-float', label: 'Agent Landlord Float', path: 'payouts/float', icon: Landmark },
      { key: 'payouts-idle-float', label: 'Float Not Paid Out', path: 'payouts/idle-float', icon: Undo2 },
    ],
  },
  {
    title: 'FIX-UPS',
    items: [
      { key: 'fixups-chain-health', label: 'Chain Health', path: 'fixups/chain-health', icon: Link2 },
      { key: 'fixups-lc1-duplicates', label: 'LC1 Duplicates', path: 'fixups/lc1-duplicates', icon: Layers },
      { key: 'fixups-locations', label: 'Location Mismatches', path: 'fixups/locations', icon: MapPin },
      { key: 'fixups-no-landlord', label: 'No Landlord Listed', path: 'fixups/no-landlord', icon: AlertTriangle },
      { key: 'fixups-matching', label: 'Tenant Matching', path: 'fixups/matching', icon: Handshake },
    ],
  },
  {
    title: 'REGISTERS',
    items: [
      { key: 'registers-landlords', label: 'Landlords', path: 'registers/landlords', icon: Building2 },
      { key: 'registers-landlord-float', label: 'Landlord Float', path: 'registers/landlord-float', icon: Wallet },
      { key: 'registers-houses-tenants', label: 'Houses & Tenants', path: 'registers/houses-tenants', icon: Home },
      { key: 'registers-requests', label: 'All Requests', path: 'registers/requests', icon: Table2 },
      { key: 'registers-lc1', label: 'LC1 Register', path: 'registers/lc1', icon: ShieldCheck },
    ],
  },
  {
    title: 'ACROSS EVERYTHING',
    items: [
      { key: 'calling', label: 'Calling Hub', path: 'calling', icon: PhoneCall },
      { key: 'coverage', label: 'Coverage', path: 'coverage', icon: Globe },
      { key: 'agent-capacity', label: 'Agent Capacity', path: 'agent-capacity', icon: Users },
      { key: 'service-centres', label: 'Service Centres', path: 'service-centres', icon: Building2 },
      { key: 'reports', label: 'Reports & Exports', path: 'reports', icon: Download },
    ],
  },
];

export const ALL_LANDLORD_OPS_ITEMS: LandlordOpsNavItem[] = LANDLORD_OPS_SECTIONS.flatMap((s) => s.items);

export function findLandlordOpsItem(pathOrKey: string): LandlordOpsNavItem | undefined {
  const clean = pathOrKey.replace(/^\//, '').replace(/^landlord-ops\/?/, '');
  if (!clean || clean === 'today') return ALL_LANDLORD_OPS_ITEMS[0];
  return ALL_LANDLORD_OPS_ITEMS.find((i) => i.path === clean || i.key === clean);
}

// Backward compatibility with previous view union
export type LandlordOpsViewKey = string;
export const LANDLORD_OPS_VIEW_KEYS = new Set(ALL_LANDLORD_OPS_ITEMS.map((i) => i.path));
export function landlordOpsLabelFor(key: string): string {
  const item = findLandlordOpsItem(key);
  return item?.label || 'Landlord Operations';
}

/** Section search used by the top bar: matches label, section title and path. */
export function searchLandlordOpsNav(
  query: string,
): Array<LandlordOpsNavItem & { parentLabel?: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: Array<LandlordOpsNavItem & { parentLabel?: string }> = [];
  for (const section of LANDLORD_OPS_SECTIONS) {
    for (const item of section.items) {
      const haystack = `${item.label} ${section.title ?? ''} ${item.path}`.toLowerCase();
      if (haystack.includes(q)) {
        out.push({ ...item, parentLabel: section.title });
      }
    }
  }
  return out.slice(0, 12);
}
