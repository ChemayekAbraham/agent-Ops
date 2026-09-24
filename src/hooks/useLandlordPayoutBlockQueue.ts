import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Open, unclaimed landlord float payouts plus whether each one has been
 * allowed through the CTO "Block landlord payouts from queue" control.
 *
 * Reads `get_landlord_payout_block_queue()` and writes via
 * `set_landlord_payout_block_exemption()` (both SECURITY DEFINER, CTO / CFO /
 * super_admin only). An allowed row stays visible and claimable in the
 * Merchant Agent Payout Queue while the block is ON; every other landlord
 * row stays hidden. Never optimistic — re-fetches after each write.
 */
export interface LandlordPayoutBlockRow {
  withdrawal_id: string;
  landlord_payout_id: string;
  amount: number;
  created_at: string;
  status: string;
  landlord_name: string | null;
  landlord_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  mobile_money_number: string | null;
  mobile_money_name: string | null;
  payout_method: string | null;
  exempt_at: string | null;
  exempt_by: string | null;
  exempt_by_name: string | null;
}

export function useLandlordPayoutBlockQueue(enabled = true) {
  const [rows, setRows] = useState<LandlordPayoutBlockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await (supabase.rpc as any)('get_landlord_payout_block_queue');
    if (err) setError(err.message);
    else {
      setError(null);
      setRows((data ?? []) as LandlordPayoutBlockRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  /** Returns the number of rows actually changed, or throws. */
  const setAllowed = useCallback(
    async (withdrawalIds: string[], allow: boolean): Promise<number> => {
      if (!withdrawalIds.length) return 0;
      setSaving(true);
      try {
        const { data, error: err } = await (supabase.rpc as any)('set_landlord_payout_block_exemption', {
          p_withdrawal_ids: withdrawalIds,
          p_allow: allow,
        });
        if (err) throw new Error(err.message);
        return Number(data ?? 0);
      } finally {
        await load();
        setSaving(false);
      }
    },
    [load],
  );

  return { rows, loading, saving, error, reload: load, setAllowed };
}

export default useLandlordPayoutBlockQueue;
