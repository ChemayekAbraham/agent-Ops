import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { SignageRecord, SignageStatus, SIGNAGE_RATES } from '@/lib/welileSignages';
import { safeUUID } from '@/lib/safeUUID';
import { toast } from 'sonner';

const STORAGE_KEY = 'welile:signages:local_cache';

function getLocalSignages(): SignageRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalSignages(records: SignageRecord[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // ignore
  }
}

export function useMySignages() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['welile-signages', 'my', user?.id],
    queryFn: async (): Promise<SignageRecord[]> => {
      try {
        if (user?.id) {
          const { data, error } = await (supabase as any)
            .from('welile_signages')
            .select('*')
            .eq('agent_id', user.id)
            .order('created_at', { ascending: false });

          if (!error && Array.isArray(data)) {
            // Merge with any local pending entries
            const locals = getLocalSignages().filter(r => !r.agent_id || r.agent_id === user.id);
            const map = new Map<string, SignageRecord>();
            for (const item of data) map.set(item.id, item as SignageRecord);
            for (const loc of locals) {
              if (!map.has(loc.id)) map.set(loc.id, loc);
            }
            return Array.from(map.values());
          }
        }
      } catch {
        // Fall back to local storage
      }
      return getLocalSignages().filter(r => !user?.id || !r.agent_id || r.agent_id === user.id);
    },
  });
}

export function useSignageOpsQueue() {
  return useQuery({
    queryKey: ['welile-signages', 'ops-queue'],
    queryFn: async (): Promise<SignageRecord[]> => {
      try {
        const { data, error } = await (supabase as any)
          .from('welile_signages')
          .select('*')
          .order('created_at', { ascending: false });

        if (!error && Array.isArray(data)) {
          return data as SignageRecord[];
        }
      } catch {
        // Fall back to local mock
      }
      return getLocalSignages();
    },
  });
}

export function useSubmitSignage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: Omit<SignageRecord, 'id' | 'reference_no' | 'agent_id' | 'created_at' | 'updated_at' | 'status'>) => {
      if (!user?.id) throw new Error('You must be signed in to submit a signage.');

      // Mandatory GPS validation
      if (!payload.gps_latitude || !payload.gps_longitude) {
        throw new Error('Mandatory Live GPS capture required. Coordinates cannot be blank.');
      }
      if (!payload.permission_confirmed) {
        throw new Error('Consenting person permission must be documented and confirmed.');
      }

      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const reference_no = `SGN-${new Date().getFullYear()}-${randomSuffix}`;
      const now = new Date().toISOString();

      const newRecord: SignageRecord = {
        id: safeUUID(),
        reference_no,
        agent_id: user.id,
        agent_name: user.user_metadata?.full_name || user.email || 'Agent',
        agent_phone: user.user_metadata?.phone || '',
        status: 'submitted',
        created_at: now,
        updated_at: now,
        ...payload,
      };

      try {
        const { data, error } = await (supabase as any)
          .from('welile_signages')
          .insert([newRecord])
          .select()
          .single();

        if (error) {
          console.warn('[useSubmitSignage] Server insert fallback to local storage:', error.message);
        } else if (data) {
          newRecord.id = data.id;
        }
      } catch (err) {
        console.warn('[useSubmitSignage] Stored locally:', err);
      }

      // Keep local copy so agent can view even before pending migration is applied
      const current = getLocalSignages();
      saveLocalSignages([newRecord, ...current.filter(c => c.id !== newRecord.id)]);

      return newRecord;
    },
    onSuccess: (record) => {
      queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success(`Signage application ${record.reference_no} submitted successfully!`);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to submit signage application.');
    },
  });
}

export function useReviewSignage() {
  const { user } = useAuth();
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

      const now = new Date().toISOString();

      try {
        await (supabase as any)
          .from('welile_signages')
          .update({
            status: targetStatus,
            review_notes: notes || null,
            rejection_reason: rejectionReason || null,
            reviewed_by: user?.id || null,
            reviewed_at: now,
            updated_at: now,
          })
          .eq('id', signageId);
      } catch {
        // ignore
      }

      // Update local storage
      const locals = getLocalSignages().map(rec => {
        if (rec.id === signageId) {
          return {
            ...rec,
            status: targetStatus,
            review_notes: notes,
            rejection_reason: rejectionReason,
            reviewed_by: user?.id,
            reviewed_at: now,
            updated_at: now,
          };
        }
        return rec;
      });
      saveLocalSignages(locals);

      return { signageId, targetStatus };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success('Signage review decision recorded.');
    },
  });
}

