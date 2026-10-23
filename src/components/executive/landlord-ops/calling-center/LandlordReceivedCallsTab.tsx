import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  RECEIVED_STATUS_LABEL,
  type ReceivedCall,
  type ReceivedCallStatus,
  useReceivedCalls,
  useRecordReceivedCall,
  useUpdateReceivedCall,
} from '@/hooks/useCallingConcerns';
import { LandlordForwardConcernDialog } from './LandlordForwardConcernDialog';
import {
  PhoneIncoming,
  Plus,
  Send,
  Pencil,
  Search,
  Clock,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

export function LandlordReceivedCallsTab() {
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [editing, setEditing] = useState<ReceivedCall | null>(null);
  const [forwarding, setForwarding] = useState<ReceivedCall | null>(null);

  const list = useReceivedCalls(days);

  // Filter to landlord inbound calls (or general inbound calls matching search)
  const rows = useMemo(() => {
    const all = (list.data ?? []).filter(
      (r) => !r.linked_kind || r.linked_kind === 'landlord',
    );
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.caller_name, r.caller_phone ?? '', r.concern ?? '', r.notes ?? '', r.recorded_by_name ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [list.data, search]);

  const totalToday = rows.filter(
    (r) => new Date(r.called_at).toDateString() === new Date().toDateString(),
  ).length;
  const openCount = rows.filter((r) => r.status === 'open' || r.status === 'following_up').length;
  const resolvedCount = rows.filter((r) => r.status === 'resolved' || r.status === 'closed').length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card className="p-3">
          <div className="text-[11px] text-muted-foreground">Total Logged</div>
          <div className="text-xl font-bold tabular-nums">{rows.length}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-muted-foreground">Received Today</div>
          <div className="text-xl font-bold tabular-nums text-primary">{totalToday}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-muted-foreground">Open / Following Up</div>
          <div className="text-xl font-bold tabular-nums text-amber-600">{openCount}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] text-muted-foreground">Resolved</div>
          <div className="text-xl font-bold tabular-nums text-emerald-600">{resolvedCount}</div>
        </Card>
      </div>

      <Card className="p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search landlord name, phone, or notes…"
            className="pl-8 h-8 text-xs"
          />
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="h-8 text-xs w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 Days</SelectItem>
            <SelectItem value="30">Last 30 Days</SelectItem>
            <SelectItem value="90">Last 90 Days</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setLogOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> Log Inbound Landlord Call
        </Button>
      </Card>

      <Card className="divide-y">
        {list.isLoading && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Loading received landlord calls…
          </div>
        )}
        {!list.isLoading && rows.length === 0 && (
          <div className="p-8 text-center space-y-2">
            <PhoneIncoming className="h-8 w-8 text-muted-foreground mx-auto" />
            <div className="text-sm font-medium">No inbound landlord calls logged yet</div>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              When a landlord calls into Welile (on a staff phone, WhatsApp, or office line), log it here so their inquiry is captured and can be forwarded for review.
            </p>
            <Button size="sm" variant="outline" onClick={() => setLogOpen(true)} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Log First Inbound Call
            </Button>
          </div>
        )}
        {rows.map((r) => {
          const statusLabel =
            RECEIVED_STATUS_LABEL[r.status as ReceivedCallStatus] ?? r.status;
          return (
            <div
              key={r.id}
              className="p-3 flex flex-col sm:flex-row sm:items-start justify-between gap-2 text-xs"
            >
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm">{r.caller_name}</span>
                  {r.caller_phone && (
                    <span className="font-mono text-muted-foreground">{r.caller_phone}</span>
                  )}
                  <Badge
                    variant={r.status === 'resolved' ? 'default' : 'secondary'}
                    className="text-[10px] gap-1"
                  >
                    {r.status === 'resolved' ? (
                      <CheckCircle2 className="h-2.5 w-2.5" />
                    ) : (
                      <AlertCircle className="h-2.5 w-2.5" />
                    )}
                    {statusLabel}
                  </Badge>
                </div>
                <p className="text-foreground font-medium whitespace-pre-wrap">{r.concern}</p>
                {r.notes && <p className="text-muted-foreground whitespace-pre-wrap">{r.notes}</p>}
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDistanceToNow(new Date(r.called_at), { addSuffix: true })} by{' '}
                    {r.recorded_by_name ?? 'Staff'}
                  </span>
                  {r.follow_up_note && <span>Follow-up: {r.follow_up_note}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={() => setEditing(r)}
                >
                  <Pencil className="h-3 w-3" /> Update
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={() => setForwarding(r)}
                >
                  <Send className="h-3 w-3" /> Forward Issue
                </Button>
              </div>
            </div>
          );
        })}
      </Card>

      <LogInboundLandlordCallDialog open={logOpen} onOpenChange={setLogOpen} />

      {editing && (
        <EditInboundLandlordCallDialog
          row={editing}
          open={!!editing}
          onOpenChange={(v) => !v && setEditing(null)}
        />
      )}

      {forwarding && (
        <LandlordForwardConcernDialog
          open={!!forwarding}
          onOpenChange={(v) => !v && setForwarding(null)}
          sourceKind="received_call"
          defaultSubjectId={forwarding.linked_user_id}
          defaultSubjectName={forwarding.caller_name}
          defaultSubjectPhone={forwarding.caller_phone}
          defaultSummary={`Inbound Landlord Call: ${forwarding.caller_name}`}
          defaultDetails={forwarding.concern}
          receivedCallId={forwarding.id}
        />
      )}
    </div>
  );
}

function LogInboundLandlordCallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const record = useRecordReceivedCall();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [concern, setConcern] = useState('');
  const [status, setStatus] = useState<ReceivedCallStatus>('open');
  const [followUpNote, setFollowUpNote] = useState('');

  const reset = () => {
    setName('');
    setPhone('');
    setConcern('');
    setStatus('open');
    setFollowUpNote('');
  };

  const submit = async () => {
    if (!name.trim() || !concern.trim()) return;
    try {
      await record.mutateAsync({
        caller_name: name.trim(),
        caller_phone: phone.trim() || null,
        linked_kind: 'landlord',
        concern: concern.trim(),
        status,
        follow_up_note: followUpNote.trim() || null,
      });
      toast.success('Inbound landlord call recorded.');
      reset();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not record inbound call');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <PhoneIncoming className="h-4 w-4 text-primary" /> Log Inbound Landlord Call
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <Label className="text-xs">Landlord Name *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
              />
            </div>
            <div>
              <Label className="text-xs">Caller Phone</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0772..."
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as ReceivedCallStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="following_up">Following up</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">What the Landlord Said (Inquiry / Feedback) *</Label>
            <Textarea
              rows={4}
              value={concern}
              onChange={(e) => setConcern(e.target.value)}
              placeholder="Capture the landlord's inquiry, Rent Plan or payout question, and what you advised…"
            />
          </div>

          <div>
            <Label className="text-xs">Follow-up Note (Optional)</Label>
            <Input
              value={followUpNote}
              onChange={(e) => setFollowUpNote(e.target.value)}
              placeholder="e.g. Confirm payout number review on Friday"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={record.isPending || !name.trim() || !concern.trim()}
          >
            {record.isPending ? 'Saving…' : 'Save Call Log'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditInboundLandlordCallDialog({
  row,
  open,
  onOpenChange,
}: {
  row: ReceivedCall;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const update = useUpdateReceivedCall();
  const [status, setStatus] = useState<ReceivedCallStatus>(
    (row.status as ReceivedCallStatus) || 'open',
  );
  const [notes, setNotes] = useState(row.notes ?? '');
  const [followUpNote, setFollowUpNote] = useState(row.follow_up_note ?? '');

  const save = async () => {
    try {
      await update.mutateAsync({
        id: row.id,
        status,
        notes: notes.trim() || null,
        follow_up_note: followUpNote.trim() || null,
      });
      toast.success('Inbound call updated.');
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not update inbound call');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            Update Inbound Call — {row.caller_name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2.5 text-sm">
          <div>
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as ReceivedCallStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="following_up">Following up</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Notes / Resolution</Label>
            <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Follow-up Note</Label>
            <Input value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
