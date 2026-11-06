import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';

/**
 * The ontology as the desks read it.
 *
 * `ontology_desk_view(p_days)` is the whole living document — counts, boards,
 * rules, the registries and what changed in the last `p_days` — and
 * `ontology_rules_for_desk(p_desk)` is the slice one desk works under. Neither
 * is in the generated Supabase types, so both go through the `rpc` cast in
 * reviewApi.ts. Read-only: nothing here writes.
 */

export type Automation = 'manual' | 'one_push' | 'auto' | 'guard';
export type Basis = 'decision' | 'assumption';

export type BoardFollow = {
  reviews_14d: number | null;
  followed_14d: number | null;
  rate: number | null;
  top_overrides: { reason_code: string; n: number }[] | null;
};

export type OntologyBoard = {
  ord: number;
  name: string;
  route: string | null;
  purpose: string | null;
  data_rpc: string | null;
  actions: string[] | null;
  owner_roles: string[] | null;
  status: string | null;
  notes: string | null;
  follow: BoardFollow | null;
};

export type OntologyRule = {
  rule_id: string;
  board: string | null;
  condition: string | null;
  decision: string | null;
  action: string | null;
  reason_code: string | null;
  automation: Automation | string | null;
  basis: Basis | string | null;
  owner: string | null;
  status: string | null;
  since_version: string | null;
  notes: string | null;
};

export type OntologyAssumption = { rule_id: string; board: string | null; owner: string | null; decision: string | null; notes: string | null };
export type OntologyObject = { name: string; family: string | null; sot: string | null; description: string | null; status: string | null; since_version: string | null };
export type OntologyLink = { name: string; from_object: string | null; to_object: string | null; via: string | null; meaning: string | null; status: string | null; since_version: string | null };
export type OntologyAction = {
  name: string;
  object_type: string | null;
  from_states: string[] | null;
  to_state: string | null;
  owner_desk: string | null;
  evidence_column: string | null;
  status: string | null;
  since_version: string | null;
};
export type OntologyReasonCode = { code: string; desks: string[] | null; meaning: string | null; requires_text: boolean | null; status: string | null };
export type OntologyJob = { ref: string; kind: string | null; owner: string | null; purpose: string | null; status: string | null };
export type OntologySwitch = { key: string; is_on: boolean | null; note: string | null; changed_at: string | null };

export type ChangeKind = 'add' | 'edit' | 'retire';
export type OntologyChange = { at: string | null; kind: ChangeKind | string | null; what: string | null; why: string | null; by: string | null };
export type LadderCandidate = { rule_id: string; board: string | null; from: string | null; to: string | null; follow_rate: number | null; reviews_14d: number | null };

export type OntologyView = {
  version: string | null;
  generated_at: string | null;
  days: number | null;
  counts: { objects: number; links: number; actions: number; boards: number; rules: number; assumptions: number } | null;
  boards: OntologyBoard[] | null;
  rules: OntologyRule[] | null;
  assumptions: OntologyAssumption[] | null;
  objects: OntologyObject[] | null;
  links: OntologyLink[] | null;
  actions: OntologyAction[] | null;
  reason_codes: OntologyReasonCode[] | null;
  jobs: OntologyJob[] | null;
  switches: OntologySwitch[] | null;
  week: {
    since: string | null;
    changes: OntologyChange[] | null;
    added: { kind: string; name: string }[] | null;
    retired: { kind: string; name: string; now: string | null }[] | null;
    ladder_candidates: LadderCandidate[] | null;
  } | null;
  document_md: string | null;
};

export type DeskRule = {
  rule_id: string;
  when: string | null;
  then: string | null;
  automation: Automation | string | null;
  basis: Basis | string | null;
  owner: string | null;
  notes: string | null;
  all_desks: boolean | null;
};

export type DeskRulesView = {
  desk: string;
  board: string | null;
  version: string | null;
  rules: DeskRule[] | null;
  changed_7d: { at: string | null; what: string | null; why: string | null }[] | null;
};

export const CHANGE_WINDOWS = [7, 30, 90] as const;
export type ChangeWindow = (typeof CHANGE_WINDOWS)[number];

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

