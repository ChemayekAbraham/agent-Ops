import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Pencil, CalendarCheck, CalendarClock, PhoneCall, FileText } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

interface NoteRow {
  id: string;
  partner_name: string | null;
  amount: number | null;
  status: string | null;
  created_at: string;
  recorded_on: string | null;
  fulfilment_due_on: string | null;
  follow_up_status: string | null;
  last_followed_up_on: string | null;
  follow_up_note: string | null;
  phone_number: string | null;
  total_collected: number | null;
}

const statusClass: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-300',
  activated: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  fulfilled: 'bg-blue-100 text-blue-800 border-blue-300',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

const FOLLOW_UP_OPTIONS: { value: string; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'Following up' },
  { value: 'awaiting_payment', label: 'Awaiting payment' },
  { value: 'unreachable', label: 'Could not reach' },
  { value: 'done', label: 'Closed' },
];

const followUpLabel = (v?: string | null) =>
  FOLLOW_UP_OPTIONS.find((o) => o.value === (v ?? 'not_started'))?.label ?? 'Not started';

const followUpClass: Record<string, string> = {
  not_started: 'bg-muted text-muted-foreground border-border',
  in_progress: 'bg-sky-100 text-sky-800 border-sky-300',
  awaiting_payment: 'bg-amber-100 text-amber-800 border-amber-300',
  unreachable: 'bg-rose-100 text-rose-800 border-rose-300',
  done: 'bg-emerald-100 text-emerald-800 border-emerald-300',
};

function fmtDate(v?: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function toDateInput(v?: string | null) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Officer-facing promissory notes for a single agent: full list with follow-up
 * tracking and inline editing, so an officer never has to leave the agent page.
 */
export function AgentPromissoryNotesSection({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<NoteRow | null>(null);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [recorded, setRecorded] = useState('');
  const [due, setDue] = useState('');
  const [followUp, setFollowUp] = useState('not_started');
  const [followedOn, setFollowedOn] = useState('');
  const [followNote, setFollowNote] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: notes, isLoading } = useQuery({
    queryKey: ['agent-promissory-notes-section', agentId],
    enabled: !!agentId,
    staleTime: 30_000,
    queryFn: async (): Promise<NoteRow[]> => {
      const { data, error } = await supabase
        .from('promissory_notes')
        .select('id, partner_name, amount, status, created_at, recorded_on, fulfilment_due_on, follow_up_status, last_followed_up_on, follow_up_note, phone_number, total_collected')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as NoteRow[];
    },
  });

  const openEdit = (n: NoteRow) => {
    setEditing(n);
    setName(n.partner_name ?? '');
    setAmount(String(n.amount ?? ''));
    setRecorded(toDateInput(n.recorded_on ?? n.created_at));
    setDue(toDateInput(n.fulfilment_due_on));
    setFollowUp(n.follow_up_status ?? 'not_started');
    setFollowedOn(toDateInput(n.last_followed_up_on));
    setFollowNote(n.follow_up_note ?? '');
  };

  const save = async () => {
    if (!editing) return;
    if (!name.trim()) { toast.error('Enter the partner name'); return; }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (recorded && due && due < recorded) { toast.error('The promised date cannot be before the date recorded'); return; }
    const statusChanged = followUp !== (editing.follow_up_status ?? 'not_started');
    const noteChanged = followNote.trim() !== (editing.follow_up_note ?? '');
    const autoToday = new Date().toISOString().slice(0, 10);
    const followedDate =
      followedOn || ((statusChanged || noteChanged) && followUp !== 'not_started' ? autoToday : '');
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from('promissory_notes')
        .update({
          partner_name: name.trim(),
          amount: amt,
          recorded_on: recorded || null,
          fulfilment_due_on: due || null,
          follow_up_status: followUp,
          last_followed_up_on: followedDate || null,
          follow_up_note: followNote.trim() || null,
        })
        .eq('id', editing.id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('You do not have permission to edit this note');
      toast.success('Note updated');
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ['agent-promissory-notes-section', agentId] });
      await qc.invalidateQueries({ queryKey: ['agent-promissory-notes-tile', agentId] });
      await qc.invalidateQueries({ queryKey: ['agent-promissory-notes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the note');
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (!notes?.length) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground">
        <FileText className="mx-auto mb-2 h-5 w-5 opacity-50" />
        This agent has not recorded any promissory notes.
      </div>
    );
  }

  const totalPromised = notes.reduce((s, n) => s + Number(n.amount ?? 0), 0);
  const totalCollected = notes.reduce((s, n) => s + Number(n.total_collected ?? 0), 0);

  return (
    <>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border bg-card/60 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Notes</p>
            <p className="text-sm font-bold tabular-nums">{notes.length}</p>
          </div>
          <div className="rounded-xl border bg-card/60 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Promised</p>
            <p className="text-sm font-bold tabular-nums">{formatUGX(totalPromised)}</p>
          </div>
          <div className="rounded-xl border bg-card/60 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Collected</p>
            <p className="text-sm font-bold tabular-nums">{formatUGX(totalCollected)}</p>
          </div>
        </div>

        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-xl border bg-card/60 p-2.5 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="text-sm font-semibold truncate">{n.partner_name || 'Partner'}</span>
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${statusClass[n.status ?? 'pending'] ?? statusClass.pending}`}>
                    {n.status ?? 'pending'}
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${followUpClass[n.follow_up_status ?? 'not_started'] ?? followUpClass.not_started}`}>
                    {followUpLabel(n.follow_up_status)}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <CalendarCheck className="h-3 w-3" /> Recorded {fmtDate(n.recorded_on ?? n.created_at)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock className="h-3 w-3" /> Promised {fmtDate(n.fulfilment_due_on)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <PhoneCall className="h-3 w-3" /> Followed up {fmtDate(n.last_followed_up_on)}
                  </span>
                  {n.phone_number && <span>{n.phone_number}</span>}
                </div>
                {n.follow_up_note && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{n.follow_up_note}</p>
                )}
                <p className="mt-0.5 text-xs font-bold tabular-nums">{formatUGX(n.amount ?? 0)}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2 shrink-0"
                aria-label={`Edit note for ${n.partner_name || 'partner'}`}
                onClick={() => openEdit(n)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <Dialog open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit note</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ops-pn-name">Partner name</Label>
              <Input id="ops-pn-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ops-pn-amount">Amount (UGX)</Label>
              <Input id="ops-pn-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ops-pn-recorded">Date recorded</Label>
                <Input id="ops-pn-recorded" type="date" value={recorded} onChange={(e) => setRecorded(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ops-pn-due">Date promised</Label>
                <Input id="ops-pn-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ops-pn-followup">Follow-up</Label>
              <Select value={followUp} onValueChange={setFollowUp}>
                <SelectTrigger id="ops-pn-followup"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FOLLOW_UP_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ops-pn-followed-on">Last followed up</Label>
              <Input id="ops-pn-followed-on" type="date" value={followedOn} onChange={(e) => setFollowedOn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ops-pn-follow-note">Follow-up note (optional)</Label>
              <Textarea id="ops-pn-follow-note" rows={2} value={followNote} onChange={(e) => setFollowNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default AgentPromissoryNotesSection;
