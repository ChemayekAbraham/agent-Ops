/**
 * Everyone on one concern, and the record of how they got there.
 *
 * A concern can be shared with several people from the very first hand-off, and
 * more can be brought in at any stage by the sender, anyone already on it, HR or
 * the CEO. Nobody is ever erased: taking a person off keeps their row, the reason
 * and who did it, and every change also writes an entry to the concern's history.
 */
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BellRing, CheckCircle2, Search, UserMinus, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  activeReviewers,
  pastReviewers,
  useAddConcernReviewer,
  useConcernPowers,
  useConcernStaffOptions,
  useRemoveConcernReviewer,
  type ConcernReviewer,
  type ForwardedConcern,
} from '@/hooks/useCallingConcerns';

const stamp = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

function AddPeopleDialog({
  concern,
  current,
  open,
  onClose,
}: {
  concern: ForwardedConcern;
  current: ConcernReviewer[];
  open: boolean;
  onClose: () => void;
}) {
  const staff = useConcernStaffOptions();
  const add = useAddConcernReviewer();
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');

  const onIt = useMemo(() => new Set(current.map((r) => r.user_id)), [current]);
  const people = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (staff.data ?? [])
      .filter((p) => !onIt.has(p.user_id))
      .filter((p) => (q ? p.full_name.toLowerCase().includes(q) : true));
  }, [staff.data, search, onIt]);

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    if (picked.length === 0) {
      toast.error('Choose at least one person to add.');
      return;
    }
    try {
      for (const userId of picked) {
        await add.mutateAsync({ concern_id: concern.id, user_id: userId, reason: reason.trim() || null });
      }
      toast.success(picked.length > 1 ? `${picked.length} people added.` : 'Person added to this concern.');
      setPicked([]);
      setReason('');
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not add that person.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold">Add people to this concern</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <p className="rounded-xl border border-border/80 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
            They join the same concern and see the whole history. Nobody already on it is replaced.
          </p>
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
            <p className="px-1 text-[11px] text-muted-foreground">
              No other staff member with an active employee role to add.
            </p>
          ) : (
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-border bg-muted/20 p-1.5">
              {people.map((p) => {
                const on = picked.includes(p.user_id);
                return (
                  <button
                    key={p.user_id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(p.user_id)}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      on ? 'bg-primary font-semibold text-primary-foreground shadow-sm' : 'hover:bg-background'
                    }`}
                  >
                    <span className="truncate">{p.full_name}</span>
                    {on && <CheckCircle2 className="ml-2 h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Why are they being brought in? (optional)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Needs the landlord side checked"
              className="text-xs"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" className="h-9 text-xs font-semibold" onClick={submit} disabled={add.isPending}>
              {add.isPending ? 'Saving…' : picked.length > 1 ? `Add ${picked.length} people` : 'Add'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RemovePersonDialog({
  concern,
  person,
  onClose,
}: {
  concern: ForwardedConcern;
  person: ConcernReviewer | null;
  onClose: () => void;
}) {
  const remove = useRemoveConcernReviewer();
  const [reason, setReason] = useState('');

  const submit = async () => {
    if (!person) return;
    if (reason.trim().length < 5) {
      toast.error('Say why they are being taken off (at least 5 characters).');
      return;
    }
    try {
      await remove.mutateAsync({ concern_id: concern.id, user_id: person.user_id, reason: reason.trim() });
      toast.success(`${person.full_name ?? 'Person'} taken off this concern.`);
      setReason('');
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not take that person off.');
    }
  };

  return (
    <Dialog open={!!person} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold">Take {person?.full_name ?? 'person'} off this concern</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <p className="rounded-xl border border-border/80 bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
            Their time on this concern stays on the record, with your reason and the list before and after.
          </p>
          <div className="space-y-1">
            <Label className="text-[11px] font-semibold">Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Handed over to the landlord team"
              className="text-xs"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-9 text-xs font-semibold"
              onClick={submit}
              disabled={remove.isPending || reason.trim().length < 5}
            >
              {remove.isPending ? 'Saving…' : 'Take off'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ConcernParticipantsPanel({
  concern,
  reviewers,
  readOnly = false,
}: {
  concern: ForwardedConcern;
  reviewers: ConcernReviewer[];
  readOnly?: boolean;
}) {
  const { user } = useAuth();
  const powers = useConcernPowers();
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<ConcernReviewer | null>(null);

  const current = useMemo(() => activeReviewers(reviewers), [reviewers]);
  const past = useMemo(() => pastReviewers(reviewers), [reviewers]);

  const canManage =
    !readOnly &&
    !!user?.id &&
    (concern.forwarded_by === user.id ||
      concern.forwarded_to === user.id ||
      current.some((r) => r.user_id === user.id) ||
      !!powers.data?.is_hr ||
      !!powers.data?.is_ceo ||
      !!powers.data?.is_super_admin);

  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-2">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <p className="flex items-center gap-1.5 text-[11px] font-bold">
          <Users className="h-3.5 w-3.5 text-primary" />
          On this concern ({current.length})
        </p>
        {canManage && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[11px] font-semibold"
            onClick={() => setAddOpen(true)}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Add people
          </Button>
        )}
      </div>

      <div className="mt-1.5 space-y-1">
        {current.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {concern.forwarded_to_name ?? 'Staff member'}
          </p>
        ) : (
          current.map((r) => (
            <div
              key={r.user_id}
              className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg bg-background/70 px-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold">
                  {r.full_name ?? 'Staff member'}
                  {r.role === 'handler' && (
                    <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[9px]">
                      First recipient
                    </Badge>
                  )}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Added by {r.added_by_name ?? 'Officer'} · {stamp(r.created_at)}
                  {r.added_reason ? ` · ${r.added_reason}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {r.acknowledged_at ? (
                  <Badge className="gap-1 bg-emerald-500/10 text-[9px] text-emerald-700 hover:opacity-100">
                    <CheckCircle2 className="h-3 w-3" />
                    Confirmed {stamp(r.acknowledged_at)}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 border-amber-500/40 text-[9px] text-amber-700">
                    <BellRing className="h-3 w-3" />
                    Notified {stamp(r.notified_at)} · not confirmed
                  </Badge>
                )}
                {canManage && current.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-1.5 text-[10px] text-destructive"
                    onClick={() => setRemoving(r)}
                  >
                    <UserMinus className="h-3 w-3" />
                    Take off
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {past.length > 0 && (
        <div className="mt-2 border-t border-border/60 pt-1.5">
          <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            Previously on it ({past.length})
          </p>
          <div className="mt-1 space-y-1">
            {past.map((r) => (
              <div key={r.user_id} className="rounded-lg bg-background/50 px-2 py-1.5">
                <p className="truncate text-[11px] font-semibold text-muted-foreground line-through">
                  {r.full_name ?? 'Staff member'}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Taken off by {r.removed_by_name ?? 'Officer'} · {stamp(r.removed_at)}
                  {r.remove_reason ? ` · ${r.remove_reason}` : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <AddPeopleDialog concern={concern} current={current} open={addOpen} onClose={() => setAddOpen(false)} />
      <RemovePersonDialog concern={concern} person={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
