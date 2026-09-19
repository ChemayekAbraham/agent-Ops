/**
 * Staff step for National ID groups.
 *
 * The person who holds the ID has already agreed, and the code sent to their
 * number was entered. Staff only confirm that the details are right — they
 * cannot approve a request the holder has not allowed.
 */
import { useState } from 'react';
import { IdCard, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

  return (
    <Card id="national-id-link-staff-queue" className="border-2 border-amber-500/40 shadow-sm scroll-mt-20">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <IdCard className="h-4 w-4 text-amber-600" />
            National ID link audit queue ({rows.length})
          </CardTitle>
          <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-400">
            Audit review · Payout auto-verified
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Holders approved these links in-app. Payout destinations are auto-verified immediately; staff review and audit the link record.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((r) => (
          <div
            key={r.id}
            id={`national-id-link-record-${r.id}`}
            className="space-y-2.5 rounded-xl border border-border bg-card/60 p-3.5 transition-all scroll-mt-24"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                National ID <span className="font-mono font-bold">{r.nin}</span>
              </p>
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                Awaiting staff audit
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Holder approved this link on{' '}
              {r.owner_confirmed_at
                ? new Date(r.owner_confirmed_at as string).toLocaleString('en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : '—'}
              , and mobile code was entered
              {r.code_verified_at ? ' ✓' : ' — not yet'}.
            </p>
            <Textarea
              value={notes[r.id] ?? ''}
              onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
              placeholder="Audit notes — what did you check? (at least 10 characters)"
              rows={2}
              className="text-sm"
            />
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                variant="outline"
                className="h-10 text-xs font-semibold"
                onClick={() => decide(r.id, false)}
                disabled={confirm.isPending}
              >
                Refuse link
              </Button>
              <Button
                className="h-10 text-xs font-semibold shadow-sm"
                onClick={() => decide(r.id, true)}
                disabled={confirm.isPending}
              >
                {confirm.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Confirm audit
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
