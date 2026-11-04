import { formatUGX } from '@/lib/creditFeeCalculations';
import { MoneyDrilldownReport, type DrillConfig, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';

const when = (r: any) => new Date(r.paid_at ?? r.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });
const meth = (r: any) => (r.payment_method ?? '').replace(/_/g, ' ');

const config: DrillConfig = {
  title: 'Money Paid Out',
  description: 'Completed payouts to mobile money, bank and cash, plus pending requests. Wallet credits and internal transfers are excluded.',
  rpc: 'get_cfo_money_paid_out_page', kind: 'paid_out', payerParam: 'p_recipient', filename: 'money-paid-out',
  personLabel: 'Recipient', confirmedLabel: 'Paid out',
  types: ['Wallet withdrawal', 'Supporter returns', 'Commission', 'Landlord', 'Salary'],
  statuses: [{ value: 'confirmed', label: 'Paid (completed + paid)' }, { value: 'completed', label: 'Completed' }, { value: 'paid', label: 'Paid' }, { value: 'pending', label: 'Pending' }],
  columns: [
    { head: 'Date/time', cell: when, csv: when, className: 'whitespace-nowrap' },
    { head: 'Payout reference', cell: r => r.payout_reference ?? '—', csv: r => r.payout_reference },
    { head: 'Recipient', cell: r => <div className="min-w-24 max-w-32 break-words">{r.recipient}<div className="mt-0.5 text-muted-foreground whitespace-nowrap">{r.recipient_phone}</div></div>, csv: r => `${r.recipient} ${r.recipient_phone ?? ''}`.trim() },
    { head: 'Payout type', cell: r => r.payout_type, csv: r => r.payout_type, className: 'whitespace-nowrap' },
    { head: 'Amount (UGX)', cell: r => formatUGX(Number(r.amount)), csv: r => r.amount, className: 'whitespace-nowrap' },
    { head: 'Payment method', cell: meth, csv: meth, className: 'whitespace-nowrap capitalize' },
    { head: 'Status', cell: r => <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium capitalize whitespace-nowrap ${['completed', 'paid'].includes(r.status) ? 'bg-success/15 text-success' : r.status === 'pending' ? 'bg-warning/15 text-warning-foreground' : 'bg-muted text-muted-foreground'}`}>{r.status}</span>, csv: r => r.status },
    { head: 'Source/account', cell: r => r.source_account, csv: r => r.source_account, className: 'max-w-[180px] break-words' },
    { head: 'Description', cell: r => r.description, csv: r => r.description, className: 'max-w-[240px] break-words text-muted-foreground' },
    { head: 'Ledger reference', cell: r => r.ledger_reference ? <span title={r.ledger_reference} aria-label={r.ledger_reference} className="whitespace-nowrap">…{String(r.ledger_reference).slice(-8)}</span> : <span className="text-muted-foreground">No ledger entry</span>, csv: r => r.ledger_reference ?? '', className: 'text-[10px]' },
  ],
};

export function MoneyPaidOutReport(props: { open: boolean; onOpenChange: (o: boolean) => void; preset?: DrilldownPreset | null }) {
  return <MoneyDrilldownReport {...props} config={config} />;
}
