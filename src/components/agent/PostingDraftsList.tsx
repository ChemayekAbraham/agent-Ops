/**
 * "Saved" (E109): rent requests the agent saved to finish later, from posting_drafts_mine.
 * Continue reopens the chat at the first missing item, prefilled; Remove discards it.
 * Hidden when there are none, or while the RPC is not on the database yet.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { closeDraft, fetchMyDrafts, type PostingDraftRow } from '@/lib/postingDrafts';
import { openT4RentRequest } from '@/lib/t4RentRequest';

export const POSTING_DRAFTS_KEY = ['posting-drafts-mine'] as const;

const expiryLabel = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric' });
};

export function PostingDraftsList({ onContinue }: { onContinue?: () => void }) {
  const qc = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: POSTING_DRAFTS_KEY,
    queryFn: fetchMyDrafts,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
  // null = the RPC is not there yet; an error or an empty list shows nothing either.
  if (!data || data.length === 0) return null;

  const cont = (d: PostingDraftRow) => {
    if (!d.payload) return;
    onContinue?.();
    openT4RentRequest({ mode: 'new', entry: 'saved-draft', draft: { id: d.id, payload: d.payload } });
  };
  const remove = async (d: PostingDraftRow) => {
    setRemoving(d.id);
    const err = await closeDraft(d.id, 'discarded');
    setRemoving(null);
    if (err) { toast.error(err); return; }
    qc.setQueryData<PostingDraftRow[] | null>(POSTING_DRAFTS_KEY, (rows) => (rows ?? []).filter((r) => r.id !== d.id));
  };

  return (
    <section className="mb-4 space-y-2" aria-labelledby="posting-drafts-title" data-testid="posting-drafts">
      <h3 id="posting-drafts-title" className="flex items-center gap-1.5 text-sm font-semibold">
        <Bookmark className="h-4 w-4 text-primary" aria-hidden /> Saved
      </h3>
      <ul className="space-y-2">
        {data.map((d) => {
          const expires = expiryLabel(d.expires_at);
          return (
            <li key={d.id} className="rounded-xl border border-border bg-card p-3">
              <p className="truncate font-semibold">{d.tenant_name?.trim() || d.tenant_phone || 'Tenant not named yet'}</p>
              {d.missing && <p className="mt-0.5 text-xs text-muted-foreground">Missing: {d.missing}</p>}
              {expires && <p className="mt-0.5 text-[11px] text-muted-foreground">Expires {expires}</p>}
              <div className="mt-2 flex gap-2">
                <Button size="sm" className="h-9 flex-1" onClick={() => cont(d)} disabled={!d.payload}>Continue</Button>
                <Button size="sm" variant="outline" className="h-9" onClick={() => void remove(d)} disabled={removing === d.id}
                  aria-label={`Remove saved request for ${d.tenant_name || 'this tenant'}`}>
                  {removing === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Remove'}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
