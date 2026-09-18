import {
  BarChart3, Shield, Banknote, ClipboardList, BookOpen, Server, Code, Lock, Wrench,
  TrendingUp, Users, Home, Building2, Handshake, Activity, Megaphone, Target, Share2,
  MessageSquare, HeadphonesIcon, AlertTriangle, Scale, UserCheck, FileText, Wallet,
  Crown, LayoutDashboard, Globe, DollarSign, UserCog, Truck, Layers, MinusCircle, Receipt,
  ShieldCheck, GraduationCap, Mail, FolderOpen, CalendarCheck, Landmark, KeyRound, SlidersHorizontal, HandCoins, Snowflake, ShoppingBag, MonitorSmartphone
  , Gauge, Download, ShieldAlert,
  Eye, Trash2, PhoneCall, History, RefreshCw, Archive, Bike, GitCommit,
} from 'lucide-react';
import type { AppRole } from '@/hooks/auth/types';

/**
 * Declares what a signed-in person needs in order to actually open a sidebar
 * item's route. Mirrors the guard already applied to the route in App.tsx —
 * this adds NO new permission system, it only stops rendering links that would
 * bounce the user with a 404.
 *
 *  - `'signed-in'` → visible to anyone who is authenticated.
 *  - `{ roles, permission }` → visible when the user holds one of `roles`
 *    AND (when given) `hasPermission(permission)` from `useStaffPermissions`.
 *
 * Omitted entirely = unchanged legacy behaviour (always rendered).
 */
export type SidebarItemAccess =
  | 'signed-in'
  | { roles: AppRole[]; permission?: string };

export interface SidebarItem {
  label: string;
  icon: typeof BarChart3;
  id: string;
  route?: string;
  /** Optional gate describing who can reach this item's route. */
  access?: SidebarItemAccess;
  /**
   * Optional second-level items, rendered indented under a parent that expands
   * on click instead of switching the view itself. One level only — a child
   * with its own `children` is not rendered as a third level.
   *
   * A parent with children is a disclosure, not a destination: give the landing
   * view its own child entry (e.g. Call Center → Overview) rather than relying
   * on the parent id.
   */
  children?: SidebarItem[];
}

export interface SidebarSection {
  title: string;
  items: SidebarItem[];
  /**
   * When true, renders this section as a collapsible group with a chevron
   * toggle. Defaults to false (always-expanded section header).
   */
  collapsible?: boolean;
  /** Default open state when `collapsible` is true. */
  defaultOpen?: boolean;
  /** Optional icon shown next to the section title when collapsible. */
  icon?: typeof BarChart3;
}

/** Same gate the /hr/* routes already enforce via RoleGuard. */
const HR_ACCESS: SidebarItemAccess = {
  roles: ['hr', 'super_admin'],
  permission: 'hr',
};

/** Same gate the CFO dashboard route already enforces. */
const CFO_ACCESS: SidebarItemAccess = {
  roles: ['cfo', 'super_admin'],
};

