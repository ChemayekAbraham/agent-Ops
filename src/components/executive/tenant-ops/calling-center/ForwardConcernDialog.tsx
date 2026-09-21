/**
 * Forward a concern to a member of staff.
 *
 * Works from both call sources — an outbound recorded call or a received call —
 * and only offers people with a live employee role, with Platform Sales Officers
 * left out. The hand-off itself is written by a SECURITY DEFINER function, which
 * also opens the concern's history trail.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, Check, Forward, Paperclip, Search, X } from 'lucide-react';
import {
  CONCERN_ATTACHMENT_MAX_BYTES,
  uploadConcernAttachments,
} from '@/hooks/useConcernAttachments';
import { CCBlock, CCDialogHeading } from './ccUi';
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
  addReviewer = false,
  onClose,
}: {
  open: boolean;
  source: ForwardConcernSource | null;
  addReviewer?: boolean;
  onClose: () => void;
}) {
  const staff = useConcernStaffOptions();
  const forward = useForwardConcern();
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');
  const [priority, setPriority] = useState('normal');
  const [dueHours, setDueHours] = useState(DEFAULT_DUE);
  const [to, setTo] = useState<string[]>([]);
  const [staffSearch, setStaffSearch] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (picked: FileList | null) => {
    if (!picked) return;
    const tooBig = Array.from(picked).find((f) => f.size > CONCERN_ATTACHMENT_MAX_BYTES);
    if (tooBig) {
      toast.error(`${tooBig.name} is larger than 10MB.`);
      return;
    }
    setFiles((prev) => [...prev, ...Array.from(picked)]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };


  // Reset only when the dialog opens for a different call — the parent rebuilds the
  // `source` object on every render, so depending on the object itself would wipe the
  // chosen staff member the moment anything else re-rendered.
  const sourceKey = source
    ? `${source.source_kind}:${source.received_call_id ?? ''}:${source.cycle_row_id ?? ''}`
    : '';

  useEffect(() => {
    if (!open) return;
    setTitle(source?.suggestedTitle?.slice(0, 120) ?? '');
    setContext(source?.suggestedContext ?? '');
    setPriority('normal');
    setDueHours(DEFAULT_DUE);
    setTo([]);
    setStaffSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceKey]);

  const people = useMemo(() => {
    const list = staff.data ?? [];
    const q = staffSearch.trim().toLowerCase();
    return q ? list.filter((p) => p.full_name.toLowerCase().includes(q)) : list;
  }, [staff.data, staffSearch]);

  const chosen = useMemo(
    () => (staff.data ?? []).filter((p) => to.includes(p.user_id)),
    [staff.data, to],
  );

  const toggle = (userId: string) =>
    setTo((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));

  const submit = async () => {
    if (!source) return;
    if (title.trim().length < 5) {
      toast.error('Give the concern a short title (at least 5 characters).');
      return;
    }
    if (to.length === 0) {
      toast.error(addReviewer ? 'Choose at least one person to add.' : 'Choose at least one person to handle this.');
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
      const concernId = await forward.mutateAsync(payload);
      if (files.length > 0) {
        setUploading(true);
        try {
          await uploadConcernAttachments(concernId, files);
        } catch (e: any) {
          toast.error(
            `The concern was saved, but a file did not attach: ${e?.message ?? 'upload failed'}. You can attach it again from the concern.`,
          );
        } finally {
          setUploading(false);
        }
      }
      const many = to.length > 1;
      toast.success(
        addReviewer
          ? many
            ? `${to.length} people added to this concern.`
            : 'Person added to this concern.'
          : many
            ? `Forwarded to ${to.length} people. It now shows in each of their My Space.`
            : 'Forwarded. It now shows in their My Space.',
      );
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not forward this concern.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle asChild>
            <CCDialogHeading
              icon={Forward}
              title={addReviewer ? 'Add another reviewer' : 'Forward this concern'}
              hint={
                addReviewer
                  ? 'Everyone added shares the same concern and the same history.'
                  : 'One concern per call. The person you choose sees it in their My Space.'
              }
            />
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {source?.caller_name && (
            <CCBlock className="px-2.5 py-2 text-[11px]">
              About <span className="font-semibold">{source.caller_name}</span> ·{' '}
              {source.source_kind === 'received_call' ? 'call they made to us' : 'call we made to them'}
            </CCBlock>
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
            <Label className="text-[11px] font-semibold">
              {addReviewer ? 'Who else should review it?' : 'Who should handle it?'}
            </Label>
            <p className="px-1 text-[11px] text-muted-foreground">
              Tap as many names as you need — everyone chosen shares the same concern and the same history.
            </p>
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
              <p className="flex items-start gap-1.5 rounded-xl border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] font-semibold text-warning">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                No matching staff member with an active employee role.
              </p>
            ) : (
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-border bg-muted/20 p-1.5">
                {people.map((p) => {
                  const picked = to.includes(p.user_id);
                  return (
                    <button
                      key={p.user_id}
                      type="button"
                      aria-pressed={picked}
                      onClick={() => toggle(p.user_id)}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                        picked
                          ? 'bg-primary font-semibold text-primary-foreground shadow-sm'
                          : 'hover:bg-background hover:shadow-sm'
                      }`}
                    >
                      <span className="truncate">{p.full_name}</span>
                      {picked && (
                        <Check className="ml-2 h-3.5 w-3.5 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {chosen.length > 0 ? (
              <div className="flex flex-wrap gap-1 px-1 pt-1">
                {chosen.map((p) => (
                  <button
                    key={p.user_id}
                    type="button"
                    onClick={() => toggle(p.user_id)}
                    className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary"
                    title="Tap to remove"
                  >
                    {p.full_name}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-1 pt-0.5 text-[11px] font-semibold text-muted-foreground">
                Tap one or more names above.
              </p>
            )}
          </div>


          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" className="h-9 text-xs font-semibold" onClick={submit} disabled={forward.isPending}>
              {forward.isPending
                ? 'Saving…'
                : addReviewer
                  ? to.length > 1
                    ? `Add ${to.length} people`
                    : 'Add reviewer'
                  : to.length > 1
                    ? `Forward to ${to.length} people`
                    : 'Forward concern'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
