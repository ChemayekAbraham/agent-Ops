import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface RentAccessLimitParams {
  paid_increment_ugx: number;
  missed_decrement_ugx: number;
  max_limit_ugx: number;
}

export const DEFAULT_RENT_ACCESS_LIMIT_PARAMS: RentAccessLimitParams = {
  paid_increment_ugx: 10_000,
  missed_decrement_ugx: 7_000,
  max_limit_ugx: 30_000_000,
};

const LS_KEY = 'rent_access_limit_params_v1';

function readLs(): RentAccessLimitParams | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (
      typeof p?.paid_increment_ugx === 'number' &&
      typeof p?.missed_decrement_ugx === 'number' &&
      typeof p?.max_limit_ugx === 'number'
    ) return p as RentAccessLimitParams;
    return null;
  } catch { return null; }
}

function writeLs(p: RentAccessLimitParams) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export function useRentAccessLimitParams() {
  const [params, setParams] = useState<RentAccessLimitParams>(
    () => readLs() ?? DEFAULT_RENT_ACCESS_LIMIT_PARAMS,
  );
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', 'rent_access_limit_params')
        .maybeSingle();
      const v = (data?.value ?? null) as Partial<RentAccessLimitParams> | null;
      if (v) {
        const merged: RentAccessLimitParams = {
          paid_increment_ugx: Number(v.paid_increment_ugx) || DEFAULT_RENT_ACCESS_LIMIT_PARAMS.paid_increment_ugx,
          missed_decrement_ugx: Number(v.missed_decrement_ugx) || DEFAULT_RENT_ACCESS_LIMIT_PARAMS.missed_decrement_ugx,
          max_limit_ugx: Number(v.max_limit_ugx) || DEFAULT_RENT_ACCESS_LIMIT_PARAMS.max_limit_ugx,
        };
        setParams(merged);
        writeLs(merged);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { params, loading, refresh };
}
