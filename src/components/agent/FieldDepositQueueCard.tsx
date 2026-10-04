import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { Banknote, ChevronRight, Clock, CheckCircle2, AlertCircle, Send, Wallet, XCircle, ShieldCheck, ChevronDown, Loader2, Coins, AlertTriangle, FileText, ArrowDownRight, ArrowUpRight, Info, Download, FileSpreadsheet } from 'lucide-react';
import {
  listAgentBatches,
  type FieldDepositBatch,
  type BatchItemDetail,
  listBatchItems,
  FIELD_DEPOSIT_COMMISSION_RATE_FALLBACK,
  getFieldDepositCommissionConfig,
  type FieldDepositCommissionConfig,
  channelLabel,
  statusLabel,
  getBatchAllocationDetail,
  type AllocationTenantBreakdown,
} from '@/lib/fieldDepositBatches';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FieldDepositWizardDialog } from '@/components/agent/FieldDepositWizardDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

/**
 * Tolerance (in UGX) for reconciliation comparisons. Repayment / commission
 * deltas at or below this threshold are treated as "matching" so floor / round
 * differences from the per-line commission calculation never surface as a
 * mismatch. Override per-environment via VITE_FIELD_DEPOSIT_RECONCILE_TOLERANCE.
 */
const RECONCILE_TOLERANCE_UGX = (() => {
  const raw = (import.meta as any).env?.VITE_FIELD_DEPOSIT_RECONCILE_TOLERANCE;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
})();

interface FieldDepositQueueCardProps {
  /** Optional: lets the parent open a different "submit proof" dialog. Defaults to opening the wizard pre-bound to that batch. */
  onSubmitProof?: (batch: FieldDepositBatch) => void;
}

/**
 * Agent dashboard card showing the deposit pipeline:
 * cash collected → batched → proof submitted → FinOps verified.
 */
export function FieldDepositQueueCard({ onSubmitProof }: FieldDepositQueueCardProps) {
  const { user } = useAuth();
  const [batches, setBatches] = useState<FieldDepositBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [proofForBatch, setProofForBatch] = useState<FieldDepositBatch | null>(null);
  const [commissionConfig, setCommissionConfig] = useState<FieldDepositCommissionConfig | null>(null);
  const [commissionConfigLoaded, setCommissionConfigLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getFieldDepositCommissionConfig()
      .then((cfg) => { if (!cancelled) setCommissionConfig(cfg); })
      .catch(() => { if (!cancelled) setCommissionConfig(null); })
      .finally(() => { if (!cancelled) setCommissionConfigLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    try {
      setBatches(await listAgentBatches(user.id, 6));
    } catch {
      /* surfaced by toast in wizard; card stays quiet */
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 8000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const awaiting = batches.filter(b => b.status === 'awaiting_proof');
  const pending = batches.filter(b => b.status === 'pending_finops_verification');
  const recent = batches.slice(0, 4);

  const handleProof = (b: FieldDepositBatch) => {
    if (onSubmitProof) onSubmitProof(b);
    else setProofForBatch(b);
  };

  return (
    <>
      <div className="rounded-2xl border bg-card overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 flex items-center justify-between border-b bg-gradient-to-br from-primary/5 to-transparent">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Wallet className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm leading-tight">Deposit Queue</p>
              <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                Bank the cash you collected from the field
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => setWizardOpen(true)} className="gap-1.5 shrink-0">
            <Send className="h-3.5 w-3.5" />
            Deposit
          </Button>
        </div>

        {/* Status strip */}
        {!loading && (awaiting.length > 0 || pending.length > 0) && (
          <div className="grid grid-cols-2 gap-px bg-border">
            <StatusTile
              icon={<Clock className="h-3.5 w-3.5" />}
              label="Awaiting proof"
              count={awaiting.length}
              total={awaiting.reduce((s, b) => s + Number(b.declared_total), 0)}
              tone="amber"
            />
            <StatusTile
              icon={<Send className="h-3.5 w-3.5" />}
              label="With Finance"
              count={pending.length}
              total={pending.reduce((s, b) => s + Number(b.declared_total), 0)}
              tone="blue"
            />
          </div>
        )}

        {/* Recent list */}
        <div className="divide-y">
          {loading ? (
            <div className="p-4 space-y-2">
              <div className="h-12 rounded-lg bg-muted animate-pulse" />
              <div className="h-12 rounded-lg bg-muted animate-pulse" />
            </div>
          ) : recent.length === 0 ? (
            <button
              onClick={() => setWizardOpen(true)}
              className="w-full p-5 text-center text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
            >
              No deposits yet. Tap <span className="font-semibold text-foreground">Deposit</span> when you're ready to bank collected cash.
            </button>
          ) : (
            recent.map(b => (
              <BatchRow
                key={b.id}
                batch={b}
                onSubmitProof={() => handleProof(b)}
                commissionConfig={commissionConfig}
                commissionConfigLoaded={commissionConfigLoaded}
              />
            ))
          )}
        </div>
      </div>

      <FieldDepositWizardDialog
        open={wizardOpen}
        onOpenChange={(open) => { setWizardOpen(open); if (!open) refresh(); }}
      />

      {proofForBatch && (
        <FieldDepositWizardDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setProofForBatch(null);
              refresh();
            }
          }}
          attachProofTo={proofForBatch}
        />
      )}
    </>
  );
}