/** The living document. Cached five minutes; a returning tab refetches once it is stale. */
export function useOntologyView(days: ChangeWindow) {
  return useQuery({
    queryKey: ['desk-feed', 'ontology-desk-view', days],
    queryFn: () => call<OntologyView>('ontology_desk_view', { p_days: days }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
    retry: 1,
  });
}

/** One desk's rules. Cached ten minutes; a returning tab refetches once it is stale. */
export function useDeskRules(deskId: string | null) {
  return useQuery({
    queryKey: ['desk-feed', 'ontology-rules-for-desk', deskId],
    enabled: !!deskId,
    queryFn: () => call<DeskRulesView>('ontology_rules_for_desk', { p_desk: deskId }),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/* ───────────────────────── pure helpers (tested) ───────────────────────── */

/** A rate as a whole percentage, whether the database sends 0.92 or 92. */
export function pctOf(rate: number | null | undefined): number | null {
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return null;
  const n = Number(rate);
  return Math.round(n <= 1 ? n * 100 : n);
}

/** "Follows the system: 92% of 140 reviews (14 days)", or "No reviews yet". */
export function followText(follow: BoardFollow | null | undefined): string {
  const reviews = Number(follow?.reviews_14d ?? 0);
  if (!follow || !reviews) return 'No reviews yet';
  const pct =
    follow.followed_14d !== null && follow.followed_14d !== undefined
      ? Math.round((Number(follow.followed_14d) / reviews) * 100)
      : pctOf(follow.rate);
  if (pct === null) return 'No reviews yet';
  return `Follows the system: ${pct}% of ${reviews.toLocaleString('en')} reviews (14 days)`;
}

/** "AO-3 → auto: 95% followed over 140 reviews". */
export function ladderText(c: LadderCandidate): string {
  const pct = pctOf(c.follow_rate);
  const reviews = Number(c.reviews_14d ?? 0).toLocaleString('en');
  return `${c.rule_id} → ${c.to ?? '—'}: ${pct === null ? '—' : `${pct}%`} followed over ${reviews} reviews`;
}

export const LADDER_EMPTY = 'No rule is ready yet — follow rates build as desks use their boards.';

/** "v0.9" from either "0.9" or "v0.9". */
export function versionLabel(version: string | null | undefined): string {
  const v = String(version ?? '').trim();
  if (!v) return '';
  return /^v/i.test(v) ? v : `v${v}`;
}

const KAMPALA = 'Africa/Kampala';

/** Today's date in Kampala as yyyy-mm-dd. */
export function kampalaDate(now: Date = new Date()): string {
  // en-CA formats as yyyy-mm-dd.
  return now.toLocaleDateString('en-CA', { timeZone: KAMPALA, year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** WELILE-ONTOLOGY-<version>-<yyyy-mm-dd>.md — the version kept as sent, made safe for a file name. */
export function downloadName(version: string | null | undefined, now: Date = new Date()): string {
  const v = String(version ?? '').trim().replace(/[^0-9A-Za-z._-]+/g, '-') || 'unversioned';
  return `WELILE-ONTOLOGY-${v}-${kampalaDate(now)}.md`;
}

/** "6 Nov, 14:05 EAT". */
export function eatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const day = d.toLocaleDateString('en-GB', { timeZone: KAMPALA, day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: KAMPALA, hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time} EAT`;
}

/** The desk's own rules first, in the order sent; rules that hold on every desk last. */
export function sortDeskRules(rules: DeskRule[] | null | undefined): DeskRule[] {
  const list = [...(rules ?? [])];
  return [...list.filter((r) => !r.all_desks), ...list.filter((r) => !!r.all_desks)];
}

/** Rules grouped by board, in pipeline order; rules on a board the view does not list come after. */
export function rulesByBoard(rules: OntologyRule[] | null | undefined, boards: OntologyBoard[] | null | undefined): { board: string; rules: OntologyRule[] }[] {
  const order = [...(boards ?? [])].sort((a, b) => a.ord - b.ord).map((b) => b.name);
  const groups = new Map<string, OntologyRule[]>();
  for (const r of rules ?? []) {
    const key = r.board ?? 'Unassigned';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const known = order.filter((name) => groups.has(name));
  const rest = [...groups.keys()].filter((k) => !order.includes(k));
  return [...known, ...rest].map((board) => ({ board, rules: groups.get(board) ?? [] }));
}

/** A row matches when any of its values contains the query, case-insensitively. */
export function rowMatches(row: Record<string, unknown>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return Object.values(row).some((v) => {
    if (v === null || v === undefined) return false;
    const s = Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.toLowerCase().includes(q);
  });
}
