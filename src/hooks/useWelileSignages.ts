import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { SignageRecord, SignageListRecord, SIGNAGE_RATES, signageReviewTarget, canReviewSignage, hasDeviceSignageGps, SignagePhoto } from '@/lib/welileSignages';
import { readStoredAuthSession, isSessionPastMaxAge } from '@/lib/sessionCache';
import { safeUUID } from '@/lib/safeUUID';
import { toast } from 'sonner';
import { withUserSession } from '@/lib/authenticatedRequests';

// Legacy device-only cache. Read only for the one-time upload to the server; never written.
const STORAGE_KEY = 'welile:signages:local_cache';

/** Columns an agent may send when creating an application. Server sets reference, status fields and dates. */
const INSERT_COLUMNS = [
  'id', 'agent_id', 'agent_name', 'agent_phone',
  'property_name', 'property_type', 'business_category',
  'owner_full_name', 'owner_phone', 'owner_alt_phone', 'consenting_relation', 'permission_confirmed',
  'owner_payment_method', 'owner_payment_number', 'owner_payment_name',
  'gps_latitude', 'gps_longitude', 'gps_accuracy_meters', 'gps_captured_at', 'gps_source',
  'district_name', 'county_name', 'sub_county_name', 'parish_name', 'village_name', 'plot_or_landmark',
  'foot_traffic', 'road_visibility', 'operating_hours', 'nearby_landmarks',
  'proposed_surface', 'proposed_dimensions', 'accessibility_notes', 'photos',
] as const;

const db = () => supabase as any;

// Explicit projection: never download base64 application/installation photos with a queue.
export const SIGNAGE_QUEUE_COLUMNS = 'id,reference_no,agent_id,agent_name,agent_phone,property_name,property_type,business_category,owner_full_name,owner_phone,owner_alt_phone,consenting_relation,permission_confirmed,owner_payment_method,owner_payment_number,owner_payment_name,gps_latitude,gps_longitude,gps_accuracy_meters,gps_captured_at,gps_source,repeat_owner_phone,district_name,county_name,sub_county_name,parish_name,village_name,plot_or_landmark,foot_traffic,road_visibility,operating_hours,nearby_landmarks,proposed_surface,proposed_dimensions,accessibility_notes,status,rejection_reason,review_notes,reviewed_by,reviewed_at,coo_approved_by,coo_approved_at,coo_review_notes,installed_at,installer_name,verified_by,verified_at,verification_notes,activated_at,removal_effective_at,agent_reward_status,agent_reward_disbursed_at,agent_reward_disbursed_by,agent_reward_tx_ref,owner_rent_status,owner_rent_disbursed_at,owner_rent_disbursed_by,owner_rent_tx_ref,created_at,updated_at';

function useSignageQueryUser() {
  const { user, session, loading } = useAuth();
  // A role/profile lookup need not hold up RLS-protected reads. Supabase still checks the JWT.
  const stored = loading && !session ? readStoredAuthSession() : null;
  const current = session ?? stored;
  if (!current?.access_token || isSessionPastMaxAge(current)
    || (current.expires_at ?? 0) <= Date.now() / 1000) return undefined;
  if (user && user.id !== current.user?.id) return undefined;
  return current.user?.id as string | undefined;
}

export function signageDetailQuery(userId: string | undefined, signageId: string | undefined) {
  return {
    queryKey: ['welile-signages', 'detail', userId, signageId],
    enabled: !!userId && !!signageId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SignageRecord> => {
      if (!userId || !signageId) throw new Error('Sign in and select an application.');
      const { data, error } = await db().from('welile_signages').select('*')
        .eq('id', signageId).abortSignal(signal).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error('This signage is unavailable or you cannot inspect it.');
      return data as SignageRecord;
    },
  };
}

export function useSignageDetail(signageId?: string) {
  return useQuery(signageDetailQuery(useSignageQueryUser(), signageId));
}

export function useLoadSignageDetail() {
  const userId = useSignageQueryUser();
  const queryClient = useQueryClient();
  return (signageId: string) => queryClient.fetchQuery(signageDetailQuery(userId, signageId));
}

