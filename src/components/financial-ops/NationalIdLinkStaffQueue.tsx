/**
 * Staff step for National ID groups.
 *
 * The person who holds the ID has already agreed, and the code sent to their
 * number was entered. Staff only confirm that the details are right — they
 * cannot approve a request the holder has not allowed.
 */
import { useState } from 'react';
import { Check, IdCard, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  useNationalIdLinkStaffConfirm, useNationalIdLinkStaffQueue,
} from '@/hooks/useNationalIdLink';

export default function NationalIdLinkStaffQueue() {
  const queue = useNationalIdLinkStaffQueue();
  const confirm = useNationalIdLinkStaffConfirm();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const rows = queue.data ?? [];
  if (queue.isLoading || rows.length === 0) return null;

  const decide = async (id: string, approve: boolean) => {
    const reason = (notes[id] ?? '').trim();
    if (reason.length < 10) {
      toast.error('Write at least 10 characters saying what you checked.');
      return;
    }
    try {
      await confirm.mutateAsync({ id, approve, reason });
      toast.success(approve ? 'Account linked to that National ID.' : 'Request refused.');
      setNotes((n) => ({ ...n, [id]: '' }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record that decision.');
    }
  };

  const maskId = (n?: string | null) => (n && n.length > 4 ? `${n.slice(0, 2)}${'•'.repeat(n.length - 4)}${n.slice(-2)}` : n ?? '—');
  return (
    <section id="national-id-link-staff-queue" className="scroll-mt-20 rounded-2xl border-2 border-[#B79BF2] bg-card p-4 shadow-sm sm:p-5" aria-label="National ID link audit queue">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="flex items-center gap-2.5 text-xl font-bold text-foreground">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border-2 border-[#B79BF2] text-[#6D2EE8]"><IdCard className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" /></span> National ID link audit queue ({rows.length})
        </h3>
        <span className="text-sm text-muted-foreground">Audit review · Payout auto-verified</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">The holder approved the link in the app. Staff audit the record afterwards.</p>

      <div className="mt-3 divide-y divide-border/70 border-t border-border/70">
        {rows.map((r) => (
          <div key={r.id} id={`national-id-link-record-${r.id}`} className="flex scroll-mt-24 flex-wrap items-center gap-x-5 gap-y-3 py-3.5">
            <div className="flex items-center gap-3">
              <span className="font-mono text-base font-bold text-foreground">{maskId(r.nin)}</span>
              <span className="rounded-full bg-[#FFE49A] px-3.5 py-1 text-sm font-extrabold text-[#6B4200] dark:bg-amber-400/30 dark:text-amber-200">Awaiting staff audit</span>
            </div>
            <p className="text-sm text-foreground">
              Holder approved{' '}
              {r.owner_confirmed_at
                ? new Date(r.owner_confirmed_at as string).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '—'}
              <span className="mx-3 text-border" aria-hidden="true">|</span>
              <span className={r.code_verified_at ? 'font-bold text-[#13803E] dark:text-emerald-300' : 'font-semibold text-[#9A5B00]'}>
                {r.code_verified_at ? <><Check className="mr-1 inline h-4 w-4" strokeWidth={3} aria-hidden="true" />Mobile code entered</> : 'Mobile code not yet entered'}
              </span>
            </p>
            <div className="min-w-[14rem] flex-1">
              <label htmlFor={`link-note-${r.id}`} className="text-sm font-bold text-foreground">Audit notes</label>
              <Textarea
                id={`link-note-${r.id}`}
                value={notes[r.id] ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                placeholder="At least 10 characters."
                rows={1}
                className="mt-1 min-h-[44px] text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="min-h-[44px] rounded-xl border-[#E0352B] bg-white px-5 font-extrabold text-[#D92D20] hover:bg-[#FFECEB] dark:bg-transparent" onClick={() => decide(r.id, false)} disabled={confirm.isPending}>
                Refuse link
              </Button>
              <Button className="min-h-[44px] rounded-xl px-5 font-bold" onClick={() => decide(r.id, true)} disabled={confirm.isPending}>
                {confirm.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Confirm audit
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
