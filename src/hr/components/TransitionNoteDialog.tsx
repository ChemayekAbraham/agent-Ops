import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The single source of truth for transition-note prompts. Its keys are also the
 * set of event types for which a note is REQUIRED — never keep a second list.
 */
export const TRANSITION_NOTE_LABELS: Record<string, string> = {
  completed: 'What was the outcome?',
};

const MIN_NOTE_LENGTH = 10;

/** The one validation rule for transition notes. */
export function isValidTransitionNote(note: string): boolean {
  return note.trim().length >= MIN_NOTE_LENGTH;
}

/** How many more characters are still needed for the note to pass. */
export function charsStillNeeded(note: string): number {
  return Math.max(0, MIN_NOTE_LENGTH - note.trim().length);
}

export const isNoteRequired = (action: string) => action in TRANSITION_NOTE_LABELS;

interface TransitionNoteDialogProps {
  eventType: string;
  open: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
  busy?: boolean;
}

export default function TransitionNoteDialog({
  eventType,
  open,
  onClose,
  onConfirm,
  busy,
}: TransitionNoteDialogProps) {
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) setNote('');
  }, [open, eventType]);

  const valid = isValidTransitionNote(note);
  const missing = charsStillNeeded(note);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="capitalize">{eventType.replace(/_/g, ' ')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="transition-note">
            {TRANSITION_NOTE_LABELS[eventType] ?? 'Add a note for this action.'}
          </Label>
          <Textarea
            id="transition-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
          />
          <p className="text-[11px] text-muted-foreground">
            {valid ? 'Ready to submit' : `${missing} more character${missing === 1 ? '' : 's'} needed`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(note.trim())} disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}