export const executiveSidebarConfig: Record<string, SidebarSection[]> = {
  cto: [
    {
      title: 'Engineering',
      items: [
        { label: 'Overview', icon: LayoutDashboard, id: 'overview' },
        { label: 'System Infrastructure', icon: Server, id: 'infrastructure' },
        { label: 'API Management', icon: Code, id: 'api' },
        { label: 'Communication', icon: Mail, id: 'communication' },
        { label: 'OTP / SMS Logs', icon: MessageSquare, id: 'sms-delivery' },
        { label: 'Voice API Calls', icon: PhoneCall, id: 'voice-calls' },
        { label: 'SMS Exceptions', icon: ShieldCheck, id: 'sms-exceptions' },
        { label: 'Broadcast Status', icon: Megaphone, id: 'broadcast-status' },
        { label: 'Security Logs', icon: Lock, id: 'security' },
        { label: 'Platform Controls', icon: SlidersHorizontal, id: 'platform-controls' },
        { label: 'Agent Freeze', icon: Snowflake, id: 'agent-freeze' },
        { label: 'KYC & ID Overrides', icon: ShieldCheck, id: 'kyc-level' },
        { label: 'Reset Password', icon: KeyRound, id: 'password-reset' },
        { label: 'Merchant Invites', icon: HandCoins, id: 'merchant-invites' },
        { label: 'Developer Tools', icon: Wrench, id: 'tools' },
        { label: 'System Logs', icon: FileText, id: 'system-logs' },
        { label: 'Code Commits', icon: GitCommit, id: 'git-commits' },
        { label: 'Browser Compatibility', icon: MonitorSmartphone, id: 'browser-compat' },
        { label: 'Signup Log', icon: ShieldCheck, id: 'signup-log' },
        { label: 'Deposit Bridge', icon: Activity, id: 'bridge-health' },
        { label: 'Platform Users', icon: Users, id: 'platform-users', route: '/platform-users' },
        { label: 'Deleted Accounts', icon: Trash2, id: 'deleted-accounts' },

        { label: 'Requisitions', icon: ClipboardList, id: 'requisitions' },
        { label: 'My Work', icon: ClipboardList, id: 'my-work' },
      ],
    },
  ],
  cfo: [
    {
      title: 'Quick Actions',
      items: [
        { label: 'Home', icon: Home, id: 'overview' },
        { label: 'Payroll Release', icon: Banknote, id: 'payroll-release' },
        { label: 'Send Money', icon: Wallet, id: 'wallet-payout' },
        { label: 'Standing Orders', icon: RefreshCw, id: 'standing-orders' },
        { label: 'Wallet Activities', icon: ClipboardList, id: 'wallet-activities' },
        { label: 'How Did They Earn?', icon: ClipboardList, id: 'earnings-explainer' },
        { label: 'Platform Impact', icon: Globe, id: 'platform-impact' },
        { label: 'Requisitions', icon: ClipboardList, id: 'requisitions' },
        { label: 'My Work', icon: ClipboardList, id: 'my-work' },
      ],
    },
    {
      title: 'Advances',
      items: [
        { label: 'Advances Overview', icon: BarChart3, id: 'advances-analytics' },
        { label: 'Advance Requests', icon: HandCoins, id: 'advances' },
        { label: 'Disbursed Advances', icon: Banknote, id: 'advances-disbursed' },
        { label: 'Advance Repayments', icon: Receipt, id: 'advance-repayments' },
        {
          label: 'Agent Products',
          icon: ShoppingBag,
          id: 'agent-products',
          children: [
            { label: 'Welile Motorbikes', icon: Bike, id: 'agent-products-motorbikes' },
            { label: 'Welile Smartphones', icon: MonitorSmartphone, id: 'agent-products-smartphones' },
          ],
        },
      ],
    },
    {
      title: 'Money In',
      items: [
        { label: 'Rent Collections', icon: Receipt, id: 'rent-collections' },
        
        { label: 'Tenant Self-Repayments', icon: Receipt, id: 'tenant-self-repayments' },
        { label: 'Investor Returns', icon: TrendingUp, id: 'roi-requests' },
        { label: 'Partner Top-ups', icon: TrendingUp, id: 'partner-topups' },
      ],
    },
    {
      title: 'Money Out',
      items: [
      { label: 'Rent Payouts', icon: Banknote, id: 'rent-payouts' },
        { label: 'Landlord Payout Float', icon: Home, id: 'landlord-payout-float' },
        { label: 'Float Timeline', icon: History, id: 'landlord-float-timeline' },
        { label: 'Already Funded Landlords', icon: Landmark, id: 'already-funded-landlords' },
        { label: 'Agent Commissions', icon: Banknote, id: 'commissions' },
        { label: 'Withdrawals', icon: Wallet, id: 'withdrawals' },
        { label: 'Withdrawal History', icon: ClipboardList, id: 'withdrawal-history' },
        { label: 'Withdrawal Reconciliation', icon: ShieldAlert, id: 'withdrawal-reconciliation' },
        { label: 'Staff & Payroll', icon: Users, id: 'payroll' },
        { label: 'Agent Requests', icon: FileText, id: 'agent-requisitions' },
        { label: 'Manual Requisition Links', icon: FileText, id: 'employee-requisition-links' },
        { label: 'Manual Requisition Review', icon: ClipboardList, id: 'employee-requisitions' },
        { label: 'Wallet Removals', icon: MinusCircle, id: 'retractions' },
        { label: 'Mark-Not-Funded Approvals', icon: ShieldCheck, id: 'unfunding-approvals' },
      ],
    },
    {
      title: 'Agents & Field',
      items: [
        { label: 'Agent Teams', icon: DollarSign, id: 'financial-agents' },
        { label: 'Agent Activity', icon: Activity, id: 'agent-activity' },
        { label: 'Agent Rankings', icon: Crown, id: 'agent-rankings' },
        { label: 'Agent Float', icon: Building2, id: 'float-management' },
        { label: 'Delivery Tracking', icon: Truck, id: 'delivery-pipeline' },
        { label: 'Cash Check', icon: Scale, id: 'cash-reconciliation' },
      ],
    },
    {
      title: 'Budgeting',
      items: [
        { label: 'Department Budgets', icon: ClipboardList, id: 'department-budgets', access: CFO_ACCESS },
        { label: 'Service Centre Spend', icon: Building2, id: 'service-centre-spend', access: CFO_ACCESS },
      ],
    },

    {
      title: 'Reports & Audit',
      items: [
        { label: 'Financial Reports', icon: BookOpen, id: 'statements' },
        { label: 'Weekly CFO Report', icon: FileText, id: 'weekly-report' },
        { label: 'Revenue & Expenses', icon: TrendingUp, id: 'revenue-expenses' },
        { label: 'Returns Disbursement Report', icon: FileText, id: 'roi-disbursement-report' },
        { label: 'Rent Disbursement Report', icon: FileText, id: 'rent-disbursement-report' },
        { label: 'Merchant Requisition Report', icon: FileText, id: 'merchant-requisition-report' },
        { label: 'Employee Requisition Report', icon: FileText, id: 'employee-requisition-report' },
        { label: 'Expense Report', icon: FileText, id: 'expense-report' },
        { label: 'Payout Reports', icon: Banknote, id: 'payout-reports' },
        { label: 'All Advances Report', icon: HandCoins, id: 'advances-report' },
        { label: 'House Listing Commission', icon: Home, id: 'house-listing-commission' },
        { label: 'Safety Buffer', icon: Shield, id: 'solvency' },
        { label: 'Reconciliation', icon: Scale, id: 'reconciliation' },
        { label: 'Full Ledger', icon: ClipboardList, id: 'ledger' },
        { label: 'Detailed Ledgers', icon: BookOpen, id: 'advanced-ledgers' },
        { label: 'Approval History', icon: ShieldCheck, id: 'approval-audit' },
        { label: 'Wallet Error Corrections', icon: ShieldCheck, id: 'error-corrections' },
        { label: 'Allocation Traces', icon: ClipboardList, id: 'allocation-traces' },
        { label: 'System Health', icon: Activity, id: 'ledger-health' },
        { label: 'SMS Delivery Log', icon: MessageSquare, id: 'sms-log' },
        { label: 'Graphic Cashflow Forecast', icon: BarChart3, id: 'cashflow-forecast' },
        { label: 'Capital Opportunities', icon: TrendingUp, id: 'capital-opportunities' },
        { label: 'Angel Pool', icon: Layers, id: 'angel-pool' },
      ],
    },
  ],
  coo: [
    {
      title: 'Financial Operations',
      items: [
        { label: 'Overview', icon: Activity, id: 'overview' },
        { label: 'Rent Approvals', icon: ClipboardList, id: 'rent-approvals' },
        { label: 'Tenants', icon: Home, id: 'tenants' },
        { label: 'Transactions', icon: ClipboardList, id: 'transactions' },
        { label: 'Agent Collections', icon: Users, id: 'collections' },
        { label: 'Daily Collections', icon: CalendarCheck, id: 'daily-collections' },
        { label: 'Wallets', icon: Wallet, id: 'wallets' },
        { label: 'Agents', icon: Activity, id: 'agent-activity' },
        { label: 'Payment Analytics', icon: BarChart3, id: 'analytics' },
        { label: 'My Work', icon: ClipboardList, id: 'my-work' },
      ],
    },
    {
      title: 'Governance',
      items: [
        { label: 'Financial Reports', icon: FileText, id: 'reports' },
        { label: 'Alerts', icon: AlertTriangle, id: 'alerts' },
        { label: 'Withdrawal Approvals', icon: Banknote, id: 'withdrawals' },
        { label: 'ROI Return Approvals', icon: ShieldCheck, id: 'roi-approvals' },
        { label: 'Partners', icon: Handshake, id: 'partners' },
        { label: 'Partner Finance', icon: Receipt, id: 'partner-finance' },
        { label: 'Partner Top-ups', icon: TrendingUp, id: 'partner-topups' },
        { label: 'Staff Performance', icon: UserCheck, id: 'staff-performance' },
        { label: 'Global Verification Center', icon: ShieldCheck, id: 'global-verification' },
        { label: 'Welile Operations', icon: Landmark, id: 'welile-operations' },
        { label: 'Approval History', icon: History, id: 'approval-history' },
        { label: 'Service Centre Vetting', icon: Building2, id: 'service-centres' },
        {
          label: 'Agent Products',
          icon: ShoppingBag,
          id: 'agent-products',
          children: [
            { label: 'Welile Motorbikes', icon: Bike, id: 'agent-products-motorbikes' },
            { label: 'Welile Smartphones', icon: MonitorSmartphone, id: 'agent-products-smartphones' },
          ],
        },
        { label: 'Manual Requisitions', icon: ClipboardList, id: 'manual-requisitions' },
        { label: 'Funder Rent Plans', icon: Eye, id: 'funder-rent-plans', route: '/coo/funder-rent-plans' },
         { label: 'Department Budgets', icon: ClipboardList, id: 'department-budgets' },
        { label: 'Requisitions', icon: ClipboardList, id: 'requisitions' },
      ],
    },
    {
      title: 'Reports',
      icon: FolderOpen,
      collapsible: true,
      defaultOpen: false,
      items: [
        { label: 'Partner Ops',   icon: Handshake,     id: 'reports-partner-ops',   route: '/coo/reports/partner-ops' },
        { label: 'Agent Ops',     icon: Users,         id: 'reports-agent-ops',     route: '/coo/reports/agent-ops' },
        { label: 'Tenant Ops',    icon: Home,          id: 'reports-tenant-ops',    route: '/coo/reports/tenant-ops' },
        { label: 'Portfolio Performance', icon: BarChart3, id: 'reports-tenant-portfolio-performance', route: '/coo/reports/tenant-portfolio-performance' },
        { label: 'Financial Ops', icon: Wallet,        id: 'reports-financial-ops', route: '/coo/reports/financial-ops' },
        { label: 'System Overview', icon: Activity,    id: 'reports-system-overview', route: '/coo/reports/system-overview' },
        { label: 'Platform Sales Officers', icon: Users, id: 'reports-platform-sales-officers', route: '/hr/reports/platform-sales-officers' },
      ],
    },
  ],
  cmo: [
    {
      title: 'Marketing',
      items: [
        { label: 'Overview', icon: LayoutDashboard, id: 'overview' },
        { label: 'User Analytics', icon: BarChart3, id: 'user-analytics' },
        { label: 'Growth Metrics', icon: TrendingUp, id: 'growth' },
        { label: 'Signup Trends', icon: UserCheck, id: 'signups' },
        { label: 'Referral Performance', icon: Share2, id: 'referrals' },
        { label: 'Campaign Analytics', icon: Target, id: 'campaigns' },
        { label: 'Install Funnel', icon: Download, id: 'install-funnel' },
        { label: 'Merchandise', icon: ShoppingBag, id: 'merchandise' },
        { label: 'Requisitions', icon: ClipboardList, id: 'requisitions' },
        { label: 'My Work', icon: ClipboardList, id: 'my-work' },
      ],
    },
  ],
  crm: [
    {
      title: 'Customer Relations',
      items: [
        { label: 'Overview', icon: LayoutDashboard, id: 'overview' },
        {
          label: 'Call Center',
          icon: PhoneCall,
          id: 'call-centre',
          children: [
            { label: 'Overview', icon: Gauge, id: 'call-centre-overview' },
            { label: 'History', icon: History, id: 'call-centre-history' },
            { label: 'People / Calls', icon: Users, id: 'call-centre-people' },
          ],
        },
        { label: 'Customer Issues', icon: MessageSquare, id: 'customer-issues' },
        { label: 'Tenant Support', icon: Handshake, id: 'tenant-support' },
        { label: 'Communications', icon: MessageSquare, id: 'communications' },
        { label: 'Requisitions', icon: ClipboardList, id: 'requisitions' },
        { label: 'My Work', icon: ClipboardList, id: 'my-work' },
      ],
    },
  ],
  ceo: [
    {
      title: 'Executive',
      items: [
        { label: 'Platform Overview', icon: Crown, id: 'overview' },
        { label: 'Revenue & Growth', icon: TrendingUp, id: 'revenue' },
        { label: 'Revenue Recognition', icon: Gauge, id: 'revenue-recognition' },
        { label: 'Users & Coverage', icon: Globe, id: 'users' },
        { label: 'Global Verification Center', icon: ShieldCheck, id: 'global-verification' },
        { label: 'Welile Operations', icon: Landmark, id: 'welile-operations' },
        { label: 'Financial Health', icon: Shield, id: 'financial' },
        { label: 'Requisitions', icon: ClipboardList, id: 'requisitions' },
        { label: 'Payroll Approvals', icon: Banknote, id: 'ceo-pay-approvals', route: '/approvals' },
        { label: 'Salary Advances', icon: HandCoins, id: 'ceo-pay-advances', route: '/hr/pay/advances' },
        { label: 'Platform Sales Officers', icon: Users, id: 'ceo-platform-sales-officers', route: '/hr/reports/platform-sales-officers' },
        { label: 'Staff Performance', icon: UserCheck, id: 'staff-performance' },
        { label: 'Angel Pool', icon: Layers, id: 'angel-pool' },
        { label: 'Mission & Goals', icon: Target, id: 'mission-goals' },
        { label: 'Role Management', icon: UserCog, id: 'role-management' },
        { label: 'My Work', icon: ClipboardList, id: 'my-work' },
      ],
    },
  ],
  hr: [
    {
      title: 'Human Resources',
      items: [
        { label: 'Overview', icon: LayoutDashboard, id: 'overview', access: HR_ACCESS },
        { label: 'My Work', icon: ClipboardList, id: 'my-work', access: HR_ACCESS },
        { label: 'Recruitment', icon: UserCheck, id: 'hr-recruitment', route: '/hr/dashboard/recruitment', access: HR_ACCESS },
        { label: 'People', icon: Users, id: 'hr-people', route: '/hr/people', access: HR_ACCESS },
        { label: 'Departments', icon: Building2, id: 'departments', access: HR_ACCESS },
        { label: 'Contracts', icon: FileText, id: 'hr-contracts', route: '/hr/contracts', access: HR_ACCESS },
        { label: 'Leave Management', icon: ClipboardList, id: 'leave', access: HR_ACCESS },
        { label: 'Disciplinary', icon: AlertTriangle, id: 'disciplinary', access: HR_ACCESS },
      ],
    },
    {
      title: 'Payroll',
      icon: FolderOpen,
      collapsible: true,
      defaultOpen: false,
      items: [
        { label: 'Payroll Enrolment', icon: Banknote, id: 'hr-pay-enrollment', route: '/hr/pay/enrollment', access: HR_ACCESS },
        { label: 'Pay Runs', icon: Banknote, id: 'hr-pay-runs', route: '/hr/pay/runs', access: HR_ACCESS },
        { label: 'Advances', icon: Banknote, id: 'hr-pay-advances', route: '/hr/pay/advances', access: HR_ACCESS },
        { label: 'Approvals', icon: Banknote, id: 'hr-pay-approvals', route: '/approvals', access: HR_ACCESS },
        { label: 'Payroll Config', icon: Banknote, id: 'hr-pay-config', route: '/hr/pay/config', access: HR_ACCESS },
      ],
    },
    {
      title: 'Reports',
      items: [
        { label: 'Submitted Reports', icon: FileText, id: 'submitted-reports', access: HR_ACCESS },
        { label: 'Report Archive', icon: Archive, id: 'report-archive', access: HR_ACCESS },
        { label: 'Platform Sales Officers', icon: Users, id: 'hr-pso-report', route: '/hr/reports/platform-sales-officers', access: HR_ACCESS },
        { label: 'Engineering Contribution', icon: Code, id: 'hr-engineering-contribution', route: '/hr/engineering/contribution' },
        { label: 'My Contribution', icon: ClipboardList, id: 'me-contribution', route: '/me/contribution' },
        { label: 'Portfolio Performance', icon: BarChart3, id: 'hr-portfolio-performance', route: '/hr/reports/tenant-portfolio-performance', access: HR_ACCESS },
      ],
    },
    {
      title: 'Performance',
      icon: TrendingUp,
      collapsible: true,
      defaultOpen: false,
      items: [
        { label: 'Executive Brief', icon: Gauge, id: 'hr-executive-brief', route: '/hr/dashboard/executive-brief', access: HR_ACCESS },
        { label: 'Productivity', icon: TrendingUp, id: 'hr-productivity', route: '/hr/dashboard/productivity', access: HR_ACCESS },
        { label: 'Tasks', icon: ClipboardList, id: 'hr-tasks', route: '/hr/dashboard/tasks', access: HR_ACCESS },
        { label: 'Metric Definitions', icon: Gauge, id: 'hr-metrics', route: '/hr/dashboard/metrics', access: HR_ACCESS },
      ],
    },

    {
      title: 'Administration',
      icon: Shield,
      collapsible: true,
      defaultOpen: false,
      items: [
        { label: 'Requisitions', icon: ClipboardList, id: 'requisitions', access: HR_ACCESS },
        { label: 'Platform Users', icon: UserCog, id: 'user-management', route: '/platform-users', access: HR_ACCESS },
        { label: 'Audit Trail', icon: FileText, id: 'audit', access: HR_ACCESS },
        { label: 'Approval History', icon: History, id: 'approval-history', access: HR_ACCESS },
      ],
    },
  ],
  super_admin: [
    {
      title: 'Administration',
      items: [
        { label: 'Dashboard Access', icon: LayoutDashboard, id: 'access-panel' },
        { label: 'User Management', icon: Users, id: 'users' },
        { label: 'Audit Log', icon: ClipboardList, id: 'audit' },
        { label: 'System Config', icon: Wrench, id: 'config' },
      ],
    },
  ],
  manager: [
    {
      title: 'Administration',
      items: [
        { label: 'Dashboard Access', icon: LayoutDashboard, id: 'access-panel' },
        { label: 'User Management', icon: Users, id: 'users' },
        { label: 'Deposits', icon: Banknote, id: 'deposits' },
        { label: 'Financial Ops', icon: Wallet, id: 'financial-ops' },
        { label: 'Portfolio Performance', icon: BarChart3, id: 'portfolio-performance', route: '/agent-ops/reports/tenant-portfolio-performance' },
        { label: 'Audit Log', icon: ClipboardList, id: 'audit' },
      ],
    },
  ],
};

