import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { FB_REASONS, fetchBoardItems } from '@/lib/fundersBoard';
import { rpc } from '../reviewApi';
import type { ReviewSheet } from '../reviewTypes';
import { ugx } from './fundersView';

/**
 * Data behind the Funders Dashboard rows and their plan drawer.
 *
 *   funders_board_items     what funders see on their card: house, city, rent (+ fee via pay())
 *   pipeline_review_sheet   tenant / agent / landlord with phones, LC1, house photos;
 *                           when it refuses (a request at coo_approved belongs to no
 *                           desk, so only Command Centre / all-desk staff pass), the
 *                           same facts are read from the tables the CFO may read
 *   partner_self_plan_claims  the funder's pick (who, when)
 *
 * The one write is the recall (E86), and it goes through the funded_recall RPC.
 */

/** "Ref 1A2B3C4D": the first 8 of the request id, upper case. */
export const refText = (id: string) => `Ref ${String(id).slice(0, 8).toUpperCase()}`;

/* ───────────── what funders see (funders_board_items) ───────────── */

export type BoardFacts = {
  houseCategory: string | null;
  city: string | null;
  rentAmount: number;
  requestKind: string | null;
  incomplete: string[] | null;
};

export const BOARD_FACTS_KEY = ['desk-feed', 'funders-dashboard', 'board-facts'] as const;

