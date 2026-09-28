import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Download, Loader2 } from 'lucide-react';

type Row = {
  received_at: string; id: string; receipt_reference: string | null;
  payer: string; payer_phone: string | null; receipt_type: string; amount: number;
  payment_method: string | null; status: string; destination: string | null; description: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const sel = 'h-9 rounded-md border border-input bg-background px-2 text-sm';

/** Read-only report of real external payouts (completed/paid) plus pending ones. */
export function MoneyReceivedReport({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [type, setType] = useState('');
  const [recipient, setRecipient] = useState('');
  const [params, setParams] = useState<Record<string, string> | null>(null);

  const generate = () => setParams({ from, to, status, method, type, recipient });

  const q = useQuery({
    queryKey: ['cfo-money-received-report', params],
    enabled: open && !!params,
    queryFn: async () => {
      const p = params!;
      const end = new Date(p.to); end.setDate(end.getDate() + 1);
      const { data, error } = await (supabase.rpc as any)('get_cfo_money_received_report', {
        p_from: new Date(p.from + 'T00:00:00+03:00').toISOString(),
        p_to: new Date(iso(end) + 'T00:00:00+03:00').toISOString(),
        p_status: p.status || null, p_method: p.method || null,
        p_type: p.type || null, p_payer: p.recipient.trim() || null, p_limit: 10000,
      });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
  const rows = q.data ?? [];
  const recvTotal = rows.filter(r => r.status !== 'pending').reduce((s, r) => s + Number(r.amount), 0);

  const exportCsv = () => {
    const head = ['Date/time', 'Receipt reference', 'Source/payer', 'Phone', 'Receipt type', 'Amount (UGX)', 'Payment method', 'Status', 'Destination account/wallet', 'Description'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map(r => [
      new Date(r.received_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' }),
      r.receipt_reference, r.payer, r.payer_phone, r.receipt_type, r.amount,
      (r.payment_method ?? '').replace(/_/g, ' '), r.status, r.destination, r.description,
    ].map(esc).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `money-received_${params?.from}_${params?.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Money Received Report</DialogTitle>
          <DialogDescription>Confirmed deposits by mobile money, bank and cash, plus pending ones. Internal transfers, reclassifications and accounting corrections are excluded.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end">
          <label className="text-xs">From<Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          <label className="text-xs">To<Input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
          <label className="text-xs flex flex-col">Receipt type
            <select className={sel} value={type} onChange={e => setType(e.target.value)}>
              <option value="">All</option>
              {['Operational float', 'Personal deposit', 'Partnership deposit', 'Rent repayment', 'Other'].map(t => <option key={t}>{t}</option>)}
            </select></label>
          <label className="text-xs flex flex-col">Method
            <select className={sel} value={method} onChange={e => setMethod(e.target.value)}>
              <option value="">All</option><option value="mobile_money">Mobile money</option>
              <option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option>
            </select></label>
          <label className="text-xs flex flex-col">Status
            <select className={sel} value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All</option><option value="approved">Confirmed</option><option value="pending">Pending</option>
            </select></label>
          <label className="text-xs">Source/payer<Input placeholder="Name or phone" value={recipient} onChange={e => setRecipient(e.target.value)} /></label>
          <Button onClick={generate} disabled={q.isFetching}>
            {q.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Generate'}
          </Button>
        </div>

        {params && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{rows.length.toLocaleString()} rows · Received <b>{formatUGX(recvTotal)}</b></span>
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!rows.length}>
              <Download className="h-4 w-4 mr-1" /> Export CSV
            </Button>
          </div>
        )}

        <div className="overflow-auto flex-1 border rounded-md">
          {!params ? <p className="p-6 text-sm text-muted-foreground">Choose filters and tap Generate.</p>
            : q.error ? <p className="p-6 text-sm text-destructive">Could not load the report.</p>
            : (
              <table className="w-full text-xs">
                <thead className="bg-muted sticky top-0">
                  <tr>{['Date/time', 'Reference', 'Source/payer', 'Type', 'Amount', 'Method', 'Status', 'Destination account/wallet', 'Description'].map(h =>
                    <th key={h} className="text-left p-2 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-t align-top">
                      <td className="p-2 whitespace-nowrap">{new Date(r.received_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })}</td>
                      <td className="p-2">{r.receipt_reference ?? '—'}</td>
                      <td className="p-2">{r.payer}<div className="text-muted-foreground">{r.payer_phone}</div></td>
                      <td className="p-2 whitespace-nowrap">{r.receipt_type}</td>
                      <td className="p-2 whitespace-nowrap text-right">{formatUGX(Number(r.amount))}</td>
                      <td className="p-2 whitespace-nowrap capitalize">{(r.payment_method ?? '').replace(/_/g, ' ')}</td>
                      <td className="p-2 capitalize">{r.status}</td>
                      <td className="p-2 max-w-[180px] break-words">{r.destination}</td>
                      <td className="p-2 max-w-[260px] break-words text-muted-foreground">{r.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
