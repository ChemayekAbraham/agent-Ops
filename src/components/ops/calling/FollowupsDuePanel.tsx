import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { ccErrorText, type CcCallingHub } from '@/hooks/useCcCallingHub';

export function FollowupsDuePanel({ hub }: { hub: CcCallingHub }) {
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <Card className="rounded-2xl border-border/60 p-3 sm:p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
        <CalendarClock className="h-4 w-4 text-primary" />
        Follow-ups due ({hub.followups.length})
      </h3>

      {hub.followupsError && (
        <p className="mb-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{hub.followupsError}</p>
      )}

      {!hub.followups.length ? (
        <p className="text-xs text-muted-foreground">Nothing owed by you.</p>

      ) : (
        <ul className="space-y-2">
          {hub.followups.map((f: any) => (
            <li key={f.id} className="rounded-xl border border-border/60 p-2">
              <div className="text-sm font-semibold">{f.reason}</div>
              <div className="text-[11px] text-muted-foreground">
                {f.ticket?.ref ? `${f.ticket.ref} · ` : ''}
                due {f.due_at ? new Date(f.due_at).toLocaleString() : '—'}
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <Input
                  value={notes[f.id] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [f.id]: e.target.value }))}
                  placeholder="Completion note"
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  className="h-8"
                  disabled={hub.completeFollowup.isPending}
                  onClick={() =>
                    hub.completeFollowup.mutate(
                      { id: f.id, note: notes[f.id] ?? '' },
                      {
                        onSuccess: () => toast.success('Follow-up completed.'),
                        onError: (e) => toast.error(ccErrorText(e)),
                      },
                    )
                  }
                >
                  Complete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
