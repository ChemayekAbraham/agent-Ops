import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';

/**
 * Accountability: requests a person passed that a later desk found unfit,
 * from `desk_accountability(p_desk, p_days)`. `p_desk` null means every desk
 * (the command centre). Not in the generated Supabase types, so it goes
 * through the `rpc` cast in reviewApi.ts. Read-only.
 */

export type AccountabilityItem = {
  req: string | null;
  id: string | null;
  label: string | null;
  found_at: string | null;
  found_on: string | null;
};

export type AccountabilityRow = {
  stage: string | null;
  person_id: string | null;
  name: string | null;
  staff_ref: string | null;
  passed: number | null;
  flagged: number | null;
  rate: number | null;
  items: AccountabilityItem[] | null;
};

export type AccountabilityView = { rows: AccountabilityRow[] | null };

export const ACCOUNTABILITY_WINDOWS = [7, 30, 90] as const;
export type AccountabilityWindow = (typeof ACCOUNTABILITY_WINDOWS)[number];

export const EMPTY_ACCOUNTABILITY = 'No passed request has been found unfit yet.';

export function useAccountability(deskId: string | null, days: AccountabilityWindow, enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'desk-accountability', deskId ?? 'all', days],
    enabled,
    queryFn: async (): Promise<AccountabilityView> => {
      const { data, error } = await rpc('desk_accountability', { p_desk: deskId, p_days: days });
      if (error) throw error;
      return (data ?? { rows: [] }) as AccountabilityView;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/* ───────────────────────── pure helpers (tested) ───────────────────────── */

/** The server refused this caller: not a lead on this desk, nor COO/CEO. The fold hides itself. */
export function isDenied(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === '42501' || e.code === 'PGRST301' || e.code === '403') return true;
  return /42501|permission denied|not authori[sz]ed|forbidden|not allowed/i.test(String(e.message ?? ''));
}

/**
 * Share of passed requests later found unfit, as a fraction (0.1 = 10%).
 * Worked out from the two counts on the row, so the scale of `rate` never
 * matters; `rate` is only used when the counts are missing.
 */
export function unfitShare(r: Pick<AccountabilityRow, 'passed' | 'flagged' | 'rate'>): number | null {
  const passed = Number(r.passed ?? 0);
  if (passed > 0 && r.flagged !== null && r.flagged !== undefined) return Number(r.flagged) / passed;
  if (r.rate === null || r.rate === undefined || !Number.isFinite(Number(r.rate))) return null;
  const n = Number(r.rate);
  return n > 1 ? n / 100 : n;
}

/** Red from 10% up. */
export const RATE_RED_AT = 0.1;

export function rateTone(share: number | null): 'bad' | 'plain' | 'idle' {
  if (share === null) return 'idle';
  return share >= RATE_RED_AT - 1e-9 ? 'bad' : 'plain';
}

export function rateText(share: number | null): string {
  if (share === null) return '—';
  const p = share * 100;
  return `${p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}

/** Most found unfit first, then the highest share, then by name. */
export function sortAccountability(rows: AccountabilityRow[] | null | undefined): AccountabilityRow[] {
  return [...(rows ?? [])].sort(
    (a, b) =>
      Number(b.flagged ?? 0) - Number(a.flagged ?? 0) ||
      (unfitShare(b) ?? 0) - (unfitShare(a) ?? 0) ||
      String(a.name ?? '').localeCompare(String(b.name ?? '')),
  );
}

export const STAGE_ORDER = ['agent_app', 'service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'partner_ops', 'cfo'];

export const STAGE_NAME: Record<string, string> = {
  agent_app: 'Agent app',
  service_centre: 'Service Centre',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  coo: 'COO',
  partner_ops: 'Partner Ops',
  cfo: 'CFO',
  funders: 'Funders',
  funders_board: "Funders' board",
  customer_care: 'Customer Care',
};

/** "agent-ops" or "agent_ops" → "Agent Ops"; anything unknown is shown as sent. */
export function stageName(stage: string | null | undefined): string {
  const k = String(stage ?? '').replace(/-/g, '_');
  return STAGE_NAME[k] ?? (stage ? String(stage) : 'Unknown desk');
}

/** Rows grouped by stage in pipeline order; stages the order does not know come last. */
export function groupByStage(rows: AccountabilityRow[] | null | undefined): { stage: string; rows: AccountabilityRow[] }[] {
  const groups = new Map<string, AccountabilityRow[]>();
  for (const r of rows ?? []) {
    const k = String(r.stage ?? 'unknown').replace(/-/g, '_');
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const known = STAGE_ORDER.filter((s) => groups.has(s));
  const rest = [...groups.keys()].filter((k) => !STAGE_ORDER.includes(k)).sort();
  return [...known, ...rest].map((stage) => ({ stage, rows: sortAccountability(groups.get(stage)) }));
}
