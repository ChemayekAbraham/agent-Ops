import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PARTNER_RETURN_POLICY_QUERY_KEY, usePartnerReturnPolicy } from '@/hooks/usePartnerReturnPolicy';
import { usePartnerQuoteRate } from '@/hooks/usePartnerQuoteRate';
import { staffRateRequestFields } from '@/lib/staffPortfolioRate';

/**
 * The Returns-rate field of a staff portfolio form (design v2 §6.1, staff form contract). Wire it
 * in the form's data code only:
 *   const rate = useStaffPortfolioRate(partner?.id, '15');   // today's prefill, used only while off
 *   value={rate.value} onChange={e => rate.setValue(e.target.value)}
 *   const r = rate.requestFields(); if ('error' in r) { toast.error(r.error); return; }
 *   invoke(..., { body: { ...other, ...r.fields } });
 *   on error: if (await isPolicyChangedError(error)) { toast.error(POLICY_CHANGED_MESSAGE); rate.refetchPolicy(); }
 *
 * Prefill: switch seen OFF on a fresh network read -> `switchOffPrefill` (today's behaviour, always
 * sent). Switch on or unknown -> the partner's own rate (partner_quote_rate, blank when unknown),
 * sent only when staff edit the field.
 */
export function useStaffPortfolioRate(partnerId: string | null | undefined, switchOffPrefill: string | number | null = null) {
  const qc = useQueryClient();
  const policy = usePartnerReturnPolicy({ fresh: true });
  const { rate: personRate, isLoading: personRateLoading } = usePartnerQuoteRate('partner', partnerId ?? null);
  const switchOffSeen = policy.fromNetwork && policy.enabled === false;
  const [value, setRawValue] = useState('');
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    if (edited) return;
    const prefill = switchOffSeen ? switchOffPrefill : personRate;
    setRawValue(prefill === null || prefill === undefined ? '' : String(prefill));
  }, [edited, switchOffSeen, switchOffPrefill, personRate]);

  // A different partner is a different form: start from that partner's prefill again.
  useEffect(() => { setEdited(false); }, [partnerId]);

  const setValue = useCallback((v: string) => {
    setRawValue(v);
    setEdited(true);
  }, []);

  const reset = useCallback(() => setEdited(false), []);

  /** After a 409 POLICY_CHANGED: read the policy again (the typed value is kept for staff to check). */
  const refetchPolicy = useCallback(
    () => qc.invalidateQueries({ queryKey: PARTNER_RETURN_POLICY_QUERY_KEY }),
    [qc],
  );

  const requestFields = useCallback(
    () => staffRateRequestFields({ value, edited, policyEnabled: policy.enabled, policyFromNetwork: policy.fromNetwork }),
    [value, edited, policy.enabled, policy.fromNetwork],
  );

  return {
    value,
    setValue,
    edited,
    reset,
    requestFields,
    refetchPolicy,
    /** The partner's own rate for a new portfolio (null = unknown). */
    personRate,
    /** true = on, false = off, null = unknown (not yet read on this mount, or unreadable). */
    policyEnabled: policy.enabled,
    switchOffSeen,
    isLoading: policy.isLoading || personRateLoading,
  };
}
