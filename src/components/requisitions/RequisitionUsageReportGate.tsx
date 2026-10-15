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
/** Mirrors the limit enforced by `defer_requisition_usage_report`. */
const MAX_DEFERRALS = 2;
const MAX_DEFERRALS_MSG = 'Maximum deferrals reached. This accountability report can no longer be deferred.';

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
  grace_ends_at: string | null;
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
  const [receipts, setReceipts] = useState<File[]>([]);
  const [deferrals, setDeferrals] = useState<Record<string, number>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [ackChecked, setAckChecked] = useState(false);
  const [showDefer, setShowDefer] = useState(false);
  const [deferReason, setDeferReason] = useState('');
  const [deferring, setDeferring] = useState(false);
  const [deferError, setDeferError] = useState<string | null>(null);
  const loadedOnceRef = useRef(false);

  const pickReceipts = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast.error(`"${file.name}" is not a PDF or photo (JPG, PNG or WebP)`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.error(`"${file.name}" is larger than 10MB`);
        continue;
      }
      setReceipts((prev) => [...prev, file]);
    }
  };

  const removeReceipt = (index: number) => {
    setReceipts((prev) => prev.filter((_, i) => i !== index));
  };

  const current = pending[0] ?? null;
  const approvedAmount = useMemo(
    () => (current ? Number(current.approved_amount ?? current.amount) : 0),
    [current],
  );

  const load = useCallback(async () => {
    if (!user?.id) { setPending([]); return; }
    // The server decides visibility (36h after CFO approval, no report yet),
    // the deferral count and whether the notice is mandatory.
    const { data, error } = await (supabase.rpc as any)('get_my_usage_report_notices');
    if (error) {
      console.warn('[RequisitionUsageReportGate] could not load notices', error);
      return;
    }
    const rows = (data || []) as Array<{
      requisition_id: string; requisition_code: string; title: string; amount: number;
      approved_amount: number | null; reason: string; category: string | null;
      cfo_decided_at: string | null; grace_ends_at: string | null; deferral_count: number;
      mandatory: boolean; acknowledged: boolean;
    }>;
    const counts: Record<string, number> = {};
    const acks: Record<string, boolean> = {};
    rows.forEach((r) => { counts[r.requisition_id] = r.deferral_count; acks[r.requisition_id] = r.acknowledged; });
    setDeferrals(counts);
    setAcknowledged(acks);
    setPending(rows.map((r) => ({
      id: r.requisition_id, requisition_code: r.requisition_code, title: r.title, amount: r.amount,
      approved_amount: r.approved_amount, reason: r.reason, cfo_decided_at: r.cfo_decided_at,
      category: r.category, grace_ends_at: r.grace_ends_at,
    })));
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
    if (receipts.length === 0) { toast.error('Attach at least one receipt or proof of payment'); return; }

    setSaving(true);

    // Upload each receipt first (existing storage + auth path) so we never save a
    // report that claims an attachment it does not have.
    const attachmentPaths: string[] = [];
    for (const receipt of receipts) {
      const form = new FormData();
      form.append('requisition_id', current.id);
      form.append('file', receipt);
      const { data: up, error: upErr } = await invokeEdgeFunction<{ path: string }>(
        'staff-requisition-add-attachment',
        { body: form, errorTitle: `Could not attach "${receipt.name}"` },
      );
      if (upErr || !up?.path) { setSaving(false); return; }
      attachmentPaths.push(up.path);
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
        setReceipts([]);
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
    setReceipts([]);
    setShowForm(false);
    setOpen(false);
    await load();
  };

  const deferCount = current ? deferrals[current.id] || 0 : 0;
  const limitReached = deferCount >= MAX_DEFERRALS;
  const isAcked = current ? !!acknowledged[current.id] : false;

  // Record each time a notice is actually shown (server de-duplicates per hour).
  useEffect(() => {
    if (!open || !current) return;
    void (supabase.rpc as any)('log_usage_report_notice_event', { p_requisition_id: current.id, p_event: 'shown' });
  }, [open, current?.id, deferCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const proceedToForm = async () => {
    if (!current) return;
    if (limitReached && !isAcked) {
      const { error } = await (supabase.rpc as any)('log_usage_report_notice_event', {
        p_requisition_id: current.id, p_event: 'acknowledged',
      });
      if (error) { toast.error('Could not record acknowledgement', { description: error.message }); return; }
      setAcknowledged((a) => ({ ...a, [current.id]: true }));
    }
    setShowForm(true);
  };

  const deferReport = async () => {
    if (!current) return;
    if (limitReached) { setDeferError(MAX_DEFERRALS_MSG); return; }
    if (deferReason.trim().length < 10) { setDeferError('Give a reason of at least 10 characters for deferring.'); return; }
    setDeferring(true);
    setDeferError(null);
    const { data, error } = await (supabase.rpc as any)('defer_requisition_usage_report', {
      p_requisition_id: current.id,
      p_reason: deferReason.trim(),
    });
    setDeferring(false);
    if (error) {
      setDeferError(/maximum deferrals/i.test(error.message || '') ? MAX_DEFERRALS_MSG : error.message);
      await load();
      return;
    }
    const remaining = Number((data as { remaining?: number } | null)?.remaining ?? 0);
    toast.success('Report deferred', {
      description: remaining > 0 ? `${remaining} deferral${remaining === 1 ? '' : 's'} left.` : 'No deferrals left. You must submit the report next time.',
    });
    setDeferReason('');
    setShowDefer(false);
    setOpen(false);
    await load();
  };

  if (!current) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) return; setOpen(o); }}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg [&>button.absolute]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
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
                  Receipts or proof of payment <span className="text-destructive">*</span>
                </Label>
                {receipts.map((receipt, i) => (
                  <div key={`${receipt.name}-${i}`} className="flex items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{receipt.name}</span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => removeReceipt(i)}
                      disabled={saving}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Input
                  id="usage-receipt"
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(e) => { pickReceipts(e.target.files); e.target.value = ''; }}
                />
                <p className="text-xs text-muted-foreground">At least one required. You can attach several — photos or PDFs, up to 10MB each.</p>
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Deferred {deferCount} of {MAX_DEFERRALS} times.
          </p>
          {limitReached && (
            <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {MAX_DEFERRALS_MSG} Please submit your usage report now.
            </p>
          )}
          {limitReached && !isAcked && !showForm && (
            <label className="flex items-start gap-2 rounded-xl border p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={ackChecked}
                onChange={(e) => setAckChecked(e.target.checked)}
              />
              I acknowledge this is my final notice and I will submit the accountability report now.
            </label>
          )}

          {showDefer && !limitReached && !showForm && (
            <div className="space-y-2">
              <Label htmlFor="usage-defer-reason">Why are you deferring?</Label>
              <Textarea
                id="usage-defer-reason"
                rows={3}
                value={deferReason}
                onChange={(e) => { setDeferReason(e.target.value); setDeferError(null); }}
                placeholder="At least 10 characters"
              />
            </div>
          )}
          {deferError && (
            <p role="alert" className="text-sm text-destructive">{deferError}</p>
          )}

          {pending.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {pending.length - 1} other approved requisition{pending.length - 1 === 1 ? '' : 's'} still needs a report.
            </p>
          )}
        </div>

        <DialogFooter>
          {!limitReached && !showForm && (
            showDefer ? (
              <>
                <Button variant="ghost" onClick={() => { setShowDefer(false); setDeferError(null); }} disabled={deferring}>
                  Back
                </Button>
                <Button variant="outline" onClick={() => void deferReport()} disabled={deferring}>
                  {deferring && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm defer
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => { setShowDefer(true); setDeferError(null); }} disabled={saving}>
                Later
              </Button>
            )
          )}
          {showForm && (
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={saving}>
              Back
            </Button>
          )}
          {showForm ? (
            <Button onClick={() => void submitReport()} disabled={saving || receipts.length === 0}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Submit report
            </Button>
          ) : (
            !showDefer && (
              <Button
                disabled={limitReached && !isAcked && !ackChecked}
                onClick={() => void proceedToForm()}
              >
                {limitReached && !isAcked ? 'Acknowledge and continue' : 'Submit Usage Report'}
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RequisitionUsageReportGate;
