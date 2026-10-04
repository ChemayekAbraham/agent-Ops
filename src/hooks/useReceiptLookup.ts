import { useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type ReceiptLookupResult =
  | { ok: false; error: string; message?: string }
  | { ok: true; found: false; query: string }
  | {
      ok: true;
      found: true;
      scope: 'basic';
      receipt_number: string;
      status: string;
      is_mine: boolean;
    }
  | {
      ok: true;
      found: true;
      scope: 'full';
      receipt_id: string;
      receipt_number: string;
      receipt_code: string;
      status: string;
      amount: number;
      landlord_id: string | null;
      tenant_id: string | null;
      agent_id: string | null;
      processed_by: string | null;
      landlord_phone: string | null;
      generated_at: string | null;
      sms_sent_at: string | null;
      sms_attempts: number | null;
      sms_last_error: string | null;
      snapshot: Record<string, unknown> | null;
      payout: {
        id: string;
        status: string;
        amount: number;
        provider_reference: string | null;
        disbursed_at: string | null;
      } | null;
    };

export const RECEIPT_LOOKUP_ERRORS: Record<string, string> = {
  not_authenticated: 'Please sign in again to search receipts.',
  query_too_short: 'Enter at least 4 characters of the receipt number.',
  rate_limited: 'Too many searches. Please wait a minute and try again.',
};

/**
 * Shared receipt-number lookup. Backed by `lookup_landlord_payout_receipt`,
 * which enforces the 5-searches-per-minute limit and decides how much
 * metadata the caller is allowed to see (full for CFO/FinOps/ops, existence
 * only for agents).
 */
export function useReceiptLookup() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReceiptLookupResult | null>(null);

  const reset = useCallback(() => {
    setQuery('');
    setResult(null);
    setLoading(false);
  }, []);

  const search = useCallback(async (raw?: string) => {
    const q = (raw ?? query).trim();
    if (q.length < 4) {
      setResult({ ok: false, error: 'query_too_short' });
      return null;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('lookup_landlord_payout_receipt', { p_query: q });
      if (error) throw error;
      const parsed = data as unknown as ReceiptLookupResult;
      setResult(parsed);
      return parsed;
    } catch (e) {
      const parsed: ReceiptLookupResult = {
        ok: false,
        error: 'lookup_failed',
        message: e instanceof Error ? e.message : 'Lookup failed. Try again.',
      };
      setResult(parsed);
      return parsed;
    } finally {
      setLoading(false);
    }
  }, [query]);

  const errorMessage =
    result && result.ok === false
      ? result.message || RECEIPT_LOOKUP_ERRORS[result.error] || 'Lookup failed. Try again.'
      : null;

  return { query, setQuery, loading, result, errorMessage, search, reset };
}
