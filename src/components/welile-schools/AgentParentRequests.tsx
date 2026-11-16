import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageCircle, Phone, Receipt, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import { toIntlDigits, writeLockedSchool, type SchoolRow } from '@/lib/welileSchools';
import {
  AGENT_STATUS_LABEL, fetchAgentParentRequests, isOpenParentRequest, parentRequestErrorMessage, updateParentRequest,
  type ParentRequestRow, type ParentRequestStatus,
} from '@/lib/welileSchoolsParentRequests';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const TONE: Record<ParentRequestStatus, string> = {
  new: 'bg-primary text-primary-foreground',
  contacted: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  sent_to_welile: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  declined: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

/**
 * Parent requests routed to this agent: who asked, for which child at which school, and the steps
 * to take — call the parent, start the formal fee request at that school, or decline with a reason.
 */
export default function AgentParentRequests({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const queryKey = ['welile-agent-parent-requests', agentId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => {
      const rows = await fetchAgentParentRequests(agentId);
      const ids = [...new Set(rows.map((r) => r.school_id))];
      const { data: schools } = ids.length ? await db.from('welile_schools').select('*').in('id', ids) : { data: [] };
      return { rows, schools: (schools ?? []) as SchoolRow[] };
    },
    staleTime: 30_000,
  });
  const [showClosed, setShowClosed] = useState(false);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Not switched on yet (migration not applied) or nothing to show: stay out of the way.
  if (error || (!isLoading && !data?.rows.length)) return null;

  const rows = data?.rows ?? [];
  const open = rows.filter((r) => isOpenParentRequest(r.status));
  const closed = rows.filter((r) => !isOpenParentRequest(r.status));
  const shown = showClosed ? rows : open;
  const school = (id: string) => data?.schools.find((s) => s.id === id) ?? null;

  const move = async (r: ParentRequestRow, status: ParentRequestStatus, note?: string) => {
    setBusy(r.id);
    try {
      await updateParentRequest(r.id, status, note);
      toast.success(status === 'contacted' ? 'Marked as contacted' : status === 'sent_to_welile' ? 'Marked as sent to Welile' : 'Request declined');
      setDeclining(null); setReason('');
      qc.invalidateQueries({ queryKey });
    } catch (e) {
      toast.error('Could not update', { description: parentRequestErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  /** Open the School fees screen at this request's school. */
  const startFeeRequest = (r: ParentRequestRow) => {
    const s = school(r.school_id);
    if (!s) { toast.error('Could not open that school'); return; }
    writeLockedSchool(s);
    if (r.status === 'new') void updateParentRequest(r.id, 'contacted').then(() => qc.invalidateQueries({ queryKey })).catch(() => {});
    navigate('/agent/welile-schools?mode=fees');
  };

  return (
    <section aria-labelledby="ws-parent-requests">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 id="ws-parent-requests" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Parent requests{open.length ? ` (${open.length} open)` : ''}
        </h2>
        {closed.length > 0 && (
          <button type="button" className="text-xs font-semibold text-primary" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Open only' : `Show all (${rows.length})`}
          </button>
        )}
      </div>
      {isLoading ? (
        <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
      ) : shown.length === 0 ? (
        <p className="rounded-2xl bg-muted/50 p-3 text-sm text-muted-foreground">No open parent requests.</p>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70 bg-card">
          {shown.map((r) => {
            const s = school(r.school_id);
            const intl = toIntlDigits(r.parent_phone);
            const isOpen = isOpenParentRequest(r.status);
            return (
              <article key={r.id} aria-label={`Request for ${r.child_name}`} className="space-y-2.5 p-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><UserRound className="h-4 w-4" aria-hidden /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{r.child_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[s?.name ?? 'School', r.class_grade, r.boarding_status === 'boarding' ? 'Boarding' : r.boarding_status === 'day' ? 'Day' : null, r.term_fee ? formatDynamic(Number(r.term_fee)) : null].filter(Boolean).join(' · ')}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">Parent: {r.parent_name} · {r.parent_phone}</p>
                  </div>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', TONE[r.status])}>{AGENT_STATUS_LABEL[r.status]}</span>
                </div>
                {r.note && <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs"><span className="font-semibold">Parent's note: </span>{r.note}</p>}
                {r.agent_note && !isOpen && <p className="text-xs text-muted-foreground">Your note: {r.agent_note}</p>}

                {isOpen && (
                  declining === r.id ? (
                    <div className="space-y-2">
                      <Input autoFocus placeholder="Why can't this go ahead?" value={reason} onChange={(e) => setReason(e.target.value)} className="h-11 rounded-xl" />
                      <div className="flex gap-2">
                        <Button variant="ghost" className="min-h-[44px] flex-1" onClick={() => { setDeclining(null); setReason(''); }}>Back</Button>
                        <Button variant="destructive" className="min-h-[44px] flex-1" disabled={busy === r.id || reason.trim().length < 3} onClick={() => move(r, 'declined', reason)}>Decline</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <Button asChild variant="outline" className="min-h-[44px] gap-1.5 rounded-xl">
                          <a href={`tel:${r.parent_phone}`}><Phone className="h-4 w-4" />Call</a>
                        </Button>
                        <Button asChild variant="outline" className="min-h-[44px] gap-1.5 rounded-xl">
                          <a href={`https://wa.me/${intl}`} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" />WhatsApp</a>
                        </Button>
                      </div>
                      <Button className="min-h-[48px] w-full gap-2 rounded-xl" onClick={() => startFeeRequest(r)}>
                        <Receipt className="h-4 w-4" />Start the fee request
                      </Button>
                      <div className="flex flex-wrap gap-2">
                        {r.status === 'new' && (
                          <Button variant="ghost" size="sm" className="min-h-[40px] rounded-full" disabled={busy === r.id} onClick={() => move(r, 'contacted')}>Mark contacted</Button>
                        )}
                        <Button variant="ghost" size="sm" className="min-h-[40px] rounded-full text-emerald-700 dark:text-emerald-400" disabled={busy === r.id} onClick={() => move(r, 'sent_to_welile')}>Mark sent to Welile</Button>
                        <Button variant="ghost" size="sm" className="ml-auto min-h-[40px] rounded-full text-destructive" disabled={busy === r.id} onClick={() => setDeclining(r.id)}>Decline</Button>
                      </div>
                    </div>
                  )
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
