import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDirectPayAgentItems, useDirectPayRecordLandlordReceipt, useDirectPayUploadLandlordReceiptPhoto } from '@/hooks/useDirectPay';
import { directPayMessage, formatUgx, welileReceiptUrl, type DirectPayAgentItem } from '@/lib/directPay';
import { DirectPayUnavailable } from './DirectPayPartner';

function AgentReceipt({ item }: { item: DirectPayAgentItem }) {
  const [number, setNumber] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const record = useDirectPayRecordLandlordReceipt();
  const upload = useDirectPayUploadLandlordReceiptPhoto();
  return <li className="space-y-3 rounded-lg border border-border bg-card p-4">
    <p className="font-semibold">Paid by partner {item.partner_first_name}</p>
    <dl className="grid gap-2 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">Tenant</dt><dd>{item.tenant_name ?? '—'}</dd></div><div><dt className="text-muted-foreground">Landlord</dt><dd>{item.landlord_name ?? '—'}</dd></div><div><dt className="text-muted-foreground">Amount</dt><dd>{formatUgx(item.amount)}</dd></div></dl>
    {item.receipt_code && <Button asChild variant="outline"><a href={welileReceiptUrl(item.receipt_code)} target="_blank" rel="noopener noreferrer">{item.receipt_number ?? 'WLR receipt'}</a></Button>}
    {item.needs_landlord_receipt ? <form className="space-y-3" onSubmit={async (event) => {
      event.preventDefault(); setMessage(null);
      try {
        const photoPath = photo ? await upload.mutateAsync({ rentRequestId: item.rent_request_id, photo }) : null;
        if (photo && !photoPath) { setMessage(directPayMessage({ ok: false, code: 'invalid_photo' })); return; }
        const result = await record.mutateAsync({ paymentId: item.payment_id, receiptNumber: number, photoPath });
        setMessage(result.ok ? 'Landlord receipt recorded.' : result.code === 'receipt_number_invalid' ? 'Enter the receipt number exactly as written (3 to 50 characters).' : directPayMessage({ ok: false, code: 'save_failed' }));
      } catch { setMessage(directPayMessage({ ok: false, code: 'not_available' })); }
    }}><Label className="block">Number on the landlord's signed receipt<Input value={number} onChange={(e) => setNumber(e.target.value)} className="mt-1" /></Label><Label className="block">Signed receipt photo (optional)<Input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} className="mt-1" /></Label><Button type="submit" disabled={record.isPending || upload.isPending}>{record.isPending || upload.isPending ? 'Saving…' : 'Record landlord receipt'}</Button></form> : <p className="text-sm text-success">Landlord receipt: {item.landlord_receipt_number ?? 'Recorded'}</p>}
    {message && <p role="status" className="text-sm text-primary">{message}</p>}
  </li>;
}

export function DirectPayAgentItems() {
  const query = useDirectPayAgentItems();
  if (query.isLoading) return <p role="status">Loading directly paid Rent Plans…</p>;
  if (query.isError) return <DirectPayUnavailable retry={() => { void query.refetch(); }} />;
  if (!query.data?.length) return null;
  return <section className="space-y-3" aria-label="Rent Plans paid directly by partners"><h2 className="text-lg font-semibold">Rent Plans paid directly by partners</h2><ul className="space-y-3">{query.data.map((item) => <AgentReceipt key={item.payment_id} item={item} />)}</ul></section>;
}