/** Map role to its dedicated route */
export const roleDashboardRoutes: Partial<Record<AppRole, string>> = {
  cto: '/cto/dashboard',
  cfo: '/cfo/dashboard',
  coo: '/coo/dashboard',
  cmo: '/cmo/dashboard',
  crm: '/crm/dashboard',
  ceo: '/ceo/dashboard',
  hr: '/hr/dashboard',
  operations: '/operations',
  manager: '/admin/dashboard',
  super_admin: '/admin/dashboard',
  employee: '/admin/dashboard',
};

/** Roles that get redirected away from /dashboard to their isolated environment */
export const ISOLATED_ROLES: AppRole[] = [
  'cto', 'cfo', 'coo', 'cmo', 'crm', 'ceo', 'hr', 'operations',
  'manager', 'super_admin', 'employee',
];

/** Role display names */
export const roleLabels: Record<AppRole, string> = {
  tenant: 'Tenant',
  agent: 'Agent',
  landlord: 'Landlord',
  supporter: 'Supporter',
  manager: 'Manager',
  ceo: 'CEO',
  coo: 'COO',
  cfo: 'CFO',
  cto: 'CTO',
  cmo: 'CMO',
  crm: 'CRM',
  employee: 'Employee',
  hr: 'HR',
  operations: 'Operations',
  super_admin: 'Super Admin',
  access_admin: 'Access Admin',
};

/**
 * Sidebar item ids that surface Partner Operations health. When the
 * `partner_ops_scoreboard` RPC reports one or more leads in the `red` state,
 * the layout paints a red left edge + count badge on these items.
 *
 * Purely presentational — routes, ids, access and ordering are untouched.
 */
export const PARTNER_OPS_ATTENTION_ITEM_IDS: string[] = [
  'partners',
  'reports-partner-ops',
  'staff-performance',
  'hr-executive-brief',
];
