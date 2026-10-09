import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

const KEY = 'welile_lead_click';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** After a visitor who came through a Customer Leads link signs up or in, link that click to their account (once). */
export default function LeadClickClaimer() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user?.id) return;
    let saved: { id?: string; at?: number } | null = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
    if (!saved?.id || !saved.at || Date.now() - saved.at > MAX_AGE_MS) { localStorage.removeItem(KEY); return; }
    (supabase.rpc as any)('claim_lead_click', { p_click_id: saved.id })
      .then(({ error }: { error: unknown }) => { if (!error) localStorage.removeItem(KEY); });
  }, [user?.id]);
  return null;
}
