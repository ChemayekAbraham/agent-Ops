/**
 * Forward a concern to a member of staff.
 *
 * Works from both call sources — an outbound recorded call or a received call —
 * and only offers people with a live employee role, with Platform Sales Officers
 * left out. The hand-off itself is written by a SECURITY DEFINER function, which
 * also opens the concern's history trail.
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, Forward, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  useConcernStaffOptions,
  useForwardConcern,
  type ForwardConcernInput,
} from '@/hooks/useCallingConcerns';

export interface ForwardConcernSource {
  source_kind: 'outbound_call' | 'received_call';
  received_call_id?: string | null;
  cycle_row_id?: string | null;
  caller_name?: string | null;
  caller_user_id?: string | null;
  subject_type?: string | null;
  suggestedTitle?: string;
  suggestedContext?: string;
}

const DUE_CHOICES = [4, 8, 12, 24, 48, 72];
const DEFAULT_DUE = 24;

export function ForwardConcernDialog({
  open,
  source,
  onClose,
}: {
  open: boolean;
  source: ForwardConcernSource | null;
  onClose: () => void;
}) {
  const staff = useConcernStaffOptions();
  const forward = useForwardConcern();
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');
  const [priority, setPriority] = useState('normal');
  const [dueHours, setDueHours] = useState(12);
  const [to, setTo] = useState('');
  const [staffSearch, setStaffSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(source?.suggestedTitle?.slice(0, 120) ?? '');
    setContext(source?.suggestedContext ?? '');
    setPriority('normal');
    setDueHours(12);
    setTo('');
    setStaffSearch('');
  }, [open, source]);

  const people = useMemo(() => {
    const list = staff.data ?? [];
    const q = staffSearch.trim().toLowerCase();
    return q ? list.filter((p) => p.full_name.toLowerCase().includes(q)) : list;
  }, [staff.data, staffSearch]);

  const submit = async () => {
    if (!source) return;
    if (title.trim().length < 5) {
      toast.error('Give the concern a short title (at least 5 characters).');
      return;
    }
    if (!to) {
      toast.error('Choose who should handle this.');
      return;
    }
    const payload: ForwardConcernInput = {
      source_kind: source.source_kind,
      title: title.trim(),
      forwarded_to: to,
      context: context.trim() || null,
      priority,
      received_call_id: source.received_call_id ?? null,
      cycle_row_id: source.cycle_row_id ?? null,
      caller_name: source.caller_name ?? null,
      caller_user_id: source.caller_user_id ?? null,
      subject_type: source.subject_type ?? null,
      due_hours: dueHours,
    };
    try {
      await forward.mutateAsync(payload);
      toast.success('Forwarded. It now shows in their My Space.');
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not forward this concern.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-bold">
            <Forward className="h-4 w-4 text-primary" />
            Forward this concern
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {source?.caller_name && (
            <p className="rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px]">
              About <span className="font-semibold">{source.caller_name}</span> ·{' '}
              {source.source_kind === 'received_call' ? 'call they made to us' : 'call we made to them'}
            </p>
          )}

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">What is the concern?</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short title, e.g. Landlord has not received rent"
              className="h-9 text-xs"
              maxLength={120}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Details for the person taking it on</Label>
            <Textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={3}
              placeholder="What the caller said, and what you already checked."
              className="text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold">How urgent?</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['low', 'normal', 'high', 'critical'].map((p) => (
                    <SelectItem key={p} value={p} className="text-xs capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold">Answer expected within</Label>
              <Select value={String(dueHours)} onValueChange={(v) => setDueHours(Number(v))}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DUE_CHOICES.map((h) => (
                    <SelectItem key={h} value={String(h)} className="text-xs">
                      {h} hours
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Who should handle it?</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={staffSearch}
                onChange={(e) => setStaffSearch(e.target.value)}
                placeholder="Search staff by name"
                className="h-9 pl-9 text-xs"
              />
            </div>
            {staff.isLoading ? (
              <p className="px-1 text-[11px] text-muted-foreground">Loading staff…</p>
            ) : people.length === 0 ? (
              <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] font-semibold text-amber-700">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                No matching staff member with an active employee role.
              </p>
            ) : (
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                {people.map((p) => (
                  <button
                    key={p.user_id}
                    type="button"
                    onClick={() => setTo(p.user_id)}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs ${
                      to === p.user_id ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'
                    }`}
                  >
                    <span className="truncate">{p.full_name}</span>
                    {to === p.user_id && <span className="text-[10px]">Selected</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" className="h-9 text-xs font-semibold" onClick={submit} disabled={forward.isPending}>
              {forward.isPending ? 'Forwarding…' : 'Forward concern'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
