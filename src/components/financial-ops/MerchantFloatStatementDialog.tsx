import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ArrowDownLeft, ArrowUpRight, FileDown, Share2 } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { MerchantFloatPosition, useMerchantFloatStatement } from '@/hooks/useMerchantFloat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  buildMerchantFloatStatementFilename,
  generateMerchantFloatStatementPdf,
} from '@/lib/merchantFloatStatementPdf';
import { sharePdfViaWhatsApp } from '@/lib/whatsappShare';
import { useState } from 'react';
import { toast } from 'sonner';

const CATEGORY_LABELS: Record<string, string> = {
  agent_float_deposit: 'Float in — money sent to their phone',
  agent_float_settlement: 'Float used — customer payout',
  agent_float_return: 'Float returned to company',
};

/**
 * Human label for one float movement line.
 *
 * Float in  = company money sent to the agent's MTN/Airtel line (confirmed by
 *             the extracted payment email).
 * Float used = money that left their float when they claimed and completed a
 *              withdrawal payout, plus the telecom sending charge on it.
 */
function label(row: { category: string; referenceId?: string | null; description?: string | null }) {
  const ref = `${row.referenceId ?? ''} ${row.description ?? ''}`.toLowerCase();
  if (row.category === 'agent_float_settlement') {
    if (ref.includes('telecom')) return 'Float used — telecom sending charge';
    return 'Float used — customer payout';
  }
  return CATEGORY_LABELS[row.category] ?? row.category.replace(/_/g, ' ');
}

/** True for the leg that settled a customer cash-out (not the telecom charge). */
function isCustomerPayout(row: { category: string; referenceId?: string | null; description?: string | null }) {
  const ref = `${row.referenceId ?? ''} ${row.description ?? ''}`.toLowerCase();
  return row.category === 'agent_float_settlement' && !ref.includes('telecom');
}

/**
 * Statement of one merchant agent's float movement — money we sent them and
 * money that left their float as payouts / telecom charges, with the balance
 * after each line. Read-only.
 */
