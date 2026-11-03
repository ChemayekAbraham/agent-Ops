import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

type Demand = { id: string; message: string; response: string | null; responded_at: string | null };

/**
 * Data-driven management explanation demand. Shows only for users who have an
 * uncleared row in explanation_demands (RLS limits reads to their own row).
 */
export function ExplanationDemandOverlay() {
  const { user } = useAuth();
  const [demand, setDemand] = useState<Demand | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user?.id) { setDemand(null); return; }
    const { data } = await (supabase as any)
      .from('explanation_demands')
      .select('id, message, response, responded_at')
      .eq('user_id', user.id)
      .is('cleared_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setDemand((data as Demand) ?? null);
  }, [user?.id]);

  useEffect(() => { void load(); }, [load]);

  if (!demand) return null;

  if (demand.responded_at) {
    return createPortal(
      <div className="fixed inset-x-0 top-0 z-[2147483000] bg-red-700 px-4 py-2 text-center text-sm font-bold text-white shadow-lg">
        Explanation submitted — awaiting management review
      </div>,
      document.body,
    );
  }

  const submit = async () => {
    setError(null);
    if (text.trim().length < 10) { setError('Please write at least 10 characters.'); return; }
    setSaving(true);
    const { error: err } = await (supabase as any).rpc('submit_explanation', { p_id: demand.id, p_response: text.trim() });
    setSaving(false);
    if (err) { setError(err.message || 'Could not submit. Please try again.'); return; }
    await load();
  };

  return createPortal(
    <div role="alertdialog" aria-modal="true" aria-labelledby="explanation-demand-title"
      className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-red-700 p-6 text-white shadow-2xl ring-4 ring-red-500 sm:p-8">
        <h2 id="explanation-demand-title" className="text-2xl font-extrabold tracking-wide sm:text-4xl">
          URGENT: EXPLANATION REQUIRED
        </h2>
        <p className="mt-4 text-base font-bold leading-relaxed sm:text-lg">{demand.message}</p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="Write your explanation here…"
          className="mt-5 w-full rounded-lg border-2 border-white bg-white p-3 text-base text-red-950 placeholder:text-red-900/50 focus:outline-none"
        />
        {error ? <p className="mt-2 font-bold text-white">{error}</p> : null}
        <button type="button" onClick={submit} disabled={saving}
          className="mt-4 w-full rounded-lg bg-white px-5 py-3 text-lg font-extrabold text-red-700 disabled:opacity-60">
          {saving ? 'Submitting…' : 'Submit explanation'}
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default ExplanationDemandOverlay;