function pickInsert(rec: Partial<SignageRecord>): Record<string, unknown> {
  const out: Record<string, unknown> = { status: 'submitted' };
  for (const k of INSERT_COLUMNS) {
    const v = (rec as any)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Insert by client id; a duplicate id means it was already saved, which counts as success. */
async function insertSignage(rec: Partial<SignageRecord>) {
  const { error } = await db().from('welile_signages').insert([pickInsert(rec)]);
  if (error && !(error.code === '23505' && error.message?.includes('welile_signages_pkey'))) {
    throw new Error(error.message?.includes('welile_signages_unique_gps')
      ? 'A signage application already exists at these GPS coordinates. Choose a different spot.' : error.message);
  }
}

function readLegacy(): SignageRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLegacy(records: SignageRecord[]) {
  try {
    if (records.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One-time upload of applications that were only ever saved on this device. */
function useLegacySignageSync(userId?: string) {
  const queryClient = useQueryClient();
  const ran = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || ran.current === userId) return;
    ran.current = userId;
    const all = readLegacy();
    const mine = all.filter((r) => !r.agent_id || r.agent_id === userId);
    if (!mine.length) return;
    (async () => {
      let synced = 0;
      const remaining = all.filter((r) => !mine.includes(r));
      for (const rec of mine) {
        try {
          await insertSignage({
            ...rec,
            id: rec.id && UUID_RE.test(rec.id) ? rec.id : safeUUID(),
            agent_id: userId,
          });
          synced++;
        } catch (e) {
          console.warn('[signage sync] kept on device:', e);
          remaining.push(rec);
        }
      }
      writeLegacy(remaining);
      if (synced) {
        toast.success(`${synced} signage application${synced === 1 ? '' : 's'} synced`);
        queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      }
    })();
  }, [userId, queryClient]);
}

export function useMySignages() {
  const userId = useSignageQueryUser();
  useLegacySignageSync(userId);

  return useQuery({
    queryKey: ['welile-signages', 'my', userId],
    enabled: !!userId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<SignageListRecord[]> => {
      if (!userId) return [];
      const { data, error } = await db()
        .from('welile_signages')
        .select(SIGNAGE_QUEUE_COLUMNS)
        .eq('agent_id', userId)
        .abortSignal(signal)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as SignageListRecord[];
    },
  });
}

export function useSignageOpsQueue() {
  const userId = useSignageQueryUser();
  return useQuery({
    queryKey: ['welile-signages', 'ops-queue', userId],
    enabled: !!userId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<SignageListRecord[]> => {
      const { data, error } = await db()
        .from('welile_signages')
        .select(SIGNAGE_QUEUE_COLUMNS)
        .abortSignal(signal)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as SignageListRecord[];
    },
  });
}

export function useSubmitSignage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: Omit<SignageRecord, 'id' | 'reference_no' | 'agent_id' | 'created_at' | 'updated_at' | 'status'>) => {
      if (!user?.id) throw new Error('You must be signed in to submit a signage.');
      if (!hasDeviceSignageGps(payload)) {
        throw new Error('Mandatory Live GPS capture required. Coordinates cannot be blank.');
      }
      if (!payload.permission_confirmed) {
        throw new Error('Consenting person permission must be documented and confirmed.');
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('You are offline. The application was not saved — reconnect and try again.');
      }

      const id = safeUUID();
      try {
        await insertSignage({
          ...payload,
          id,
          agent_id: user.id,
          agent_name: user.user_metadata?.full_name || user.email || 'Agent',
          agent_phone: user.user_metadata?.phone || '',
        });
      } catch (e: any) {
        throw new Error(`The application was not saved: ${e?.message || 'network error'}. Please try again.`);
      }
      const { data, error } = await db().from('welile_signages').select('*').eq('id', id).single();
      if (error || !data) throw new Error('The application could not be confirmed on the server. Please refresh.');
      return data as SignageRecord;
    },
    onSuccess: (record) => {
      queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success(`Signage application ${record.reference_no} submitted.`);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to submit signage application.');
    },
  });
}

async function updateSignage(signageId: string, updates: Record<string, unknown>) {
  const { data, error } = await db().from('welile_signages').update(updates).eq('id', signageId).select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('You are not allowed to change this application, or it no longer exists.');
}

export function useReviewSignage(stage: 'agent_ops' | 'coo' = 'agent_ops') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      signageId,
      decision,
      notes,
      rejectionReason,
    }: {
      signageId: string;
      decision: 'approve' | 'return' | 'reject';
      notes?: string;
      rejectionReason?: string;
    }) => {
      const targetStatus = signageReviewTarget(decision, stage);
      if (stage === 'coo') {
        const { data, error } = await db().rpc('coo_decide_signage', {
          p_signage_id: signageId, p_decision: decision,
          p_notes: (decision === 'reject' ? rejectionReason : notes) || null,
        });
        if (error) throw new Error(error.message);
        if (data?.status !== targetStatus) throw new Error('The decision could not be confirmed. Refresh the queue.');
        return { signageId, targetStatus };
      }
      // Read fresh state, then condition the write on it so a stale review cannot overwrite another decision.
      const { data: current, error: readError } = await db().from('welile_signages')
        .select('id,status').eq('id', signageId).maybeSingle();
      if (readError) throw new Error(readError.message);
      if (!current || !canReviewSignage(current.status, stage)) {
        throw new Error('This application is no longer pending Agent Ops review. Refresh the queue.');
      }
      // reviewed_by / reviewed_at are stamped by the server. Confirm the actual stored status.
      const { data: saved, error: saveError } = await db().from('welile_signages').update({
        status: targetStatus,
        review_notes: notes || null,
        rejection_reason: rejectionReason || null,
      }).eq('id', signageId).eq('status', current.status).select('id,status').maybeSingle();
      if (saveError) throw new Error(saveError.message);
      if (saved?.status !== targetStatus) throw new Error('The decision could not be confirmed. Refresh the queue.');
      return { signageId, targetStatus };
    },
    onSuccess: async ({ signageId, targetStatus }) => {
      queryClient.setQueriesData<SignageRecord[]>({ queryKey: ['welile-signages'] }, (records) =>
        Array.isArray(records) ? records.map((record) => record.id === signageId ? { ...record, status: targetStatus } : record) : records);
      await queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success(targetStatus === 'awaiting_coo'
        ? 'Awaiting COO. Sent to the COO for approval.'
        : stage === 'coo' && targetStatus === 'awaiting_cfo'
          ? 'COO approved. Sent to the CFO for disbursement.'
          : 'Signage review decision recorded.');
    },
    onError: (err: Error) => toast.error('Could not save the decision: ' + err.message),
  });
}

