import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { ccErrorText, CC_NOTE_MIN_LENGTH, type CcCallingHub, type CcSeverity } from '@/hooks/useCcCallingHub';

const SEVERITIES: CcSeverity[] = ['normal', 'high', 'critical'];

export function RecordOutcomeDialog({
  hub,
  attempt,
  onClose,
  awareness30mSection,
}: {
  hub: CcCallingHub;
  attempt: { id: string; cycle_row_id: string; name: string } | null;
  onClose: () => void;
  /**
   * Optional 30M awareness fields rendered inside the Engaged tab, just above
   * the submit button. Only passed from TenantCallingCenter — the standard
   * Calling Hub leaves this undefined so the dialog is unchanged there.
   */
  awareness30mSection?: ReactNode;
}) {
  const [categoryId, setCategoryId] = useState('');
  const [severity, setSeverity] = useState<CcSeverity>('normal');
  const [note, setNote] = useState('');
  const [routedTo, setRoutedTo] = useState('');
  const [consent, setConsent] = useState(false);
  const [dueAt, setDueAt] = useState('');

  const category = useMemo(() => hub.categories.find((c) => c.id === categoryId) ?? null, [hub.categories, categoryId]);
  const locked = !!category?.locked;

  const reset = () => {
    setCategoryId('');
    setSeverity('normal');
    setNote('');
    setRoutedTo('');
    setConsent(false);
    setDueAt('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const submitEngaged = () => {
    if (!attempt) return;
    if (!categoryId) return toast.error('Choose a feedback category.');
    if (!note.trim()) return toast.error('A note is required for an engaged call.');
    if (note.trim().length < CC_NOTE_MIN_LENGTH) {
      return toast.error(`Please write at least ${CC_NOTE_MIN_LENGTH} characters describing what the customer said.`);
    }
    hub.recordEngaged.mutate(
      {
        attemptId: attempt.id,
        categoryId,
        severity,
        note: note.trim(),
        routedToStaffId: locked ? null : routedTo || null,
        consent,
      },
      {
        onSuccess: () => {
          toast.success('Engaged call recorded and routed.');
          close();
        },
        onError: (e) => toast.error(ccErrorText(e)),
      },
    );
  };

  const submitCallback = () => {
    if (!attempt) return;
    if (!dueAt) return toast.error('Set the callback date and time.');
    hub.recordCallback.mutate(
      { attemptId: attempt.id, dueAt: new Date(dueAt).toISOString() },
      {
        onSuccess: () => {
          toast.success('Callback booked.');
          close();
        },
        onError: (e) => toast.error(ccErrorText(e)),
      },
    );
  };

  return (
    <Dialog open={!!attempt} onOpenChange={(o) => !o && close()}>
      {/* Capped height + scroll so the submit button stays reachable with the
          on-screen keyboard open on a handset. */}
      <DialogContent className="max-h-[85svh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Record outcome — {attempt?.name}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="engaged">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="engaged">Engaged</TabsTrigger>
            <TabsTrigger value="callback">Callback booked</TabsTrigger>
          </TabsList>

          <TabsContent value="engaged" className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Feedback category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger><SelectValue placeholder="Select a category" /></SelectTrigger>
                <SelectContent>
                  {hub.categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Severity</Label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as CcSeverity)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                Note (required, min {CC_NOTE_MIN_LENGTH} characters)
              </Label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="max-h-40"
                placeholder="What did they say, in their words?"
              />
              <p className={`text-[11px] font-medium ${note.trim().length >= CC_NOTE_MIN_LENGTH ? 'text-muted-foreground' : 'text-amber-600'}`}>
                {note.trim().length}/{CC_NOTE_MIN_LENGTH} characters
              </p>
            </div>

            {locked ? (
              <p className="flex items-start gap-2 rounded-lg bg-muted px-2 py-2 text-xs font-medium">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This category is locked. It routes automatically to the required role
                {category?.default_owner_role ? ` (${String(category.default_owner_role).replace(/_/g, ' ')})` : ''} and
                cannot be assigned to a person of your choosing.
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs">Route to staff</Label>
                <Select value={routedTo} onValueChange={setRoutedTo}>
                  <SelectTrigger><SelectValue placeholder="Leave to the default owner" /></SelectTrigger>
                  <SelectContent>
                    {hub.staffOptions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <label className="flex items-center gap-2 text-xs font-medium">
              <Checkbox checked={consent} onCheckedChange={(v) => setConsent(!!v)} />
              They consented to being contacted about this
            </label>

            {/* 30M Awareness section — only present in TenantCallingCenter */}
            {awareness30mSection}

            <Button className="w-full" onClick={submitEngaged} disabled={hub.recordEngaged.isPending}>
              {hub.recordEngaged.isPending ? 'Recording…' : 'Record engaged call'}
            </Button>
          </TabsContent>

          <TabsContent value="callback" className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Callback due</Label>
              <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
            <Button className="w-full" onClick={submitCallback} disabled={hub.recordCallback.isPending}>
              {hub.recordCallback.isPending ? 'Booking…' : 'Book callback'}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
