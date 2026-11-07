import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';

/**
 * IN / OUT for one desk, from `desk_flow(p_desk)`: four rolling windows from
 * now (today = last 24 h, 7 d, 90 d, all time). IN = requests that arrived at
 * the desk; OUT = requests that left it (forwarded, returned or rejected). On
 * the Funders board and the command centre OUT means funded. Not in the
 * generated Supabase types, so it goes through the `rpc` cast. Read-only.
 */

export type FlowPeriod = {
  in_n: number | null;
  in_ugx: number | null;
  out_n: number | null;
  out_ugx: number | null;
  forwarded_n: number | null;
  returned_n: number | null;
  rejected_n: number | null;
};

export type FlowPeriodKey = 'today' | '7d' | '90d' | 'all';

export type DeskFlow = {
  desk: string | null;
  generated_at: string | null;
  periods: Partial<Record<FlowPeriodKey, FlowPeriod | null>> | null;
  note: string | null;
};

/** In the sketch's order. */
export const FLOW_PERIODS: { key: FlowPeriodKey; label: string }[] = [
  { key: 'today', label: 'Today (24 h)' },
  { key: '7d', label: '7 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
];

/** The desks `desk_flow` knows. Customer Care and the Ontology desk have no stage, so no panel. */
export const FLOW_DESKS = new Set(['service-centre', 'agent-ops', 'tenant-ops', 'landlord-ops', 'coo', 'cfo', 'funders', 'partner-ops', 'command']);

export function useDeskFlow(deskId: string | null) {
  return useQuery({
    queryKey: ['desk-feed', 'desk-flow', deskId],
    enabled: !!deskId && FLOW_DESKS.has(deskId),
    queryFn: async (): Promise<DeskFlow> => {
      const { data, error } = await rpc('desk_flow', { p_desk: deskId });
      if (error) throw error;
      return data as DeskFlow;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/* ───────────────────────── pure helpers (tested) ───────────────────────── */

const num = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** "1,234", or "—" when the figure is missing. */
export function countText(v: number | null | undefined): string {
  const n = num(v);
  return n === null ? '—' : Math.round(n).toLocaleString('en');
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });

/**
 * "4.2M", "22.5M", "512M" — three figures at most, so a value fits a phone's
 * quarter. The row is already labelled UGX, so the cell drops it; the full
 * figure is on hover and in the accessible name.
 */
export function ugxShort(v: number | null | undefined): string {
  const n = num(v);
  return n === null ? '—' : compact.format(n);
}

/** What OUT was made of: "7 forwarded · 1 returned · 1 rejected" ("funded" where OUT means funded). */
export function outBreakdown(p: FlowPeriod | null | undefined, deskId: string): string | null {
  if (!p) return null;
  if (deskId === 'command') return `${countText(p.out_n)} funded`;
  const fwd = deskId === 'cfo' || deskId === 'funders' || deskId === 'partner-ops' ? 'funded' : 'forwarded';
  return `${countText(p.forwarded_n)} ${fwd} · ${countText(p.returned_n)} returned · ${countText(p.rejected_n)} rejected`;
}

/** What IN and OUT mean on this desk, for the card's hint. */
export function flowHint(deskId: string): string {
  if (deskId === 'command') return 'IN = new requests · OUT = funded';
  if (deskId === 'cfo' || deskId === 'funders' || deskId === 'partner-ops') return 'IN = listed for funders · OUT = funded';
  return 'IN = arrived at this desk · OUT = left it';
}

/** Two across on a phone, four from md (600 px) — the sketch's 2×2 and 1×4. */
export function flowColumns(mdUp: boolean): 2 | 4 {
  return mdUp ? 4 : 2;
}