export function useBoardFacts() {
  return useQuery({
    queryKey: BOARD_FACTS_KEY,
    queryFn: async (): Promise<Map<string, BoardFacts>> => {
      const { items } = await fetchBoardItems();
      return new Map(
        items.map((i) => [
          i.id,
          { houseCategory: i.houseCategory, city: i.city, rentAmount: i.rentAmount, requestKind: i.requestKind ?? null, incomplete: i.incomplete ?? null },
        ]),
      );
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

/** What the funder card shows: its amount is pay(rent), rent plus the fee (the plain rent while the fee is off). */
export function funderAmount(f: Pick<BoardFacts, 'rentAmount'>, pay: (rent: number) => number): number {
  return f.rentAmount > 0 ? pay(f.rentAmount) : f.rentAmount;
}

/** "Self-contained in Kampala · UGX 650,000", with the card's own fallbacks ("House", "Uganda"). */
export function funderLine(f: BoardFacts, pay: (rent: number) => number): string {
  return `${f.houseCategory ?? 'House'} in ${f.city ?? 'Uganda'} · ${ugx(funderAmount(f, pay))}`;
}

/* ───────────── the people (review sheet, else the tables) ───────────── */

type Person = { name: string | null; phone: string | null };
export type PlanPeople = {
  tenant: Person;
  agent: Person;
  landlord: Person & { verified: boolean | null };
  lc1: string | null;
  lcLetter: { bucket: string | null; path: string } | null;
  photos: string[];
  durationDays: number | null;
};

export function peopleFromSheet(sheet: ReviewSheet): PlanPeople {
  const r = sheet.request;
  return {
    tenant: { name: r.tenant?.name ?? null, phone: r.tenant?.phone ?? null },
    agent: { name: r.agent?.name ?? null, phone: r.agent?.phone ?? null },
    landlord: { name: r.landlord?.name ?? null, phone: r.landlord?.phone ?? null, verified: r.landlord?.verified ?? null },
    lc1: r.lc1?.name ?? null,
    lcLetter: r.lc_letter?.path ? { bucket: r.lc_letter.bucket ?? null, path: r.lc_letter.path } : null,
    photos: Array.isArray(r.house_photos) ? r.house_photos.filter((u) => typeof u === 'string' && !!u) : [],
    durationDays: r.duration_days ?? null,
  };
}

type Row = Record<string, unknown>;
type Res = { data: unknown; error: { message?: string } | null };
type Select = {
  eq: (c: string, v: unknown) => Select;
  in: (c: string, v: unknown[]) => Select;
  order: (c: string, o: { ascending: boolean }) => Select;
  limit: (n: number) => Select;
  maybeSingle: () => Promise<Res>;
  then: Promise<Res>['then'];
};
/** Plain reads on tables the generated types may not carry every column of. */
const read = (table: string, cols: string): Select =>
  (supabase as unknown as { from: (t: string) => { select: (c: string) => Select } }).from(table).select(cols);

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

async function peopleFromTables(requestId: string): Promise<PlanPeople> {
  const rr = await read(
    'rent_requests',
    'id, tenant_id, agent_id, assigned_agent_id, landlord_id, lc1_id, lc_letter_bucket, lc_letter_path, house_image_urls, duration_days',
  )
    .eq('id', requestId)
    .maybeSingle();
  if (rr.error) throw rr.error;
  const r = (rr.data ?? null) as Row | null;
  if (!r) throw new Error('This request could not be read.');
  const agentId = str(r.assigned_agent_id) ?? str(r.agent_id);
  const ids = [str(r.tenant_id), agentId].filter((x): x is string => !!x);
  const [profiles, landlord, lc1] = await Promise.all([
    ids.length ? read('profiles', 'id, full_name, phone').in('id', ids) : Promise.resolve({ data: [], error: null } as Res),
    str(r.landlord_id) ? read('landlords', 'id, name, phone, mobile_money_number, verified').eq('id', r.landlord_id).maybeSingle() : Promise.resolve({ data: null, error: null } as Res),
    str(r.lc1_id) ? read('lc1_chairpersons', 'id, name').eq('id', r.lc1_id).maybeSingle() : Promise.resolve({ data: null, error: null } as Res),
  ]);
  const byId = new Map(((profiles.data ?? []) as Row[]).map((p) => [String(p.id), p]));
  const person = (id: string | null): Person => {
    const p = id ? byId.get(id) : undefined;
    return { name: str(p?.full_name), phone: str(p?.phone) };
  };
  const l = (landlord.data ?? null) as Row | null;
  return {
    tenant: person(str(r.tenant_id)),
    agent: person(agentId),
    landlord: { name: str(l?.name), phone: str(l?.phone) ?? str(l?.mobile_money_number), verified: typeof l?.verified === 'boolean' ? l.verified : null },
    lc1: str(((lc1.data ?? null) as Row | null)?.name),
    lcLetter: str(r.lc_letter_path) ? { bucket: str(r.lc_letter_bucket), path: String(r.lc_letter_path) } : null,
    photos: Array.isArray(r.house_image_urls) ? (r.house_image_urls as unknown[]).filter((u): u is string => typeof u === 'string' && !!u) : [],
    durationDays: r.duration_days === null || r.duration_days === undefined ? null : Number(r.duration_days),
  };
}

export function usePlanPeople(requestId: string) {
  return useQuery({
    queryKey: ['desk-feed', 'funders-dashboard', 'plan-people', requestId],
    queryFn: async (): Promise<PlanPeople> => {
      const { data, error } = await rpc('pipeline_review_sheet', { p_request_id: requestId });
      if (!error && data) return peopleFromSheet(data as ReviewSheet);
      try {
        return await peopleFromTables(requestId);
      } catch {
        // Neither path could read it: the review sheet's own words.
        throw error ?? new Error('This request could not be read.');
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/* ───────────── the funder's pick ───────────── */

export type FunderPick = { who: string | null; status: 'held' | 'confirmed'; at: string | null; expiresAt: string | null };

/** A confirmed pick wins; else a hold that has not run out. */
export function pickFrom(claims: Row[], now = Date.now()): (Omit<FunderPick, 'who'> & { partnerId: string | null }) | null {
  const confirmed = claims.find((c) => c.status === 'confirmed');
  const held = claims.find((c) => c.status === 'held' && (!c.expires_at || Date.parse(String(c.expires_at)) > now));
  const c = confirmed ?? held;
  if (!c) return null;
  return {
    partnerId: str(c.partner_id),
    status: c.status === 'confirmed' ? 'confirmed' : 'held',
    at: str(c.status === 'confirmed' ? (c.confirmed_at ?? c.claimed_at) : c.claimed_at),
    expiresAt: str(c.expires_at),
  };
}

export function useFunderPick(requestId: string) {
  return useQuery({
    queryKey: ['desk-feed', 'funders-dashboard', 'funder-pick', requestId],
    queryFn: async (): Promise<FunderPick | null> => {
      const res = await read('partner_self_plan_claims', 'partner_id, status, claimed_at, confirmed_at, expires_at')
        .eq('rent_request_id', requestId)
        .in('status', ['held', 'confirmed'])
        .order('claimed_at', { ascending: false })
        .limit(10);
      if (res.error) throw res.error;
      const pick = pickFrom((res.data ?? []) as Row[]);
      if (!pick) return null;
      let who: string | null = null;
      if (pick.partnerId) {
        const p = await read('profiles', 'id, full_name').eq('id', pick.partnerId).maybeSingle();
        who = str(((p.data ?? null) as Row | null)?.full_name);
      }
      return { who, status: pick.status, at: pick.at, expiresAt: pick.expiresAt };
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });
}

/* ───────────── E86 recall of a funded tenant (funded_recall) ───────────── */

/** The five reasons, in the order the desk shows them; words from the funders board catalogue. */
export const RECALL_REASON_CODES = ['FB_PHOTOS_POOR', 'FB_DETAILS_WRONG', 'FB_NOT_QUALIFIED', 'FB_NOT_AVAILABLE', 'FB_DUPLICATE'] as const;
export type RecallReason = (typeof RECALL_REASON_CODES)[number];
export const RECALL_REASONS: { code: RecallReason; label: string }[] = RECALL_REASON_CODES.map((code) => ({
  code,
  label: FB_REASONS.find((r) => r.code === code)?.label ?? code,
}));

export const RECALL_LEVELS = [
  { value: 'board', label: 'Keep on funders board' },
  { value: 'coo', label: 'COO desk' },
  { value: 'landlord_ops', label: 'Landlord Ops' },
  { value: 'tenant_ops', label: 'Tenant Ops' },
  { value: 'agent_ops', label: 'Agent Ops' },
  { value: 'service_centre', label: 'Service Centre' },
  { value: 'reject', label: 'Reject' },
] as const;
export type RecallLevel = (typeof RECALL_LEVELS)[number]['value'];

export const RECALL_NOTE_MIN = 10;

/** Recall is offered only to staff the server lets demote, and only while the money is still with the agent. */
export const canRecall = (canDemote: boolean, stage: string | null | undefined) => canDemote && stage === 'with_agent';

export const recallNoteOk = (note: string) => note.trim().length >= RECALL_NOTE_MIN;

export function recallConfirmText(amount: number | null | undefined, agent: string | null | undefined, funder: string | null | undefined): string {
  return `Take ${ugx(amount)} back from ${agent || 'the agent'}'s landlord float and refund ${funder || 'the funder'}'s wallet?`;
}

/** Flat, so it narrows under the app's non-strict tsc config too. */
export type RecallOutcome = { ok: boolean; message?: string; floatRecalled: number; funderRefunded: number };

export const recallToastText = (o: { floatRecalled: number; funderRefunded: number }) =>
  `Recalled: ${ugx(o.floatRecalled)} back, funder refunded ${ugx(o.funderRefunded)}`;

/** funded_recall; a refusal comes back word for word (RECALL_LANDLORD_PAID, RECALL_REPAID, …). */
export async function recallFunded(requestId: string, reason: RecallReason, note: string, level: RecallLevel): Promise<RecallOutcome> {
  try {
    const { data, error } = await rpc('funded_recall', { p_rent_request_id: requestId, p_reason_code: reason, p_note: note.trim(), p_level: level });
    if (error) return { ok: false, message: String((error as { message?: string }).message || error), floatRecalled: 0, funderRefunded: 0 };
    const d = (data ?? {}) as Row;
    return { ok: true, floatRecalled: Number(d.float_recalled ?? 0), funderRefunded: Number(d.funder_refunded ?? 0) };
  } catch (e) {
    return { ok: false, message: String((e as { message?: string } | null)?.message ?? e), floatRecalled: 0, funderRefunded: 0 };
  }
}
