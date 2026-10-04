import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRentPaymentStatusMutation, type AgentPaymentStatus } from '@/hooks/useRentPaymentStatusMutation';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rentRequestId: string | null;
  tenantName?: string;
  currentStatus: AgentPaymentStatus;
  agentId?: string;
}

const REASON_PRESETS = [
  { value: 'moved_out',       label: 'Moved out of the property' },
  { value: 'refused_to_pay',  label: 'Refusing to pay' },
  { value: 'dispute',         label: 'Dispute with landlord' },
  { value: 'lost_job',        label: 'Lost job / income' },
  { value: 'unreachable',     label: 'Unreachable / disappeared' },
  { value: 'other',           label: 'Other (explain)' },
];

export function RentPaymentStatusSheet({
  open, onOpenChange, rentRequestId, tenantName, currentStatus, agentId,
}: Props) {
  const isNotPaying = currentStatus === 'not_paying';
  const nextStatus: AgentPaymentStatus = isNotPaying ? 'paying' : 'not_paying';

  const [preset, setPreset] = useState<string>('moved_out');
  const [note, setNote] = useState<string>('');
  const mutation = useRentPaymentStatusMutation(agentId);

  const presetLabel = REASON_PRESETS.find(p => p.value === preset)?.label ?? '';
  const composedReason = nextStatus === 'not_paying'
    ? [presetLabel, note.trim()].filter(Boolean).join(' — ')
    : 'Marked as paying again';
  const reasonOk = nextStatus === 'paying' || composedReason.trim().length >= 10;

  const handleSubmit = async () => {
    if (!rentRequestId) return;
    await mutation.mutateAsync({ rentRequestId, status: nextStatus, reason: composedReason });
    onOpenChange(false);
    setNote('');
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader className="text-left">
          <SheetTitle>
            {nextStatus === 'not_paying' ? 'Mark as Not Paying' : 'Mark as Paying'}
          </SheetTitle>
          <SheetDescription>
            {nextStatus === 'not_paying'
              ? <>This removes <strong>{tenantName ?? 'this tenant'}</strong> from your daily collection target. They will not count toward the 20% Daily Eligibility rule until they pay again.</>
              : <>This re-adds <strong>{tenantName ?? 'this tenant'}</strong> to your daily collection target.</>}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-4">
          {nextStatus === 'not_paying' && (
            <>
              <div className="space-y-2">
                <Label>Reason</Label>
                <Select value={preset} onValueChange={setPreset}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {REASON_PRESETS.map(p => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Details {preset === 'other' ? '(required)' : '(optional)'}</Label>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add specifics so managers can audit later (min 10 characters total)."
                  rows={3}
                />
                <p className="text-[11px] text-muted-foreground">
                  {composedReason.length} characters {reasonOk ? '✓' : '(need 10+)'}
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            variant={nextStatus === 'not_paying' ? 'destructive' : 'default'}
            onClick={handleSubmit}
            disabled={!rentRequestId || !reasonOk || mutation.isPending}
          >
            {mutation.isPending ? 'Saving…' : nextStatus === 'not_paying' ? 'Mark Not Paying' : 'Mark Paying'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
