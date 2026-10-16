import { CardShell, Stat, StatGrid } from './MetricsShared';
import { num } from './metricsFormat';
import { FALLBACK_BASIS, type TotalsCardProps } from './totalsCards.shared';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { formatUGX } from '@/lib/rentCalculations';
import { metricsCsvName, metricsPreamble } from '@/lib/agentMetrics';

/** Advances issued in the dates (given, repaid) and today's balances (outstanding, overdue). */
export function AdvancesCard({ controls, totals, from, to }: TotalsCardProps) {
  const t = totals.data;
  const csv = t ? () => downloadCsvWithPreamble(
    metricsCsvName('advances', from, to), metricsPreamble('Advances', from, to, t.basis),
    ['Figure', 'Count', 'Amount (UGX)'],
    [['Given in the dates', t.advances_given_count, t.advances_given_amount], ['Repaid (of those given)', '', t.advances_repaid], ['Outstanding today', '', t.advances_outstanding], ['Overdue today', t.advances_overdue_count, t.advances_overdue_amount]],
  ) : undefined;
  return (
    <CardShell id="advances" controls={controls} state={totals} basis={t?.basis || FALLBACK_BASIS} onCsv={csv}>
      {t && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Issued in the dates</p>
          <StatGrid>
            <Stat label="Advances given" value={num(t.advances_given_count)} testId="metrics-adv-count" />
            <Stat label="Amount given" value={formatUGX(t.advances_given_amount)} testId="metrics-adv-given" />
            <Stat label="Repaid so far" value={formatUGX(t.advances_repaid)} hint="Of the advances given" testId="metrics-adv-repaid" />
          </StatGrid>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Balances today</p>
          <StatGrid>
            <Stat label="Outstanding" value={formatUGX(t.advances_outstanding)} testId="metrics-adv-outstanding" />
            <Stat label="Overdue advances" value={num(t.advances_overdue_count)} testId="metrics-adv-overdue-count" />
            <Stat label="Overdue amount" value={formatUGX(t.advances_overdue_amount)} testId="metrics-adv-overdue-amount" />
          </StatGrid>
        </>
      )}
    </CardShell>
  );
}