export function MerchantFloatStatementDialog({
  position,
  open,
  onOpenChange,
}: {
  position: MerchantFloatPosition | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading, error } = useMerchantFloatStatement(position?.agentId, open);
  const [busy, setBusy] = useState<'pdf' | 'share' | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  if (!position) return null;

  const allRows = data?.rows ?? [];
  // Financial Ops can restrict the downloaded statement to a date window.
  const inPeriod = (iso: string) => {
    const d = new Date(iso).getTime();
    if (fromDate && d < new Date(`${fromDate}T00:00:00`).getTime()) return false;
    if (toDate && d > new Date(`${toDate}T23:59:59.999`).getTime()) return false;
    return true;
  };
  const hasPeriod = Boolean(fromDate || toDate);
  const rows = hasPeriod ? allRows.filter((r) => inPeriod(r.date)) : allRows;
  const inTotal = rows.filter((r) => r.direction === 'cash_in').reduce((s, r) => s + r.amount, 0);
  const outTotal = rows.filter((r) => r.direction === 'cash_out').reduce((s, r) => s + r.amount, 0);
  // The statement carries EVERY leg (admin corrections included) and starts from
  // an explicit opening balance, so the closing figure equals the books float.
  const booksBalance = data?.booksBalance ?? 0;
  const openingBalance = data?.openingBalance ?? 0;
  const balance = rows.length ? rows[0].runningBalance : hasPeriod ? 0 : booksBalance;
  // Opening for the selected window = balance carried by the leg just before it.
  const periodOpening = (() => {
    if (!hasPeriod || rows.length === 0) return openingBalance;
    const idx = allRows.findIndex((r) => r.id === rows[rows.length - 1].id);
    const prev = allRows[idx + 1];
    return prev ? prev.runningBalance : openingBalance;
  })();
  const variance = balance - booksBalance;
  const tallies = Math.abs(variance) < 1;
  const correctionRows = rows.filter((r) => r.isCorrection);
  const correctionNet = data?.correctionNet ?? 0;

  const agentName = position.agentName || position.label || 'Merchant agent';

  const buildPdf = async () =>
    generateMerchantFloatStatementPdf({
      agentName,
      agentPhone: position.agentPhone,
      totalIn: inTotal,
      totalOut: outTotal,
      balance,
      booksBalance,
      openingBalance: periodOpening,
      periodFrom: fromDate || null,
      periodTo: toDate || null,
      rows: rows.map((r) => ({
        date: r.date,
        category: r.category,
        label: label(r),
        isCorrection: r.isCorrection,
        description: isCustomerPayout(r)
          ? `Paid to ${r.payeeName || 'Unknown customer'} · ${r.description || r.referenceId || ''}`.trim()
          : r.description || r.referenceId || null,
        direction: r.direction,
        amount: r.amount,
        runningBalance: r.runningBalance,
      })),
    });

  const filename = buildMerchantFloatStatementFilename(agentName, position.agentPhone, {
    from: fromDate || null,
    to: toDate || null,
  });

  const handleDownloadPdf = async () => {
    try {
      setBusy('pdf');
      const blob = await buildPdf();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch {
      toast.error('Could not generate the statement PDF');
    } finally {
      setBusy(null);
    }
  };

  const handleShare = async () => {
    try {
      setBusy('share');
      const blob = await buildPdf();
      const caption = `Welile float statement — ${agentName}: float left ${formatUGX(balance)} (sent in ${formatUGX(inTotal)}, used ${formatUGX(outTotal)}).`;
      const result = await sharePdfViaWhatsApp(blob, {
        filename,
        caption,
        phone: position.agentPhone?.replace(/\D/g, '') || undefined,
      });
      if (result === 'deeplink') {
        toast.success('Statement downloaded — attach it in WhatsApp');
      }
    } catch {
      toast.error('Could not share the statement');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {position.agentName || position.label || 'Merchant agent'} — float statement
          </DialogTitle>
          <DialogDescription className="text-xs">
            {position.agentPhone || '—'} · float in when we send money to their phone, float used when they complete a payout
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end justify-end gap-2">
          <div className="mr-auto flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="float-from" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                From
              </Label>
              <Input
                id="float-from"
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-8 w-[9.5rem] text-xs"
              />
            </div>
            <div>
              <Label htmlFor="float-to" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                To
              </Label>
              <Input
                id="float-to"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                className="h-8 w-[9.5rem] text-xs"
              />
            </div>
            {hasPeriod && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => {
                  setFromDate('');
                  setToDate('');
                }}
              >
                Clear dates
              </Button>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={isLoading || rows.length === 0 || busy !== null}
            onClick={handleDownloadPdf}
          >
            <FileDown className="h-3.5 w-3.5 mr-1" /> {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={isLoading || rows.length === 0 || busy !== null}
            onClick={handleShare}
          >
            <Share2 className="h-3.5 w-3.5 mr-1" /> {busy === 'share' ? 'Preparing…' : 'Share on WhatsApp'}
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Float in (to their phone)</p>
            <p className="mt-1 font-mono text-sm font-bold tabular-nums text-success break-all">{formatUGX(inTotal)}</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Float used (payouts)</p>
            <p className="mt-1 font-mono text-sm font-bold tabular-nums text-destructive break-all">{formatUGX(outTotal)}</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Float left</p>
            <p className="mt-1 font-mono text-sm font-bold tabular-nums text-foreground break-all">{formatUGX(balance)}</p>
          </div>
        </div>

        <div
          className={`rounded-xl border p-3 ${
            tallies ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5'
          }`}
        >
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Statement vs books (wallet float)
          </p>
          <p className="mt-1 text-xs font-semibold text-foreground">
            Statement close {formatUGX(balance)} · Books {formatUGX(booksBalance)}{' '}
            <span className={tallies ? 'text-success' : 'text-destructive'}>
              {tallies ? '· tallies' : `· variance ${formatUGX(variance)}`}
            </span>
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {correctionRows.length > 0
              ? `Includes ${correctionRows.length} admin correction leg${correctionRows.length === 1 ? '' : 's'} (net ${formatUGX(correctionNet)}) — always shown.`
              : 'No admin correction legs on this float line.'}
          </p>
          {Math.abs(openingBalance) >= 1 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Opening balance before the first leg below: {formatUGX(openingBalance)} (anchored baseline from
              past float resets).
            </p>
          )}
        </div>

        <div className="mt-2 divide-y divide-border rounded-xl border border-border overflow-hidden">
          {isLoading && <p className="p-4 text-xs text-muted-foreground">Loading statement…</p>}
          {error && (
            <p className="p-4 text-xs text-muted-foreground">
              This statement is only visible to finance roles.
            </p>
          )}
          {!isLoading && !error && rows.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground">No float movement recorded for this agent yet.</p>
          )}
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 p-3 min-w-0">
              <div
                className={`p-1.5 rounded-lg shrink-0 ${
                  r.direction === 'cash_in' ? 'bg-success/10' : 'bg-destructive/10'
                }`}
              >
                {r.direction === 'cash_in' ? (
                  <ArrowDownLeft className="h-3.5 w-3.5 text-success" />
                ) : (
                  <ArrowUpRight className="h-3.5 w-3.5 text-destructive" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">
                  {label(r)}
                  {r.isCorrection && (
                    <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-warning">
                      Admin correction
                    </span>
                  )}
                </p>
                {isCustomerPayout(r) && (
                  <p
                    className={`text-[11px] font-semibold truncate ${
                      r.payeeName ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    Paid to {r.payeeName || 'Unknown customer'}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground truncate">
                  {r.description || r.referenceId || '—'}
                </p>
                {isCustomerPayout(r) && r.payoutRequestId && (
                  <p className="text-[10px] font-mono text-muted-foreground truncate">
                    Transaction: {r.payoutRequestId}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p
                  className={`font-mono text-sm font-semibold tabular-nums ${
                    r.direction === 'cash_in' ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {r.direction === 'cash_in' ? '+' : '-'}
                  {formatUGX(r.amount)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {format(new Date(r.date), 'MMM d, HH:mm')} · bal {formatUGX(r.runningBalance)}
                </p>
              </div>
            </div>
          ))}
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Float in is company money sent to this agent's phone number, confirmed by the MTN/Airtel payment email we
          extracted. Float used is money that left their float when they claimed a withdrawal request and completed the
          payout, plus the telecom sending charge on it.
        </p>
      </DialogContent>
    </Dialog>
  );
}