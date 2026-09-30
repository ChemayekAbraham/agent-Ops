/**
 * Shared controls for a forwarded concern: change who is handling it (HR / CEO)
 * and set or adjust the answer time (the person handling it, HR, the CEO).
 *
 * Both writes go through SECURITY DEFINER functions that keep the previous value
 * on the record, so nothing in the history is ever overwritten.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, CalendarClock, Search, UserCog } from 'lucide-react';
import { CCBlock, CCDialogHeading } from './ccUi';
import { toast } from 'sonner';
import {
  concernTimeLeft,
  useConcernPowers,
  useConcernStaffOptions,
  useReassignConcern,
  useSetConcernDue,
  type ForwardedConcern,
} from '@/hooks/useCallingConcerns';

const stamp = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

/** Local datetime value for the input, in the user's own time. */
const toLocalInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 24 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const QUICK_HOURS = [4, 8, 12, 24, 48, 72];

function ReassignDialog({
  concern,
  open,
  onClose,
}: {
  concern: ForwardedConcern;
  open: boolean;
  onClose: () => void;
}) {
  const staff = useConcernStaffOptions();
  const reassign = useReassignConcern();
  const [search, setSearch] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setTo('');
    setReason('');
  }, [open]);

  const people = useMemo(() => {
    const list = (staff.data ?? []).filter((p) => p.user_id !== concern.forwarded_to);
    const q = search.trim().toLowerCase();
    return q ? list.filter((p) => p.full_name.toLowerCase().includes(q)) : list;
  }, [staff.data, search, concern.forwarded_to]);

  const submit = async () => {
    try {
      const res = await reassign.mutateAsync({
        concern_id: concern.id,
        new_forwarded_to: to,
        reason: reason.trim(),
      });
      toast.success(`Now with ${res.new_recipient_name}. They must confirm they have it.`);
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not change who is handling this.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-bold">
            <UserCog className="h-4 w-4 text-primary" />
            Change who is handling this
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px]">
            <p className="font-semibold">{concern.title}</p>
            <p className="mt-0.5 text-muted-foreground">
              With {concern.forwarded_to_name ?? 'a staff member'} now · first sent to{' '}
              {concern.original_forwarded_to_name ?? concern.forwarded_to_name ?? '—'}
              {concern.reassigned_count > 0 ? ` · changed ${concern.reassigned_count} time(s) already` : ''}
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Who should handle it now?</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search staff by name"
                className="h-9 pl-9 text-xs"
              />
            </div>
            {staff.isLoading ? (
              <p className="px-1 text-[11px] text-muted-foreground">Loading staff…</p>
            ) : people.length === 0 ? (
              <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] font-semibold text-amber-700">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                No other staff member with an active employee role matches.
              </p>
            ) : (
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                {people.map((p) => (
                  <button
                    key={p.user_id}
                    type="button"
                    onClick={() => setTo(p.user_id)}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs ${
                      to === p.user_id ? 'bg-primary font-semibold text-primary-foreground' : 'hover:bg-muted'
                    }`}
                  >
                    <span className="truncate">{p.full_name}</span>
                    {to === p.user_id && <span className="text-[10px]">Selected</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Why are you changing it?</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="At least 10 characters. This stays on the record."
              className="text-xs"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-9 text-xs font-semibold"
              onClick={submit}
              disabled={reassign.isPending || !to || reason.trim().length < 10}
            >
              {reassign.isPending ? 'Saving…' : 'Change handler'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DueDialog({ concern, open, onClose }: { concern: ForwardedConcern; open: boolean; onClose: () => void }) {
  const setDue = useSetConcernDue();
  const [value, setValue] = useState(toLocalInput(concern.due_at));
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    setValue(toLocalInput(concern.due_at));
    setReason('');
  }, [open, concern.due_at]);

  const submit = async () => {
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) {
      toast.error('Pick a valid date and time.');
      return;
    }
    try {
      await setDue.mutateAsync({ concern_id: concern.id, due_at: when.toISOString(), reason: reason.trim() });
      toast.success('Answer time updated.');
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not change the answer time.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle asChild>
            <CCDialogHeading
              icon={CalendarClock}
              title="Set the answer time"
              hint="The previous time stays on the record — nothing is overwritten."
            />
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <CCBlock className="px-2.5 py-2 text-[11px]">
            Now due {stamp(concern.due_at)}
            {concern.due_is_custom
              ? ` · set by ${concern.due_set_by_name ?? 'staff'} on ${stamp(concern.due_set_at)}`
              : ' · standard 24 hours'}
          </CCBlock>

          <div className="flex flex-wrap gap-1.5">
            {QUICK_HOURS.map((h) => (
              <Button
                key={h}
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => setValue(toLocalInput(new Date(Date.now() + h * 3_600_000).toISOString()))}
              >
                +{h}h
              </Button>
            ))}
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">New answer time</Label>
            <Input
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-9 text-xs"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Why is it changing?</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="At least 5 characters. This stays on the record."
              className="text-xs"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-9 text-xs font-semibold"
              onClick={submit}
              disabled={setDue.isPending || reason.trim().length < 5}
            >
              {setDue.isPending ? 'Saving…' : 'Save answer time'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Due time, time left / past due, and the change buttons for whoever may use them. */
export function ConcernControlPanel({
  concern,
  isReceiver = false,
  compact = false,
}: {
  concern: ForwardedConcern;
  isReceiver?: boolean;
  compact?: boolean;
}) {
  const powers = useConcernPowers();
  const [reassignOpen, setReassignOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const left = concernTimeLeft(concern);
  const canReassign = (isReceiver || !!powers.data?.can_reassign) && concern.status !== 'completed';
  const canSetDue = (isReceiver || !!powers.data?.can_set_due) && concern.status !== 'completed';

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium">Answer expected by {stamp(concern.due_at)}</span>
        <Badge
          variant="outline"
          className={`text-[10px] ${
            left.overdue
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-border bg-muted/40 text-muted-foreground'
          }`}
        >
          {left.label}
        </Badge>
        {concern.due_is_custom && (
          <Badge variant="outline" className="text-[10px]">
            Set by {concern.due_set_by_name ?? 'staff'}
          </Badge>
        )}
        {concern.reassigned_count > 0 && (
          <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
            Reassigned {concern.reassigned_count}×
          </Badge>
        )}
      </div>

      {concern.reassigned_count > 0 && (
        <p className="text-[11px] text-muted-foreground">
          First sent to {concern.original_forwarded_to_name ?? '—'} · now with{' '}
          <span className="font-semibold text-foreground">{concern.forwarded_to_name ?? '—'}</span>
          {concern.last_reassigned_by_name ? ` · changed by ${concern.last_reassigned_by_name}` : ''}
          {concern.last_reassigned_at ? ` on ${stamp(concern.last_reassigned_at)}` : ''}
        </p>
      )}

      {(canReassign || canSetDue) && (
        <div className="flex flex-wrap gap-1.5">
          {canSetDue && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-[11px] font-semibold"
              onClick={() => setDueOpen(true)}
            >
              <CalendarClock className="mr-1 h-3.5 w-3.5" />
              Change answer time
            </Button>
          )}
          {canReassign && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-[11px] font-semibold"
              onClick={() => setReassignOpen(true)}
            >
              <UserCog className="mr-1 h-3.5 w-3.5" />
              {isReceiver ? 'Forward to another staff' : 'Change handler'}
            </Button>
          )}
        </div>
      )}

      {reassignOpen && <ReassignDialog concern={concern} open={reassignOpen} onClose={() => setReassignOpen(false)} />}
      {dueOpen && <DueDialog concern={concern} open={dueOpen} onClose={() => setDueOpen(false)} />}
    </div>
  );
}
