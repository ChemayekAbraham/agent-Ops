import { formatUGX } from '@/lib/creditFeeCalculations';
import { MoneyDrilldownReport, type DrillConfig, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { CREDITS_GROUP_LABELS } from '@/lib/withdrawableCreditsGroups';

const when = (r: any) => new Date(r.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });

const config: DrillConfig = {
  title: 'Wearable credits'.replace('Wearable', 'Withdrawable'),
  description: 'Every credit into a user\'s withdrawable balance, straight from the ledger. Filter by source, person and Kampala day range; totals cover the full filtered set.',
  rpc: 'get_cfo_withdrawable_credits_page',
  kind: 'credits',
  payerParam: 'p_person',
  filename: 'withdrawable-credits',
  personLabel: 'Received by',
  confirmedLabel: 'Credited',
  types: CREDITS_GROUP_LABELS,
  statuses: [],
  columns: [
    { head: 'Date/time', cell: when, csv: when, className: 'whitespace-nowrap' },
    { head: 'Source', cell: r => r.credit_type, csv: r => r.credit_type, className: 'whitespace-nowrap' },
    { head: 'Ledger category', cell: r => String(r.category ?? '').replace(/_/g, ' '), csv: r => r.category, className: 'whitespace-nowrap capitalize' },
    { head: 'Received by', cell: r => <>{r.full_name}<div className="text-muted-foreground">{r.phone}</div></>, csv: r => `${r.full_name} ${r.phone ?? ''}`.trim() },
    { head: 'Amount (UGX)', cell: r => formatUGX(Number(r.amount)), csv: r => r.amount, className: 'whitespace-nowrap text-right' },
    { head: 'Description', cell: r => r.description, csv: r => r.description, className: 'max-w-[240px] break-words text-muted-foreground' },
    { head: 'Reference', cell: r => r.reference_id ?? <span className="text-muted-foreground">—</span>, csv: r => r.reference_id ?? '', className: 'max-w-[180px] break-all font-mono text-[10px]' },
    { head: 'Ledger reference', cell: r => r.ledger_reference ?? <span className="text-muted-foreground">—</span>, csv: r => r.ledger_reference ?? '', className: 'max-w-[200px] break-all font-mono text-[10px]' },
  ],
};

/** Withdrawable-credits drill-down in the same layout as the Money Paid Out report. */
export function WithdrawableCreditsReport(props: { open: boolean; onOpenChange: (o: boolean) => void; preset?: DrilldownPreset | null }) {
  return <MoneyDrilldownReport {...props} config={config} />;
}
