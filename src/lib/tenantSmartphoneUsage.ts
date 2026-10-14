/**
 * Smartphone usage (Tenant Operations Workspace → Tenant Classification tab). Labels and light
 * presentation helpers only: every count comes from `tops_smartphone_usage` (read-only, staff-gated).
 * Nothing here decides what counts as a smartphone: `profiles.has_smartphone` is the answer captured
 * at sign-up, `profiles.smartphone_status` is what an agent, the call centre or a dashboard visit later
 * confirmed — the same three values `get_tenant_smartphone_overview` segments on.
 */
import { kampalaTodayYmd, kampalaYmd } from '@/lib/kampalaDays';

export interface TenantSmartphoneUsage {
  as_of: string;
  from_day: string;
  to_day: string;
  tenants: number;
  recorded_smartphone: number;
  recorded_without: number;
  confirmed_smartphone: number;
  confirmed_feature_phone: number;
  device_unknown: number;
  joined: number;
  joined_recorded_smartphone: number;
  checks: number;
  checks_smartphone: number;
  checks_feature_phone: number;
  seen_on_phone: number;
}

/** 59,063 */
export const fmtTenants = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('en-GB');

/**
 * The Kampala days a chosen range covers. The shared presets end a range at the local end of a day,
 * which is already tomorrow in Kampala (EAT is three hours ahead of UTC), so the end is clamped to
 * today and the start never lands after it. `tops_smartphone_usage` compares Kampala dates and
 * refuses a future day, so this is the only place a window is turned into days.
 */
export function kampalaWindow(start: Date, end: Date): { fromDay: string; toDay: string } {
  const today = kampalaTodayYmd();
  const toDay = (kampalaYmd(end) ?? today) > today ? today : (kampalaYmd(end) ?? today);
  const rawFrom = kampalaYmd(start) ?? toDay;
  return { fromDay: rawFrom > toDay ? toDay : rawFrom, toDay };
}

/** "of 59,063 tenants · 201 recorded without · 491 confirmed feature phone" */
export function recordedSmartphoneHint(u: TenantSmartphoneUsage): string {
  return [
    `of ${fmtTenants(u.tenants)} tenants`,
    `${fmtTenants(u.recorded_without)} recorded without`,
    `${fmtTenants(u.confirmed_feature_phone)} confirmed feature phone`,
    `${fmtTenants(u.confirmed_smartphone)} confirmed smartphone`,
  ].join(' · ');
}

/** "2 smartphones · 20 feature phones · 3 tenants seen opening the dashboard on a phone" */
export function windowChecksHint(u: TenantSmartphoneUsage): string {
  return [
    `${fmtTenants(u.checks_smartphone)} smartphone${u.checks_smartphone === 1 ? '' : 's'}`,
    `${fmtTenants(u.checks_feature_phone)} feature phone${u.checks_feature_phone === 1 ? '' : 's'}`,
    `${fmtTenants(u.seen_on_phone)} seen on a phone`,
  ].join(' · ');
}

/** "156 of 172 tenants who joined recorded as having a smartphone" */
export function joinedWindowHint(u: TenantSmartphoneUsage): string {
  if (u.joined === 0) return 'nobody joined in this period';
  return `${fmtTenants(u.joined_recorded_smartphone)} of ${fmtTenants(u.joined)} who joined recorded as having one`;
}
