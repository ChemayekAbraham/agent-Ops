/**
 * Shared definitions for the monthly Mission & Goals system.
 *
 * The CEO authors a mission + goals per dashboard, per month. Every operator
 * and executive dashboard then surfaces the active mission for its own role,
 * falling back to a company-wide "all" mission when no role-specific one exists.
 */

export interface DashboardMissionTarget {
  /** Stored value in dashboard_missions.dashboard_role */
  key: string;
  label: string;
  /** Short helper describing who sees it */
  audience: string;
}

/** Company-wide fallback key. */
export const MISSION_ALL_KEY = 'all';

/**
 * Dashboards the CEO can target. The executive keys (ceo, coo, cfo, ...) match
 * the `role` prop passed to ExecutiveDashboardLayout; the operator keys match
 * the role used by the operator dashboards.
 */
export const MISSION_DASHBOARDS: DashboardMissionTarget[] = [
  { key: MISSION_ALL_KEY, label: 'Company-wide (all dashboards)', audience: 'Everyone — used as a fallback when a dashboard has no specific mission' },
  { key: 'ceo', label: 'CEO', audience: 'Chief Executive' },
  { key: 'coo', label: 'COO', audience: 'Operations leadership' },
  { key: 'cfo', label: 'CFO', audience: 'Finance leadership' },
  { key: 'cto', label: 'CTO', audience: 'Technology leadership' },
  { key: 'cmo', label: 'CMO', audience: 'Marketing leadership' },
  { key: 'crm', label: 'CRM', audience: 'Customer relations team' },
  { key: 'hr', label: 'HR', audience: 'People & culture team' },
  { key: 'operations', label: 'Operations', audience: 'Operations staff' },
  { key: 'manager', label: 'Manager / Admin', audience: 'Managers & admins' },
  { key: 'ops-all', label: 'All Ops Dashboards', audience: 'Every operations dashboard — fallback for ops teams' },
  { key: 'agent-ops', label: 'Agents Ops', audience: 'Agent operations team' },
  { key: 'tenant-ops', label: 'Tenants Ops', audience: 'Tenant operations team' },
  { key: 'landlord-ops', label: 'Landlord Ops', audience: 'Landlord operations team' },
  { key: 'partners-ops', label: 'Partners Ops', audience: 'Partner operations team' },
  { key: 'company-staff', label: 'Company Staff', audience: 'All company staff' },
  { key: 'agent', label: 'Agent', audience: 'Field agents' },
  { key: 'tenant', label: 'Tenant', audience: 'Tenants' },
  { key: 'landlord', label: 'Landlord', audience: 'Landlords' },
  { key: 'supporter', label: 'Supporter', audience: 'Supporters / partners' },
];

export function missionDashboardLabel(key: string): string {
  return MISSION_DASHBOARDS.find((d) => d.key === key)?.label ?? key;
}

/**
 * Dashboards the CEO is NOT allowed to author missions for. These end-user /
 * field dashboards never display a mission (not even the company-wide fallback).
 */
export const MISSION_RESTRICTED_DASHBOARDS = ['agent', 'tenant', 'landlord', 'supporter'] as const;

export function isMissionRestricted(key: string): boolean {
  return (MISSION_RESTRICTED_DASHBOARDS as readonly string[]).includes(key);
}

/** Dashboards the CEO can actually target in the editor. */
export const MISSION_EDITABLE_DASHBOARDS: DashboardMissionTarget[] = MISSION_DASHBOARDS.filter(
  (d) => !isMissionRestricted(d.key),
);

/**
 * Font choices the CEO can apply to the mission statement. The `stack` is the
 * CSS font-family value applied inline to the mission text.
 */
export interface MissionFontOption {
  key: string;
  label: string;
  stack: string;
}

export const MISSION_DEFAULT_FONT = 'default';

export const MISSION_FONTS: MissionFontOption[] = [
  { key: 'default', label: 'Default (Plus Jakarta Sans)', stack: "'Plus Jakarta Sans', system-ui, sans-serif" },
  { key: 'dm-sans', label: 'DM Sans (clean)', stack: "'DM Sans', system-ui, sans-serif" },
  { key: 'serif', label: 'Serif (classic)', stack: "Georgia, 'Times New Roman', serif" },
  { key: 'mono', label: 'Monospace (technical)', stack: "'Courier New', ui-monospace, monospace" },
  { key: 'system', label: 'System (native)', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
];

/** Always returns a valid CSS font-family stack, falling back to the default
 *  when the key is missing, null, or unrecognized so the banner never breaks. */
export function missionFontStack(key: string | null | undefined): string {
  const fallback = MISSION_FONTS.find((f) => f.key === MISSION_DEFAULT_FONT)!.stack;
  if (!key) return fallback;
  return MISSION_FONTS.find((f) => f.key === key)?.stack ?? fallback;
}

/** First day of a month as `YYYY-MM-01` (local time). */
export function monthKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** First day of the month after the given month key (or today). */
export function nextMonthKey(fromKey?: string): string {
  let base: Date;
  if (fromKey) {
    const [y, m] = fromKey.split('-').map(Number);
    base = new Date(y, (m - 1) + 1, 1);
  } else {
    const now = new Date();
    base = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  return monthKey(base);
}

/** Human label for a `YYYY-MM-01` month key, e.g. "June 2026". */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Build a list of selectable months (current + previous/next few). */
export function buildMonthOptions(back = 2, forward = 3): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = -back; i <= forward; i++) {
    out.push(monthKey(new Date(now.getFullYear(), now.getMonth() + i, 1)));
  }
  return out;
}

export interface DashboardMission {
  id: string;
  dashboard_role: string;
  period_month: string;
  mission: string | null;
  goals: string[];
  is_active: boolean;
  font_family: string | null;
  posted_by_name: string | null;
  updated_at: string;
}