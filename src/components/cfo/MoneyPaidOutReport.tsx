import { formatUGX } from '@/lib/creditFeeCalculations';
import { MoneyDrilldownReport, type DrillConfig, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';

const when = (r: any) => new Date(r.paid_at ?? r.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });
const meth = (r: any) => (r.payment_method ?? '').replace(/_/g, ' ');

const config: DrillConfig = {
  title: 'Money Paid Out',
  description: 'Completed payouts to mobile money, bank and cash, plus pending requests. Wallet credits and internal transfers are excluded.',
  rpc: 'get_cfo_money_paid_out_drilldown', payerParam: 'p_recipient', filename: 'money-paid-out',
  personLabel: 'Recipient', confirmedLabel: 'Paid out',
  types: ['Wallet withdrawal', 'Supporter returns', 'Commission', 'Landlord', 'Salary'],
  statuses: [{ value: 'confirmed', label: 'Paid (completed + paid)' }, { value: 'completed', label: 'Completed' }, { value: 'paid', label: 'Paid' }, { value: 'pending', label: 'Pending' }],
  columns: [
    { head: 'Date/time', cell: when, csv: when, className: 'whitespace-nowrap' },
    { head: 'Payout reference', cell: r => r.payout_reference ?? '—', csv: r => r.payout_reference },
    { head: 'Recipient', cell: r => <>{r.recipient}<div className="text-muted-foreground">{r.recipient_phone}</div></>, csv: r => `${r.recipient} ${r.recipient_phone ?? ''}`.trim() },
    { head: 'Payout type', cell: r => r.payout_type, csv: r => r.payout_type, className: 'whitespace-nowrap' },
    { head: 'Amount (UGX)', cell: r => formatUGX(Number(r.amount)), csv: r => r.amount, className: 'whitespace-nowrap text-right' },
    { head: 'Payment method', cell: meth, csv: meth, className: 'whitespace-nowrap capitalize' },
    { head: 'Status', cell: r => r.status, csv: r => r.status, className: 'capitalize' },
    { head: 'Source/account', cell: r => r.source_account, csv: r => r.source_account, className: 'max-w-[180px] break-words' },
    { head: 'Description', cell: r => r.description, csv: r => r.description, className: 'max-w-[240px] break-words text-muted-foreground' },
    { head: 'Ledger reference', cell: r => r.ledger_reference ?? <span className="text-muted-foreground">No ledger entry</span>, csv: r => r.ledger_reference ?? '', className: 'max-w-[200px] break-all font-mono text-[10px]' },
  ],
};

export function MoneyPaidOutReport(props: { open: boolean; onOpenChange: (o: boolean) => void; preset?: DrilldownPreset | null }) {
  return <MoneyDrilldownReport {...props} config={config} />;
}
