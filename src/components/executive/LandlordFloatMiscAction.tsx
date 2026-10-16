import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { LANDLORD_FLOAT_MIN_REASON, type MiscRequestResult } from '@/lib/landlordFloatBudget';

export function LandlordFloatMiscAction({ requestId, tenantName, pending, requestMisc }: {
  requestId: string; tenantName: string; pending: boolean;
  requestMisc: (items: { rentRequestId: string; reason: string }[]) => Promise<MiscRequestResult | null>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (reason.trim().length < LANDLORD_FLOAT_MIN_REASON || busy) return;
    setBusy(true);
    try {
      const result = await requestMisc([{ rentRequestId: requestId, reason: reason.trim() }]);
      if (result?.requested.length) { setOpen(false); setReason(''); }
    } finally { setBusy(false); }
  }
  if (pending) return <Badge variant="secondary">Waiting for CFO</Badge>;
  return <div onClick={e => e.stopPropagation()}>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Request miscellaneous</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Request miscellaneous approval</DialogTitle><DialogDescription>{tenantName} · This Rent Plan stays at the COO stage until the CFO approves.</DialogDescription></DialogHeader><Label htmlFor={`misc-reason-${requestId}`}>Reason (at least 10 characters)</Label><Textarea id={`misc-reason-${requestId}`} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy || reason.trim().length < LANDLORD_FLOAT_MIN_REASON} onClick={() => void submit()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Send to CFO</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
