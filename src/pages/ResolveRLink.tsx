import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import PayoutReceipt from './PayoutReceipt';
import LandlordRentReceipt from './LandlordRentReceipt';
import ScreenLoader from '@/components/common/ScreenLoader';
import type { LandlordReceiptData } from '@/lib/landlordReceiptPdf';

/**
 * Unified resolver for the shared `/r/:code` namespace. Recruiting / signup
 * short links, landlord rent-payment receipts and public payout-receipt tokens
 * all live under `/r/`. This dispatcher tries, in order: short link (redirect),
 * landlord rent receipt, then the payout receipt (which reads the same `code`
 * param as a token).
 */
export default function ResolveRLink() {
  const { code } = useParams<{ code: string }>();
  const [mode, setMode] = useState<'checking' | 'receipt' | 'landlord'>('checking');
  const [landlord, setLandlord] = useState<LandlordReceiptData | null>(null);

  useEffect(() => {
    if (!code) { setMode('receipt'); return; }
    let active = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .rpc('resolve_short_link', { p_code: code })
          .maybeSingle();
        if (!active) return;
        const target = data as { target_path?: string; target_params?: Record<string, string> | null } | null;
        if (!error && target?.target_path) {
          // Fire-and-forget click tracking — don't block the redirect. Same
          // call TrackedRedirect (/s/:code) makes; this /r/:code path is the
          // one createShortLink/useShortLink actually embed in SMS and email,
          // so it must record too or short_links.click_count stays at 0.
          try {
            await supabase.rpc('record_short_link_click', {
              p_code: code,
              p_user_agent: navigator.userAgent ?? null,
              p_referrer: document.referrer ?? null,
            });
          } catch {
            /* ignore tracking errors */
          }

          const params = new URLSearchParams();
          if (target.target_params) {
            Object.entries(target.target_params).forEach(([k, v]) => params.set(k, String(v)));
          }
          const qs = params.toString();
          const fullUrl = `${target.target_path}${qs ? `?${qs}` : ''}`;
          window.location.replace(`${window.location.origin}${fullUrl}`);
          return;
        }
      } catch {
        /* not a short link — fall through */
      }

      // Landlord rent-payment receipt codes are 10-char unguessable codes.
      try {
        const { data: rec } = await supabase.rpc('get_landlord_payout_receipt' as any, { p_code: code });
        if (!active) return;
        if (rec) {
          setLandlord(rec as unknown as LandlordReceiptData);
          setMode('landlord');
          return;
        }
      } catch {
        /* not a landlord receipt — fall through to the payout receipt view */
      }

      if (active) setMode('receipt');
    })();
    return () => { active = false; };
  }, [code]);

  if (mode === 'checking') {
    return (
      <ScreenLoader />
    );
  }

  if (mode === 'landlord') {
    return <LandlordRentReceipt preloaded={landlord} />;
  }

  return <PayoutReceipt />;
}
