import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  STAGE_STATUS,
  type ChecklistItem,
  type ReasonCode,
  type ReviewSheet,
  type Stage,
  type SuggestedAgent,
} from './reviewTypes';

/**
 * The E26 pipeline RPCs are not in the generated Supabase types yet (they are
 * added by the E26 migration, which has not been through `schema:accept-types`),
 * so every call goes through this cast — the same shape `useDeskFeed` uses.
 */
type RpcFn = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
export const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

/** A missing staff ID comes back as 42501 from every pipeline RPC. The desks say so in one sentence. */
export const NO_STAFF_ID = 'Needs an active employee account with a staff ID — contact HR.';

export function readableError(error: unknown): string {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return 'Something went wrong.';
  if (e.code === '42501') return NO_STAFF_ID;
  const msg = String(e.message ?? '');
  if (/42501/.test(msg) || /not authori[sz]ed/i.test(msg)) return NO_STAFF_ID;
  return msg || 'Something went wrong.';
}

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

/* ───────────────────────── request identity ─────────────────────────
 * The desk feeds show `req` — the first 8 characters of the request id —
 * because `desk_feed` was built before the review sheet existed, and the
 * review sheet needs the whole uuid.
 *
 * `pipeline_resolve_request(p_short)` turns one back into the other for any
 * desk viewer, `operations` included, and scopes the lookup to what the caller
 * may see. It is the only route used while it answers. The per-stage id list
 * below stays as a fall-back for when that RPC itself errors.
 */

export const AMBIGUOUS_MSG = 'Two requests share this code — open it from the COO or Partner Ops list';
export const NOT_FOUND_MSG = 'This request is no longer at this desk — refresh the table.';

export type Resolved =
  | { status: 'ok'; id: string }
  | { status: 'ambiguous' }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

async function idsAtStage(stage: Stage): Promise<string[]> {
  const status = STAGE_STATUS[stage];

  const direct = await supabase.from('rent_requests').select('id').eq('status', status).limit(2000);
  if (!direct.error && (direct.data?.length ?? 0) > 0) return (direct.data ?? []).map((r) => String(r.id));

  if (stage === 'service_centre') {
    // Defaults to the caller, so this returns the requests this manager is
    // assigned — which is exactly the set they are allowed to review anyway.
    const queue = await call<{ pending?: { id: string }[] } | null>('get_service_center_rent_queue', { p_manager_id: null });
    if (queue?.pending?.length) return queue.pending.map((r) => String(r.id));
  }
  if (stage === 'partner_ops' || stage === 'coo') {
    const page = await call<{ rows?: { id: string }[] } | null>('partner_ops_list_rent_requests', {
      p_status: status,
      p_search: null,
      p_limit: 500,
      p_offset: 0,
    });
    if (page?.rows?.length) return page.rows.map((r) => String(r.id));
  }
  if (stage === 'coo') {
    const plan = await call<{ rent_request_id: string }[] | null>('pipeline_coo_funding_plan');
    if (plan?.length) return plan.map((r) => String(r.rent_request_id));
  }

  if (direct.error) throw direct.error;
  return [];
}

/** The fall-back list, cached briefly so a run of rows does not refetch it. */
const stageIdCache = new Map<Stage, { at: number; ids: string[] }>();
const STAGE_CACHE_MS = 30_000;

async function cachedIdsAtStage(stage: Stage): Promise<string[]> {
  const hit = stageIdCache.get(stage);
  if (hit && Date.now() - hit.at < STAGE_CACHE_MS) return hit.ids;
  const ids = await idsAtStage(stage);
  stageIdCache.set(stage, { at: Date.now(), ids });
  return ids;
}

/**
 * The 8-character code a desk table prints, turned back into the request id.
 *
 * `pipeline_resolve_request` answers for every desk viewer and already counts
 * the matches, so an ambiguous code never opens anything — a review recorded
 * against the wrong tenant is the one failure worth refusing to risk. The
 * stage list is only consulted when that RPC errors, and it applies the same
 * rule: a clash resolves to ambiguous, not to a guess.
 */
