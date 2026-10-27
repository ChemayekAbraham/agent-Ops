import { useState } from 'react';
import {
  Plus, ShieldCheck, ShieldAlert, Scale, ChevronRight, AlertCircle,
  FileSpreadsheet, Filter, Building2, User as UserIcon
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { STATUS_LABEL, describeSpecialAdvanceError, type SpecialAdvanceStatus } from '@/lib/specialAdvances';
import { useSpecialAdvanceList, useSpecialAdvanceReconciliation } from '@/hooks/useSpecialAdvances';
import { SpecialAdvanceModal } from '@/components/cfo/SpecialAdvanceModal';
import { SpecialAdvanceDetailSheet } from './SpecialAdvanceDetailSheet';
import { cn } from '@/lib/utils';

const ALL = '__all__';

function getStatusBadgeClass(status: SpecialAdvanceStatus): string {
  switch (status) {
    case 'pending_approval':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20';
    case 'approved':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20';
    case 'disbursed':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20';
    case 'settled':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20';
    case 'rejected':
      return 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20';
    case 'cancelled':
    default:
      return 'bg-muted text-muted-foreground border-border/80';
  }
}

/**
 * CFO Special Advances: executive issuance switch, A24 general ledger reconciliation,
 * and the authoritative subledger register of custom advance agreements.
 */
export function SpecialAdvancesPanel() {
  const [status, setStatus] = useState<SpecialAdvanceStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const list = useSpecialAdvanceList(status);
  const recon = useSpecialAdvanceReconciliation();
  const issuanceEnabled = list.data?.issuance_enabled ?? false;
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-5">
      {/* Top Executive KPI & Controls Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Issuance Policy Card */}
        <div className="rounded-2xl border border-border/80 bg-card p-4 sm:p-5 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              Issuance Policy
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border',
                issuanceEnabled
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
              )}
            >
              {issuanceEnabled ? 'Active' : 'Disabled'}
            </span>
          </div>

          <div className="text-xs mt-1">
            <span
              id="special-advance-issuance-state"
              className={cn(
                'inline-flex items-center gap-1.5 font-medium leading-relaxed',
                issuanceEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'
              )}
            >
              {issuanceEnabled ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
              {list.data
                ? issuanceEnabled
                  ? 'Issuance is switched on'
                  : 'Issuance is switched off — recording, approval and payout are disabled'
                : 'Checking the server...'}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2 border-t border-border/40 pt-2">
            Server-enforced kill switch controlling creation, approvals, and fund disbursement.
          </p>
        </div>

        {/* A24 General Ledger Alignment Card */}
        <div className="rounded-2xl border border-border/80 bg-card p-4 sm:p-5 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Scale className="h-3.5 w-3.5 text-primary" />
              A24 Ledger Alignment
            </span>
            {recon.data && (
              <span
                className={cn(
                  'inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border',
                  recon.data.balanced
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
                    : 'bg-destructive/10 text-destructive border-destructive/20'
                )}
              >
                {recon.data.balanced ? 'Reconciled' : 'Variance Detected'}
              </span>
            )}
          </div>

          <div className="text-xs mt-1">
            {recon.data ? (
              <span
                id="special-advance-reconciliation"
                className={cn(
                  'font-medium leading-relaxed block',
                  recon.data.balanced ? 'text-foreground' : 'font-semibold text-destructive'
                )}
              >
                A24 ledger {formatUGX(recon.data.a24_ledger_balance)} · records {formatUGX(recon.data.subledger_outstanding)}
                {recon.data.balanced ? ' · reconciled' : ` · difference ${formatUGX(recon.data.difference)}`}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">A24 subledger reconciliation checking...</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2 border-t border-border/40 pt-2">
            Continuous parity validation between Account A24 (General Ledger) and individual agreements.
          </p>
        </div>
      </div>

      {/* Main Subledger Agreements Register */}
      <section className="rounded-2xl border border-border/80 bg-card shadow-sm overflow-hidden" aria-label="Special Advances">
        {/* Table Toolbar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-b border-border/70 p-4 sm:p-5 bg-card">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileSpreadsheet className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold tracking-tight text-foreground">Agreements Register</h2>
              <p className="text-[11px] text-muted-foreground">
                {list.isLoading ? 'Loading records...' : `${items.length} ${items.length === 1 ? 'agreement' : 'agreements'} found`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 self-end sm:self-auto w-full sm:w-auto">
            <Select value={status ?? ALL} onValueChange={(v) => setStatus(v === ALL ? null : (v as SpecialAdvanceStatus))}>
              <SelectTrigger id="special-advance-status-filter" aria-label="Filter by status" className="h-9 w-full sm:w-48 text-xs bg-background">
                <Filter className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {(Object.keys(STATUS_LABEL) as SpecialAdvanceStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              id="special-advance-new"
              size="sm"
              onClick={() => setRecording(true)}
              className="gap-1.5 shrink-0 shadow-sm font-medium"
            >
              <Plus className="h-4 w-4" /> New Special Advance
            </Button>
          </div>
        </div>

        {/* Agreements Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-muted/40 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/60">
              <tr>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Borrower</th>
                <th className="px-4 py-3 text-right">Principal</th>
                <th className="hidden px-4 py-3 text-right sm:table-cell">Total Repayable</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {list.isLoading && (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      <span className="text-xs">Loading subledger agreements...</span>
                    </div>
                  </td>
                </tr>
              )}

              {list.isError && (
                <tr>
                  <td colSpan={6} role="alert" className="py-8 px-4 text-center">
                    <div className="inline-flex items-center gap-2 text-destructive bg-destructive/10 px-4 py-2.5 rounded-lg border border-destructive/20 text-xs">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span>{describeSpecialAdvanceError(list.error)}</span>
                    </div>
                  </td>
                </tr>
              )}

              {!list.isLoading && !list.isError && items.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <FileSpreadsheet className="h-8 w-8 text-muted-foreground/40" />
                      <span className="text-xs font-medium">No Special Advances recorded{status ? ' with this status' : ''}.</span>
                      <p className="text-[11px] text-muted-foreground max-w-sm">
                        Use the "New Special Advance" button above to record an individually agreed advance.
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {items.map((a) => (
                <tr
                  key={a.id}
                  tabIndex={0}
                  className="cursor-pointer hover:bg-muted/40 transition-colors group"
                  onClick={() => setOpenId(a.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setOpenId(a.id);
                  }}
                >
                  <td className="px-4 py-3.5 font-mono font-semibold text-primary group-hover:underline">
                    {a.reference}
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="font-medium text-foreground text-xs">
                      {a.borrower_name ?? '—'}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground">
                      {a.borrower_kind === 'external' ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Building2 className="h-3 w-3" /> External Borrower
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-primary/80">
                          <UserIcon className="h-3 w-3" /> Welile Account
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-right tabular-nums font-semibold text-foreground">
                    {formatUGX(a.principal)}
                  </td>
                  <td className="hidden px-4 py-3.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                    {formatUGX(a.total_repayable)}
                  </td>
                  <td className="px-4 py-3.5">
                    <span
                      className={cn(
                        'inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium border',
                        getStatusBadgeClass(a.status)
                      )}
                    >
                      {STATUS_LABEL[a.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground group-hover:text-primary transition-colors">
                      View
                      <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <SpecialAdvanceDetailSheet advanceId={openId} issuanceEnabled={issuanceEnabled} onOpenChange={(o) => { if (!o) setOpenId(null); }} />
      <SpecialAdvanceModal open={recording} onOpenChange={setRecording} />
    </div>
  );
}

export default SpecialAdvancesPanel;
