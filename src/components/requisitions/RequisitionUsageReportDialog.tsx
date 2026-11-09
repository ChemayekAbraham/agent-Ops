import { useEffect, useMemo, useRef, useState } from 'react';
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
import { evaluateUsageMatching, type RefundStatus } from '@/lib/usageReportMatching';
import { pruneCache, uploadAllResumable, type UploadCache } from '@/lib/resumableUpload';

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECEIPT_FILES = 15;
const MAX_REFUND_FILES = 5;

export interface UsageReportRequisitionTarget {
  id: string;
  requisition_code: string;
  title: string;
  amount: number;
  approved_amount: number | null;
  reason?: string | null;
  category?: string | null;
  cfo_decided_at?: string | null;
  grace_ends_at?: string | null;
}

interface Props {
  requisition: UsageReportRequisitionTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function RequisitionUsageReportDialog({
  requisition,
  open,
  onOpenChange,
  onSubmitted,
}: Props) {
  const { user } = useAuth();
  const [amountUsed, setAmountUsed] = useState('');
  const [receiptTotal, setReceiptTotal] = useState('');
  const [summary, setSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [receipts, setReceipts] = useState<File[]>([]);
  const [mismatchExplanation, setMismatchExplanation] = useState('');
  const [unspentExplanation, setUnspentExplanation] = useState('');
  const [overspendExplanation, setOverspendExplanation] = useState('');
  const [refundStatus, setRefundStatus] = useState<RefundStatus | ''>('');
  const [refundEvidence, setRefundEvidence] = useState<File[]>([]);
  const [refundReason, setRefundReason] = useState('');

  const uploadedRef = useRef<UploadCache>(new Map());

  const resetForm = () => {
    setAmountUsed('');
    setReceiptTotal('');
    setSummary('');
    setReceipts([]);
    setMismatchExplanation('');
    setUnspentExplanation('');
    setOverspendExplanation('');
    setRefundStatus('');
    setRefundEvidence([]);
    setRefundReason('');
    uploadedRef.current.clear();
  };

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open]);

  const approvedAmount = useMemo(
    () => (requisition ? Number(requisition.approved_amount ?? requisition.amount) : 0),
    [requisition],
  );

  const matching = useMemo(
    () =>
      evaluateUsageMatching({
        approved: approvedAmount,
        used: amountUsed === '' ? null : Number(amountUsed),
        receiptTotal: receiptTotal === '' ? null : Number(receiptTotal),
        mismatchExplanation,
        unspentExplanation,
        overspendExplanation,
        refundStatus: refundStatus || null,
        refundEvidenceCount: refundEvidence.length,
        refundNotRequiredReason: refundReason,
      }),
    [
      approvedAmount,
      amountUsed,
      receiptTotal,
      mismatchExplanation,
      unspentExplanation,
      overspendExplanation,
      refundStatus,
      refundEvidence.length,
      refundReason,
    ],
  );

