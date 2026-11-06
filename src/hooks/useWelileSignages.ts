import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { SignageRecord, SignageStatus, SIGNAGE_RATES } from '@/lib/welileSignages';
import { safeUUID } from '@/lib/safeUUID';
import { toast } from 'sonner';

// Legacy device-only cache. Read only for the one-time upload to the server; never written.
const STORAGE_KEY = 'welile:signages:local_cache';

/** Columns an agent may send when creating an application. Server sets reference, status fields and dates. */
const INSERT_COLUMNS = [
  'id', 'agent_id', 'agent_name', 'agent_phone',
  'property_name', 'property_type', 'business_category',
  'owner_full_name', 'owner_phone', 'owner_alt_phone', 'consenting_relation', 'permission_confirmed',
  'owner_payment_method', 'owner_payment_number', 'owner_payment_name',
  'gps_latitude', 'gps_longitude', 'gps_accuracy_meters', 'gps_captured_at',
  'district_name', 'county_name', 'sub_county_name', 'parish_name', 'village_name', 'plot_or_landmark',
  'foot_traffic', 'road_visibility', 'operating_hours', 'nearby_landmarks',
  'proposed_surface', 'proposed_dimensions', 'accessibility_notes', 'photos',
] as const;

const db = () => supabase as any;

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
  if (error && error.code !== '23505') throw new Error(error.message);
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
  const { user } = useAuth();
  useLegacySignageSync(user?.id);

  return useQuery({
    queryKey: ['welile-signages', 'my', user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<SignageRecord[]> => {
      const { data, error } = await db()
        .from('welile_signages')
        .select('*')
        .eq('agent_id', user!.id)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as SignageRecord[];
    },
  });
}

export function useSignageOpsQueue() {
  return useQuery({
    queryKey: ['welile-signages', 'ops-queue'],
    queryFn: async (): Promise<SignageRecord[]> => {
      const { data, error } = await db()
        .from('welile_signages')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as SignageRecord[];
    },
  });
}

export function useSubmitSignage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: Omit<SignageRecord, 'id' | 'reference_no' | 'agent_id' | 'created_at' | 'updated_at' | 'status'>) => {
      if (!user?.id) throw new Error('You must be signed in to submit a signage.');
      if (!payload.gps_latitude || !payload.gps_longitude) {
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

export function useReviewSignage() {
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
      let targetStatus: SignageStatus = 'under_review';
      if (decision === 'approve') targetStatus = 'approved_for_installation';
      if (decision === 'return') targetStatus = 'changes_required';
      if (decision === 'reject') targetStatus = 'rejected';
      // reviewed_by / reviewed_at are stamped by the server.
      await updateSignage(signageId, {
        status: targetStatus,
        review_notes: notes || null,
        rejection_reason: rejectionReason || null,
      });
      return { signageId, targetStatus };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success('Signage review decision recorded.');
    },
    onError: (err: Error) => toast.error('Could not save the decision: ' + err.message),
  });
}

export function useVerifyInstallation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      signageId,
      installerName,
      installedAt,
      verificationNotes,
    }: {
      signageId: string;
      installerName: string;
      installedAt: string;
      verificationNotes?: string;
      photoUrl?: string;
    }) => {
      // verified_by / verified_at / activated_at are stamped by the server.
      await updateSignage(signageId, {
        status: 'active',
        installed_at: installedAt,
        installer_name: installerName,
        verification_notes: verificationNotes || null,
      });
      return { signageId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success(`Installation verified. Signage is now active (owner UGX ${SIGNAGE_RATES.OWNER_MONTHLY_UGX.toLocaleString()}/month).`);
    },
    onError: (err: Error) => toast.error('Could not mark installed: ' + err.message),
  });
}

/** Signage payouts are not connected to the payment process yet; nothing is ever marked paid here. */
export const SIGNAGE_PAYOUTS_AVAILABLE = false;

export function useCfoDisburseSignage() {
  return useMutation({
    mutationFn: async (_args: {
      signageId: string;
      payoutType: 'agent_reward' | 'owner_rent';
      transactionRef?: string;
      recipientPhone?: string;
      recipientName?: string;
      amountUgx: number;
    }): Promise<never> => {
      throw new Error('Signage payouts are coming soon. No payment was made.');
    },
    onError: (err: any) => toast.error(err.message),
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
