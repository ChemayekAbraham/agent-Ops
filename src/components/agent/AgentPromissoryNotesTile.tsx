import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
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
import { FileText, Pencil, Loader2, CalendarCheck, CalendarClock, Download, PhoneCall } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { toast } from 'sonner';
import { downloadPromissoryNotesReportPdf } from '@/lib/promissoryNotesReportPdf';

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
 * Agent dashboard tile: the notes this agent recorded, with the date recorded,
 * the date the partner promised to pay, the partner name, and a quick edit.
 * Editing is only offered while a note is still pending (matches the database rule).
 */
export function AgentPromissoryNotesTile({ agentId, onSeeAll }: { agentId: string; onSeeAll?: () => void }) {
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
  const [exporting, setExporting] = useState(false);

  const downloadReport = async () => {
    hapticTap();
    setExporting(true);
    try {
      const [{ data: rows, error }, { data: auth }] = await Promise.all([
        supabase
          .from('promissory_notes')
          .select('partner_name, amount, status, created_at, recorded_on, fulfilment_due_on, phone_number, whatsapp_number, email, contribution_type, total_collected')
          .eq('agent_id', agentId)
          .order('created_at', { ascending: false }),
        supabase.auth.getUser(),
      ]);
      if (error) throw error;
      if (!rows?.length) { toast.error('No notes to include in the report'); return; }

      let generatedByName: string | null = null;
      const uid = auth?.user?.id;
      if (uid) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', uid)
          .maybeSingle();
        generatedByName = profile?.full_name ?? null;
      }

      await downloadPromissoryNotesReportPdf(rows as never[], {
        generatedByName,
        generatedByEmail: auth?.user?.email ?? null,
      });
      toast.success('Report downloaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the report');
    } finally {
      setExporting(false);
    }
  };

  const { data: notes, isLoading } = useQuery({
    queryKey: ['agent-promissory-notes-tile', agentId],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async (): Promise<NoteRow[]> => {
      const { data, error } = await supabase
        .from('promissory_notes')
        .select('id, partner_name, amount, status, created_at, recorded_on, fulfilment_due_on')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as NoteRow[];
    },
  });

  const openEdit = (n: NoteRow) => {
    hapticTap();
    setEditing(n);
    setName(n.partner_name ?? '');
    setAmount(String(n.amount ?? ''));
    setRecorded(toDateInput(n.recorded_on ?? n.created_at));
    setDue(toDateInput(n.fulfilment_due_on));
  };

  const save = async () => {
    if (!editing) return;
    if (!name.trim()) { toast.error('Enter the partner name'); return; }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (recorded && due && due < recorded) { toast.error('The promised date cannot be before the date recorded'); return; }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('promissory_notes')
        .update({
          partner_name: name.trim(),
          amount: amt,
          recorded_on: recorded || null,
          fulfilment_due_on: due || null,
        })
        .eq('id', editing.id)
        .select('id');
      if (error) throw error;
      toast.success('Note updated');
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ['agent-promissory-notes-tile', agentId] });
      await qc.invalidateQueries({ queryKey: ['agent-promissory-notes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the note');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card className="shadow-sm">
        <CardContent className="p-3 sm:p-4 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <FileText className="h-4.5 w-4.5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold leading-tight">Promissory Notes</p>
                <p className="text-[11px] text-muted-foreground leading-tight">Date recorded · date promised · partner</p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={downloadReport}
                disabled={exporting}
              >
                {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                <span className="ml-1 hidden sm:inline">Report</span>
              </Button>
              {onSeeAll && (
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { hapticTap(); onSeeAll(); }}>
                  See all
                </Button>
              )}
            </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : !notes?.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No notes recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="rounded-xl border bg-card/60 p-2.5 flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-semibold truncate">{n.partner_name || 'Partner'}</span>
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${statusClass[n.status ?? 'pending'] ?? statusClass.pending}`}>
                        {n.status ?? 'pending'}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <CalendarCheck className="h-3 w-3" /> Recorded {fmtDate(n.recorded_on ?? n.created_at)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" /> Promised {fmtDate(n.fulfilment_due_on)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs font-bold tabular-nums">{formatUGX(n.amount ?? 0)}</p>
                  </div>
                  {(n.status ?? 'pending') === 'pending' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 shrink-0"
                      aria-label={`Edit note for ${n.partner_name || 'partner'}`}
                      onClick={() => openEdit(n)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit note</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pn-name">Partner name</Label>
              <Input id="pn-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pn-amount">Amount (UGX)</Label>
              <Input id="pn-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pn-recorded">Date recorded</Label>
                <Input id="pn-recorded" type="date" value={recorded} onChange={(e) => setRecorded(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pn-due">Date promised</Label>
                <Input id="pn-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </div>
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

export default AgentPromissoryNotesTile;