  const pickReceipts = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    let count = receipts.length;
    for (const file of Array.from(files)) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast.error(`"${file.name}" is not a PDF or photo (JPG, PNG or WebP)`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.error(`"${file.name}" is larger than 10MB`);
        continue;
      }
      if (count >= MAX_RECEIPT_FILES) {
        toast.error(`You can attach up to ${MAX_RECEIPT_FILES} receipts. "${file.name}" was not added.`);
        continue;
      }
      count += 1;
      setReceipts((prev) => [...prev, file]);
    }
  };

  const removeReceipt = (index: number) => {
    setReceipts((prev) => prev.filter((_, i) => i !== index));
  };

  const submitReport = async () => {
    if (!requisition || !user?.id) return;
    const used = Number(amountUsed);
    if (!Number.isFinite(used) || used < 0) {
      toast.error('Enter how much of the money you used');
      return;
    }
    if (summary.trim().length < 20) {
      toast.error('Explain how the funds were used (at least 20 characters)');
      return;
    }
    if (receipts.length === 0) {
      toast.error('Attach at least one receipt or proof of payment');
      return;
    }
    if (matching.problems.length > 0) {
      toast.error(matching.problems[0]);
      return;
    }
    if (refundEvidence.length > MAX_REFUND_FILES) {
      toast.error(`Attach at most ${MAX_REFUND_FILES} files as proof of refund`);
      return;
    }

    setSaving(true);

    const uploadOne = async (file: File) => {
      const form = new FormData();
      form.append('requisition_id', requisition.id);
      form.append('purpose', 'usage_report');
      form.append('file', file);
      const { data: up, error: upErr } = await invokeEdgeFunction<{ path: string }>(
        'staff-requisition-add-attachment',
        { body: form, errorTitle: `Could not attach "${file.name}"` },
      );
      return upErr || !up?.path ? null : up.path;
    };

    const receiptScope = `receipt:${requisition.id}`;
    const refundScope = `refund:${requisition.id}`;
    pruneCache(uploadedRef.current, receiptScope, receipts);
    pruneCache(uploadedRef.current, refundScope, refundEvidence);

    const attachmentPaths = await uploadAllResumable(
      receipts,
      receiptScope,
      uploadedRef.current,
      uploadOne,
    );
    if (!attachmentPaths) {
      setSaving(false);
      return;
    }

    const refundPaths =
      matching.hasUnspent && refundStatus === 'made'
        ? await uploadAllResumable(
            refundEvidence,
            refundScope,
            uploadedRef.current,
            uploadOne,
          )
        : [];
    if (!refundPaths) {
      setSaving(false);
      return;
    }

    const { data: res, error } = await (supabase.rpc as any)(
      'submit_requisition_usage_report',
      {
        p_requisition_id: requisition.id,
        p_amount_used: used,
        p_receipt_total: Number(receiptTotal),
        p_summary: summary.trim(),
        p_attachment_paths: attachmentPaths,
        p_mismatch_explanation: matching.mismatch ? mismatchExplanation.trim() : null,
        p_unspent_explanation: matching.hasUnspent ? unspentExplanation.trim() : null,
        p_overspend_explanation: matching.hasOverspend ? overspendExplanation.trim() : null,
        p_refund_status: matching.hasUnspent ? refundStatus : null,
        p_refund_evidence_paths: refundPaths,
        p_refund_not_required_reason:
          matching.hasUnspent && refundStatus === 'not_required'
            ? refundReason.trim()
            : null,
      },
    );

    setSaving(false);

    if (error) {
      const alreadyReported =
        error.code === '23505' || /duplicate key/i.test(error.message || '');
      if (alreadyReported) {
        toast.success('This requisition already has a submitted report.');
        resetForm();
        onOpenChange(false);
        onSubmitted?.();
        return;
      }
      toast.error('Could not submit usage report', { description: error.message });
      return;
    }

    toast.success('Usage report submitted', {
      description: (res as { discrepancy_flag?: boolean } | null)?.discrepancy_flag
        ? 'Amount differences were flagged for CFO review.'
        : undefined,
    });
    resetForm();
    onOpenChange(false);
    onSubmitted?.();
  };

  if (!requisition) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-emerald-600" />
            Submit Usage Requisition Report
          </DialogTitle>
          <DialogDescription>
            Account for the funds disbursed for this requisition.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-2xl border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {requisition.requisition_code}
              </span>
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
              >
                Approved
              </Badge>
            </div>
            <p className="mt-2 font-semibold">{requisition.title}</p>
            {requisition.category && (
              <p className="text-xs text-muted-foreground">{requisition.category}</p>
            )}
            <p className="mt-2 flex items-center gap-2 text-lg font-bold">
              <Wallet className="h-4 w-4 text-emerald-600" /> {formatUGX(approvedAmount)}
            </p>
            {requisition.cfo_decided_at && (
              <p className="text-xs text-muted-foreground">
                Approved {fmtDate(requisition.cfo_decided_at)}
              </p>
            )}
            {requisition.reason && (
              <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {requisition.reason}
              </p>
            )}
          </div>

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
              <Label htmlFor="usage-receipt-total">Total shown on your receipts (UGX)</Label>
              <Input
                id="usage-receipt-total"
                inputMode="numeric"
                value={receiptTotal}
                onChange={(e) => setReceiptTotal(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="Add up the amounts on your receipts"
              />
              <p className="text-xs text-red-600 dark:text-red-400">
                Type it yourself — the receipts are checked by hand, not read automatically.
              </p>
            </div>

            {matching.receiptVsUsed !== null && (
              <div className="rounded-xl border bg-muted/30 p-3 text-sm" aria-label="Amount matching">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-xs text-muted-foreground">Approved</p>
                    <p className="font-semibold">{formatUGX(approvedAmount)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Used</p>
                    <p className="font-semibold">{formatUGX(Number(amountUsed))}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Receipts</p>
                    <p className="font-semibold">{formatUGX(Number(receiptTotal))}</p>
                  </div>
                </div>
                <p
                  className={`mt-2 ${
                    matching.mismatch
                      ? 'font-semibold text-destructive'
                      : 'text-muted-foreground'
                  }`}
                >
                  {matching.mismatch
                    ? `Discrepancy: receipts are ${formatUGX(
                        Math.abs(matching.receiptVsUsed),
                      )} ${matching.receiptVsUsed > 0 ? 'more' : 'less'} than the amount used.`
                    : 'Receipts match the amount used.'}
                </p>
                {matching.hasUnspent && (
                  <p className="font-semibold text-warning">
                    Unspent balance: {formatUGX(matching.unspent ?? 0)}
                  </p>
                )}
                {matching.hasOverspend && (
                  <p className="font-semibold text-destructive">
                    Spent above approval: {formatUGX(matching.overspend ?? 0)}
                  </p>
                )}
              </div>
            )}

            {matching.mismatch && (
              <div className="space-y-2">
                <Label htmlFor="usage-mismatch">
                  Why do the receipts differ from the amount used?
                </Label>
                <Textarea
                  id="usage-mismatch"
                  rows={2}
                  value={mismatchExplanation}
                  onChange={(e) => setMismatchExplanation(e.target.value)}
                  placeholder="At least 10 characters"
                />
              </div>
            )}

            {matching.hasOverspend && (
              <div className="space-y-2">
                <Label htmlFor="usage-overspend">
                  Explain the amount spent above the approval
                </Label>
                <Textarea
                  id="usage-overspend"
                  rows={2}
                  value={overspendExplanation}
                  onChange={(e) => setOverspendExplanation(e.target.value)}
                  placeholder="At least 10 characters"
                />
              </div>
            )}

            {matching.hasUnspent && (
              <div className="space-y-2 rounded-xl border p-3">
                <Label htmlFor="usage-unspent">Account for the unspent balance</Label>
                <Textarea
                  id="usage-unspent"
                  rows={2}
                  value={unspentExplanation}
                  onChange={(e) => setUnspentExplanation(e.target.value)}
                  placeholder="What happened to the remaining money (at least 10 characters)"
                />
                <Label>Refund status</Label>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ['made', 'Refund made'],
                      ['pending', 'Refund pending'],
                      ['not_required', 'Not required per policy'],
                    ] as const
                  ).map(([v, l]) => (
                    <Button
                      key={v}
                      type="button"
                      size="sm"
                      variant={refundStatus === v ? 'default' : 'outline'}
                      onClick={() => setRefundStatus(v)}
                    >
                      {l}
                    </Button>
                  ))}
                </div>
                {refundStatus === 'made' && (
                  <div className="space-y-1">
                    <Label htmlFor="usage-refund-proof">Proof of refund</Label>
                    {refundEvidence.map((f, i) => (
                      <div
                        key={`${f.name}-${i}`}
                        className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1 text-xs"
                      >
                        <span className="truncate">{f.name}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() =>
                            setRefundEvidence((p) => p.filter((_, j) => j !== i))
                          }
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                    <Input
                      id="usage-refund-proof"
                      type="file"
                      multiple
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []).filter(
                          (f) => ALLOWED_TYPES.includes(f.type) && f.size <= MAX_BYTES,
                        );
                        setRefundEvidence((p) => [...p, ...files]);
                        e.target.value = '';
                      }}
                    />
                  </div>
                )}
                {refundStatus === 'not_required' && (
                  <Textarea
                    rows={2}
                    value={refundReason}
                    onChange={(e) => setRefundReason(e.target.value)}
                    placeholder="Why no refund is required under policy (at least 10 characters)"
                    aria-label="Why no refund is required"
                  />
                )}
              </div>
            )}

            {matching.problems.length > 0 && amountUsed !== '' && receiptTotal !== '' && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive" role="alert">
                {matching.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}

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
                <div
                  key={`${receipt.name}-${i}`}
                  className="flex items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3 py-2"
                >
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
                onChange={(e) => {
                  pickReceipts(e.target.files);
                  e.target.value = '';
                }}
              />
              <p className="text-xs text-red-600 dark:text-red-400">
                At least one required. You can attach several — photos or PDFs, up to 10MB each.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void submitReport()}
            disabled={saving || receipts.length === 0 || matching.problems.length > 0}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RequisitionUsageReportDialog;

