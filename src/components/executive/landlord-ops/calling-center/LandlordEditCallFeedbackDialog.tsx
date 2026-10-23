import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CcCallHistoryRow, useUpdateCcCallOutcome } from '@/hooks/useCcCallHistory';
import { useCcCallingHub } from '@/hooks/useCcCallingHub';
import { Pencil } from 'lucide-react';
import { formatHumanLabel } from './ccUi';

const OUTCOMES = [
  { code: 'engaged', label: 'Engaged' },
  { code: 'reached_busy', label: 'Reached (Busy)' },
  { code: 'no_answer', label: 'No Answer' },
  { code: 'unreachable', label: 'Unreachable / Off' },
  { code: 'wrong_number', label: 'Wrong Number' },
  { code: 'callback_requested', label: 'Callback Requested' },
];

export function LandlordEditCallFeedbackDialog({
  row,
  open,
  onOpenChange,
  hub,
}: {
  row: CcCallHistoryRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  hub: ReturnType<typeof useCcCallingHub>;
}) {
  const update = useUpdateCcCallOutcome();
  const [outcome, setOutcome] = useState('engaged');
  const [category, setCategory] = useState<string>('__none__');
  const [notes, setNotes] = useState('');
  const [nextAction, setNextAction] = useState('');

  useEffect(() => {
    if (row && open) {
      setOutcome(row.outcome || 'engaged');
      setCategory(row.feedback_category || '__none__');
      setNotes(row.feedback_notes || row.notes || '');
      setNextAction(row.next_action || '');
    }
  }, [row, open]);

  if (!row) return null;

  const categories = hub.categories.data ?? [];

  const handleSave = async () => {
    await update.mutateAsync({
      attemptId: row.attempt_id,
      outcome,
      notes: notes.trim() || null,
      category: category === '__none__' ? null : category,
      nextAction: nextAction.trim() || null,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Pencil className="h-4 w-4 text-primary" /> Edit Call Feedback — {row.subject_name || 'Landlord'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Label className="text-xs">Call Outcome</Label>
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((o) => (
                  <SelectItem key={o.code} value={o.code}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Landlord Feedback Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— None —</SelectItem>
                {categories.map((c: any) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.label || formatHumanLabel(c.code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Feedback / Call Notes</Label>
            <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Update call summary or notes…" />
          </div>
          <div>
            <Label className="text-xs">Agreed Next Action</Label>
            <Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="e.g. Confirm payout number on Friday" />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
