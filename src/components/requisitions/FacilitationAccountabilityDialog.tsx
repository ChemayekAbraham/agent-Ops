import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { FileText, Loader2, Search, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';

/**
 * Accountability report for a disbursed facilitation.
 *
 * Writes one `staff_requisition_usage_reports` row (including amount_received,
 * places_visited, activities_carried_out and results_achieved — all required by
 * a database trigger) and links the selected promissory notes into
 * `staff_facilitation_notes`. Note numbers are never typed: the officer
 * searches and selects existing notes.
 */

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

interface NoteRow {
  id: string;
  partner_name: string;
  amount: number;
  recorded_on: string;
}

interface Props {
  requisitionId: string;
  requisitionCode: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
}

export function FacilitationAccountabilityDialog({
  requisitionId, requisitionCode, open, onOpenChange, onSubmitted,
}: Props) {
  const [received, setReceived] = useState('');
  const [spent, setSpent] = useState('');
  const [places, setPlaces] = useState('');
  const [activities, setActivities] = useState('');
  const [results, setResults] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<NoteRow[]>([]);
  const [selected, setSelected] = useState<NoteRow[]>([]);

  const balance = (Number(received) || 0) - (Number(spent) || 0);
  const notesValue = useMemo(
    () => selected.reduce((sum, n) => sum + Number(n.amount || 0), 0),
    [selected],
  );

  const runSearch = useCallback(async (term: string) => {
    if (term.trim().length < 3) { setMatches([]); return; }
    setSearching(true);
    const { data, error } = await supabase
      .from('promissory_notes')
      .select('id, partner_name, amount, recorded_on')
      .ilike('partner_name', `%${term.trim()}%`)
      .order('recorded_on', { ascending: false })
      .limit(20);
    setSearching(false);
    if (error) { toast.error(error.message); return; }
    setMatches((data || []) as unknown as NoteRow[]);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => { void runSearch(search); }, 350);
    return () => window.clearTimeout(t);
  }, [search, runSearch]);

  const pickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(e.target.files || []);
    e.target.value = '';
    const valid: File[] = [];
    for (const f of chosen) {
      if (!ALLOWED_TYPES.includes(f.type)) { toast.error(`${f.name} must be a PDF or a photo`); continue; }
      if (f.size > MAX_BYTES) { toast.error(`${f.name} is larger than 10MB`); continue; }
      valid.push(f);
    }
    setFiles((prev) => [...prev, ...valid].slice(0, 10));
  };

  const submit = async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) { toast.error('Please sign in again'); return; }

    const amountReceived = Number(received);
    const amountUsed = Number(spent);
    if (!Number.isFinite(amountReceived) || amountReceived <= 0) { toast.error('Enter the amount you received'); return; }
    if (!Number.isFinite(amountUsed) || amountUsed < 0) { toast.error('Enter the amount you spent'); return; }
    if (amountUsed > amountReceived) { toast.error('You cannot spend more than you received'); return; }
    if (!places.trim()) { toast.error('List the places you visited'); return; }
    if (!activities.trim()) { toast.error('Describe the activities you carried out'); return; }
    if (!results.trim()) { toast.error('Describe the results you achieved'); return; }
    if (files.length === 0) { toast.error('Attach at least one receipt or proof of spending'); return; }

    setSaving(true);

    const attachmentPaths: string[] = [];
    for (const file of files) {
      const form = new FormData();
      form.append('requisition_id', requisitionId);
      form.append('file', file);
      const { data: up, error: upErr } = await invokeEdgeFunction<{ path: string }>(
        'staff-requisition-add-attachment',
        { body: form, errorTitle: `Could not attach ${file.name}` },
      );
      if (upErr || !up?.path) { setSaving(false); return; }
      attachmentPaths.push(up.path);
    }

    const { error } = await supabase.from('staff_requisition_usage_reports').insert({
      requisition_id: requisitionId,
      requester_id: uid,
      amount_received: amountReceived,
      amount_used: amountUsed,
      places_visited: places.trim(),
      activities_carried_out: activities.trim(),
      results_achieved: results.trim(),
      summary: results.trim(),
      attachment_paths: attachmentPaths.length ? attachmentPaths : null,
    });

    if (error) {
      setSaving(false);
      toast.error(error.message);
      return;
    }

    if (selected.length) {
      const { error: noteError } = await supabase
        .from('staff_facilitation_notes')
        .insert(selected.map((n) => ({
          requisition_id: requisitionId,
          promissory_note_id: n.id,
          linked_by: uid,
        })));
      if (noteError) {
        setSaving(false);
        toast.error(noteError.message);
        return;
      }
    }

    setSaving(false);
    toast.success('Accountability report submitted');
    onOpenChange(false);
    onSubmitted?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Account for {requisitionCode}</DialogTitle>
          <DialogDescription>
            Every field here is required. Attach receipts and link the promissory notes you raised.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="fac-received">Amount received</Label>
              <Input
                id="fac-received"
                inputMode="numeric"
                value={received}
                onChange={(e) => setReceived(e.target.value.replace(/[^0-9.]/g, ''))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fac-spent">Amount spent</Label>
              <Input
                id="fac-spent"
                inputMode="numeric"
                value={spent}
                onChange={(e) => setSpent(e.target.value.replace(/[^0-9.]/g, ''))}
              />
            </div>
            <div className="space-y-2">
              <Label>Balance</Label>
              <Input readOnly value={formatUGX(balance)} className="bg-muted/40" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="fac-places">Places visited</Label>
            <Textarea id="fac-places" rows={2} value={places} onChange={(e) => setPlaces(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fac-activities">Activities carried out</Label>
            <Textarea id="fac-activities" rows={3} value={activities} onChange={(e) => setActivities(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fac-results">Results achieved</Label>
            <Textarea id="fac-results" rows={3} value={results} onChange={(e) => setResults(e.target.value)} />
          </div>

          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-sm font-semibold">Promissory notes raised</p>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by partner name (3 letters or more)"
                className="pl-8"
              />
              {searching && <Loader2 className="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
            </div>

            {matches.length > 0 && (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {matches.map((n) => {
                  const picked = selected.some((s) => s.id === n.id);
                  return (
                    <button
                      key={n.id}
                      type="button"
                      disabled={picked}
                      onClick={() => setSelected((prev) => [...prev, n])}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left text-xs hover:bg-muted/40 disabled:opacity-50"
                    >
                      <span className="truncate">{n.partner_name}</span>
                      <span className="shrink-0 font-medium">{formatUGX(Number(n.amount))}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {new Date(n.recorded_on).toLocaleDateString('en-GB', { dateStyle: 'medium' })}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {selected.length > 0 && (
              <div className="space-y-1 border-t pt-2">
                {selected.map((n) => (
                  <div key={n.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">{n.partner_name}</span>
                    <span className="font-medium">{formatUGX(Number(n.amount))}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setSelected((prev) => prev.filter((s) => s.id !== n.id))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                  {selected.length} {selected.length === 1 ? 'note' : 'notes'} • {formatUGX(notesValue)}
                </Badge>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">
              Receipts or proof of spending
              <span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">At least one required. Photo or PDF, up to 10MB each.</p>
            <div className="rounded-xl border border-dashed bg-muted/20 p-3 text-center">
              <label className="flex cursor-pointer flex-col items-center gap-1">
                <Upload className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-semibold text-primary">Attach receipts</span>
                <input
                  type="file"
                  multiple
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={pickFiles}
                />
              </label>
            </div>
            {files.map((f, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg border p-2 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate">{f.name}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default FacilitationAccountabilityDialog;
