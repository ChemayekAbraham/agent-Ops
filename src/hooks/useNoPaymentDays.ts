import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  NO_PAYMENT_DAYS_PARAM,
  NO_PAYMENT_DEFAULT_DAYS,
  isValidNoPaymentDays,
  parseNoPaymentDays,
} from '@/lib/noPaymentDays';

/**
 * The staff-chosen "days without payment" number, kept in the URL (`?days=30`) so a link, a reload and the
 * back button keep it, and so the No Payment tab and the Weekly Performance tab agree. The default (20)
 * leaves the URL clean. Other URL parameters are left alone.
 */
export function useNoPaymentDays(): [number, (days: number) => void] {
  const [params, setParams] = useSearchParams();
  const days = parseNoPaymentDays(params.get(NO_PAYMENT_DAYS_PARAM));
  const setDays = useCallback(
    (next: number) => {
      if (!isValidNoPaymentDays(next)) return;
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (next === NO_PAYMENT_DEFAULT_DAYS) out.delete(NO_PAYMENT_DAYS_PARAM);
          else out.set(NO_PAYMENT_DAYS_PARAM, String(next));
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [days, setDays];
}
