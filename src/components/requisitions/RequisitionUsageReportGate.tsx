import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ClipboardCheck, Loader2, Paperclip, Wallet, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';

/**
 * RequisitionUsageReportGate — mandatory accountability popup.
 *
 * Shown ONLY to the original requester of a staff requisition, and ONLY once
 * the CFO has approved it (`cfo_decided_at` present, stage = approved).
 * It asks for a usage report; while no report row exists for that requisition
 * the popup re-appears every 5 minutes for as long as the user stays on the
 * dashboard. Dismissing only snoozes it.
 *
 * Writes a single row to `staff_requisition_usage_reports` (RLS: requester
 * only, approved requisitions only). No wallet, ledger or approval logic is
 * touched.
 */

const REMIND_INTERVAL_MS = 5 * 60 * 1000;

/** Mirrors the limits enforced by the staff-requisition-add-attachment function. */
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

interface PendingReq {
  id: string;
  requisition_code: string;
  title: string;
  amount: number;
  approved_amount: number | null;
  reason: string;
  cfo_decided_at: string | null;
  category: string | null;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function RequisitionUsageReportGate() {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingReq[]>([]);
  const [open, setOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [amountUsed, setAmountUsed] = useState('');
  const [summary, setSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);
  const loadedOnceRef = useRef(false);

  const pickReceipt = (file: File | null) => {
    if (!file) { setReceipt(null); return; }
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error('Attach a PDF or a photo (JPG, PNG or WebP)');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('That file is larger than 10MB');
      return;
    }
    setReceipt(file);
  };

  const current = pending[0] ?? null;
  const approvedAmount = useMemo(
    () => (current ? Number(current.approved_amount ?? current.amount) : 0),
    [current],
  );

  const load = useCallback(async () => {
    if (!user?.id) { setPending([]); return; }

    const { data: reqs, error } = await supabase
      .from('staff_requisitions')
      .select('id, requisition_code, title, amount, approved_amount, reason, cfo_decided_at, category')
      .eq('requester_id', user.id)
      .eq('stage', 'approved')
      // Facilitations have their own accountability form (extra required
      // fields), so they must not be nagged by this generic report popup.
      .or('request_kind.is.null,request_kind.neq.facilitation')
      .not('cfo_decided_at', 'is', null)
      .order('cfo_decided_at', { ascending: true })
      .limit(50);

    if (error || !reqs?.length) { setPending([]); return; }

    const ids = reqs.map((r) => r.id);
    const { data: reports, error: reportsError } = await supabase
      .from('staff_requisition_usage_reports')
      .select('requisition_id')
      .in('requisition_id', ids);

    if (reportsError) {
      // Cannot tell which requisitions already have a report — do NOT fall
      // through and show every approved requisition as pending (that would
      // re-nag for ones already reported, and the resulting resubmit fails
      // on staff_requisition_usage_reports_req_uniq). Leave `pending` as-is
      // and retry on the next poll/realtime tick instead.
      console.warn('[RequisitionUsageReportGate] could not check existing reports', reportsError);
      return;
    }

    const reported = new Set((reports || []).map((r) => r.requisition_id));
    setPending((reqs as unknown as PendingReq[]).filter((r) => !reported.has(r.id)));
  }, [user?.id]);

  // Initial load + refresh every 60s (+ on focus) so a newly-paid requisition
  // is picked up. The old Realtime listener was on staff_requisitions, which
  // is not in the publication, so it never fired (doc 147).
  useEffect(() => {
    if (!user?.id) return;
    void load();
  }, [user?.id, load]);
  usePolling(() => load(), 60_000, { enabled: !!user?.id });

  // Open immediately on first discovery, then re-open every 5 minutes while
  // a report is still outstanding.
  useEffect(() => {
    if (!pending.length) { loadedOnceRef.current = false; setOpen(false); return; }
    if (!loadedOnceRef.current) {
      loadedOnceRef.current = true;
      setOpen(true);
    }
    const timer = window.setInterval(() => setOpen(true), REMIND_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pending.length]);

  const submitReport = async () => {
    if (!current || !user?.id) return;
    const used = Number(amountUsed);
    if (!Number.isFinite(used) || used < 0) { toast.error('Enter how much of the money you used'); return; }
    if (summary.trim().length < 20) { toast.error('Explain how the funds were used (at least 20 characters)'); return; }
    if (!receipt) { toast.error('Attach a receipt or proof of payment'); return; }

    setSaving(true);

    // Upload the receipt first (existing storage + auth path) so we never save a
    // report that claims an attachment it does not have.
    let attachmentPaths: string[] | null = null;
    if (receipt) {
      const form = new FormData();
      form.append('requisition_id', current.id);
      form.append('file', receipt);
      const { data: up, error: upErr } = await invokeEdgeFunction<{ path: string }>(
        'staff-requisition-add-attachment',
        { body: form, errorTitle: 'Could not attach your receipt' },
      );
      if (upErr || !up?.path) { setSaving(false); return; }
      attachmentPaths = [up.path];
    }

    const { error } = await supabase.from('staff_requisition_usage_reports').insert({
      requisition_id: current.id,
      requester_id: user.id,
      amount_used: used,
      summary: summary.trim(),
      attachment_paths: attachmentPaths,
    });
    setSaving(false);

    if (error) {
      // A report for this requisition already exists (staff_requisition_usage_reports_req_uniq).
      // This happens when an earlier submit actually succeeded but this popup's
      // local `pending` list was never refreshed (e.g. no staff_requisitions
      // change fired the realtime reload) — resync from the DB instead of
      // leaving a stale, already-done requisition stuck reappearing forever.
      const alreadyReported = error.code === '23505' || /duplicate key/i.test(error.message || '');
      if (alreadyReported) {
        toast.success('This requisition already has a submitted report.');
        setAmountUsed('');
        setSummary('');
        setReceipt(null);
        setShowForm(false);
        setOpen(false);
        await load();
        return;
      }
      toast.error('Could not submit your report', { description: error.message });
      return;
    }

    toast.success('Usage report submitted');
    setAmountUsed('');
    setSummary('');
    setReceipt(null);
    setShowForm(false);
    setOpen(false);
    await load();
  };

  if (!current) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setShowForm(false); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-emerald-600" />
            Your requisition was approved
          </DialogTitle>
          <DialogDescription>
            You must now submit a report explaining how the money was used.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-2xl border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">{current.requisition_code}</span>
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700">
                Approved
              </Badge>
            </div>
            <p className="mt-2 font-semibold">{current.title}</p>
            {current.category && (
              <p className="text-xs text-muted-foreground">{current.category}</p>
            )}
            <p className="mt-2 flex items-center gap-2 text-lg font-bold">
              <Wallet className="h-4 w-4 text-emerald-600" /> {formatUGX(approvedAmount)}
            </p>
            <p className="text-xs text-muted-foreground">Approved {fmtDate(current.cfo_decided_at)}</p>
            <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{current.reason}</p>
          </div>

          {showForm && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="usage-amount">How much did you use (UGX)</Label>
                <Input
                  id="usage-amount"
                  inputMode="numeric"
                  value={amountUsed}
                  onChange={(e) => setAmountUsed(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder={String(approvedAmount)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="usage-summary">What was it spent on</Label>
                <Textarea
                  id="usage-summary"
                  rows={4}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="List what you paid for, to whom, and what it achieved (at least 20 characters)"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="usage-receipt">
                  Receipt or proof of payment <span className="text-destructive">*</span>
                </Label>
                {receipt ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{receipt.name}</span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => setReceipt(null)}
                      disabled={saving}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Input
                    id="usage-receipt"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) => { pickReceipt(e.target.files?.[0] ?? null); e.target.value = ''; }}
                  />
                )}
                <p className="text-xs text-muted-foreground">Required. Photo or PDF, up to 10MB.</p>
              </div>
            </div>
          )}

          {pending.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {pending.length - 1} other approved requisition{pending.length - 1 === 1 ? '' : 's'} still needs a report.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Later
          </Button>
          {showForm ? (
            <Button onClick={() => void submitReport()} disabled={saving || !receipt}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Submit report
            </Button>
          ) : (
            <Button onClick={() => setShowForm(true)}>Submit Usage Report</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RequisitionUsageReportGate;