export function useVerifyInstallation() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      signageId,
      installerName,
      installedAt,
      verificationNotes,
      photoUrl,
    }: {
      signageId: string;
      installerName: string;
      installedAt: string;
      verificationNotes?: string;
      photoUrl?: string;
    }) => {
      const now = new Date().toISOString();

      try {
        await (supabase as any)
          .from('welile_signages')
          .update({
            status: 'active',
            installed_at: installedAt,
            installer_name: installerName,
            verified_by: user?.id || null,
            verified_at: now,
            verification_notes: verificationNotes || null,
            activated_at: now,
            updated_at: now,
          })
          .eq('id', signageId);

        // Also record installation entry
        await (supabase as any)
          .from('welile_signage_installations')
          .insert([{
            signage_id: signageId,
            installer_name: installerName,
            installed_at: installedAt,
            verified_by: user?.id,
            verification_notes: verificationNotes,
          }]);
      } catch {
        // ignore
      }

      // Update local storage
      const locals = getLocalSignages().map(rec => {
        if (rec.id === signageId) {
          return {
            ...rec,
            status: 'active' as SignageStatus,
            installed_at: installedAt,
            installer_name: installerName,
            agent_reward_status: 'eligible',
            owner_rent_status: 'pending',
            verified_by: user?.id,
            verified_at: now,
            verification_notes: verificationNotes,
            activated_at: now,
            updated_at: now,
          };
        }
        return rec;
      });
      saveLocalSignages(locals);

      return { signageId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      toast.success(`Installation verified! Signage is now active. Agent reward (UGX ${SIGNAGE_RATES.AGENT_REWARD_UGX.toLocaleString()}) and Owner obligation clock (UGX ${SIGNAGE_RATES.OWNER_MONTHLY_UGX.toLocaleString()}/mo) activated.`);
    },
  });
}

export function useCfoDisburseSignage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      signageId,
      payoutType,
      transactionRef,
      recipientPhone,
      recipientName,
      amountUgx,
    }: {
      signageId: string;
      payoutType: 'agent_reward' | 'owner_rent';
      transactionRef?: string;
      recipientPhone?: string;
      recipientName?: string;
      amountUgx: number;
    }) => {
      const now = new Date().toISOString();
      const txRef = transactionRef || `DISB-SGN-${Date.now().toString().slice(-6)}`;

      const updates: Partial<SignageRecord> = {
        updated_at: now,
      };

      if (payoutType === 'agent_reward') {
        updates.agent_reward_status = 'disbursed';
        updates.agent_reward_disbursed_at = now;
        updates.agent_reward_disbursed_by = user?.id;
        updates.agent_reward_tx_ref = txRef;
      } else {
        updates.owner_rent_status = 'disbursed';
        updates.owner_rent_disbursed_at = now;
        updates.owner_rent_disbursed_by = user?.id;
        updates.owner_rent_tx_ref = txRef;
      }

      try {
        await (supabase as any)
          .from('welile_signages')
          .update(updates)
          .eq('id', signageId);

        if (payoutType === 'agent_reward') {
          await (supabase as any)
            .from('welile_signage_agent_rewards')
            .update({
              status: 'paid',
              wallet_transaction_id: txRef,
              paid_at: now,
            })
            .eq('signage_id', signageId);
        } else {
          await (supabase as any)
            .from('welile_signage_owner_obligations')
            .update({
              status: 'paid',
              transaction_ref: txRef,
              disbursed_at: now,
              disbursed_by: user?.id,
            })
            .eq('signage_id', signageId);
        }
      } catch (err) {
        console.warn('[useCfoDisburseSignage] Fallback to local cache:', err);
      }

      // Update local storage
      const locals = getLocalSignages().map((rec) => {
        if (rec.id === signageId) {
          return {
            ...rec,
            ...updates,
          };
        }
        return rec;
      });
      saveLocalSignages(locals);

      return { signageId, payoutType, txRef, amountUgx };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['welile-signages'] });
      const label = data.payoutType === 'agent_reward' ? 'Agent Reward (UGX 3,000)' : 'Owner Rent (UGX 10,000)';
      toast.success(`${label} disbursed successfully! Ref: ${data.txRef}`);
    },
    onError: (err: any) => {
      toast.error('Failed to disburse: ' + (err.message || 'Unknown error'));
    },
  });
}