export function useResubmitSignage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ signageId, payload }: { signageId: string; payload: Partial<SignageRecord> }) => {
      if (!user?.id) throw new Error('Sign in to resubmit this application.');
      if (!hasDeviceSignageGps(payload as SignageRecord)) throw new Error('Capture real device GPS again before resubmitting.');
      const { data: current, error: readError } = await db().from('welile_signages').select('id,status')
        .eq('id', signageId).eq('agent_id', user.id).maybeSingle();
      if (readError) throw new Error(readError.message);
      if (current?.status !== 'changes_required') throw new Error('Only your Changes Required applications can be edited and resubmitted.');
      const updates = pickInsert(payload);
      delete updates.id;
      delete updates.agent_id;
      delete updates.agent_name;
      delete updates.agent_phone;
      const { data, error } = await db().from('welile_signages').update(updates).eq('id', signageId)
        .eq('agent_id', user.id).eq('status', 'changes_required').select('*').maybeSingle();
      if (error) throw new Error(error.message?.includes('welile_signages_unique_gps')
        ? 'A signage application already exists at these GPS coordinates.' : error.message);
      if (data?.status !== 'submitted') throw new Error('Resubmission could not be confirmed. Refresh the queue.');
      return data as SignageRecord;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success('Changes submitted to Agent Ops for review.');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

export const SIGNAGE_PAYOUTS_AVAILABLE = true;

export function useSignageCfoQueue() {
  const userId = useSignageQueryUser();
  return useQuery({
    queryKey: ['welile-signages', 'cfo-queue', userId], enabled: !!userId,
    staleTime: 60_000, gcTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<SignageListRecord[]> => {
      const { data, error } = await db().rpc('cfo_signages_queue').abortSignal(signal);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

export function useCfoDisburseSignage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      signageId: string;
      payoutType: 'agent_reward' | 'owner_rent';
      transactionRef?: string;
      recipientPhone?: string;
      recipientName?: string;
      amountUgx: number;
      periodIndex: number;
    }) => {
      const expected = args.payoutType === 'agent_reward' ? SIGNAGE_RATES.AGENT_REWARD_UGX : SIGNAGE_RATES.OWNER_MONTHLY_UGX;
      if (args.amountUgx !== expected) throw new Error('Incorrect signage payment amount.');
      const { data, error } = await withUserSession(() => db().rpc('cfo_disburse_signage', {
        p_signage_id: args.signageId, p_payout_type: args.payoutType, p_period_index: args.periodIndex,
      }));
      if (error) throw new Error(error.message);
      if (!data?.ledger_group_id || data.signage_id !== args.signageId || Number(data.amount_ugx) !== expected) {
        throw new Error('Payment could not be confirmed. Refresh before trying again.');
      }
      return data;
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success(data.already_paid ? 'This payment was already credited; no duplicate payment made.'
        : data.status === 'active' ? 'Payment credited to Welile wallet.'
          : 'Agent reward credited. Signage is awaiting CFO approval.');
    },
    onError: (err: any) => toast.error(err.message),
  });
}

export function useCfoApproveSignage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (signageId: string) => {
      const { data, error } = await withUserSession(() => db().rpc('cfo_approve_signage', { p_signage_id: signageId }));
      if (error) throw new Error(error.message);
      if (data?.signage_id !== signageId || data.status !== 'active') throw new Error('Approval could not be confirmed. Refresh before trying again.');
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success('CFO approved. Signage is Active; no owner payment was made.');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Agents cannot delete; this cancels a still-pending application. */
export function useDeleteSignage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (signageId: string) => {
      await updateSignage(signageId, { status: 'cancelled' });
      return signageId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success('Signage application cancelled.');
    },
    onError: (err: any) => toast.error('Could not cancel: ' + (err.message || 'Unknown error')),
  });
}
