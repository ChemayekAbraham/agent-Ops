import { useState } from 'react';
import { useCashoutClaimComments } from '@/hooks/useCashoutClaimComments';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, MessageSquarePlus, Send } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

const STATUS_OPTIONS = ['Verified', 'Paid', 'Charges confirmed', 'Awaiting confirmation', 'Failed', 'Rejected', 'Approved'];

function statusTone(status?: string | null) {
  const s = (status || '').toLowerCase();
  if (['paid', 'verified', 'approved', 'charges confirmed'].some((x) => s.includes(x)))
    return 'border-emerald-500/40 text-emerald-600';
  if (['failed', 'rejected'].some((x) => s.includes(x))) return 'border-destructive/40 text-destructive';
  return 'border-amber-500/40 text-amber-600';
}

/**
 * Permanent comment timeline for a cash-out claim + an add-comment composer.
 * Every action becomes part of the audit trail — nothing can be edited/removed.
 */
export function ClaimCommentTimeline({ withdrawalId }: { withdrawalId: string }) {
  const { comments, isLoading, addComment } = useCashoutClaimComments(withdrawalId);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string>('none');

  const submit = () => {
    addComment.mutate(
      { comment: text, status: status === 'none' ? null : status },
      {
        onSuccess: () => {
          setText('');
          setStatus('none');
          toast.success('Comment added to the claim timeline');
        },
        onError: (e: any) => toast.error(e.message || 'Could not add comment'),
      },
    );
  };

  return (
    <div className="space-y-3">
      {isLoading ? (
        <div className="flex items-center py-3 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading comments…
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet. Add the first note below.</p>
      ) : (
        <ol className="relative border-l border-border ml-1.5 space-y-3">
          {comments.map((c) => (
            <li key={c.id} className="ml-4">
              <span className="absolute -left-[5px] mt-1 h-2.5 w-2.5 rounded-full bg-primary" />
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-foreground">{c.author_name || 'Officer'}</p>
                {c.author_role && (
                  <Badge variant="outline" className="text-[9px] h-4 px-1 capitalize">{c.author_role}</Badge>
                )}
                {c.status && (
                  <Badge variant="outline" className={`text-[9px] h-4 px-1 ${statusTone(c.status)}`}>{c.status}</Badge>
                )}
              </div>
              <p className="text-sm text-foreground/90 mt-0.5">{c.comment}</p>
              <p className="text-[11px] text-muted-foreground">
                {format(new Date(c.created_at), 'dd MMM yyyy, HH:mm')}
              </p>
            </li>
          ))}
        </ol>
      )}

      <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <MessageSquarePlus className="h-3.5 w-3.5" /> Add a comment
        </div>
        <Textarea
          rows={2}
          placeholder="e.g. Verified bank slip, customer has received funds…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 text-xs w-40">
              <SelectValue placeholder="Status (optional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No status</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="ml-auto gap-1.5"
            disabled={addComment.isPending || text.trim().length < 2}
            onClick={submit}
          >
            {addComment.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Post
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ClaimCommentTimeline;
