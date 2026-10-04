import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_KEY = 'merchant_agent_ref';

/**
 * 1) Persist `?mref=<uuid>` from the URL into localStorage so it survives
 *    OAuth redirects and email-verification bounces.
 * 2) After sign-in, apply the referrer to the user's profile
 *    (`pending_merchant_agent = true`, `merchant_agent_referrer_id = mref`).
 * 3) Redirect any signed-in user with `pending_merchant_agent = true` to the
 *    Merchant Agent onboarding page (except for safe paths like /auth, /settings).
 *
 * The UGX 10,000 referral reward pool (UGX 4,000 direct / UGX 6,000 upline, or
 * the full UGX 10,000 to a root-level recruiter) is credited automatically by the
 * referral triggers once the invitee is active in `cashout_agents` AND has
 * processed their first payout with uploaded proof.
 */
export default function MerchantAgentReferralGate() {
  const { user, loading } = useAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [pending, setPending] = useState<boolean | null>(null);
  const applyOnceRef = useRef(false);

  // 1) Capture `mref` from URL into localStorage
  useEffect(() => {
    const mref = (params.get('mref') || '').trim();
    if (mref && UUID_RX.test(mref)) {
      try { localStorage.setItem(STORAGE_KEY, mref); } catch { /* ignore */ }
      const next = new URLSearchParams(params);
      next.delete('mref');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  // 2 + 3) After sign-in, apply referral + read pending status
  useEffect(() => {
    if (loading || !user?.id) { setPending(null); return; }
    let cancelled = false;

    (async () => {
      let mref: string | null = null;
      try { mref = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }

      if (mref && UUID_RX.test(mref) && mref !== user.id && !applyOnceRef.current) {
        applyOnceRef.current = true;
        const { error } = await supabase
          .from('profiles')
          .update({
            pending_merchant_agent: true,
            merchant_agent_referrer_id: mref,
          })
          .eq('id', user.id)
          .is('merchant_agent_referrer_id', null); // never overwrite existing referrer
        if (!error) {
          try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        }

        // Auto-activate as a Merchant Agent so they land on the Merchant
        // Agent dashboard immediately (not the standard Agent dashboard).
        // The RPC verifies the referrer is a real active merchant agent,
        // creates an active cashout_agents row, grants the 'agent' role,
        // and clears pending_merchant_agent. Idempotent.
        try {
          await supabase.rpc('auto_activate_merchant_referral', {
            p_referrer: mref,
          });
        } catch (rpcErr) {
          console.warn('[MerchantAgentReferralGate] auto-activate failed', rpcErr);
        }
      }

      const { data } = await supabase
        .from('profiles')
        .select('pending_merchant_agent')
        .eq('id', user.id)
        .maybeSingle();
      if (!cancelled) setPending(!!data?.pending_merchant_agent);
    })();

    return () => { cancelled = true; };
  }, [user?.id, loading]);

  // Redirect pending merchant-agents to onboarding
  useEffect(() => {
    if (!pending) return;
    const p = location.pathname;
    const safe =
      p.startsWith('/merchant-agent/onboarding') ||
      p.startsWith('/settings') ||
      p.startsWith('/auth') ||
      p.startsWith('/logout') ||
      p.startsWith('/unsubscribe') ||
      p.startsWith('/stop-sms') ||
      p.startsWith('/r/') ||
      p.startsWith('/receipt/');
    if (!safe) navigate('/merchant-agent/onboarding', { replace: true });
  }, [pending, location.pathname, navigate]);

  return null;
}