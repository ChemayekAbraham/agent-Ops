import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RenewalAdvice, RenewalPreview } from '@/lib/renewalAdvice';

/** The server's advice for renewing a plan, for the number of days chosen (null = the plan's current days). */
export async function fetchRenewalAdvice(prevRequestId: string, days: number | null): Promise<RenewalAdvice> {
  const { data, error } = await supabase.rpc('get_renewal_advice', {
    p_prev_request_id: prevRequestId,
    ...(days !== null ? { p_new_days: days } : {}),
  });
  if (error) throw error;
  return data as unknown as RenewalAdvice;
}

/** The fees, total and daily payment the server will apply for a rent and days. Read-only. */
export async function fetchRenewalPreview(prevRequestId: string, rent: number, days: number | null): Promise<RenewalPreview> {
  const { data, error } = await supabase.rpc('preview_renewal_amount', {
    p_prev_request_id: prevRequestId,
    p_new_rent: rent,
    ...(days !== null ? { p_new_days: days } : {}),
  });
  if (error) throw error;
  return data as unknown as RenewalPreview;
}

interface Loaded<T> { data: T | null; loading: boolean; error: unknown }

/** Advice for the chosen days. Re-runs when the days change; a late answer for earlier days is ignored. */
export function useRenewalAdvice(prevRequestId: string | null, days: number | null, enabled: boolean) {
  const [state, setState] = useState<Loaded<RenewalAdvice>>({ data: null, loading: false, error: null });
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || !prevRequestId) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchRenewalAdvice(prevRequestId, days)
      .then((data) => { if (mine === seq.current) setState({ data, loading: false, error: null }); })
      .catch((error) => { if (mine === seq.current) setState((s) => ({ ...s, loading: false, error })); });
  }, [prevRequestId, days, enabled]);

  const reset = useCallback(() => { seq.current++; setState({ data: null, loading: false, error: null }); }, []);
  return { ...state, reset };
}

/** Debounced server preview of the amount typed. A late answer for an earlier amount is ignored. */
export function useRenewalPreview(
  prevRequestId: string | null,
  rent: number,
  days: number | null,
  enabled: boolean,
  delayMs = 400,
) {
  const [state, setState] = useState<Loaded<RenewalPreview>>({ data: null, loading: false, error: null });
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || !prevRequestId || days === null || !Number.isFinite(rent) || rent <= 0) {
      seq.current++;
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(() => {
      fetchRenewalPreview(prevRequestId, rent, days)
        .then((data) => { if (mine === seq.current) setState({ data, loading: false, error: null }); })
        .catch((error) => { if (mine === seq.current) setState((s) => ({ ...s, loading: false, error })); });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [prevRequestId, rent, days, enabled, delayMs]);

  const reset = useCallback(() => { seq.current++; setState({ data: null, loading: false, error: null }); }, []);
  return { ...state, reset };
}