function StatusTile({
  icon, label, count, total, tone,
}: {
  icon: React.ReactNode; label: string; count: number; total: number;
  tone: 'amber' | 'blue';
}) {
  const toneClass = tone === 'amber'
    ? 'text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/20'
    : 'text-blue-700 dark:text-blue-400 bg-blue-50/60 dark:bg-blue-950/20';
  return (
    <div className={cn('px-3 py-2.5', toneClass)}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
        {icon}{label}
      </div>
      <p className="text-base font-bold leading-tight mt-0.5">{count}</p>
      <p className="text-[10px] opacity-80 leading-tight">{formatUGX(total)}</p>
    </div>
  );
}

function BatchRow({
  batch,
  onSubmitProof,
  commissionConfig,
  commissionConfigLoaded,
}: {
  batch: FieldDepositBatch;
  onSubmitProof: () => void;
  commissionConfig: FieldDepositCommissionConfig | null;
  commissionConfigLoaded: boolean;
}) {
  const isAwaiting = batch.status === 'awaiting_proof';
  const isPending = batch.status === 'pending_finops_verification';
  const isVerified = batch.status === 'verified';
  const isRejected = batch.status === 'rejected';
  const isCancelled = batch.status === 'cancelled';
  const canExpand = !isAwaiting; // only batches with proof/verification have meaningful detail
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<BatchItemDetail[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [allocationDetail, setAllocationDetail] = useState<{
    generated_at: string;
    tenants: AllocationTenantBreakdown[];
  } | null>(null);

  const toggle = async () => {
    if (!canExpand) return;
    const next = !expanded;
    setExpanded(next);
    if (next && items === null && !loadErr) {
      try {
        const [its, alloc] = await Promise.all([
          listBatchItems(batch.id),
          isVerified ? getBatchAllocationDetail(batch.id) : Promise.resolve(null),
        ]);
        setItems(its);
        setAllocationDetail(alloc);
      } catch (e: any) {
        setLoadErr(e?.message ?? 'Failed to load items');
      }
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
      <button
        type="button"
        onClick={toggle}
        disabled={!canExpand}
        className={cn(
        'h-9 w-9 rounded-lg flex items-center justify-center shrink-0',
        isVerified && 'bg-emerald-500/10 text-emerald-600',
        isRejected && 'bg-red-500/10 text-red-600',
        isAwaiting && 'bg-amber-500/10 text-amber-600',
        isPending && 'bg-blue-500/10 text-blue-600',
        isCancelled && 'bg-muted text-muted-foreground',
        canExpand && 'hover:opacity-80 transition-opacity cursor-pointer',
      )}>
        {isVerified ? <CheckCircle2 className="h-4 w-4" /> :
         isRejected ? <XCircle className="h-4 w-4" /> :
         isPending ? <ShieldCheck className="h-4 w-4" /> :
         isAwaiting ? <Clock className="h-4 w-4" /> :
         <Banknote className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={toggle}
        disabled={!canExpand}
        className={cn(
          'min-w-0 flex-1 text-left',
          canExpand && 'hover:opacity-90 transition-opacity cursor-pointer',
        )}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-semibold text-sm truncate">{formatUGX(Number(batch.declared_total))}</p>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal shrink-0">
            {channelLabel(batch.channel)}
          </Badge>
          <StatusPill batch={batch} />
          {canExpand && (
            <ChevronDown
              className={cn(
                'h-3 w-3 text-muted-foreground transition-transform shrink-0',
                expanded && 'rotate-180',
              )}
            />
          )}
        </div>
        {batch.proof_reference && (
          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
            Ref <span className="font-mono">{batch.proof_reference}</span>
          </p>
        )}
        {isRejected && batch.rejection_reason && (
          <div className="mt-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              Rejection reason
            </p>
            <p className="text-[11px] text-destructive/90 mt-0.5 leading-snug">
              {batch.rejection_reason}
            </p>
          </div>
        )}
      </button>
      {isAwaiting ? (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 shrink-0" onClick={onSubmitProof}>
          Add proof
          <ChevronRight className="h-3 w-3" />
        </Button>
      ) : isRejected ? (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 shrink-0" onClick={onSubmitProof}>
          Resubmit
          <ChevronRight className="h-3 w-3" />
        </Button>
      ) : null}
      </div>

      {expanded && canExpand && (
        <CommissionBreakdown
          items={items}
          loading={items === null && !loadErr}
          error={loadErr}
          isVerified={isVerified}
          batch={batch}
          allocationDetail={allocationDetail}
          commissionConfig={commissionConfig}
          commissionConfigLoaded={commissionConfigLoaded}
        />
      )}
    </div>
  );
}

function CommissionBreakdown({
  items,
  loading,
  error,
  isVerified,
  batch,
  allocationDetail,
  commissionConfig,
  commissionConfigLoaded,
}: {
  items: BatchItemDetail[] | null;
  loading: boolean;
  error: string | null;
  isVerified: boolean;
  batch: FieldDepositBatch;
  allocationDetail: { generated_at: string; tenants: AllocationTenantBreakdown[] } | null;
  commissionConfig: FieldDepositCommissionConfig | null;
  commissionConfigLoaded: boolean;
}) {
  // Prefer the rate that was actually recorded at verify time (audit truth).
  // Otherwise use the stored config. Fallback constant only kicks in if the
  // RPC fails AND the batch has no recorded rate — UI surfaces a warning.
  const recordedRate =
    typeof allocationDetail === 'object' && allocationDetail
      ? Number((allocationDetail as any)?.commission_rate ?? NaN)
      : NaN;
  const effectiveRate = Number.isFinite(recordedRate) && recordedRate > 0
    ? recordedRate
    : commissionConfig?.rate ?? FIELD_DEPOSIT_COMMISSION_RATE_FALLBACK;
  const usingFallback = commissionConfigLoaded && !commissionConfig && !(Number.isFinite(recordedRate) && recordedRate > 0);
  const ratePct = +(effectiveRate * 100).toFixed(2);
  const totalRepayment = items?.reduce((s, i) => s + i.amount, 0) ?? 0;
  const totalCommission =
    items?.reduce((s, i) => s + Math.round(i.amount * effectiveRate), 0) ?? 0;
  const declared = Number(batch.declared_total || 0);
  const recordedTagged = Number(batch.tagged_total || 0);
  // Match against authoritative batch numbers:
  // - if verified, compare to recorded `tagged_total`; otherwise fall back to declared total.
  const matchTarget = isVerified && recordedTagged > 0 ? recordedTagged : declared;
  const matchTargetLabel = isVerified && recordedTagged > 0 ? 'recorded tagged total' : 'declared total';
  const repaymentDelta = totalRepayment - matchTarget;
  const repaymentMatches = items !== null && Math.abs(repaymentDelta) <= RECONCILE_TOLERANCE_UGX;

  // Build a quick lookup from item_id → audit detail (per-tenant generation timestamp)
  const auditByItem = new Map<string, AllocationTenantBreakdown>(
    (allocationDetail?.tenants ?? []).map((t) => [t.item_id, t]),
  );

  // Commission reconciliation:
  //  - For verified batches, the authoritative recorded commission is the
  //    sum of per-tenant commissions captured in the allocation audit row.
  //  - For pending batches, expected commission = effectiveRate × tagged_total
  //    (or declared total if not yet tagged) — what *will* be booked on verify.
  const recordedCommissionTotal = (allocationDetail?.tenants ?? []).reduce(
    (s, t) => s + Number(t.commission || 0),
    0,
  );
  const expectedCommissionTarget =
    isVerified && recordedCommissionTotal > 0
      ? recordedCommissionTotal
      : Math.round(matchTarget * effectiveRate);
  const commissionTargetLabel =
    isVerified && recordedCommissionTotal > 0
      ? "batch's recorded commission total"
      : `expected commission (${ratePct}% × ${matchTargetLabel})`;
  const commissionDelta = totalCommission - expectedCommissionTarget;
  const commissionMatches =
    items !== null && Math.abs(commissionDelta) <= RECONCILE_TOLERANCE_UGX;

  // ----- Export handlers -------------------------------------------------
  const buildExportRows = useCallback(() => {
    return (items ?? []).map((it) => {
      const audit = auditByItem.get(it.id);
      return {
        tenant: it.tenant_name ?? '—',
        repayment: it.amount,
        commission: Math.round(it.amount * effectiveRate),
        recordedRepayment: audit ? Number(audit.repayment || 0) : null,
        recordedCommission: audit ? Number(audit.commission || 0) : null,
        generatedAt: audit?.generated_at ?? null,
      };
    });
  }, [items, auditByItem, effectiveRate]);

  const fileBase = `field-deposit-${batch.id.slice(0, 8)}-reconciliation`;

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const csvEscape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const handleExportCSV = () => {
    const rows = buildExportRows();
    const lines: string[] = [];
    lines.push(`Field Deposit Reconciliation`);
    lines.push(`Batch ID,${csvEscape(batch.id)}`);
    lines.push(`Channel,${csvEscape(channelLabel(batch.channel))}`);
    lines.push(`Status,${csvEscape(statusLabel(batch.status))}`);
    lines.push(`Commission rate,${ratePct}%`);
    lines.push(`Match target (${csvEscape(matchTargetLabel)}),${matchTarget}`);
    lines.push('');
    lines.push(['Tenant', 'Repayment (UGX)', 'Commission (UGX)', 'Recorded repayment', 'Recorded commission', 'Generated at'].map(csvEscape).join(','));
    for (const r of rows) {
      lines.push([
        r.tenant,
        r.repayment,
        r.commission,
        r.recordedRepayment ?? '',
        r.recordedCommission ?? '',
        r.generatedAt ?? '',
      ].map(csvEscape).join(','));
    }
    lines.push('');
    lines.push(`Total repayments,${totalRepayment}`);
    lines.push(`Total commission,${totalCommission}`);
    lines.push(`Repayment reconciliation,${repaymentMatches ? 'MATCH' : 'MISMATCH'},delta,${repaymentDelta}`);
    lines.push(`Commission reconciliation,${commissionMatches ? 'MATCH' : 'MISMATCH'},delta,${commissionDelta}`);
    triggerDownload(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `${fileBase}.csv`);
    toast.success('CSV exported');
  };

  const handleExportPDF = async () => {
    try {
      const [{ default: jsPDF }, autoTableMod] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const autoTable = (autoTableMod as any).default ?? (autoTableMod as any);
      const doc = new jsPDF();
      doc.setFontSize(14);
      doc.text('Field Deposit Reconciliation', 14, 16);
      doc.setFontSize(9);
      doc.text(`Batch: ${batch.id}`, 14, 24);
      doc.text(`Channel: ${channelLabel(batch.channel)}`, 14, 30);
      doc.text(`Status: ${statusLabel(batch.status)}`, 14, 36);
      doc.text(`Commission rate: ${ratePct}%`, 14, 42);
      doc.text(`Match target (${matchTargetLabel}): ${formatUGX(matchTarget)}`, 14, 48);

      const rows = buildExportRows();
      autoTable(doc, {
        startY: 56,
        head: [['Tenant', 'Repayment', 'Commission', 'Generated']],
        body: rows.map((r) => [
          r.tenant,
          formatUGX(r.repayment),
          formatUGX(r.commission),
          r.generatedAt ? format(new Date(r.generatedAt), 'MMM d, HH:mm') : '—',
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [60, 60, 60] },
      });

      const endY = (doc as any).lastAutoTable?.finalY ?? 60;
      doc.setFontSize(10);
      doc.text(`Total repayments: ${formatUGX(totalRepayment)}`, 14, endY + 8);
      doc.text(`Total commission: ${formatUGX(totalCommission)}`, 14, endY + 14);
      doc.text(
        `Repayment: ${repaymentMatches ? 'MATCH' : 'MISMATCH'} (delta ${formatUGX(Math.abs(repaymentDelta))})`,
        14,
        endY + 22,
      );
      doc.text(
        `Commission: ${commissionMatches ? 'MATCH' : 'MISMATCH'} (delta ${formatUGX(Math.abs(commissionDelta))})`,
        14,
        endY + 28,
      );

      doc.save(`${fileBase}.pdf`);
      toast.success('PDF exported');
    } catch (err) {
      toast.error('Could not generate PDF');
      console.error(err);
    }
  };

  return (
    <div className="mt-3 ml-12 rounded-lg border bg-muted/30 overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between border-b bg-background/40">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Coins className="h-3 w-3" />
          Commission breakdown · {ratePct}% per repayment
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {isVerified ? 'Recorded as expense' : 'Estimate (on verify)'}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] gap-1 px-2"
                disabled={!items || items.length === 0}
              >
                <Download className="h-3 w-3" />
                Export
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onClick={handleExportCSV} className="gap-2">
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Download CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportPDF} className="gap-2">
                <FileText className="h-3.5 w-3.5" />
                Download PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {usingFallback && (
        <div className="px-3 py-2 border-b bg-destructive/10 text-destructive flex items-start gap-1.5 text-[11px]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold">Commission config missing</div>
            <div className="opacity-90 leading-snug mt-0.5">
              No active <span className="font-mono">field_deposit_commission_config</span> row was
              found. Showing the {ratePct}% fallback rate — Finance will be unable to verify this
              batch until an operator restores the config.
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="px-3 py-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading tenants…
        </div>
      )}
      {error && <div className="px-3 py-3 text-xs text-destructive">{error}</div>}

      {items && items.length === 0 && (
        <div className="px-3 py-3 text-xs text-muted-foreground text-center">
          No tenants tagged in this batch.
        </div>
      )}

      {items && items.length > 0 && (
        <>
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground border-b">
            <span>Tenant</span>
            <span className="text-right">Repayment</span>
            <span className="text-right min-w-[80px]">Commission</span>
          </div>
          <ul className="divide-y">
            {items.map((it) => {
              const comm = Math.round(it.amount * effectiveRate);
              const audit = auditByItem.get(it.id);
              // A line item is flagged when EITHER:
              //  (a) the overall repayment total doesn't match the batch target
              //      AND this line's repayment drifts from what the audit
              //      recorded for the same tenant (verified batches), or
              //  (b) the overall commission total doesn't match the recorded /
              //      expected commission AND this line's recomputed commission
              //      drifts from the audit value.
              const auditRepayment = audit ? Number(audit.repayment || 0) : null;
              const auditCommission = audit ? Number(audit.commission || 0) : null;
              const repaymentDrift =
                auditRepayment !== null && Math.abs(it.amount - auditRepayment) >= 1;
              const commissionDrift =
                auditCommission !== null && Math.abs(comm - auditCommission) >= 1;
              // For pending batches with no audit, share the blame across all
              // lines when the overall total drifts (so users know to spot-check).
              const sharedRepaymentBlame = !auditRepayment && !repaymentMatches;
              const sharedCommissionBlame = !auditCommission && !commissionMatches;
              const repaymentSuspect =
                (!repaymentMatches && repaymentDrift) || sharedRepaymentBlame;
              const commissionSuspect =
                (!commissionMatches && commissionDrift) || sharedCommissionBlame;
              const flagged = repaymentSuspect || commissionSuspect;
              return (
                <li
                  key={it.id}
                  className={cn(
                    'grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 text-xs items-center',
                    flagged && 'bg-amber-500/10 border-l-2 border-amber-500',
                  )}
                  title={
                    flagged
                      ? [
                          repaymentSuspect &&
                            (auditRepayment !== null
                              ? `Repayment drifts from audit (${formatUGX(auditRepayment)})`
                              : 'Contributes to repayment mismatch'),
                          commissionSuspect &&
                            (auditCommission !== null
                              ? `Commission drifts from audit (${formatUGX(auditCommission)})`
                              : 'Contributes to commission mismatch'),
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : undefined
                  }
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium flex items-center gap-1">
                      {flagged && (
                        <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                      )}
                      <span className="truncate">{it.tenant_name ?? '—'}</span>
                    </div>
                    {audit?.generated_at && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Generated {format(new Date(audit.generated_at), 'MMM d, HH:mm')}
                      </div>
                    )}
                  </div>
                  <span
                    className={cn(
                      'font-mono text-right',
                      repaymentSuspect && 'text-amber-700 dark:text-amber-400 font-semibold',
                    )}
                  >
                    {formatUGX(it.amount)}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-right min-w-[80px]',
                      commissionSuspect
                        ? 'text-amber-700 dark:text-amber-400 font-semibold'
                        : 'text-emerald-600 dark:text-emerald-400',
                    )}
                  >
                    +{formatUGX(comm)}
                  </span>
                </li>
              );
            })}
          </ul>
          {/* Totals footer */}
          <div className="border-t bg-background/60">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 text-xs items-center font-semibold">
              <span>Total ({items.length} tenant{items.length === 1 ? '' : 's'})</span>
              <span className="font-mono text-right">{formatUGX(totalRepayment)}</span>
              <span className="font-mono text-right text-emerald-600 dark:text-emerald-400 min-w-[80px]">
                +{formatUGX(totalCommission)}
              </span>
            </div>

            {/* Reconciliation against batch */}
            <div
              className={cn(
                'px-3 py-2 border-t text-[11px] flex items-start gap-1.5',
                repaymentMatches
                  ? 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
              )}
            >
              {repaymentMatches ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                {repaymentMatches ? (
                  <span>
                    Repayments match the {matchTargetLabel} of{' '}
                    <span className="font-mono font-semibold">{formatUGX(matchTarget)}</span>.
                  </span>
                ) : (
                  <span>
                    Repayments {repaymentDelta > 0 ? 'exceed' : 'fall short of'} the {matchTargetLabel} (
                    <span className="font-mono font-semibold">{formatUGX(matchTarget)}</span>) by{' '}
                    <span className="font-mono font-semibold">{formatUGX(Math.abs(repaymentDelta))}</span>
                    {!isVerified && repaymentDelta < 0 ? ' — surplus stays as agent float on verify.' : '.'}
                  </span>
                )}
              </div>
            </div>

            {/* Commission reconciliation */}
            <div
              className={cn(
                'px-3 py-2 border-t text-[11px] flex items-start gap-1.5',
                commissionMatches
                  ? 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
              )}
            >
              {commissionMatches ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                {commissionMatches ? (
                  <span>
                    Commission matches the {commissionTargetLabel} of{' '}
                    <span className="font-mono font-semibold">
                      {formatUGX(expectedCommissionTarget)}
                    </span>
                    .
                  </span>
                ) : (
                  <span>
                    Commission {commissionDelta > 0 ? 'exceeds' : 'falls short of'} the{' '}
                    {commissionTargetLabel} (
                    <span className="font-mono font-semibold">
                      {formatUGX(expectedCommissionTarget)}
                    </span>
                    ) by{' '}
                    <span className="font-mono font-semibold">
                      {formatUGX(Math.abs(commissionDelta))}
                    </span>
                    .
                  </span>
                )}
              </div>
            </div>

            {/* Source-of-truth label */}
            <div className="px-3 py-1.5 border-t bg-background/40 text-[10px] text-muted-foreground flex items-start gap-1.5">
              <Info className="h-3 w-3 shrink-0 mt-0.5" />
              <div className="min-w-0 leading-snug">
                <span className="font-semibold">Source of truth:</span>{' '}
                {isVerified ? (
                  recordedTagged > 0 ? (
                    <>
                      Verified batch — comparing against the recorded{' '}
                      <span className="font-mono">tagged_total</span> (
                      <span className="font-mono">{formatUGX(recordedTagged)}</span>) and the
                      per-tenant commission audit captured at verify time.
                    </>
                  ) : (
                    <>
                      Verified batch — no <span className="font-mono">tagged_total</span> recorded,
                      falling back to <span className="font-mono">declared_total</span> (
                      <span className="font-mono">{formatUGX(declared)}</span>).
                    </>
                  )
                ) : (
                  <>
                    Pending batch — comparing against{' '}
                    <span className="font-mono">declared_total</span> (
                    <span className="font-mono">{formatUGX(declared)}</span>); commission is the
                    estimate that will be booked on verify at {ratePct}%.
                  </>
                )}
                <span className="block mt-0.5 opacity-80">
                  Match tolerance:{' '}
                  <span className="font-mono">±{formatUGX(RECONCILE_TOLERANCE_UGX)}</span> (rounding-safe).
                </span>
              </div>
            </div>
          </div>

          {/* Pre-verify ledger impact preview */}
          {!isVerified && (
            <LedgerImpactPreview
              declared={declared}
              totalAllocated={totalRepayment}
              totalCommission={totalCommission}
              ratePct={ratePct}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Shows the exact ledger lines that will be booked when Finance verifies this batch.
 * Mirrors the categories used by `process_verified_field_deposit`:
 *   • agent_float_deposit       (cash-in to agent float)
 *   • agent_float_used_for_rent (settlement against tenant repayments)
 *   • agent_commission_earned   (platform expense → agent reward, 10% of repayments)
 */
function LedgerImpactPreview({
  declared,
  totalAllocated,
  totalCommission,
  ratePct,
}: {
  declared: number;
  totalAllocated: number;
  totalCommission: number;
  ratePct: number;
}) {
  const surplus = Math.max(0, declared - totalAllocated);
  const lines: { dir: 'in' | 'out'; category: string; label: string; amount: number; note?: string }[] = [
    {
      dir: 'in',
      category: 'agent_float_deposit',
      label: 'Agent float credit (declared cash banked)',
      amount: declared,
    },
    {
      dir: 'out',
      category: 'agent_float_used_for_rent',
      label: 'Float settled against tenant repayments',
      amount: totalAllocated,
      note: surplus > 0 ? `Surplus ${formatUGX(surplus)} stays as agent float` : undefined,
    },
    {
      dir: 'out',
      category: 'agent_commission_earned',
      label: `Platform expense → agent commission (${ratePct}% of repayments)`,
      amount: totalCommission,
    },
  ];

  return (
    <div className="border-t bg-primary/[0.03]">
      <div className="px-3 py-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground border-b">
        <FileText className="h-3 w-3" />
        Ledger impact preview · books on Finance verify
      </div>
      <ul className="divide-y">
        {lines.map((l) => (
          <li key={l.category} className="px-3 py-2 grid grid-cols-[auto_1fr_auto] gap-2 items-start text-xs">
            <span
              className={cn(
                'h-5 w-5 rounded-md flex items-center justify-center mt-0.5',
                l.dir === 'in'
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
              )}
              title={l.dir === 'in' ? 'Cash in' : 'Cash out / expense'}
            >
              {l.dir === 'in' ? (
                <ArrowDownRight className="h-3 w-3" />
              ) : (
                <ArrowUpRight className="h-3 w-3" />
              )}
            </span>
            <div className="min-w-0">
              <div className="font-medium leading-tight">{l.label}</div>
              <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{l.category}</div>
              {l.note && (
                <div className="text-[10px] text-muted-foreground mt-0.5">{l.note}</div>
              )}
            </div>
            <span
              className={cn(
                'font-mono text-right whitespace-nowrap',
                l.dir === 'in'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-700 dark:text-amber-400',
              )}
            >
              {l.dir === 'in' ? '+' : '−'}
              {formatUGX(l.amount)}
            </span>
          </li>
        ))}
      </ul>
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t">
        Double-entry: cash-in equals cash-out + commission expense booked to platform earnings.
      </div>
    </div>
  );
}

function StatusPill({ batch }: { batch: FieldDepositBatch }) {
  const s = batch.status;
  const cfg = (() => {
    switch (s) {
      case 'awaiting_proof':
        return { label: 'Pending proof', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400' };
      case 'pending_finops_verification':
        return { label: 'Pending Finance review', cls: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400' };
      case 'verified':
        return { label: 'Verified', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' };
      case 'rejected':
        return { label: 'Rejected', cls: 'border-destructive/30 bg-destructive/10 text-destructive' };
      case 'cancelled':
        return { label: 'Cancelled', cls: 'border-muted-foreground/30 bg-muted text-muted-foreground' };
      default:
        return { label: statusLabel(s), cls: 'border-border bg-muted text-muted-foreground' };
    }
  })();
  return (
    <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-4 font-medium shrink-0', cfg.cls)}>
      {cfg.label}
    </Badge>
  );
}

export default FieldDepositQueueCard;
