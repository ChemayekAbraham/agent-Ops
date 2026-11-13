import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';
import { PERIODS, type Period } from './cfoApi';

/**
 * The requests behind a Funders Dashboard headline number, from
 * `funders_headline_list(p_period, p_kind)` (rule E53b). Not in the generated
 * types, so it goes through the `rpc` cast. Read-only.
 *
 *   posted  — the COO put it on the funders' board in the period
 *   sold     — the tile is E93's: landlord PAID, OTP confirmed (funded_money_flow,
 *              releasesApi.ts); the server's own "sold" list here is not used
 *   selected — a funder selected it and the landlord is not yet paid (funded_money_flow)
 *   waiting  — the tile is posted minus (sold + selected); its list is the posted list
 *              without those requests
 */

export type HeadlineKind = 'posted' | 'sold' | 'selected' | 'waiting';

export const HEADLINE_KINDS: { kind: HeadlineKind; title: string; caption: string }[] = [
  { kind: 'posted', title: 'Rent requests posted', caption: "From the COO to the funders' board" },
  { kind: 'sold', title: 'Rent requests sold', caption: 'Landlord paid — OTP confirmed' },
  { kind: 'selected', title: 'Selected, waiting', caption: 'Funder selected, landlord not yet paid' },
  { kind: 'waiting', title: 'Waiting for funder', caption: 'Posted minus sold and selected' },
];

export type HeadlineListRow = {
  id: string;
  req: string;
  at: string | null;
  tenant: string;
  tenant_location: string | null;
  agent: string | null;
  landlord: string | null;
  landlord_phone: string | null;
  rent: number | null;
  posted_at: string | null;
  status: string | null;
  status_label: string | null;
  partner: string | null;
  partner_phone: string | null;
  released_at: string | null;
};

export type HeadlineList = {
  period: string;
  kind: HeadlineKind;
  count: number;
  ugx: number;
  rows: HeadlineListRow[];
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Tolerant: a missing field is null, never a crash. Rows keep the server's order (newest first). */
export function parseHeadlineList(data: unknown, period: Period, kind: HeadlineKind): HeadlineList {
  const d = (data ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(d.rows) ? (d.rows as Record<string, unknown>[]) : [];
  const rows: HeadlineListRow[] = raw.map((r) => {
    const id = String(r.id ?? '');
    return {
      id,
      req: str(r.req) ?? id.slice(0, 8),
      at: str(r.at),
      tenant: str(r.tenant) ?? '—',
      tenant_location: str(r.tenant_location),
      agent: str(r.agent),
      landlord: str(r.landlord),
      landlord_phone: str(r.landlord_phone),
      rent: num(r.rent),
      posted_at: str(r.posted_at),
      status: str(r.status),
      status_label: str(r.status_label) ?? str(r.status),
      partner: str(r.partner),
      partner_phone: str(r.partner_phone),
      released_at: str(r.released_at),
    };
  });
  return {
    period: str(d.period) ?? period,
    kind: (str(d.kind) as HeadlineKind | null) ?? kind,
    count: num(d.count) ?? rows.length,
    ugx: num(d.ugx) ?? 0,
    rows,
  };
}

export function useFundersHeadlineList(period: Period, kind: HeadlineKind | null) {
  return useQuery({
    queryKey: ['desk-feed', 'funders-headline-list', period, kind],
    enabled: kind !== null,
    queryFn: async (): Promise<HeadlineList> => {
      const { data, error } = await rpc('funders_headline_list', { p_period: period, p_kind: kind });
      if (error) throw error;
      return parseHeadlineList(data, period, kind as HeadlineKind);
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export const periodLabel = (p: string) => PERIODS.find((x) => x.value === p)?.label ?? p;

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });

/** "9 Nov 2026" in Kampala time; "—" when there is no date. */
export function dayText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '—' : DAY.format(t);
}