export async function resolveShortId(short: string, stage: Stage): Promise<Resolved> {
  const code = short.trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(code)) return { status: 'not_found' };

  const { data, error } = await rpc('pipeline_resolve_request', { p_short: code });
  if (!error) {
    const r = data as { id?: string | null; matches?: number; status?: string } | null;
    if (r?.status === 'ok' && r.id) return { status: 'ok', id: String(r.id) };
    if (r?.status === 'ambiguous') return { status: 'ambiguous' };
    if (r?.status === 'not_found') return { status: 'not_found' };
  }

  try {
    const matches = (await cachedIdsAtStage(stage)).filter((id) => id.slice(0, 8).toLowerCase() === code);
    if (matches.length === 1) return { status: 'ok', id: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous' };
    return { status: 'not_found' };
  } catch (e) {
    return { status: 'error', message: readableError(error ?? e) };
  }
}

/* ───────────────────────── the sheet and its lists ───────────────────────── */

export function useReviewSheet(requestId: string | null) {
  return useQuery({
    queryKey: ['desk-feed', 'review-sheet', requestId],
    enabled: !!requestId,
    queryFn: () => call<ReviewSheet>('pipeline_review_sheet', { p_request_id: requestId }),
    staleTime: 10_000,
    retry: false,
  });
}

export function useReasonCodes() {
  return useQuery({
    queryKey: ['desk-feed', 'reason-codes'],
    queryFn: async (): Promise<ReasonCode[]> => {
      const { data, error } = await supabase
        .from('ontology_reason_codes')
        .select('code, desks, meaning, requires_text')
        .eq('status', 'active')
        .order('code');
      if (error) throw error;
      return (data ?? []) as unknown as ReasonCode[];
    },
    staleTime: 10 * 60_000,
  });
}

export function useSuggestedAgents(requestId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'suggest-agents', requestId],
    enabled: !!requestId && enabled,
    queryFn: () => call<SuggestedAgent[]>('pipeline_suggest_agents', { p_request_id: requestId, p_limit: 8 }),
    staleTime: 60_000,
  });
}

/** The verified proxy partners Partner Ops may attach, from the queue RPC that desk already uses. */
export function useProxyAgents(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'proxy-agents'],
    enabled,
    queryFn: async () => {
      const page = await call<{ proxy_agents?: { agent_user_id: string; full_name: string | null; phone: string | null }[] }>(
        'partner_ops_list_rent_requests',
        { p_status: 'landlord_ops_approved', p_search: null, p_limit: 1, p_offset: 0 },
      );
      return page?.proxy_agents ?? [];
    },
    staleTime: 5 * 60_000,
  });
}

export function useFundingPlan(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'coo-funding-plan'],
    enabled,
    queryFn: () => call<Record<string, unknown>[]>('pipeline_coo_funding_plan'),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useFunderBoardPreview(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'funder-board-preview'],
    enabled,
    queryFn: () => call<Record<string, unknown>[]>('pipeline_funder_board_preview'),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useDeskDaily(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'desk-daily'],
    enabled,
    queryFn: () => call<Record<string, unknown>[]>('pipeline_desk_daily', { p_date: null }),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useOverrides(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'overrides'],
    enabled,
    queryFn: () => call<Record<string, unknown>[]>('pipeline_overrides', { p_date: null }),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useSendBackReasons(days: number, enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'send-back-reasons', days],
    enabled,
    queryFn: () => call<Record<string, unknown>[]>('pipeline_send_back_reasons', { p_days: days, p_agent_id: null }),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * The reviewer's own staff ID for the desk header. `_pipeline_staff_ref` is an
 * internal helper with no grant, so this reads the one `hr_staff` row the
 * reviewer's own RLS policy already lets them see.
 */
export function useMyStaffRef() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['desk-feed', 'my-staff-ref', user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('hr_staff')
        .select('staff_ref')
        .eq('user_id', user?.id as string)
        .eq('active', true)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) return null;
      const row = (data ?? [])[0] as { staff_ref?: string | null } | undefined;
      return row?.staff_ref?.trim() || null;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** A short-lived signed URL for the LC1 letter. Returns null when the file has gone missing. */
export async function lcLetterUrl(bucket: string | null, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(bucket || 'rent-documents').createSignedUrl(path, 600);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/** Only the items for the desk being reviewed. */
export function stageChecklist(sheet: ReviewSheet | undefined, stage: Stage): ChecklistItem[] {
  return (sheet?.checklist ?? []).filter((c) => c.stage === stage);
}
