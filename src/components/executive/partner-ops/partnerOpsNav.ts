import {
  LayoutDashboard,
  Users,
  Wallet,
  Inbox,
  Clock,
  CalendarX2,
  History,
  Banknote,
  TrendingUp,
  PlusCircle,
  ArrowDownToLine,
  PiggyBank,
  DollarSign,
  CalendarClock,
  PhoneCall,
  UserCog,
  ShieldCheck,
  FileText,
  ClipboardCheck,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react';

export type PartnerOpsViewKey =
  | 'overview'
  | 'directory'
  | 'portfolios.invited'
  | 'portfolios.pending'
  | 'portfolios.expiring'
  | 'portfolios.renewed'
  | 'portfolios.maturity'
  | 'financial.payouts'
  | 'financial.topups'
  | 'financial.withdrawals'
  | 'financial.wallets'
  | 'financial.capital'
  | 'nearing.overview'
  | 'nearing.followup'
  | 'proxy.overview'
  | 'proxy.vetting'
  | 'proxy.promissory'
  | 'proxy.followup'
  | 'maturity'
  | 'approvals'
  | 'rent.requests';

export interface PartnerOpsNavChild {
  key: PartnerOpsViewKey;
  label: string;
  icon: LucideIcon;
  /** extra words used by the top-bar search */
  keywords?: string[];
}

export interface PartnerOpsNavItem {
  key: PartnerOpsViewKey | string;
  label: string;
  icon: LucideIcon;
  /** leaf items carry a view key, groups carry children */
  view?: PartnerOpsViewKey;
  children?: PartnerOpsNavChild[];
  keywords?: string[];
}

export const PARTNER_OPS_NAV: PartnerOpsNavItem[] = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard, view: 'overview', keywords: ['home', 'summary', 'brief'] },
  { key: 'directory', label: 'Partner Directory', icon: Users, view: 'directory', keywords: ['partners', 'list', 'accounts'] },
  {
    key: 'portfolios',
    label: 'Portfolios',
    icon: Wallet,
    keywords: ['plans', 'investments'],
    children: [
      { key: 'portfolios.invited', label: 'Invited Portfolios', icon: Inbox, keywords: ['invites', 'invitations'] },
      { key: 'portfolios.pending', label: 'Pending Portfolios', icon: Clock, keywords: ['awaiting', 'requests'] },
      { key: 'portfolios.expiring', label: 'Expiring Portfolios', icon: CalendarX2, keywords: ['maturing', 'due'] },
      { key: 'portfolios.renewed', label: 'Renewed Portfolios', icon: History, keywords: ['renewals', 'rollover'] },
      {
        key: 'portfolios.maturity',
        label: 'Redemption & Renewal',
        icon: CalendarClock,
        keywords: ['redemption', 'redeem', 'renewal', 'maturity', 'requests', 'vet', 'queue'],
      },
    ],
  },
  {
    key: 'financial',
    label: 'Financial',
    icon: Banknote,
    keywords: ['money', 'finance'],
    children: [
      { key: 'financial.payouts', label: 'Return Payouts', icon: TrendingUp, keywords: ['roi', 'returns', 'disbursement'] },
      { key: 'financial.topups', label: 'Top-Ups', icon: PlusCircle, keywords: ['topup', 'add capital'] },
      { key: 'financial.withdrawals', label: 'Withdrawals', icon: ArrowDownToLine, keywords: ['cash out', 'payout requests'] },
      { key: 'financial.wallets', label: 'Wallet Balances', icon: PiggyBank, keywords: ['wallet', 'balance', 'activity'] },
      { key: 'financial.capital', label: 'Capital Flow', icon: DollarSign, keywords: ['liquidity', 'projections', 'charts'] },
    ],
  },
  {
    key: 'nearing',
    label: 'Nearing Payouts',
    icon: CalendarClock,
    keywords: ['due soon', 'upcoming'],
    children: [
      { key: 'nearing.overview', label: 'Overview', icon: CalendarClock, keywords: ['due soon'] },
      { key: 'nearing.followup', label: 'Followup', icon: PhoneCall, keywords: ['call', 'whatsapp', 'contact'] },
    ],
  },
  {
    key: 'proxy',
    label: 'Proxy Agents',
    icon: UserCog,
    keywords: ['proxy', 'agents'],
    children: [
      { key: 'proxy.overview', label: 'Overview', icon: UserCog, keywords: ['manage proxies'] },
      { key: 'proxy.vetting', label: 'Vetting', icon: ShieldCheck, keywords: ['applications', 'approve proxy'] },
      { key: 'proxy.promissory', label: 'Promissory Notes', icon: FileText, keywords: ['notes', 'commitments'] },
      { key: 'proxy.followup', label: 'Followup', icon: PhoneCall, keywords: ['contact', 'chase'] },
    ],
  },
  { key: 'maturity', label: 'Maturity Requests', icon: CalendarClock, view: 'maturity', keywords: ['maturity', 'requests', 'queue'] },
  {
    key: 'rent.requests',
    label: 'Rent Plan Vetting',
    icon: ClipboardList,
    view: 'rent.requests',
    keywords: ['rent', 'requests', 'proxy', 'attach', 'coo', 'tenants', 'media'],
  },
  { key: 'approvals', label: 'Partner Approvals', icon: ClipboardCheck, view: 'approvals', keywords: ['approve', 'funders', 'role requests'] },
];

export interface PartnerOpsSearchResult {
  view: PartnerOpsViewKey;
  label: string;
  parentLabel?: string;
  icon: LucideIcon;
}

/** Flat, searchable index of every navigable destination (parents + children). */
export const PARTNER_OPS_SEARCH_INDEX: (PartnerOpsSearchResult & { haystack: string })[] =
  PARTNER_OPS_NAV.flatMap((item) => {
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
      view: (item.view || item.key) as PartnerOpsViewKey,
      label: item.label,
      icon: item.icon,
      haystack: [item.label, ...(item.keywords || [])].join(' ').toLowerCase(),
    }];
  });

export function searchPartnerOpsNav(query: string): PartnerOpsSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return PARTNER_OPS_SEARCH_INDEX
    .filter((entry) => terms.every((t) => entry.haystack.includes(t)))
    .slice(0, 12)
    .map(({ haystack, ...rest }) => rest);
}

/** Which group should be expanded for a given active view. */
export function groupKeyForView(view: PartnerOpsViewKey): string | null {
  const found = PARTNER_OPS_NAV.find((item) => item.children?.some((c) => c.key === view));
  return found ? String(found.key) : null;
}