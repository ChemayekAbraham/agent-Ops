/**
 * Per-tenant Notes/Activity popover for the "20+ Days No Payment" tab.
 * Historical, append-only — adding a note never overwrites a previous one
 * (enforced at the database level: tenant_no_payment_notes has no
 * UPDATE/DELETE grant at all).
 *
 * Built from the same Popover + Card + Badge + Button primitives NoPaymentTab
 * already uses for its agent filter, so it looks native rather than
 * introducing a new UI idiom.
 */
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { MessageSquare, Loader2 } from 'lucide-react';
import {
  useTenantNoPaymentNoteHistory,
  useAddTenantNoPaymentNote,
  type TenantNoPaymentNoteSummary,
} from '@/hooks/useTenantNoPaymentNotes';

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function TenantNotesPopover({
  tenantId,
  summary,
}: {
  tenantId: string;
  summary?: TenantNoPaymentNoteSummary;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const { data: notes, isLoading } = useTenantNoPaymentNoteHistory(open ? tenantId : null);
  const addNote = useAddTenantNoPaymentNote();

  const count = summary?.notes_count ?? 0;

  const submit = () => {
    if (!draft.trim()) return;
    addNote.mutate(
      { tenantId, note: draft },
      { onSuccess: () => setDraft('') },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-9 w-full max-w-[220px] justify-start gap-2 px-2.5 py-1.5 text-left font-normal"
        >
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            {count > 0 ? (
              <span className="block truncate text-xs">{summary?.last_note}</span>
            ) : (
              <span className="block text-xs text-muted-foreground">No notes yet</span>
            )}
          </span>
          {count > 0 && (
            <Badge variant="secondary" className="ml-auto shrink-0 tabular-nums">
              {count}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-3">
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note — what happened, what's next…"
            className="min-h-16 text-sm"
          />
          <Button
            size="sm"
            className="w-full gap-1.5"
            disabled={!draft.trim() || addNote.isPending}
            onClick={submit}
          >
            {addNote.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Add note
          </Button>
        </div>

        <div className="mt-3 border-t pt-2">
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            History
          </p>
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : !notes || notes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No notes recorded for this tenant yet.</p>
          ) : (
            <ScrollArea className="max-h-64 pr-2">
              <div className="space-y-2.5">
                {notes.map((n) => (
                  <div key={n.id} className="text-xs">
                    <p className="break-words leading-snug">{n.note}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {formatWhen(n.created_at)} · {n.created_by_name}
                    </p>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
