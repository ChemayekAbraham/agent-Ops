import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, MapPin, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';

/**
 * Facilitation request form — Platform Sales Officers only.
 *
 * Writes one `staff_requisitions` row with request_kind = 'facilitation', then
 * the activity plan rows into `staff_facilitation_plan_lines` (seq from 1).
 * Database errors (including the 7-day accountability lock message) are shown
 * verbatim.
 */

interface PlanRow {
  purpose: string;
  location: string;
  amount: string;
}

const EMPTY_ROW: PlanRow = { purpose: '', location: '', amount: '' };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
}

export function FacilitationRequestDialog({ open, onOpenChange, onSubmitted }: Props) {
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState<PlanRow[]>([{ ...EMPTY_ROW }]);
  const [submitting, setSubmitting] = useState(false);

  const requested = Number(amount) || 0;
  const planTotal = useMemo(
    () => rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
    [rows],
  );
  const rowsComplete = rows.length > 0 && rows.every(
    (r) => r.purpose.trim() && r.location.trim() && (Number(r.amount) || 0) > 0,
  );
  const balanced = requested > 0 && planTotal === requested;
  const canSubmit = Boolean(
    title.trim() && reason.trim().length >= 10 && rowsComplete && balanced && !submitting,
  );

  const reset = () => {
    setTitle('');
    setAmount('');
    setReason('');
    setRows([{ ...EMPTY_ROW }]);
  };

  const updateRow = (index: number, patch: Partial<PlanRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const submit = async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) { toast.error('Please sign in again'); return; }

    setSubmitting(true);
    const { data: req, error } = await supabase
      .from('staff_requisitions')
      .insert({
        requester_id: uid,
        title: title.trim(),
        amount: requested,
        reason: reason.trim(),
        request_kind: 'facilitation',
      })
      .select('id')
      .single();

    if (error || !req) {
      setSubmitting(false);
      // Verbatim — the accountability lock names how many earlier
      // facilitations are unaccounted for.
      toast.error(error?.message || 'Could not submit your facilitation request');
      return;
    }

    const { error: lineError } = await supabase
      .from('staff_facilitation_plan_lines')
      .insert(rows.map((r, i) => ({
        requisition_id: req.id,
        seq: i + 1,
        purpose: r.purpose.trim(),
        location: r.location.trim(),
        amount: Number(r.amount),
      })));

    setSubmitting(false);

    if (lineError) {
      toast.error(lineError.message);
      return;
    }

    toast.success('Facilitation request submitted');
    reset();
    onOpenChange(false);
    onSubmitted?.();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request facilitation</DialogTitle>
          <DialogDescription>
            Reviewed by the COO, then disbursed by the CFO. You must account for every
            facilitation within 7 days of receiving it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="fac-title">What is it for</Label>
            <Input
              id="fac-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Partner visits in Mukono for September"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="fac-amount">Total amount requested (UGX)</Label>
            <Input
              id="fac-amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="250000"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="fac-reason">Why do you need it</Label>
            <Textarea
              id="fac-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain the need and the expected outcome (min 10 characters)"
            />
          </div>

          <div className="space-y-2 rounded-xl border p-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <MapPin className="h-4 w-4 text-primary" /> Activity plan
            </p>
            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={i} className="grid gap-2 rounded-lg border bg-muted/20 p-2 sm:grid-cols-[1fr_1fr_120px_auto]">
                  <Input
                    value={row.purpose}
                    onChange={(e) => updateRow(i, { purpose: e.target.value })}
                    placeholder="Purpose / activity"
                  />
                  <Input
                    value={row.location}
                    onChange={(e) => updateRow(i, { location: e.target.value })}
                    placeholder="Location / places to visit"
                  />
                  <Input
                    inputMode="numeric"
                    value={row.amount}
                    onChange={(e) => updateRow(i, { amount: e.target.value.replace(/[^0-9.]/g, '') })}
                    placeholder="Amount"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={rows.length === 1}
                    onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRows((prev) => [...prev, { ...EMPTY_ROW }])}
            >
              <Plus className="mr-2 h-4 w-4" /> Add a row
            </Button>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm">
              <span className="text-muted-foreground">Plan total</span>
              <span className={balanced ? 'font-semibold text-primary' : 'font-semibold text-destructive'}>
                {formatUGX(planTotal)} of {formatUGX(requested)}
              </span>
            </div>
            {!balanced && (
              <p className="text-xs text-muted-foreground">
                The plan rows must add up to exactly the amount requested before you can submit.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default FacilitationRequestDialog;
