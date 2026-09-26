import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type RentAccessPromoSurface =
  | 'tenant_dashboard'
  | 'daily_payment_card'
  | 'repayment_dialog'
  | 'pay_rent_flow';

const kampalaDay = () =>
  new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

const seenKey = (surface: RentAccessPromoSurface) =>
  `welile-rent-access-promo-seen:${surface}:${kampalaDay()}`;

/**
 * Records how often tenants see and engage with the rent-access growth message.
 * Views are de-duplicated to one per surface per day per browser session so the
 * write volume stays bounded; clicks are always recorded.
 * Failures are silent by design — analytics must never break a payment screen.
 */
export function useRentAccessPromoTracking(surface: RentAccessPromoSurface) {
  const recordedView = useRef(false);

  const record = useCallback(
    (event: 'view' | 'click') => {
      void supabase.rpc('track_rent_access_promo', { p_surface: surface, p_event: event }).then(
        ({ error }) => {
          if (error) console.debug('rent-access promo tracking skipped:', error.message);
        },
      );
    },
    [surface],
  );

  useEffect(() => {
    if (recordedView.current) return;
    recordedView.current = true;
    try {
      const key = seenKey(surface);
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      // private mode / storage disabled — still record the view
    }
    record('view');
  }, [surface, record]);

  const trackClick = useCallback(() => record('click'), [record]);

  return { trackClick };
}

export default useRentAccessPromoTracking;
