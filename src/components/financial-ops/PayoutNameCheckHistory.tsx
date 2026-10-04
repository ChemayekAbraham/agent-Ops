import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

export interface NameCheckLogInput {
  destinationId: string;
  subjectUserId: string | null;
  payoutTarget: string;
  network: string;
  checkedName: string;
  idName: string;
  outcome: 'match' | 'partial' | 'different';
}

/** Append-only: every recorded name check is kept permanently. */
export async function logNameCheck(input: NameCheckLogInput) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Not signed in');
  const { error } = await supabase.from('payout_name_check_log').insert({
    destination_id: input.destinationId,
    subject_user_id: input.subjectUserId,
    payout_target: input.payoutTarget,
    network: input.network,
    checked_name: input.checkedName,
    id_name: input.idName,
    outcome: input.outcome,
    checked_by: auth.user.id,
  });
  if (error) throw error;
}

const OUTCOME_LABEL: Record<string, string> = {
  match: 'Same person',
  partial: 'Partly agrees',
  different: 'Different name',
};

export function nameCheckHistoryKey(destinationId: string) {
  return ['payout-name-check-log', destinationId];
}

export function PayoutNameCheckHistory({ destinationId }: { destinationId: string }) {
  const q = useQuery({
    queryKey: nameCheckHistoryKey(destinationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payout_name_check_log')
        .select('id, checked_name, network, payout_target, outcome, checked_by, checked_at')
        .eq('destination_id', destinationId)
        .order('checked_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const ids = [...new Set((data ?? []).map((r) => r.checked_by))];
      const names: Record<string, string> = {};
      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        (profs ?? []).forEach((p: { id: string; full_name: string | null }) => {
          names[p.id] = p.full_name || 'Staff member';
        });
      }
      return (data ?? []).map((r) => ({ ...r, checker: names[r.checked_by] || 'Staff member' }));
    },
  });

  const tone = (o: string) =>
    o === 'match' ? 'text-emerald-700 dark:text-emerald-400' : o === 'partial' ? 'text-amber-700 dark:text-amber-400' : 'text-destructive';

  return (
    <div className="mt-3 rounded-xl border border-border bg-background/60 p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
        <History className="h-3.5 w-3.5" aria-hidden="true" /> Verification history
      </p>
      {q.isLoading ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="mt-2 text-xs text-destructive">{(q.error as Error).message}</p>
      ) : !q.data?.length ? (
        <p className="mt-2 text-xs text-muted-foreground">No name checks recorded yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {q.data.map((r) => (
            <li key={r.id} className="py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <span className="break-words font-bold text-foreground">{r.checked_name}</span>
                <span className={`shrink-0 font-bold uppercase tracking-wide ${tone(r.outcome)}`}>
                  {OUTCOME_LABEL[r.outcome] ?? r.outcome}
                </span>
              </div>
              <p className="mt-0.5 text-muted-foreground">
                {r.network ? `${r.network} · ` : ''}
                {r.payout_target || '—'}
              </p>
              <p className="text-muted-foreground">
                {r.checker} · {new Date(r.checked_at).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
