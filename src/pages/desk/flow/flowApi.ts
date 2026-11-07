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

/** Desks where OUT means funded: Funders (cfo), Partner Ops and the command centre. */
const fundedDesk = (deskId: string) => deskId === 'cfo' || deskId === 'funders' || deskId === 'partner-ops' || deskId === 'command';

/**
 * The two column headers: stage desks "In | Out"; Funders and Partner Ops
 * "Listed | Funded"; the command centre "New | Funded".
 */
export function flowWords(deskId: string): { in: string; out: string } {
  if (deskId === 'command') return { in: 'New', out: 'Funded' };
  if (fundedDesk(deskId)) return { in: 'Listed', out: 'Funded' };
  return { in: 'In', out: 'Out' };
}

/** What OUT was made of: "forwarded 7 · returned 1 · rejected 1"; "funded 9" where OUT means funded. */
export function outBreakdown(p: FlowPeriod | null | undefined, deskId: string): string | null {
  if (!p) return null;
  if (fundedDesk(deskId)) return `funded ${countText(p.out_n)}`;
  return `forwarded ${countText(p.forwarded_n)} · returned ${countText(p.returned_n)} · rejected ${countText(p.rejected_n)}`;
}

/** What the two columns mean on this desk, for the card's hint. */
export function flowHint(deskId: string): string {
  if (deskId === 'command') return 'New = new requests · Funded = funded';
  if (fundedDesk(deskId)) return 'Listed = listed for funders · Funded = funded';
  return 'In = arrived at this desk · Out = left it';
}

/** Two across on a phone, four from md (600 px) — the sketch's 2×2 and 1×4. */
export function flowColumns(mdUp: boolean): 2 | 4 {
  return mdUp ? 4 : 2;
}
