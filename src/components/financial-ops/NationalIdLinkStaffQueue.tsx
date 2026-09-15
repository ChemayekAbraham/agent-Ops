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
    <Card className="border-2 border-amber-500/40">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <IdCard className="h-4 w-4 text-amber-600" />
          National ID groups waiting for you ({rows.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((r) => (
          <div key={r.id} className="space-y-2 rounded-xl border border-border p-3">
            <p className="text-sm font-semibold">
              National ID <span className="font-mono">{r.nin}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              The holder allowed this on{' '}
              {r.owner_confirmed_at
                ? new Date(r.owner_confirmed_at as string).toLocaleString('en-GB', {
                    dateStyle: 'medium', timeStyle: 'short',
                  })
                : '—'}
              , and the code sent to their number was entered
              {r.code_verified_at ? '' : ' — not yet'}.
            </p>
            <Textarea
              value={notes[r.id] ?? ''}
              onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
              placeholder="What did you check? (at least 10 characters)"
              rows={2}
              className="text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-10"
                onClick={() => decide(r.id, false)}
                disabled={confirm.isPending}
              >
                Refuse
              </Button>
              <Button className="h-10" onClick={() => decide(r.id, true)} disabled={confirm.isPending}>
                {confirm.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Confirm the link
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
