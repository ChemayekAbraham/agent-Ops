import { format } from 'date-fns';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  ADVANCE_RECON_ISSUE_LABEL,
  useAdvanceWalletReconciliation,
} from '@/hooks/useAdvanceWalletReconciliation';

interface Props {
  advanceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * CFO view: an advance's statement reconciled against the agent's wallet.
 * Data-only layout — visual polish is Gemini's lane.
 */
export function AdvanceWalletReconciliationDialog({ advanceId, open, onOpenChange }: Props) {
  const { data, isLoading, error } = useAdvanceWalletReconciliation(open ? advanceId : null);
  const adv = data?.advance;
  const t = data?.totals;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Wallet check{adv?.agent_name ? ` — ${adv.agent_name}` : ''}</DialogTitle>
          <DialogDescription>
            Every deduction on the advance statement, matched to a debit on the agent's wallet statement.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

        {adv && t && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              {t.reconciled ? (
                <Badge variant="secondary">Reconciled</Badge>
              ) : (
                <Badge variant="destructive">{t.issue_count} issue{t.issue_count === 1 ? '' : 's'}</Badge>
              )}
              <span className="text-xs text-muted-foreground">{adv.agent_phone} · {adv.status}</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <Stat label="Paid out" value={format(new Date(adv.issued_at), 'd MMM yyyy, HH:mm')} />
              <Stat label="Principal" value={formatUGX(adv.principal)} />
              <Stat label="Total to repay" value={formatUGX(adv.total_repayable)} />
              <Stat label="Deducted from wallet" value={`${formatUGX(t.wallet_deducted)} (${t.wallet_deduction_count})`} />
              <Stat label="Deducted on statement" value={formatUGX(t.statement_deducted)} />
              <Stat label="Penalty added" value={formatUGX(t.penalty)} />
              <Stat label="Balance" value={formatUGX(adv.outstanding_balance)} />
              <Stat label="Arrears" value={formatUGX(adv.arrears_balance)} />
              <Stat label="Daily instalment" value={formatUGX(adv.daily_installment)} />
            </div>

            {data.issues.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-semibold">Issues</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Issue</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.issues.map((i, idx) => (
                      <TableRow key={`${i.kind}-${i.row_id ?? i.wallet_entry_id ?? idx}`}>
                        <TableCell className="whitespace-nowrap">{format(new Date(i.at), 'd MMM yyyy, HH:mm')}</TableCell>
                        <TableCell>
                          <div className="font-medium">{ADVANCE_RECON_ISSUE_LABEL[i.kind] ?? i.kind}</div>
                          <div className="text-xs text-muted-foreground">{i.detail}</div>
                        </TableCell>
                        <TableCell className="text-right">{formatUGX(i.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="space-y-1">
              <p className="text-sm font-semibold">Day by day</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead className="text-right">Deductions</TableHead>
                    <TableHead className="text-right">From wallet</TableHead>
                    <TableHead className="text-right">On statement</TableHead>
                    <TableHead className="text-right">Penalty</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.days.map((d) => {
                    const mismatch = Math.abs(Number(d.wallet_deducted) - Number(d.statement_deducted)) >= 0.01;
                    return (
                      <TableRow key={d.day} className={mismatch ? 'bg-destructive/5' : undefined}>
                        <TableCell className="whitespace-nowrap">{format(new Date(d.day), 'd MMM yyyy')}</TableCell>
                        <TableCell className="text-right">{d.deductions}</TableCell>
                        <TableCell className="text-right">{formatUGX(d.wallet_deducted)}</TableCell>
                        <TableCell className="text-right">{formatUGX(d.statement_deducted)}</TableCell>
                        <TableCell className="text-right">{Number(d.penalty) > 0 ? formatUGX(d.penalty) : '—'}</TableCell>
                        <TableCell className="text-right">{formatUGX(d.closing_balance)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}
