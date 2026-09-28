import { formatUGX } from '@/lib/creditFeeCalculations';
import { MoneyDrilldownReport, type DrillConfig, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';

const when = (r: any) => new Date(r.received_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });
const meth = (r: any) => (r.payment_method ?? '').replace(/_/g, ' ');

const config: DrillConfig = {
  title: 'Money Received',
  description: 'Confirmed deposits by mobile money, bank and cash, plus pending ones. Internal transfers and accounting corrections are excluded.',
  rpc: 'get_cfo_money_received_drilldown', payerParam: 'p_payer', filename: 'money-received',
  personLabel: 'Source/payer', confirmedLabel: 'Received',
  types: ['Operational float', 'Personal deposit', 'Partnership deposit', 'Rent repayment', 'Other'],
  statuses: [{ value: 'approved', label: 'Confirmed' }, { value: 'pending', label: 'Pending' }],
  columns: [
    { head: 'Date/time', cell: when, csv: when, className: 'whitespace-nowrap' },
    { head: 'Receipt reference', cell: r => r.receipt_reference ?? '—', csv: r => r.receipt_reference },
    { head: 'Source/payer', cell: r => <>{r.payer}<div className="text-muted-foreground">{r.payer_phone}</div></>, csv: r => `${r.payer} ${r.payer_phone ?? ''}`.trim() },
    { head: 'Receipt type', cell: r => r.receipt_type, csv: r => r.receipt_type, className: 'whitespace-nowrap' },
    { head: 'Amount (UGX)', cell: r => formatUGX(Number(r.amount)), csv: r => r.amount, className: 'whitespace-nowrap text-right' },
    { head: 'Payment method', cell: meth, csv: meth, className: 'whitespace-nowrap capitalize' },
    { head: 'Destination', cell: r => r.destination, csv: r => r.destination, className: 'max-w-[180px] break-words' },
    { head: 'Status', cell: r => r.status === 'approved' ? 'Confirmed' : r.status, csv: r => r.status, className: 'capitalize' },
    { head: 'Description', cell: r => r.description, csv: r => r.description, className: 'max-w-[240px] break-words text-muted-foreground' },
    { head: 'Ledger reference', cell: r => r.ledger_reference ?? <span className="text-muted-foreground">No ledger entry</span>, csv: r => r.ledger_reference ?? '', className: 'max-w-[200px] break-all font-mono text-[10px]' },
  ],
};

export function MoneyReceivedReport(props: { open: boolean; onOpenChange: (o: boolean) => void; preset?: DrilldownPreset | null }) {
  return <MoneyDrilldownReport {...props} config={config} />;
}
