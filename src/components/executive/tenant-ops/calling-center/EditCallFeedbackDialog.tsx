/**
 * Tracked edit of the feedback an officer already recorded for a call.
 *
 * Nothing about the call itself changes — the outcome, its date, the attempt
 * number, routing, tickets and follow-ups all stay exactly as recorded. Only the
 * feedback category, severity and note can be corrected, and every correction is
 * written to the append-only edit trail (with the reason and who made it) before
 * it is applied. The previous wording is never lost.
 */
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, PencilLine } from 'lucide-react';
import { toast } from 'sonner';
import { ccErrorText, CC_NOTE_MIN_LENGTH, type CcCallingHub, type CcSeverity } from '@/hooks/useCcCallingHub';
import { useAmendCcFeedback } from '@/hooks/useCcFeedbackAmendments';

const SEVERITIES: CcSeverity[] = ['normal', 'high', 'critical'];
const REASON_MIN_LENGTH = 10;

export function EditCallFeedbackDialog({
  hub,
  open,
  call,
  onClose,
}: {
  hub: CcCallingHub;
  open: boolean;
  call: {
    feedbackId: string;
    categoryId: string | null;
    severity: CcSeverity | null;
    comment: string | null;
    attemptNo: number;
  } | null;
  onClose: () => void;
}) {
  const amend = useAmendCcFeedback();
  const [categoryId, setCategoryId] = useState('');
  const [severity, setSeverity] = useState<CcSeverity>('normal');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open || !call) return;
    setCategoryId(call.categoryId ?? '');
    setSeverity(call.severity ?? 'normal');
    setNote(call.comment ?? '');
    setReason('');
  }, [open, call]);

  const submit = () => {
    if (!call) return;
    if (!categoryId) return toast.error('Choose a feedback category.');
    if (note.trim().length < CC_NOTE_MIN_LENGTH) {
      return toast.error(`Please write at least ${CC_NOTE_MIN_LENGTH} characters describing what the customer said.`);
    }
    if (reason.trim().length < REASON_MIN_LENGTH) {
      return toast.error(`Please give a reason of at least ${REASON_MIN_LENGTH} characters for this edit.`);
    }
    amend.mutate(
      { feedbackId: call.feedbackId, categoryId, severity, note: note.trim(), reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Feedback updated — the edit has been recorded.');
          onClose();
        },
        onError: (e) => toast.error(ccErrorText(e)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88svh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-sm font-bold sm:text-base">
            <PencilLine className="h-4 w-4 text-primary" />
            Edit feedback {call ? `— call #${call.attemptNo}` : ''}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            The call itself, its date and its outcome stay as recorded. Every edit is kept with your name, the time and
            the reason.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Feedback category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="h-10 text-xs">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {hub.categories.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as CcSeverity)}>
              <SelectTrigger className="h-10 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">What the customer said</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              className="text-xs"
              placeholder="Correct or complete the note…"
            />
            <p className="text-[10px] text-muted-foreground">
              {note.trim().length}/{CC_NOTE_MIN_LENGTH} characters minimum
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Reason for this edit</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="text-xs"
              placeholder="e.g. Wrong category chosen during the call"
            />
            <p className="text-[10px] text-muted-foreground">
              {reason.trim().length}/{REASON_MIN_LENGTH} characters minimum
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="button" variant="outline" className="h-10 text-xs font-semibold" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            className="h-10 flex-1 text-xs font-semibold"
            disabled={amend.isPending}
            onClick={submit}
          >
            {amend.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save edit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
